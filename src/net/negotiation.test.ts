/**
 * End-to-end negotiation between a real `HostNet` and a real `GuestNet`, wired
 * through a fake Supabase Realtime bus and spec-faithful `RTCPeerConnection`s.
 *
 * peer.test.ts covers one `Peer` in isolation. This file covers the part that
 * actually broke: the ORDERING between two of them and the signaling channel
 * carrying SDP and trickled ICE in the same stream. Every case here failed
 * before the fix and reproduces the outage in
 * docs/rca/0001-guests-cannot-connect-across-networks.md.
 *
 * The load-bearing assertion throughout is
 * `expect(pc.rejectedIceCandidates).toHaveLength(0)`. A rejected candidate is
 * one the browser threw away, and across a NAT the thrown-away one is
 * routinely the only candidate that would have worked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PLAYERS } from "../config";
import { GuestNet, type ConnectionStatus } from "./guestNet";
import { HostNet } from "./hostNet";
import { resetIceServersForTest } from "./iceServers";
import {
  FakePeerConnection,
  FakeRealtimeBus,
  FakeRealtimeChannel,
  fakeSupabaseClient,
  flushMicrotasks,
} from "./testFakes";

interface Rig {
  readonly bus: FakeRealtimeBus;
  readonly host: HostNet;
  readonly guest: GuestNet;
  /** The Host's connection to this Guest. Undefined until the offer is handled. */
  hostPc(): FakePeerConnection | undefined;
  guestPc(): FakePeerConnection | undefined;
}

function makeRig(guestId = "guest-1"): Rig {
  const bus = new FakeRealtimeBus();
  let hostPc: FakePeerConnection | undefined;
  let guestPc: FakePeerConnection | undefined;

  const host = new HostNet({
    client: fakeSupabaseClient(bus),
    roomCode: "ROOMCODE01",
    selfId: "host-1",
    createPeerConnection: () => (hostPc = new FakePeerConnection("host")),
  });
  const guest = new GuestNet({
    client: fakeSupabaseClient(bus),
    roomCode: "ROOMCODE01",
    selfId: guestId,
    createPeerConnection: () => (guestPc = new FakePeerConnection("guest")),
  });

  return { bus, host, guest, hostPc: () => hostPc, guestPc: () => guestPc };
}

beforeEach(() => {
  resetIceServersForTest();
  // iceServers.ts warns loudly when no TURN is configured, which is correct
  // behaviour and pure noise here.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "debug").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  resetIceServersForTest();
});

