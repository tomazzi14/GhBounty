/**
 * submissions.create (a.k.a. submit_pr) — GHB-187
 *
 * Lets an AI agent submit a PR on-chain as a bounty solution. Full flow:
 *   auth → role guard (dev) → delegation guard → load bounty
 *   → idempotency check → verifyPrOwnership (GHB-182 pre-check) → verifyPrRelevance (GHB-108 pre-check)
 *   → fetch blockhash → build submit_solution tx (Task 7)
 *   → Privy signs as solver (Task 6) → SolanaGasStation signs + submits
 *   → insert mirror row in DB → return result
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authenticate } from "@/lib/auth/middleware";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { mcpError } from "@/lib/errors";
import { getChainId } from "@/lib/config";
import { requireRole } from "@/lib/tools/role-guard";
import { requireWalletDelegated } from "@/lib/tools/delegation-guard";
import { verifyPrOwnership, verifyPrRelevance } from "@ghbounty/shared";
import {
  getPrivyServerClient,
  signSolanaTransaction,
} from "@/lib/privy/delegated-signer";
import { buildSubmitSolutionTx } from "@/lib/solana/build-submit-solution-tx";
import { solanaRpc } from "@/lib/solana/rpc";
import { submitSponsoredTx } from "@/lib/gas-station/server";

const CreateInput = z.object({
  authorization: z.string().optional(),
  bounty_id: z.string().uuid(),
  pr_url: z.string().url().max(200),
});

/**
 * Extract the repo URL (https://github.com/owner/repo) from a GitHub
 * issue URL. Returns null if the URL doesn't match the expected pattern.
 */
