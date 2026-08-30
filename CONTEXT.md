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

### M1 — Single-player core, no network/Supabase — **DONE**
- [x] Scaffold, `config.ts`, shared `types.ts` contract
- [x] Puzzle geometry: seeded RNG, shared Edge generation (interlock invariant), grid fitting, scatter — `puzzle/rng.ts edges.ts geometry.ts layout.ts` (all unit-tested)
- [x] Texture baking into atlases with seam fix — `puzzle/textures.ts` (unit-tested; visually confirmed seamless)
- [x] Drag/zoom/pan/pinch input — `render/interactions.ts viewport.ts` (unit-tested + real-mouse-drag verified)
- [x] Snap/Merge/Completion, held-Group deferral — `game/state.ts snap.ts` (unit-tested)
- [x] `host.ts` + `client.ts` over an in-process loopback transport — `game/loopback.ts` (unit-tested)
- [x] **PixiJS renderer wired to the board** — `render/board.ts` + `render/cursors.ts`, mounted from `app.tsx`'s `BoardMount`. This was the one missing piece as of 2026-08-30 (app.tsx had a literal `TODO(wiring)` stub); implemented and verified this session via a throwaway smoke harness (real loopback Host+Client, real Pixi renderer, real mouse drag): pieces scatter, interlock, bake seamlessly, and a full grab/move/drop/snap/merge solve reaches Completion with zero console errors.
- [ ] 500-Piece Chrome-perf FPS check (target 60fps) — not yet run

### M2 — Supabase Rooms + persistence — **code complete, unverified live**
- [x] `supabase/schema.sql` (table + RPCs + bucket policy) — written, **not yet applied to any Supabase project**
- [x] Image normalisation & upload — `supabase/storageUpload.ts` (unit-tested)
- [x] Room links / hash routing — `ui/routing.ts` (unit-tested)
- [x] Debounced Snapshot save (`SnapshotScheduler`) — `supabase/snapshot.ts`
- [x] Epoch-guarded claim-Host + resume flow — `supabase/rooms.ts`, wired in `app.tsx`'s `RoomSessionController`
- [ ] **Live verification blocked**: no `.env.local` exists yet (`.env.example` only), so `createRoom`/`getRoom`/`claim_host` have never run against a real project. Create-a-room and cross-device resume are unverified.

### M3 — WebRTC multiplayer — **code complete, unverified live**
- [x] Signaling, peer wrapper, Host/Guest net wiring — `net/signaling.ts peer.ts hostNet.ts guestNet.ts` (unit-tested with mocked `RTCPeerConnection`)
- [x] Live cursors — `render/cursors.ts` `CursorLayer`, plus `Host.getCursors()`/`getPlayerId()` (added this session — `Host` was missing these, causing a `tsc` unused-field error; `Client` already had the equivalent)
- [x] Grab locks, optimistic drag + reconciliation, MOVE relay — `game/host.ts client.ts` (unit-tested, including a regression test for a MOVE-relay gap found and fixed in a prior session)
- [x] Resync (30s timer + Guest-pull on seq gap) — implemented
- [x] Reconnection / Host-disconnect / deposed-Host / 8-player-cap UI — `ui/ConnectionOverlay.tsx DeposedOverlay.tsx ResumeHostScreen.tsx`
- [ ] **Live verification blocked** (same Supabase gap as M2, plus needs real browser windows): two-window localhost, LAN, cross-network STUN-only failure UX, simultaneous-grab race, drop-against-held-Group, Host tab close + resume, sleeping-Host-wakes-deposed — none of these have been run for real yet.

### M4 — Polish — **partial**
- [x] Confetti + stats on Completion — `ui/WinDialog.tsx`
- [x] Ghost-image toggle (press "g") — added this session in `render/board.ts`
- [x] Remote-motion lerp (`REMOTE_LERP_MS`) — `render/renderer.ts` + `render/cursors.ts`
- [x] `pnpm build && vite build` succeeds (chunk-size warning only, expected from bundling Pixi)
- [ ] Piece bevels/shadows — not started
- [ ] Mobile touch/pinch — pointer-event plumbing exists in `interactions.ts` but untested on an actual touch device
- [ ] Vercel deploy — not started

### Current blocker (do this next)
**No Supabase project is provisioned.** `.env.local` doesn't exist, and `supabase/schema.sql` has never been run anywhere. Until that happens:
- The Home screen renders and works standalone, but "Create puzzle" will fail (no RPCs to call).
- M2 and M3's live-verification checklists above can't be attempted.

Next concrete steps: create a Supabase project → run `supabase/schema.sql` in its SQL editor → create the public `puzzles` storage bucket → copy `.env.example` to `.env.local` with the project's URL/publishable key → re-test Home → Create → Room → (second browser window) Join.
