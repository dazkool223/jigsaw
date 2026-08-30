-- ─────────────────────────────────────────────────────────────────────────────
-- Jigsaw — Supabase schema
--
-- Applied BY HAND in the Supabase dashboard SQL editor. There is no migration
-- tooling for this project, so this file is the source of truth: whenever you
-- change something here, re-run the whole file against the project (it is
-- written to be idempotent — safe to re-run top to bottom at any time) and
-- keep this file in sync with what actually ran.
--
-- SECURITY MODEL (see docs/adr/0001-host-epoch-and-rpc-only-access.md)
-- ─────────────────────────────────────────────────────────────────────────────
-- The Room `code` IS the credential: presenting it grants access to that Room,
-- and it must never be possible to LIST codes. The anon key ships in the JS
-- bundle, so if we granted anon direct SELECT on `rooms` (even behind a
-- permissive RLS policy), anyone holding the bundled key could enumerate every
-- Room, harvest every image and Snapshot, and overwrite anyone's board.
--
-- So: RLS is enabled on `rooms` with NO policies (deny-all by default), all
-- default table privileges are revoked from anon/authenticated, and the ONLY
-- access is through a small set of `security definer` RPCs below. Each one
-- takes the room `code` as a required argument, so calling it means you
-- already presented the credential. EXECUTE on those functions (and only
-- those) is granted to anon.
--
-- HOST EPOCH (single-writer guard, see ADR-0001)
-- ─────────────────────────────────────────────────────────────────────────────
-- `host_epoch` is a monotonic counter. Claiming Host is a compare-and-swap
-- increment (`claim_host`) — exactly one concurrent claimant wins. Every
-- Snapshot write (`save_snapshot`) must carry the epoch it believes is
-- current; a write from a deposed Host (stale epoch) is silently rejected
-- rather than clobbering newer state, and the caller uses the boolean return
-- to detect that and self-demote.
-- ─────────────────────────────────────────────────────────────────────────────


