/**
 * Driven by `TransportStatus` (see ../types.ts). Covers every state that
 * would otherwise leave the user staring at a silent hang:
 *
 *  - connecting: a simple, honest "Connecting" - no fake progress bar.
 *  - failed: the transport's own message verbatim (this is the 15s
 *    STUN-only timeout from config.ts's CONNECT_TIMEOUT_MS - see peer.ts).
 *    Copy is upfront that some networks can't complete a STUN-only
 *    connection, with a Retry action.
 *  - roomFull: the transport's own message verbatim, no Retry (retrying
 *    won't change the player count).
 */

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
    <div className="overlay">
      <div className="card">
        {status.state === "connecting" && (
          <div className="card__body">
            <div className="card__spinner" aria-hidden="true" />
            <h2 className="card__title">Pulling up a chair</h2>
            <p className="card__text">Connecting you straight to the host.</p>
          </div>
        )}

        {status.state === "failed" && (
          <>
            <div className="card__body">
              {/* Title names the situation, body is the transport's own words,
                  hint adds only the fix - peer.ts already states the cause, so
                  repeating "mobile networks" here would say it three times. */}
              <h2 className="card__title">Couldn't join this puzzle</h2>
              <p className="card__text">{status.message}</p>
              <p className="card__hint">
                Switching to Wi-Fi, or trying from a different network, usually gets through.
              </p>
            </div>
            <div className="card__tray">
              <div className="card__actions">
                <button type="button" className="btn" onClick={onRetry}>
                  Try again
                </button>
                <button type="button" className="btn btn--ghost" onClick={onBackToHome}>
                  Back to home
                </button>
              </div>
            </div>
          </>
        )}

        {status.state === "roomFull" && (
          <>
            <div className="card__body">
              <h2 className="card__title">This table is full</h2>
              <p className="card__text">{status.message}</p>
            </div>
            <div className="card__tray">
              <button type="button" className="btn btn--ghost" onClick={onBackToHome}>
                Back to home
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
