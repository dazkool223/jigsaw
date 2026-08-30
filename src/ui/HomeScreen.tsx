/**
 * Create-a-puzzle screen: pick a photo, pick a piece count, cut it. No signup,
 * no accounts — the Room code (generated once up front) is both the upload key
 * and the eventual join credential (ADR-0001).
 *
 * Laid out as a puzzle box lid (see theme.css): a real box lid carries exactly
 * the two things this form collects — the picture and the piece count — so the
 * metaphor encodes the information architecture rather than decorating it.
 */

import { useState } from "react";
import { PIECE_PRESETS } from "../config";
import { createRoom, generateRoomCode } from "../supabase/rooms";
import { fitGrid } from "../puzzle/layout";
import { PieceCountPicker } from "./PieceCountPicker";
import { UploadForm, type UploadedImage } from "./UploadForm";
import { PuzzlePreview } from "./PuzzlePreview";

export type HomeScreenProps = {
  readonly onRoomCreated: (code: string) => void;
};

export function HomeScreen({ onRoomCreated }: HomeScreenProps) {
  const [code] = useState(() => generateRoomCode());
  // Chosen once, up front: PuzzlePreview draws the real cut for this seed, so
  // generating a fresh one at create time would hand the player a different
  // puzzle than the one they just looked at.
  const [seed] = useState(() => Math.floor(Math.random() * 0x7fffffff));
  const [pieceTarget, setPieceTarget] = useState<number>(PIECE_PRESETS[1]);
  const [uploaded, setUploaded] = useState<UploadedImage | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The honest piece count: fitGrid rounds to keep Cells square, so "~500"
  // on this particular photo might really be 494 in a 26 x 19 grid. Printed
  // like a box-back spec once we know the photo's aspect.
  const fitted = uploaded ? fitGrid(uploaded.width, uploaded.height, pieceTarget) : null;

  const handleCreate = async () => {
    if (!uploaded) return;
    setCreating(true);
    setError(null);
    try {
      const grid = fitGrid(uploaded.width, uploaded.height, pieceTarget);
      const result = await createRoom({
        code,
        seed,
        rows: grid.rows,
        cols: grid.cols,
        imagePath: uploaded.path,
      });
      if (result.outcome === "error") {
        setError(result.error);
        setCreating(false);
        return;
      }
      onRoomCreated(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The puzzle couldn't be created. Try again.");
      setCreating(false);
    }
  };

  return (
    <div className="page">
      <div style={{ width: "100%", maxWidth: 470 }}>
        <div className="lid lid--home">
          <UploadForm
            code={code}
            uploaded={uploaded}
            onUploaded={setUploaded}
            overlay={
              uploaded && fitted ? (
                <PuzzlePreview
                  imageUrl={code}
                  imageWidth={uploaded.width}
                  imageHeight={uploaded.height}
                  seed={seed}
                  rows={fitted.rows}
                  cols={fitted.cols}
                />
              ) : null
            }
          />

          <h1 className="wordmark">Jigsaw</h1>
          <p className="tagline">
            Cut a photo into a puzzle, send the link, and solve it together — from anywhere,
            with no accounts.
          </p>

          <div className="rule" />

          <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <span className="stamp">Pieces</span>
            <PieceCountPicker value={pieceTarget} onChange={setPieceTarget} disabled={creating} />
            <p className="spec">
              {fitted
                ? `${fitted.rows * fitted.cols} pieces · ${fitted.cols} × ${fitted.rows} grid`
                : "Exact count is set by your photo's shape"}
            </p>
          </div>

          {error && <p className="note">{error}</p>}
        </div>

        <div className="cta-row">
          <button
            type="button"
            className="piece-btn"
            disabled={!uploaded || creating}
            onClick={() => void handleCreate()}
          >
            {/* One name for the action the whole way through — the empty well
                and the disabled state already say a photo is needed. */}
            <span className="piece-btn__label">{creating ? "Cutting…" : "Cut the puzzle"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
