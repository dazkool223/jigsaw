/**
 * The box lid, propped up beside the table.
 *
 * The one thing a physical jigsaw always gives you and a bare canvas doesn't:
 * the finished picture to check against. Shows the source photo with the real
 * cut drawn over it (PuzzlePreview), so it answers both "what am I building"
 * and "which piece is this".
 *
 * Two controls, because a reference has two failure modes. It can be in the
 * way — so it collapses to its header, and stays collapsed for the rest of the
 * session. And it can be too small to read at 500 pieces in a 200px tag — so
 * clicking it props the lid up full size, which is also the size at which
 * PuzzlePreview starts drawing the cut at all.
 */

import { useEffect, useState } from "react";
import type { Puzzle } from "../types";
import { PuzzlePreview } from "./PuzzlePreview";

export type BoxArtProps = {
  readonly puzzle: Puzzle;
  readonly imageUrl: string;
};

export function BoxArt({ puzzle, imageUrl }: BoxArtProps) {
  const [open, setOpen] = useState(true);
  const [enlarged, setEnlarged] = useState(false);

  useEffect(() => {
    if (!enlarged) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setEnlarged(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enlarged]);

  // The tag takes the photo's own shape so the lid is the whole picture, the
  // same bargain the home screen's well makes. Clamped so a panorama or a tall
  // phone shot still leaves a tag rather than a stripe or a column.
  const aspect = Math.min(2, Math.max(0.75, puzzle.grid.imageW / puzzle.grid.imageH));

  return (
    <>
      <div className="tag boxart">
        <div className="boxart__head">
          <span className="stamp">The picture</span>
          <button
            type="button"
            className="boxart__toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Hide" : "Show"}
          </button>
        </div>

        {open && (
          <button
            type="button"
            className="boxart__art"
            style={{ aspectRatio: String(aspect) }}
            onClick={() => setEnlarged(true)}
            aria-label="See the picture full size"
          >
            <img className="boxart__img" src={imageUrl} alt="" aria-hidden="true" />
            <PuzzlePreview puzzle={puzzle} className="boxart__cut" />
            <span className="boxart__cue">Full size</span>
          </button>
        )}
      </div>

      {enlarged && (
        <div
          className="boxart-zoom"
          role="dialog"
          aria-modal="true"
          aria-label="The finished picture"
          onClick={() => setEnlarged(false)}
        >
          <div className="boxart-zoom__frame" onClick={(e) => e.stopPropagation()}>
            {/* Sized by the image itself, so the frame is exactly the picture. */}
            <img className="boxart-zoom__img" src={imageUrl} alt="The finished picture" />
            <PuzzlePreview puzzle={puzzle} className="boxart__cut" />
          </div>
          <button type="button" className="btn btn--ghost" onClick={() => setEnlarged(false)}>
            Close
          </button>
        </div>
      )}
    </>
  );
}
