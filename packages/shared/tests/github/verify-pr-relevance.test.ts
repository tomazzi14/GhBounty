import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyPrRelevance } from "../../src/github/verify-pr-relevance";

describe("verifyPrRelevance", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok:body_reference when PR body contains Fixes #N matching the bounty issue", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          body: "This PR fixes the diff-filter bug.\n\nFixes #67",
          title: "fix(diff-filter): ignore Anchor .anchor/ generated directory",
        }),
        { status: 200 }
      )
    );

    const result = await verifyPrRelevance({
      prUrl: "https://github.com/Ghbounty/GhBounty/pull/99",
      bountyIssueUrl: "https://github.com/Ghbounty/GhBounty/issues/67",
    });

    expect(result).toEqual({ ok: true, match: "body_reference" });
  });

  it("returns ok:body_reference when PR title contains Closes #N matching the bounty issue", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          body: "Some PR description",
          title: "Closes #67 — fix diff-filter Anchor directory",
        }),
        { status: 200 }
      )
    );

    const result = await verifyPrRelevance({
      prUrl: "https://github.com/Ghbounty/GhBounty/pull/99",
      bountyIssueUrl: "https://github.com/Ghbounty/GhBounty/issues/67",
    });

    expect(result).toEqual({ ok: true, match: "body_reference" });
  });

  it("returns issue_number_mismatch when PR references a different issue", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          body: "This is a test PR.\n\nFixes #70",
          title: "test: something",
        }),
        { status: 200 }
      )
    );

    const result = await verifyPrRelevance({
      prUrl: "https://github.com/Ghbounty/GhBounty/pull/99",
      bountyIssueUrl: "https://github.com/Ghbounty/GhBounty/issues/67",
    });

    expect(result).toEqual({ ok: false, reason: "issue_number_mismatch" });
  });

  it("returns no_issue_reference when PR body has no Fixes/Closes/Resolves", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          body: "Just a regular PR with no issue references.",
          title: "some change",
        }),
        { status: 200 }
      )
    );

    const result = await verifyPrRelevance({
      prUrl: "https://github.com/Ghbounty/GhBounty/pull/99",
      bountyIssueUrl: "https://github.com/Ghbounty/GhBounty/issues/67",
    });

    expect(result).toEqual({ ok: false, reason: "no_issue_reference" });
  });

  it("returns invalid_url for non-GitHub URLs", async () => {
    const result = await verifyPrRelevance({
      prUrl: "https://gitlab.com/owner/repo/pull/1",
      bountyIssueUrl: "https://github.com/Ghbounty/GhBounty/issues/67",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_url" });
  });

  it("returns pr_not_found on 404", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));

    const result = await verifyPrRelevance({
      prUrl: "https://github.com/Ghbounty/GhBounty/pull/99999",
      bountyIssueUrl: "https://github.com/Ghbounty/GhBounty/issues/67",
    });
    expect(result).toEqual({ ok: false, reason: "pr_not_found" });
  });

  it("returns rate_limited on 403 with rate-limit header", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0" },
      })
    );

    const result = await verifyPrRelevance({
      prUrl: "https://github.com/Ghbounty/GhBounty/pull/99",
      bountyIssueUrl: "https://github.com/Ghbounty/GhBounty/issues/67",
    });
    expect(result).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("returns upstream_error when fetch throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND"));

    const result = await verifyPrRelevance({
      prUrl: "https://github.com/Ghbounty/GhBounty/pull/99",
      bountyIssueUrl: "https://github.com/Ghbounty/GhBounty/issues/67",
    });
    expect(result).toEqual({ ok: false, reason: "upstream_error" });
  });
});
