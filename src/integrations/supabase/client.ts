import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types";

function readEnv(name: string): string | undefined {
  // Vite replaces import.meta.env at build time on the client; the
  // process.env fallback covers SSR.
  const viteValue =
    typeof import.meta !== "undefined"
      ? (import.meta.env?.[name] as string | undefined)
      : undefined;
  if (viteValue) return viteValue;
  if (typeof process !== "undefined") return process.env[name];
  return undefined;
}

function createSupabaseClient() {
  const SUPABASE_URL = readEnv("VITE_SUPABASE_URL") ?? readEnv("SUPABASE_URL");
  // Primary name per spec is VITE_SUPABASE_ANON_KEY. The previous client
  // used VITE_SUPABASE_PUBLISHABLE_KEY (Supabase's newer key name), so it
  // is kept as a fallback to avoid breaking existing deployments.
  const SUPABASE_ANON_KEY =
    readEnv("VITE_SUPABASE_ANON_KEY") ??
    readEnv("VITE_SUPABASE_PUBLISHABLE_KEY") ??
    readEnv("SUPABASE_ANON_KEY");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    const missing = [
      ...(!SUPABASE_URL ? ["VITE_SUPABASE_URL"] : []),
      ...(!SUPABASE_ANON_KEY ? ["VITE_SUPABASE_ANON_KEY"] : []),
    ];
    const message = `Missing Supabase environment variable(s): ${missing.join(", ")}.`;
    console.error(`[Supabase] ${message}`);
    throw new Error(message);
  }

  return createClient<Database>(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
}

let _supabase: ReturnType<typeof createSupabaseClient> | undefined;

// Import the supabase client like this:
// import { supabase } from "@/integrations/supabase/client";
export const supabase = new Proxy({} as ReturnType<typeof createSupabaseClient>, {
  get(_, prop, receiver) {
    if (!_supabase) _supabase = createSupabaseClient();
    return Reflect.get(_supabase, prop, receiver);
  },
});
