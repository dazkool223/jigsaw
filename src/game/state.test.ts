import { describe, expect, it } from "vitest";
import type { Piece, Puzzle } from "../types";
import {
  bringToFront,
  createInitialState,
  deserialize,
  grabGroup,
  groupOfPiece,
  isComplete,
  mergeGroups,
  moveGroup,
  releaseGroup,
  serialize,
} from "./state";

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

describe("createInitialState", () => {
  it("creates one Group per Piece, with the given scatter offsets and ascending z", () => {
    const puzzle = makePuzzle();
    const scatter = Object.fromEntries(puzzle.pieces.map((p) => [p.id, { x: p.id, y: -p.id }]));
    const state = createInitialState(puzzle, scatter);

    expect(Object.keys(state.groups)).toHaveLength(9);
    for (const piece of puzzle.pieces) {
      const group = state.groups[piece.id];
      expect(group).toBeDefined();
      expect(group.pieceIds).toEqual([piece.id]);
      expect(group.offset).toEqual({ x: piece.id, y: -piece.id });
    }

    const zs = puzzle.pieces.map((p) => state.groups[p.id].z);
    const sorted = [...zs].sort((a, b) => a - b);
    expect(zs).toEqual(sorted); // ascending in piece order
    expect(new Set(zs).size).toBe(9); // all distinct
    expect(state.nextZ).toBe(9);
    expect(state.heldBy).toEqual({});
  });

  it("defaults to (0,0) offset for a Piece missing from scatterOffsets", () => {
    const puzzle = makePuzzle();
    const state = createInitialState(puzzle, {});
    expect(state.groups[0].offset).toEqual({ x: 0, y: 0 });
  });
});

describe("grabGroup / releaseGroup", () => {
  it("grants a grab on an unheld Group", () => {
    const state = createInitialState(makePuzzle(), {});
    const result = grabGroup(state, 0, "alice");
    expect(result.granted).toBe(true);
    expect(result.state.heldBy[0]).toBe("alice");
  });

  it("is a no-op success re-grabbing your own held Group", () => {
    const state = createInitialState(makePuzzle(), {});
    const first = grabGroup(state, 0, "alice");
    const again = grabGroup(first.state, 0, "alice");
    expect(again.granted).toBe(true);
    expect(again.state).toBe(first.state);
  });

  it("denies a grab on a Group already held by a different player — first requester wins", () => {
    const state = createInitialState(makePuzzle(), {});
    const alice = grabGroup(state, 0, "alice");
    expect(alice.granted).toBe(true);

    const bob = grabGroup(alice.state, 0, "bob");
    expect(bob.granted).toBe(false);
    if (!bob.granted) expect(bob.reason).toBe("held-by-other");
    // state is unchanged for the loser
    expect(bob.state).toBe(alice.state);
    expect(bob.state.heldBy[0]).toBe("alice");
  });

  it("denies a grab on a nonexistent Group", () => {
    const state = createInitialState(makePuzzle(), {});
    const result = grabGroup(state, 999, "alice");
    expect(result.granted).toBe(false);
    if (!result.granted) expect(result.reason).toBe("not-found");
  });

  it("releases only for the current holder; is a no-op otherwise", () => {
    const state = createInitialState(makePuzzle(), {});
    const held = grabGroup(state, 0, "alice").state;

    const bobRelease = releaseGroup(held, 0, "bob");
    expect(bobRelease).toBe(held); // no-op, unchanged reference

    const released = releaseGroup(held, 0, "alice");
    expect(released.heldBy[0]).toBeUndefined();
  });

  it("lets a different player grab after release", () => {
    const state = createInitialState(makePuzzle(), {});
    const held = grabGroup(state, 0, "alice").state;
    const released = releaseGroup(held, 0, "alice");
    const bob = grabGroup(released, 0, "bob");
    expect(bob.granted).toBe(true);
    expect(bob.state.heldBy[0]).toBe("bob");
  });
});

