# Jigsaw

A browser-first co-op multiplayer jigsaw puzzle. One player's browser is authoritative (no game server); others connect to it peer-to-peer.

## Language

### Puzzle

**Piece**:
One jigsaw tile, fully determined by the puzzle definition `(image, seed, rows, cols)`. Its outline is assembled from four Edges, not owned by it. Always belongs to exactly one Group.

**Edge**:
One cut line between two adjacent Pieces (or the straight outer boundary of a border Piece). Shared: each interior Edge is generated once and referenced by both neighbouring Pieces, one of them traversing it reversed. Edges — not Pieces — are what the seeded PRNG generates.

**Tab / Blank**:
The two sides of an interior Edge's interlocking bulge: the Tab protrudes from one Piece into the neighbouring Blank. A Tab has a pinched neck and a wider bulb, which is what makes Pieces interlock rather than abut.
_Avoid_: knob, hole, bump

**Cell**:
A Piece's nominal slot in the grid. Cell corners are jittered so cut lines look hand-cut, but a Cell's origin is still the Piece's solved position — jitter never moves the Lattice.

**Group**:
A rigid set of one or more correctly-joined Pieces that moves as one unit. Every Piece is in a Group; a lone Piece is a Group of one.
_Avoid_: island, cluster

**Lattice**:
The grid of solved positions on the board. "Lattice snap" is a Group snapping to its correct absolute position.
_Avoid_: board frame, correct position grid

**Merge**:
The host-decided, atomic joining of two Groups whose Pieces land within snap tolerance. A Group currently held by a player is never a merge target; the connection is deferred until it is dropped.

**Completion**:
The state where all Pieces belong to a single Group.

### Session & roles

**Room**:
A puzzle instance addressed by its unguessable code. The code is the credential: presenting it grants access; it is never listable.

**Host**:
The one player whose browser is currently authoritative for a Room: it decides grabs, merges, and writes Snapshots. A role, not a person — claimed explicitly, one holder at a time.

**Guest**:
Any connected player who is not the Host. Guests send intents (grab, move, drop) and receive authoritative state.

**Host Epoch**:
A monotonic counter on the Room row. Claiming Host increments it via compare-and-swap; exactly one claimant wins. Snapshot writes carrying a stale epoch are rejected.

**Snapshot**:
The persisted serialization of a Room's state (noun only — the act is "saving a snapshot"). Written only by the current Host.

**Grab**:
A player's lock request on a Group. The Host grants it to the first requester; a denied grab snaps the Group back for the loser.

**Player**:
A per-device identity (name + cursor color) persisted locally. Cosmetic only — no state of consequence is keyed to it.

---

## Progress Tracker

> Status snapshot, not glossary — update this section (not the vocabulary above) as work
> proceeds. Milestones and file layout refer to `i-want-to-create-recursive-bentley.md`
> (the implementation plan). Last updated: 2026-08-30.

### M1 — Single-player core, no network/Supabase — **DONE, live-verified**
- [x] Scaffold, `config.ts`, shared `types.ts` contract
- [x] Puzzle geometry: seeded RNG, shared Edge generation (interlock invariant), grid fitting, scatter — `puzzle/rng.ts edges.ts geometry.ts layout.ts` (all unit-tested)
- [x] Texture baking into atlases with seam fix — `puzzle/textures.ts` (unit-tested; visually confirmed seamless with a real photo)
- [x] Drag/zoom/pan/pinch input — `render/interactions.ts viewport.ts` (unit-tested + real-mouse-drag verified against the live-rendered board, not just a synthetic harness)
- [x] Snap/Merge/Completion, held-Group deferral — `game/state.ts snap.ts` (unit-tested)
- [x] `host.ts` + `client.ts` over an in-process loopback transport — `game/loopback.ts` (unit-tested)
- [x] **PixiJS renderer wired to the board** — `render/board.ts` + `render/cursors.ts`, mounted from `app.tsx`'s `BoardMount`. Real end-to-end run confirmed: a user's own photo (`src/puzzle/sample.png`) scatters into correctly-interlocking pieces, drags smoothly, and a real drag's resulting offset round-trips through the real Host into a real Supabase Snapshot.
- [ ] 500-Piece Chrome-perf FPS check (target 60fps) — not yet run (tested at ~24/~100 pieces only so far)

### M2 — Supabase Rooms + persistence — **DONE, live-verified against a real project**
- [x] `supabase/schema.sql` (table + RPCs + bucket policy) — applied to a real project (`uxkjkltmammwfsdvyfwv.supabase.co`)
- [x] Image normalisation & upload — `supabase/storageUpload.ts` — **redesigned this session, see "Storage bug" below**
- [x] Room links / hash routing — `ui/routing.ts` (unit-tested)
- [x] Debounced Snapshot save (`SnapshotScheduler`) — confirmed live: a real drag's Group offset was read back from `get_room` after the debounce window
- [x] Epoch-guarded claim-Host + resume flow — confirmed live: creating a Room does NOT auto-host (per ADR-0001, "explicit Resume puzzle button"); closing the Host tab and reloading correctly shows "Host disconnected — progress is saved" / Resume puzzle, exactly per plan
- [x] Cross-device resume — the "host_epoch increments on each claim" mechanism observed directly (epoch went 0→1→2 across create/resume/re-resume in testing)

