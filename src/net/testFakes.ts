/**
 * Test doubles for WebRTC and Supabase Realtime, shared by peer.test.ts and
 * negotiation.test.ts. Imported only from tests, so it never reaches the
 * bundle.
 *
 * READ THIS BEFORE RELAXING ANYTHING HERE. The previous fake accepted ICE
 * candidates unconditionally and treated `setRemoteDescription` as a
 * no-op returning an already-resolved promise. Both real browser behaviours it
 * papered over were exactly where the bug lived:
 *
 *   - `addIceCandidate()` REJECTS with InvalidStateError while
 *     `remoteDescription` is null, and trickled candidates routinely arrive
 *     before the SDP they belong to;
 *   - `setRemoteDescription()` takes several ticks, so "before the remote
 *     description is applied" is a real, reachable window, not a theoretical one.
 *
 * With those two modelled, the suite could see the defect. Without them it
 * could not, and 273 green tests said the networking was fine while no Guest
 * could join across a NAT. Keep the fakes faithful to the state machine, not
 * just to the type signature.
 *
 * See docs/rca/0001-guests-cannot-connect-across-networks.md.
 */

import type { DataChannelLike, PeerConnectionLike } from "./peer";
import type { BroadcastPayload, RealtimeChannelLike, SupabaseClientLike } from "./signaling";

export class FakeDataChannel implements DataChannelLike {
  readyState: RTCDataChannelState = "connecting";
  onopen: ((this: DataChannelLike, ev: Event) => void) | null = null;
  onclose: ((this: DataChannelLike, ev: Event) => void) | null = null;
  onerror: ((this: DataChannelLike, ev: Event) => void) | null = null;
  onmessage: ((this: DataChannelLike, ev: MessageEvent) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly label: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = "closed";
    this.onclose?.call(this, new Event("close"));
  }

  simulateOpen(): void {
    this.readyState = "open";
    this.onopen?.call(this, new Event("open"));
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.call(this, { data: JSON.stringify(data) } as MessageEvent);
  }

  simulateError(): void {
    this.onerror?.call(this, new Event("error"));
  }
}

/**
 * An `RTCPeerConnection` stand-in that enforces the parts of the real state
 * machine this codebase depends on.
 */
export class FakePeerConnection implements PeerConnectionLike {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";

  onconnectionstatechange: ((this: PeerConnectionLike, ev: Event) => void) | null = null;
  oniceconnectionstatechange: ((this: PeerConnectionLike, ev: Event) => void) | null = null;
  onicegatheringstatechange: ((this: PeerConnectionLike, ev: Event) => void) | null = null;
  onicecandidateerror: ((this: PeerConnectionLike, ev: Event) => void) | null = null;
  onicecandidate:
    | ((this: PeerConnectionLike, ev: { candidate: RTCIceCandidateInit | null }) => void)
    | null = null;
  ondatachannel:
    | ((this: PeerConnectionLike, ev: { channel: DataChannelLike }) => void)
    | null = null;

  readonly createdChannels: FakeDataChannel[] = [];
  /** Candidates the connection ACCEPTED, in order. */
  readonly addedIceCandidates: RTCIceCandidateInit[] = [];
  /** Candidates rejected because no remote description was set. Should stay empty. */
  readonly rejectedIceCandidates: RTCIceCandidateInit[] = [];

  remoteDescription: RTCSessionDescriptionInit | null = null;
  localDescription: RTCSessionDescriptionInit | null = null;
  closed = false;

  constructor(readonly label = "fake") {}

  createDataChannel(label: string, _options?: RTCDataChannelInit): DataChannelLike {
    const dc = new FakeDataChannel(label);
    this.createdChannels.push(dc);
    return dc;
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { type: "offer", sdp: "fake-offer-sdp" };
  }

