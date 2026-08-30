/**
 * Supabase Realtime rendezvous for WebRTC signaling. Both sides join the
 * same Realtime channel `room:<code>`:
 *
 *   - the Host subscribes and listens for offers/ICE from any Guest;
 *   - a Guest broadcasts an SDP offer, the Host answers, and ICE candidates
 *     trickle both ways.
 *
 * Realtime **presence** is used only as a cheap "is a Host online" hint for
 * the UI (e.g. show "Resume puzzle" vs "Join"). It is NEVER authoritative
 * for who the Host is — the Host Epoch column on the `rooms` row is (see
 * CONTEXT.md, ADR-0001). Do not branch game logic on presence state.
 *
 * The Supabase client is injected rather than imported, so this module has
 * no hard dependency on `src/supabase/` (owned by another agent) — it only
 * depends on the small structural shape below, which the real
 * `@supabase/supabase-js` client satisfies.
 */

import type { PlayerId } from "../types";

// ── Minimal structural shape of what we need from supabase-js ──────────────

export interface BroadcastPayload<T> {
  readonly payload: T;
}

export interface RealtimeChannelLike {
  on(
    type: "broadcast",
    filter: { event: string },
    callback: (payload: BroadcastPayload<unknown>) => void,
  ): RealtimeChannelLike;
  on(
    type: "presence",
    filter: { event: "sync" | "join" | "leave" },
    callback: () => void,
  ): RealtimeChannelLike;
  send(message: {
    type: "broadcast";
    event: string;
    payload: unknown;
  }): Promise<unknown>;
  subscribe(callback?: (status: string) => void): RealtimeChannelLike;
  track(payload: unknown): Promise<unknown>;
  untrack(): Promise<unknown>;
  presenceState(): Record<string, readonly unknown[]>;
}

export interface SupabaseClientLike {
  channel(name: string): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): void;
}

// ── Wire shapes exchanged over the signaling channel ────────────────────────
// (Distinct from protocol.ts: these never touch the WebRTC data channels —
// they only ever travel over Supabase Realtime, before a P2P link exists.)

type OfferPayload = { readonly from: PlayerId; readonly sdp: RTCSessionDescriptionInit };
type AnswerPayload = {
  readonly from: PlayerId;
  readonly to: PlayerId;
  readonly sdp: RTCSessionDescriptionInit;
};
type IceFromGuestPayload = {
  readonly from: PlayerId;
  readonly candidate: RTCIceCandidateInit;
};
type IceFromHostPayload = {
  readonly from: PlayerId;
  readonly to: PlayerId;
  readonly candidate: RTCIceCandidateInit;
};
type RoomFullPayload = { readonly to: PlayerId };

