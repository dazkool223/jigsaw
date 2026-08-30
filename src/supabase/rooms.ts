/**
 * Typed wrappers over the `rooms` security-definer RPCs (see supabase/schema.sql
 * and docs/adr/0001-host-epoch-and-rpc-only-access.md). There is no direct
 * table access — every function here calls an RPC that requires the Room
 * `code` to be presented, because that's what makes the code a credential.
 */

import { nanoid } from "nanoid";
import { GEOMETRY_VERSION, ROOM_CODE_LENGTH } from "../config";
import { supabase } from "./client";

/** Mirrors the `rooms` row shape returned by the RPCs. */
export type RoomRow = {
  code: string;
  seed: number;
  rows: number;
  cols: number;
  image_path: string | null;
  snapshot: unknown | null;
  host_epoch: number;
  geometry_version: number;
  completed: boolean;
  created_at: string;
  updated_at: string;
};

/** Generates a fresh, unguessable Room code. The code IS the credential. */
export function generateRoomCode(): string {
  return nanoid(ROOM_CODE_LENGTH);
}

export type CreateRoomParams = {
  code: string;
  seed: number;
  rows: number;
  cols: number;
  imagePath: string;
};

export type CreateRoomResult =
  | { outcome: "ok"; room: RoomRow }
  | { outcome: "error"; error: string };

/**
 * Creates a new Room row at host_epoch 0. Callers should generate `code` via
 * generateRoomCode() and have already uploaded the normalised image (see
 * storageUpload.ts) so `imagePath` is the final `rooms/<code>/image` path.
 *
 * geometry_version is always the app's current GEOMETRY_VERSION — a Room is
 * stamped with the geometry constants in force when it was created.
 */
export async function createRoom(params: CreateRoomParams): Promise<CreateRoomResult> {
  const { data, error } = await supabase.rpc("create_room", {
    p_code: params.code,
    p_seed: params.seed,
    p_rows: params.rows,
    p_cols: params.cols,
    p_image_path: params.imagePath,
    p_geometry_version: GEOMETRY_VERSION,
  });

  if (error) {
    return { outcome: "error", error: error.message };
  }
  return { outcome: "ok", room: data as RoomRow };
}

export type GetRoomResult =
  | { outcome: "ok"; room: RoomRow }
  | { outcome: "not_found" }
  /**
   * The Room exists but was created under different geometry constants
   * (src/config.ts's GEOMETRY_VERSION has moved on). Regenerating geometry
   * from (seed, rows, cols) today would NOT match the shapes the saved
   * Snapshot describes — see config.ts's GEOMETRY block. The caller must show
   * a clear message rather than render the mismatch.
   */
  | { outcome: "geometry_mismatch"; room: RoomRow }
  | { outcome: "error"; error: string };

/** Fetches a Room by code, or a clear "not found" / "geometry mismatch" outcome. */
export async function getRoom(code: string): Promise<GetRoomResult> {
  const { data, error } = await supabase.rpc("get_room", { p_code: code });

  if (error) {
    return { outcome: "error", error: error.message };
  }
  // A Postgres function returning a single composite row that matched
  // nothing comes back as either null or an all-null row, depending on
  // client/driver version — treat both as "not found".
  if (!data || (data as RoomRow).code == null) {
    return { outcome: "not_found" };
  }

  const room = data as RoomRow;
  if (room.geometry_version !== GEOMETRY_VERSION) {
    return { outcome: "geometry_mismatch", room };
  }
  return { outcome: "ok", room };
}

export type ClaimHostResult =
  | { outcome: "claimed"; epoch: number }
  /** Another claimant's compare-and-swap won the race first. Join as a Guest. */
  | { outcome: "lost" }
  | { outcome: "error"; error: string };

/**
 * The compare-and-swap at the heart of the single-Host model (ADR-0001).
 * Pass the epoch you last observed for this Room (0 for a never-hosted Room).
 * Exactly one concurrent caller with the same expectedEpoch wins.
 */
export async function claimHost(code: string, expectedEpoch: number): Promise<ClaimHostResult> {
  const { data, error } = await supabase.rpc("claim_host", {
    p_code: code,
    p_expected_epoch: expectedEpoch,
  });

  if (error) {
    return { outcome: "error", error: error.message };
  }
  if (data === null || data === undefined) {
    return { outcome: "lost" };
  }
  return { outcome: "claimed", epoch: data as number };
}

export type SaveSnapshotResult =
  | { outcome: "written" }
  /** host_epoch moved on — a newer Host has claimed the Room. Self-demote. */
  | { outcome: "deposed" }
  | { outcome: "error"; error: string };

/**
 * Epoch-guarded Snapshot write (ADR-0001). Only writes if the Room's
 * host_epoch still equals `epoch`; otherwise the caller was deposed and must
 * tear down hosting and offer Rejoin (see CONTEXT.md's Host Epoch). Called
 * by the debounced scheduler in snapshot.ts, never directly from the drag path.
 */
export async function saveSnapshot(
  code: string,
  epoch: number,
  snapshot: unknown,
  completed: boolean,
): Promise<SaveSnapshotResult> {
  const { data, error } = await supabase.rpc("save_snapshot", {
    p_code: code,
    p_epoch: epoch,
    p_snapshot: snapshot,
    p_completed: completed,
  });

  if (error) {
    return { outcome: "error", error: error.message };
  }
  return data === true ? { outcome: "written" } : { outcome: "deposed" };
}