describe("Guest <-> Host handshake", () => {
  it("completes: offer, answer, candidates both ways, control channel open", async () => {
    const rig = makeRig();
    const joined: string[] = [];
    rig.host.onPeerJoin((id) => joined.push(id));

    rig.guest.connect();
    await flushMicrotasks();

    expect(rig.bus.sentEvents("offer")).toHaveLength(1);
    expect(rig.bus.sentEvents("answer")).toHaveLength(1);
    expect(rig.guestPc()?.remoteDescription).not.toBeNull();
    expect(rig.hostPc()?.remoteDescription).not.toBeNull();

    // Both sides trickle; each candidate should reach the other intact.
    rig.guestPc()!.simulateLocalCandidate("srflx", "1");
    rig.hostPc()!.simulateLocalCandidate("srflx", "2");
    await flushMicrotasks();

    expect(rig.hostPc()!.rejectedIceCandidates).toHaveLength(0);
    expect(rig.guestPc()!.rejectedIceCandidates).toHaveLength(0);
    expect(rig.hostPc()!.addedIceCandidates).toHaveLength(1);
    expect(rig.guestPc()!.addedIceCandidates).toHaveLength(1);

    rig.guestPc()!.openControlChannel();
    rig.hostPc()!.openControlChannel();
    await flushMicrotasks();

    expect(rig.guest.getConnectionStatus().state).toBe("connected");
    expect(joined).toEqual(["guest-1"]);
  });

  it("HOST keeps Guest candidates that chase the offer down the same channel", async () => {
    // The exact outage shape: the Guest applies its own offer and starts
    // trickling immediately, so candidates land while the Host is still inside
    // its awaited createAnswer(). These used to be rejected and lost.
    const rig = makeRig();
    rig.guest.connect();
    await flushMicrotasks(4); // offer sent; Host mid-negotiation

    rig.guestPc()!.simulateLocalCandidate("host", "1");
    rig.guestPc()!.simulateLocalCandidate("srflx", "2");
    await flushMicrotasks();

    expect(rig.hostPc()!.rejectedIceCandidates).toHaveLength(0);
    expect(rig.hostPc()!.addedIceCandidates).toHaveLength(2);
  });

  it("GUEST keeps Host candidates that arrive while it is applying the answer", async () => {
    const rig = makeRig();
    rig.guest.connect();
    await flushMicrotasks(6);

    rig.hostPc()!.simulateLocalCandidate("srflx", "9");
    await flushMicrotasks();

    expect(rig.guestPc()!.rejectedIceCandidates).toHaveLength(0);
    expect(rig.guestPc()!.addedIceCandidates.map((c) => c.candidate)).toEqual([
      expect.stringContaining("typ srflx") as unknown as string,
    ]);
  });

  it("HOST keeps candidates that arrive BEFORE the offer does", async () => {
    // Signaling does not guarantee ordering across transports: supabase-js
    // falls back to an HTTP POST when the socket has not finished joining, so
    // an offer can genuinely land behind a candidate sent after it.
    const bus = new FakeRealtimeBus();
    let hostPc: FakePeerConnection | undefined;
    const host = new HostNet({
      client: fakeSupabaseClient(bus),
      roomCode: "ROOMCODE01",
      selfId: "host-1",
      createPeerConnection: () => (hostPc = new FakePeerConnection("host")),
    });
    const guestChannel = new FakeRealtimeChannel(bus);

    await guestChannel.send({
      type: "broadcast",
      event: "ice-from-guest",
      payload: { from: "guest-1", candidate: { candidate: "candidate:1 1 UDP 1 1.2.3.4 5000 typ srflx" } },
    });
    await flushMicrotasks();
    await guestChannel.send({
      type: "broadcast",
      event: "offer",
      payload: { from: "guest-1", sdp: { type: "offer", sdp: "o" } },
    });
    await flushMicrotasks();

    expect(hostPc).toBeDefined();
    expect(hostPc!.rejectedIceCandidates).toHaveLength(0);
    expect(hostPc!.addedIceCandidates).toHaveLength(1);
    host.close();
  });
});