describe("moveGroup", () => {
  it("sets the Group's offset to the given absolute value", () => {
    const state = createInitialState(makePuzzle(), {});
    const moved = moveGroup(state, 0, { x: 42, y: -7 });
    expect(moved.groups[0].offset).toEqual({ x: 42, y: -7 });
    // original state untouched
    expect(state.groups[0].offset).toEqual({ x: 0, y: 0 });
  });

  it("is a no-op for a nonexistent Group", () => {
    const state = createInitialState(makePuzzle(), {});
    const moved = moveGroup(state, 999, { x: 1, y: 1 });
    expect(moved).toBe(state);
  });
});

describe("mergeGroups", () => {
  it("unions pieceIds, keeps the into Group's id and offset, takes the higher z", () => {
    const puzzle = makePuzzle();
    let state = createInitialState(puzzle, {
      0: { x: 5, y: 5 },
      1: { x: 999, y: 999 }, // deliberately different — merge must NOT change into's offset
    });
    state = { ...state, groups: { ...state.groups, 1: { ...state.groups[1], z: 100 } } };

    const merged = mergeGroups(state, 0, 1);
    expect(merged.groups[0].pieceIds.sort()).toEqual([0, 1]);
    expect(merged.groups[0].offset).toEqual({ x: 5, y: 5 });
    expect(merged.groups[0].z).toBe(100);
    expect(merged.groups[1]).toBeUndefined();
  });

  it("clears heldBy entries for both the absorbed and surviving id", () => {
    const puzzle = makePuzzle();
    let state = createInitialState(puzzle, {});
    state = { ...state, heldBy: { 0: "alice", 1: "bob" } };
    const merged = mergeGroups(state, 0, 1);
    expect(merged.heldBy[0]).toBeUndefined();
    expect(merged.heldBy[1]).toBeUndefined();
  });

  it("is a no-op if either Group is missing, or ids are equal", () => {
    const state = createInitialState(makePuzzle(), {});
    expect(mergeGroups(state, 0, 999)).toBe(state);
    expect(mergeGroups(state, 999, 0)).toBe(state);
    expect(mergeGroups(state, 0, 0)).toBe(state);
  });
});

describe("bringToFront", () => {
  it("assigns the Group state.nextZ and increments it", () => {
    const state = createInitialState(makePuzzle(), {});
    const brought = bringToFront(state, 0);
    expect(brought.groups[0].z).toBe(state.nextZ);
    expect(brought.nextZ).toBe(state.nextZ + 1);
  });
});

describe("groupOfPiece", () => {
  it("finds the Group containing a Piece", () => {
    const puzzle = makePuzzle();
    let state = createInitialState(puzzle, {});
    state = mergeGroups(state, 0, 1);
    expect(groupOfPiece(state, 1)).toBe(0);
    expect(groupOfPiece(state, 0)).toBe(0);
    expect(groupOfPiece(state, 2)).toBe(2);
  });

  it("returns undefined for an unknown Piece", () => {
    const state = createInitialState(makePuzzle(), {});
    expect(groupOfPiece(state, 999)).toBeUndefined();
  });
});

describe("isComplete", () => {
  it("is false with multiple Groups and true with exactly one", () => {
    const puzzle = makePuzzle();
    let state = createInitialState(puzzle, {});
    expect(isComplete(state)).toBe(false);

    for (let id = 1; id < 9; id++) {
      state = mergeGroups(state, 0, id);
    }
    expect(isComplete(state)).toBe(true);
    expect(Object.keys(state.groups)).toEqual(["0"]);
  });
});

describe("serialize / deserialize", () => {
  it("round-trips exactly", () => {
    const puzzle = makePuzzle();
    let state = createInitialState(puzzle, { 0: { x: 3, y: 4 } });
    state = grabGroup(state, 2, "alice").state;
    state = bringToFront(state, 5);
    state = mergeGroups(state, 3, 4);

    const wire = serialize(state);
    const roundTripped = deserialize(wire);
    expect(roundTripped).toEqual(state);

    // and serializing again produces the same wire shape
    expect(serialize(roundTripped)).toEqual(wire);
  });
});
