/**
 * Assembles Pieces from the shared Edge set. This is the only place Piece
 * outlines are put together - always from four Edge *references* (never
 * freshly generated), oriented head-to-tail clockwise, which is what keeps
 * neighbouring Pieces sharing identical curves (see edges.ts).
 */

import type { Edge, Grid, Piece, Point, Puzzle, PuzzleDefinition, Rect } from "../types";
import { generateEdges, reverseEdge } from "./edges";

function buildGrid(definition: PuzzleDefinition, imageW: number, imageH: number): Grid {
  return {
    rows: definition.rows,
    cols: definition.cols,
    cellW: imageW / definition.cols,
    cellH: imageH / definition.rows,
    imageW,
    imageH,
  };
}

/** Tight bounding box over every outline point: segment endpoints and control
 * points. Control points can lie outside the hull of the endpoints (that's
 * exactly how the bulb overhang is built), so including them keeps this box
 * a safe, conservative bound on where the Piece actually paints. */
function outlineBBox(outline: readonly Edge[]): Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (p: Point) => {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  };
  for (const edge of outline) {
    consider(edge.from);
    for (const seg of edge.segments) {
      consider(seg.c1);
      consider(seg.c2);
      consider(seg.to);
    }
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function buildPuzzle(definition: PuzzleDefinition, imageW: number, imageH: number): Puzzle {
  const grid = buildGrid(definition, imageW, imageH);
  const edges = generateEdges(grid, definition.seed);
  const { rows, cols, cellW, cellH } = grid;

  const pieces: Piece[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const top = edges.horizontal(row, col);
      const right = edges.vertical(row, col + 1);
      const bottom = reverseEdge(edges.horizontal(row + 1, col));
      const left = reverseEdge(edges.vertical(row, col));
      const outline: readonly Edge[] = [top, right, bottom, left];

      pieces.push({
        id: row * cols + col,
        row,
        col,
        // Nominal (unjittered) Cell origin - the Lattice position. Vertex
        // jitter must never move this.
        solved: { x: col * cellW, y: row * cellH },
        outline,
        bbox: outlineBBox(outline),
      });
    }
  }

  return { definition, grid, pieces };
}
