/**
 * Create-a-puzzle screen: pick an image, pick an approximate piece count,
 * then create the Room and hand off navigation to the caller. No signup, no
 * accounts — the Room code (generated once up front) is both the upload key
 * and the eventual join credential (ADR-0001).
 */

import { useState, type CSSProperties } from "react";
import { PIECE_PRESETS } from "../config";
import { createRoom, generateRoomCode } from "../supabase/rooms";
import { fitGrid } from "../puzzle/layout";
import { PieceCountPicker } from "./PieceCountPicker";
import { UploadForm, type UploadedImage } from "./UploadForm";

export type HomeScreenProps = {
  readonly onRoomCreated: (code: string) => void;
};

export function HomeScreen({ onRoomCreated }: HomeScreenProps) {
  const [code] = useState(() => generateRoomCode());
  const [pieceTarget, setPieceTarget] = useState<number>(PIECE_PRESETS[1]);
  const [uploaded, setUploaded] = useState<UploadedImage | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!uploaded) return;
    setCreating(true);
    setError(null);
    try {
      const grid = fitGrid(uploaded.width, uploaded.height, pieceTarget);
      const seed = Math.floor(Math.random() * 0x7fffffff);
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
      setError(err instanceof Error ? err.message : "Couldn't create the room.");
      setCreating(false);
    }
  };

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Jigsaw</h1>
        <p style={styles.tagline}>
          Upload a photo, pick a piece count, and start solving together. Anyone with the link can
          join — no signup.
        </p>

        <section style={styles.section}>
          <label style={styles.label}>Image</label>
          <UploadForm code={code} uploaded={uploaded} onUploaded={setUploaded} />
        </section>

        <section style={styles.section}>
          <label style={styles.label}>Piece count</label>
          <PieceCountPicker value={pieceTarget} onChange={setPieceTarget} disabled={creating} />
        </section>

        {error && <p style={styles.error}>{error}</p>}

        <button
          type="button"
          style={{ ...styles.createButton, opacity: uploaded && !creating ? 1 : 0.5 }}
          disabled={!uploaded || creating}
          onClick={() => void handleCreate()}
        >
          {creating ? "Creating…" : "Create puzzle"}
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 480,
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  title: {
    margin: 0,
    fontSize: 32,
    fontWeight: 700,
  },
  tagline: {
    margin: 0,
    color: "#9aa0ad",
    fontSize: 14,
    lineHeight: 1.5,
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  label: {
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#9aa0ad",
  },
  error: {
    margin: 0,
    color: "#e6194b",
    fontSize: 13,
  },
  createButton: {
    padding: "12px 20px",
    borderRadius: 8,
    border: "1px solid #4363d8",
    background: "#4363d8",
    color: "#fff",
    fontWeight: 600,
    fontSize: 15,
  },
};
