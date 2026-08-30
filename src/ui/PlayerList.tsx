/**
 * Connected Players with their cursor colours (CONTEXT.md "Player"). Your own
 * name is editable inline — identity is cosmetic, persisted per-device via
 * src/supabase/identity.ts, so renaming here is expected to call
 * `renameIdentity` (the caller wires that through `onRename`). Capacity is
 * shown against config.ts's MAX_PLAYERS — never hard-coded.
 */

import { useState } from "react";
import type { Player, PlayerId } from "../types";
import { MAX_PLAYERS } from "../config";

export type PlayerListProps = {
  readonly players: readonly Player[];
  readonly selfId: PlayerId;
  readonly onRename: (name: string) => void;
};

export function PlayerList({ players, selfId, onRename }: PlayerListProps) {
  return (
    <div className="tag players">
      <div className="players__head">
        <span className="stamp">At the table</span>
        <span className="players__count">
          {players.length}/{MAX_PLAYERS}
        </span>
      </div>
      <ul className="players__list">
        {players.map((player) => (
          <PlayerRow
            key={player.id}
            player={player}
            isSelf={player.id === selfId}
            onRename={onRename}
          />
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
    <li className="players__row">
      <span
        className="players__dot"
        style={{ background: player.color }}
        aria-hidden="true"
      />
      {isSelf && editing ? (
        <input
          autoFocus
          className="players__input"
          value={draft}
          aria-label="Your name"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(player.name);
              setEditing(false);
            }
          }}
        />
      ) : isSelf ? (
        <button
          type="button"
          className="players__rename"
          title="Rename yourself"
          onClick={() => {
            setDraft(player.name);
            setEditing(true);
          }}
        >
          {player.name} <span className="players__you">(you)</span>
        </button>
      ) : (
        <span className="players__name">{player.name}</span>
      )}
    </li>
  );
}
