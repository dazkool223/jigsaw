/**
 * The authoritative Host. Owns the one true GameState, consumes a Transport
 * (see ../types.ts), and is the only thing that ever decides a grab, a
 * merge, or Completion.
 *
 * Wire messages are the canonical shapes from `../net/protocol` - see that
 * module for the full message list and its "SEQUENCING" note, which this
 * class implements: `nextSeq()` is called only for genuine control-channel
 * broadcasts (GRAB_GRANTED, SNAP, PLAYER_LIST, COMPLETE, the periodic-resync
 * FULL_STATE); unicast replies (WELCOME, ROOM_FULL, GRAB_DENIED, the
 * on-demand FULL_STATE reply) either omit `seq` or stamp the CURRENT counter
 * without incrementing it, so answering one Guest never manufactures a
 * phantom gap for everyone else.
 */

import type {
  GroupId,
  PieceId,
  Player,
  PlayerId,
  Point,
  Puzzle,
  Recipient,
  Transport,
} from "../types";
import { BROADCAST } from "../types";
import { MAX_PLAYERS, RESYNC_INTERVAL_MS } from "../config";
import {
  bringToFront,
  createInitialState,
  grabGroup,
  groupOfPiece,
  isComplete,
  moveGroup,
  releaseGroup,
} from "./state";
import { resolveDrop } from "./snap";
import type { GameState } from "../types";
import {
  dropStale,
  parseMessage,
  type ProtocolMessage,
  type StreamMessage,
} from "../net/protocol";

export type HostOptions = {
  readonly transport: Transport;
  readonly puzzle: Puzzle;
  /** Seed-derived initial scatter, keyed by PieceId. See state.ts. Ignored if `initialState` is given. */
  readonly scatterOffsets: Readonly<Record<PieceId, Point>>;
  readonly hostPlayerId: PlayerId;
  readonly hostPlayer: Player;
  /** Overrides RESYNC_INTERVAL_MS; mainly for tests. */
  readonly resyncIntervalMs?: number;
  /**
   * The Host Epoch to stamp on WELCOME (protocol.ts requires it). Host Epoch
   * arbitration itself (ADR-0001) lives in the session/Supabase layer, which
   * is out of scope for game/host.ts - this is just a pass-through so a
   * caller that HAS claimed an epoch can thread it through. Defaults to 0
   * for callers (e.g. the M1 loopback path) that don't have one yet.
   */
  readonly hostEpoch?: number;
  /**
   * Resume-as-Host (CONTEXT.md "Session lifecycle"): a previously-saved
   * Snapshot, deserialized (see state.ts's `deserialize`), to start from
   * instead of a fresh scatter. Without this, claiming Host on a Room with an
   * in-progress board would silently re-scatter it - the M2 verification
   * criterion is "exact positions restored", not "puzzle restarted".
   */
  readonly initialState?: GameState;
};

export class Host {
  private readonly transport: Transport;
  private readonly puzzle: Puzzle;
  private state: GameState;
  private readonly players = new Map<PlayerId, Player>();
  private readonly hostEpoch: number;
  private seq = 0;
  /** Own outbound counter for everything THIS Host originates on `stream` (local play only - relayed Guest messages keep their own seq). */
  private outStreamSeq = -1;
  /** Per-sender staleness tracking for the unreliable `stream` channel (MOVE). */
  private readonly lastStreamSeq = new Map<PlayerId, number>();
  private resyncTimer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly hostPlayerId: PlayerId;
  private readonly listeners = new Set<() => void>();

  constructor(opts: HostOptions) {
    this.transport = opts.transport;
    this.puzzle = opts.puzzle;
    this.hostPlayerId = opts.hostPlayerId;
    this.state = opts.initialState ?? createInitialState(opts.puzzle, opts.scatterOffsets);
    this.players.set(opts.hostPlayerId, opts.hostPlayer);
    this.hostEpoch = opts.hostEpoch ?? 0;

    this.unsubscribers.push(
      this.transport.onMessage((from, _channel, msg) => this.handleMessage(from, msg)),
      this.transport.onPeerLeave((id) => this.handlePeerLeave(id))
    );

    const interval = opts.resyncIntervalMs ?? RESYNC_INTERVAL_MS;
    this.resyncTimer = setInterval(() => this.broadcastFullState(), interval);
  }