const EVENT = {
  offer: "offer",
  answer: "answer",
  iceFromGuest: "ice-from-guest",
  iceFromHost: "ice-from-host",
  roomFull: "room-full",
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** RTCSessionDescriptionInit / RTCIceCandidateInit are opaque here — just require an object. */
function isPlainObject(v: unknown): boolean {
  return isRecord(v);
}

function isOfferPayload(v: unknown): v is OfferPayload {
  return isRecord(v) && isNonEmptyString(v.from) && isPlainObject(v.sdp);
}

function isAnswerPayload(v: unknown): v is AnswerPayload {
  return (
    isRecord(v) &&
    isNonEmptyString(v.from) &&
    isNonEmptyString(v.to) &&
    isPlainObject(v.sdp)
  );
}

function isIceFromGuestPayload(v: unknown): v is IceFromGuestPayload {
  return isRecord(v) && isNonEmptyString(v.from) && isPlainObject(v.candidate);
}

function isIceFromHostPayload(v: unknown): v is IceFromHostPayload {
  return (
    isRecord(v) &&
    isNonEmptyString(v.from) &&
    isNonEmptyString(v.to) &&
    isPlainObject(v.candidate)
  );
}

function isRoomFullPayload(v: unknown): v is RoomFullPayload {
  return isRecord(v) && isNonEmptyString(v.to);
}

// ── Public API ───────────────────────────────────────────────────────────

export type Unsubscribe = () => void;

export interface HostSignalingHandlers {
  /** A Guest wants to connect. */
  onOffer(from: PlayerId, sdp: RTCSessionDescriptionInit): void;
  onIceCandidateFromGuest(from: PlayerId, candidate: RTCIceCandidateInit): void;
}

export interface GuestSignalingHandlers {
  onAnswer(from: PlayerId, sdp: RTCSessionDescriptionInit): void;
  onIceCandidateFromHost(from: PlayerId, candidate: RTCIceCandidateInit): void;
  onRoomFull(): void;
  /** Cheap, non-authoritative "is a Host currently present" indicator. */
  onHostPresenceChange(online: boolean): void;
}

/**
 * Host-side signaling session for one Room. Construct, call `listen`, then
 * `sendAnswer` / `sendIceCandidate` / `sendRoomFull` as WebRTC negotiation
 * proceeds (driven by `peer.ts` + `hostNet.ts`).
 */
export class HostSignaling {
  private readonly channel: RealtimeChannelLike;
  private readonly client: SupabaseClientLike;
  private readonly selfId: PlayerId;

  constructor(client: SupabaseClientLike, roomCode: string, selfId: PlayerId) {
    this.client = client;
    this.selfId = selfId;
    this.channel = client.channel(`room:${roomCode}`);
  }

  listen(handlers: HostSignalingHandlers): void {
    this.channel
      .on("broadcast", { event: EVENT.offer }, ({ payload }) => {
        if (isOfferPayload(payload)) handlers.onOffer(payload.from, payload.sdp);
      })
      .on("broadcast", { event: EVENT.iceFromGuest }, ({ payload }) => {
        if (isIceFromGuestPayload(payload)) {
          handlers.onIceCandidateFromGuest(payload.from, payload.candidate);
        }
      })
      .subscribe();
    // Presence marks this Host as online — a hint for Guests deciding
    // whether to show "Join" vs "Resume puzzle". Not authoritative.
    void this.channel.track({ role: "host", playerId: this.selfId });
  }

  sendAnswer(to: PlayerId, sdp: RTCSessionDescriptionInit): void {
    const payload: AnswerPayload = { from: this.selfId, to, sdp };
    void this.channel.send({ type: "broadcast", event: EVENT.answer, payload });
  }

  sendIceCandidate(to: PlayerId, candidate: RTCIceCandidateInit): void {
    const payload: IceFromHostPayload = { from: this.selfId, to, candidate };
    void this.channel.send({ type: "broadcast", event: EVENT.iceFromHost, payload });
  }

  /** Reject a Guest before (or instead of) completing a WebRTC handshake — see hostNet.ts MAX_PLAYERS. */
  sendRoomFull(to: PlayerId): void {
    const payload: RoomFullPayload = { to };
    void this.channel.send({ type: "broadcast", event: EVENT.roomFull, payload });
  }

  close(): void {
    void this.channel.untrack();
    this.client.removeChannel(this.channel);
  }
}

/**
 * Guest-side signaling session for one Room. Construct, call `listen`, then
 * `sendOffer` / `sendIceCandidate` (driven by `peer.ts` + `guestNet.ts`).
 */
export class GuestSignaling {
  private readonly channel: RealtimeChannelLike;
  private readonly client: SupabaseClientLike;
  private readonly selfId: PlayerId;

  constructor(client: SupabaseClientLike, roomCode: string, selfId: PlayerId) {
    this.client = client;
    this.selfId = selfId;
    this.channel = client.channel(`room:${roomCode}`);
  }

  listen(handlers: GuestSignalingHandlers): void {
    this.channel
      .on("broadcast", { event: EVENT.answer }, ({ payload }) => {
        if (isAnswerPayload(payload) && payload.to === this.selfId) {
          handlers.onAnswer(payload.from, payload.sdp);
        }
      })
      .on("broadcast", { event: EVENT.iceFromHost }, ({ payload }) => {
        if (isIceFromHostPayload(payload) && payload.to === this.selfId) {
          handlers.onIceCandidateFromHost(payload.from, payload.candidate);
        }
      })
      .on("broadcast", { event: EVENT.roomFull }, ({ payload }) => {
        if (isRoomFullPayload(payload) && payload.to === this.selfId) {
          handlers.onRoomFull();
        }
      })
      .on("presence", { event: "sync" }, () => {
        handlers.onHostPresenceChange(this.isHostPresent());
      })
      .subscribe();
  }

  sendOffer(sdp: RTCSessionDescriptionInit): void {
    const payload: OfferPayload = { from: this.selfId, sdp };
    void this.channel.send({ type: "broadcast", event: EVENT.offer, payload });
  }

  sendIceCandidate(candidate: RTCIceCandidateInit): void {
    const payload: IceFromGuestPayload = { from: this.selfId, candidate };
    void this.channel.send({ type: "broadcast", event: EVENT.iceFromGuest, payload });
  }

  private isHostPresent(): boolean {
    const state = this.channel.presenceState();
    return Object.values(state).some((metas) =>
      metas.some((m) => isRecord(m) && m.role === "host"),
    );
  }

  close(): void {
    this.client.removeChannel(this.channel);
  }
}
