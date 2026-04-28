/**
 * One-off CLI to score a real GitHub PR with Claude Sonnet (or whatever
 * ANTHROPIC_MODEL is set to). Useful for manual smoke-testing without
 * spinning up the full watcher/relayer loop.
 *
 * Usage:
 *   cd relayer
 *   pnpm tsx scripts/score-pr.ts <github-pr-url> [issue-description...]
 *
 * Example:
 *   pnpm tsx scripts/score-pr.ts https://github.com/anthropics/claude-code/pull/1234
 *
 * Requires ANTHROPIC_API_KEY in relayer/.env.
 */
import * as path from "node:path";
import * as url from "node:url";
import { config as dotenvConfig } from "dotenv";

// Resolve .env relative to this script so it works regardless of cwd
// (pnpm in monorepo can run from the workspace root).
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
dotenvConfig({ path: path.join(__dirname, "..", ".env") });

import { scorePR } from "../src/opus.js";

async function main(): Promise<void> {
  const [, , prUrl, ...descParts] = process.argv;
  if (!prUrl) {
    console.error("usage: pnpm tsx scripts/score-pr.ts <pr-url> [issue description...]");
    process.exit(1);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set in env. Add it to relayer/.env first.");
    process.exit(1);
  }
  const model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
  const issueDescription = descParts.length > 0 ? descParts.join(" ") : undefined;

  console.log(`scoring ${prUrl} with ${model}...`);
  const t0 = Date.now();
  const result = await scorePR(
    { prUrl, issueDescription },
    { apiKey, model },
  );
  const elapsedMs = Date.now() - t0;

  // Pretty-print: dimension scores, dropped files, then full report.
  const dims = result.report;
  console.log(`\noverall: ${result.overall}/10  (${elapsedMs}ms)\n`);
  console.log(`  code_quality       ${dims.code_quality.score}/10  ${dims.code_quality.reasoning}`);
  console.log(`  test_coverage      ${dims.test_coverage.score}/10  ${dims.test_coverage.reasoning}`);
  console.log(`  requirements_match ${dims.requirements_match.score}/10  ${dims.requirements_match.reasoning}`);
  console.log(`  security           ${dims.security.score}/10  ${dims.security.reasoning}`);
  console.log(`\nsummary:\n${dims.summary}\n`);
  console.log(`kept files (${result.filtered.kept.length}):    ${result.filtered.kept.slice(0, 10).join(", ")}${result.filtered.kept.length > 10 ? "..." : ""}`);
  if (result.filtered.dropped.length) {
    console.log(`dropped files (${result.filtered.dropped.length}): ${result.filtered.dropped.slice(0, 10).map((d) => `${d.path}(${d.reason})`).join(", ")}${result.filtered.dropped.length > 10 ? "..." : ""}`);
  }
  console.log(`\nreportHash: ${result.reportHash}${result.truncated ? "  [TRUNCATED]" : ""}`);
}

main().catch((err) => {
  console.error("score-pr failed:", err);
  process.exit(1);
});
