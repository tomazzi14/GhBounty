import { Keypair } from "@solana/web3.js";
import { describe, expect, test, vi } from "vitest";

import { type AnalyzeResult } from "../src/analyzer.js";
import { handleSubmission } from "../src/submission-handler.js";

/**
 * Integration-style tests for the per-submission pipeline. We build a fake
 * `Db` that records every call, a fake scorer client, and a fake analyzer.
 * The real `analyzeSubmission` is bypassed via `deps.analyze`, and the real
 * `db/ops` functions are exercised against a Drizzle-shaped fake.
 *
 * The fake DB is just enough to satisfy the small surface our ops use:
 *   - select(...).from(bountyMeta).innerJoin(issues, ...).where(...).limit()
 *   - insert(submissions).values(...).onConflictDoNothing(...)
 *   - update(submissions).set(...).where(...)
 *   - insert(evaluations).values(...)
 */

type Recorded = { kind: string; payload: unknown };

interface FakeDb {
  calls: Recorded[];
  thresholdToReturn: number | null;
}

function fakeDb(thresholdToReturn: number | null = null): FakeDb {
  return { calls: [], thresholdToReturn };
}

// Build a Drizzle-shaped object that records calls. Each method returns
// `this` (or a final array for `.limit()`) so the chain compiles + runs.
function buildDrizzleProxy(state: FakeDb): unknown {
  const insertChain = (table: unknown) => ({
    values: (payload: unknown) => {
      const next = {
        onConflictDoNothing: () => {
          state.calls.push({ kind: "insert", payload: { table, payload } });
          return Promise.resolve();
        },
        onConflictDoUpdate: () => {
          state.calls.push({ kind: "insert", payload: { table, payload } });
          return Promise.resolve();
        },
        // Direct await without .onConflict* (used by insertEvaluation)
        then: (
          resolve: (v: unknown) => void,
          reject?: (e: unknown) => void,
        ) => {
          state.calls.push({ kind: "insert", payload: { table, payload } });
          return Promise.resolve().then(resolve, reject);
        },
      };
      return next;
    },
  });

  const updateChain = (table: unknown) => ({
    set: (patch: unknown) => ({
      where: () => {
        state.calls.push({ kind: "update", payload: { table, patch } });
        return Promise.resolve();
      },
    }),
  });

  const selectChain = () => ({
    from: () => ({
      innerJoin: () => ({
        where: () => ({
          limit: () => {
            state.calls.push({ kind: "select", payload: "threshold-lookup" });
            return Promise.resolve(
              state.thresholdToReturn == null
                ? []
                : [{ threshold: state.thresholdToReturn }],
            );
          },
        }),
      }),
    }),
  });

  return {
    insert: insertChain,
    update: updateChain,
    select: selectChain,
  };
}

// Build a fake DecodedSubmission. We use freshly generated keypairs because
// `new PublicKey(string)` requires a valid base58 32-byte encoding and most
// hand-crafted strings (e.g. "22222...") fall outside the valid set.
function buildSub(prUrl = "https://github.com/o/r/pull/1") {
  return {
    pda: Keypair.generate().publicKey,
    bounty: Keypair.generate().publicKey,
    solver: Keypair.generate().publicKey,
    submissionIndex: 0,
    prUrl,
    opusReportHash: new Uint8Array(32).fill(0xab),
    score: null as number | null,
  };
}

const opusResult: AnalyzeResult = {
  score: 7,
  source: "opus",
  reasoning: "Decent change, no concerns.",
  report: {
    code_quality: { score: 7, reasoning: "" },
    test_coverage: { score: 6, reasoning: "" },
    requirements_match: { score: 8, reasoning: "" },
    security: { score: 5, reasoning: "" },
    summary: "Decent change, no concerns.",
  },
  reportHash: "f".repeat(64),
};

const lowOpusResult: AnalyzeResult = {
  ...opusResult,
  score: 3,
  reasoning: "Weak.",
  report: {
    code_quality: { score: 3, reasoning: "" },
    test_coverage: { score: 2, reasoning: "" },
    requirements_match: { score: 4, reasoning: "" },
    security: { score: 3, reasoning: "" },
    summary: "Weak.",
  },
};

function buildScorer(txHash = "TX_OK") {
  const setScore = vi.fn(async () => txHash);
  return { client: { setScore }, setScore };
}

const baseDeps = {
  chainId: "solana-devnet",
  stubScore: 5,
  anthropicApiKey: null,
  anthropicModel: "claude-sonnet-4-5-20250929",
};

