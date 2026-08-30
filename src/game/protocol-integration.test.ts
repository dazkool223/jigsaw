/**
 * The whole point of this file: prove that `Host` and `Client` actually
 * agree with `net/protocol.ts`. Every message either side sends over the
 * loopback Transport is intercepted here and must round-trip through
 * `JSON.parse(JSON.stringify(msg))` (simulating the wire) and then
 * `parseMessage(...)` without returning null - i.e. it must be a
 * well-formed member of `ProtocolMessage`. Before the reconciliation this
 * task performs, `host.ts`/`client.ts` sent their own local shapes and this
 * test would have failed on the first message.
 */

import { describe, expect, it } from "vitest";
import type { Channel, Piece, Player, Puzzle, Recipient, Transport } from "../types";
import { MAX_PLAYERS } from "../config";
import { Host } from "./host";
import { Client } from "./client";
import { LoopbackHub } from "./loopback";
import { parseMessage } from "../net/protocol";

// ── Fixture: a tiny 2x2 puzzle, deliberately independent of src/puzzle ──
// scatterOffsets defaults every Group to offset (0,0) - its own Lattice
// position - so a single grab+drop at (0,0) cascades a full Merge to one
// Group in one resolveDrop call, letting one small scenario exercise SNAP
// and COMPLETE without needing large/careful drag math.

function makePiece(id: number): Piece {
  const row = Math.floor(id / 2);
  const col = id % 2;
  return {
    id,
    row,
    col,
    solved: { x: col * 100, y: row * 100 },
    outline: [],
    bbox: { x: col * 100, y: row * 100, w: 100, h: 100 },
  };
}

function makePuzzle(): Puzzle {
  const pieces = Array.from({ length: 4 }, (_, id) => makePiece(id));
  return {
    definition: { imageUrl: "test://image", seed: 1, rows: 2, cols: 2 },
    grid: { rows: 2, cols: 2, cellW: 100, cellH: 100, imageW: 200, imageH: 200 },
    pieces,
  };
}

function makeHostPlayer(): Player {
  return { id: "host-player", name: "Host", color: "#111111" };
}

/**
 * The loopback delivers via setTimeout(0), so in practice every condition here
 * settles in single-digit milliseconds. The timeout exists only to turn a hang
 * into a readable failure, so it is deliberately generous: a tight budget makes
 * this suite flaky when the machine is loaded (several vitest workers in
 * parallel), which is a false alarm rather than a real defect. Pass `label` so
 * a genuine failure says WHICH condition never came true.
 */
