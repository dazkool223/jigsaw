/**
 * Driven by `TransportStatus` (see ../types.ts). Covers every state that
 * would otherwise leave the user staring at a silent hang:
 *
 *  - connecting: a simple, honest "Connecting" - no fake progress bar.
 *  - failed: the transport's own message AND its own hint, both verbatim.
 *    This component deliberately writes no diagnosis of its own. It used to
 *    end every failure with "Switching to Wi-Fi, or trying from a different
 *    network, usually gets through", which is true for exactly one of the
 *    several failures that land here and actively misleading for the rest -
 *    it sent real players off changing networks over a host that had gone
 *    offline. `peer.ts` knows which failure happened; it supplies the words.
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
  | {
      readonly state: "failed";
      readonly message: string;
      /** Advice from the transport for THIS failure. Omitted when there is none worth giving. */
      readonly hint?: string;
    }
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
              {/* Title names the situation; body and hint are both the
                  transport's words, because only it knows which failure this
                  was. Nothing here is hard-coded advice. */}
              <h2 className="card__title">Couldn't join this puzzle</h2>
              <p className="card__text">{status.message}</p>
              {status.hint ? <p className="card__hint">{status.hint}</p> : null}
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
