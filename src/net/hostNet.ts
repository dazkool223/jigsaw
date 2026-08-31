/**
 * Host-side `Transport` (see `../types`). Owns one `Peer` per connected
 * Guest, fans messages out over `HostSignaling`, and enforces `MAX_PLAYERS`.
 *
 * This is a deep module on purpose: constructing a `HostNet` is enough to
 * start accepting Guest connections for a Room - callers only ever see the
 * `Transport` surface (`send` / `onMessage` / `onPeerJoin` / `onPeerLeave` /
 * `close`), never the WebRTC or signaling plumbing underneath. That mirrors
 * `LoopbackTransport` (game/loopback.ts, M1's in-process stand-in), so
 * swapping one for the other is just swapping which class the caller
 * constructs.
 *
 * Two ordering hazards are handled here, both from a real outage
 * (docs/rca/0001-guests-cannot-connect-across-networks.md):
 *
 *  - A Guest trickles ICE candidates the moment it applies its own offer, so
 *    they chase the offer down the same Realtime channel and can arrive before
 *    this side has a `Peer` to give them to. They are buffered per Guest and
 *    handed over as soon as one exists.
 *
 *  - A second offer from a PlayerId we already hold means that Guest gave up
 *    on the first attempt and started over. `PlayerId` is persisted per device,
 *    so it is the SAME id every time; treating the repeat as a duplicate to
 *    ignore left retrying Guests unanswerable until this side's own timeout
 *    expired.
 */

import { MAX_PLAYERS } from "../config";
import type { Channel, PlayerId, Recipient, Transport } from "../types";
import { BROADCAST } from "../types";
import { resolveIceServers } from "./iceServers";
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

/**
 * Cap on candidates held for a Guest with no `Peer` yet. A browser gathers
 * well under this; the cap only stops a noisy or hostile broadcaster on the
 * Room's channel from growing the map without bound.
 */
const MAX_BUFFERED_CANDIDATES_PER_GUEST = 40;

/**
 * Cap on distinct PlayerIds tracked before any of them has a `Peer`. Anyone
 * broadcasting here already holds the Room code and could simply join, so this
 * is not a security boundary - just a bound on how much memory a noisy channel
 * can cost the Host's tab. Comfortably above MAX_PLAYERS.
 */
const MAX_TRACKED_GUEST_IDS = 64;

export class HostNet implements Transport {
  private readonly createPeerConnection: CreatePeerConnection | undefined;
  private readonly signaling: HostSignaling;

  private readonly guests = new Map<PlayerId, GuestConnection>();
  /** Candidates that arrived before this Guest's `Peer` existed - see the file header. */
  private readonly earlyCandidates = new Map<PlayerId, RTCIceCandidateInit[]>();
  /**
   * Per-Guest offer counter. Negotiating is async, so two offers from one
   * Guest can be in flight together; the newest must win. Without this the
   * older one can finish last and answer with SDP the Guest has already
   * thrown away.
   */
  private readonly offerGeneration = new Map<PlayerId, number>();

  private readonly messageHandlers = new Set<
    (from: PlayerId, channel: Channel, msg: unknown) => void
  >();
  private readonly joinHandlers = new Set<(id: PlayerId) => void>();
  private readonly leaveHandlers = new Set<(id: PlayerId) => void>();

  private closed = false;

  constructor(options: HostNetOptions) {
    this.createPeerConnection = options.createPeerConnection;
    this.signaling = new HostSignaling(options.client, options.roomCode, options.selfId);

    this.signaling.listen({
      onOffer: (from, sdp) => void this.handleOffer(from, sdp),
      onIceCandidateFromGuest: (from, candidate) => this.handleGuestCandidate(from, candidate),
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
    this.closed = true;
    for (const [id] of this.guests) this.disconnect(id);
    this.earlyCandidates.clear();
    this.offerGeneration.clear();
    this.signaling.close();
  }

  // ── Guest lifecycle ──────────────────────────────────────────────────────

  disconnect(guestId: PlayerId): void {
    const g = this.guests.get(guestId);
    if (!g) return;
    // Delete BEFORE closing: peer.close() fires the state handler
    // synchronously, and it must not find this entry and fire leave twice.
    this.guests.delete(guestId);
    this.earlyCandidates.delete(guestId);
    g.peer.close();
    if (g.joined) {
      for (const h of this.leaveHandlers) h(guestId);
    }
  }

  private handleGuestCandidate(from: PlayerId, candidate: RTCIceCandidateInit): void {
    const existing = this.guests.get(from);
    if (existing) {
      // Peer buffers internally until its own remote description is applied.
      void existing.peer.addIceCandidate(candidate);
      return;
    }
    const buffered = this.earlyCandidates.get(from);
    if (!buffered) {
      if (this.earlyCandidates.size >= MAX_TRACKED_GUEST_IDS) return;
      this.earlyCandidates.set(from, [candidate]);
      return;
    }
    if (buffered.length >= MAX_BUFFERED_CANDIDATES_PER_GUEST) return;
    buffered.push(candidate);
  }

  private async handleOffer(guestId: PlayerId, sdp: RTCSessionDescriptionInit): Promise<void> {
    // A repeat offer is a RETRY, not a duplicate: PlayerId is persisted per
    // device, so a Guest whose first attempt failed comes back with the same
    // id. Tear the dead connection down and negotiate again, otherwise the
    // Guest is unanswerable until our own connect timeout expires - which is
    // exactly long enough for "Try again" to look permanently broken.
    if (this.guests.has(guestId)) {
      console.debug(`[hostNet] re-offer from ${guestId} - replacing the previous connection`);
      this.disconnect(guestId);
    }

    // Host counts as one of MAX_PLAYERS; the rest is Guest capacity.
    if (this.connectedCount >= MAX_PLAYERS - 1) {
      this.signaling.sendRoomFull(guestId);
      return;
    }
    if (!this.offerGeneration.has(guestId) && this.offerGeneration.size >= MAX_TRACKED_GUEST_IDS) {
      return;
    }

    // Claim this negotiation. Anything already in flight for this Guest is now
    // stale and bails at its next checkpoint.
    const generation = (this.offerGeneration.get(guestId) ?? 0) + 1;
    this.offerGeneration.set(guestId, generation);
    const current = (): boolean =>
      !this.closed && this.offerGeneration.get(guestId) === generation;

    const iceServers = await resolveIceServers();
    if (!current()) return;

    const peer = new Peer({
      role: "answerer",
      iceServers,
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
      // Guard on identity, not just presence: a replaced connection's late
      // state change must not evict the connection that replaced it.
      if (this.guests.get(guestId) !== connection) return;
      if (state === "connected" && !connection.joined) {
        connection.joined = true;
        for (const h of this.joinHandlers) h(guestId);
      } else if (state === "failed" || state === "closed") {
        const wasJoined = connection.joined;
        this.guests.delete(guestId);
        this.earlyCandidates.delete(guestId);
        if (wasJoined) {
          for (const h of this.leaveHandlers) h(guestId);
        }
      }
    });

    // Anything that raced ahead of the offer goes in before we answer; Peer
    // holds it until setRemoteDescription lands inside createAnswer().
    const early = this.earlyCandidates.get(guestId);
    if (early) {
      this.earlyCandidates.delete(guestId);
      for (const candidate of early) void peer.addIceCandidate(candidate);
    }

    const answer = await peer.createAnswer(sdp);
    // Answering with SDP for an offer the Guest has already abandoned is worse
    // than not answering: it wastes their whole connect budget.
    if (!current() || this.guests.get(guestId) !== connection) return;
    this.signaling.sendAnswer(guestId, answer);
  }
}
