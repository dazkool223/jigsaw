# Jigsaw

A browser-first co-op multiplayer jigsaw puzzle. One player's browser is authoritative (the "Host"); everyone else connects to it peer-to-peer over WebRTC. Supabase is used only for a small Postgres table (room state), Storage (puzzle images), and Realtime (WebRTC signaling) - there is no game server. See [`CONTEXT.md`](./CONTEXT.md) for the domain vocabulary and `docs/adr/` for the design decisions behind the backend.

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

The app needs a Supabase project configured (below) before it will run - it fails fast with a clear error if the required environment variables are missing.

## Connect it to Supabase

Supabase provides three things here: the `rooms` table (room/session state), a public Storage bucket for uploaded puzzle images, and a Realtime channel used to bootstrap the WebRTC connection between players. There is no migration tooling - the schema is a single idempotent SQL file applied by hand.

1. Create a project at [supabase.com](https://supabase.com).
2. In the dashboard, open the **SQL Editor** and run the entire contents of `supabase/schema.sql` against your project. It's safe to re-run any time the file changes.
   - This creates the `rooms` table (RLS enabled, no direct-access policies - access is only through `security definer` RPCs: `create_room`, `get_room`, `claim_host`, `save_snapshot`) and a public `puzzles` Storage bucket for images. See `docs/adr/0001-host-epoch-and-rpc-only-access.md` for why direct table access is intentionally locked down.
3. In **Settings -> API**, copy your **Project URL** and **anon/public key**.
4. Create a `.env.local` file in the project root (git-ignored) with:

   ```
   VITE_SUPABASE_URL=https://your-project-ref.supabase.co
   VITE_SUPABASE_ANON_KEY=your-anon-public-key
   ```

5. Restart `npm run dev` if it was already running, so Vite picks up the new env vars.

No further Supabase configuration (auth providers, extra tables, etc.) is needed - the anon key is safe to ship in the client bundle because every table access goes through the RPCs described above.

## Set up a TURN relay

Skip this and the app still builds and runs, but a large share of players will
not be able to join each other. It is the difference between "works on my
network" and "works".

Players connect peer-to-peer, so their browsers have to find a route to each
other through whatever NAT each is behind. STUN alone solves the easy half.
It reports the address a NAT showed the STUN server, and a symmetric NAT hands
out a different external port for every destination, so that address is not
where the other side must send. Carrier-grade NAT on mobile data works this
way, and so do many ISP and office networks. Because the host is the one fixed
endpoint every guest must reach, a host behind such a NAT is unreachable by
every guest, from every network. Guests switching to Wi-Fi does not help. A
network that blocks UDP outright fails the same way, with `turns:` on 443 as
the only way out.

The full incident this caused is written up in
`docs/rca/0001-guests-cannot-connect-across-networks.md`.

This project uses [Cloudflare Realtime's TURN service](https://developers.cloudflare.com/realtime/turn/):
managed, no VPS to run. In the Cloudflare dashboard, go to **Realtime -> TURN
Service -> Create TURN App/Key**, which gives you a Turn Key ID and a Turn Key
API Token. Then wire it up one of two ways.

**Production - short-lived credentials.** TURN credentials must not go in a
`VITE_` variable: everything so prefixed is compiled into the bundle and served
to every visitor, so a static password is a free relay for whoever reads it.
`supabase/functions/turn-credentials/` is a ready-to-deploy Edge Function that
calls Cloudflare's credential-generation endpoint and keeps the API token
server-side, handing the browser only short-lived credentials. Its header
comments carry the deploy steps. Then set:

```
VITE_TURN_CREDENTIALS_URL=https://your-project-ref.functions.supabase.co/turn-credentials
```

**Local testing - static credentials.** Fine against a local
[coturn](https://github.com/coturn/coturn) or a one-off Cloudflare-minted
credential pasted in by hand, not for anything you share:

```
VITE_TURN_URLS=turn:localhost:3478?transport=udp,turn:localhost:3478?transport=tcp
VITE_TURN_USERNAME=your-turn-user
VITE_TURN_CREDENTIAL=your-turn-password
```

List a TCP URL and a `turns:` URL on 443 alongside UDP. UDP is faster when it
is available, and on the networks that block it nothing else gets through.

To check what the browser actually negotiated, open the console: every
connection logs its gathered candidate types on completion. Seeing `relay`
among them means TURN is working. Seeing only `host` and `srflx` means the app
is still one strict NAT away from failing.

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
3. Add the environment variables from your `.env.local` to the Vercel project (**Settings -> Environment Variables**), for Production (and Preview, if you want preview deployments to work):
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - `VITE_TURN_CREDENTIALS_URL` - see "Set up a TURN relay" above. Without it the deployed app is peer-to-peer over STUN only, which fails for anyone behind a symmetric NAT.
4. Deploy (`vercel --prod`, or push to your production branch if the project is connected to Git). Because everything is client-side and peer-to-peer, no additional server configuration is required - Vercel only needs to serve the static build.