describe("a Guest retrying gets answered", () => {
  it("a second offer from the same PlayerId is answered, not ignored", async () => {
    // PlayerId is persisted per device, so a retry carries the SAME id. The
    // Host used to treat that as a duplicate broadcast and return silently,
    // leaving "Try again" a no-op until its own timeout expired.
    const bus = new FakeRealtimeBus();
    const pcs: FakePeerConnection[] = [];
    const host = new HostNet({
      client: fakeSupabaseClient(bus),
      roomCode: "ROOMCODE01",
      selfId: "host-1",
      createPeerConnection: () => {
        const pc = new FakePeerConnection(`host-${pcs.length}`);
        pcs.push(pc);
        return pc;
      },
    });
    const guestChannel = new FakeRealtimeChannel(bus);
    const answers: unknown[] = [];
    guestChannel.on("broadcast", { event: "answer" }, ({ payload }) => answers.push(payload));

    await guestChannel.send({
      type: "broadcast",
      event: "offer",
      payload: { from: "guest-1", sdp: { type: "offer", sdp: "first" } },
    });
    await flushMicrotasks();
    expect(answers).toHaveLength(1);

    await guestChannel.send({
      type: "broadcast",
      event: "offer",
      payload: { from: "guest-1", sdp: { type: "offer", sdp: "retry" } },
    });
    await flushMicrotasks();

    expect(answers).toHaveLength(2);
    expect(pcs).toHaveLength(2);
    expect(pcs[0].closed).toBe(true); // the stale connection was torn down
    host.close();
  });

  it("a retry after a completed join re-announces the Guest exactly once", async () => {
    const bus = new FakeRealtimeBus();
    const pcs: FakePeerConnection[] = [];
    const host = new HostNet({
      client: fakeSupabaseClient(bus),
      roomCode: "ROOMCODE01",
      selfId: "host-1",
      createPeerConnection: () => {
        const pc = new FakePeerConnection(`host-${pcs.length}`);
        pcs.push(pc);
        return pc;
      },
    });
    const events: string[] = [];
    host.onPeerJoin((id) => events.push(`join:${id}`));
    host.onPeerLeave((id) => events.push(`leave:${id}`));

    const guestChannel = new FakeRealtimeChannel(bus);
    const offer = {
      type: "broadcast" as const,
      event: "offer",
      payload: { from: "guest-1", sdp: { type: "offer", sdp: "o" } },
    };

    await guestChannel.send(offer);
    await flushMicrotasks();
    pcs[0].openControlChannel();
    expect(events).toEqual(["join:guest-1"]);

    await guestChannel.send(offer);
    await flushMicrotasks();
    pcs[1].openControlChannel();

    expect(events).toEqual(["join:guest-1", "leave:guest-1", "join:guest-1"]);
    expect(host.connectedCount).toBe(1);
    host.close();
  });

  it("two offers in flight at once: the newer one is answered and the older is abandoned", async () => {
    // Negotiating is async, so a fast retry can overlap the attempt it
    // replaces. Answering the older offer would hand the Guest SDP it has
    // already discarded and burn its whole connect budget.
    const bus = new FakeRealtimeBus();
    const pcs: FakePeerConnection[] = [];
    const host = new HostNet({
      client: fakeSupabaseClient(bus),
      roomCode: "ROOMCODE01",
      selfId: "host-1",
      createPeerConnection: () => {
        const pc = new FakePeerConnection(`host-${pcs.length}`);
        pcs.push(pc);
        return pc;
      },
    });
    const guestChannel = new FakeRealtimeChannel(bus);
    const answers: Array<{ sdp: { sdp: string } }> = [];
    guestChannel.on("broadcast", { event: "answer" }, ({ payload }) => {
      answers.push(payload as { sdp: { sdp: string } });
    });

    // Both offers cross the bus before either negotiation gets to finish.
    void guestChannel.send({
      type: "broadcast",
      event: "offer",
      payload: { from: "guest-1", sdp: { type: "offer", sdp: "stale" } },
    });
    void guestChannel.send({
      type: "broadcast",
      event: "offer",
      payload: { from: "guest-1", sdp: { type: "offer", sdp: "newest" } },
    });
    await flushMicrotasks();

    expect(answers).toHaveLength(1);
    expect(pcs.filter((pc) => !pc.closed)).toHaveLength(1);
    expect(pcs.at(-1)!.remoteDescription?.sdp).toBe("newest");
    host.close();
  });

  it("a replaced connection's late teardown does not evict the one that replaced it", async () => {
    const bus = new FakeRealtimeBus();
    const pcs: FakePeerConnection[] = [];
    const host = new HostNet({
      client: fakeSupabaseClient(bus),
      roomCode: "ROOMCODE01",
      selfId: "host-1",
      createPeerConnection: () => {
        const pc = new FakePeerConnection(`host-${pcs.length}`);
        pcs.push(pc);
        return pc;
      },
    });
    const guestChannel = new FakeRealtimeChannel(bus);
    const offer = {
      type: "broadcast" as const,
      event: "offer",
      payload: { from: "guest-1", sdp: { type: "offer", sdp: "o" } },
    };

    await guestChannel.send(offer);
    await flushMicrotasks();
    await guestChannel.send(offer);
    await flushMicrotasks();
    pcs[1].openControlChannel();
    expect(host.connectedCount).toBe(1);

    // The abandoned connection's ICE gives up long after it was replaced.
    pcs[0].simulateConnectionState("failed");

    expect(host.connectedCount).toBe(1);
    host.close();
  });
});

