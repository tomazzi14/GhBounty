import { describe, expect, test, vi } from "vitest";

import {
  computeOverall,
  fetchGithubDiff,
  scorePR,
  type OpusReport,
} from "../src/opus.js";

const goodReport = (
  overrides: Partial<{
    cq: number; tc: number; req: number; sec: number; summary: string;
  }> = {},
): OpusReport => ({
  code_quality: { score: overrides.cq ?? 7, reasoning: "clean code" },
  test_coverage: { score: overrides.tc ?? 6, reasoning: "happy path only" },
  requirements_match: { score: overrides.req ?? 8, reasoning: "solves the issue" },
  security: { score: overrides.sec ?? 5, reasoning: "no concerns" },
  summary: overrides.summary ?? "Reasonable PR addressing the bounty.",
});

describe("scorePR", () => {
  test("filters diff, calls LLM, returns 4-dim report + overall", async () => {
    const fetchDiff = vi.fn(async () =>
      [
        "diff --git a/src/x.ts b/src/x.ts",
        "+++ b/src/x.ts",
        "+real change",
        "diff --git a/package-lock.json b/package-lock.json",
        "+++ b/package-lock.json",
        "+lockfile junk",
      ].join("\n"),
    );
    const callLLM = vi.fn(async (_apiKey, _model, _system, user) => {
      // The lockfile must NOT appear in the prompt sent to the LLM.
      expect(user).not.toContain("lockfile junk");
      expect(user).toContain("real change");
      // The dropped-files note must mention the lockfile.
      expect(user).toContain("package-lock.json");
      return JSON.stringify(goodReport());
    });

    const r = await scorePR(
      { prUrl: "https://github.com/o/r/pull/1", issueDescription: "Fix bug X" },
      { apiKey: "k", model: "m", fetchDiff, callLLM },
    );

    expect(r.report.code_quality.score).toBe(7);
    expect(r.report.test_coverage.score).toBe(6);
    expect(r.report.requirements_match.score).toBe(8);
    expect(r.report.security.score).toBe(5);
    expect(r.report.summary).toMatch(/Reasonable/);
    expect(r.reportHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.reportHashBytes).toHaveLength(32);
    expect(r.filtered.kept).toContain("src/x.ts");
    expect(r.filtered.dropped.some((d) => d.path === "package-lock.json")).toBe(true);
    expect(r.truncated).toBe(false);
  });

  test("strips ```json fences if model wraps the JSON", async () => {
    const fetchDiff = vi.fn(async () => "diff --git a/x b/x\n+x");
    const callLLM = vi.fn(async () =>
      "```json\n" + JSON.stringify(goodReport()) + "\n```",
    );
    const r = await scorePR(
      { prUrl: "https://github.com/o/r/pull/2" },
      { apiKey: "k", model: "m", fetchDiff, callLLM },
    );
    expect(r.report.code_quality.score).toBe(7);
  });

  test("rejects non-integer dimension score", async () => {
    const fetchDiff = vi.fn(async () => "diff --git a/x b/x\n+x");
    const bad = goodReport();
    (bad.code_quality as unknown as { score: number }).score = 7.5;
    const callLLM = vi.fn(async () => JSON.stringify(bad));
    await expect(
      scorePR(
        { prUrl: "https://github.com/o/r/pull/3" },
        { apiKey: "k", model: "m", fetchDiff, callLLM },
      ),
    ).rejects.toThrow(/integer/);
  });

  test("rejects out-of-range dimension score", async () => {
    const fetchDiff = vi.fn(async () => "diff --git a/x b/x\n+x");
    const bad = goodReport({ sec: 42 });
    const callLLM = vi.fn(async () => JSON.stringify(bad));
    await expect(
      scorePR(
        { prUrl: "https://github.com/o/r/pull/4" },
        { apiKey: "k", model: "m", fetchDiff, callLLM },
      ),
    ).rejects.toThrow(/security.*\[1,10\]/);
  });

  test("rejects empty summary", async () => {
    const fetchDiff = vi.fn(async () => "diff --git a/x b/x\n+x");
    const bad = goodReport({ summary: "" });
    const callLLM = vi.fn(async () => JSON.stringify(bad));
    await expect(
      scorePR(
        { prUrl: "https://github.com/o/r/pull/5" },
        { apiKey: "k", model: "m", fetchDiff, callLLM },
      ),
    ).rejects.toThrow(/summary/);
  });

  test("rejects missing dimension", async () => {
    const fetchDiff = vi.fn(async () => "diff --git a/x b/x\n+x");
    const callLLM = vi.fn(async () =>
      JSON.stringify({
        code_quality: { score: 5, reasoning: "ok" },
        // test_coverage missing
        requirements_match: { score: 5, reasoning: "ok" },
        security: { score: 5, reasoning: "ok" },
        summary: "x",
      }),
    );
    await expect(
      scorePR(
        { prUrl: "https://github.com/o/r/pull/6" },
        { apiKey: "k", model: "m", fetchDiff, callLLM },
      ),
    ).rejects.toThrow(/test_coverage/);
  });

  test("identical reports yield identical reportHash (canonical JSON)", async () => {
    const fetchDiff = vi.fn(async () => "diff --git a/x b/x\n+x");
    // Same content, different key ordering — should still hash identically.
    const reordered = JSON.stringify({
      summary: "Reasonable PR addressing the bounty.",
      security: { reasoning: "no concerns", score: 5 },
      requirements_match: { reasoning: "solves the issue", score: 8 },
      test_coverage: { reasoning: "happy path only", score: 6 },
      code_quality: { reasoning: "clean code", score: 7 },
    });
    const callA = vi.fn(async () => JSON.stringify(goodReport()));
    const callB = vi.fn(async () => reordered);
    const a = await scorePR(
      { prUrl: "https://github.com/o/r/pull/7" },
      { apiKey: "k", model: "m", fetchDiff, callLLM: callA },
    );
    const b = await scorePR(
      { prUrl: "https://github.com/o/r/pull/7" },
      { apiKey: "k", model: "m", fetchDiff, callLLM: callB },
    );
    expect(a.reportHash).toBe(b.reportHash);
  });

  test("truncates large filtered diffs and flags truncated=true", async () => {
    const big = "diff --git a/x b/x\n" + "a".repeat(300_000);
    const fetchDiff = vi.fn(async () => big);
    const callLLM = vi.fn(async (_a, _m, _s, user) => {
      expect(user).toContain("truncated");
      return JSON.stringify(goodReport());
    });
    const r = await scorePR(
      { prUrl: "https://github.com/o/r/pull/8" },
      { apiKey: "k", model: "m", fetchDiff, callLLM, maxDiffBytes: 1000 },
    );
    expect(r.truncated).toBe(true);
  });
});

