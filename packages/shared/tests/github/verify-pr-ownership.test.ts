import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { verifyPrOwnership } from "../../src/github/verify-pr-ownership";

describe("verifyPrOwnership", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok when author and repo match", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: { login: "alice" },
          base: { repo: { html_url: "https://github.com/acme/proj" } },
          body: "Fixes #42",
        }),
        { status: 200 }
      )
    );

    const result = await verifyPrOwnership({
      prUrl: "https://github.com/acme/proj/pull/42",
      expectedGithubHandle: "alice",
      expectedRepoUrl: "https://github.com/acme/proj",
      expectedIssueUrl: "https://github.com/acme/proj/issues/42",
    });

    expect(result).toEqual({ ok: true });
  });

  it("returns issue_mismatch when PR closes a different issue", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: { login: "alice" },
          base: { repo: { html_url: "https://github.com/acme/proj" } },
          body: "Closes #70",
        }),
        { status: 200 }
      )
    );

    const result = await verifyPrOwnership({
      prUrl: "https://github.com/acme/proj/pull/99",
      expectedGithubHandle: "alice",
      expectedRepoUrl: "https://github.com/acme/proj",
      expectedIssueUrl: "https://github.com/acme/proj/issues/67",
    });

    expect(result).toEqual({ ok: false, reason: "issue_mismatch" });
  });

  it("accepts full issue URLs in closing references", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: { login: "alice" },
          base: { repo: { html_url: "https://github.com/acme/proj" } },
          body: "Resolves https://github.com/acme/proj/issues/67",
        }),
        { status: 200 }
      )
    );

    const result = await verifyPrOwnership({
      prUrl: "https://github.com/acme/proj/pull/99",
      expectedGithubHandle: "alice",
      expectedRepoUrl: "https://github.com/acme/proj",
      expectedIssueUrl: "https://github.com/acme/proj/issues/67",
    });

    expect(result).toEqual({ ok: true });
  });

  it("returns author_mismatch when login differs", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: { login: "mallory" },
          base: { repo: { html_url: "https://github.com/acme/proj" } },
        }),
        { status: 200 }
      )
    );

    const result = await verifyPrOwnership({
      prUrl: "https://github.com/acme/proj/pull/42",
      expectedGithubHandle: "alice",
      expectedRepoUrl: "https://github.com/acme/proj",
    });

    expect(result).toEqual({ ok: false, reason: "author_mismatch" });
  });

  it("returns repo_mismatch when PR is in a different repo", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          user: { login: "alice" },
          base: { repo: { html_url: "https://github.com/other/repo" } },
        }),
        { status: 200 }
      )
    );

    const result = await verifyPrOwnership({
      prUrl: "https://github.com/acme/proj/pull/42",
      expectedGithubHandle: "alice",
      expectedRepoUrl: "https://github.com/acme/proj",
    });

    expect(result).toEqual({ ok: false, reason: "repo_mismatch" });
  });

  it("returns pr_not_found on 404", async () => {
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));

    const result = await verifyPrOwnership({
      prUrl: "https://github.com/acme/proj/pull/9999",
      expectedGithubHandle: "alice",
      expectedRepoUrl: "https://github.com/acme/proj",
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

    const result = await verifyPrOwnership({
      prUrl: "https://github.com/acme/proj/pull/42",
      expectedGithubHandle: "alice",
      expectedRepoUrl: "https://github.com/acme/proj",
    });

    expect(result).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("returns invalid_url when the URL doesn't match the PR pattern", async () => {
    const result = await verifyPrOwnership({
      prUrl: "https://gitlab.com/owner/repo/pull/1",
      expectedGithubHandle: "alice",
      expectedRepoUrl: "https://github.com/acme/proj",
    });
    expect(result).toEqual({ ok: false, reason: "invalid_url" });
  });

  it("returns upstream_error when fetch throws (e.g. DNS failure)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND"));
    const result = await verifyPrOwnership({
      prUrl: "https://github.com/acme/proj/pull/42",
      expectedGithubHandle: "alice",
      expectedRepoUrl: "https://github.com/acme/proj",
    });
    expect(result).toEqual({ ok: false, reason: "upstream_error" });
  });
});
