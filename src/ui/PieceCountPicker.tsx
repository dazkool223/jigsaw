/**
 * Piece-count selector, driven entirely by config.ts's PIECE_PRESETS — never
 * hard-code the preset list here. Labelled "~N pieces" because grid fitting
 * to the image aspect means the real count differs (500 on 4:3 is actually
 * 494) — see puzzle/layout.ts#fitGrid.
 */

import type { CSSProperties } from "react";
import { PIECE_PRESETS } from "../config";

export type PieceCountPickerProps = {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
};

export function PieceCountPicker({ value, onChange, disabled }: PieceCountPickerProps) {
  return (
    <div style={styles.row} role="radiogroup" aria-label="Piece count">
      {PIECE_PRESETS.map((preset) => {
        const selected = preset === value;
        return (
          <button
            key={preset}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(preset)}
            style={{
              ...styles.pill,
              ...(selected ? styles.pillSelected : null),
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            ~{preset}
          </button>
        );
      })}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  row: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
  },
  pill: {
    padding: "8px 16px",
    borderRadius: 999,
    border: "1px solid #3a3f4b",
    background: "#22262f",
    color: "#e8eaf0",
    fontSize: 14,
    fontWeight: 500,
  },
  pillSelected: {
    background: "#4363d8",
    border: "1px solid #4363d8",
    color: "#ffffff",
  },
};