  async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "fake-answer-sdp" };
  }

  // Real setLocal/setRemoteDescription resolve after several microtasks. The
  // await here is what makes "a candidate arrived mid-negotiation" reachable.
  async setLocalDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await Promise.resolve();
    this.localDescription = desc;
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    await Promise.resolve();
    this.remoteDescription = desc;
  }

  /** Rejects before a remote description exists, exactly like Chrome and Firefox. */
  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (this.remoteDescription === null) {
      this.rejectedIceCandidates.push(candidate);
      throw new DOMException(
        "Failed to execute 'addIceCandidate': The remote description was null",
        "InvalidStateError",
      );
    }
    this.addedIceCandidates.push(candidate);
  }

  close(): void {
    this.closed = true;
  }

  // ── Test helpers ────────────────────────────────────────────────────────

  simulateConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.call(this, new Event("connectionstatechange"));
  }

  simulateIceConnectionState(state: RTCIceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.call(this, new Event("iceconnectionstatechange"));
  }

  simulateGatheringState(state: RTCIceGatheringState): void {
    this.iceGatheringState = state;
    this.onicegatheringstatechange?.call(this, new Event("icegatheringstatechange"));
  }

  /** Emit a local candidate. `type` becomes the SDP's `typ` token. */
  simulateLocalCandidate(type: "host" | "srflx" | "relay", id = "1"): void {
    this.onicecandidate?.call(this, {
      candidate: {
        candidate: `candidate:${id} 1 UDP 2130706431 192.0.2.${id} 5000${id} typ ${type}`,
        sdpMid: "0",
      },
    });
  }

  simulateIncomingChannel(dc: DataChannelLike): void {
    this.ondatachannel?.call(this, { channel: dc });
  }

  /** Open the control channel however this side got it (created or received). */
  openControlChannel(): void {
    const existing = this.createdChannels.find((c) => c.label === "control");
    if (existing) {
      existing.simulateOpen();
      return;
    }
    const remote = new FakeDataChannel("control");
    this.simulateIncomingChannel(remote);
    remote.simulateOpen();
  }
}

// ── Supabase Realtime ──────────────────────────────────────────────────────

/**
 * A broadcast bus shared by the channels on one topic. Delivery is a
 * microtask, not synchronous, because the real thing is a websocket and the
 * ordering hazards this suite exists to catch only appear when it is async.
 */
export class FakeRealtimeBus {
  readonly channels: FakeRealtimeChannel[] = [];
  /** Every message that crossed the bus, for assertions. */
  readonly traffic: Array<{ event: string; payload: unknown }> = [];

  publish(from: FakeRealtimeChannel, event: string, payload: unknown): void {
    this.traffic.push({ event, payload });
    void Promise.resolve().then(() => {
      for (const ch of this.channels) {
        if (ch === from) continue; // Realtime default: no echo to the sender
        ch.deliver(event, payload);
      }
    });
  }

  sentEvents(event: string): unknown[] {
    return this.traffic.filter((m) => m.event === event).map((m) => m.payload);
  }
}

export class FakeRealtimeChannel implements RealtimeChannelLike {
  private readonly broadcastHandlers = new Map<
    string,
    Array<(payload: BroadcastPayload<unknown>) => void>
  >();
  private readonly presenceHandlers: Array<() => void> = [];
  private presence: Record<string, readonly unknown[]> = {};

  constructor(private readonly bus: FakeRealtimeBus) {
    bus.channels.push(this);
  }

  on(type: "broadcast", filter: { event: string }, cb: (p: BroadcastPayload<unknown>) => void): RealtimeChannelLike;
  on(type: "presence", filter: { event: "sync" | "join" | "leave" }, cb: () => void): RealtimeChannelLike;
  on(type: string, filter: { event: string }, cb: (...args: never[]) => void): RealtimeChannelLike {
    if (type === "broadcast") {
      const list = this.broadcastHandlers.get(filter.event) ?? [];
      list.push(cb as (p: BroadcastPayload<unknown>) => void);
      this.broadcastHandlers.set(filter.event, list);
    } else if (type === "presence" && filter.event === "sync") {
      this.presenceHandlers.push(cb as () => void);
    }
    return this;
  }

  async send(message: { type: "broadcast"; event: string; payload: unknown }): Promise<string> {
    this.bus.publish(this, message.event, message.payload);
    return "ok";
  }

  subscribe(callback?: (status: string) => void): RealtimeChannelLike {
    callback?.("SUBSCRIBED");
    return this;
  }

  async track(payload: unknown): Promise<string> {
    for (const ch of this.bus.channels) {
      if (ch === this) continue;
      ch.presence = { ...ch.presence, host: [payload] };
      for (const h of ch.presenceHandlers) h();
    }
    return "ok";
  }

  async untrack(): Promise<string> {
    return "ok";
  }

  presenceState(): Record<string, readonly unknown[]> {
    return this.presence;
  }

  deliver(event: string, payload: unknown): void {
    for (const h of this.broadcastHandlers.get(event) ?? []) h({ payload });
  }
}

export function fakeSupabaseClient(bus: FakeRealtimeBus): SupabaseClientLike {
  return {
    channel: () => new FakeRealtimeChannel(bus),
    removeChannel: () => {},
  };
}

/** Let queued microtasks run. WebRTC negotiation here is several deep. */
export async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}
