import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONNECT_TIMEOUT_MS } from "../config";
import {
  Peer,
  USER_FACING_TIMEOUT_MESSAGE,
  type DataChannelLike,
  type PeerConnectionLike,
} from "./peer";

// ── Fakes ────────────────────────────────────────────────────────────────

class FakeDataChannel implements DataChannelLike {
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

class FakePeerConnection implements PeerConnectionLike {
  connectionState: RTCPeerConnectionState = "new";
  onconnectionstatechange: ((this: PeerConnectionLike, ev: Event) => void) | null = null;
  onicecandidate:
    | ((this: PeerConnectionLike, ev: { candidate: RTCIceCandidateInit | null }) => void)
    | null = null;
  ondatachannel:
    | ((this: PeerConnectionLike, ev: { channel: DataChannelLike }) => void)
    | null = null;

  readonly createdChannels: FakeDataChannel[] = [];
  readonly addedIceCandidates: RTCIceCandidateInit[] = [];
  closed = false;

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

  async setLocalDescription(_desc: RTCSessionDescriptionInit): Promise<void> {}

  async setRemoteDescription(_desc: RTCSessionDescriptionInit): Promise<void> {}

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    this.addedIceCandidates.push(candidate);
  }

  close(): void {
    this.closed = true;
  }

  /** Test helper: simulate the browser reaching a new pc.connectionState. */
  simulateConnectionState(state: RTCPeerConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.call(this, new Event("connectionstatechange"));
  }

