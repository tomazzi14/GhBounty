/**
 * GHB-165: Privy → Supabase JWT bridge.
 *
 * Thin route wrapper. All the verification + signing logic lives in
 * `lib/privy-bridge-core.ts` so it can be tested without spinning up
 * a Next.js server or stubbing the runtime.
 */

import { NextResponse } from "next/server";
import { createRemoteJWKSet } from "jose";
import {
  BridgeError,
  SUPABASE_TOKEN_DEFAULT_TTL_S,
  verifyAndMintToken,
} from "@/lib/privy-bridge-core";

export const runtime = "nodejs";

const PRIVY_APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? "";

const PRIVY_JWKS_URL = PRIVY_APP_ID
  ? new URL(`https://auth.privy.io/api/v1/apps/${PRIVY_APP_ID}/jwks.json`)
  : null;

// `createRemoteJWKSet` caches the response per its HTTP cache headers, so
// the actual HTTP fetch happens at most once per Privy key-rotation window.
const privyJWKS = PRIVY_JWKS_URL ? createRemoteJWKSet(PRIVY_JWKS_URL) : null;

interface BridgeBody {
  privyAccessToken?: string;
}

export async function POST(req: Request) {
  if (!PRIVY_APP_ID || !privyJWKS) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_PRIVY_APP_ID is not configured" },
      { status: 500 },
    );
  }
  if (!SUPABASE_JWT_SECRET) {
    return NextResponse.json(
      { error: "SUPABASE_JWT_SECRET is not configured" },
      { status: 500 },
    );
  }

  let body: BridgeBody;
  try {
    body = (await req.json()) as BridgeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = body.privyAccessToken?.trim() ?? "";

  try {
    const minted = await verifyAndMintToken(token, {
      privyAppId: PRIVY_APP_ID,
      verifyKey: privyJWKS,
      supabaseJwtSecret: SUPABASE_JWT_SECRET,
      now: () => Math.floor(Date.now() / 1000),
      ttlSeconds: SUPABASE_TOKEN_DEFAULT_TTL_S,
    });
    return NextResponse.json(minted);
  } catch (err) {
    if (err instanceof BridgeError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 },
    );
  }
}
