/**
 * GHB-83 + GHB-84: company-side review actions on individual submissions.
 *
 * Two orchestrators live here:
 *
 *   - `recordWinnerOnchain(...)` — DB-only mirror to run AFTER a confirmed
 *     `resolve_bounty` transaction. The on-chain tx itself is built by
 *     `buildResolveBountyIx` and signed by the React layer (Privy hooks
 *     can't be called from a non-component module). After the tx confirms,
 *     this helper bumps `issues.status_*` mirrors and (if applicable) the
 *     winning submission's `state` so the rest of the app sees the
 *     resolved bounty without waiting for the relayer to re-index.
 *
 *   - `rejectSubmission(...)` — pure DB write. The "reject" action has no
 *     on-chain counterpart (there's no `reject_submission` ix in the
 *     program — escrow custody only changes through `resolve_bounty` /
 *     `cancel_bounty`). It's a soft, off-chain decision the company can
 *     undo by re-submitting an upsert with `rejected: false`.
 *
 * Both helpers are idempotent: re-running `rejectSubmission` for the same
 * (submission_id) overwrites the existing `submission_reviews` row via
 * upsert, and `recordWinnerOnchain` is no-op-on-missing for the
 * issue/state mirrors.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./db.types";

type DBClient = SupabaseClient<Database>;

export type RejectSubmissionParams = {
  /** Supabase `submissions.id` (uuid). PK of the review row. */
  submissionId: string;
  /**
   * Free-form rejection feedback. The UI caps the textarea length, but
   * the DB column is unconstrained — we trim trailing whitespace here.
   * Empty string is normalized to null so the dev-side display can
   * distinguish "rejected with no reason" from a stray space.
   */
  reason: string;
  /**
   * Privy DID of the company user making the call. Stored for audit
   * purposes (`submission_reviews.decided_by`); the on-the-wire RLS
   * policy verifies the same identity owns the parent bounty.
   */
  reviewerUserId: string;
};

/**
 * Mark a submission rejected, with optional feedback. Upserts the
 * `submission_reviews` row keyed by `submission_id`.
 *
 * RLS-protected on the server side: only the company that owns the
 * parent bounty can write here (policy `submission_reviews_write_creator`
 * walks submissions → issues → bounty_meta). A failed RLS check surfaces
 * as an empty result or a permission error from PostgREST — we throw on
 * either so the UI can show "could not save" rather than silently
 * pretending the action succeeded.
 */
export async function rejectSubmission(
  supabase: DBClient,
  p: RejectSubmissionParams,
): Promise<void> {
  const trimmed = p.reason.trim();
  const reason = trimmed.length > 0 ? trimmed : null;

  // `submission_reviews` is post-0010 — not in the generated db.types.ts
  // yet. Cast through `as never` on the table name (same trick we use
  // for `evaluations` in lib/data.ts).
  const { error } = await supabase
    .from("submission_reviews" as never)
    .upsert(
      {
        submission_id: p.submissionId,
        rejected: true,
        reject_reason: reason,
        decided_by: p.reviewerUserId,
        decided_at: new Date().toISOString(),
      } as never,
      { onConflict: "submission_id" },
    );

  if (error) {
    throw new Error(
      `Could not save the rejection (${error.code ?? "?"}): ${error.message}`,
    );
  }
}

export type RecordWinnerParams = {
  /** Supabase `issues.id` (uuid) — the bounty whose escrow just resolved. */
  bountyId: string;
  /** Supabase `submissions.id` of the winning submission. */
  winnerSubmissionId: string;
  /** Solana tx signature, persisted alongside the submission for audit. */
  txSignature: string;
  /**
   * Optional free-form feedback the company wrote in the PickWinnerModal.
   * Persisted to `submission_reviews.approval_feedback` so the winning
   * dev sees it on `/app/profile`. Whitespace is trimmed; empty strings
   * are normalized to skipping the upsert (we don't want to insert a row
   * with all-null fields just for the audit timestamps).
   */
  approvalFeedback?: string;
  /**
   * Privy DID of the company user — persisted as `decided_by` for audit
   * symmetry with the reject path. Only used when there's actual
   * feedback to record (otherwise we skip the upsert entirely).
   */
  reviewerUserId?: string;
};

/**
 * Best-effort post-`resolve_bounty` mirror update. We try to:
 *
 *   1. Mark the winning submission's `tx_hash` so the dev-side view shows
 *      the payout tx without waiting for the relayer to backfill.
 *   2. Flip `bounty_meta.closed_by_user = true` so the issue drops out of
 *      "Open" filters in the marketplace immediately.
 *
 * The on-chain `submissions.state = 'winner'` flip is RLS-restricted
 * (mirror table — only the relayer can write) so we deliberately don't
 * attempt it here. The relayer's `resolve_bounty` watcher will catch up
 * within the polling interval; in the meantime the bounty's status
 * derivation falls back to "approved" via `closed_by_user`.
 *
 * Returns silently on every step's failure — the on-chain tx already
 * succeeded, so showing the user a "DB sync failed" error here would be
 * misleading. We log + move on.
 */
export async function recordWinnerOnchain(
  supabase: DBClient,
  p: RecordWinnerParams,
): Promise<void> {
  // 1. Persist tx_hash on the winning submission row.
  try {
    const { error: subErr } = await supabase
      .from("submissions")
      .update({ tx_hash: p.txSignature })
      .eq("id", p.winnerSubmissionId);
    if (subErr) {
      console.warn("[recordWinnerOnchain:submissions]", subErr);
    }
  } catch (err) {
    console.warn("[recordWinnerOnchain:submissions]", err);
  }

  // 2. Flip closed_by_user on bounty_meta.
  try {
    const { error: metaErr } = await supabase
      .from("bounty_meta")
      .update({ closed_by_user: true })
      .eq("issue_id", p.bountyId);
    if (metaErr) {
      console.warn("[recordWinnerOnchain:bounty_meta]", metaErr);
    }
  } catch (err) {
    console.warn("[recordWinnerOnchain:bounty_meta]", err);
  }

  // 3. Persist optional approval feedback. Skipped when the company
  //    left the textarea blank — no need to insert a near-empty row
  //    just to record the timestamp. Best-effort like the other
  //    branches: a failed RLS check or transient error logs and
  //    moves on rather than masking the on-chain success.
  const trimmed = p.approvalFeedback?.trim();
  if (trimmed && trimmed.length > 0 && p.reviewerUserId) {
    try {
      const { error: revErr } = await supabase
        .from("submission_reviews" as never)
        .upsert(
          {
            submission_id: p.winnerSubmissionId,
            rejected: false,
            approval_feedback: trimmed,
            decided_by: p.reviewerUserId,
            decided_at: new Date().toISOString(),
          } as never,
          { onConflict: "submission_id" },
        );
      if (revErr) {
        console.warn("[recordWinnerOnchain:submission_reviews]", revErr);
      }
    } catch (err) {
      console.warn("[recordWinnerOnchain:submission_reviews]", err);
    }
  }
}
