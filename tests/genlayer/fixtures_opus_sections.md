# Test fixtures for BountyJudge.evaluate()

Each scenario has four Opus-style sections. Paste them into the Studio UI
when calling `evaluate(pr_url, opus_code_quality, opus_test_coverage, opus_requirements, opus_security)`.

Expected behavior on strict_eq: all 5 validators should converge on the
same integer per dimension. If any diverges, iterate the prompt.

---

## Scenario A — Good PR (expected final_score ~8-9)

**pr_url:** `https://github.com/example/repo/pull/42`

**opus_code_quality:**
```
The PR introduces a clean `computeWeightedScore` helper with clear parameter names
and a single responsibility. No dead code, no commented-out lines. Variable naming
follows the existing Rust convention in the file. Cyclomatic complexity stays low;
the helper is 11 lines with a single return path. One minor nit: the PR keeps two
identical error messages that could be extracted into a constant, but that would be
a pure style preference rather than a real defect. Overall the diff reads as
production-grade code that matches the surrounding file's style.
```

**opus_test_coverage:**
```
The PR adds three unit tests covering the happy path, the boundary case where every
score is 10, and the degenerate case where every score is 1. The tests assert exact
equality on the weighted integer result. No integration tests were added, but the
function is pure and deterministic, so unit tests are sufficient. Coverage for the
touched file rises from 72% to 94%. All tests pass locally and in CI.
```

**opus_requirements:**
```
The bounty asked for a weighted scoring helper matching the formula
(code*30 + tests*25 + req*30 + sec*15) / 100, rounded to the nearest integer. The PR
implements exactly this formula, including round-half-up semantics via `(sum + 50) // 100`.
It does not introduce unrelated changes or drive-by refactors. The diff matches the
issue description line by line.
```

**opus_security:**
```
The change is a pure arithmetic helper with no I/O, no external calls, no storage
mutation, and no user-controlled input reaching sensitive paths. Integer overflow is
impossible given the documented input range (each score 1-10, weights bounded and
summing to 100). No new dependencies were introduced. No attack surface change.
```

---

## Scenario B — Mediocre PR (expected final_score ~5-6)

**pr_url:** `https://github.com/example/repo/pull/43`

**opus_code_quality:**
```
The PR solves the requested issue but the style is inconsistent. It mixes camelCase
and snake_case in new identifiers, uses two different logging idioms in the same
function, and includes a 40-line nested if/else block where a flat early-return
pattern would read better. Comments contradict the code in one place (the comment
says "sorted by score descending" while `.sort()` is called without a comparator).
No obvious bugs, but a reviewer would definitely request changes.
```

**opus_test_coverage:**
```
One unit test was added, covering only the happy path. Edge cases (empty input,
duplicate scores, out-of-range values) are not tested. The file's coverage actually
drops slightly because the new code is larger than the new tests exercise. CI passes
because existing tests still cover the untouched branches.
```

**opus_requirements:**
```
The PR solves the main requirement (ranking submissions by weighted score) but also
silently changes the tie-break behavior from "first submitted wins" to "alphabetical
by solver address", which was not requested and is not mentioned in the description.
This is a partial implementation with an undocumented side effect.
```

**opus_security:**
```
No security issues introduced. The code does not touch authentication, authorization,
crypto, or external calls. No new dependencies. The behavioral change in tie-breaking
is a correctness issue, not a security issue.
```

---

## Scenario C — Broken PR (expected final_score ~2-3)

**pr_url:** `https://github.com/example/repo/pull/44`

**opus_code_quality:**
```
The PR is full of print debug statements left over from local development, several
TODO comments referencing the author's own name, and at least one commented-out
block of the previous implementation. Variable names are cryptic (`x1`, `tmp_2`,
`hack`). There is an unused import and an unreachable branch after an early return.
The file does not compile in one supported target.
```

**opus_test_coverage:**
```
No tests were added. Two existing tests were modified to pass with the new (broken)
behavior instead of being updated to validate the new semantics. CI is green only
because the modified tests now assert on the bug instead of the intended behavior.
```

**opus_requirements:**
```
The PR claims to implement the reject threshold logic but the condition is inverted:
submissions below the threshold are accepted and those above are rejected. The issue
description and acceptance criteria clearly state the opposite. This does not solve
the bounty.
```

**opus_security:**
```
The PR disables an existing input validation (`require(amount > 0)` was removed from
the deposit path) without justification. A caller can now lock the escrow with a
zero-amount bounty, which is at best a nuisance and at worst a denial-of-service
vector depending on how the UI handles empty bounties. The change also adds a new
dependency from an unaudited npm package.
```

---

## How to validate

For each scenario:

1. In the Studio UI, deploy `contracts/genlayer/BountyJudge.py`.
2. Call `evaluate()` with the four sections above.
3. Wait for consensus. All 5 validators should emit the same integer per dimension.
4. Call `get_verdict()` and confirm:
   - `evaluated == true`
   - Each per-dimension score is in 1-10
   - `final_score == (cq*30 + tc*25 + rq*30 + sec*15 + 50) // 100`
5. Record the scores in a test matrix.

If strict_eq fails for any scenario (validators diverge on an integer), iterate
the prompt inside `_score_dimension` in `BountyJudge.py` — make the rubric
tighter or provide score anchors (e.g., "1-2 = broken, 9-10 = excellent").
