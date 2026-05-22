/**
 * Pure function. Calls GitHub REST API to verify that a PR was opened by
 * the expected user against the expected repo. Used by both the MCP server
 * (pre-check before submit_pr) and the relayer (post-check before scoring).
 *
 * Token: pass `GITHUB_TOKEN` (server-side env). Public-repo reads work
 * unauthenticated but with lower rate limit; provide a PAT for safety.
 */

export type VerifyPrOwnershipInput = {
  prUrl: string;
  expectedGithubHandle: string;
  /** Full URL like `https://github.com/owner/repo` (no trailing slash). */
  expectedRepoUrl: string;
  /** Optional full URL like `https://github.com/owner/repo/issues/123`. */
  expectedIssueUrl?: string | null;
  /** Optional GitHub token for higher rate limit. */
  token?: string;
};

export type VerifyPrOwnershipResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "pr_not_found"
        | "author_mismatch"
        | "repo_mismatch"
        | "issue_mismatch"
        | "rate_limited"
        | "invalid_url"
        | "upstream_error";
    };

const PR_URL_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

const ISSUE_URL_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;

const CLOSING_KEYWORD_RE =
  /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:(?:https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/)?#?(\d+))/gi;

export async function verifyPrOwnership(
  input: VerifyPrOwnershipInput
): Promise<VerifyPrOwnershipResult> {
  const match = input.prUrl.match(PR_URL_RE);
  if (!match) return { ok: false, reason: "invalid_url" };

  const [, owner, repo, prNumber] = match;
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (input.token) headers.Authorization = `Bearer ${input.token}`;

  let res: Response;
  try {
    res = await fetch(apiUrl, { headers });
  } catch {
    return { ok: false, reason: "upstream_error" };
  }

  if (res.status === 404) return { ok: false, reason: "pr_not_found" };

  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    return { ok: false, reason: "rate_limited" };
  }

  if (!res.ok) return { ok: false, reason: "upstream_error" };

  let body: {
    user: { login: string } | null;
    base: { repo: { html_url: string } | null } | null;
    body?: string | null;
  };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, reason: "upstream_error" };
  }

  const authorLogin = body?.user?.login;
  const repoHtmlUrl = body?.base?.repo?.html_url;
  if (!authorLogin || !repoHtmlUrl) {
    return { ok: false, reason: "upstream_error" };
  }

  if (authorLogin.toLowerCase() !== input.expectedGithubHandle.toLowerCase()) {
    return { ok: false, reason: "author_mismatch" };
  }

  const normalize = (u: string) => u.replace(/\/$/, "").toLowerCase();
  if (normalize(repoHtmlUrl) !== normalize(input.expectedRepoUrl)) {
    return { ok: false, reason: "repo_mismatch" };
  }

  if (input.expectedIssueUrl) {
    const expectedIssue = parseIssueUrl(input.expectedIssueUrl);
    if (!expectedIssue) return { ok: false, reason: "issue_mismatch" };

    if (!prBodyClosesIssue(body.body ?? "", expectedIssue)) {
      return { ok: false, reason: "issue_mismatch" };
    }
  }

  return { ok: true };
}

function parseIssueUrl(url: string): { owner: string; repo: string; number: string } | null {
  const m = url.match(ISSUE_URL_RE);
  if (!m) return null;
  return { owner: m[1]!.toLowerCase(), repo: m[2]!.toLowerCase(), number: m[3]! };
}

function prBodyClosesIssue(
  body: string,
  expectedIssue: { owner: string; repo: string; number: string }
): boolean {
  for (const m of body.matchAll(CLOSING_KEYWORD_RE)) {
    const [, owner, repo, number] = m;
    if (number !== expectedIssue.number) continue;

    // `Fixes #123` is scoped to the already-verified base repo. A fully
    // qualified URL must point to the same repo as the bounty issue.
    if (!owner && !repo) return true;
    if (
      owner?.toLowerCase() === expectedIssue.owner &&
      repo?.toLowerCase() === expectedIssue.repo
    ) {
      return true;
    }
  }
  return false;
}
