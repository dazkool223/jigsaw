/**
 * The real cut lines, drawn as a transparent canvas over a photo.
 *
 * These are the REAL cut lines, not an illustration of a grid: the outlines
 * come from the same `Puzzle` the board is built from, so every jittered
 * vertex and every tab and blank is exactly the one the player gets. A
 * decorative lattice would promise a different puzzle than the one that gets
 * cut, and "~500" alone doesn't tell you how fine the pieces actually are.
 *
 * Two callers, one job:
 *  - HomeScreen, over the box art in the lid's well, before the Room exists.
 *    (The seed must therefore be chosen up front and reused at create time;
 *    HomeScreen owns it for that reason.)
 *  - BoxArt, over the propped-up lid beside the board, during play.
 *
 * It takes a built `Puzzle` rather than build params so neither caller pays
 * for a second `buildPuzzle` of geometry it already has.
 *
 * Purely presentational and entirely off the gameplay path.
 */

import { useEffect, useRef } from "react";
import type { Puzzle } from "../types";
import { outlineToPath2D } from "../puzzle/textures";

/**
 * Below this on-screen Cell size the cut stops being information and becomes
 * a mesh laid over the photo - 500 pieces in a 200px thumbnail is 8px cells,
 * which reads as hatching, not as a puzzle. Drawing nothing is the honest
 * result: the picture still shows, and the same preview enlarged draws the
 * cut again the moment the Cells are big enough to tell apart.
 */
const MIN_CELL_PX = 14;

export type PuzzlePreviewProps = {
  readonly puzzle: Puzzle;
  /** Positioning class; the canvas must overlay the photo's own box exactly. */
  readonly className?: string;
};

export function PuzzlePreview({ puzzle, className }: PuzzlePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const { imageW, imageH } = puzzle.grid;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW === 0 || cssH === 0) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // The <img> under this canvas uses object-fit: contain, so the picture
      // may be letter/pillarboxed inside its box. Match that rect exactly or
      // the cut lines drift off the photo.
      const scale = Math.min(cssW / imageW, cssH / imageH);
      const drawW = imageW * scale;
      const drawH = imageH * scale;

      const cellPx = drawW / puzzle.grid.cols;
      if (cellPx < MIN_CELL_PX) return;

      ctx.translate((cssW - drawW) / 2, (cssH - drawH) / 2);
      ctx.scale(scale, scale);

      // Two passes so the cut reads on both bright sky and dark shadow: a
      // soft dark line, then a finer light one on top of it.
      //
      // Weight tracks Cell size rather than being a fixed pixel width. A
      // constant stroke is right at 24 pieces but turns a 500-piece preview
      // into a cage of lines with the photo barely visible behind it.
      const darkWidth = Math.min(1.9, Math.max(0.5, cellPx * 0.045));

      const paths = puzzle.pieces.map(outlineToPath2D);
      ctx.lineJoin = "round";

      ctx.strokeStyle = "rgba(0, 0, 0, 0.3)";
      ctx.lineWidth = darkWidth / scale;
      for (const path of paths) ctx.stroke(path);

      ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
      ctx.lineWidth = (darkWidth * 0.5) / scale;
      for (const path of paths) ctx.stroke(path);
    };

    draw();

    // Both hosts are fluid (the well changes aspect with the photo; the
    // enlarged lid tracks the viewport), so redraw on resize.
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [puzzle, imageW, imageH]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
