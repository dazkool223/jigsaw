/**
 * Completion (CONTEXT.md "Completion"): confetti, elapsed time, piece count,
 * and the share link so players can show off the finished puzzle. Confetti
 * fires once per mount via canvas-confetti (already a dependency — no new
 * package added), and is skipped for players who ask for reduced motion.
 *
 * The stats read as the spec printed on the back of a finished box.
 */

import { useEffect } from "react";
import confetti from "canvas-confetti";
import { ShareLink } from "./ShareLink";

export type WinDialogProps = {
  readonly pieceCount: number;
  readonly elapsedMs: number;
  readonly shareUrl: string;
};

export function WinDialog({ pieceCount, elapsedMs, shareUrl }: WinDialogProps) {
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const end = Date.now() + 2200;
    let raf = 0;
    // Chipboard, flag orange and gold rather than the library's default
    // rainbow — the celebration should look like it belongs to this table.
    const colors = ["#ded2bb", "#ece2d0", "#d6552f", "#e0a13b", "#8fbfa6"];
    const frame = () => {
      void confetti({ particleCount: 4, angle: 60, spread: 60, origin: { x: 0, y: 0.8 }, colors });
      void confetti({ particleCount: 4, angle: 120, spread: 60, origin: { x: 1, y: 0.8 }, colors });
      if (Date.now() < end) raf = requestAnimationFrame(frame);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="overlay overlay--win">
      <div className="card">
        <div className="card__body">
          <h2 className="card__title">Solved</h2>
          <p className="card__text">Every piece is home. Nicely done.</p>

          <div className="stats">
            <div className="stat">
              <div className="stat__value">{pieceCount}</div>
              <div className="stat__label">Pieces</div>
            </div>
            <div className="stat">
              <div className="stat__value">{formatElapsed(elapsedMs)}</div>
              <div className="stat__label">Time</div>
            </div>
          </div>
        </div>
        <div className="card__tray">
          <ShareLink url={shareUrl} />
        </div>
      </div>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