function waitUntil(
  predicate: () => boolean,
  label = "condition",
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitUntil: ${label} never became true within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

/**
 * Wraps a Transport so every message it `send`s is handed to `onSend` before
 * being forwarded unmodified to the real transport. Everything else
 * (onMessage, onPeerJoin, onPeerLeave, close, and the optional
 * onStatus/getStatus) just delegates straight through.
 */
function wrapTransportSend(inner: Transport, onSend: (msg: unknown) => void): Transport {
  const wrapped: Transport = {
    send(channel: Channel, to: Recipient, msg: unknown): void {
      onSend(msg);
      inner.send(channel, to, msg);
    },
    onMessage: (handler) => inner.onMessage(handler),
    onPeerJoin: (handler) => inner.onPeerJoin(handler),
    onPeerLeave: (handler) => inner.onPeerLeave(handler),
    close: () => inner.close(),
  };
  if (inner.onStatus) {
    wrapped.onStatus = (handler) => inner.onStatus!(handler);
  }
  if (inner.getStatus) {
    wrapped.getStatus = () => inner.getStatus!();
  }
  return wrapped;
}

/** Asserts `msg` is exactly what a real wire trip would deliver: parseable, not null. */
function expectRoundTrips(msg: unknown): void {
  const wire = JSON.parse(JSON.stringify(msg));
  const parsed = parseMessage(wire);
  expect(parsed, `message failed to round-trip through parseMessage: ${JSON.stringify(msg)}`).not.toBeNull();
}

describe("Host <-> Client wire traffic all round-trips through parseMessage", () => {
  it("every message type sent during a full session (join, grab race, drag, merge-to-complete, cursor, resync, leave) is well-formed", async () => {
    const puzzle = makePuzzle();
    const hub = new LoopbackHub();
    const seenTypes = new Set<string>();

    const collect = (msg: unknown): void => {
      expectRoundTrips(msg);
      if (msg !== null && typeof msg === "object" && "type" in msg) {
        seenTypes.add(String((msg as { type: unknown }).type));
      }
    };

    const rawHostTransport = hub.connectHost("host-player");
    const hostTransport = wrapTransportSend(rawHostTransport, collect);
    const host = new Host({
      transport: hostTransport,
      puzzle,
      scatterOffsets: {},
      hostPlayerId: "host-player",
      hostPlayer: makeHostPlayer(),
      resyncIntervalMs: 60_000,
      hostEpoch: 7,
    });

    const rawAliceTransport = hub.connectGuest("alice");
    const aliceTransport = wrapTransportSend(rawAliceTransport, collect);
    const alice = new Client({ transport: aliceTransport, playerId: "alice", name: "Alice", color: "#f00" });

    const rawBobTransport = hub.connectGuest("bob");
    const bobTransport = wrapTransportSend(rawBobTransport, collect);
    const bob = new Client({ transport: bobTransport, playerId: "bob", name: "Bob", color: "#0f0" });

    await waitUntil(() => alice.isReady() && bob.isReady());

    // Grab race: alice wins, bob is denied (GRAB, GRAB_GRANTED, GRAB_DENIED).
    alice.grab(0);
    await waitUntil(() => host.getState().heldBy[0] === "alice");
    bob.grab(0);
    await waitUntil(() => bob.getLastGrabDenied()?.groupId === 0);
    // bob's denial handler auto-requests a resync (STATE_REQUEST / FULL_STATE).
    await waitUntil(() => seenTypes.has("STATE_REQUEST") && seenTypes.has("FULL_STATE"));

    // Mid-drag (MOVE), then drop back at the Lattice position, cascading a
    // full Merge (SNAP) and Completion (COMPLETE) in one drop.
    alice.sendCursor({ x: 12, y: 34 }); // CURSOR
    alice.move(0, { x: 5, y: -5 }); // MOVE
    alice.drop(0, { x: 0, y: 0 }); // DROP -> SNAP (+ COMPLETE, since it's the whole 2x2)
    await waitUntil(() => Object.keys(host.getState().groups).length === 1);
    await waitUntil(() => seenTypes.has("SNAP") && seenTypes.has("COMPLETE"));
    await waitUntil(() => alice.isComplete() && bob.isComplete());

    // Peer leave -> PLAYER_LIST re-broadcast. Client.close() only unsubscribes
    // its own message handler (transport lifecycle is the caller's
    // responsibility, same as in the original design) - close the transport
    // itself to simulate a real disconnect and trigger the Host's onPeerLeave.
    bob.close();
    bobTransport.close();
    await waitUntil(() => host.getPlayers().every((p) => p.id !== "bob"));

    host.close();
    alice.close();

    // Sanity: we actually exercised the message types this scenario claims to.
    for (const expected of [
      "JOIN",
      "WELCOME",
      "PLAYER_LIST",
      "GRAB",
      "GRAB_GRANTED",
      "GRAB_DENIED",
      "STATE_REQUEST",
      "FULL_STATE",
      "CURSOR",
      "MOVE",
      "DROP",
      "SNAP",
      "COMPLETE",
    ]) {
      expect(seenTypes.has(expected), `expected to have seen a ${expected} message on the wire`).toBe(true);
    }
  });

  it("ROOM_FULL round-trips when a Guest joins beyond MAX_PLAYERS", async () => {
    const puzzle = makePuzzle();
    const hub = new LoopbackHub();
    const messages: unknown[] = [];
    const collect = (msg: unknown): void => {
      expectRoundTrips(msg);
      messages.push(msg);
    };

    const hostTransport = wrapTransportSend(hub.connectHost("host-player"), collect);
    const host = new Host({
      transport: hostTransport,
      puzzle,
      scatterOffsets: {},
      hostPlayerId: "host-player",
      hostPlayer: makeHostPlayer(),
      resyncIntervalMs: 60_000,
    });

    const clients: Client[] = [];
    for (let i = 0; i < MAX_PLAYERS - 1; i++) {
      const id = `guest-${i}`;
      const transport = wrapTransportSend(hub.connectGuest(id), collect);
      clients.push(new Client({ transport, playerId: id, name: `Guest ${i}`, color: "#000000" }));
    }
    await waitUntil(() => clients.every((c) => c.isReady()));

    const overflowTransport = wrapTransportSend(hub.connectGuest("guest-overflow"), collect);
    const overflow = new Client({
      transport: overflowTransport,
      playerId: "guest-overflow",
      name: "Overflow",
      color: "#ffffff",
    });

    await waitUntil(() => overflow.getJoinDeniedReason() === "room-full");
    expect(
      messages.some((m) => m !== null && typeof m === "object" && (m as { type?: unknown }).type === "ROOM_FULL")
    ).toBe(true);

    host.close();
    for (const c of clients) c.close();
    overflow.close();
  });
});
