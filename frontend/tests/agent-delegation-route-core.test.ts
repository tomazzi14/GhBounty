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
  test("returns ok:true on successful upsert", async () => {
    let capturedDelegationTable: unknown;
    let capturedProfileTable: unknown;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "agent_delegations") {
          return {
            upsert: vi.fn().mockImplementation((rows: unknown) => {
              capturedDelegationTable = rows;
              return Promise.resolve({ error: null });
            }),
          };
        }
        if (table === "profiles") {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                is: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    const result = await delegateWallet(supabase, {
      user_id: USER_ID,
      wallet_pubkey: WALLET,
    });

    expect(result.ok).toBe(true);
    expect(capturedDelegationTable).toBeDefined();
  });

  test("defaults chain_type to 'solana'", async () => {
    let capturedRows: unknown;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "agent_delegations") {
          return {
            upsert: vi.fn().mockImplementation((rows: unknown) => {
              capturedRows = rows;
              return Promise.resolve({ error: null });
            }),
          };
        }
        if (table === "profiles") {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                is: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    await delegateWallet(supabase, { user_id: USER_ID, wallet_pubkey: WALLET });

    expect((capturedRows as Record<string, unknown>).chain_type).toBe("solana");
  });

  test("passes chain_type when provided", async () => {
    let capturedRows: unknown;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "agent_delegations") {
          return {
            upsert: vi.fn().mockImplementation((rows: unknown) => {
              capturedRows = rows;
              return Promise.resolve({ error: null });
            }),
          };
        }
        if (table === "profiles") {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                is: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    await delegateWallet(supabase, {
      user_id: USER_ID,
      wallet_pubkey: WALLET,
      chain_type: "ethereum",
    });

    expect((capturedRows as Record<string, unknown>).chain_type).toBe("ethereum");
  });

  test("sets revoked_at to null on upsert", async () => {
    let capturedRows: unknown;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "agent_delegations") {
          return {
            upsert: vi.fn().mockImplementation((rows: unknown) => {
              capturedRows = rows;
              return Promise.resolve({ error: null });
            }),
          };
        }
        if (table === "profiles") {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                is: vi.fn().mockResolvedValue({ error: null }),
              }),
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    await delegateWallet(supabase, { user_id: USER_ID, wallet_pubkey: WALLET });

    expect((capturedRows as Record<string, unknown>).revoked_at).toBeNull();
  });

  test("backfills profiles.wallet_pubkey on delegate", async () => {
    let profileUpdateParams: unknown;
    let profileEqParams: unknown;
    let profileIsParams: unknown;
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "agent_delegations") {
          return {
            upsert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        if (table === "profiles") {
          return {
            update: vi.fn().mockImplementation((upd: unknown) => {
              profileUpdateParams = upd;
              return {
                eq: vi.fn().mockImplementation((col: string, val: string) => {
                  profileEqParams = { col, val };
                  return {
                    is: vi.fn().mockImplementation((col2: string, val2: unknown) => {
                      profileIsParams = { col: col2, val: val2 };
                      return Promise.resolve({ error: null });
                    }),
                  };
                }),
              };
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    await delegateWallet(supabase, {
      user_id: USER_ID,
      wallet_pubkey: WALLET,
    });

    expect(profileUpdateParams).toEqual({ wallet_pubkey: WALLET });
    expect(profileEqParams).toEqual({ col: "user_id", val: USER_ID });
    expect(profileIsParams).toEqual({ col: "wallet_pubkey", val: null });
  });

  test("returns ok:true when profiles update fails (non-fatal)", async () => {
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "agent_delegations") {
          return {
            upsert: vi.fn().mockResolvedValue({ error: null }),
          };
        }
        if (table === "profiles") {
          return {
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                is: vi.fn().mockResolvedValue({ error: { message: "DB err" } }),
              }),
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

    const result = await delegateWallet(supabase, {
      user_id: USER_ID,
      wallet_pubkey: WALLET,
    });

    // Profiles backfill is best-effort — delegation succeeds regardless
    expect(result.ok).toBe(true);
  });

  test("returns ok:false with detail on Supabase error", async () => {
    const supabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === "agent_delegations") {
          return {
            upsert: vi.fn().mockResolvedValue({
              error: { message: "FK violation" },
            }),
          };
        }
        return {};
      }),
    } as unknown as SupabaseClient<Database>;

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
