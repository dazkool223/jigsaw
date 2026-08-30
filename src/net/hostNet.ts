/**
 * Host-side `Transport` (see `../types`). Owns one `Peer` per connected
 * Guest, fans messages out over `HostSignaling`, and enforces `MAX_PLAYERS`.
 *
 * This is a deep module on purpose: constructing a `HostNet` is enough to
 * start accepting Guest connections for a Room — callers only ever see the
 * `Transport` surface (`send` / `onMessage` / `onPeerJoin` / `onPeerLeave` /
 * `close`), never the WebRTC or signaling plumbing underneath. That mirrors
 * `LoopbackTransport` (game/loopback.ts, M1's in-process stand-in), so
 * swapping one for the other is just swapping which class the caller
 * constructs.
 */

import { MAX_PLAYERS } from "../config";
import type { Channel, PlayerId, Recipient, Transport } from "../types";
import { BROADCAST } from "../types";
import { Peer, type CreatePeerConnection } from "./peer";
import { HostSignaling, type SupabaseClientLike } from "./signaling";

export interface HostNetOptions {
  readonly client: SupabaseClientLike;
  readonly roomCode: string;
  /** This Host's own PlayerId (used only for signaling presence/addressing). */
  readonly selfId: PlayerId;
  /** Injectable for testing; defaults to the real global RTCPeerConnection. */
  readonly createPeerConnection?: CreatePeerConnection;
}

type Unsubscribe = () => void;

interface GuestConnection {
  readonly peer: Peer;
  /** True once this Guest has counted against MAX_PLAYERS and fired onPeerJoin. */
  joined: boolean;
}

export class HostNet implements Transport {
  private readonly createPeerConnection: CreatePeerConnection | undefined;
  private readonly signaling: HostSignaling;

  private readonly guests = new Map<PlayerId, GuestConnection>();

  private readonly messageHandlers = new Set<
    (from: PlayerId, channel: Channel, msg: unknown) => void
  >();
  private readonly joinHandlers = new Set<(id: PlayerId) => void>();
  private readonly leaveHandlers = new Set<(id: PlayerId) => void>();

  constructor(options: HostNetOptions) {
    this.createPeerConnection = options.createPeerConnection;
    this.signaling = new HostSignaling(options.client, options.roomCode, options.selfId);

    this.signaling.listen({
      onOffer: (from, sdp) => void this.handleOffer(from, sdp),
      onIceCandidateFromGuest: (from, candidate) => {
        void this.guests.get(from)?.peer.addIceCandidate(candidate);
      },
    });
  }

  /** Guests currently counted against MAX_PLAYERS (i.e. past the connect handshake). */
  get connectedCount(): number {
    let n = 0;
    for (const g of this.guests.values()) if (g.joined) n++;
    return n;
  }

  // ── Transport ────────────────────────────────────────────────────────────

  send(channel: Channel, to: Recipient, msg: unknown): void {
    if (to === BROADCAST) {
      for (const g of this.guests.values()) {
        if (g.joined) g.peer.send(channel, msg);
      }
      return;
    }
    const g = this.guests.get(to);
    if (g?.joined) g.peer.send(channel, msg);
  }

  onMessage(handler: (from: PlayerId, channel: Channel, msg: unknown) => void): Unsubscribe {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onPeerJoin(handler: (id: PlayerId) => void): Unsubscribe {
    this.joinHandlers.add(handler);
    return () => this.joinHandlers.delete(handler);
  }

  onPeerLeave(handler: (id: PlayerId) => void): Unsubscribe {
    this.leaveHandlers.add(handler);
    return () => this.leaveHandlers.delete(handler);
  }

  close(): void {
    for (const [id] of this.guests) this.disconnect(id);
    this.signaling.close();
  }

  // ── Guest lifecycle ──────────────────────────────────────────────────────

  disconnect(guestId: PlayerId): void {
    const g = this.guests.get(guestId);
    if (!g) return;
    this.guests.delete(guestId);
    g.peer.close();
    if (g.joined) {
      for (const h of this.leaveHandlers) h(guestId);
    }
  }

  private async handleOffer(guestId: PlayerId, sdp: RTCSessionDescriptionInit): Promise<void> {
    if (this.guests.has(guestId)) return; // duplicate offer (e.g. retried broadcast) — ignore

    // Host counts as one of MAX_PLAYERS; the rest is Guest capacity.
    if (this.connectedCount >= MAX_PLAYERS - 1) {
      this.signaling.sendRoomFull(guestId);
      return;
    }

    const peer = new Peer({
      role: "answerer",
      createPeerConnection: this.createPeerConnection,
      logLabel: `host:${guestId}`,
    });
    const connection: GuestConnection = { peer, joined: false };
    this.guests.set(guestId, connection);

    peer.onIceCandidate((candidate) => this.signaling.sendIceCandidate(guestId, candidate));
    peer.onMessage((channel, msg) => {
      for (const h of this.messageHandlers) h(guestId, channel, msg);
    });
    peer.onStateChange((state) => {
      if (state === "connected" && !connection.joined) {
        connection.joined = true;
        for (const h of this.joinHandlers) h(guestId);
      } else if ((state === "failed" || state === "closed") && this.guests.has(guestId)) {
        const wasJoined = connection.joined;
        this.guests.delete(guestId);
        if (wasJoined) {
          for (const h of this.leaveHandlers) h(guestId);
        }
      }
    });

    const answer = await peer.createAnswer(sdp);
    this.signaling.sendAnswer(guestId, answer);
  }
}
