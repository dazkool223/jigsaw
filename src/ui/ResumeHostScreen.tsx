/**
 * Shown when a Room has no Host online (CONTEXT.md "Host", ADR-0001).
 * Claiming Host is a DELIBERATE act - this screen must never auto-claim, so
 * that link-preview bots and background tabs can't silently steal the role.
 * The only way forward is the explicit "Resume puzzle" button.
 */

export type ResumeHostScreenProps = {
  readonly onResume: () => void;
  readonly claiming: boolean;
  readonly error?: string;
};

export function ResumeHostScreen({ onResume, claiming, error }: ResumeHostScreenProps) {
  return (
    <div className="overlay">
      <div className="card">
        <div className="card__body">
          <h2 className="card__title">Nobody's hosting right now</h2>
          <p className="card__text">
            Every piece is exactly where it was left. Take over to put the board back on the
            table - anyone with the link can join you.
          </p>
          {error && <p className="note">{error}</p>}
        </div>
        <div className="card__tray">
          <button type="button" className="piece-btn" onClick={onResume} disabled={claiming}>
            <span className="piece-btn__label">{claiming ? "Resuming…" : "Resume puzzle"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
