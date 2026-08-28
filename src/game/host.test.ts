import { describe, expect, it } from "vitest";
import type { Piece, Player, Puzzle } from "../types";
import { MAX_PLAYERS } from "../config";
import { Host } from "./host";
import { Client } from "./client";
import { LoopbackHub } from "./loopback";

// ── Synthetic 3x3 fixture — deliberately independent of src/puzzle ──

function makePiece(id: number): Piece {
  const row = Math.floor(id / 3);
  const col = id % 3;
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
  const pieces = Array.from({ length: 9 }, (_, id) => makePiece(id));
  return {
    definition: { imageUrl: "test://image", seed: 1, rows: 3, cols: 3 },
    grid: { rows: 3, cols: 3, cellW: 100, cellH: 100, imageW: 300, imageH: 300 },
    pieces,
  };
}

/** Loopback delivery is always deferred (setTimeout(0)); poll for a condition. */
function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("waitUntil: condition never became true"));
        return;
      }
      setTimeout(tick, 0);
    };
    tick();
  });
}

function makeHostPlayer(): Player {
  return { id: "host-player", name: "Host", color: "#111111" };
}

describe("Host over loopback", () => {
  it("a Guest joins, receives full state, grabs, moves, drops, and both sides converge", async () => {
    const puzzle = makePuzzle();
    const hub = new LoopbackHub();
    const hostTransport = hub.connectHost("host-player");

    const host = new Host({
      transport: hostTransport,
      puzzle,
      scatterOffsets: {},
      hostPlayerId: "host-player",
      hostPlayer: makeHostPlayer(),
      resyncIntervalMs: 60_000, // keep the periodic resync out of this test's way
    });

    const guestTransport = hub.connectGuest("guest-1");
    const client = new Client({ transport: guestTransport, playerId: "guest-1", name: "Guest", color: "#222222" });

    await waitUntil(() => client.isReady());
    expect(client.getPlayerId()).toBe("guest-1");
    expect(Object.keys(client.getState().groups)).toHaveLength(9);
    expect(host.getPlayers().map((p) => p.id).sort()).toEqual(["guest-1", "host-player"]);

    // Grab: Guest requests, Host grants, both sides see it held by the Guest.
    client.grab(0);
    await waitUntil(() => host.getState().heldBy[0] === "guest-1");
    await waitUntil(() => client.getState().heldBy[0] === "guest-1");

    // Move: an offset outside Lattice/merge tolerance so nothing snaps/merges
    // and the expected final value is unambiguous.
    const finalOffset = { x: 30, y: 40 };
    client.move(0, finalOffset);
    await waitUntil(() => host.getState().groups[0]?.offset.x === 30);

    // Drop: releases the hold and triggers resolveDrop on the Host.
    client.drop(0, finalOffset);
    await waitUntil(() => host.getState().heldBy[0] === undefined);

    // Both sides converge on the same final position for the dropped Group,
    // AND on the hold having been released (the Client applies both offset
    // and release atomically from the Host's "snap" message — checking both
    // here, not just offset, avoids a false-positive from the Client's own
    // earlier *optimistic* apply, which sets the offset before the Host's
    // authoritative round trip clears the hold).
    await waitUntil(() => {
      const hostGroup = host.getState().groups[0];
      const clientGroup = client.getState().groups[0];
      return (
        hostGroup !== undefined &&
        clientGroup !== undefined &&
        hostGroup.offset.x === finalOffset.x &&
        hostGroup.offset.y === finalOffset.y &&
        clientGroup.offset.x === finalOffset.x &&
        clientGroup.offset.y === finalOffset.y &&
        host.getState().heldBy[0] === undefined &&
        client.getState().heldBy[0] === undefined
      );
    });

    expect(host.getState().heldBy[0]).toBeUndefined();
    expect(client.getState().heldBy[0]).toBeUndefined();

    host.close();
    client.close();
  });

  it("denies a grab race to the loser, and lets them grab after release", async () => {
    const puzzle = makePuzzle();
    const hub = new LoopbackHub();
    const hostTransport = hub.connectHost("host-player");
    const host = new Host({
      transport: hostTransport,
      puzzle,
      scatterOffsets: {},
      hostPlayerId: "host-player",
      hostPlayer: makeHostPlayer(),
      resyncIntervalMs: 60_000,
    });

    const alice = new Client({ transport: hub.connectGuest("alice"), playerId: "alice", name: "Alice", color: "#f00" });
    const bob = new Client({ transport: hub.connectGuest("bob"), playerId: "bob", name: "Bob", color: "#0f0" });
    await waitUntil(() => alice.isReady() && bob.isReady());

    alice.grab(0);
    await waitUntil(() => host.getState().heldBy[0] === "alice");

    bob.grab(0); // races for the same Group, should be denied
    await waitUntil(() => bob.getLastGrabDenied()?.groupId === 0);
    expect(bob.getLastGrabDenied()).toEqual({ groupId: 0, reason: "held" });
    expect(host.getState().heldBy[0]).toBe("alice"); // exactly one requester won

    host.close();
    alice.close();
    bob.close();
  });
});

describe("MAX_PLAYERS enforcement", () => {
  it("rejects joins beyond the cap with a room-full reason, without touching player count", async () => {
    const puzzle = makePuzzle();
    const hub = new LoopbackHub();
    const hostTransport = hub.connectHost("host-player");
    const host = new Host({
      transport: hostTransport,
      puzzle,
      scatterOffsets: {},
      hostPlayerId: "host-player",
      hostPlayer: makeHostPlayer(),
      resyncIntervalMs: 60_000,
    });

    // Host already occupies one of MAX_PLAYERS slots.
    const clients: Client[] = [];
    for (let i = 0; i < MAX_PLAYERS - 1; i++) {
      const id = `guest-${i}`;
      const transport = hub.connectGuest(id);
      clients.push(new Client({ transport, playerId: id, name: `Guest ${i}`, color: "#000000" }));
    }
    await waitUntil(() => clients.every((c) => c.isReady()));
    expect(host.getPlayers()).toHaveLength(MAX_PLAYERS);

    const overflow = new Client({
      transport: hub.connectGuest("guest-overflow"),
      playerId: "guest-overflow",
      name: "Overflow",
      color: "#ffffff",
    });

    await waitUntil(() => overflow.getJoinDeniedReason() === "room-full");
    expect(overflow.isReady()).toBe(false);
    expect(host.getPlayers()).toHaveLength(MAX_PLAYERS);
    expect(host.getPlayers().some((p) => p.id === "guest-overflow")).toBe(false);

    host.close();
    for (const c of clients) c.close();
    overflow.close();
  });
});
