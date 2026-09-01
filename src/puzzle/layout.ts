/**
 * Grid fitting and initial scatter. Pure functions, no PRNG state escapes
 * this module - a fresh Room needs zero position sync because every peer
 * derives the same scatter from the same seed.
 */

import type { Grid, Point, Rect } from "../types";
import { SCATTER_MARGIN } from "../config";
import { keyedRandom } from "./rng";

/**
 * Fit a rows x cols grid to an image so Cells stay roughly (not exactly)
 * square, targeting `targetPieces` total. The actual piece count (rows*cols)
 * will differ from the target - that is expected: "500" on a 4:3 image
 * yields 26x19 = 494.
 */
export function fitGrid(imageW: number, imageH: number, targetPieces: number): Grid {
  const cols = Math.max(2, Math.round(Math.sqrt((targetPieces * imageW) / imageH)));
  const rows = Math.max(2, Math.round(targetPieces / cols));
  return {
    rows,
    cols,
    cellW: imageW / cols,
    cellH: imageH / rows,
    imageW,
    imageH,
  };
}

/**
 * The playable area: the image rect expanded on every side by
 * `marginFraction` (a fraction of image size). This is the one definition of
 * "where pieces live" - `scatterOffsets` below spreads the initial pile
 * across exactly this rect, and `render/board.ts` clamps dragging and
 * panning to it, so a piece can never end up somewhere the scatter itself
 * would never have put it.
 */
export function playAreaBounds(grid: Grid, marginFraction: number = SCATTER_MARGIN): Rect {
  const marginX = grid.imageW * marginFraction;
  const marginY = grid.imageH * marginFraction;
  return {
    x: -marginX,
    y: -marginY,
    w: grid.imageW + marginX * 2,
    h: grid.imageH + marginY * 2,
  };
}

/**
 * Deterministic initial scatter, one offset per Piece in row-major order
 * (id = row*cols+col - the same ordering `geometry.ts#buildPuzzle` assigns
 * Piece ids in), so `scatterOffsets(grid, seed)[piece.id]` is a Group
 * `offset` ready to apply directly: `piece.solved + offset` places the Piece
 * scattered instead of solved.
 *
 * Pieces are spread uniformly over `playAreaBounds(grid)`, independent of
 * solved position, so the scatter looks like a random pile rather than a
 * jittered grid.
 */
export function scatterOffsets(grid: Grid, seed: number): Point[] {
  const { rows, cols, cellW, cellH } = grid;
  const bounds = playAreaBounds(grid);
  const minX = bounds.x;
  const maxX = bounds.x + bounds.w;
  const minY = bounds.y;
  const maxY = bounds.y + bounds.h;

  const offsets: Point[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const rand = keyedRandom(seed, `scatter:${row}:${col}`);
      const targetX = minX + rand() * (maxX - minX);
      const targetY = minY + rand() * (maxY - minY);
      const solvedX = col * cellW;
      const solvedY = row * cellH;
      offsets.push({ x: targetX - solvedX, y: targetY - solvedY });
    }
  }
  return offsets;
}
