# v0.3.4
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

import json

from genlayer import *


MIN_PASSING_SCORE = 6


class BountyJudge(gl.Contract):
    known: TreeMap[str, bool]
    status: TreeMap[str, str]
    score: TreeMap[str, u256]
    code_quality: TreeMap[str, u256]
    test_coverage: TreeMap[str, u256]
    requirements_match: TreeMap[str, u256]
    security: TreeMap[str, u256]

    def __init__(self):
        pass

    # Write ------------------------------------------------------------------

    @gl.public.write
    def submit_evaluation(self, submission_id: str, opus_report: str) -> None:
        if not submission_id:
            raise gl.vm.UserError("submission_id is required")
        if not opus_report or not opus_report.strip():
            raise gl.vm.UserError("opus_report is required")
        if submission_id in self.known:
            raise gl.vm.UserError(
                f"submission {submission_id} already evaluated"
            )

        prompt = f"""
You are a senior code reviewer acting as an on-chain judge for a bounty
evaluation system. A developer submitted a Pull Request to resolve a GitHub
issue with a bounty. Before reaching you, the submission was analyzed in
depth by Claude Opus with access to the full diff, the issue body, and test
results from a sandboxed run.

Your job is to review Opus's analysis and emit a final verdict. You act as
a perito who trusts Opus's reasoning by default but can push back if the
evidence in the report does not support the conclusions.

OPUS ANALYSIS:
---
{opus_report}
---

TASK:
Evaluate the submission on four dimensions, each scored 1-10:
- code_quality: style, complexity, correctness, idiomaticity
- test_coverage: whether tests were added, whether they cover the right
  cases, and whether they actually passed in the sandbox
- requirements_match: whether the PR solves what the issue asked for,
  without unrelated drive-by changes
- security: whether the change introduces attack surface, removes
  safeguards, or pulls in unaudited dependencies

Then emit a final integer score (1-10) that reflects your overall verdict.

Respond with the following JSON format:
{{
    "score": int,
    "dimensions": {{
        "code_quality": int,
        "test_coverage": int,
        "requirements_match": int,
        "security": int
    }}
}}

It is mandatory that you respond only using the JSON format above,
nothing else. Don't include any other words or characters,
your output must be only JSON without any formatting prefix or suffix.
This result should be perfectly parsable by a JSON parser without errors.
"""

        def judge_submission() -> str:
            raw = gl.nondet.exec_prompt(prompt)
            cleaned = raw.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(cleaned)
            score = int(parsed["score"])
            if not 1 <= score <= 10:
                raise ValueError(f"score out of range: {score}")
            dims = parsed["dimensions"]
            for key in (
                "code_quality",
                "test_coverage",
                "requirements_match",
                "security",
            ):
                v = int(dims[key])
                if not 1 <= v <= 10:
                    raise ValueError(f"{key} out of range: {v}")
            payload = {
                "score": score,
                "dimensions": {
                    "code_quality": int(dims["code_quality"]),
                    "test_coverage": int(dims["test_coverage"]),
                    "requirements_match": int(dims["requirements_match"]),
                    "security": int(dims["security"]),
                },
            }
            return json.dumps(payload, sort_keys=True)

        consensed_raw = gl.eq_principle.strict_eq(judge_submission)
        verdict = json.loads(consensed_raw)
        final_score = int(verdict["score"])
        dims = verdict["dimensions"]

        new_status = (
            "passed"
            if final_score >= MIN_PASSING_SCORE
            else "rejected_by_genlayer"
        )

        self.known[submission_id] = True
        self.status[submission_id] = new_status
        self.score[submission_id] = u256(final_score)
        self.code_quality[submission_id] = u256(int(dims["code_quality"]))
        self.test_coverage[submission_id] = u256(int(dims["test_coverage"]))
        self.requirements_match[submission_id] = u256(
            int(dims["requirements_match"])
        )
        self.security[submission_id] = u256(int(dims["security"]))

    # Read -------------------------------------------------------------------

    @gl.public.view
    def get_status(self, submission_id: str) -> str:
        if submission_id not in self.known:
            raise gl.vm.UserError(f"submission {submission_id} not found")
        return self.status[submission_id]

    @gl.public.view
    def get_score(self, submission_id: str) -> int:
        if submission_id not in self.known:
            raise gl.vm.UserError(f"submission {submission_id} not found")
        return int(self.score[submission_id])

    @gl.public.view
    def get_dimensions(self, submission_id: str) -> dict[str, int]:
        if submission_id not in self.known:
            raise gl.vm.UserError(f"submission {submission_id} not found")
        return {
            "code_quality": int(self.code_quality[submission_id]),
            "test_coverage": int(self.test_coverage[submission_id]),
            "requirements_match": int(self.requirements_match[submission_id]),
            "security": int(self.security[submission_id]),
        }

    @gl.public.view
    def list_submissions(self) -> list[str]:
        return [k for k in self.known]
