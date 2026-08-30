/**
 * Shared Edge generation - THE interlock invariant lives here.
 *
 * A lattice of vertices V(r,c), r in [0,rows], c in [0,cols], is built first.
 * Interior vertices are jittered for the "hand-cut" look; boundary vertices
 * are not, so the outer border stays a clean rectangle.
 *
 * Then every cut line is generated EXACTLY ONCE:
 *   - horizontal h(r,c), r in [0,rows], c in [0,cols-1]: V(r,c) -> V(r,c+1)
 *   - vertical   v(r,c), r in [0,rows-1], c in [0,cols]: V(r,c) -> V(r+1,c)
 *
 * geometry.ts assembles each Piece's outline from four references into this
 * shared set - it never generates its own curves. Two neighbouring Pieces
 * therefore always reference the identical curve, one of them via
 * `reverseEdge`, which is what makes them interlock instead of merely abut.
 */

import type { BezierSegment, Edge, Grid, Point } from "../types";
import {
  TAB_BULB_RATIO,
  TAB_NECK_RATIO,
  TAB_POSITION_JITTER,
  TAB_SIZE_JITTER,
  TAB_SIZE_RATIO,
  VERTEX_JITTER,
} from "../config";
import { keyedRandom, signedUnit } from "./rng";

export type EdgeSet = {
  readonly rows: number;
  readonly cols: number;
  horizontal(r: number, c: number): Edge;
  vertical(r: number, c: number): Edge;
};

// ─────────────────────────────────────────────────────────────────────────────
// Vertex lattice
// ─────────────────────────────────────────────────────────────────────────────

/** verts[r][c] = V(r,c), r in [0,rows], c in [0,cols]. */
function buildVertices(grid: Grid, seed: number): Point[][] {
  const { rows, cols, cellW, cellH } = grid;
  const jitterMax = VERTEX_JITTER * Math.min(cellW, cellH);
  const verts: Point[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: Point[] = [];
    for (let c = 0; c <= cols; c++) {
      const nominalX = c * cellW;
      const nominalY = r * cellH;
      const isBoundary = r === 0 || r === rows || c === 0 || c === cols;
      if (isBoundary) {
        row.push({ x: nominalX, y: nominalY });
      } else {
        const rand = keyedRandom(seed, `vertex:${r}:${c}`);
        const dx = signedUnit(rand()) * jitterMax;
        const dy = signedUnit(rand()) * jitterMax;
        row.push({ x: nominalX + dx, y: nominalY + dy });
      }
    }
    verts.push(row);
  }
  return verts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Straight (boundary) edges
// ─────────────────────────────────────────────────────────────────────────────

/** A single straight segment - collinear control points, no Tab. */
function straightEdge(from: Point, to: Point): Edge {
  const c1: Point = { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 };
  const c2: Point = { x: from.x + (to.x - from.x) * (2 / 3), y: from.y + (to.y - from.y) * (2 / 3) };
  return { from, to, segments: [{ c1, c2, to }] };
}

// ─────────────────────────────────────────────────────────────────────────────
// Interior (tabbed) edges
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a Tab curve between `from` and `to`, in the edge's own frame (unit
 * vector along the edge, and its perpendicular for Tab height) so it works at
 * any edge angle - jittered vertices mean interior edges are rarely axis
 * aligned.
 *
 * Local coordinates: u along the edge (0 at `from`, L at `to`), v
 * perpendicular (0 on the edge line, positive in the Tab's protrusion
 * direction). Five cubic beziers:
 *   shoulder -> neck-in (pull toward the narrow neck) -> bulb cap (wide) ->
 *   neck-out -> shoulder.
 * The neck-in/out segments pull their control points toward the neck's
 * (narrower) x-position while sweeping to the bulb's (wider) endpoint - the
 * u-coordinate briefly reverses direction as v approaches its max, which is
 * what makes the bulb overhang the neck instead of just being a bump.
 */
