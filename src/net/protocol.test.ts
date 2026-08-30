import { describe, expect, it } from "vitest";
import type { GameState, Group, Player } from "../types";
import {
  dropStale,
  isCompleteMessage,
  isCursorMessage,
  isDropMessage,
  isFullStateMessage,
  isGrabDeniedMessage,
  isGrabGrantedMessage,
  isGrabMessage,
  isHostChangedMessage,
  isJoinMessage,
  isMoveMessage,
  isPlayerListMessage,
  isRoomFullMessage,
  isSnapMessage,
  isStateRequestMessage,
  isWelcomeMessage,
  parseMessage,
  type ProtocolMessage,
} from "./protocol";

// ── Fixtures ─────────────────────────────────────────────────────────────

const player: Player = { id: "p1", name: "Red Fox", color: "#ff0000" };

const group: Group = { id: 1, pieceIds: [0, 1, 2], offset: { x: 0, y: 0 }, z: 1 };

const gameState: GameState = {
  groups: { 1: group },
  heldBy: { 1: "p1" },
  nextZ: 2,
  nextGroupId: 2,
};

const validMessages: ProtocolMessage[] = [
  { type: "JOIN", playerId: "p1", name: "Red Fox", color: "#ff0000" },
  {
    type: "WELCOME",
    you: "p1",
    players: [player],
    state: gameState,
    hostEpoch: 3,
    seq: 0,
  },
  { type: "FULL_STATE", state: gameState, seq: 1 },
  { type: "STATE_REQUEST", playerId: "p1" },
  { type: "GRAB", groupId: 1, playerId: "p1" },
  { type: "GRAB_GRANTED", groupId: 1, playerId: "p1", z: 6, seq: 2 },
  { type: "GRAB_DENIED", groupId: 1, playerId: "p1", reason: "held" },
  {
    type: "MOVE",
    seq: 5,
    groupId: 1,
    playerId: "p1",
    offset: { x: 10, y: -5 },
  },
  { type: "DROP", groupId: 1, playerId: "p1", offset: { x: 10, y: -5 } },
  {
    type: "SNAP",
    groups: [group],
    removedGroupIds: [2, 3],
    nextZ: 4,
    nextGroupId: 5,
    seq: 3,
  },
  { type: "CURSOR", seq: 7, playerId: "p1", point: { x: 1, y: 2 } },
  { type: "PLAYER_LIST", players: [player], seq: 4 },
  { type: "COMPLETE", seq: 8 },
  { type: "ROOM_FULL" },
  { type: "HOST_CHANGED", hostId: "p2", hostEpoch: 4 },
];

const guardsByType: Record<
  ProtocolMessage["type"],
  (m: unknown) => boolean
> = {
  JOIN: isJoinMessage,
  WELCOME: isWelcomeMessage,
  FULL_STATE: isFullStateMessage,
  STATE_REQUEST: isStateRequestMessage,
  GRAB: isGrabMessage,
  GRAB_GRANTED: isGrabGrantedMessage,
  GRAB_DENIED: isGrabDeniedMessage,
  MOVE: isMoveMessage,
  DROP: isDropMessage,
  SNAP: isSnapMessage,
  CURSOR: isCursorMessage,
  PLAYER_LIST: isPlayerListMessage,
  COMPLETE: isCompleteMessage,
  ROOM_FULL: isRoomFullMessage,
  HOST_CHANGED: isHostChangedMessage,
};

// ── Generic malformed-input probes, run against every guard and parseMessage ──

const genericMalformed: unknown[] = [
  null,
  undefined,
  42,
  "not an object",
  true,
  [],
  [1, 2, 3],
  {},
  { type: 123 },
  { type: null },
  { type: "TOTALLY_UNKNOWN" },
  { nested: { deeply: { junk: [1, { type: "JOIN" }] } } },
  JSON.stringify({ type: "JOIN", playerId: "p1", name: "x", color: "y" }),
];

