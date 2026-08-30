import { describe, expect, it } from "vitest";
import type { Edge, Grid, Point } from "../types";
import { generateEdges, reverseEdge } from "./edges";

function makeGrid(rows: number, cols: number, imageW = 800, imageH = 600): Grid {
  return { rows, cols, cellW: imageW / cols, cellH: imageH / rows, imageW, imageH };
}

/** Cross product magnitude of (to-from) x (p-from) - 0 iff p is collinear with from->to. */
function collinearity(from: Point, to: Point, p: Point): number {
  return (to.x - from.x) * (p.y - from.y) - (to.y - from.y) * (p.x - from.x);
}

function allPoints(e: Edge): Point[] {
  const pts: Point[] = [e.from];
  for (const seg of e.segments) {
    pts.push(seg.c1, seg.c2, seg.to);
  }
  return pts;
}

describe("generateEdges", () => {
  it("is deterministic for the same seed", () => {
    const grid = makeGrid(6, 5);
    const a = generateEdges(grid, 123);
    const b = generateEdges(grid, 123);
    for (let r = 0; r <= grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        expect(a.horizontal(r, c)).toEqual(b.horizontal(r, c));
      }
    }
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c <= grid.cols; c++) {
        expect(a.vertical(r, c)).toEqual(b.vertical(r, c));
      }
    }
  });

  it("gives different geometry for a different seed", () => {
    const grid = makeGrid(6, 5);
    const a = generateEdges(grid, 1);
    const b = generateEdges(grid, 2);
    // At least one interior horizontal edge should differ.
    let sawDifference = false;
    for (let r = 1; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        if (JSON.stringify(a.horizontal(r, c)) !== JSON.stringify(b.horizontal(r, c))) {
          sawDifference = true;
        }
      }
    }
    expect(sawDifference).toBe(true);
  });

  it("access order does not change the result (no order-coupling)", () => {
    const grid = makeGrid(6, 5);
    const fresh = generateEdges(grid, 55);
    const straightAnswer = fresh.horizontal(2, 2);

    const other = generateEdges(grid, 55);
    // Touch a bunch of unrelated edges first, in a scrambled order.
    other.vertical(3, 3);
    other.horizontal(0, 0);
    other.vertical(0, 4);
    other.horizontal(5, 1);
    expect(other.horizontal(2, 2)).toEqual(straightAnswer);
  });

  it("boundary edges are a single straight (collinear) segment", () => {
    const grid = makeGrid(6, 5);
    const edges = generateEdges(grid, 7);
    const boundaryEdges: Edge[] = [];
    for (let c = 0; c < grid.cols; c++) {
      boundaryEdges.push(edges.horizontal(0, c), edges.horizontal(grid.rows, c));
    }
    for (let r = 0; r < grid.rows; r++) {
      boundaryEdges.push(edges.vertical(r, 0), edges.vertical(r, grid.cols));
    }
    for (const edge of boundaryEdges) {
      expect(edge.segments.length).toBe(1);
      const seg = edge.segments[0];
      expect(collinearity(edge.from, edge.to, seg.c1)).toBeCloseTo(0, 6);
      expect(collinearity(edge.from, edge.to, seg.c2)).toBeCloseTo(0, 6);
      expect(seg.to).toEqual(edge.to);
    }
  });

  it("interior edges have a multi-segment Tab curve (not a single straight bump)", () => {
    const grid = makeGrid(6, 5);
    const edges = generateEdges(grid, 7);
    // interior horizontal: r in 1..rows-1
    for (let r = 1; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const edge = edges.horizontal(r, c);
        expect(edge.segments.length).toBeGreaterThanOrEqual(4);
        // At least one control point must be off the straight line -> real curve, not a
        // disguised straight line.
        const from = edge.from;
        const to = edge.to;
        const offLine = allPoints(edge).some((p) => Math.abs(collinearity(from, to, p)) > 1e-6);
        expect(offLine).toBe(true);
      }
    }
    // interior vertical: c in 1..cols-1
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 1; c < grid.cols; c++) {
        const edge = edges.vertical(r, c);
        expect(edge.segments.length).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("boundary vertices are not jittered: the border stays a clean rectangle", () => {
    const grid = makeGrid(6, 5);
    const edges = generateEdges(grid, 999);
    // top border corner-to-corner points should all sit exactly on y=0
    for (let c = 0; c < grid.cols; c++) {
      const e = edges.horizontal(0, c);
      expect(e.from.y).toBe(0);
      expect(e.to.y).toBe(0);
    }
    // left border points should all sit exactly on x=0
    for (let r = 0; r < grid.rows; r++) {
      const e = edges.vertical(r, 0);
      expect(e.from.x).toBe(0);
      expect(e.to.x).toBe(0);
    }
    // bottom / right borders sit exactly on the image edges
    for (let c = 0; c < grid.cols; c++) {
      const e = edges.horizontal(grid.rows, c);
      expect(e.from.y).toBe(grid.imageH);
      expect(e.to.y).toBe(grid.imageH);
    }
    for (let r = 0; r < grid.rows; r++) {
      const e = edges.vertical(r, grid.cols);
      expect(e.from.x).toBe(grid.imageW);
      expect(e.to.x).toBe(grid.imageW);
    }
  });
});

describe("reverseEdge", () => {
  const grid = makeGrid(6, 5);
  const edges = generateEdges(grid, 321);

  it("swaps from and to", () => {
    const e = edges.horizontal(2, 2);
    const r = reverseEdge(e);
    expect(r.from).toEqual(e.to);
    expect(r.to).toEqual(e.from);
  });

  it("is an involution: reverseEdge(reverseEdge(e)) deep-equals e", () => {
    const e = edges.horizontal(2, 2);
    expect(reverseEdge(reverseEdge(e))).toEqual(e);

    const straight = edges.horizontal(0, 0);
    expect(reverseEdge(reverseEdge(straight))).toEqual(straight);
  });

  it("preserves the same set of curve points, traversed backwards", () => {
    const e = edges.vertical(3, 3);
    const forwardPoints = allPoints(e);
    const reversed = reverseEdge(e);
    const reversedPoints = allPoints(reversed);
    // Same multiset of points (control points paired per-segment, order reversed).
    expect(reversedPoints.slice().sort((a, b) => a.x - b.x || a.y - b.y)).toEqual(
      forwardPoints.slice().sort((a, b) => a.x - b.x || a.y - b.y),
    );
  });

  it("keeps the chain closed: consecutive segment endpoints still connect", () => {
    const e = edges.horizontal(3, 2);
    const reversed = reverseEdge(e);
    let cursor = reversed.from;
    for (const seg of reversed.segments) {
      // cursor is implicit; just check the final point equals `to`.
      cursor = seg.to;
    }
    expect(cursor).toEqual(reversed.to);
  });
});