function tabbedEdge(from: Point, to: Point, minCellDim: number, rand: () => number): Edge {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const L = Math.sqrt(dx * dx + dy * dy);
  const ex: Point = { x: dx / L, y: dy / L };
  // Perpendicular (rotate ex 90 deg CCW in image space). Convention only
  // matters for internal consistency, which local(u,v)->world always is.
  const ey: Point = { x: -ex.y, y: ex.x };

  const dir = rand() < 0.5 ? -1 : 1; // which side the bulb protrudes; unconstrained
  const posJitter = signedUnit(rand()) * TAB_POSITION_JITTER;
  const sizeJitter = 1 + signedUnit(rand()) * TAB_SIZE_JITTER;

  const cx = (0.5 + posJitter) * L;
  const h = TAB_SIZE_RATIO * sizeJitter * minCellDim;
  const hv = h * dir;

  const nH = (TAB_NECK_RATIO * L) / 2; // neck half-width
  const bH = (TAB_BULB_RATIO * L) / 2; // bulb half-width (> nH: the interlock)
  const curveHalfWidth = bH * 1.25; // shoulder margin around the bulb

  const xNeckL = cx - nH;
  const xNeckR = cx + nH;
  const xBulbL = cx - bH;
  const xBulbR = cx + bH;
  const xS0 = cx - curveHalfWidth;
  const xS1 = cx + curveHalfWidth;

  const toWorld = (u: number, v: number): Point => ({
    x: from.x + u * ex.x + v * ey.x,
    y: from.y + u * ex.y + v * ey.y,
  });

  const p0 = from;
  const p1 = toWorld(xS0, 0);
  const p2 = toWorld(xBulbL, hv);
  const p3 = toWorld(xBulbR, hv);
  const p4 = toWorld(xS1, 0);
  const p5 = to;

  const segments: BezierSegment[] = [
    // shoulder 1: flat run from the corner to where the neck curve begins
    { c1: toWorld(xS0 / 3, 0), c2: toWorld((xS0 * 2) / 3, 0), to: p1 },
    // neck-in: pulled toward the narrow neck x, then swept out to the bulb
    { c1: toWorld(xNeckL, 0), c2: toWorld(xNeckL, hv), to: p2 },
    // bulb cap: bows slightly past hv for a rounded (not flat) top
    { c1: toWorld(cx - bH * 0.55, hv * 1.05), c2: toWorld(cx + bH * 0.55, hv * 1.05), to: p3 },
    // neck-out: mirror of neck-in
    { c1: toWorld(xNeckR, hv), c2: toWorld(xNeckR, 0), to: p4 },
    // shoulder 2: flat run to the far corner
    {
      c1: toWorld(xS1 + ((L - xS1) * 1) / 3, 0),
      c2: toWorld(xS1 + ((L - xS1) * 2) / 3, 0),
      to: p5,
    },
  ];

  return { from: p0, to: p5, segments };
}

// ─────────────────────────────────────────────────────────────────────────────
// reverseEdge - same curve, traversed backwards. This is what lets two
// Pieces share one generated curve and still each draw it head-to-tail.
// ─────────────────────────────────────────────────────────────────────────────

export function reverseEdge(e: Edge): Edge {
  const points: Point[] = [e.from, ...e.segments.map((s) => s.to)];
  const n = e.segments.length;
  const segments: BezierSegment[] = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    const seg = e.segments[i];
    segments[n - 1 - i] = { c1: seg.c2, c2: seg.c1, to: points[i] };
  }
  return { from: e.to, to: e.from, segments };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────────────────────

export function generateEdges(grid: Grid, seed: number): EdgeSet {
  const { rows, cols, cellW, cellH } = grid;
  const minCellDim = Math.min(cellW, cellH);
  const verts = buildVertices(grid, seed);

  const horizontal: Edge[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: Edge[] = [];
    for (let c = 0; c < cols; c++) {
      const from = verts[r][c];
      const to = verts[r][c + 1];
      const isBoundary = r === 0 || r === rows;
      row.push(
        isBoundary
          ? straightEdge(from, to)
          : tabbedEdge(from, to, minCellDim, keyedRandom(seed, `edge:h:${r}:${c}`)),
      );
    }
    horizontal.push(row);
  }

  const vertical: Edge[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Edge[] = [];
    for (let c = 0; c <= cols; c++) {
      const from = verts[r][c];
      const to = verts[r + 1][c];
      const isBoundary = c === 0 || c === cols;
      row.push(
        isBoundary
          ? straightEdge(from, to)
          : tabbedEdge(from, to, minCellDim, keyedRandom(seed, `edge:v:${r}:${c}`)),
      );
    }
    vertical.push(row);
  }

  return {
    rows,
    cols,
    horizontal(r: number, c: number): Edge {
      return horizontal[r][c];
    },
    vertical(r: number, c: number): Edge {
      return vertical[r][c];
    },
  };
}
