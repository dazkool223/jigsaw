import { describe, expect, it } from "vitest";
import type { GameState, Piece, Puzzle } from "../types";
import { createInitialState, isComplete, mergeGroups } from "./state";
import { findMerges, resolveDrop, snapToLattice } from "./snap";

// ── Synthetic 3x3 fixture — deliberately independent of src/puzzle ──
//
//   0(0,0) 1(0,1) 2(0,2)
//   3(1,0) 4(1,1) 5(1,2)
//   6(2,0) 7(2,1) 8(2,2)
//
// cellW = cellH = 100, so SNAP_TOLERANCE (0.15) * 100 = 15px tolerance.

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

/**
 * All 9 Pieces as singleton Groups. Every Group defaults to a WIDELY spaced
 * (1000px apart) far-away offset — not (0,0) — so two orthogonally-adjacent
 * default Groups never accidentally land within SNAP_TOLERANCE of each
 * other. Tests override specific Groups' offsets to set up the scenario
 * they actually want to exercise.
 */
function baseState(overrides: Readonly<Record<number, { x: number; y: number }>> = {}): GameState {
  const scatter: Record<number, { x: number; y: number }> = {};
  for (let id = 0; id < 9; id++) {
    scatter[id] = { x: 10_000 + id * 1000, y: 10_000 + id * 1000 };
  }
  return createInitialState(makePuzzle(), { ...scatter, ...overrides });
}

function withOffset(state: GameState, groupId: number, offset: { x: number; y: number }): GameState {
  return { ...state, groups: { ...state.groups, [groupId]: { ...state.groups[groupId], offset } } };
}

function withHeld(state: GameState, groupId: number, playerId: string): GameState {
  return { ...state, heldBy: { ...state.heldBy, [groupId]: playerId } };
}

describe("findMerges — snap tolerance", () => {
  it("finds an adjacent Group just inside tolerance (14 < 15)", () => {
    const puzzle = makePuzzle();
    let state = baseState();
    state = withOffset(state, 0, { x: 0, y: 0 });
    state = withOffset(state, 1, { x: 14, y: 0 }); // piece 1 is adjacent to piece 0

    expect(findMerges(state, puzzle, 0)).toEqual([1]);
  });

  it("does not find an adjacent Group just outside tolerance (16 >= 15)", () => {
    const puzzle = makePuzzle();
    let state = baseState();
    state = withOffset(state, 0, { x: 0, y: 0 });
    state = withOffset(state, 1, { x: 16, y: 0 });

    expect(findMerges(state, puzzle, 0)).toEqual([]);
  });

  it("does not find non-adjacent Groups regardless of offset", () => {
    const puzzle = makePuzzle();
    let state = baseState();
    state = withOffset(state, 0, { x: 0, y: 0 });
    state = withOffset(state, 8, { x: 0, y: 0 }); // piece 8 is diagonal, not orthogonal, to piece 0

    expect(findMerges(state, puzzle, 0)).toEqual([]);
  });
});

describe("findMerges — held Groups are never merge targets", () => {
  it("skips a held neighbour, then finds it once released", () => {
    const puzzle = makePuzzle();
    let state = baseState();
    state = withOffset(state, 0, { x: 0, y: 0 });
    state = withOffset(state, 1, { x: 0, y: 0 });
    state = withHeld(state, 1, "bob");

    expect(findMerges(state, puzzle, 0)).toEqual([]);

    const released = { ...state, heldBy: {} };
    expect(findMerges(released, puzzle, 0)).toEqual([1]);
  });

  it("resolveDrop performs no merge while the neighbour is held, then merges after release", () => {
    const puzzle = makePuzzle();
    let state = baseState();
    state = withOffset(state, 4, { x: 0, y: 0 });
    state = withOffset(state, 1, { x: 0, y: 0 });
    state = withHeld(state, 1, "bob");

    const firstDrop = resolveDrop(state, puzzle, 4);
    expect(firstDrop.merged).toEqual([]);
    expect(firstDrop.state.groups[4].pieceIds).toEqual([4]);
    expect(firstDrop.state.groups[1]).toBeDefined();

    const releasedState = { ...firstDrop.state, heldBy: {} };
    const secondDrop = resolveDrop(releasedState, puzzle, 4);
    expect(secondDrop.merged).toEqual([1]);
    expect(secondDrop.state.groups[4].pieceIds.sort()).toEqual([1, 4]);
    expect(secondDrop.state.groups[1]).toBeUndefined();
  });
});

