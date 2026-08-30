/**
 * Driven by `TransportStatus` (see ../types.ts). Covers every state that
 * would otherwise leave the user staring at a silent hang:
 *
 *  - connecting: a simple, honest "Connecting..." — no fake progress bar.
 *  - failed: the transport's own message verbatim (this is the 15s
 *    STUN-only timeout from config.ts's CONNECT_TIMEOUT_MS — see peer.ts).
 *    Copy is upfront that some mobile networks can't complete a STUN-only
 *    connection, with a Retry action.
 *  - roomFull: the transport's own message verbatim, no Retry (retrying
 *    won't change the player count).
 */

import type { CSSProperties } from "react";

// Deliberately NOT `Extract<TransportStatus, {state: "connecting"|"failed"|"roomFull"}>`:
// types.ts's TransportStatus bundles "failed" and "roomFull" into one union
// member alongside "new"|"connecting"|"connected"|"closed" in the other, so
// Extract can't cleanly pull out a "connecting"-with-no-message shape. These
// three variants are still exactly the states TransportStatus can report.
export type ConnectionOverlayStatus =
  | { readonly state: "connecting" }
  | { readonly state: "failed"; readonly message: string }
  | { readonly state: "roomFull"; readonly message: string };

export type ConnectionOverlayProps = {
  readonly status: ConnectionOverlayStatus;
  readonly onRetry: () => void;
  readonly onBackToHome: () => void;
};

export function ConnectionOverlay({ status, onRetry, onBackToHome }: ConnectionOverlayProps) {
  return (
    <div style={styles.backdrop}>
      <div style={styles.card}>
        {status.state === "connecting" && (
          <>
            <div style={styles.spinner} aria-hidden="true" />
            <h2 style={styles.title}>Connecting…</h2>
            <p style={styles.body}>Reaching the host peer-to-peer.</p>
          </>
        )}

        {status.state === "failed" && (
          <>
            <h2 style={styles.title}>Couldn't connect</h2>
            <p style={styles.body}>{status.message}</p>
            <p style={styles.hint}>
              Some mobile and corporate networks block direct peer-to-peer connections entirely.
              Trying from a different network (or Wi-Fi instead of cellular) often fixes this.
            </p>
            <div style={styles.actions}>
              <button type="button" style={styles.primaryButton} onClick={onRetry}>
                Retry
              </button>
              <button type="button" style={styles.secondaryButton} onClick={onBackToHome}>
                Back to home
              </button>
            </div>
          </>
        )}

        {status.state === "roomFull" && (
          <>
            <h2 style={styles.title}>Room is full</h2>
            <p style={styles.body}>{status.message}</p>
            <div style={styles.actions}>
              <button type="button" style={styles.secondaryButton} onClick={onBackToHome}>
                Back to home
              </button>
            </div>
          </>
        )}
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
    maxWidth: 380,
    textAlign: "center",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 10,
  },
  spinner: {
    width: 28,
    height: 28,
    borderRadius: "50%",
    border: "3px solid #3a3f4b",
    borderTopColor: "#4363d8",
    animation: "jigsaw-spin 0.8s linear infinite",
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
  hint: {
    margin: 0,
    color: "#9aa0ad",
    fontSize: 12,
  },
  actions: {
    display: "flex",
    gap: 10,
    marginTop: 8,
  },
  primaryButton: {
    padding: "8px 18px",
    borderRadius: 6,
    border: "1px solid #4363d8",
    background: "#4363d8",
    color: "#fff",
    fontWeight: 600,
  },
  secondaryButton: {
    padding: "8px 18px",
    borderRadius: 6,
    border: "1px solid #3a3f4b",
    background: "transparent",
    color: "#e8eaf0",
  },
};
