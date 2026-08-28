/**
 * The authoritative Host. Owns the one true GameState, consumes a Transport
 * (see ../types.ts), and is the only thing that ever decides a grab, a
 * merge, or Completion.
 *
 * Wire messages are the canonical shapes from `../net/protocol` — see that
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
  /** Seed-derived initial scatter, keyed by PieceId. See state.ts. */
  readonly scatterOffsets: Readonly<Record<PieceId, Point>>;
  readonly hostPlayerId: PlayerId;
  readonly hostPlayer: Player;
  /** Overrides RESYNC_INTERVAL_MS; mainly for tests. */
  readonly resyncIntervalMs?: number;
  /**
   * The Host Epoch to stamp on WELCOME (protocol.ts requires it). Host Epoch
   * arbitration itself (ADR-0001) lives in the session/Supabase layer, which
   * is out of scope for game/host.ts — this is just a pass-through so a
   * caller that HAS claimed an epoch can thread it through. Defaults to 0
   * for callers (e.g. the M1 loopback path) that don't have one yet.
   */
  readonly hostEpoch?: number;
};

export class Host {
  private readonly transport: Transport;
  private readonly puzzle: Puzzle;
  private state: GameState;
  private readonly players = new Map<PlayerId, Player>();
  private readonly hostEpoch: number;
  private seq = 0;
  /** Per-sender staleness tracking for the unreliable `stream` channel (MOVE, CURSOR). */
  private readonly lastStreamSeq = new Map<PlayerId, number>();
  private resyncTimer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(opts: HostOptions) {
    this.transport = opts.transport;
    this.puzzle = opts.puzzle;
    this.state = createInitialState(opts.puzzle, opts.scatterOffsets);
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

  close(): void {
    if (this.resyncTimer !== undefined) clearInterval(this.resyncTimer);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }

  // ── Inbound ──

  private handleMessage(from: PlayerId, raw: unknown): void {
    const msg = parseMessage(raw);
    if (!msg) return; // malformed / not a Guest->Host shape we recognise — drop

    switch (msg.type) {
      case "JOIN":
        this.handleJoin(from, msg.name, msg.color);
        break;
      case "GRAB":
        this.handleGrabRequest(from, msg.groupId);
        break;
      case "MOVE":
        if (this.acceptStream(from, msg)) this.handleMove(from, msg);
        break;
      case "DROP":
        this.handleDrop(from, msg.groupId, msg.offset);
        break;
      case "CURSOR":
        if (this.acceptStream(from, msg)) {
          // Best-effort relay, unmodified (including the original seq) —
          // other Guests gap-check it themselves per-sender.
          this.transport.send("stream", BROADCAST, msg);
        }
        break;
      case "STATE_REQUEST":
        this.sendFullState(from);
        break;
      default:
        break; // Host->Guest-only shapes arriving here are ignored, not an error
    }
  }

  /** Staleness gate for the unreliable `stream` channel — see protocol.ts's SEQUENCING note. */
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
    // with WELCOME's `players`, but harmless — same idempotent overwrite).
    this.broadcastControl({ type: "PLAYER_LIST", players: this.getPlayers(), seq: this.nextSeq() });
  }

  private handleGrabRequest(from: PlayerId, groupId: GroupId): void {
    const result = grabGroup(this.state, groupId, from);
    this.state = result.state;
    if (!result.granted) {
      this.sendControl(from, {
        type: "GRAB_DENIED",
        groupId,
        playerId: from,
        reason: result.reason === "not-found" ? "not-found" : "held",
      });
      return;
    }
    // Bringing the grabbed Group to the front is a judgement call (not
    // spelled out in the brief) but matches the obvious drag UX; see report.
    this.state = bringToFront(this.state, groupId);
    const z = this.state.groups[groupId]?.z ?? 0;
    this.broadcastControl({ type: "GRAB_GRANTED", seq: this.nextSeq(), groupId, playerId: from, z });
  }

  private handleMove(from: PlayerId, msg: { readonly groupId: GroupId; readonly offset: Point }): void {
    if (this.state.heldBy[msg.groupId] !== from) return; // stale/unauthorized — ignore
    this.state = moveGroup(this.state, msg.groupId, msg.offset);
  }

  private handleDrop(from: PlayerId, groupId: GroupId, offset: Point): void {
    if (this.state.heldBy[groupId] !== from) return; // stale/unauthorized — ignore
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

  private handlePeerLeave(id: PlayerId): void {
    for (const [groupIdKey, holder] of Object.entries(this.state.heldBy)) {
      if (holder === id) {
        this.state = releaseGroup(this.state, Number(groupIdKey), id);
      }
    }
    if (this.players.delete(id)) {
      this.broadcastControl({ type: "PLAYER_LIST", players: this.getPlayers(), seq: this.nextSeq() });
    }
  }

  // ── Resync ──

  private broadcastFullState(): void {
    this.broadcastControl({ type: "FULL_STATE", state: this.state, seq: this.nextSeq() });
  }

  /** On-demand reply to a Guest's STATE_REQUEST — re-baselines, doesn't consume a seq slot. */
  private sendFullState(to: PlayerId): void {
    this.sendControl(to, { type: "FULL_STATE", state: this.state, seq: this.seq });
  }

  // ── Outbound plumbing ──

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private sendControl(to: Recipient, msg: ProtocolMessage): void {
    this.transport.send("control", to, msg);
  }

  private broadcastControl(msg: ProtocolMessage): void {
    this.transport.send("control", BROADCAST, msg);
  }
}
