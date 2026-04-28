/**
 * GHB-165: pure logic for the Privy → Supabase token exchange.
 *
 * Extracted from `app/api/auth/privy-bridge/route.ts` so tests can inject
 * verification keys, the secret, and the clock without mocking Next.js
 * runtime internals or hitting Privy's JWKS endpoint over HTTP.
 *
 * The route file calls `verifyAndMintToken` with real-world dependencies:
 *   - `verifyKey`: a `createRemoteJWKSet(...)` getter for Privy's JWKS.
 *   - `secret`: `SUPABASE_JWT_SECRET` (HS256 signing key).
 *   - `now`: `() => Date.now() / 1000`.
 *
 * Tests pass a static public-key resolver and a fixed clock.
 */

import { jwtVerify, SignJWT } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

export interface VerifyAndMintDeps {
  /** Privy app ID; consumed as the JWT's `aud` claim. */
  privyAppId: string;
  /**
   * Verifying key/getter that satisfies `jose.jwtVerify`. In production this
   * is `createRemoteJWKSet(new URL(<jwks>))`. In tests it's a function
   * resolving to a `CryptoKey` generated locally.
   */
  verifyKey: JWTVerifyGetKey | CryptoKey | Uint8Array;
  /** HS256 signing secret (`SUPABASE_JWT_SECRET`). */
  supabaseJwtSecret: string;
  /** Current epoch seconds. Injected for deterministic tests. */
  now: () => number;
  /** TTL of the minted Supabase JWT, in seconds. */
  ttlSeconds: number;
}

export const PRIVY_ISSUER = "privy.io";
export const SUPABASE_AUDIENCE = "authenticated";
export const SUPABASE_TOKEN_DEFAULT_TTL_S = 60 * 60; // 1h

export interface MintedToken {
  supabaseAccessToken: string;
  expiresAt: number;
  sub: string;
}

export class BridgeError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

/**
 * Verifies a Privy JWT and mints a Supabase-compatible HS256 JWT for the
 * same `sub`. Throws `BridgeError` with an appropriate HTTP status on
 * failure; never returns null.
 */
export async function verifyAndMintToken(
  privyAccessToken: string,
  deps: VerifyAndMintDeps,
): Promise<MintedToken> {
  if (!privyAccessToken) {
    throw new BridgeError(400, "Missing privyAccessToken");
  }
  if (!deps.privyAppId) {
    throw new BridgeError(500, "privyAppId is empty");
  }
  if (!deps.supabaseJwtSecret) {
    throw new BridgeError(500, "supabaseJwtSecret is empty");
  }

  // 1. Verify the Privy JWT.
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(privyAccessToken, deps.verifyKey as never, {
      issuer: PRIVY_ISSUER,
      audience: deps.privyAppId,
    });
    payload = verified.payload;
  } catch (err) {
    throw new BridgeError(
      401,
      `Privy token verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!payload.sub || typeof payload.sub !== "string") {
    throw new BridgeError(401, "Privy token missing sub");
  }

  // 2. Mint a Supabase HS256 token whose `sub` is the Privy DID. RLS
  //    policies (auth.jwt() ->> 'sub') compare against profiles.user_id.
  const nowS = deps.now();
  const expiresAt = nowS + deps.ttlSeconds;

  const supabaseToken = await new SignJWT({
    role: "authenticated",
    privy_aud: payload.aud,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("privy-bridge")
    .setSubject(payload.sub)
    .setAudience(SUPABASE_AUDIENCE)
    .setIssuedAt(nowS)
    .setExpirationTime(expiresAt)
    .sign(new TextEncoder().encode(deps.supabaseJwtSecret));

  return {
    supabaseAccessToken: supabaseToken,
    expiresAt,
    sub: payload.sub,
  };
}
