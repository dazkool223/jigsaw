/**
 * Shown when a Room has no Host online (CONTEXT.md "Host", ADR-0001).
 * Claiming Host is a DELIBERATE act — this screen must never auto-claim, so
 * that link-preview bots and background tabs can't silently steal the role.
 * The only way forward is the explicit "Resume puzzle" button.
 */

import type { CSSProperties } from "react";

export type ResumeHostScreenProps = {
  readonly onResume: () => void;
  readonly claiming: boolean;
  readonly error?: string;
};

export function ResumeHostScreen({ onResume, claiming, error }: ResumeHostScreenProps) {
  return (
    <div style={styles.backdrop}>
      <div style={styles.card}>
        <h2 style={styles.title}>Host disconnected — progress is saved</h2>
        <p style={styles.body}>
          Nobody is currently hosting this puzzle. Your pieces are safe; resume whenever you're
          ready to keep playing.
        </p>
        {error && <p style={styles.error}>{error}</p>}
        <button type="button" style={styles.primaryButton} onClick={onResume} disabled={claiming}>
          {claiming ? "Resuming…" : "Resume puzzle"}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  backdrop: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(10, 11, 15, 0.72)",
    zIndex: 20,
  },
  card: {
    background: "#1e2129",
    border: "1px solid #3a3f4b",
    borderRadius: 12,
    padding: "28px 32px",
    maxWidth: 400,
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 12,
  },
  title: {
    margin: 0,
    fontSize: 18,
  },
  body: {
    margin: 0,
    color: "#c3c7d1",
    fontSize: 14,
  },
  error: {
    margin: 0,
    color: "#f58231",
    fontSize: 13,
  },
  primaryButton: {
    padding: "10px 22px",
    borderRadius: 6,
    border: "1px solid #4363d8",
    background: "#4363d8",
    color: "#fff",
    fontWeight: 600,
    fontSize: 14,
  },
};
