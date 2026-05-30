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
  /** Optional GitHub issue URL that the PR must explicitly close/fix/resolve. */
  expectedIssueUrl?: string;
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

  if (input.expectedIssueUrl && !prBodyClosesIssue(body.body ?? "", input.expectedIssueUrl)) {
    return { ok: false, reason: "issue_mismatch" };
  }

  return { ok: true };
}

const ISSUE_URL_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/i;
const CLOSING_KEYWORDS_RE = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+/i;

function prBodyClosesIssue(body: string, issueUrl: string): boolean {
  const match = issueUrl.match(ISSUE_URL_RE);
  if (!match) return false;

  const owner = match[1]!;
  const repo = match[2]!;
  const issueNumber = match[3]!;
  const escapedOwner = escapeRegExp(owner);
  const escapedRepo = escapeRegExp(repo);
  const escapedIssueNumber = escapeRegExp(issueNumber);

  const references = [
    `#${escapedIssueNumber}`,
    `${escapedOwner}/${escapedRepo}#${escapedIssueNumber}`,
    `https:\\/\\/github\\.com\\/${escapedOwner}\\/${escapedRepo}\\/issues\\/${escapedIssueNumber}\\/?`,
  ].join("|");

  return new RegExp(`${CLOSING_KEYWORDS_RE.source}(?:${references})`, "i").test(body);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