#### Storage bug found + fixed this session (real, not hypothetical)
Live testing surfaced a genuine design conflict, not a setup mistake: the original upload code used
`upsert: true` so a user could re-pick an image before clicking "Create puzzle". Supabase Storage's
`upsert` needs a **SELECT** policy internally to check-and-replace — but this schema deliberately grants
**no SELECT** on `storage.objects` (ADR-0001: a SELECT policy would let the bundled publishable key call
`storage.list('rooms')` and enumerate every Room code). So `upsert: true` was guaranteed to fail RLS on
any project using this schema, not just a misconfigured one. A delete-then-insert alternative was tried
next (only needs DELETE, not SELECT) — the RLS policy and table grant were both verified correct via
direct SQL (`set role anon; delete ... returning`, which reached the row), but Supabase Storage's DELETE
**endpoint** silently no-ops for the publishable key in production (200 OK, zero rows removed) — a
platform-side quirk, not a policy bug. **Fix**: every upload now gets a fresh random-suffixed path
(`uploadPathForRoom()` in `storageUpload.ts`, `rooms/<code>/image-<random>`) instead of overwriting in
place; the bucket grants INSERT only, nothing else. `create_room`'s `image_path` already supported an
arbitrary path per-Room, so no schema/RPC shape changed — only `storageUpload.ts`, `UploadForm.tsx`
(uses the upload's returned path instead of recomputing one), `app.tsx` (reads `room.image_path` instead
of reconstructing from `code`), and `schema.sql`'s storage policies (INSERT-only now) changed.

### M3 — WebRTC multiplayer — **core path DONE, live-verified two-window on localhost**
- [x] Signaling, peer wrapper, Host/Guest net wiring — `net/signaling.ts peer.ts hostNet.ts guestNet.ts` (unit-tested with mocked `RTCPeerConnection`)
- [x] **Live two-browser-context test**: Host creates+claims a Room; a second browser context opens the same URL, connects via real Supabase Realtime signaling + real WebRTC over localhost, and lands directly on the board (no Resume screen, since a Host is online) — both sides show an identical scattered board and a synced `PLAYERS 2/8` roster with correct `(you)` labelling on each side.
- [x] Live cursors — `render/cursors.ts` `CursorLayer`, plus `Host.getCursors()`/`getPlayerId()` (added this session — `Host` was missing these, causing a `tsc` unused-field error; `Client` already had the equivalent). Not yet visually confirmed moving live (roster sync was; cursor-glyph movement wasn't specifically checked).
- [x] Grab locks, optimistic drag + reconciliation, MOVE relay — `game/host.ts client.ts` (unit-tested, including a regression test for a MOVE-relay gap found and fixed in a prior session)
- [x] Resync (30s timer + Guest-pull on seq gap) — implemented, not separately live-tested
- [x] Reconnection / Host-disconnect / deposed-Host / 8-player-cap UI — `ui/ConnectionOverlay.tsx DeposedOverlay.tsx ResumeHostScreen.tsx`; Host-disconnect-then-resume path live-confirmed (see M2)
- [ ] **Not yet live-tested**: LAN/cross-network (only localhost, where ICE always succeeds, has been tried), STUN-only failure UX, simultaneous-grab race, drop-against-held-Group, sleeping-Host-wakes-deposed, actual Guest-side drag (only Host-side dragging has been exercised so far).

### M4 — Polish — **partial**
- [x] Confetti + stats on Completion — `ui/WinDialog.tsx`
- [x] Ghost-image toggle (press "g") — added this session in `render/board.ts`
- [x] Remote-motion lerp (`REMOTE_LERP_MS`) — `render/renderer.ts` + `render/cursors.ts`
- [x] `pnpm build && vite build` succeeds (chunk-size warning only, expected from bundling Pixi)
- [x] Fixed a real (if cosmetic) React warning in `PieceCountPicker.tsx`: `pillSelected` used longhand `borderColor` against a base style using shorthand `border`, which React flags as a styling-bug risk on rerender — both now use the `border` shorthand.
- [ ] Piece bevels/shadows — not started
- [ ] Mobile touch/pinch — pointer-event plumbing exists in `interactions.ts` but untested on an actual touch device
- [ ] Vercel deploy — not started

### Environment note (real gotcha hit this session, worth knowing)
This repo lives at `C:\Users\neeku\programs\projects\jigsaw`, with a **git worktree checked out inside
it** at `.claude\worktrees\jigsaw-domain-model` (a nested copy of the same repo on a different branch).
A `pnpm dev`/Vite process started from the worktree earlier in a session can keep running in the
background and squat on a dev-server port; a later `pnpm dev` from the main repo can appear to start
fine while the *old worktree process* is still the one actually answering that port, silently serving
stale code with no error. If browser-tested behavior doesn't match what's in the file on disk, check
`Get-NetTCPConnection -LocalPort <port>` → `Get-CimInstance Win32_Process` for the PID's actual
`CommandLine` before assuming the code is wrong.

### Current status
Both `main` and the `feat/jigsaw-implementation` worktree branch are live-verified end-to-end against a
real Supabase project (`uxkjkltmammwfsdvyfwv.supabase.co`) as of 2026-08-30: upload → create Room → claim
Host → drag a piece → Snapshot persists → disconnect/resume → second browser joins as Guest over real
WebRTC, all confirmed working with a real photo. Remaining gaps are the M3 edge cases listed above, M4
polish items, and the 500-piece performance check.
