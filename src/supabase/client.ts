/**
 * The single Supabase client for the app. Everything else in src/supabase/
 * goes through this - never construct a second client.
 *
 * Configured from Vite env vars (see .env.example). Both are required: there
 * is no "offline" mode, so fail loudly with a clear error rather than letting
 * every RPC call fail later with an opaque network error.
 *
 * Construction is deferred to first use (via the Proxy below) rather than
 * done at module load. This means importing this module - or anything that
 * imports it, like storageUpload.ts's pure helpers - never throws just for
 * being loaded without env vars present (e.g. under vitest); only an actual
 * network call (`supabase.rpc(...)`, `supabase.storage...`) does.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function createSupabaseClient(): SupabaseClient {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  const missing: string[] = [];
  if (!url) missing.push("VITE_SUPABASE_URL");
  if (!publishableKey) missing.push("VITE_SUPABASE_PUBLISHABLE_KEY");
  if (missing.length > 0) {
    throw new Error(
      `Missing Supabase config: ${missing.join(", ")}. Copy .env.example to ` +
        `.env.local and fill in your Supabase project's URL and publishable key ` +
        `(Settings -> API Keys in the dashboard).`,
    );
  }

  return createClient(url, publishableKey);
}

let cachedClient: SupabaseClient | undefined;

/** The app's Supabase client. Publishable-key only - see docs/adr/0001 for why that's safe. Never construct one with a secret key here; there is no server code to hold it. */
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    if (!cachedClient) {
      cachedClient = createSupabaseClient();
    }
    return Reflect.get(cachedClient as object, prop, receiver);
  },
});
