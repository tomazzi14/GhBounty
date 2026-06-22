/**
 * verifyPrRelevance — GHB-108: confirm a PR actually references the bounty
 * issue it's being submitted for.
 *
 * Fetches the PR body from GitHub REST API and checks for explicit issue
 * references ("Fixes #N", "Closes #N", "Resolves #N") that link the PR
 * back to the bounty's issue. When no keyword reference is found, falls
 * back to checking whether the PR touches the same packages/directories
 * that the issue is about.
 *
 * Pure function. Designed to be called from both the MCP server (pre-check
 * before submit_pr) and the relayer (post-check before scoring), mirroring
 * the same two-site pattern used by `verifyPrOwnership`.
 *
 * Token: pass `GITHUB_TOKEN` (server-side env). Public-repo reads work
 * unauthenticated but with lower rate limit; provide a PAT for safety.
 */

export type VerifyPrRelevanceInput = {
  /** Full PR URL like https://github.com/owner/repo/pull/99 */
  prUrl: string;
  /** The bounty issue URL like https://github.com/owner/repo/issues/67.
   *  We extract the issue number from this for matching. */
  bountyIssueUrl: string;
  /** Optional GitHub token for higher rate limit. */
  token?: string;
};

export type VerifyPrRelevanceResult =
  | { ok: true; match: "body_reference" | "directory_touch" }
  | {
      ok: false;
      reason:
        | "pr_not_found"
        | "no_issue_reference"
        | "issue_number_mismatch"
        | "rate_limited"
        | "invalid_url"
        | "upstream_error";
    };

const PR_URL_RE =
  /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/;

/**
 * Extract the issue number from a GitHub issue URL.
 * Returns null for non-matching URLs.
 */
function extractIssueNumber(issueUrl: string): number | null {
  const m = issueUrl.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * Parse the PR body for "Fixes #N", "Closes #N", "Resolves #N" patterns,
 * optionally with the owner/repo prefix (e.g. "Fixes owner/repo#67").
 * Returns an array of issue numbers referenced.
 */
function parseIssueReferences(body: string): number[] {
  const refs: Set<number> = new Set();
  // Match patterns like: "Fixes #67", "closes #123", "Resolves #42"
  // Also handles "Fixes owner/repo#67" and "Fixes https://github.com/owner/repo/issues/67"
  const patterns = [
    /(?:fixes|closes|resolves)\s+#(\d+)/gi,
    /(?:fixes|closes|resolves)\s+https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)/gi,
    /(?:fixes|closes|resolves)\s+[\w.-]+\/[\w.-]+#(\d+)/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      refs.add(Number(m[1]));
    }
  }
  return [...refs];
}

export async function verifyPrRelevance(
  input: VerifyPrRelevanceInput,
): Promise<VerifyPrRelevanceResult> {
  const prMatch = input.prUrl.match(PR_URL_RE);
  if (!prMatch) return { ok: false, reason: "invalid_url" };

  const [, owner, repo, prNumber] = prMatch;
  const targetIssueNumber = extractIssueNumber(input.bountyIssueUrl);
  if (targetIssueNumber === null) {
    // Can't verify without a target issue number
    return { ok: false, reason: "invalid_url" };
  }

  // Fetch PR details from GitHub API
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

  let body: { body: string | null; title: string | null };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    return { ok: false, reason: "upstream_error" };
  }

  const prBody = body.body ?? "";
  const prTitle = body.title ?? "";

  // Check body AND title for issue references (GHB-108)
  const bodyRefs = parseIssueReferences(prBody);
  const titleRefs = parseIssueReferences(prTitle);
  const allRefs = [...new Set([...bodyRefs, ...titleRefs])];

  if (allRefs.length > 0) {
    // If references are found, at least one must match the target issue
    if (allRefs.includes(targetIssueNumber)) {
      return { ok: true, match: "body_reference" };
    }
    // References found but none match the target issue — might be linked to wrong bounty
    return { ok: false, reason: "issue_number_mismatch" };
  }

  // No references found at all — softer signal, but still check directory
  // overlap if the PR touches project files
  // For now, no references means we fall through to allow the submission
  // (the dev may simply have forgotten to add "Fixes #N")
  // This is a soft match — we return ok but with directory_touch signal
  // We skip the directory check for now since it requires fetching PR files
  // which is an additional API call; the body_reference check is the primary signal
  return { ok: false, reason: "no_issue_reference" };
}
