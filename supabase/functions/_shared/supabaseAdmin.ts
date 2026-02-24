import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import type { RuntimeEnv } from "./env.ts";

export function createSupabaseAdmin(env: RuntimeEnv) {
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