describe("capacity and failure reporting", () => {
  it("still rejects a Guest over MAX_PLAYERS with room-full rather than a silent hang", async () => {
    const bus = new FakeRealtimeBus();
    const pcs: FakePeerConnection[] = [];
    const host = new HostNet({
      client: fakeSupabaseClient(bus),
      roomCode: "ROOMCODE01",
      selfId: "host-1",
      createPeerConnection: () => {
        const pc = new FakePeerConnection(`host-${pcs.length}`);
        pcs.push(pc);
        return pc;
      },
    });
    const guestChannel = new FakeRealtimeChannel(bus);
    const roomFullFor: string[] = [];
    guestChannel.on("broadcast", { event: "room-full" }, ({ payload }) => {
      roomFullFor.push((payload as { to: string }).to);
    });

    // Fill every Guest slot: the Host occupies one of MAX_PLAYERS itself, and
    // a slot only counts once the control channel is actually open.
    for (let i = 0; i < MAX_PLAYERS - 1; i++) {
      await guestChannel.send({
        type: "broadcast",
        event: "offer",
        payload: { from: `guest-${i}`, sdp: { type: "offer", sdp: "o" } },
      });
      await flushMicrotasks();
      pcs[i].openControlChannel();
    }
    expect(host.connectedCount).toBe(MAX_PLAYERS - 1);

    await guestChannel.send({
      type: "broadcast",
      event: "offer",
      payload: { from: "one-too-many", sdp: { type: "offer", sdp: "o" } },
    });
    await flushMicrotasks();

    expect(roomFullFor).toEqual(["one-too-many"]);
    expect(pcs).toHaveLength(MAX_PLAYERS - 1); // no connection built for the rejected Guest
    host.close();
  });

  it("with no TURN configured, an ICE failure names the missing relay", async () => {
    const rig = makeRig();
    const statuses: ConnectionStatus[] = [];
    rig.guest.onConnectionStatus((s) => statuses.push(s));

    rig.guest.connect();
    await flushMicrotasks();
    rig.guestPc()!.simulateLocalCandidate("srflx");
    rig.guestPc()!.simulateIceConnectionState("failed");
    await flushMicrotasks();

    const failed = statuses.find((s) => s.state === "failed");
    expect(failed?.state).toBe("failed");
    if (failed?.state !== "failed") throw new Error("expected a failed status");
    expect(failed.reason).toBe("ice-failed");
    expect(failed.hint).toMatch(/no relay server is configured/i);
    // The old copy blamed the player's network for a host-side problem.
    expect(failed.hint).not.toMatch(/switching to wi-?fi/i);
  });

  it("a Host that never answers is reported as such, not as a network problem", async () => {
    vi.useFakeTimers();
    try {
      const bus = new FakeRealtimeBus();
      let guestPc: FakePeerConnection | undefined;
      // No HostNet on the bus at all: exactly what a stale Realtime presence
      // entry looks like from the Guest's side.
      const guest = new GuestNet({
        client: fakeSupabaseClient(bus),
        roomCode: "ROOMCODE01",
        selfId: "guest-1",
        createPeerConnection: () => (guestPc = new FakePeerConnection("guest")),
      });
      const statuses: ConnectionStatus[] = [];
      guest.onConnectionStatus((s) => statuses.push(s));

      guest.connect();
      await vi.advanceTimersByTimeAsync(0);
      guestPc?.simulateLocalCandidate("srflx");
      await vi.advanceTimersByTimeAsync(60_000);

      const failed = statuses.find((s) => s.state === "failed");
      if (failed?.state !== "failed") throw new Error("expected a failed status");
      expect(failed.reason).toBe("no-answer");
      expect(failed.message).toMatch(/host didn't answer/i);
      guest.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("room-full survives the peer teardown that follows it", async () => {
    const bus = new FakeRealtimeBus();
    const guest = new GuestNet({
      client: fakeSupabaseClient(bus),
      roomCode: "ROOMCODE01",
      selfId: "guest-1",
      createPeerConnection: () => new FakePeerConnection("guest"),
    });
    guest.connect();
    await flushMicrotasks();

    const hostChannel = new FakeRealtimeChannel(bus);
    await hostChannel.send({ type: "broadcast", event: "room-full", payload: { to: "guest-1" } });
    await flushMicrotasks();

    // onRoomFull closes the peer straight after setting the status; the
    // resulting "closed" must not overwrite the verdict with a vaguer one.
    expect(guest.getConnectionStatus().state).toBe("room_full");
    guest.close();
  });
});