-- ─────────────────────────────────────────────────────────────────────────────
-- Table: rooms
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.rooms (
  code              text primary key,
  seed              bigint not null,
  rows              int not null,
  cols              int not null,
  image_path        text,
  snapshot          jsonb,
  host_epoch        int not null default 0,
  geometry_version  int not null,
  completed         boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.rooms is
  'One row per puzzle Room. code is the unguessable credential (nanoid, '
  'ROOM_CODE_LENGTH chars) — never expose a way to list this table. All access '
  'goes through the security definer RPCs below, never direct table grants.';
comment on column public.rooms.host_epoch is
  'Monotonic. Bumped by claim_host() via compare-and-swap; save_snapshot() only '
  'writes when the caller''s epoch still matches, so a deposed Host''s stale '
  'write fails instead of clobbering newer state.';
comment on column public.rooms.geometry_version is
  'Copied from GEOMETRY_VERSION (src/config.ts) at creation time. A mismatch on '
  'load means the puzzle-generation constants changed since this Room was '
  'created and existing (seed, rows, cols) would regenerate different shapes '
  'than the saved snapshot describes — the client must refuse to render it.';

-- Enable RLS with NO policies: deny-all for every direct-table role. Combined
-- with the revokes below, anon/authenticated have zero direct access to this
-- table — the only door in is the RPCs.
alter table public.rooms enable row level security;
alter table public.rooms force row level security;

revoke all on public.rooms from anon, authenticated, public;


-- ─────────────────────────────────────────────────────────────────────────────
-- Keep updated_at current on any row write (defence in depth — save_snapshot
-- also sets it explicitly, but this covers any future writer).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_rooms_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists rooms_set_updated_at on public.rooms;
create trigger rooms_set_updated_at
  before update on public.rooms
  for each row
  execute function public.set_rooms_updated_at();


-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: create_room(p_code, p_seed, p_rows, p_cols, p_image_path, p_geometry_version)
--
-- Inserts a brand-new Room at host_epoch 0. The caller (rooms.ts) is expected
-- to have already generated an unguessable code (nanoid, ROOM_CODE_LENGTH) and
-- uploaded the normalised image before calling this, so p_image_path is
-- already the final `rooms/<code>/image` storage path.
--
-- Returns the created row. Raises if the code already exists (nanoid
-- collisions at ROOM_CODE_LENGTH are astronomically unlikely; the caller can
-- retry with a fresh code on unique_violation).
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.create_room(
  p_code             text,
  p_seed             bigint,
  p_rows             int,
  p_cols             int,
  p_image_path       text,
  p_geometry_version int
)
returns public.rooms
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
begin
  insert into public.rooms (code, seed, rows, cols, image_path, geometry_version)
  values (p_code, p_seed, p_rows, p_cols, p_image_path, p_geometry_version)
  returning * into v_room;

  return v_room;
end;
$$;

revoke all on function public.create_room(text, bigint, int, int, text, int) from public;
grant execute on function public.create_room(text, bigint, int, int, text, int) to anon;


-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: get_room(p_code)
--
-- Returns the single Room row for a presented code, or zero rows if it
-- doesn't exist. This is the ONLY way to read a Room; there is no SELECT
-- grant on the table itself.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.get_room(p_code text)
returns public.rooms
language sql
security definer
set search_path = public
stable
as $$
  select * from public.rooms where code = p_code;
$$;

revoke all on function public.get_room(text) from public;
grant execute on function public.get_room(text) to anon;


-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: claim_host(p_code, p_expected_epoch)
--
-- The compare-and-swap at the heart of the single-Host model (ADR-0001).
-- Succeeds only if the row's current host_epoch still equals p_expected_epoch,
-- in which case it increments the epoch and returns the NEW value. If another
-- claimant already won the race (or the caller's view of the epoch was
-- stale), zero rows match and this returns NULL — the caller must then join
-- as a Guest instead.
--
-- Typical caller flow: get_room() to read the current host_epoch, then
-- claim_host(code, that_epoch). A fresh Room (never hosted) has host_epoch 0,
-- so the first-ever claim passes p_expected_epoch = 0.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.claim_host(p_code text, p_expected_epoch int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_epoch int;
begin
  update public.rooms
  set host_epoch = host_epoch + 1
  where code = p_code
    and host_epoch = p_expected_epoch
  returning host_epoch into v_new_epoch;

  return v_new_epoch; -- NULL if no row matched (lost the race, or bad code)
end;
$$;

revoke all on function public.claim_host(text, int) from public;
grant execute on function public.claim_host(text, int) to anon;


-- ─────────────────────────────────────────────────────────────────────────────
-- RPC: save_snapshot(p_code, p_epoch, p_snapshot, p_completed)
--
-- Writes the Snapshot ONLY if the row's host_epoch still equals p_epoch —
-- the epoch-guarded write from ADR-0001. Returns true if it wrote, false if a
-- newer Host has since claimed the room (the caller's epoch is stale) or the
-- code doesn't exist. The app treats `false` as "you were deposed": tear down
-- hosting and offer Rejoin, per CONTEXT.md's Host Epoch semantics.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.save_snapshot(
  p_code      text,
  p_epoch     int,
  p_snapshot  jsonb,
  p_completed boolean
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
begin
  update public.rooms
  set snapshot  = p_snapshot,
      completed = p_completed,
      updated_at = now()
  where code = p_code
    and host_epoch = p_epoch;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

revoke all on function public.save_snapshot(text, int, jsonb, boolean) from public;
grant execute on function public.save_snapshot(text, int, jsonb, boolean) to anon;


-- ─────────────────────────────────────────────────────────────────────────────
-- Storage: public bucket `puzzles`, objects at rooms/<code>/image
--
-- Public read (anyone with the URL — same trust level as the Room code
-- itself) so any Player's browser can fetch the puzzle image directly from
-- Storage's CDN without another RPC round-trip. Anon may insert/update
-- objects under this bucket since normalisation happens client-side before a
-- Room row even exists; `create_room` doesn't gate the upload, so this is
-- intentionally as open as the Room code itself.
--
-- !! NO anon SELECT POLICY ON storage.objects — THIS IS DELIBERATE. !!
-- Object paths are `rooms/<code>/image`, so the path CONTAINS the credential.
-- A select policy on this bucket would let anyone holding the bundled anon key
-- call storage.list('rooms') and enumerate every Room code — reopening exactly
-- the enumeration hole that ADR-0001 closes at the table level, and handing the
-- attacker get_room()/save_snapshot() access to every board. Public-bucket
-- reads go through /object/public/<bucket>/<path>, which does not consult RLS,
-- so dropping the select policy costs nothing: fetching a known path still
-- works, listing does not. Do not "fix" this by adding a select policy.
-- ─────────────────────────────────────────────────────────────────────────────

insert into storage.buckets (id, name, public)
values ('puzzles', 'puzzles', true)
on conflict (id) do nothing;

-- Explicitly remove the enumerable read policy if an older run of this file
-- (or a dashboard click) ever created one.
drop policy if exists "puzzles: anon can read" on storage.objects;

drop policy if exists "puzzles: anon can upload" on storage.objects;
create policy "puzzles: anon can upload"
  on storage.objects
  for insert
  to anon
  with check (bucket_id = 'puzzles');

-- Allow overwriting rooms/<code>/image (upload uses upsert: true so a retry
-- or re-normalisation of the same Room's image replaces the object in place).
drop policy if exists "puzzles: anon can overwrite" on storage.objects;
create policy "puzzles: anon can overwrite"
  on storage.objects
  for update
  to anon
  using (bucket_id = 'puzzles')
  with check (bucket_id = 'puzzles');


-- ─────────────────────────────────────────────────────────────────────────────
-- POST-V1 TODO — Room hygiene (see CONTEXT.md / plan "TODO (post-v1)")
--
-- Nothing is ever deleted today. updated_at is maintained (see trigger above)
-- and each Room's image path is derivable from its code, so a purge of Rooms
-- untouched for N days is a single statement when the free-tier storage
-- ceiling actually becomes a problem. NOT active — left commented out
-- deliberately; deleting someone's in-progress puzzle is not a decision to
-- make silently via a cron job without product sign-off on N.
--
-- delete from storage.objects
--   where bucket_id = 'puzzles'
--     and name in (
--       select 'rooms/' || code || '/image' from public.rooms
--       where updated_at < now() - interval '90 days'
--     );
-- delete from public.rooms where updated_at < now() - interval '90 days';
-- ─────────────────────────────────────────────────────────────────────────────
