"use client";

/**
 * GHB-165: client-side glue between Privy and Supabase.
 *
 * Privy gives us short-lived ES256 JWTs (`getAccessToken()`), but Supabase
 * RLS expects HS256 JWTs signed with the project's JWT secret. The
 * `/api/auth/privy-bridge` route does the swap server-side; this module:
 *
 *   1. Holds a registry pointer to Privy's `getAccessToken` so the Supabase
 *      client (which is constructed eagerly) can pull a Privy token on
 *      demand without depending on React state.
 *   2. Caches the minted Supabase token and refreshes ~60s before expiry
 *      so we don't pay the round-trip on every request.
 *   3. De-dupes concurrent refreshes via a single in-flight promise.
 *
 * The Supabase browser client uses `accessToken: getSupabaseAccessToken`
 * (see `utils/supabase/client.ts`). When Privy is not mounted (anonymous
 * browsing, or the legacy Supabase-Auth path) the getter returns `null`
 * and supabase-js falls back to the publishable key + anon role — exactly
 * the behavior we want for public reads.
 */

type PrivyTokenGetter = () => Promise<string | null>;

let privyTokenGetter: PrivyTokenGetter | null = null;
let cachedSupabaseToken: { token: string; expiresAt: number } | null = null;
let inflight: Promise<string | null> | null = null;

/**
 * Refresh the cached token this many seconds BEFORE the server-stamped
 * expiry. Keeps long-running queries from racing the boundary.
 */
const REFRESH_SAFETY_WINDOW_S = 60;

/** Called from `auth-privy.tsx` once Privy is ready. */
export function registerPrivyTokenGetter(fn: PrivyTokenGetter): void {
  privyTokenGetter = fn;
}

/** Called on Privy logout / unmount. Wipes the cached Supabase token too. */
export function clearPrivySession(): void {
  privyTokenGetter = null;
  cachedSupabaseToken = null;
  inflight = null;
}

interface BridgeResponse {
  supabaseAccessToken: string;
  expiresAt: number;
  sub: string;
}

/**
 * Returns a fresh Supabase JWT, or `null` if the user isn't logged in via
 * Privy. Safe to call from anywhere (no React deps); the supabase-js
 * `accessToken` callback wires straight into this.
 */
export async function getSupabaseAccessToken(): Promise<string | null> {
  if (!privyTokenGetter) return null;

  const nowS = Math.floor(Date.now() / 1000);
  if (
    cachedSupabaseToken &&
    cachedSupabaseToken.expiresAt - nowS > REFRESH_SAFETY_WINDOW_S
  ) {
    return cachedSupabaseToken.token;
  }

  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const privyToken = await privyTokenGetter!();
      if (!privyToken) return null;

      const res = await fetch("/api/auth/privy-bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ privyAccessToken: privyToken }),
      });
      if (!res.ok) {
        // Don't throw — letting Supabase fall back to anon for this request
        // is preferable to crashing the whole UI on a transient failure.
        // The next call will retry.
        cachedSupabaseToken = null;
        return null;
      }
      const data = (await res.json()) as BridgeResponse;
      cachedSupabaseToken = {
        token: data.supabaseAccessToken,
        expiresAt: data.expiresAt,
      };
      return data.supabaseAccessToken;
    } catch {
      cachedSupabaseToken = null;
      return null;
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}
