/**
 * "Who's playing" on the home screen — the one place a name can be set before
 * a Room exists.
 *
 * Identity is cosmetic and per-device (src/supabase/identity.ts), so this
 * writes straight through to `renameIdentity` rather than reporting upward:
 * whoever ends up reading `getIdentity()` at connect time — Host or Client —
 * picks up whatever was typed here, with no plumbing in between.
 *
 * Presented as the place card at the table: the swatch is this device's real
 * cursor colour, so the name you type here is visibly the same marker that
 * will move on the board.
 */

import { useState } from "react";
import { PLAYER_NAME_MAX_LENGTH } from "../config";
import { getIdentity, renameIdentity } from "../supabase/identity";

export type NameFieldProps = {
  readonly disabled?: boolean;
};

export function NameField({ disabled = false }: NameFieldProps) {
  const [identity] = useState(() => getIdentity());
  const [draft, setDraft] = useState(identity.name);

  return (
    <label className="placecard">
      <span
        className="placecard__dot"
        style={{ background: identity.color }}
        aria-hidden="true"
      />
      <input
        className="placecard__input"
        value={draft}
        disabled={disabled}
        maxLength={PLAYER_NAME_MAX_LENGTH}
        aria-label="Your name"
        onChange={(e) => {
          setDraft(e.target.value);
          // Persisted per keystroke so a name typed and then clicked straight
          // past still counts. `rename` ignores a blank, so clearing the field
          // to retype never wipes the stored identity.
          renameIdentity(e.target.value);
        }}
        onBlur={() => {
          // Whatever was actually kept is what should be showing.
          setDraft(getIdentity().name);
        }}
      />
    </label>
  );
}
