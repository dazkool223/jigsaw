/**
 * Piece-count selector, driven entirely by config.ts's PIECE_PRESETS - never
 * hard-code the preset list here. Labelled "~N" because grid fitting to the
 * image aspect means the real count differs (500 on 4:3 is actually 494) -
 * see puzzle/layout.ts#fitGrid. HomeScreen prints the exact fitted grid
 * beneath these keys once a photo is in, so the approximation is never the
 * last word the player gets.
 */

import { PIECE_PRESETS } from "../config";

export type PieceCountPickerProps = {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
};

export function PieceCountPicker({ value, onChange, disabled }: PieceCountPickerProps) {
  return (
    <div className="keys" role="radiogroup" aria-label="Piece count">
      {PIECE_PRESETS.map((preset) => (
        <button
          key={preset}
          type="button"
          role="radio"
          aria-checked={preset === value}
          disabled={disabled}
          onClick={() => onChange(preset)}
          className="key"
        >
          ~{preset}
        </button>
      ))}
    </div>
  );
}