  /** Test helper: simulate the remote side opening a data channel (answerer side). */
  simulateIncomingChannel(dc: DataChannelLike): void {
    this.ondatachannel?.call(this, { channel: dc });
  }
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Peer state machine", () => {
  it("starts in 'new'", () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    expect(peer.getState()).toBe("new");
  });

  it("offerer: createOffer() creates control+stream channels and moves to 'connecting'", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });

    const offer = await peer.createOffer();

    expect(offer.sdp).toBe("fake-offer-sdp");
    expect(peer.getState()).toBe("connecting");
    expect(pc.createdChannels.map((c) => c.label).sort()).toEqual(["control", "stream"]);
  });

  it("offerer -> 'connected' when the control channel opens", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    const states: string[] = [];
    peer.onStateChange((s) => states.push(s));

    await peer.createOffer();
    const control = pc.createdChannels.find((c) => c.label === "control")!;
    control.simulateOpen();

    expect(peer.getState()).toBe("connected");
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("stream channel opening alone does NOT move to 'connected'", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    const stream = pc.createdChannels.find((c) => c.label === "stream")!;
    stream.simulateOpen();

    expect(peer.getState()).toBe("connecting");
  });

  it("answerer: createAnswer() answers an offer and moves to 'connecting', without creating channels itself", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "answerer", createPeerConnection: () => pc });

    const answer = await peer.createAnswer({ type: "offer", sdp: "guest-offer-sdp" });

    expect(answer.sdp).toBe("fake-answer-sdp");
    expect(peer.getState()).toBe("connecting");
    expect(pc.createdChannels).toHaveLength(0);
  });

  it("answerer -> 'connected' when the Guest's control channel arrives via ondatachannel and opens", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "answerer", createPeerConnection: () => pc });
    await peer.createAnswer({ type: "offer", sdp: "x" });

    const remoteControl = new FakeDataChannel("control");
    pc.simulateIncomingChannel(remoteControl);
    expect(peer.getState()).toBe("connecting");

    remoteControl.simulateOpen();
    expect(peer.getState()).toBe("connected");
  });

  it("respects roles: offerer cannot createAnswer, answerer cannot createOffer/acceptAnswer", async () => {
    const offerer = new Peer({ role: "offerer", createPeerConnection: () => new FakePeerConnection() });
    const answerer = new Peer({ role: "answerer", createPeerConnection: () => new FakePeerConnection() });

    await expect(offerer.createAnswer({ type: "offer", sdp: "x" })).rejects.toThrow();
    await expect(answerer.createOffer()).rejects.toThrow();
    await expect(answerer.acceptAnswer({ type: "answer", sdp: "x" })).rejects.toThrow();
  });

  it("pc.connectionState 'failed' moves the peer to 'failed' with a user-facing message", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();

    pc.simulateConnectionState("failed");

    expect(peer.getState()).toBe("failed");
    expect(peer.getFailureMessage()).toBe(USER_FACING_TIMEOUT_MESSAGE);
  });

  it("close() transitions to 'closed' and closes the underlying connection and channels", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    const control = pc.createdChannels.find((c) => c.label === "control")!;
    control.simulateOpen();
    expect(peer.getState()).toBe("connected");

    peer.close();

    expect(peer.getState()).toBe("closed");
    expect(pc.closed).toBe(true);
    expect(control.readyState).toBe("closed");
  });

  it("terminal states do not reopen: further transitions after 'closed' are ignored", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    peer.close();
    expect(peer.getState()).toBe("closed");

    pc.simulateConnectionState("failed");
    expect(peer.getState()).toBe("closed");
  });

  it("send() delivers JSON over the right channel, and no-ops when the channel is not open", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    const control = pc.createdChannels.find((c) => c.label === "control")!;
    control.simulateOpen();

    peer.send("control", { type: "JOIN", playerId: "p1", name: "x", color: "y" });
    expect(control.sent).toEqual([
      JSON.stringify({ type: "JOIN", playerId: "p1", name: "x", color: "y" }),
    ]);

    const stream = pc.createdChannels.find((c) => c.label === "stream")!;
    expect(stream.readyState).toBe("connecting");
    peer.send("stream", { type: "CURSOR", seq: 1, playerId: "p1", point: { x: 0, y: 0 } });
    expect(stream.sent).toEqual([]); // dropped: not open
  });

  it("onMessage delivers parsed data tagged with the right channel", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    const control = pc.createdChannels.find((c) => c.label === "control")!;

    const received: Array<[string, unknown]> = [];
    peer.onMessage((channel, data) => received.push([channel, data]));

    control.simulateMessage({ type: "WELCOME", you: "p1" });

    expect(received).toEqual([["control", { type: "WELCOME", you: "p1" }]]);
  });

  it("onIceCandidate forwards non-null candidates from the underlying connection", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    const candidates: RTCIceCandidateInit[] = [];
    peer.onIceCandidate((c) => candidates.push(c));

    pc.onicecandidate?.call(pc, { candidate: { candidate: "fake", sdpMid: "0" } });
    pc.onicecandidate?.call(pc, { candidate: null }); // end-of-candidates: not forwarded

    expect(candidates).toEqual([{ candidate: "fake", sdpMid: "0" }]);
  });
});

describe("Peer connect timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transitions to 'failed' with a clear message if CONNECT_TIMEOUT_MS elapses while connecting", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    const states: Array<[string, string | undefined]> = [];
    peer.onStateChange((s, m) => states.push([s, m]));

    await peer.createOffer();
    expect(peer.getState()).toBe("connecting");

    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);

    expect(peer.getState()).toBe("failed");
    expect(peer.getFailureMessage()).toBe(USER_FACING_TIMEOUT_MESSAGE);
    expect(states.at(-1)).toEqual(["failed", USER_FACING_TIMEOUT_MESSAGE]);
  });

  it("does NOT time out if the control channel opens before CONNECT_TIMEOUT_MS", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });

    await peer.createOffer();
    const control = pc.createdChannels.find((c) => c.label === "control")!;
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS - 1);
    control.simulateOpen();
    vi.advanceTimersByTime(10_000);

    expect(peer.getState()).toBe("connected");
  });

  it("a custom connectTimeoutMs overrides the config default", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({
      role: "offerer",
      createPeerConnection: () => pc,
      connectTimeoutMs: 500,
    });

    await peer.createOffer();
    vi.advanceTimersByTime(499);
    expect(peer.getState()).toBe("connecting");
    vi.advanceTimersByTime(1);
    expect(peer.getState()).toBe("failed");
  });
});
