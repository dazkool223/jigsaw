/**
 * The authoritative Host. Owns the one true GameState, consumes a Transport
 * (see ../types.ts), and is the only thing that ever decides a grab, a
 * merge, or Completion.
 *
 * Message shapes are defined LOCALLY here (exported) rather than imported
 * from a shared protocol module, per instructions — another agent owns
 * src/net/protocol.ts and these will need reconciling with it. See the
 * final report for the exact shapes.
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
  serialize,
  type SerializedState,
} from "./state";
import { resolveDrop } from "./snap";
import type { GameState } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Wire messages (LOCAL to game/host.ts — reconcile with net/protocol.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Guest -> Host. */
export type ClientMessage =
  | { readonly type: "join"; readonly name: string; readonly color: string }
  | { readonly type: "grabRequest"; readonly groupId: GroupId }
  | { readonly type: "move"; readonly groupId: GroupId; readonly offset: Point }
  | { readonly type: "drop"; readonly groupId: GroupId; readonly offset: Point }
  | { readonly type: "cursor"; readonly point: Point }
  | { readonly type: "stateRequest" };

/**
 * Host -> Guest(s).
 *
 * `seq` is a monotonic counter, incremented once per BROADCAST that's part
 * of the ordered control stream: playerJoined, playerLeft, grabGranted,
 * snap, complete. A Guest gap-checks exactly these (see client.ts's
 * checkSeqGap) and pulls a resync on a gap.
 *
 * "welcome" and "state" also carry `seq`, but only to (re-)establish a
 * Guest's baseline — the Host stamps them with the CURRENT counter value
 * without incrementing it (a `state` broadcast from the resync timer is the
 * exception: it's a genuine broadcast and does increment). Receiving either
 * simply adopts `seq` as the new baseline rather than being gap-checked
 * against the old one, so answering one Guest's on-demand stateRequest can't
 * manufacture a phantom gap for everyone else.
 *
 * "joinDenied", "grabDenied", "move" and "cursor" carry no seq at all —
 * joinDenied/grabDenied are terminal one-off replies outside the ordered
 * stream, and move/cursor travel on the unreliable `stream` channel where
 * drops are normal, not gaps.
 */
export type HostMessage =
  | {
      readonly type: "welcome";
      readonly seq: number;
      readonly playerId: PlayerId;
      readonly state: SerializedState;
      readonly players: readonly Player[];
    }
  | { readonly type: "joinDenied"; readonly reason: "room-full" }
  | {
      readonly type: "grabGranted";
      readonly seq: number;
      readonly groupId: GroupId;
      readonly playerId: PlayerId;
      readonly z: number;
    }
  | {
      readonly type: "grabDenied";
      readonly groupId: GroupId;
      readonly playerId: PlayerId;
      readonly reason: "held" | "not-found";
    }
  | {
      readonly type: "move";
      readonly groupId: GroupId;
      readonly offset: Point;
      readonly playerId: PlayerId;
    }
  | {
      readonly type: "snap";
      readonly seq: number;
      readonly groupId: GroupId;
      readonly merged: readonly GroupId[];
      readonly offset: Point;
      readonly z: number;
    }
  | { readonly type: "state"; readonly seq: number; readonly state: SerializedState }
  | { readonly type: "playerJoined"; readonly seq: number; readonly player: Player }
  | { readonly type: "playerLeft"; readonly seq: number; readonly playerId: PlayerId }
  | { readonly type: "complete"; readonly seq: number }
  | { readonly type: "cursor"; readonly playerId: PlayerId; readonly point: Point };

export type HostOptions = {
  readonly transport: Transport;
  readonly puzzle: Puzzle;
  /** Seed-derived initial scatter, keyed by PieceId. See state.ts. */
  readonly scatterOffsets: Readonly<Record<PieceId, Point>>;
  readonly hostPlayerId: PlayerId;
  readonly hostPlayer: Player;
  /** Overrides RESYNC_INTERVAL_MS; mainly for tests. */
  readonly resyncIntervalMs?: number;
};

export class Host {
  private readonly transport: Transport;
  private readonly puzzle: Puzzle;
  private state: GameState;
  private readonly players = new Map<PlayerId, Player>();
  private seq = 0;
  private resyncTimer: ReturnType<typeof setInterval> | undefined;
  private readonly unsubscribers: Array<() => void> = [];