describe("handleSubmission", () => {
  test("no DB: still calls setScore with the analyzer's score", async () => {
    const { client, setScore } = buildScorer("ABC");
    const analyze = vi.fn(async () => opusResult);
    const sub = buildSub();

    const r = await handleSubmission(sub, {
      ...baseDeps,
      db: null,
      scorer: client,
      analyze,
    });

    expect(setScore).toHaveBeenCalledOnce();
    const args = setScore.mock.calls[0];
    expect(args[0].equals(sub.bounty)).toBe(true);
    expect(args[1].equals(sub.pda)).toBe(true);
    expect(args[2]).toBe(7);
    expect(r.score).toBe(7);
    expect(r.outcome).toBe("pass");
    expect(r.threshold).toBeNull();
    expect(r.txHash).toBe("ABC");
  });

  test("with DB and no threshold: marks scored, never auto_rejected", async () => {
    const state = fakeDb(null); // no threshold configured for the issue
    const db = buildDrizzleProxy(state);
    const { client } = buildScorer();
    const analyze = vi.fn(async () => opusResult);

    const r = await handleSubmission(buildSub(), {
      ...baseDeps,
      db: db as never,
      scorer: client,
      analyze,
    });

    expect(r.outcome).toBe("pass");
    expect(r.threshold).toBeNull();

    const updateCalls = state.calls.filter((c) => c.kind === "update");
    expect(updateCalls).toHaveLength(1);
    const patch = (updateCalls[0].payload as { patch: { state: string } }).patch;
    expect(patch.state).toBe("scored");
  });

  test("score below threshold → marks auto_rejected", async () => {
    const state = fakeDb(5); // threshold=5, score=3 → reject
    const db = buildDrizzleProxy(state);
    const { client } = buildScorer();
    const analyze = vi.fn(async () => lowOpusResult);

    const r = await handleSubmission(buildSub(), {
      ...baseDeps,
      db: db as never,
      scorer: client,
      analyze,
    });

    expect(r.outcome).toBe("auto_rejected");
    expect(r.threshold).toBe(5);
    expect(r.score).toBe(3);

    const updateCalls = state.calls.filter((c) => c.kind === "update");
    expect(updateCalls).toHaveLength(1);
    const patch = (updateCalls[0].payload as { patch: { state: string } }).patch;
    expect(patch.state).toBe("auto_rejected");
  });

  test("score equal to threshold passes (strict <)", async () => {
    const state = fakeDb(7); // threshold=7, score=7 → pass
    const db = buildDrizzleProxy(state);
    const { client } = buildScorer();
    const analyze = vi.fn(async () => opusResult);

    const r = await handleSubmission(buildSub(), {
      ...baseDeps,
      db: db as never,
      scorer: client,
      analyze,
    });

    expect(r.outcome).toBe("pass");
    expect(r.score).toBe(7);

    const updateCalls = state.calls.filter((c) => c.kind === "update");
    const patch = (updateCalls[0].payload as { patch: { state: string } }).patch;
    expect(patch.state).toBe("scored");
  });

  test("setScore is called regardless of threshold outcome (onchain truth)", async () => {
    const state = fakeDb(10); // threshold=10, score=3 → reject
    const db = buildDrizzleProxy(state);
    const { client, setScore } = buildScorer("TX_REJECTED");
    const analyze = vi.fn(async () => lowOpusResult);

    const r = await handleSubmission(buildSub(), {
      ...baseDeps,
      db: db as never,
      scorer: client,
      analyze,
    });

    // Even though the submission auto-rejects off-chain, set_score still runs
    // so onchain has the truth and resolve_bounty can compare scores later.
    expect(setScore).toHaveBeenCalledOnce();
    expect(r.txHash).toBe("TX_REJECTED");
    expect(r.outcome).toBe("auto_rejected");
  });

  test("evaluation row is inserted in both pass and reject paths", async () => {
    const passState = fakeDb(null);
    await handleSubmission(buildSub(), {
      ...baseDeps,
      db: buildDrizzleProxy(passState) as never,
      scorer: buildScorer().client,
      analyze: vi.fn(async () => opusResult),
    });
    expect(passState.calls.filter((c) => c.kind === "insert").length).toBe(2);
    // First insert = upsertSubmission, second = insertEvaluation.

    const rejectState = fakeDb(8);
    await handleSubmission(buildSub(), {
      ...baseDeps,
      db: buildDrizzleProxy(rejectState) as never,
      scorer: buildScorer().client,
      analyze: vi.fn(async () => lowOpusResult),
    });
    expect(rejectState.calls.filter((c) => c.kind === "insert").length).toBe(2);
  });

  test("falls back to stub when no API key (still threshold-checked)", async () => {
    const state = fakeDb(6); // stubScore=5 < threshold=6 → reject
    const db = buildDrizzleProxy(state);
    const { client } = buildScorer();

    const r = await handleSubmission(buildSub(), {
      ...baseDeps,
      stubScore: 5,
      db: db as never,
      scorer: client,
      // Use the real analyzer (no analyze override) → stub path
    });

    expect(r.source).toBe("stub");
    expect(r.score).toBe(5);
    expect(r.outcome).toBe("auto_rejected");
    expect(r.threshold).toBe(6);
  });

  test("propagates analyzer errors (does not silently swallow)", async () => {
    const { client } = buildScorer();
    const analyze = vi.fn(async () => {
      throw new Error("analyzer exploded");
    });

    await expect(
      handleSubmission(buildSub(), {
        ...baseDeps,
        db: null,
        scorer: client,
        analyze,
      }),
    ).rejects.toThrow(/analyzer exploded/);
  });

  test("propagates setScore errors (does not silently swallow)", async () => {
    const setScore = vi.fn(async () => {
      throw new Error("rpc down");
    });
    const analyze = vi.fn(async () => opusResult);

    await expect(
      handleSubmission(buildSub(), {
        ...baseDeps,
        db: null,
        scorer: { setScore },
        analyze,
      }),
    ).rejects.toThrow(/rpc down/);
  });

  test("upserts the submission before analyzing (so DB has the row even on analyze failure)", async () => {
    const state = fakeDb(null);
    const db = buildDrizzleProxy(state);
    const { client } = buildScorer();
    const analyze = vi.fn(async () => {
      throw new Error("opus boom");
    });

    await expect(
      handleSubmission(buildSub(), {
        ...baseDeps,
        db: db as never,
        scorer: client,
        analyze,
      }),
    ).rejects.toThrow();

    // The upsert ran before the analyzer threw.
    expect(state.calls.filter((c) => c.kind === "insert").length).toBe(1);
    // No update yet because we never made it past setScore.
    expect(state.calls.filter((c) => c.kind === "update").length).toBe(0);
  });
});