describe("resolveDrop — Lattice snap", () => {
  it("snaps a Group just inside tolerance of (0,0) to exactly (0,0)", () => {
    const puzzle = makePuzzle();
    const state = withOffset(baseState(), 4, { x: 5, y: -5 }); // magnitude ~7.07 < 15

    const result = resolveDrop(state, puzzle, 4);
    expect(result.snapped).toBe(true);
    expect(result.state.groups[4].offset).toEqual({ x: 0, y: 0 });
  });

  it("does not snap a Group outside Lattice tolerance", () => {
    const puzzle = makePuzzle();
    const state = withOffset(baseState(), 4, { x: 20, y: 0 }); // magnitude 20 >= 15

    const result = resolveDrop(state, puzzle, 4);
    expect(result.snapped).toBe(false);
    expect(result.state.groups[4].offset).toEqual({ x: 20, y: 0 });
  });

  it("snapToLattice alone leaves an out-of-tolerance offset untouched", () => {
    const puzzle = makePuzzle();
    const state = withOffset(baseState(), 4, { x: 20, y: 0 });
    const result = snapToLattice(state, 4, puzzle.grid);
    expect(result.groups[4].offset).toEqual({ x: 20, y: 0 });
  });
});

describe("resolveDrop — merge direction: smaller absorbed into larger", () => {
  it("keeps the larger Group's id and offset", () => {
    const puzzle = makePuzzle();
    let state = baseState();
    // Larger Group: pieces 0 and 1, sitting at a non-zero, non-tolerance offset.
    state = withOffset(state, 0, { x: 50, y: 50 });
    state = withOffset(state, 1, { x: 50, y: 50 });
    state = mergeGroups(state, 0, 1); // group 0 now has pieceIds [0,1], offset {50,50}

    // Smaller Group: piece 3 (adjacent to piece 0), dropped near group 0's offset.
    state = withOffset(state, 3, { x: 45, y: 45 }); // diff to {50,50} is ~7.07 < 15

    const result = resolveDrop(state, puzzle, 3);
    expect(result.merged).toEqual([3]);
    expect(result.snapped).toBe(false); // {45,45} itself is far from (0,0)
    expect(result.state.groups[0]).toBeDefined();
    expect(result.state.groups[0].pieceIds.sort()).toEqual([0, 1, 3]);
    expect(result.state.groups[0].offset).toEqual({ x: 50, y: 50 }); // unchanged — larger keeps its offset
    expect(result.state.groups[3]).toBeUndefined();
  });
});

describe("resolveDrop — chain merge", () => {
  it("a single drop bridging two separate Groups merges all three in one call", () => {
    const puzzle = makePuzzle();
    let state = baseState();
    // Three separate Groups, all near the Lattice, with piece 4 in the middle:
    //   group "1" = {1}, group "2" = {2}, dropped group "4" = {4}
    // piece 4 is adjacent to piece 1 (directly), but NOT adjacent to piece 2 —
    // piece 2 is only reachable through piece 1, so the second Group can only
    // be found on the chain-recheck pass, after piece 1's Group has merged in.
    for (const id of [0, 3, 5, 6, 7, 8]) {
      state = withOffset(state, id, { x: 500, y: 500 }); // far away — never a candidate
    }
    state = withOffset(state, 1, { x: 0, y: 0 });
    state = withOffset(state, 2, { x: 0, y: 0 });
    state = withOffset(state, 4, { x: 0, y: 0 });

    const result = resolveDrop(state, puzzle, 4);

    expect(result.merged.sort()).toEqual([1, 2]);
    expect(result.state.groups[4]).toBeDefined();
    expect(result.state.groups[4].pieceIds.sort()).toEqual([1, 2, 4]);
    expect(result.state.groups[1]).toBeUndefined();
    expect(result.state.groups[2]).toBeUndefined();
  });
});

describe("resolveDrop — Completion", () => {
  it("fires exactly when the last two Groups merge, not before", () => {
    const puzzle = makePuzzle();
    // Every Piece sitting together near the Lattice — override the "far
    // apart" default from baseState() since this test wants them adjacent.
    const together = Object.fromEntries(Array.from({ length: 9 }, (_, id) => [id, { x: 0, y: 0 }]));
    let state = baseState(together);
    for (let id = 1; id <= 7; id++) {
      state = mergeGroups(state, 0, id); // group 0 now holds pieces 0..7
    }
    expect(isComplete(state)).toBe(false);

    // piece 8 is adjacent to piece 5 and piece 7, both already in group 0.
    const result = resolveDrop(state, puzzle, 8);
    expect(result.merged).toEqual([8]);
    expect(isComplete(result.state)).toBe(true);
  });
});
