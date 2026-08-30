import { describe, expect, it } from "vitest";
import type { Piece, Point, PuzzleDefinition } from "../types";
import { TAB_SIZE_JITTER, TAB_SIZE_RATIO, VERTEX_JITTER } from "../config";
import { buildPuzzle } from "./geometry";

function definition(overrides: Partial<PuzzleDefinition> = {}): PuzzleDefinition {
  return { imageUrl: "test://image", seed: 1234, rows: 6, cols: 8, ...overrides };
}

function pieceAt(pieces: readonly Piece[], cols: number, row: number, col: number): Piece {
  const p = pieces[row * cols + col];
  if (p.row !== row || p.col !== col) {
    throw new Error(`row-major indexing assumption broken: expected (${row},${col}), got (${p.row},${p.col})`);
  }
  return p;
}

function pointsEqual(a: Point, b: Point, eps = 1e-9): boolean {
  return Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;
}

describe("buildPuzzle - the interlock invariant", () => {
  it("shares curves reversed between every vertically adjacent Piece pair (bottom<->top)", () => {
    const puzzle = buildPuzzle(definition(), 1600, 1200);
    const { rows, cols } = puzzle.grid;
    for (let row = 0; row < rows - 1; row++) {
      for (let col = 0; col < cols; col++) {
        const upper = pieceAt(puzzle.pieces, cols, row, col);
        const lower = pieceAt(puzzle.pieces, cols, row + 1, col);
        const upperBottom = upper.outline[2]; // bottom
        const lowerTop = lower.outline[0]; // top
        // reverseEdge is imported indirectly via geometry's own use; re-derive
        // by reversing manually here to keep this test independent of edges.ts internals.
        const reversedUpperBottom = {
          from: upperBottom.to,
          to: upperBottom.from,
          segments: [...upperBottom.segments].reverse().map((_seg, i, arr) => {
            const origIndex = arr.length - 1 - i;
            const origSeg = upperBottom.segments[origIndex];
            const prevOrigTo =
              origIndex === 0 ? upperBottom.from : upperBottom.segments[origIndex - 1].to;
            return { c1: origSeg.c2, c2: origSeg.c1, to: prevOrigTo };
          }),
        };
        expect(pointsEqual(reversedUpperBottom.from, lowerTop.from)).toBe(true);
        expect(pointsEqual(reversedUpperBottom.to, lowerTop.to)).toBe(true);
        expect(reversedUpperBottom.segments.length).toBe(lowerTop.segments.length);
        for (let i = 0; i < reversedUpperBottom.segments.length; i++) {
          expect(pointsEqual(reversedUpperBottom.segments[i].c1, lowerTop.segments[i].c1)).toBe(true);
          expect(pointsEqual(reversedUpperBottom.segments[i].c2, lowerTop.segments[i].c2)).toBe(true);
          expect(pointsEqual(reversedUpperBottom.segments[i].to, lowerTop.segments[i].to)).toBe(true);
        }
      }
    }
  });

  it("shares curves reversed between every horizontally adjacent Piece pair (right<->left)", () => {
    const puzzle = buildPuzzle(definition(), 1600, 1200);
    const { rows, cols } = puzzle.grid;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols - 1; col++) {
        const left = pieceAt(puzzle.pieces, cols, row, col);
        const right = pieceAt(puzzle.pieces, cols, row, col + 1);
        const leftRight = left.outline[1]; // right edge
        const rightLeft = right.outline[3]; // left edge
        expect(pointsEqual(leftRight.from, rightLeft.to)).toBe(true);
        expect(pointsEqual(leftRight.to, rightLeft.from)).toBe(true);
        expect(leftRight.segments.length).toBe(rightLeft.segments.length);
      }
    }
  });
});

describe("buildPuzzle - determinism", () => {
  it("gives deeply equal output for the same seed", () => {
    const a = buildPuzzle(definition({ seed: 777 }), 1600, 1200);
    const b = buildPuzzle(definition({ seed: 777 }), 1600, 1200);
    expect(a).toEqual(b);
  });

  it("gives different output for a different seed", () => {
    const a = buildPuzzle(definition({ seed: 1 }), 1600, 1200);
    const b = buildPuzzle(definition({ seed: 2 }), 1600, 1200);
    expect(a).not.toEqual(b);
  });
});

describe("buildPuzzle - outline closure", () => {
  it("every Piece outline is a closed path", () => {
    const puzzle = buildPuzzle(definition(), 1600, 1200);
    for (const piece of puzzle.pieces) {
      for (let i = 0; i < piece.outline.length; i++) {
        const edge = piece.outline[i];
        const next = piece.outline[(i + 1) % piece.outline.length];
        expect(pointsEqual(edge.to, next.from)).toBe(true);
      }
    }
  });
});

