import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANSWER_TIMEOUT_MS, CONNECT_TIMEOUT_MS } from "../config";
import { Peer, describeFailure } from "./peer";
import { FakeDataChannel, FakePeerConnection } from "./testFakes";

// The fakes live in testFakes.ts and are SPEC-FAITHFUL about
// addIceCandidate/setRemoteDescription. That matters: the versions that used
// to live here accepted candidates in any order, which is why this suite was
// green throughout an outage where no Guest could join across a NAT. See
// docs/rca/0001-guests-cannot-connect-across-networks.md.

const TURN: readonly RTCIceServer[] = [
  { urls: ["turn:relay.example:3478"], username: "u", credential: "c" },
];

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

    pc.simulateLocalCandidate("srflx");
    pc.simulateConnectionState("failed");

    expect(peer.getState()).toBe("failed");
    expect(peer.getFailure()?.reason).toBe("ice-failed");
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

    // Applying a remote description clears the (shorter) answer timer, so this
    // exercises the overall connect budget rather than "the host never answered".
    await peer.acceptAnswer({ type: "answer", sdp: "x" });
    pc.simulateLocalCandidate("srflx");
    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);

    expect(peer.getState()).toBe("failed");
    expect(peer.getFailure()?.reason).toBe("timeout");
    expect(states.at(-1)).toEqual(["failed", peer.getFailureMessage()]);
  });

  it("does NOT time out if the control channel opens before CONNECT_TIMEOUT_MS", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });

    await peer.createOffer();
    const control = pc.createdChannels.find((c) => c.label === "control")!;
    await peer.acceptAnswer({ type: "answer", sdp: "x" });
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
      answerTimeoutMs: 500,
    });

    await peer.createOffer();
    await peer.acceptAnswer({ type: "answer", sdp: "x" });
    vi.advanceTimersByTime(499);
    expect(peer.getState()).toBe("connecting");
    vi.advanceTimersByTime(1);
    expect(peer.getState()).toBe("failed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression coverage for docs/rca/0001-guests-cannot-connect-across-networks.md
// ─────────────────────────────────────────────────────────────────────────────

describe("Peer buffers remote ICE candidates until the remote description lands", () => {
  it("offerer: candidates arriving before the answer are held, then applied in order", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();

    // The Host trickles the moment it applies its own local description, which
    // is BEFORE it broadcasts the answer. These used to be thrown away.
    await peer.addIceCandidate({ candidate: "typ host", sdpMid: "0" });
    await peer.addIceCandidate({ candidate: "typ srflx", sdpMid: "0" });

    expect(pc.addedIceCandidates).toHaveLength(0);
    expect(pc.rejectedIceCandidates).toHaveLength(0); // held, not offered and refused
    expect(peer.getPendingCandidateCount()).toBe(2);

    await peer.acceptAnswer({ type: "answer", sdp: "a" });

    expect(pc.rejectedIceCandidates).toHaveLength(0);
    expect(pc.addedIceCandidates.map((c) => c.candidate)).toEqual(["typ host", "typ srflx"]);
    expect(peer.getPendingCandidateCount()).toBe(0);
  });

  it("answerer: candidates racing the offer are held until createAnswer applies it", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "answerer", createPeerConnection: () => pc });

    await peer.addIceCandidate({ candidate: "typ srflx", sdpMid: "0" });
    expect(pc.addedIceCandidates).toHaveLength(0);

    await peer.createAnswer({ type: "offer", sdp: "o" });

    expect(pc.rejectedIceCandidates).toHaveLength(0);
    expect(pc.addedIceCandidates.map((c) => c.candidate)).toEqual(["typ srflx"]);
  });

  it("candidates arriving after the remote description go straight through", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    await peer.acceptAnswer({ type: "answer", sdp: "a" });

    await peer.addIceCandidate({ candidate: "typ relay", sdpMid: "0" });

    expect(pc.addedIceCandidates.map((c) => c.candidate)).toEqual(["typ relay"]);
    expect(peer.getPendingCandidateCount()).toBe(0);
  });

  it("one candidate the browser refuses does not abort the rest, and never rejects", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    await peer.acceptAnswer({ type: "answer", sdp: "a" });

    const original = pc.addIceCandidate.bind(pc);
    let calls = 0;
    pc.addIceCandidate = async (c: RTCIceCandidateInit) => {
      calls += 1;
      if (calls === 1) throw new Error("malformed candidate");
      await original(c);
    };

    await expect(peer.addIceCandidate({ candidate: "bad" })).resolves.toBeUndefined();
    await peer.addIceCandidate({ candidate: "typ srflx" });

    expect(pc.addedIceCandidates.map((c) => c.candidate)).toEqual(["typ srflx"]);
  });

  it("drops candidates once terminal, rather than growing the buffer forever", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    peer.close();

    await peer.addIceCandidate({ candidate: "typ host" });

    expect(peer.getPendingCandidateCount()).toBe(0);
  });
});

