/**
 * The Guest-side mirror. Applies the Host's authoritative state, supports
 * optimistic local dragging (apply locally immediately; reconcile once the
 * Host's authoritative echo/snap arrives), tracks other players' live cursors,
 * and pulls a resync when it notices a sequence gap on the control channel.
 *
 * Talks over a Transport (see ../types.ts) using the message shapes defined
 * in host.ts (ClientMessage / HostMessage) — this file is the other half of
 * that local protocol.
 */

import type { GameState, GroupId, Player, PlayerId, Point, Transport } from "../types";
import { BROADCAST } from "../types";
import { deserialize, isComplete as isStateComplete, mergeGroups, moveGroup } from "./state";
import type { ClientMessage, HostMessage } from "./host";

const EMPTY_STATE: GameState = { groups: {}, heldBy: {}, nextZ: 0, nextGroupId: 0 };

export type ClientOptions = {
  readonly transport: Transport;
  readonly name: string;
  readonly color: string;
};

export class Client {
  private readonly transport: Transport;
  private state: GameState = EMPTY_STATE;
  private playerId: PlayerId | undefined;
  private players = new Map<PlayerId, Player>();
  private readonly cursors = new Map<PlayerId, Point>();
  private ready = false;
  private joinDeniedReason: "room-full" | undefined;
  private lastGrabDenied: { readonly groupId: GroupId; readonly reason: "held" | "not-found" } | undefined;
  private completed = false;
  private lastSeq = -1;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly listeners = new Set<() => void>();

  constructor(opts: ClientOptions) {
    this.transport = opts.transport;
    this.unsubscribers.push(
      this.transport.onMessage((_from, _channel, msg) => this.handleMessage(msg as HostMessage))
    );
    this.sendControl({ type: "join", name: opts.name, color: opts.color });
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
    this.sendControl({ type: "grabRequest", groupId });
  }

  /** Optimistic mid-drag move: applied locally immediately, then relayed. */
  move(groupId: GroupId, offset: Point): void {
    this.state = moveGroup(this.state, groupId, offset);
    this.notify();
    this.transport.send("stream", BROADCAST, { type: "move", groupId, offset } satisfies ClientMessage);
  }

  /** Optimistic drop: applied locally immediately; Host's "snap" reconciles it. */
  drop(groupId: GroupId, offset: Point): void {
    this.state = moveGroup(this.state, groupId, offset);
    this.notify();
    this.sendControl({ type: "drop", groupId, offset });
  }

  sendCursor(point: Point): void {
    this.transport.send("stream", BROADCAST, { type: "cursor", point } satisfies ClientMessage);
  }

  requestResync(): void {
    this.sendControl({ type: "stateRequest" });
  }

  close(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }

  // ── Inbound (Host -> Guest) ──

  private handleMessage(msg: HostMessage): void {
    switch (msg.type) {
      case "welcome":
        // Establishes our baseline; not gap-checked against the old one.
        this.lastSeq = msg.seq;
        this.playerId = msg.playerId;
        this.state = deserialize(msg.state);
        this.players = new Map(msg.players.map((p) => [p.id, p]));
        this.ready = true;
        this.joinDeniedReason = undefined;
        break;

      case "joinDenied":
        // Not part of the ordered stream — no seq to track.
        this.joinDeniedReason = msg.reason;
        break;

      case "state":
        // Re-establishes our baseline; this IS the resync, not gap-checked.
        this.lastSeq = msg.seq;
        this.state = deserialize(msg.state);
        break;

      case "grabGranted":
        this.checkSeqGap(msg.seq);
        this.applyAuthoritativeGrab(msg.groupId, msg.playerId, msg.z);
        break;

      case "grabDenied":
        if (msg.playerId === this.playerId) {
          this.lastGrabDenied = { groupId: msg.groupId, reason: msg.reason };
          // We don't know the true holder/position from this message alone —
          // pull a resync so our optimistic view converges with the Host's.
          this.requestResync();
        }
        break;

      case "move":
        // Unreliable `stream` channel — drops are normal, no seq to check.
        this.state = moveGroup(this.state, msg.groupId, msg.offset);
        break;

      case "snap":
        this.checkSeqGap(msg.seq);
        this.applyAuthoritativeSnap(msg.groupId, msg.merged, msg.offset, msg.z);
        break;

      case "playerJoined":
        this.checkSeqGap(msg.seq);
        this.players.set(msg.player.id, msg.player);
        break;

      case "playerLeft":
        this.checkSeqGap(msg.seq);
        this.players.delete(msg.playerId);
        break;

      case "complete":
        this.checkSeqGap(msg.seq);
        this.completed = true;
        break;

      case "cursor":
        if (msg.playerId !== this.playerId) {
          this.cursors.set(msg.playerId, msg.point);
        }
        break;
    }

    this.notify();
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

  private applyAuthoritativeSnap(
    finalGroupId: GroupId,
    merged: readonly GroupId[],
    offset: Point,
    z: number
  ): void {
    let s = this.state;
    for (const absorbedId of merged) {
      if (s.groups[absorbedId] && s.groups[finalGroupId]) {
        s = mergeGroups(s, finalGroupId, absorbedId);
      }
    }
    const group = s.groups[finalGroupId];
    if (group) {
      const groups = { ...s.groups, [finalGroupId]: { ...group, offset, z } };
      const heldBy = { ...s.heldBy };
      delete heldBy[finalGroupId];
      s = { ...s, groups, heldBy };
    }
    this.state = s;
  }

  private checkSeqGap(seq: number): void {
    if (this.lastSeq >= 0 && seq !== this.lastSeq + 1) {
      this.requestResync();
    }
    this.lastSeq = seq;
  }

  // ── Outbound plumbing ──

  private sendControl(msg: ClientMessage): void {
    this.transport.send("control", BROADCAST, msg);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