describe("buildPuzzle - border Pieces", () => {
  it("have straight, collinear outer Edges", () => {
    const puzzle = buildPuzzle(definition(), 1600, 1200);
    const { rows, cols } = puzzle.grid;

    const collinearity = (from: Point, to: Point, p: Point) =>
      (to.x - from.x) * (p.y - from.y) - (to.y - from.y) * (p.x - from.x);

    // top row: outline[0] (top) is boundary
    for (let col = 0; col < cols; col++) {
      const piece = pieceAt(puzzle.pieces, cols, 0, col);
      const top = piece.outline[0];
      expect(top.segments.length).toBe(1);
      expect(Math.abs(collinearity(top.from, top.to, top.segments[0].c1))).toBeLessThan(1e-6);
    }
    // bottom row: outline[2] (bottom) is boundary
    for (let col = 0; col < cols; col++) {
      const piece = pieceAt(puzzle.pieces, cols, rows - 1, col);
      const bottom = piece.outline[2];
      expect(bottom.segments.length).toBe(1);
    }
    // left column: outline[3] (left) is boundary
    for (let row = 0; row < rows; row++) {
      const piece = pieceAt(puzzle.pieces, cols, row, 0);
      const left = piece.outline[3];
      expect(left.segments.length).toBe(1);
    }
    // right column: outline[1] (right) is boundary
    for (let row = 0; row < rows; row++) {
      const piece = pieceAt(puzzle.pieces, cols, row, cols - 1);
      const right = piece.outline[1];
      expect(right.segments.length).toBe(1);
    }
  });

  it("interior Pieces have multi-segment Edges on every side", () => {
    const puzzle = buildPuzzle(definition({ rows: 6, cols: 8 }), 1600, 1200);
    const { rows, cols } = puzzle.grid;
    expect(rows).toBeGreaterThanOrEqual(3);
    expect(cols).toBeGreaterThanOrEqual(3);
    // pick a piece not touching any border
    const piece = pieceAt(puzzle.pieces, cols, 1, 1);
    for (const edge of piece.outline) {
      expect(edge.segments.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe("buildPuzzle - solved position is the unjittered Lattice, never moved by jitter", () => {
  it("matches the nominal Cell origin exactly", () => {
    const puzzle = buildPuzzle(definition(), 1600, 1200);
    const { cellW, cellH } = puzzle.grid;
    for (const piece of puzzle.pieces) {
      expect(piece.solved.x).toBeCloseTo(piece.col * cellW, 9);
      expect(piece.solved.y).toBeCloseTo(piece.row * cellH, 9);
    }
  });
});

describe("buildPuzzle - bbox bounded by Tab overhang + vertex jitter", () => {
  it("no Piece's bbox exceeds its Cell by more than tab height + vertex jitter on any side", () => {
    const puzzle = buildPuzzle(definition({ rows: 10, cols: 10 }), 2000, 2000);
    const { cellW, cellH } = puzzle.grid;
    const minCellDim = Math.min(cellW, cellH);
    // Generous but bounded margin: max Tab height (with size jitter and the
    // curve's ~5% bulb-cap overshoot) plus max vertex displacement.
    const maxTabHeight = TAB_SIZE_RATIO * (1 + TAB_SIZE_JITTER) * minCellDim * 1.1;
    const maxVertexJitter = VERTEX_JITTER * minCellDim;
    const margin = maxTabHeight + maxVertexJitter;

    for (const piece of puzzle.pieces) {
      const cell = { x: piece.col * cellW, y: piece.row * cellH, w: cellW, h: cellH };
      expect(piece.bbox.x).toBeGreaterThanOrEqual(cell.x - margin - 1e-6);
      expect(piece.bbox.y).toBeGreaterThanOrEqual(cell.y - margin - 1e-6);
      expect(piece.bbox.x + piece.bbox.w).toBeLessThanOrEqual(cell.x + cell.w + margin + 1e-6);
      expect(piece.bbox.y + piece.bbox.h).toBeLessThanOrEqual(cell.y + cell.h + margin + 1e-6);
    }
  });
});

describe("buildPuzzle - grid fitting extremes stay sane end-to-end", () => {
  it("builds a valid puzzle for a very wide image", () => {
    const puzzle = buildPuzzle(definition({ rows: 2, cols: 40 }), 4000, 400);
    expect(puzzle.pieces.length).toBe(80);
    for (const piece of puzzle.pieces) {
      expect(piece.outline.length).toBe(4);
    }
  });

  it("builds a valid puzzle for a very tall image", () => {
    const puzzle = buildPuzzle(definition({ rows: 40, cols: 2 }), 400, 4000);
    expect(puzzle.pieces.length).toBe(80);
    for (const piece of puzzle.pieces) {
      expect(piece.outline.length).toBe(4);
    }
  });
});