describe("computeOverall", () => {
  test("weighted average with documented weights (30/25/30/15)", () => {
    // 7*0.30 + 6*0.25 + 8*0.30 + 5*0.15 = 2.1 + 1.5 + 2.4 + 0.75 = 6.75 → 7
    expect(computeOverall(goodReport())).toBe(7);
  });

  test("penalty: security <= 2 collapses overall to min(dims)", () => {
    expect(computeOverall(goodReport({ sec: 2 }))).toBe(2);
    expect(computeOverall(goodReport({ sec: 1, cq: 9, tc: 9, req: 9 }))).toBe(1);
  });

  test("penalty: requirements_match <= 2 collapses overall to min(dims)", () => {
    expect(computeOverall(goodReport({ req: 1, sec: 9, cq: 9, tc: 9 }))).toBe(1);
  });

  test("perfect 10s round to 10", () => {
    expect(computeOverall(goodReport({ cq: 10, tc: 10, req: 10, sec: 10 }))).toBe(10);
  });
});

describe("fetchGithubDiff", () => {
  test("rejects non-PR URLs", async () => {
    await expect(fetchGithubDiff("https://example.com/foo")).rejects.toThrow(
      /unsupported PR URL/,
    );
    await expect(fetchGithubDiff("https://github.com/o/r/issues/1")).rejects.toThrow(
      /unsupported PR URL/,
    );
  });
});
