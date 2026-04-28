/**
 * Unit tests for `lib/privy-bridge-core.ts`.
 *
 * Strategy: generate ephemeral ES256 keypairs locally, sign Privy-shaped
 * JWTs with the private key, hand the public key to `verifyAndMintToken`
 * via the `verifyKey` dep, and assert the minted Supabase token verifies
 * with the test secret. No HTTP, no Privy, no Next runtime.
 */

import { describe, expect, it } from "vitest";
import {
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWTVerifyGetKey,
  type ResolvedKey,
  type JWSHeaderParameters,
  type FlattenedJWSInput,
} from "jose";
import {
  BridgeError,
  PRIVY_ISSUER,
  SUPABASE_AUDIENCE,
  SUPABASE_TOKEN_DEFAULT_TTL_S,
  verifyAndMintToken,
} from "@/lib/privy-bridge-core";

const PRIVY_APP_ID = "cm_test_app_id";
const SUPABASE_JWT_SECRET = "super-secret-please-change-me";
// Pinned at module-load to keep determinism within a single test run, but
// close enough to wall-clock time that jose's `exp`/`nbf` checks pass.
const FIXED_NOW_S = Math.floor(Date.now() / 1000);

interface TestKeys {
  privateKey: CryptoKey;
  resolver: JWTVerifyGetKey;
}

async function makeKeys(): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  // Returning a single static key is sufficient because Privy tokens carry
  // a `kid` we ignore. `jose` expects either a CryptoKey or a getter; we
  // give it a getter so we exercise the same code path the route uses.
  const resolver: JWTVerifyGetKey = async (
    _header: JWSHeaderParameters,
    _input: FlattenedJWSInput,
  ): Promise<ResolvedKey["key"]> => publicKey as unknown as ResolvedKey["key"];
  return { privateKey, resolver };
}

interface SignPrivyOpts {
  sub?: string;
  audience?: string | string[];
  issuer?: string;
  iat?: number;
  exp?: number;
  privateKey: CryptoKey;
}

async function signPrivyToken(opts: SignPrivyOpts): Promise<string> {
  const iat = opts.iat ?? FIXED_NOW_S;
  const exp = opts.exp ?? iat + 600;
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "test-kid" })
    .setIssuer(opts.issuer ?? PRIVY_ISSUER)
    .setSubject(opts.sub ?? "did:privy:cm0testuser")
    .setAudience(opts.audience ?? PRIVY_APP_ID)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(opts.privateKey);
}

function defaultDeps(resolver: JWTVerifyGetKey, now = FIXED_NOW_S) {
  return {
    privyAppId: PRIVY_APP_ID,
    verifyKey: resolver,
    supabaseJwtSecret: SUPABASE_JWT_SECRET,
    now: () => now,
    ttlSeconds: SUPABASE_TOKEN_DEFAULT_TTL_S,
  };
}

describe("verifyAndMintToken — happy path", () => {
  it("verifies a valid Privy token and mints an HS256 Supabase token", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({ privateKey });

    const result = await verifyAndMintToken(privyToken, defaultDeps(resolver));

    expect(result.sub).toBe("did:privy:cm0testuser");
    expect(result.expiresAt).toBe(FIXED_NOW_S + SUPABASE_TOKEN_DEFAULT_TTL_S);
    expect(result.supabaseAccessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("preserves the Privy `sub` as the Supabase token `sub`", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({
      privateKey,
      sub: "did:privy:abc123",
    });

    const result = await verifyAndMintToken(privyToken, defaultDeps(resolver));

    const verified = await jwtVerify(
      result.supabaseAccessToken,
      new TextEncoder().encode(SUPABASE_JWT_SECRET),
      { audience: SUPABASE_AUDIENCE },
    );
    expect(verified.payload.sub).toBe("did:privy:abc123");
  });

  it("sets the Supabase token role to 'authenticated'", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({ privateKey });

    const result = await verifyAndMintToken(privyToken, defaultDeps(resolver));

    const verified = await jwtVerify(
      result.supabaseAccessToken,
      new TextEncoder().encode(SUPABASE_JWT_SECRET),
      { audience: SUPABASE_AUDIENCE },
    );
    expect(verified.payload.role).toBe("authenticated");
  });

  it("respects a custom TTL", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({ privateKey });

    const result = await verifyAndMintToken(privyToken, {
      ...defaultDeps(resolver),
      ttlSeconds: 30,
    });

    expect(result.expiresAt).toBe(FIXED_NOW_S + 30);
  });

  it("uses the injected `now` clock, not Date.now()", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({ privateKey });

    const result = await verifyAndMintToken(privyToken, {
      ...defaultDeps(resolver),
      now: () => 1234567,
    });

    expect(result.expiresAt).toBe(1234567 + SUPABASE_TOKEN_DEFAULT_TTL_S);
  });

  it("forwards Privy `aud` into a `privy_aud` claim", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({ privateKey });

    const result = await verifyAndMintToken(privyToken, defaultDeps(resolver));

    const verified = await jwtVerify(
      result.supabaseAccessToken,
      new TextEncoder().encode(SUPABASE_JWT_SECRET),
      { audience: SUPABASE_AUDIENCE },
    );
    expect(verified.payload.privy_aud).toBe(PRIVY_APP_ID);
  });

  it("issues with `privy-bridge` as the iss claim", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({ privateKey });

    const result = await verifyAndMintToken(privyToken, defaultDeps(resolver));

    const verified = await jwtVerify(
      result.supabaseAccessToken,
      new TextEncoder().encode(SUPABASE_JWT_SECRET),
      { audience: SUPABASE_AUDIENCE },
    );
    expect(verified.payload.iss).toBe("privy-bridge");
  });
});

