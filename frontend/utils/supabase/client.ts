import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/db.types";
import { getSupabaseAccessToken } from "@/lib/privy-supabase-bridge";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const usePrivy = process.env.NEXT_PUBLIC_USE_PRIVY === "1";

/**
 * GHB-165: when Privy is the active auth backend, we feed the Supabase
 * client a custom `accessToken` callback that returns a token minted by
 * `/api/auth/privy-bridge` (HS256, signed with `SUPABASE_JWT_SECRET`).
 *
 * In the legacy Supabase-Auth path (`NEXT_PUBLIC_USE_PRIVY=0`) we leave
 * `accessToken` undefined so supabase-js continues to manage the user's
 * session via cookies, exactly as before.
 */
export const createClient = () =>
  createBrowserClient<Database>(supabaseUrl!, supabaseKey!, {
    accessToken: usePrivy ? () => getSupabaseAccessToken() : undefined,
  });
