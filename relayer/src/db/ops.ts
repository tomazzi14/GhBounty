import { sql } from "drizzle-orm";
import {
  bountyMeta,
  chainRegistry,
  evaluations,
  issues,
  submissions,
  type Db,
} from "@ghbounty/db";

export interface ChainSeed {
  chainId: string;
  name: string;
  rpcUrl: string;
  escrowAddress: string;
  explorerUrl: string;
  tokenSymbol: string;
  x402Supported?: boolean;
}

export async function seedChain(db: Db, chain: ChainSeed): Promise<void> {
  await db
    .insert(chainRegistry)
    .values({
      chainId: chain.chainId,
      name: chain.name,
      rpcUrl: chain.rpcUrl,
      escrowAddress: chain.escrowAddress,
      explorerUrl: chain.explorerUrl,
      tokenSymbol: chain.tokenSymbol,
      x402Supported: chain.x402Supported ?? false,
    })
    .onConflictDoUpdate({
      target: chainRegistry.chainId,
      set: {
        name: chain.name,
        rpcUrl: chain.rpcUrl,
        escrowAddress: chain.escrowAddress,
        explorerUrl: chain.explorerUrl,
        tokenSymbol: chain.tokenSymbol,
        x402Supported: chain.x402Supported ?? false,
      },
    });
}

export interface UpsertSubmissionInput {
  chainId: string;
  issuePda: string;
  submissionPda: string;
  solver: string;
  submissionIndex: number;
  prUrl: string;
  opusReportHashHex: string;
  txHash?: string;
}

export async function upsertSubmission(
  db: Db,
  input: UpsertSubmissionInput,
): Promise<void> {
  await db
    .insert(submissions)
    .values({
      chainId: input.chainId,
      issuePda: input.issuePda,
      pda: input.submissionPda,
      solver: input.solver,
      submissionIndex: input.submissionIndex,
      prUrl: input.prUrl,
      opusReportHash: input.opusReportHashHex,
      txHash: input.txHash,
      state: "pending",
    })
    .onConflictDoNothing({ target: submissions.pda });
}

export async function markScored(
  db: Db,
  submissionPda: string,
): Promise<void> {
  await db
    .update(submissions)
    .set({
      state: "scored",
      scoredAt: sql`now()`,
    })
    .where(sql`${submissions.pda} = ${submissionPda}`);
}

/**
 * GHB-95: mark a submission as auto-rejected off-chain (score below the
 * issue's reject threshold). Onchain `set_score` is still expected to have
 * run for transparency; this only affects the off-chain UI state.
 */
export async function markAutoRejected(
  db: Db,
  submissionPda: string,
): Promise<void> {
  await db
    .update(submissions)
    .set({
      state: "auto_rejected",
      scoredAt: sql`now()`,
    })
    .where(sql`${submissions.pda} = ${submissionPda}`);
}

/**
 * GHB-95: look up the per-issue reject threshold by the bounty's onchain PDA.
 *
 * Joins `issues` (onchain mirror) → `bounty_meta` (off-chain UI config) using
 * `issues.pda` as the bridge. Returns `null` if either the issue isn't in the
 * relayer DB yet or the company hasn't configured a threshold for it. In both
 * cases the caller treats the submission as a pass (no auto-rejection).
 */
export async function getRejectThreshold(
  db: Db,
  issuePda: string,
): Promise<number | null> {
  const rows = await db
    .select({ threshold: bountyMeta.rejectThreshold })
    .from(bountyMeta)
    .innerJoin(issues, sql`${issues.id} = ${bountyMeta.issueId}`)
    .where(sql`${issues.pda} = ${issuePda}`)
    .limit(1);
  const first = rows[0];
  if (!first) return null;
  return first.threshold ?? null;
}

export interface InsertEvaluationInput {
  submissionPda: string;
  source: "stub" | "opus" | "genlayer";
  score: number;
  reasoning?: string;
  /** Full structured Opus report (4 dims + summary). Pass `null` for stub. */
  report?: unknown;
  /** sha256 hex of canonical-JSON report. Empty/null for stub. */
  reportHash?: string;
  retryCount?: number;
  txHash?: string;
}

export async function insertEvaluation(
  db: Db,
  input: InsertEvaluationInput,
): Promise<void> {
  await db.insert(evaluations).values({
    submissionPda: input.submissionPda,
    source: input.source,
    score: input.score,
    reasoning: input.reasoning,
    report: input.report ?? null,
    reportHash: input.reportHash || null,
    retryCount: input.retryCount ?? 0,
    txHash: input.txHash,
  });
}

export async function issueExists(db: Db, pda: string): Promise<boolean> {
  const rows = await db
    .select({ pda: issues.pda })
    .from(issues)
    .where(sql`${issues.pda} = ${pda}`)
    .limit(1);
  return rows.length > 0;
}
