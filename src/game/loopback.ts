/**
 * An in-process Transport (see ../types.ts) connecting one Host and one or
 * more Guests in the SAME process. This is what makes M1 single-player work
 * end-to-end, and what makes M3's WebRTC swap a transport substitution
 * rather than a game-logic rewrite.
 *
 * Modelled as a genuine STAR, matching the real topology (net/'s
 * guestNet.ts is a single RTCPeerConnection to the Host — a Guest can never
 * reach another Guest directly):
 *   - the Host's transport can address a specific Guest or BROADCAST to all;
 *   - a Guest's transport only ever has one peer, the Host, and everything
 *     it sends — BROADCAST or not — goes there.
 * Guest-to-Guest fan-out would hide topology bugs that only show up once a
 * real star (or WebRTC) is wired in, so it is deliberately not supported.
 *
 * Delivery is always deferred via setTimeout(0) — never synchronous — so
 * ordering bugs that a same-tick call stack would paper over still show up
 * in tests.
 */

import { BROADCAST, type Channel, type PlayerId, type Recipient, type Transport } from "../types";

type MessageHandler = (from: PlayerId, channel: Channel, msg: unknown) => void;
type PeerHandler = (id: PlayerId) => void;

function defer(fn: () => void): void {
  setTimeout(fn, 0);
}

abstract class BaseLoopbackTransport implements Transport {
  readonly playerId: PlayerId;
  private closed = false;
  private readonly messageHandlers = new Set<MessageHandler>();
  private readonly joinHandlers = new Set<PeerHandler>();
  private readonly leaveHandlers = new Set<PeerHandler>();

  constructor(playerId: PlayerId) {
    this.playerId = playerId;
  }

  abstract send(channel: Channel, to: Recipient, msg: unknown): void;

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onPeerJoin(handler: PeerHandler): () => void {
    this.joinHandlers.add(handler);
    return () => this.joinHandlers.delete(handler);
  }

  onPeerLeave(handler: PeerHandler): () => void {
    this.leaveHandlers.add(handler);
    return () => this.leaveHandlers.delete(handler);
  }

  abstract close(): void;

  protected isClosed(): boolean {
    return this.closed;
  }

  protected markClosed(): void {
    this.closed = true;
  }

  /** @internal called by LoopbackHub */
  emitMessage(from: PlayerId, channel: Channel, msg: unknown): void {
    if (this.closed) return;
    for (const handler of this.messageHandlers) handler(from, channel, msg);
  }

  /** @internal called by LoopbackHub */
  emitPeerJoin(id: PlayerId): void {
    if (this.closed) return;
    for (const handler of this.joinHandlers) handler(id);
  }

  /** @internal called by LoopbackHub */
  emitPeerLeave(id: PlayerId): void {
    if (this.closed) return;
    for (const handler of this.leaveHandlers) handler(id);
  }
}

class HostLoopbackTransport extends BaseLoopbackTransport {
  constructor(playerId: PlayerId, private readonly hub: LoopbackHub) {
    super(playerId);
  }

  send(channel: Channel, to: Recipient, msg: unknown): void {
    if (this.isClosed()) return;
    this.hub.routeFromHost(channel, to, msg, this.playerId);
  }

  close(): void {
    if (this.isClosed()) return;
    this.markClosed();
    this.hub.disconnectHost();
  }
}

class GuestLoopbackTransport extends BaseLoopbackTransport {
  constructor(playerId: PlayerId, private readonly hub: LoopbackHub) {
    super(playerId);
  }

  send(channel: Channel, _to: Recipient, msg: unknown): void {
    // A Guest's only peer is the Host, regardless of the `to` argument —
    // there is no one else it could reach in a star topology.
    if (this.isClosed()) return;
    this.hub.routeFromGuest(channel, msg, this.playerId);
  }

  close(): void {
    if (this.isClosed()) return;
    this.markClosed();
    this.hub.disconnectGuest(this.playerId);
  }
}

let anonymousGuestCounter = 0;

export class LoopbackHub {
  private host: HostLoopbackTransport | undefined;
  private readonly guests = new Map<PlayerId, GuestLoopbackTransport>();

  connectHost(hostId: PlayerId): Transport {
    if (this.host) {
      throw new Error("LoopbackHub already has a Host connected");
    }
    const transport = new HostLoopbackTransport(hostId, this);
    this.host = transport;
    return transport;
  }

  connectGuest(guestId?: PlayerId): Transport {
    if (!this.host) {
      throw new Error("LoopbackHub has no Host yet — connect one first");
    }
    const id = guestId ?? `guest-${++anonymousGuestCounter}`;
    if (this.guests.has(id)) {
      throw new Error(`LoopbackHub already has a Guest with id "${id}"`);
    }
    const transport = new GuestLoopbackTransport(id, this);
    this.guests.set(id, transport);

    const hostId = this.host.playerId;
    defer(() => {
      this.host?.emitPeerJoin(id);
      transport.emitPeerJoin(hostId);
    });

    return transport;
  }

  /** @internal */
  disconnectGuest(id: PlayerId): void {
    if (!this.guests.delete(id)) return;
    defer(() => this.host?.emitPeerLeave(id));
  }

  /** @internal */
  disconnectHost(): void {
    const wasHost = this.host;
    if (!wasHost) return;
    this.host = undefined;
    defer(() => {
      for (const guest of this.guests.values()) guest.emitPeerLeave(wasHost.playerId);
    });
  }

  /** @internal */
  routeFromHost(channel: Channel, to: Recipient, msg: unknown, from: PlayerId): void {
    defer(() => {
      if (to === BROADCAST) {
        for (const guest of this.guests.values()) guest.emitMessage(from, channel, msg);
      } else {
        this.guests.get(to)?.emitMessage(from, channel, msg);
      }
    });
  }

  /** @internal */
  routeFromGuest(channel: Channel, msg: unknown, from: PlayerId): void {
    defer(() => this.host?.emitMessage(from, channel, msg));
  }
}

/** Convenience: a fresh hub with one Host and one Guest already connected. */
export function createLoopbackPair(opts?: {
  readonly hostId?: PlayerId;
  readonly guestId?: PlayerId;
}): { readonly hub: LoopbackHub; readonly hostTransport: Transport; readonly guestTransport: Transport } {
  const hub = new LoopbackHub();
  const hostTransport = hub.connectHost(opts?.hostId ?? "host");
  const guestTransport = hub.connectGuest(opts?.guestId);
  return { hub, hostTransport, guestTransport };
}
