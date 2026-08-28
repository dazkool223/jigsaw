/**
 * The Guest-side mirror. Applies the Host's authoritative state, supports
 * optimistic local dragging (apply locally immediately; reconcile once the
 * Host's authoritative echo/snap arrives), tracks other players' live cursors,
 * and pulls a resync when it notices a sequence gap on the control channel.
 *
 * Talks over a Transport (see ../types.ts) using the canonical wire shapes
 * from `../net/protocol` — see that module's "SEQUENCING" note, which this
 * class implements: `checkSeqGap` runs only for genuine control-channel
 * broadcasts (GRAB_GRANTED, SNAP, PLAYER_LIST, COMPLETE); WELCOME and
 * FULL_STATE instead adopt `seq` as a new baseline without gap-checking it,
 * since either can legitimately arrive as a unicast reply that other Guests
 * never saw.
 */

import type { Group, GroupId, Player, PlayerId, Point, Transport } from "../types";
import { BROADCAST } from "../types";
import { isComplete as isStateComplete, moveGroup } from "./state";
import {
  dropStale,
  parseMessage,
  type ProtocolMessage,
  type StreamMessage,
} from "../net/protocol";
import type { GameState } from "../types";

const EMPTY_STATE: GameState = { groups: {}, heldBy: {}, nextZ: 0, nextGroupId: 0 };

export type ClientOptions = {
  readonly transport: Transport;
  /**
   * This Guest's own PlayerId. Required up front (rather than learned from
   * the Host's WELCOME, as in the old local protocol): protocol.ts's JOIN,
   * GRAB, DROP, MOVE, CURSOR and STATE_REQUEST all carry the sender's own
   * `playerId` in the payload itself, so the Client needs it before it can
   * send anything. Per CONTEXT.md, Player identity is already a per-device
   * id persisted in localStorage before a Room is ever joined, so callers
   * always have this available.
   */
  readonly playerId: PlayerId;
  readonly name: string;
  readonly color: string;
};

export class Client {
  private readonly transport: Transport;
  private state: GameState = EMPTY_STATE;
  private playerId: PlayerId;
  private players = new Map<PlayerId, Player>();
  private readonly cursors = new Map<PlayerId, Point>();
  private ready = false;
  private joinDeniedReason: "room-full" | undefined;
  private lastGrabDenied: { readonly groupId: GroupId; readonly reason: "held" | "not-found" } | undefined;
  private completed = false;
  private lastSeq = -1;
  /** Own outbound counter for everything sent on the unreliable `stream` channel. */
  private outStreamSeq = -1;
  /** Per-sender staleness tracking for inbound `stream` messages (own echoes included). */
  private readonly lastStreamSeq = new Map<PlayerId, number>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();

  constructor(opts: ClientOptions) {
    this.transport = opts.transport;
    this.playerId = opts.playerId;
    this.unsubscribers.push(
      this.transport.onMessage((_from, _channel, msg) => this.handleMessage(msg))
    );
    this.sendControl({ type: "JOIN", playerId: this.playerId, name: opts.name, color: opts.color });
  }

  // ── Queries ──

  getState(): GameState {
    return this.state;
  }

  getPlayerId(): PlayerId | undefined {
    return this.playerId;
  }

  getPlayers(): readonly Player[] {
    return [...this.players.values()];
  }

  getCursors(): ReadonlyMap<PlayerId, Point> {
    return this.cursors;
  }

  isReady(): boolean {
    return this.ready;
  }

  getJoinDeniedReason(): "room-full" | undefined {
    return this.joinDeniedReason;
  }

  /**
   * The most recent grab this Client requested that the Host denied (CONTEXT.md:
   * "a denied grab snaps the Group back for the loser") — lets the UI react.
   * Not auto-cleared; overwritten by the next denial.
   */
  getLastGrabDenied(): { readonly groupId: GroupId; readonly reason: "held" | "not-found" } | undefined {
    return this.lastGrabDenied;
  }

  isComplete(): boolean {
    return this.completed || isStateComplete(this.state);
  }

  /** Subscribe to "something changed" notifications. Returns an unsubscribe fn. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ── Intents (Guest -> Host) ──

  grab(groupId: GroupId): void {
    this.sendControl({ type: "GRAB", groupId, playerId: this.playerId });
  }

  /** Optimistic mid-drag move: applied locally immediately, then relayed. */
  move(groupId: GroupId, offset: Point): void {
    this.state = moveGroup(this.state, groupId, offset);
    this.notify();
    this.transport.send("stream", BROADCAST, {
      type: "MOVE",
      seq: this.nextOutStreamSeq(),
      groupId,
      playerId: this.playerId,
      offset,
    });
  }

  /** Optimistic drop: applied locally immediately; Host's SNAP reconciles it. */
  drop(groupId: GroupId, offset: Point): void {
    this.state = moveGroup(this.state, groupId, offset);
    this.notify();
    this.sendControl({ type: "DROP", groupId, playerId: this.playerId, offset });
  }

