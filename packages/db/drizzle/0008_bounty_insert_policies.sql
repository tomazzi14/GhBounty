-- ============================================================================
-- 0008_bounty_insert_policies.sql
--
-- GHB-80: open up INSERT on `issues` and `submissions` for authenticated
-- users so the frontend can persist a bounty/submission row right after
-- the on-chain `create_bounty` / `submit_solution` tx confirms.
--
-- Architecturally these tables are meant to be written by an off-chain
-- indexer that mirrors Solana program state. Until that indexer exists,
-- the React layer is the indexer — the helpers in `frontend/lib/bounties.ts`
-- (and the future submissions equivalent) call `.insert(...)` directly.
--
-- Integrity isn't lost: the user-facing metadata rows
--   - bounty_meta.created_by_user_id
--   - submission_meta.submitted_by_user_id
-- already gate inserts against `auth.jwt() ->> 'sub'` (migration 0007),
-- so even though the on-chain mirror table is write-open, the rows that
-- the dashboards actually read are user-pinned.
--
-- DELETE is restricted to orphan rows so `insertIssueAndMeta`'s rollback
-- (delete the issue if bounty_meta insert fails) keeps working without
-- exposing a "delete-any-issue" escape hatch to clients.
--
-- This migration is idempotent — safe to re-run.
-- ============================================================================

BEGIN;

-- issues ----------------------------------------------------------------
DROP POLICY IF EXISTS issues_insert_authenticated ON issues;
CREATE POLICY issues_insert_authenticated ON issues
  FOR INSERT TO authenticated
  WITH CHECK (true);

-- Only allow deleting issue rows that have no `bounty_meta` row attached.
-- That's exactly the rollback case in `insertIssueAndMeta`: the issue
-- was created moments ago, the meta insert failed, and now we want to
-- clean up. After a successful create both rows exist together, so the
-- issue becomes undeletable from the client.
DROP POLICY IF EXISTS issues_delete_orphan ON issues;
CREATE POLICY issues_delete_orphan ON issues
  FOR DELETE TO authenticated
  USING (
    NOT EXISTS (
      SELECT 1 FROM bounty_meta WHERE bounty_meta.issue_id = issues.id
    )
  );

-- submissions -----------------------------------------------------------
DROP POLICY IF EXISTS submissions_insert_authenticated ON submissions;
CREATE POLICY submissions_insert_authenticated ON submissions
  FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS submissions_delete_orphan ON submissions;
CREATE POLICY submissions_delete_orphan ON submissions
  FOR DELETE TO authenticated
  USING (
    NOT EXISTS (
      SELECT 1 FROM submission_meta
      WHERE submission_meta.submission_id = submissions.id
    )
  );

COMMIT;
