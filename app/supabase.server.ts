import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

export let supabase: any = null;

if (supabaseUrl && supabaseServiceKey) {
  try {
    supabase = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        persistSession: false,
      }
    });
  } catch (e: any) {
    console.warn("[WARNING] Failed to initialize Supabase client:", e.message);
  }
} else {
  console.warn("[WARNING] Supabase environment variables missing; database-only mode active.");
}
