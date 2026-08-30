/**
 * Shown when this browser WAS the Host and lost the role - a stale-epoch
 * Snapshot write was rejected (ADR-0001: another claimant's compare-and-swap
 * won). Offers a single Rejoin action; the caller decides whether that lands
 * on the current Host as a Guest or back on ResumeHostScreen.
 */

export type DeposedOverlayProps = {
  readonly onRejoin: () => void;
};

export function DeposedOverlay({ onRejoin }: DeposedOverlayProps) {
  return (
    <div className="overlay">
      <div className="card">
        <div className="card__body">
          <h2 className="card__title">Someone else picked up the board</h2>
          <p className="card__text">
            This puzzle is being hosted somewhere else now - most likely by you, on another
            device. Rejoin to keep solving it together.
          </p>
        </div>
        <div className="card__tray">
          <button type="button" className="btn" onClick={onRejoin}>
            Rejoin
          </button>
        </div>
      </div>
    </div>
  );
}
