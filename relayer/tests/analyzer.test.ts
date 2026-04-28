import { describe, expect, test, vi } from "vitest";

import { analyzeSubmission } from "../src/analyzer.js";

const baseInput = {
  submissionPda: "FakePDA",
  prUrl: "https://github.com/x/y/pull/1",
  opusReportHash: new Uint8Array(32).fill(1),
};

const validReport = {
  code_quality: { score: 7, reasoning: "clean" },
  test_coverage: { score: 6, reasoning: "happy path" },
  requirements_match: { score: 8, reasoning: "matches" },
  security: { score: 5, reasoning: "no concerns" },
  summary: "Reasonable PR.",
};

describe("analyzer", () => {
  test("falls back to stub when no ANTHROPIC_API_KEY", async () => {
    const r = await analyzeSubmission(baseInput, {
      stubScore: 7,
      anthropicApiKey: null,
      anthropicModel: "claude-sonnet-4-5-20250929",
    });
    expect(r.score).toBe(7);
    expect(r.source).toBe("stub");
    expect(r.report).toBeNull();
    expect(r.reportHash).toBe("");
    expect(r.reasoning).toMatch(/no ANTHROPIC_API_KEY/);
  });

  test("calls opus path and returns aggregated score + structured report", async () => {
    const fetchDiff = vi.fn(async () => "diff --git a/x b/x\n+real change\n");
    const callLLM = vi.fn(async () => JSON.stringify(validReport));
    const r = await analyzeSubmission(baseInput, {
      stubScore: 1,
      anthropicApiKey: "sk-ant-test",
      anthropicModel: "claude-sonnet-4-5-20250929",
      scorePRDeps: { fetchDiff, callLLM },
    });
    expect(fetchDiff).toHaveBeenCalledWith(baseInput.prUrl);
    expect(callLLM).toHaveBeenCalledOnce();
    expect(r.source).toBe("opus");
    // Weighted: 7*0.30 + 6*0.25 + 8*0.30 + 5*0.15 = 6.75 → 7
    expect(r.score).toBe(7);
    expect(r.report).not.toBeNull();
    expect(r.report?.code_quality.score).toBe(7);
    expect(r.report?.summary).toBe("Reasonable PR.");
    expect(r.reasoning).toBe("Reasonable PR.");
    expect(r.reportHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("falls back to stub when fetchDiff throws", async () => {
    const fetchDiff = vi.fn(async () => {
      throw new Error("network down");
    });
    const r = await analyzeSubmission(baseInput, {
      stubScore: 5,
      anthropicApiKey: "sk-ant-test",
      anthropicModel: "claude-sonnet-4-5-20250929",
      scorePRDeps: { fetchDiff },
    });
    expect(r.score).toBe(5);
    expect(r.source).toBe("stub");
    expect(r.report).toBeNull();
    expect(r.reasoning).toMatch(/opus scoring failed/);
  });

  test("falls back to stub when LLM returns invalid JSON", async () => {
    const fetchDiff = vi.fn(async () => "diff --git a/x b/x\n+x");
    const callLLM = vi.fn(async () => "not json at all");
    const r = await analyzeSubmission(baseInput, {
      stubScore: 3,
      anthropicApiKey: "sk-ant-test",
      anthropicModel: "claude-sonnet-4-5-20250929",
      scorePRDeps: { fetchDiff, callLLM },
    });
    expect(r.score).toBe(3);
    expect(r.source).toBe("stub");
  });

  test("falls back to stub when LLM returns out-of-range score", async () => {
    const fetchDiff = vi.fn(async () => "diff --git a/x b/x\n+x");
    const bad = { ...validReport, security: { score: 42, reasoning: "x" } };
    const callLLM = vi.fn(async () => JSON.stringify(bad));
    const r = await analyzeSubmission(baseInput, {
      stubScore: 4,
      anthropicApiKey: "sk-ant-test",
      anthropicModel: "claude-sonnet-4-5-20250929",
      scorePRDeps: { fetchDiff, callLLM },
    });
    expect(r.score).toBe(4);
    expect(r.source).toBe("stub");
  });

  test("security<=2 penalty: overall collapses to min", async () => {
    const fetchDiff = vi.fn(async () => "diff --git a/x b/x\n+x");
    const bad = {
      ...validReport,
      security: { score: 1, reasoning: "found XSS" },
      // Other dims are high — without penalty would weight to ~7
    };
    const callLLM = vi.fn(async () => JSON.stringify(bad));
    const r = await analyzeSubmission(baseInput, {
      stubScore: 99,
      anthropicApiKey: "sk-ant-test",
      anthropicModel: "claude-sonnet-4-5-20250929",
      scorePRDeps: { fetchDiff, callLLM },
    });
    expect(r.source).toBe("opus");
    expect(r.score).toBe(1); // min(7,6,8,1) = 1
  });
});