  /** Read-only snapshot of the live authoritative state (for tests/inspection). */
  getState(): GameState {
    return this.state;
  }

  getPlayers(): readonly Player[] {
    return [...this.players.values()];
  }

  getPlayerId(): PlayerId {
    return this.hostPlayerId;
  }

  /** Subscribe to "something changed" notifications. Mirrors Client.onChange. Returns an unsubscribe fn. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    if (this.resyncTimer !== undefined) clearInterval(this.resyncTimer);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }

  // ── Local intents (the Host's own browser is a player too) ──
  //
  // The Host is authoritative, so its own input never round-trips through the
  // Transport the way a Guest's does - these apply directly and return the
  // result synchronously, then notify(). They otherwise do exactly what the
  // matching handle*() method below does for a Guest, via the same shared
  // perform*() helpers, so the two paths cannot drift apart.

  /** Unlike Client.grab() (whose denial arrives later via GRAB_DENIED), this resolves synchronously - the Host IS the arbiter. */
  grab(groupId: GroupId): { readonly granted: boolean; readonly reason?: "held" | "not-found" } {
    const result = this.performGrab(this.hostPlayerId, groupId);
    this.notify();
    return result;
  }

  /** Optimistic mid-drag move for the Host's own drag; also relayed so Guests can lerp it. */
  move(groupId: GroupId, offset: Point): void {
    if (!this.performMove(this.hostPlayerId, groupId, offset)) return;
    this.notify();
    this.transport.send("stream", BROADCAST, {
      type: "MOVE",
      seq: this.nextOutStreamSeq(),
      groupId,
      playerId: this.hostPlayerId,
      offset,
    });
  }

  drop(groupId: GroupId, offset: Point): void {
    this.performDrop(this.hostPlayerId, groupId, offset);
    this.notify();
  }

  // ── Inbound ──

  private handleMessage(from: PlayerId, raw: unknown): void {
    const msg = parseMessage(raw);
    if (!msg) return; // malformed / not a Guest->Host shape we recognise - drop

    switch (msg.type) {
      case "JOIN":
        this.handleJoin(from, msg.name, msg.color);
        break;
      case "GRAB":
        this.handleGrabRequest(from, msg.groupId);
        break;
      case "MOVE":
        if (this.acceptStream(from, msg)) {
          if (this.performMove(from, msg.groupId, msg.offset)) {
            this.notify();
            // Relay unmodified (own seq preserved) so other players can lerp
            // this Guest's live drag - see protocol.ts's SEQUENCING note for
            // why CURSOR already does this; MOVE needs the same treatment or
            // remote motion never appears until the eventual DROP/SNAP.
            this.transport.send("stream", BROADCAST, msg);
          }
        }
        break;
      case "DROP":
        this.handleDrop(from, msg.groupId, msg.offset);
        break;
      case "STATE_REQUEST":
        this.sendFullState(from);
        break;
      default:
        break; // Host->Guest-only shapes arriving here are ignored, not an error
    }
  }

  /** Staleness gate for the unreliable `stream` channel - see protocol.ts's SEQUENCING note. */
  private acceptStream(from: PlayerId, msg: StreamMessage): boolean {
    const last = this.lastStreamSeq.get(from) ?? -1;
    if (dropStale(last, msg)) return false;
    this.lastStreamSeq.set(from, msg.seq);
    return true;
  }

  private handleJoin(from: PlayerId, name: string, color: string): void {
    const alreadyKnown = this.players.has(from);
    if (!alreadyKnown && this.players.size >= MAX_PLAYERS) {
      this.sendControl(from, { type: "ROOM_FULL" });
      return;
    }

    const player: Player = { id: from, name, color };
    this.players.set(from, player);

    // Unicast reply: stamps the CURRENT seq (baseline), does not increment.
    this.sendControl(from, {
      type: "WELCOME",
      you: from,
      players: this.getPlayers(),
      state: this.state,
      hostEpoch: this.hostEpoch,
      seq: this.seq,
    });
    // Genuine broadcast: increments. Reaches the new Guest too (redundant
    // with WELCOME's `players`, but harmless - same idempotent overwrite).
    this.broadcastControl({ type: "PLAYER_LIST", players: this.getPlayers(), seq: this.nextSeq() });
    this.notify();
  }