  constructor(opts: HostOptions) {
    this.transport = opts.transport;
    this.puzzle = opts.puzzle;
    this.state = createInitialState(opts.puzzle, opts.scatterOffsets);
    this.players.set(opts.hostPlayerId, opts.hostPlayer);

    this.unsubscribers.push(
      this.transport.onMessage((from, _channel, msg) => this.handleMessage(from, msg as ClientMessage)),
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

  private handleMessage(from: PlayerId, msg: ClientMessage): void {
    switch (msg.type) {
      case "join":
        this.handleJoin(from, msg);
        break;
      case "grabRequest":
        this.handleGrabRequest(from, msg.groupId);
        break;
      case "move":
        this.handleMove(from, msg.groupId, msg.offset);
        break;
      case "drop":
        this.handleDrop(from, msg.groupId, msg.offset);
        break;
      case "cursor":
        this.transport.send("stream", BROADCAST, {
          type: "cursor",
          playerId: from,
          point: msg.point,
        } satisfies HostMessage);
        break;
      case "stateRequest":
        this.sendFullState(from);
        break;
    }
  }

  private handleJoin(from: PlayerId, msg: { readonly name: string; readonly color: string }): void {
    const alreadyKnown = this.players.has(from);
    if (!alreadyKnown && this.players.size >= MAX_PLAYERS) {
      this.sendControl(from, { type: "joinDenied", reason: "room-full" });
      return;
    }

    const player: Player = { id: from, name: msg.name, color: msg.color };
    this.players.set(from, player);

    this.sendControl(from, {
      type: "welcome",
      seq: this.seq,
      playerId: from,
      state: serialize(this.state),
      players: this.getPlayers(),
    });
    this.broadcastControl({ type: "playerJoined", seq: this.nextSeq(), player });
  }

  private handleGrabRequest(from: PlayerId, groupId: GroupId): void {
    const result = grabGroup(this.state, groupId, from);
    this.state = result.state;
    if (!result.granted) {
      this.sendControl(from, {
        type: "grabDenied",
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
    this.broadcastControl({ type: "grabGranted", seq: this.nextSeq(), groupId, playerId: from, z });
  }

  private handleMove(from: PlayerId, groupId: GroupId, offset: Point): void {
    if (this.state.heldBy[groupId] !== from) return; // stale/unauthorized — ignore
    this.state = moveGroup(this.state, groupId, offset);
    // Mid-drag positions are best-effort, high-frequency: relay on `stream`.
    this.transport.send("stream", BROADCAST, {
      type: "move",
      groupId,
      offset,
      playerId: from,
    } satisfies HostMessage);
  }

  private handleDrop(from: PlayerId, groupId: GroupId, offset: Point): void {
    if (this.state.heldBy[groupId] !== from) return; // stale/unauthorized — ignore
    this.state = moveGroup(this.state, groupId, offset);
    this.state = releaseGroup(this.state, groupId, from);

    const pieceSample = this.state.groups[groupId]?.pieceIds[0];
    // `snapped` isn't surfaced separately on the wire — a Lattice snap that
    // didn't also merge still shows up in the "snap" message's offset below.
    const { state, merged } = resolveDrop(this.state, this.puzzle, groupId);
    this.state = state;

    const finalId = pieceSample !== undefined ? groupOfPiece(this.state, pieceSample) : undefined;
    const finalGroup = finalId !== undefined ? this.state.groups[finalId] : undefined;

    if (finalId !== undefined && finalGroup !== undefined) {
      this.broadcastControl({
        type: "snap",
        seq: this.nextSeq(),
        groupId: finalId,
        merged,
        offset: finalGroup.offset,
        z: finalGroup.z,
      });
    }

    if (isComplete(this.state)) {
      this.broadcastControl({ type: "complete", seq: this.nextSeq() });
    }
  }

  private handlePeerLeave(id: PlayerId): void {
    for (const [groupIdKey, holder] of Object.entries(this.state.heldBy)) {
      if (holder === id) {
        this.state = releaseGroup(this.state, Number(groupIdKey), id);
      }
    }
    if (this.players.delete(id)) {
      this.broadcastControl({ type: "playerLeft", seq: this.nextSeq(), playerId: id });
    }
  }

  // ── Resync ──

  private broadcastFullState(): void {
    this.broadcastControl({ type: "state", seq: this.nextSeq(), state: serialize(this.state) });
  }

  /** On-demand reply to a Guest's stateRequest — re-baselines, doesn't consume a seq slot. */
  private sendFullState(to: PlayerId): void {
    this.sendControl(to, { type: "state", seq: this.seq, state: serialize(this.state) });
  }

  // ── Outbound plumbing ──

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  private sendControl(to: Recipient, msg: HostMessage): void {
    this.transport.send("control", to, msg);
  }

  private broadcastControl(msg: HostMessage): void {
    this.transport.send("control", BROADCAST, msg);
  }
}
