/**
 * Grid fitting and initial scatter. Pure functions, no PRNG state escapes
 * this module — a fresh Room needs zero position sync because every peer
 * derives the same scatter from the same seed.
 */

import type { Grid, Point } from "../types";
import { SCATTER_MARGIN } from "../config";
import { keyedRandom } from "./rng";

/**
 * Fit a rows x cols grid to an image so Cells stay roughly (not exactly)
 * square, targeting `targetPieces` total. The actual piece count (rows*cols)
 * will differ from the target — that is expected: "500" on a 4:3 image
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
 * Deterministic initial scatter, one offset per Piece in row-major order
 * (id = row*cols+col — the same ordering `geometry.ts#buildPuzzle` assigns
 * Piece ids in), so `scatterOffsets(grid, seed)[piece.id]` is a Group
 * `offset` ready to apply directly: `piece.solved + offset` places the Piece
 * scattered instead of solved.
 *
 * Pieces are spread uniformly over the image area expanded on every side by
 * SCATTER_MARGIN (a fraction of image size), independent of solved position,
 * so the scatter looks like a random pile rather than a jittered grid.
 */
export function scatterOffsets(grid: Grid, seed: number): Point[] {
  const { rows, cols, cellW, cellH, imageW, imageH } = grid;
  const marginX = imageW * SCATTER_MARGIN;
  const marginY = imageH * SCATTER_MARGIN;
  const minX = -marginX;
  const maxX = imageW + marginX;
  const minY = -marginY;
  const maxY = imageH + marginY;

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
