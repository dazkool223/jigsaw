/**
 * Guest-side `Transport` (see `../types`). Owns exactly one `Peer` - the
 * connection to the Host - composed with `GuestSignaling`. The Guest is
 * ALWAYS the WebRTC offerer (see `peer.ts` for why).
 *
 * `Transport` itself has no room for connection status / user-facing errors
 * (no `onError`/`onStatus` hook), but the plan requires showing "couldn't
 * connect" and "room is full" states. `GuestNet` therefore exposes
 * `onConnectionStatus` as an addition *beyond* `Transport` - flagged in the
 * hand-off notes as a possible gap in `types.ts`.
 */

import type { Channel, PlayerId, Recipient, Transport } from "../types";
import { Peer, type CreatePeerConnection, type PeerState } from "./peer";
import { GuestSignaling, type SupabaseClientLike } from "./signaling";

export interface GuestNetOptions {
  readonly client: SupabaseClientLike;
  readonly roomCode: string;
  /** This Guest's own PlayerId. */
  readonly selfId: PlayerId;
  /** Injectable for testing; defaults to the real global RTCPeerConnection. */
  readonly createPeerConnection?: CreatePeerConnection;
}

export type ConnectionStatus =
  | { readonly state: Exclude<PeerState, "failed">; readonly message?: undefined }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "room_full"; readonly message: string };

type Unsubscribe = () => void;

const ROOM_FULL_MESSAGE = "This room is full";

export class GuestNet implements Transport {
  private readonly peer: Peer;
  private readonly signaling: GuestSignaling;

  private hostId: PlayerId | null = null;
  private status: ConnectionStatus = { state: "new" };

  private readonly messageHandlers = new Set<
    (from: PlayerId, channel: Channel, msg: unknown) => void
  >();
  private readonly joinHandlers = new Set<(id: PlayerId) => void>();
  private readonly leaveHandlers = new Set<(id: PlayerId) => void>();
  private readonly statusHandlers = new Set<(status: ConnectionStatus) => void>();
  private readonly presenceHandlers = new Set<(online: boolean) => void>();

  private joinedFired = false;

  constructor(options: GuestNetOptions) {
    this.peer = new Peer({
      role: "offerer",
      createPeerConnection: options.createPeerConnection,
      logLabel: `guest:${options.selfId}`,
    });
    this.signaling = new GuestSignaling(options.client, options.roomCode, options.selfId);

    this.peer.onIceCandidate((candidate) => this.signaling.sendIceCandidate(candidate));
    this.peer.onMessage((channel, msg) => {
      const from = this.hostId;
      if (from === null) return; // shouldn't happen: messages only flow once connected
      for (const h of this.messageHandlers) h(from, channel, msg);
    });
    this.peer.onStateChange((state, message) => {
      this.setStatus(
        state === "failed"
          ? { state: "failed", message: message ?? "Couldn't connect" }
          : { state },
      );
      if (state === "connected" && !this.joinedFired && this.hostId !== null) {
        this.joinedFired = true;
        for (const h of this.joinHandlers) h(this.hostId);
      } else if ((state === "failed" || state === "closed") && this.joinedFired) {
        this.joinedFired = false;
        if (this.hostId !== null) {
          for (const h of this.leaveHandlers) h(this.hostId);
        }
      }
    });

    this.signaling.listen({
      onAnswer: (from, sdp) => {
        this.hostId = from;
        void this.peer.acceptAnswer(sdp).then(() => {
          // The control channel may already have opened by the time the
          // answer's promise resolves; re-check so onPeerJoin still fires.
          if (this.peer.getState() === "connected" && !this.joinedFired) {
            this.joinedFired = true;
            for (const h of this.joinHandlers) h(from);
          }
        });
      },
      onIceCandidateFromHost: (_from, candidate) => {
        void this.peer.addIceCandidate(candidate);
      },
      onRoomFull: () => {
        this.setStatus({ state: "room_full", message: ROOM_FULL_MESSAGE });
        this.peer.close();
      },
      onHostPresenceChange: (online) => {
        for (const h of this.presenceHandlers) h(online);
      },
    });
  }

  /** Kicks off the offer -> signaling -> answer handshake. Call once, after construction. */
  connect(): void {
    void this.peer.createOffer().then((offer) => this.signaling.sendOffer(offer));
  }

  getConnectionStatus(): ConnectionStatus {
    return this.status;
  }

  /** Cheap, non-authoritative "is a Host currently online" indicator - see signaling.ts. */
  onHostPresenceChange(handler: (online: boolean) => void): Unsubscribe {
    this.presenceHandlers.add(handler);
    return () => this.presenceHandlers.delete(handler);
  }

  onConnectionStatus(handler: (status: ConnectionStatus) => void): Unsubscribe {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  // ── Transport ────────────────────────────────────────────────────────────

  send(channel: Channel, _to: Recipient, msg: unknown): void {
    // Only one possible destination (the Host); `to` is accepted for
    // interface compatibility but ignored.
    this.peer.send(channel, msg);
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
    this.peer.close();
    this.signaling.close();
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const h of this.statusHandlers) h(status);
  }
}
