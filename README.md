# Jigsaw

A browser-first co-op multiplayer jigsaw puzzle. One player's browser is authoritative (the "Host"); everyone else connects to it peer-to-peer over WebRTC. Supabase is used only for a small Postgres table (room state), Storage (puzzle images), and Realtime (WebRTC signaling) — there is no game server. See [`CONTEXT.md`](./CONTEXT.md) for the domain vocabulary and `docs/adr/` for the design decisions behind the backend.

## Prerequisites

- Node.js 20+
- A [Supabase](https://supabase.com) project (free tier is enough)

## Run it locally

```bash
npm install
npm run dev
```

This starts Vite's dev server (see `vite.config.ts`) and prints a local URL to open in your browser. Other useful scripts from `package.json`:

```bash
npm run build      # type-check (tsc -b) and produce a production build
npm run preview    # serve the production build locally
npm run test       # run the test suite once (vitest run)
npm run test:watch # run tests in watch mode
```

The app needs a Supabase project configured (below) before it will run — it fails fast with a clear error if the required environment variables are missing.

## Connect it to Supabase

Supabase provides three things here: the `rooms` table (room/session state), a public Storage bucket for uploaded puzzle images, and a Realtime channel used to bootstrap the WebRTC connection between players. There is no migration tooling — the schema is a single idempotent SQL file applied by hand.

1. Create a project at [supabase.com](https://supabase.com).
2. In the dashboard, open the **SQL Editor** and run the entire contents of `supabase/schema.sql` against your project. It's safe to re-run any time the file changes.
   - This creates the `rooms` table (RLS enabled, no direct-access policies — access is only through `security definer` RPCs: `create_room`, `get_room`, `claim_host`, `save_snapshot`) and a public `puzzles` Storage bucket for images. See `docs/adr/0001-host-epoch-and-rpc-only-access.md` for why direct table access is intentionally locked down.
3. In **Settings -> API**, copy your **Project URL** and **anon/public key**.
4. Create a `.env.local` file in the project root (git-ignored) with:

   ```
   VITE_SUPABASE_URL=https://your-project-ref.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-public-key
   ```

5. Restart `npm run dev` if it was already running, so Vite picks up the new env vars.

No further Supabase configuration (auth providers, extra tables, etc.) is needed — the anon key is safe to ship in the client bundle because every table access goes through the RPCs described above.

## Deploy to Vercel

The app is a static Vite build with no server-side code, so it deploys as a static site.

1. Push this repo to GitHub (if you haven't already) and import it in the [Vercel dashboard](https://vercel.com/new), or deploy from the CLI:

   ```bash
   npm i -g vercel
   vercel
   ```

2. Vercel should auto-detect the Vite framework preset. If configuring manually, use:
   - **Build command**: `npm run build`
   - **Output directory**: `dist`
3. Add the same two environment variables from your `.env.local` to the Vercel project (**Settings -> Environment Variables**), for Production (and Preview, if you want preview deployments to work):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. Deploy (`vercel --prod`, or push to your production branch if the project is connected to Git). Because everything is client-side and peer-to-peer, no additional server configuration is required — Vercel only needs to serve the static build.