  sendCursor(point: Point): void {
    this.transport.send("stream", BROADCAST, {
      type: "CURSOR",
      seq: this.nextOutStreamSeq(),
      playerId: this.playerId,
      point,
    });
  }

  requestResync(): void {
    this.sendControl({ type: "STATE_REQUEST", playerId: this.playerId });
  }

  close(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }

  // ── Inbound (Host -> Guest) ──

  private handleMessage(raw: unknown): void {
    const msg = parseMessage(raw);
    if (!msg) return; // malformed / not a Host->Guest shape we recognise — drop

    switch (msg.type) {
      case "WELCOME":
        // Establishes our baseline; not gap-checked against the old one.
        this.lastSeq = msg.seq;
        this.playerId = msg.you;
        this.state = msg.state;
        this.players = new Map(msg.players.map((p) => [p.id, p]));
        this.ready = true;
        this.joinDeniedReason = undefined;
        break;

      case "ROOM_FULL":
        // Not part of the ordered stream — no seq to track.
        this.joinDeniedReason = "room-full";
        break;

      case "FULL_STATE":
        // Re-establishes our baseline; this IS the resync, not gap-checked.
        this.lastSeq = msg.seq;
        this.state = msg.state;
        break;

      case "GRAB_GRANTED":
        this.checkSeqGap(msg.seq);
        this.applyAuthoritativeGrab(msg.groupId, msg.playerId, msg.z);
        break;

      case "GRAB_DENIED":
        if (msg.playerId === this.playerId) {
          this.lastGrabDenied = { groupId: msg.groupId, reason: msg.reason };
          // We don't know the true holder/position from this message alone —
          // pull a resync so our optimistic view converges with the Host's.
          this.requestResync();
        }
        break;

      case "MOVE":
        // Unreliable `stream` channel — staleness-checked, not gap-checked.
        if (this.acceptStream(msg)) {
          this.state = moveGroup(this.state, msg.groupId, msg.offset);
        }
        break;

      case "SNAP":
        this.checkSeqGap(msg.seq);
        this.applyAuthoritativeSnap(msg.groups, msg.removedGroupIds, msg.nextZ, msg.nextGroupId);
        break;

      case "PLAYER_LIST":
        this.checkSeqGap(msg.seq);
        this.players = new Map(msg.players.map((p) => [p.id, p]));
        break;

      case "COMPLETE":
        this.checkSeqGap(msg.seq);
        this.completed = true;
        break;

      case "CURSOR":
        if (this.acceptStream(msg) && msg.playerId !== this.playerId) {
          this.cursors.set(msg.playerId, msg.point);
        }
        break;

      default:
        break; // Guest->Host-only shapes arriving here are ignored, not an error
    }

    this.notify();
  }

  /** Staleness gate for the unreliable `stream` channel — see protocol.ts's SEQUENCING note. */
  private acceptStream(msg: StreamMessage): boolean {
    const last = this.lastStreamSeq.get(msg.playerId) ?? -1;
    if (dropStale(last, msg)) return false;
    this.lastStreamSeq.set(msg.playerId, msg.seq);
    return true;
  }

  private nextOutStreamSeq(): number {
    this.outStreamSeq += 1;
    return this.outStreamSeq;
  }

  private applyAuthoritativeGrab(groupId: GroupId, playerId: PlayerId, z: number): void {
    const group = this.state.groups[groupId];
    if (!group) return;
    // Trust the Host unconditionally (unlike state.ts's grabGroup, which is
    // the Host's *arbitration* logic) — this is just applying its verdict.
    const heldBy = { ...this.state.heldBy, [groupId]: playerId };
    const groups = { ...this.state.groups, [groupId]: { ...group, z } };
    this.state = { ...this.state, groups, heldBy };
  }

  /**
   * SNAP carries the Host's already-merged result directly (full post-merge
   * `groups`, plus `removedGroupIds`), so — unlike the old local protocol —
   * the Client doesn't replay the merge itself via mergeGroups; it just
   * adopts the given groups verbatim and drops the removed ids. `heldBy` is
   * cleared for every id in both lists (a dropped Group is implicitly no
   * longer held), and the Host's authoritative counters are adopted too.
   */
  private applyAuthoritativeSnap(
    groups: readonly Group[],
    removedGroupIds: readonly GroupId[],
    nextZ: number,
    nextGroupId: GroupId
  ): void {
    const newGroups = { ...this.state.groups };
    const heldBy = { ...this.state.heldBy };

    for (const id of removedGroupIds) {
      delete newGroups[id];
      delete heldBy[id];
    }
    for (const g of groups) {
      newGroups[g.id] = g;
      delete heldBy[g.id];
    }

    this.state = { ...this.state, groups: newGroups, heldBy, nextZ, nextGroupId };
  }

  private checkSeqGap(seq: number): void {
    if (this.lastSeq >= 0 && seq !== this.lastSeq + 1) {
      this.requestResync();
    }
    this.lastSeq = seq;
  }

  // ── Outbound plumbing ──

  private sendControl(msg: ProtocolMessage): void {
    this.transport.send("control", BROADCAST, msg);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
