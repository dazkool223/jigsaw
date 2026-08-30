/**
 * Completion (CONTEXT.md "Completion"): confetti, elapsed time, piece count,
 * and the share link so players can show off the finished puzzle. Confetti
 * fires once per mount via canvas-confetti (already a dependency — no new
 * package added).
 */

import { useEffect, type CSSProperties } from "react";
import confetti from "canvas-confetti";
import { ShareLink } from "./ShareLink";

export type WinDialogProps = {
  readonly pieceCount: number;
  readonly elapsedMs: number;
  readonly shareUrl: string;
};

export function WinDialog({ pieceCount, elapsedMs, shareUrl }: WinDialogProps) {
  useEffect(() => {
    const duration = 2200;
    const end = Date.now() + duration;

    const frame = () => {
      void confetti({
        particleCount: 4,
        angle: 60,
        spread: 60,
        origin: { x: 0, y: 0.8 },
      });
      void confetti({
        particleCount: 4,
        angle: 120,
        spread: 60,
        origin: { x: 1, y: 0.8 },
      });
      if (Date.now() < end) {
        requestAnimationFrame(frame);
      }
    };
    frame();
  }, []);

  return (
    <div style={styles.backdrop}>
      <div style={styles.card}>
        <h2 style={styles.title}>Puzzle complete!</h2>
        <p style={styles.stat}>
          {pieceCount} pieces &middot; {formatElapsed(elapsedMs)}
        </p>
        <div style={styles.shareRow}>
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

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(10, 11, 15, 0.72)",
    zIndex: 30,
  },
  card: {
    background: "#1e2129",
    border: "1px solid #3a3f4b",
    borderRadius: 12,
    padding: "32px 36px",
    maxWidth: 420,
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 14,
  },
  title: {
    margin: 0,
    fontSize: 22,
  },
  stat: {
    margin: 0,
    color: "#c3c7d1",
    fontSize: 14,
  },
  shareRow: {
    width: "100%",
    marginTop: 4,
  },
};
