/**
 * GHB-187 — pure handler for `POST /api/agent-delegation` and
 * `GET /api/agent-delegation`.
 *
 * All logic lives here so tests can drive it without spinning up a
 * Next.js server. The route file at
 * `app/api/agent-delegation/route.ts` is a thin adapter.
 *
 * POST actions:
 *   delegate — upsert a row into `agent_delegations` (wallet_pubkey + chain_type)
 *              and backfills profiles.wallet_pubkey if still null (GHB-110).
 *   revoke   — set revoked_at = now() on the caller's row
 *
 * GET — returns the caller's current delegation row (or null if none).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db.types";

type Supabase = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Delegate
// ---------------------------------------------------------------------------

export interface DelegateInput {
  user_id: string;
  wallet_pubkey: string;
  chain_type?: string;
}

export type DelegateResult =
  | { ok: true }
  | { ok: false; error: "internal"; detail: string };

export async function delegateWallet(
  supabase: Supabase,
  input: DelegateInput,
): Promise<DelegateResult> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("agent_delegations").upsert(
    {
      user_id: input.user_id,
      wallet_pubkey: input.wallet_pubkey,
      chain_type: input.chain_type ?? "solana",
      delegated_at: now,
      revoked_at: null,
      updated_at: now,
    },
    { onConflict: "user_id" },
  );
  if (error) return { ok: false, error: "internal", detail: error.message };

  // GHB-110: backfill profiles.wallet_pubkey if still null, so MCP
  // submissions.create profile checks pass after wallet delegation.
  await supabase
    .from("profiles")
    .update({ wallet_pubkey: input.wallet_pubkey })
    .eq("user_id", input.user_id)
    .is("wallet_pubkey", null);

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

export type RevokeResult =
  | { ok: true }
  | { ok: false; error: "internal"; detail: string };

export async function revokeWallet(
  supabase: Supabase,
  user_id: string,
): Promise<RevokeResult> {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("agent_delegations")
    .update({ revoked_at: now, updated_at: now })
    .eq("user_id", user_id);
  if (error) return { ok: false, error: "internal", detail: error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

export type AgentDelegationRow = Pick<
  Database["public"]["Tables"]["agent_delegations"]["Row"],
  "wallet_pubkey" | "chain_type" | "delegated_at" | "revoked_at"
>;

export type GetDelegationResult =
  | { ok: true; delegation: AgentDelegationRow | null }
  | { ok: false; error: "internal"; detail: string };

export async function getDelegation(
  supabase: Supabase,
  user_id: string,
): Promise<GetDelegationResult> {
  const { data, error } = await supabase
    .from("agent_delegations")
    .select("wallet_pubkey, chain_type, delegated_at, revoked_at")
    .eq("user_id", user_id)
    .maybeSingle();
  if (error) return { ok: false, error: "internal", detail: error.message };
  return { ok: true, delegation: data };
}
