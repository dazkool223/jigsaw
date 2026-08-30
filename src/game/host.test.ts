import { describe, expect, it } from "vitest";
import type { GameState, Piece, Player, Puzzle } from "../types";
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

describe("Live drag is visible to bystanders, not just on drop", () => {
  it("relays one Guest's mid-drag MOVE to a second Guest (for lerped remote motion, per the plan)", async () => {
    const puzzle = makePuzzle();
    const hub = new LoopbackHub();
    const host = new Host({
      transport: hub.connectHost("host-player"),
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

    // Mid-drag, BEFORE any drop — Bob must see this without waiting for DROP/SNAP.
    alice.move(0, { x: 17, y: -9 });
    await waitUntil(() => bob.getState().groups[0]?.offset.x === 17 && bob.getState().groups[0]?.offset.y === -9);

    host.close();
    alice.close();
    bob.close();
  });
});

describe("Host local play (the Host's own browser is a player too)", () => {
  it("grab/move/drop apply synchronously and reach a connected Guest, identically to a Guest's own actions", async () => {
    const puzzle = makePuzzle();
    const hub = new LoopbackHub();
    const host = new Host({
      transport: hub.connectHost("host-player"),
      puzzle,
      scatterOffsets: {},
      hostPlayerId: "host-player",
      hostPlayer: makeHostPlayer(),
      resyncIntervalMs: 60_000,
    });
    const guest = new Client({
      transport: hub.connectGuest("guest-1"),
      playerId: "guest-1",
      name: "Guest",
      color: "#222222",
    });
    await waitUntil(() => guest.isReady());

    // Synchronous result, unlike Client.grab() — the Host is the arbiter.
    expect(host.grab(0)).toEqual({ granted: true });
    expect(host.getState().heldBy[0]).toBe("host-player");

    host.move(0, { x: 30, y: 40 });
    expect(host.getState().groups[0]?.offset).toEqual({ x: 30, y: 40 });
    // The Guest should see the Host's live drag relayed to it, not just the eventual drop.
    await waitUntil(() => guest.getState().groups[0]?.offset.x === 30);

    host.drop(0, { x: 30, y: 40 });
    expect(host.getState().heldBy[0]).toBeUndefined();
    await waitUntil(
      () => guest.getState().groups[0]?.offset.x === 30 && guest.getState().heldBy[0] === undefined
    );

    host.close();
    guest.close();
  });

  it("denies the Host's own grab on a Group a Guest already holds, exactly like a Guest-vs-Guest race", async () => {
    const puzzle = makePuzzle();
    const hub = new LoopbackHub();
    const host = new Host({
      transport: hub.connectHost("host-player"),
      puzzle,
      scatterOffsets: {},
      hostPlayerId: "host-player",
      hostPlayer: makeHostPlayer(),
      resyncIntervalMs: 60_000,
    });
    const guest = new Client({
      transport: hub.connectGuest("guest-1"),
      playerId: "guest-1",
      name: "Guest",
      color: "#222222",
    });
    await waitUntil(() => guest.isReady());

    guest.grab(0);
    await waitUntil(() => host.getState().heldBy[0] === "guest-1");

    expect(host.grab(0)).toEqual({ granted: false, reason: "held" });
    expect(host.getState().heldBy[0]).toBe("guest-1"); // unchanged — the Guest keeps the lock

    host.close();
    guest.close();
  });

  it("fires onChange for both local actions and Guest-originated ones", async () => {
    const puzzle = makePuzzle();
    const hub = new LoopbackHub();
    const host = new Host({
      transport: hub.connectHost("host-player"),
      puzzle,
      scatterOffsets: {},
      hostPlayerId: "host-player",
      hostPlayer: makeHostPlayer(),
      resyncIntervalMs: 60_000,
    });
    let changes = 0;
    const unsubscribe = host.onChange(() => {
      changes += 1;
    });

    host.grab(1); // local
    expect(changes).toBeGreaterThan(0);
    const afterLocal = changes;

    const guest = new Client({
      transport: hub.connectGuest("guest-1"),
      playerId: "guest-1",
      name: "Guest",
      color: "#222222",
    });
    await waitUntil(() => guest.isReady());
    guest.grab(0);
    await waitUntil(() => changes > afterLocal); // Guest-originated grab also notifies

    unsubscribe();
    const beforeUnsub = changes;
    host.move(1, { x: 5, y: 5 });
    expect(changes).toBe(beforeUnsub); // unsubscribed — no further notifications

    host.close();
    guest.close();
  });
});

describe("Host resume-as-Host (initialState)", () => {
  it("seeds from a persisted GameState instead of re-scattering, per CONTEXT.md's Session lifecycle", async () => {
    const puzzle = makePuzzle();
    const persisted: GameState = {
      groups: {
        // Pieces 0 and 1 already merged into one Group mid-board — this is
        // exactly what a fresh scatter would never produce, so its presence
        // in the resumed Host proves the snapshot was actually used.
        0: { id: 0, pieceIds: [0, 1], offset: { x: 12, y: 7 }, z: 3 },
        2: { id: 2, pieceIds: [2], offset: { x: -40, y: 15 }, z: 1 },
      },
      heldBy: {},
      nextZ: 4,
      nextGroupId: 3,
    };

    const hub = new LoopbackHub();
    const host = new Host({
      transport: hub.connectHost("host-player"),
      puzzle,
      scatterOffsets: {}, // must be ignored in favour of initialState
      hostPlayerId: "host-player",
      hostPlayer: makeHostPlayer(),
      resyncIntervalMs: 60_000,
      initialState: persisted,
    });

    expect(host.getState()).toEqual(persisted);

    const guest = new Client({
      transport: hub.connectGuest("guest-1"),
      playerId: "guest-1",
      name: "Guest",
      color: "#222222",
    });
    await waitUntil(() => guest.isReady());
    // The Guest's WELCOME must carry the resumed state, not a fresh scatter.
    expect(guest.getState()).toEqual(persisted);

    host.close();
    guest.close();
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