describe("verifyAndMintToken — input validation", () => {
  it("throws BridgeError(400) when the privy token is empty", async () => {
    const { resolver } = await makeKeys();
    await expect(
      verifyAndMintToken("", defaultDeps(resolver)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("throws BridgeError(500) when privyAppId is empty", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({ privateKey });
    await expect(
      verifyAndMintToken(privyToken, {
        ...defaultDeps(resolver),
        privyAppId: "",
      }),
    ).rejects.toMatchObject({ status: 500, message: /privyAppId/ });
  });

  it("throws BridgeError(500) when the Supabase secret is empty", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({ privateKey });
    await expect(
      verifyAndMintToken(privyToken, {
        ...defaultDeps(resolver),
        supabaseJwtSecret: "",
      }),
    ).rejects.toMatchObject({ status: 500, message: /supabaseJwtSecret/ });
  });
});

describe("verifyAndMintToken — JWT verification", () => {
  it("rejects a tampered signature", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({ privateKey });
    // Flip the FIRST char of the signature segment so the bits change
    // unambiguously (last-char tricks can still verify under base64url
    // padding edge cases).
    const parts = privyToken.split(".");
    const sig = parts[2]!;
    parts[2] = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const tampered = parts.join(".");
    await expect(
      verifyAndMintToken(tampered, defaultDeps(resolver)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a token signed with a different keypair", async () => {
    const { resolver } = await makeKeys();
    const { privateKey: foreignKey } = await makeKeys();
    const privyToken = await signPrivyToken({ privateKey: foreignKey });
    await expect(
      verifyAndMintToken(privyToken, defaultDeps(resolver)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects when the issuer is not 'privy.io'", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({
      privateKey,
      issuer: "evil.example.com",
    });
    await expect(
      verifyAndMintToken(privyToken, defaultDeps(resolver)),
    ).rejects.toMatchObject({ status: 401, message: /verification failed/i });
  });

  it("rejects when audience does not match privyAppId", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({
      privateKey,
      audience: "some-other-app",
    });
    await expect(
      verifyAndMintToken(privyToken, defaultDeps(resolver)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects an expired token", async () => {
    const { privateKey, resolver } = await makeKeys();
    const privyToken = await signPrivyToken({
      privateKey,
      iat: FIXED_NOW_S - 7200,
      exp: FIXED_NOW_S - 3600,
    });
    await expect(
      verifyAndMintToken(privyToken, defaultDeps(resolver)),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rejects garbage that doesn't even parse as JWT", async () => {
    const { resolver } = await makeKeys();
    await expect(
      verifyAndMintToken("not.a.token.at.all", defaultDeps(resolver)),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe("verifyAndMintToken — sub claim safety", () => {
  it("preserves the sub character-for-character (no encoding tricks)", async () => {
    const { privateKey, resolver } = await makeKeys();
    const weirdSub = "did:privy:abc-DEF_123:test";
    const privyToken = await signPrivyToken({ privateKey, sub: weirdSub });

    const result = await verifyAndMintToken(privyToken, defaultDeps(resolver));

    expect(result.sub).toBe(weirdSub);
    const verified = await jwtVerify(
      result.supabaseAccessToken,
      new TextEncoder().encode(SUPABASE_JWT_SECRET),
      { audience: SUPABASE_AUDIENCE },
    );
    expect(verified.payload.sub).toBe(weirdSub);
  });
});

describe("BridgeError", () => {
  it("carries the status code as a public field", () => {
    const err = new BridgeError(418, "I'm a teapot");
    expect(err.status).toBe(418);
    expect(err.message).toBe("I'm a teapot");
    expect(err.name).toBe("BridgeError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("constants", () => {
  it("exports the expected Privy issuer", () => {
    expect(PRIVY_ISSUER).toBe("privy.io");
  });

  it("exports the expected Supabase audience", () => {
    expect(SUPABASE_AUDIENCE).toBe("authenticated");
  });

  it("exports a 1-hour default TTL", () => {
    expect(SUPABASE_TOKEN_DEFAULT_TTL_S).toBe(3600);
  });
});
