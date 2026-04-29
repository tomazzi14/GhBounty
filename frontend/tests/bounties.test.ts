/**
 * GHB-80: unit tests for the Supabase persistence helpers.
 *
 * No real network calls — we mock the chained `from(...).insert(...).select(...).single()`
 * and `from(...).select(...).eq(...).order(...)` builders with a tiny stub
 * that records every call and returns canned responses.
 */
import { describe, it, expect } from "vitest";
import { insertIssueAndMeta, listMyIssues } from "@/lib/bounties";

type Call = { table: string; op: string; args?: unknown };

type MockOpts = {
  issueResult?: { data: { id: string } | null; error: { message: string } | null };
  metaResult?: { error: { message: string } | null };
  listResult?: { data: unknown[] | null; error: { message: string } | null };
};

function makeSupabase(opts: MockOpts = {}) {
  const calls: Call[] = [];
  const supabase = {
    calls,
    from(table: string) {
      return {
        insert(args: unknown) {
          calls.push({ table, op: "insert", args });
          if (table === "issues") {
            const r = opts.issueResult ?? {
              data: { id: "00000000-0000-0000-0000-000000000001" },
              error: null,
            };
            return {
              select: (_cols: string) => ({
                single: async () => r,
              }),
            };
          }
          if (table === "bounty_meta") {
            const r = opts.metaResult ?? { error: null };
            return Promise.resolve(r);
          }
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            eq: async (col: string, v: unknown) => {
              calls.push({ table, op: "delete", args: { col, v } });
              return { error: null };
            },
          };
        },
        select(_cols: string) {
          return {
            eq: (_col: string, _v: unknown) => ({
              order: async (_col2: string, _opts2: unknown) => {
                calls.push({ table, op: "select" });
                return opts.listResult ?? { data: [], error: null };
              },
            }),
          };
        },
      };
    },
  };
  return supabase;
}

const baseParams = {
  chainId: "solana-devnet",
  pda: "PDApda",
  bountyOnchainId: 42n,
  creator: "Creator123",
  scorer: "Scorer123",
  mint: "11111111111111111111111111111111",
  amount: 100_000_000n,
  githubIssueUrl: "https://github.com/o/r/issues/1",
  releaseMode: "auto" as const,
  createdByUserId: "did:privy:abc",
};

describe("insertIssueAndMeta", () => {
  it("returns the new issue id and inserts in both tables in order", async () => {
    const supabase = makeSupabase();
    const result = await insertIssueAndMeta(supabase as never, baseParams);
    expect(result.issueId).toBe("00000000-0000-0000-0000-000000000001");

    const inserts = supabase.calls
      .filter((c) => c.op === "insert")
      .map((c) => c.table);
    expect(inserts).toEqual(["issues", "bounty_meta"]);
  });

  it("stringifies bigint columns to dodge the JS 53-bit cap", async () => {
    const supabase = makeSupabase();
    await insertIssueAndMeta(supabase as never, {
      ...baseParams,
      bountyOnchainId: 9_999_999_999_999_999n,
      amount: 18_446_744_073_709_551_614n,
    });
    const issuesInsert = supabase.calls.find(
      (c) => c.table === "issues" && c.op === "insert",
    )?.args as Record<string, unknown>;
    expect(typeof issuesInsert.bounty_onchain_id).toBe("string");
    expect(issuesInsert.bounty_onchain_id).toBe("9999999999999999");
    expect(typeof issuesInsert.amount).toBe("string");
    expect(issuesInsert.amount).toBe("18446744073709551614");
  });

  it("rolls back the issue row when bounty_meta insert fails", async () => {
    const supabase = makeSupabase({
      metaResult: { error: { message: "policy denied" } },
    });
    await expect(
      insertIssueAndMeta(supabase as never, baseParams),
    ).rejects.toThrow(/bounty_meta insert: policy denied/);

    const deletes = supabase.calls.filter(
      (c) => c.table === "issues" && c.op === "delete",
    );
    expect(deletes).toHaveLength(1);
  });

  it("throws and does not attempt rollback when issues insert fails", async () => {
    const supabase = makeSupabase({
      issueResult: { data: null, error: { message: "RLS reject" } },
    });
    await expect(
      insertIssueAndMeta(supabase as never, baseParams),
    ).rejects.toThrow(/issues insert: RLS reject/);

    const deletes = supabase.calls.filter((c) => c.op === "delete");
    expect(deletes).toHaveLength(0);
  });

  it("passes optional metadata fields through unchanged", async () => {
    const supabase = makeSupabase();
    await insertIssueAndMeta(supabase as never, {
      ...baseParams,
      title: "Fix the bug",
      description: "Long-form description",
      rejectThreshold: 5,
      evaluationCriteria: "must include tests",
    });
    const metaInsert = supabase.calls.find(
      (c) => c.table === "bounty_meta" && c.op === "insert",
    )?.args as Record<string, unknown>;
    expect(metaInsert.title).toBe("Fix the bug");
    expect(metaInsert.description).toBe("Long-form description");
    expect(metaInsert.reject_threshold).toBe(5);
    expect(metaInsert.evaluation_criteria).toBe("must include tests");
    expect(metaInsert.release_mode).toBe("auto");
    expect(metaInsert.closed_by_user).toBe(false);
  });

  it("nullifies optional metadata when not provided", async () => {
    const supabase = makeSupabase();
    await insertIssueAndMeta(supabase as never, baseParams);
    const metaInsert = supabase.calls.find(
      (c) => c.table === "bounty_meta" && c.op === "insert",
    )?.args as Record<string, unknown>;
    expect(metaInsert.title).toBeNull();
    expect(metaInsert.description).toBeNull();
    expect(metaInsert.reject_threshold).toBeNull();
    expect(metaInsert.evaluation_criteria).toBeNull();
  });
});

describe("listMyIssues", () => {
  it("returns the rows from the join", async () => {
    const rows = [{ issue_id: "i1", title: "t" }];
    const supabase = makeSupabase({ listResult: { data: rows, error: null } });
    const out = await listMyIssues(supabase as never, "did:privy:abc");
    expect(out).toEqual(rows);
  });

  it("returns [] when the join is empty", async () => {
    const supabase = makeSupabase({ listResult: { data: [], error: null } });
    const out = await listMyIssues(supabase as never, "did:privy:none");
    expect(out).toEqual([]);
  });

  it("throws on Supabase errors", async () => {
    const supabase = makeSupabase({
      listResult: { data: null, error: { message: "boom" } },
    });
    await expect(listMyIssues(supabase as never, "did")).rejects.toThrow(/boom/);
  });
});
