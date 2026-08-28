/**
 * Connected Players with their cursor colours (CONTEXT.md "Player"). Your own
 * name is editable inline — identity is cosmetic, persisted per-device via
 * src/supabase/identity.ts, so renaming here is expected to call
 * `renameIdentity` (the caller wires that through `onRename`). Capacity is
 * shown against config.ts's MAX_PLAYERS — never hard-coded.
 */

import { useState, type CSSProperties } from "react";
import type { Player, PlayerId } from "../types";
import { MAX_PLAYERS } from "../config";

export type PlayerListProps = {
  readonly players: readonly Player[];
  readonly selfId: PlayerId;
  readonly onRename: (name: string) => void;
};

export function PlayerList({ players, selfId, onRename }: PlayerListProps) {
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span>Players</span>
        <span style={styles.capacity}>
          {players.length} / {MAX_PLAYERS}
        </span>
      </div>
      <ul style={styles.list}>
        {players.map((player) => (
          <PlayerRow key={player.id} player={player} isSelf={player.id === selfId} onRename={onRename} />
        ))}
      </ul>
    </div>
  );
}

function PlayerRow({
  player,
  isSelf,
  onRename,
}: {
  player: Player;
  isSelf: boolean;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(player.name);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== player.name) {
      onRename(trimmed);
    } else {
      setDraft(player.name);
    }
  };

  return (
    <li style={styles.row}>
      <span style={{ ...styles.dot, background: player.color }} aria-hidden="true" />
      {isSelf && editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(player.name);
              setEditing(false);
            }
          }}
          style={styles.nameInput}
        />
      ) : (
        <span
          style={{ ...styles.name, cursor: isSelf ? "text" : "default" }}
          onClick={() => {
            if (isSelf) {
              setDraft(player.name);
              setEditing(true);
            }
          }}
          title={isSelf ? "Click to rename" : undefined}
        >
          {player.name}
          {isSelf ? " (you)" : ""}
        </span>
      )}
    </li>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minWidth: 180,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: "#9aa0ad",
  },
  capacity: {
    fontVariantNumeric: "tabular-nums",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: "50%",
    flexShrink: 0,
  },
  name: {
    fontSize: 14,
    color: "#e8eaf0",
  },
  nameInput: {
    fontSize: 14,
    background: "#12141a",
    border: "1px solid #4363d8",
    borderRadius: 4,
    color: "#e8eaf0",
    padding: "2px 6px",
    minWidth: 0,
  },
};