describe("per-message guards", () => {
  for (const msg of validMessages) {
    it(`accepts a valid ${msg.type} message`, () => {
      expect(guardsByType[msg.type](msg)).toBe(true);
    });

    it(`${msg.type} guard rejects generic malformed input`, () => {
      const guard = guardsByType[msg.type];
      for (const bad of genericMalformed) {
        expect(guard(bad)).toBe(false);
      }
    });

    it(`${msg.type} guard rejects the same message with type missing`, () => {
      const { type: _type, ...rest } = msg as Record<string, unknown>;
      expect(guardsByType[msg.type](rest)).toBe(false);
    });

    it(`${msg.type} guard rejects the same message with wrong-typed fields`, () => {
      // `{}` is never a valid value for any field this protocol uses (not a
      // string, not a finite number, not a Point/GameState shape, and not an
      // array), so substituting it for each field in turn is a safe generic
      // "wrong type" probe regardless of what that field's real type is.
      for (const key of Object.keys(msg)) {
        if (key === "type") continue;
        const mutated = { ...(msg as Record<string, unknown>), [key]: {} };
        expect(guardsByType[msg.type](mutated)).toBe(false);
      }
    });

    it(`other guards reject a valid ${msg.type} message`, () => {
      for (const [otherType, guard] of Object.entries(guardsByType)) {
        if (otherType === msg.type) continue;
        expect(guard(msg)).toBe(false);
      }
    });
  }
});

describe("parseMessage", () => {
  it("never throws on any malformed input", () => {
    const inputs: unknown[] = [
      ...genericMalformed,
      Symbol("weird"),
      new Date(),
      // A getter that throws — must not escape parseMessage.
      Object.defineProperty({}, "type", {
        get() {
          throw new Error("boom");
        },
        enumerable: true,
      }),
      // Circular-ish structure (not truly circular since JSON can't carry that,
      // but a deep object with a throwing nested field is a good analog).
      { type: "JOIN", playerId: "p1", name: "x", color: "y", extra: undefined },
    ];
    for (const input of inputs) {
      expect(() => parseMessage(input)).not.toThrow();
    }
  });

  it("returns null for every generic malformed input", () => {
    for (const bad of genericMalformed) {
      expect(parseMessage(bad)).toBeNull();
    }
  });

  it("accepts every valid message", () => {
    for (const msg of validMessages) {
      expect(parseMessage(msg)).toEqual(msg);
    }
  });

  it("rejects a message with an unrecognized type", () => {
    expect(parseMessage({ type: "NOT_REAL" })).toBeNull();
  });

  it("rejects a valid-looking message with extra type-mismatched required field", () => {
    expect(parseMessage({ type: "GRAB", groupId: "1", playerId: "p1" })).toBeNull();
  });

  describe("round-trip: encode -> JSON.stringify -> JSON.parse -> parseMessage", () => {
    for (const msg of validMessages) {
      it(`round-trips ${msg.type}`, () => {
        const wire = JSON.parse(JSON.stringify(msg));
        const parsed = parseMessage(wire);
        expect(parsed).toEqual(msg);
      });
    }
  });
});

describe("dropStale", () => {
  const base = { type: "CURSOR" as const, playerId: "p1", point: { x: 0, y: 0 } };

  it("drops a seq equal to lastSeq (duplicate)", () => {
    expect(dropStale(5, { ...base, seq: 5 })).toBe(true);
  });

  it("drops a seq older than lastSeq (out of order)", () => {
    expect(dropStale(5, { ...base, seq: 3 })).toBe(true);
  });

  it("accepts a seq newer than lastSeq", () => {
    expect(dropStale(5, { ...base, seq: 6 })).toBe(false);
  });

  it("accepts the very first message when lastSeq starts at -1", () => {
    expect(dropStale(-1, { ...base, seq: 0 })).toBe(false);
  });
});