  private handleGrabRequest(from: PlayerId, groupId: GroupId): void {
    const result = this.performGrab(from, groupId);
    if (!result.granted) {
      this.sendControl(from, {
        type: "GRAB_DENIED",
        groupId,
        playerId: from,
        reason: result.reason ?? "held",
      });
    }
    this.notify();
  }

  private handleDrop(from: PlayerId, groupId: GroupId, offset: Point): void {
    this.performDrop(from, groupId, offset);
    this.notify();
  }

  private handlePeerLeave(id: PlayerId): void {
    for (const [groupIdKey, holder] of Object.entries(this.state.heldBy)) {
      if (holder === id) {
        this.state = releaseGroup(this.state, Number(groupIdKey), id);
      }
    }
    if (this.players.delete(id)) {
      this.broadcastControl({ type: "PLAYER_LIST", players: this.getPlayers(), seq: this.nextSeq() });
    }
    this.notify();
  }

  // ── Shared arbitration (used by both the Guest-facing handlers above and
  //    the local-intent methods above them - the ONLY place grab/move/drop
  //    logic lives, so the Host's own play and a Guest's play can never
  //    diverge in behaviour). ──

  private performGrab(
    from: PlayerId,
    groupId: GroupId
  ): { readonly granted: boolean; readonly reason?: "held" | "not-found" } {
    const result = grabGroup(this.state, groupId, from);
    this.state = result.state;
    if (!result.granted) {
      return { granted: false, reason: result.reason === "not-found" ? "not-found" : "held" };
    }
    // Bringing the grabbed Group to the front is a judgement call (not
    // spelled out in the brief) but matches the obvious drag UX; see report.
    this.state = bringToFront(this.state, groupId);
    const z = this.state.groups[groupId]?.z ?? 0;
    this.broadcastControl({ type: "GRAB_GRANTED", seq: this.nextSeq(), groupId, playerId: from, z });
    return { granted: true };
  }

  /** Returns false (no-op) if `from` doesn't currently hold `groupId` - stale/unauthorized. */
  private performMove(from: PlayerId, groupId: GroupId, offset: Point): boolean {
    if (this.state.heldBy[groupId] !== from) return false;
    this.state = moveGroup(this.state, groupId, offset);
    return true;
  }

  private performDrop(from: PlayerId, groupId: GroupId, offset: Point): void {
    if (this.state.heldBy[groupId] !== from) return; // stale/unauthorized - ignore
    this.state = moveGroup(this.state, groupId, offset);
    this.state = releaseGroup(this.state, groupId, from);

    const pieceSample = this.state.groups[groupId]?.pieceIds[0];
    const { state, merged } = resolveDrop(this.state, this.puzzle, groupId);
    this.state = state;

    const finalId = pieceSample !== undefined ? groupOfPiece(this.state, pieceSample) : undefined;
    const finalGroup = finalId !== undefined ? this.state.groups[finalId] : undefined;

    if (finalId !== undefined && finalGroup !== undefined) {
      this.broadcastControl({
        type: "SNAP",
        seq: this.nextSeq(),
        groups: [finalGroup],
        removedGroupIds: merged,
        nextZ: this.state.nextZ,
        nextGroupId: this.state.nextGroupId,
      });
    }

    if (isComplete(this.state)) {
      this.broadcastControl({ type: "COMPLETE", seq: this.nextSeq() });
    }
  }

  // ── Resync ──

  private broadcastFullState(): void {
    this.broadcastControl({ type: "FULL_STATE", state: this.state, seq: this.nextSeq() });
  }

  /** On-demand reply to a Guest's STATE_REQUEST - re-baselines, doesn't consume a seq slot. */
  private sendFullState(to: PlayerId): void {
    this.sendControl(to, { type: "FULL_STATE", state: this.state, seq: this.seq });
  }

  // ── Outbound plumbing ──

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private nextOutStreamSeq(): number {
    this.outStreamSeq += 1;
    return this.outStreamSeq;
  }

  private sendControl(to: Recipient, msg: ProtocolMessage): void {
    this.transport.send("control", to, msg);
  }

  private broadcastControl(msg: ProtocolMessage): void {
    this.transport.send("control", BROADCAST, msg);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