describe("Peer diagnoses WHY it failed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("no answer within ANSWER_TIMEOUT_MS is reported as the host not answering", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    pc.simulateLocalCandidate("srflx");

    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS);

    expect(peer.getFailure()?.reason).toBe("no-answer");
    // The old copy blamed the player's network for this. It must not.
    expect(peer.getFailure()?.hint).not.toMatch(/different network/i);
  });

  it("the answer timer fires well before the overall connect budget", () => {
    expect(ANSWER_TIMEOUT_MS).toBeLessThan(CONNECT_TIMEOUT_MS);
  });

  it("an answer that arrives in time cancels the no-answer verdict", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();

    await peer.acceptAnswer({ type: "answer", sdp: "a" });
    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS + 1);

    expect(peer.getState()).toBe("connecting");
  });

  it("the answerer never waits on an answer - it was handed the offer", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "answerer", createPeerConnection: () => pc });
    const answering = peer.createAnswer({ type: "offer", sdp: "o" });
    await vi.advanceTimersByTimeAsync(0);
    await answering;

    vi.advanceTimersByTime(ANSWER_TIMEOUT_MS + 1);

    expect(peer.getState()).toBe("connecting");
  });

  it("ICE failing after candidates were gathered is 'ice-failed'", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    pc.simulateLocalCandidate("host");
    pc.simulateLocalCandidate("srflx");

    pc.simulateIceConnectionState("failed");

    expect(peer.getFailure()?.reason).toBe("ice-failed");
    expect(peer.getGatheredCandidateTypes()).toEqual(["host", "srflx"]);
  });

  it("ICE failing with NO candidates gathered is 'no-candidates', a different problem", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();

    pc.simulateIceConnectionState("failed");

    expect(peer.getFailure()?.reason).toBe("no-candidates");
  });

  it("without TURN, an ICE failure says so instead of telling the player to switch networks", () => {
    const withoutRelay = describeFailure("ice-failed", false);
    const withRelay = describeFailure("ice-failed", true);

    expect(withoutRelay.hint).toMatch(/no relay server is configured/i);
    expect(withoutRelay.hint).not.toEqual(withRelay.hint);
  });

  it("every failure reason produces non-empty copy", async () => {
    for (const reason of ["no-answer", "no-candidates", "ice-failed", "channel-error", "timeout"] as const) {
      const failure = describeFailure(reason, false);
      expect(failure.message.length).toBeGreaterThan(0);
      expect(failure.hint.length).toBeGreaterThan(0);
      expect(failure.reason).toBe(reason);
    }
  });

  it("a control-channel error is reported as a dropped connection, not a network problem", async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer({ role: "offerer", createPeerConnection: () => pc });
    await peer.createOffer();
    const control = pc.createdChannels.find((c) => c.label === "control")!;

    control.simulateError();

    expect(peer.getFailure()?.reason).toBe("channel-error");
  });
});

describe("Peer ICE server configuration", () => {
  it("reports whether a relay is available", () => {
    const stunOnly = new Peer({
      role: "offerer",
      createPeerConnection: () => new FakePeerConnection(),
    });
    const withTurn = new Peer({
      role: "offerer",
      iceServers: TURN,
      createPeerConnection: () => new FakePeerConnection(),
    });

    expect(stunOnly.hasRelay()).toBe(false);
    expect(withTurn.hasRelay()).toBe(true);
  });

  it("recognises a turns: URL as a relay too", () => {
    const peer = new Peer({
      role: "offerer",
      iceServers: [{ urls: "turns:relay.example:5349?transport=tcp", username: "u", credential: "c" }],
      createPeerConnection: () => new FakePeerConnection(),
    });
    expect(peer.hasRelay()).toBe(true);
  });
});

describe("shared FakePeerConnection stays faithful to the browser", () => {
  // Guards the guard. If these ever pass trivially, the fakes have drifted
  // back to the shape that hid the original bug.
  it("rejects addIceCandidate before setRemoteDescription", async () => {
    const pc = new FakePeerConnection();
    await expect(pc.addIceCandidate({ candidate: "typ host" })).rejects.toThrow(/remote description/i);
    expect(pc.rejectedIceCandidates).toHaveLength(1);
  });

  it("accepts it afterwards", async () => {
    const pc = new FakePeerConnection();
    await pc.setRemoteDescription({ type: "offer", sdp: "o" });
    await expect(pc.addIceCandidate({ candidate: "typ host" })).resolves.toBeUndefined();
  });

  it("setRemoteDescription does not resolve synchronously", async () => {
    const pc = new FakePeerConnection();
    const promise = pc.setRemoteDescription({ type: "offer", sdp: "o" });
    expect(pc.remoteDescription).toBeNull(); // still a reachable window
    await promise;
    expect(pc.remoteDescription).not.toBeNull();
  });
});