function parseRepoUrl(githubIssueUrl: string): string | null {
  const m = githubIssueUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\//);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

/** 32 zero bytes encoded as a 64-char hex string — matches the `text` column type. */
const ZERO_OPUS_HASH = "0".repeat(64);

export async function handleSubmissionsCreate(raw: unknown) {
  const parsed = CreateInput.safeParse(raw);
  if (!parsed.success) {
    return { error: mcpError("InvalidInput", parsed.error.message) };
  }

  // --- Auth ---
  const auth = await authenticate(parsed.data.authorization);
  if (!auth.ok) return { error: auth.error };

  // --- Role guard (dev only) ---
  const roleCheck = requireRole(auth.profile, "dev");
  if (!roleCheck.ok) {
    return { error: mcpError("Forbidden", roleCheck.error.message) };
  }

  // --- Profile completeness checks ---
  if (auth.profile.mcp_status !== "active") {
    return {
      error: mcpError("Forbidden", "Account is not active."),
    };
  }
  if (!auth.profile.wallet_pubkey) {
    return {
      error: mcpError("Forbidden", "Profile has no wallet pubkey."),
    };
  }
  if (!auth.profile.github_handle) {
    return {
      error: mcpError("Forbidden", "Profile has no linked GitHub handle."),
    };
  }

  const supabase = supabaseAdmin();

  // --- Delegation guard ---
  const delegationCheck = await requireWalletDelegated(
    supabase,
    auth.profile.user_id
  );
  if (!delegationCheck.ok) {
    return { error: mcpError("Forbidden", delegationCheck.error.message) };
  }

  // --- Load bounty ---
  const { data: bounty, error: bountyErr } = await supabase
    .from("issues")
    .select("id, pda, github_issue_url, state, submission_count, chain_id")
    .eq("id", parsed.data.bounty_id)
    .maybeSingle();

  if (bountyErr) return { error: mcpError("InternalError", bountyErr.message) };
  if (!bounty) return { error: mcpError("NotFound", "Bounty not found") };

  const b = bounty as any;

  // --- Idempotency check: (solver, issue_pda, pr_url) — BEFORE state check ---
  // A retry after the bounty closes must get idempotent success, not 409 Conflict.
  const { data: existing } = await supabase
    .from("submissions")
    .select("id, state")
    .eq("solver", auth.profile.wallet_pubkey)
    .eq("issue_pda", b.pda)
    .eq("pr_url", parsed.data.pr_url)
    .maybeSingle();

  if (existing) {
    const ex = existing as any;
    return {
      submission_id: ex.id,
      status: ex.state,
      tx_signature: null,
      idempotent: true,
    };
  }

  // --- State check AFTER idempotency ---
  if (b.state !== "open") {
    return {
      error: mcpError("Conflict", `Bounty is ${b.state}.`),
    };
  }

  const repoUrl = parseRepoUrl(b.github_issue_url);
  if (!repoUrl) {
    return {
      error: mcpError(
        "InternalError",
        "Could not parse bounty repo URL."
      ),
    };
  }

  // --- PR ownership pre-check (GHB-182) ---
  const verify = await verifyPrOwnership({
    prUrl: parsed.data.pr_url,
    expectedGithubHandle: auth.profile.github_handle,
    expectedRepoUrl: repoUrl,
    token: process.env.GITHUB_TOKEN,
  });
  if (!verify.ok) {
    // Transient failures (rate_limited, upstream_error) → ServiceUnavailable so
    // the agent retries. Permanent failures (author_mismatch, wrong_repo, etc.)
    // → Forbidden so the agent gives up.
    const code =
      verify.reason === "rate_limited" || verify.reason === "upstream_error"
        ? "ServiceUnavailable"
        : "Forbidden";
    return {
      error: mcpError(code, `PR ownership check failed: ${verify.reason}`),
    };
  }

  // --- PR relevance check (GHB-108) ---
  // Verify the PR body references the bounty issue (e.g. "Fixes #67") so we
  // don't auto-detect the wrong bounty for a PR. Soft-fail on transient errors
  // so a rate limit doesn't block legitimate submissions.
  const relevance = await verifyPrRelevance({
    prUrl: parsed.data.pr_url,
    bountyIssueUrl: b.github_issue_url,
    token: process.env.GITHUB_TOKEN,
  });
  if (!relevance.ok) {
    if (relevance.reason === "no_issue_reference") {
      // No "Fixes #N" found in PR body — reject with a clear message so
      // the submitter knows to update the PR body.
      return {
        error: mcpError(
          "Forbidden",
          `PR body must reference the bounty issue with "Fixes #${b.github_issue_url.split('/').pop()}" or "Closes #N". Update your PR description and retry.`
        ),
      };
    }
    if (relevance.reason === "issue_number_mismatch") {
      return {
        error: mcpError(
          "Forbidden",
          "PR body references a different issue number than the bounty. Check that your PR description references the correct issue."
        ),
      };
    }
    // rate_limited / upstream_error → ServiceUnavailable so the agent retries
    const code = "ServiceUnavailable";
    return {
      error: mcpError(code, `PR relevance check failed: ${relevance.reason}`),
    };
  }

  // --- Fetch latest blockhash ---
  const rpc = solanaRpc();
  const blockhashResp = await (rpc as any).getLatestBlockhash().send();
  const blockhash: string = blockhashResp.value.blockhash;

  // --- Build submit_solution transaction (Task 7) ---
  const gasStationPubkey = process.env.GAS_STATION_PUBKEY;
  if (!gasStationPubkey) {
    return {
      error: mcpError("InternalError", "GAS_STATION_PUBKEY not configured."),
    };
  }

  const built = await buildSubmitSolutionTx({
    rpcUrl: process.env.SOLANA_RPC_URL ?? "",
    bountyPda: b.pda,
    solver: auth.profile.wallet_pubkey,
    gasStationPubkey,
    prUrl: parsed.data.pr_url,
    submissionCount: b.submission_count ?? 0,
    blockhash,
  });

  // --- Privy delegated signing (Task 6) ---
  //
  // We pass the on-chain pubkey as `walletAddress`. The signer resolves it
  // to Privy's internal wallet id via getWalletByAddress before signing.
  const privyClient = getPrivyServerClient();
  const signed = await signSolanaTransaction(privyClient, {
    walletAddress: auth.profile.wallet_pubkey,
    unsignedTx: built.unsignedTx,
  });

  if (!signed.ok) {
    if (signed.reason === "delegation_revoked") {
      // Mark delegation revoked so future calls fast-fail cleanly.
      await supabase
        .from("agent_delegations")
        .update({ revoked_at: new Date().toISOString() })
        .eq("user_id", auth.profile.user_id);
      return {
        error: mcpError(
          "Forbidden",
          "Wallet delegation revoked — re-authorize at /app/credentials."
        ),
      };
    }
    return {
      error: mcpError(
        "ServiceUnavailable",
        "Signing service temporarily unavailable."
      ),
    };
  }

  // --- Gas station signs as fee payer + submits on-chain ---
  const submission = await submitSponsoredTx(signed.signedTx);
  if (!submission.ok) {
    return {
      error: mcpError(
        "InternalError",
        `On-chain submission failed: ${submission.reason}`
      ),
    };
  }

  // --- Insert mirror row in DB ---
  // opus_report_hash is a text column — store as 64-char hex of 32 zero bytes.
  // The relayer back-fills the real hash after scoring.
  //
  // We use upsert with ignoreDuplicates to handle the race where the relayer's
  // on-chain watcher inserts the same row before we do. Without this, the insert
  // would error and we'd fall into the mirror_insert_failed branch even though
  // the row exists.
  // NOTE: integration test for the upsert race is not included — the conflict
  // branch is hard to mock cleanly; rely on the relayer smoke test instead.
  const chainId = b.chain_id ?? getChainId();
  const { data: insertRow, error: insertErr } = await supabase
    .from("submissions")
    .upsert(
      {
        pda: built.submissionPda,
        chain_id: chainId,
        solver: auth.profile.wallet_pubkey,
        pr_url: parsed.data.pr_url,
        issue_pda: b.pda,
        submission_index: built.submissionIndex,
        opus_report_hash: ZERO_OPUS_HASH,
        tx_hash: submission.signature,
        state: "pending",
      },
      { onConflict: "pda", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle();

  if (insertErr) {
    // Genuine error (not a conflict) — on-chain tx succeeded so return the
    // signature anyway; the relayer's watcher will reconcile the DB row later.
    return {
      submission_id: null,
      status: "pending",
      tx_signature: submission.signature,
      submission_pda: built.submissionPda,
      mirror_insert_failed: true,
    };
  }

  if (!insertRow) {
    // Upsert ignored the duplicate — the relayer raced us and inserted first.
    // Fetch the existing row by pda + solver so we can return its id.
    const { data: existingRow } = await supabase
      .from("submissions")
      .select("id")
      .eq("pda", built.submissionPda)
      .eq("solver", auth.profile.wallet_pubkey)
      .maybeSingle();
    return {
      submission_id: (existingRow as any)?.id ?? null,
      status: "pending",
      tx_signature: submission.signature,
      submission_pda: built.submissionPda,
    };
  }

  return {
    submission_id: (insertRow as any).id,
    status: "pending",
    tx_signature: submission.signature,
    submission_pda: built.submissionPda,
  };
}

export function registerSubmissionsCreate(server: McpServer): void {
  server.tool(
    "submissions.create",
    {
      bounty_id: z.string().uuid(),
      pr_url: z.string().url().max(200),
    },
    async (input, extra) => {
      const authorization = (extra as any)?.requestInfo?.headers?.authorization;
      const result = await handleSubmissionsCreate({ ...input, authorization });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
