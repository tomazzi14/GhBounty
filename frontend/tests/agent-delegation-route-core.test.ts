/**
 * GHB-187 — tests for `lib/agent-delegation-route-core.ts`.
 *
 * Tests the three exported functions:
 *   - delegateWallet(supabase, input)
 *   - revokeWallet(supabase, user_id)
 *   - getDelegation(supabase, user_id)
 *
 * Uses hand-rolled Supabase mocks (no network), following the same
 * pattern as api-keys-route-core.test.ts.
 */

import { describe, expect, test, vi } from "vitest";
import {
  delegateWallet,
  revokeWallet,
  getDelegation,
} from "@/lib/agent-delegation-route-core";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db.types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = "did:privy:test_user";
const WALLET = "BPFLoaderUpgradeab1e11111111111111111111111";
const NOW = "2026-05-18T00:00:00.000Z";

type DelegationRow =
  Database["public"]["Tables"]["agent_delegations"]["Row"];

// ---------------------------------------------------------------------------
// delegateWallet
// ---------------------------------------------------------------------------

describe("delegateWallet", () => {
  /**
   * Helper: build a Supabase mock whose `from()` returns the right chain
   * for "agent_delegations" (upsert) and "profiles" (update → eq → is).
   */
  function makeMock(opts: {
    upsertError?: { message: string };
    updateError?: { message: string };
  } = {}) {
    const upsertSpy = vi.fn().mockResolvedValue({
      error: opts.upsertError ?? null,
    });
    const isSpy = vi.fn().mockResolvedValue({
      error: opts.updateError ?? null,
    });
    const eqSpy = vi.fn().mockReturnValue({ is: isSpy });
    const updateSpy = vi.fn().mockReturnValue({ eq: eqSpy });

    const fromSpy = vi.fn().mockImplementation((table: string) => {
      if (table === "profiles") {
        return { update: updateSpy };
      }
      return { upsert: upsertSpy };
    });

    return { fromSpy, upsertSpy, updateSpy, eqSpy, isSpy };
  }

  function wrap(fromSpy: ReturnType<typeof makeMock>["fromSpy"]) {
    return { from: fromSpy } as unknown as SupabaseClient<Database>;
  }

  test("returns ok:true on successful upsert", async () => {
    const m = makeMock();
    const supabase = wrap(m.fromSpy);

    const result = await delegateWallet(supabase, {
      user_id: USER_ID,
      wallet_pubkey: WALLET,
    });

    expect(result.ok).toBe(true);
    expect(m.fromSpy).toHaveBeenCalledWith("agent_delegations");
  });

  test("defaults chain_type to 'solana'", async () => {
    const m = makeMock();
    const supabase = wrap(m.fromSpy);

    await delegateWallet(supabase, { user_id: USER_ID, wallet_pubkey: WALLET });

    const capturedRows = m.upsertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(capturedRows.chain_type).toBe("solana");
  });

  test("passes chain_type when provided", async () => {
    const m = makeMock();
    const supabase = wrap(m.fromSpy);

    await delegateWallet(supabase, {
      user_id: USER_ID,
      wallet_pubkey: WALLET,
      chain_type: "ethereum",
    });

    const capturedRows = m.upsertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(capturedRows.chain_type).toBe("ethereum");
  });

  test("sets revoked_at to null on upsert", async () => {
    const m = makeMock();
    const supabase = wrap(m.fromSpy);

    await delegateWallet(supabase, { user_id: USER_ID, wallet_pubkey: WALLET });

    const capturedRows = m.upsertSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(capturedRows.revoked_at).toBeNull();
  });

  test("returns ok:false with detail on Supabase error", async () => {
    const m = makeMock({ upsertError: { message: "FK violation" } });
    const supabase = wrap(m.fromSpy);

    const result = await delegateWallet(supabase, {
      user_id: USER_ID,
      wallet_pubkey: WALLET,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("internal");
      expect(result.detail).toBe("FK violation");
    }
  });

  // -------------------------------------------------------------------------
  // GHB-110: profiles.wallet_pubkey backfill
  // -------------------------------------------------------------------------

  test("backfills profiles.wallet_pubkey after successful delegation", async () => {
    const m = makeMock();
    const supabase = wrap(m.fromSpy);

    await delegateWallet(supabase, { user_id: USER_ID, wallet_pubkey: WALLET });

    expect(m.fromSpy).toHaveBeenCalledWith("profiles");
    expect(m.updateSpy).toHaveBeenCalledWith({
      wallet_pubkey: WALLET,
      updated_at: expect.any(String),
    });
  });

  test("scopes backfill to user_id and null wallet_pubkey only", async () => {
    const m = makeMock();
    const supabase = wrap(m.fromSpy);

    await delegateWallet(supabase, { user_id: USER_ID, wallet_pubkey: WALLET });

    expect(m.eqSpy).toHaveBeenCalledWith("user_id", USER_ID);
    expect(m.isSpy).toHaveBeenCalledWith("wallet_pubkey", null);
  });

  test("still returns ok:true even if backfill update fails", async () => {
    const m = makeMock({ updateError: { message: "RLS denied" } });
    const supabase = wrap(m.fromSpy);

    const result = await delegateWallet(supabase, {
      user_id: USER_ID,
      wallet_pubkey: WALLET,
    });

    // Delegation itself succeeded; backfill is best-effort.
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// revokeWallet
// ---------------------------------------------------------------------------

describe("revokeWallet", () => {
  test("returns ok:true on successful update", async () => {
    const eqFn = vi.fn().mockResolvedValue({ error: null });
    const supabase = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({ eq: eqFn }),
      }),
    } as unknown as SupabaseClient<Database>;

    const result = await revokeWallet(supabase, USER_ID);

    expect(result.ok).toBe(true);
    expect(eqFn).toHaveBeenCalledWith("user_id", USER_ID);
  });

  test("returns ok:false with detail on Supabase error", async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: { message: "DB error" } }),
        }),
      }),
    } as unknown as SupabaseClient<Database>;

    const result = await revokeWallet(supabase, USER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("internal");
      expect(result.detail).toBe("DB error");
    }
  });
});

// ---------------------------------------------------------------------------
// getDelegation
// ---------------------------------------------------------------------------

describe("getDelegation", () => {
  test("returns delegation row when found", async () => {
    const row: Partial<DelegationRow> = {
      wallet_pubkey: WALLET,
      chain_type: "solana",
      delegated_at: NOW,
      revoked_at: null,
    };

    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient<Database>;

    const result = await getDelegation(supabase, USER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation).not.toBeNull();
      expect(result.delegation?.wallet_pubkey).toBe(WALLET);
      expect(result.delegation?.chain_type).toBe("solana");
      expect(result.delegation?.revoked_at).toBeNull();
    }
  });

  test("returns null delegation when no row exists", async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          }),
        }),
      }),
    } as unknown as SupabaseClient<Database>;

    const result = await getDelegation(supabase, USER_ID);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.delegation).toBeNull();
    }
  });

  test("returns ok:false with detail on Supabase error", async () => {
    const supabase = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: null,
              error: { message: "query failed" },
            }),
          }),
        }),
      }),
    } as unknown as SupabaseClient<Database>;

    const result = await getDelegation(supabase, USER_ID);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("internal");
      expect(result.detail).toBe("query failed");
    }
  });
});
