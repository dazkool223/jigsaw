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
 *
 * The `Peer` is built in `connect()`, not in the constructor, because the ICE
 * servers it needs are resolved asynchronously (TURN credentials are
 * short-lived, so they are fetched rather than compiled in - see
 * iceServers.ts). Signaling is listening from construction either way, so
 * nothing is missed in between.
 */

import type { Channel, PlayerId, Recipient, Transport } from "../types";
import { resolveIceServers } from "./iceServers";
import { Peer, type CreatePeerConnection, type PeerFailureReason, type PeerState } from "./peer";
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
  | { readonly state: Exclude<PeerState, "failed">; readonly message?: undefined; readonly hint?: undefined }
  | {
      readonly state: "failed";
      readonly message: string;
      /** What the player can actually do. May be empty. */
      readonly hint: string;
      /** Which failure this was - see peer.ts. Useful for logs and tests. */
      readonly reason: PeerFailureReason;
    }
  | { readonly state: "room_full"; readonly message: string; readonly hint?: undefined };

type Unsubscribe = () => void;

const ROOM_FULL_MESSAGE = "This room is full";

export class GuestNet implements Transport {
  private readonly options: GuestNetOptions;
  private readonly signaling: GuestSignaling;

  private peer: Peer | null = null;
  private hostId: PlayerId | null = null;
  private status: ConnectionStatus = { state: "new" };
  private closed = false;

  private readonly messageHandlers = new Set<
    (from: PlayerId, channel: Channel, msg: unknown) => void
  >();
  private readonly joinHandlers = new Set<(id: PlayerId) => void>();
  private readonly leaveHandlers = new Set<(id: PlayerId) => void>();
  private readonly statusHandlers = new Set<(status: ConnectionStatus) => void>();
  private readonly presenceHandlers = new Set<(online: boolean) => void>();

  private joinedFired = false;

  constructor(options: GuestNetOptions) {
    this.options = options;
    this.signaling = new GuestSignaling(options.client, options.roomCode, options.selfId);

    this.signaling.listen({
      onAnswer: (from, sdp) => {
        if (!this.peer) return; // no offer outstanding - not ours to apply
        this.hostId = from;
        void this.peer.acceptAnswer(sdp).then(() => {
          // The control channel may already have opened by the time the
          // answer's promise resolves; re-check so onPeerJoin still fires.
          if (this.peer?.getState() === "connected" && !this.joinedFired) {
            this.joinedFired = true;
            for (const h of this.joinHandlers) h(from);
          }
        });
      },
      onIceCandidateFromHost: (_from, candidate) => {
        // Peer holds candidates until its remote description is applied, so
        // one arriving right behind the answer is kept rather than rejected.
        void this.peer?.addIceCandidate(candidate);
      },
      onRoomFull: () => {
        this.setStatus({ state: "room_full", message: ROOM_FULL_MESSAGE });
        this.peer?.close();
      },
      onHostPresenceChange: (online) => {
        for (const h of this.presenceHandlers) h(online);
      },
    });
  }

  /**
   * Kicks off the offer -> signaling -> answer handshake. Call once, after
   * construction. Resolving ICE servers first is what gets a TURN relay into
   * the connection; without one, a Host behind a symmetric NAT is unreachable.
   */
  connect(): void {
    if (this.peer || this.closed) return;
    // Report "connecting" now rather than after the credentials fetch, so the
    // UI moves off the presence screen immediately.
    this.setStatus({ state: "connecting" });
    void (async () => {
      const iceServers = await resolveIceServers();
      if (this.closed || this.peer) return;
      const peer = this.createPeer(iceServers);
      const offer = await peer.createOffer();
      if (this.closed) return;
      this.signaling.sendOffer(offer);
    })();
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
    this.peer?.send(channel, msg);
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
    this.peer?.close();
    this.signaling.close();
  }

  private createPeer(iceServers: readonly RTCIceServer[]): Peer {
    const peer = new Peer({
      role: "offerer",
      iceServers,
      createPeerConnection: this.options.createPeerConnection,
      logLabel: `guest:${this.options.selfId}`,
    });
    this.peer = peer;

    peer.onIceCandidate((candidate) => this.signaling.sendIceCandidate(candidate));
    peer.onMessage((channel, msg) => {
      const from = this.hostId;
      if (from === null) return; // shouldn't happen: messages only flow once connected
      for (const h of this.messageHandlers) h(from, channel, msg);
    });
    peer.onStateChange((state) => {
      // room_full is a verdict from the Host, and onRoomFull closes the peer
      // right after setting it. Without this guard the resulting "closed"
      // overwrites it and the player gets the generic "host disconnected"
      // screen instead of being told the table is full.
      if (this.status.state !== "room_full") {
        if (state === "failed") {
          const failure = peer.getFailure();
          this.setStatus({
            state: "failed",
            message: failure?.message ?? "Couldn't connect",
            hint: failure?.hint ?? "",
            reason: failure?.reason ?? "timeout",
          });
        } else {
          this.setStatus({ state });
        }
      }

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

    return peer;
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    for (const h of this.statusHandlers) h(status);
  }
}
