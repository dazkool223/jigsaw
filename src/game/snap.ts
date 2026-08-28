/**
 * Pure snapping/merging decisions. No I/O — resolveDrop is the whole
 * Host-side drop resolution and is called synchronously from host.ts.
 *
 * Relies entirely on the KEY INVARIANT documented on `Group` in ../types.ts:
 * a Piece's world position is always `piece.solved + group.offset`, so two
 * Groups may merge iff they hold orthogonally-adjacent Pieces AND their
 * offsets agree within tolerance — no per-Piece maths needed anywhere here.
 */

import type { GameState, Grid, GroupId, Piece, Puzzle } from "../types";
import { SNAP_TOLERANCE } from "../config";
import { groupOfPiece, mergeGroups } from "./state";

function tolerancePx(grid: Grid): number {
  return SNAP_TOLERANCE * Math.min(grid.cellW, grid.cellH);
}

function magnitude(p: { readonly x: number; readonly y: number }): number {
  return Math.hypot(p.x, p.y);
}

const ORTHOGONAL_STEPS: readonly (readonly [number, number])[] = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/**
 * Which other Groups the given Group should merge with right now.
 *
 * A candidate qualifies iff:
 *  - it holds a Piece orthogonally adjacent (grid neighbour) to a Piece in
 *    `groupId`'s Group, AND
 *  - the two Groups' offsets differ by less than
 *    `SNAP_TOLERANCE * min(cellW, cellH)`.
 *
 * CRITICAL RULE: a Group currently HELD by any player is never a merge
 * target — skip it. The connection is picked up later when the holder drops
 * (see CONTEXT.md "Merge"). This is what stops Pieces teleporting into
 * another player's hand mid-drag.
 */
export function findMerges(state: GameState, puzzle: Puzzle, groupId: GroupId): GroupId[] {
  const group = state.groups[groupId];
  if (!group) return [];

  const tolerance = tolerancePx(puzzle.grid);
  const byId = new Map<number, Piece>(puzzle.pieces.map((p) => [p.id, p]));
  const byPos = new Map<string, Piece>(puzzle.pieces.map((p) => [`${p.row},${p.col}`, p]));

  const found: GroupId[] = [];
  const seen = new Set<GroupId>([groupId]);

  for (const pieceId of group.pieceIds) {
    const piece = byId.get(pieceId);
    if (!piece) continue;

    for (const [dr, dc] of ORTHOGONAL_STEPS) {
      const neighbor = byPos.get(`${piece.row + dr},${piece.col + dc}`);
      if (!neighbor) continue;

      const neighborGroupId = groupOfPiece(state, neighbor.id);
      if (neighborGroupId === undefined || seen.has(neighborGroupId)) continue;

      // A held Group is never a merge target.
      if (state.heldBy[neighborGroupId] !== undefined) {
        seen.add(neighborGroupId);
        continue;
      }

      const neighborGroup = state.groups[neighborGroupId];
      if (!neighborGroup) continue;

      const dx = neighborGroup.offset.x - group.offset.x;
      const dy = neighborGroup.offset.y - group.offset.y;
      if (magnitude({ x: dx, y: dy }) < tolerance) {
        found.push(neighborGroupId);
      }
      seen.add(neighborGroupId);
    }
  }

  return found;
}

/**
 * If a Group's offset is within tolerance of (0, 0), sets it EXACTLY to
 * (0, 0) — "Lattice snap". A no-op otherwise, or if the Group doesn't exist.
 */
export function snapToLattice(state: GameState, groupId: GroupId, grid: Grid): GameState {
  const group = state.groups[groupId];
  if (!group) return state;
  if (magnitude(group.offset) >= tolerancePx(grid)) return state;

  const groups = { ...state.groups, [groupId]: { ...group, offset: { x: 0, y: 0 } } };
  return { ...state, groups };
}

export type DropResolution = {
  readonly state: GameState;
  /** GroupIds that were absorbed (and therefore no longer exist) this call. */
  readonly merged: GroupId[];
  /** True if the dropped Group's offset was within Lattice tolerance. */
  readonly snapped: boolean;
};

/**
 * The whole Host-side drop resolution, atomic within this one call:
 *   1. Lattice-snap check on the dropped Group.
 *   2. Find and absorb merges (smaller Group absorbed into larger; the
 *      larger keeps its id and offset — see mergeGroups).
 *   3. Chain-recheck ONCE more, so a drop that bridges two previously
 *      unrelated Groups (only adjacent to each other through the piece that
 *      was just merged in, not through the originally-dropped Group) joins
 *      all three in one resolveDrop call.
 *
 * Precondition: the caller (host.ts) has already released the drop-time grab
 * lock on `groupId` before calling this — findMerges only guards against
 * OTHER Groups being held, not the dropped Group itself.
 */
export function resolveDrop(state: GameState, puzzle: Puzzle, groupId: GroupId): DropResolution {
  const group = state.groups[groupId];
  if (!group) return { state, merged: [], snapped: false };

  const snapped = magnitude(group.offset) < tolerancePx(puzzle.grid);
  let s = snapped ? snapToLattice(state, groupId, puzzle.grid) : state;

  const merged: GroupId[] = [];
  let currentId = groupId;

  const mergePass = (): void => {
    const candidates = findMerges(s, puzzle, currentId);
    for (const candidateId of candidates) {
      const a = s.groups[currentId];
      const b = s.groups[candidateId];
      if (!a || !b) continue;
      if (s.heldBy[candidateId] !== undefined) continue;

      const [intoId, fromId] =
        a.pieceIds.length >= b.pieceIds.length ? [currentId, candidateId] : [candidateId, currentId];

      s = mergeGroups(s, intoId, fromId);
      merged.push(fromId);
      currentId = intoId;
    }
  };

  mergePass(); // initial merges against the dropped Group's own neighbours
  mergePass(); // chain-recheck once, using the (possibly now larger) merged Group

  return { state: s, merged, snapped };
}
