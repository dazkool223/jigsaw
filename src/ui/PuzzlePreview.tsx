/**
 * Live preview of the cut, drawn over the box art in the home screen's well.
 *
 * These are the REAL cut lines, not an illustration of a grid: the same
 * `buildPuzzle` the Room will run, on the same `(seed, rows, cols)` the Room
 * will be created with, so the jittered vertices and every tab and blank are
 * exactly the ones the player gets. That is the whole point — a decorative
 * lattice would promise a different puzzle than the one that gets cut, and
 * "~500" alone doesn't tell you how fine the pieces actually are.
 *
 * The seed therefore has to be chosen before the preview renders and reused
 * at create time; HomeScreen owns it for that reason.
 *
 * Purely presentational and entirely off the gameplay path — this canvas is
 * thrown away the moment the Room is created.
 */

import { useEffect, useMemo, useRef } from "react";
import { buildPuzzle } from "../puzzle/geometry";
import { outlineToPath2D } from "../puzzle/textures";

export type PuzzlePreviewProps = {
  readonly imageUrl: string;
  /** Natural size of the uploaded image — the space the cut lines live in. */
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly seed: number;
  readonly rows: number;
  readonly cols: number;
};

export function PuzzlePreview({
  imageUrl,
  imageWidth,
  imageHeight,
  seed,
  rows,
  cols,
}: PuzzlePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const puzzle = useMemo(
    () => buildPuzzle({ imageUrl, seed, rows, cols }, imageWidth, imageHeight),
    [imageUrl, seed, rows, cols, imageWidth, imageHeight],
  );

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
      // may be letter/pillarboxed inside the well. Match that rect exactly or
      // the cut lines drift off the photo.
      const scale = Math.min(cssW / imageWidth, cssH / imageHeight);
      const drawW = imageWidth * scale;
      const drawH = imageHeight * scale;
      ctx.translate((cssW - drawW) / 2, (cssH - drawH) / 2);
      ctx.scale(scale, scale);

      // Two passes so the cut reads on both bright sky and dark shadow: a
      // soft dark line, then a finer light one on top of it.
      //
      // Weight tracks cell size rather than being a fixed pixel width. A
      // constant stroke is right at 24 pieces but turns a 500-piece preview
      // into a cage of lines with the photo barely visible behind it.
      const cellPx = drawW / puzzle.grid.cols;
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

    // The well is fluid (and changes aspect with the photo), so redraw on resize.
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [puzzle, imageWidth, imageHeight]);

  return <canvas ref={canvasRef} className="well__cut" aria-hidden="true" />;
}
