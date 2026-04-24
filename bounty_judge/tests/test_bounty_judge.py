"""Direct-mode tests for BountyJudge v0.3.2.

Uses gltest's direct-mode fixtures with mocked LLM responses, so the tests
exercise the full contract code path (input validation, prompt building,
JSON parsing, storage mutation, threshold logic) without spending real API
credits on the validators.

Storage is flattened into parallel TreeMaps of primitives — the GenVM
rejects TreeMap<str, CustomDataclass> with invalid_contract.
"""

from __future__ import annotations

import json
from pathlib import Path


CONTRACT = str(Path(__file__).resolve().parent.parent / "contracts" / "bounty_judge.py")
FIXTURES = Path(__file__).resolve().parent / "fixtures"

PASSED = "passed"
REJECTED = "rejected_by_genlayer"


def _mock_verdict(
    score: int,
    code_quality: int | None = None,
    test_coverage: int | None = None,
    requirements_match: int | None = None,
    security: int | None = None,
) -> str:
    payload = {
        "score": score,
        "dimensions": {
            "code_quality": code_quality if code_quality is not None else score,
            "test_coverage": test_coverage if test_coverage is not None else score,
            "requirements_match": (
                requirements_match if requirements_match is not None else score
            ),
            "security": security if security is not None else score,
        },
    }
    return "```json\n" + json.dumps(payload) + "\n```"


def _read_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


# ── Deploy ──────────────────────────────────────────────────────────────────


class TestDeploy:
    def test_deploy_succeeds(self, direct_vm, direct_deploy):
        contract = direct_deploy(CONTRACT)
        assert contract.list_submissions() == []


# ── Happy paths: passed / rejected ──────────────────────────────────────────


class TestExcellentPR:
    def test_score_9_passes(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", _mock_verdict(score=9))
        contract = direct_deploy(CONTRACT)

        contract.submit_evaluation(
            "sub-001", _read_fixture("opus_report_excellent.txt")
        )

        assert contract.get_status("sub-001") == PASSED
        assert contract.get_score("sub-001") == 9
        dims = contract.get_dimensions("sub-001")
        assert dims["code_quality"] == 9
        assert dims["test_coverage"] == 9


class TestMediocrePR:
    def test_score_6_passes_at_threshold(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", _mock_verdict(score=6))
        contract = direct_deploy(CONTRACT)

        contract.submit_evaluation("sub-002", _read_fixture("opus_report_mediocre.txt"))

        assert contract.get_status("sub-002") == PASSED
        assert contract.get_score("sub-002") == 6

    def test_score_5_rejected_below_threshold(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", _mock_verdict(score=5))
        contract = direct_deploy(CONTRACT)

        contract.submit_evaluation("sub-003", _read_fixture("opus_report_mediocre.txt"))

        assert contract.get_status("sub-003") == REJECTED
        assert contract.get_score("sub-003") == 5


class TestBrokenPR:
    def test_score_3_rejected(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", _mock_verdict(score=3, test_coverage=1))
        contract = direct_deploy(CONTRACT)

        contract.submit_evaluation("sub-004", _read_fixture("opus_report_broken.txt"))

        assert contract.get_status("sub-004") == REJECTED
        assert contract.get_score("sub-004") == 3
        assert contract.get_dimensions("sub-004")["test_coverage"] == 1


class TestMaliciousPR:
    def test_score_1_rejected_with_security_floor(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(
            r".*",
            _mock_verdict(
                score=1,
                code_quality=4,
                test_coverage=2,
                requirements_match=6,
                security=1,
            ),
        )
        contract = direct_deploy(CONTRACT)

        contract.submit_evaluation("sub-005", _read_fixture("opus_report_malicious.txt"))

        assert contract.get_status("sub-005") == REJECTED
        assert contract.get_score("sub-005") == 1
        assert contract.get_dimensions("sub-005")["security"] == 1


# ── Input validation ────────────────────────────────────────────────────────


class TestInputValidation:
    def test_empty_submission_id_reverts(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", _mock_verdict(score=8))
        contract = direct_deploy(CONTRACT)

        with direct_vm.expect_revert("submission_id is required"):
            contract.submit_evaluation("", "some report")

    def test_empty_opus_report_reverts(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", _mock_verdict(score=8))
        contract = direct_deploy(CONTRACT)

        with direct_vm.expect_revert("opus_report is required"):
            contract.submit_evaluation("sub-006", "")

    def test_whitespace_opus_report_reverts(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", _mock_verdict(score=8))
        contract = direct_deploy(CONTRACT)

        with direct_vm.expect_revert("opus_report is required"):
            contract.submit_evaluation("sub-007", "   \n  \t  ")

    def test_duplicate_submission_id_reverts(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", _mock_verdict(score=8))
        contract = direct_deploy(CONTRACT)

        contract.submit_evaluation("sub-008", _read_fixture("opus_report_excellent.txt"))
        with direct_vm.expect_revert("already evaluated"):
            contract.submit_evaluation(
                "sub-008", _read_fixture("opus_report_excellent.txt")
            )


# ── Malformed validator output ──────────────────────────────────────────────


class TestMalformedValidatorOutput:
    def test_invalid_json_reverts(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", "this is definitely not json")
        contract = direct_deploy(CONTRACT)

        with direct_vm.expect_revert():
            contract.submit_evaluation(
                "sub-009", _read_fixture("opus_report_excellent.txt")
            )

    def test_out_of_range_score_reverts(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", _mock_verdict(score=11))
        contract = direct_deploy(CONTRACT)

        with direct_vm.expect_revert():
            contract.submit_evaluation(
                "sub-010", _read_fixture("opus_report_excellent.txt")
            )

    def test_missing_dimensions_reverts(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(
            r".*",
            "```json\n" + json.dumps({"score": 8}) + "\n```",
        )
        contract = direct_deploy(CONTRACT)

        with direct_vm.expect_revert():
            contract.submit_evaluation(
                "sub-011", _read_fixture("opus_report_excellent.txt")
            )


# ── Getters ─────────────────────────────────────────────────────────────────


class TestGetters:
    def test_get_status_unknown_id_reverts(self, direct_vm, direct_deploy):
        contract = direct_deploy(CONTRACT)
        with direct_vm.expect_revert("not found"):
            contract.get_status("nonexistent")

    def test_get_score_unknown_id_reverts(self, direct_vm, direct_deploy):
        contract = direct_deploy(CONTRACT)
        with direct_vm.expect_revert("not found"):
            contract.get_score("nonexistent")

    def test_list_submissions_returns_all_ids(self, direct_vm, direct_deploy):
        direct_vm.mock_llm(r".*", _mock_verdict(score=7))
        contract = direct_deploy(CONTRACT)

        contract.submit_evaluation("sub-a", _read_fixture("opus_report_excellent.txt"))
        contract.submit_evaluation("sub-b", _read_fixture("opus_report_mediocre.txt"))

        ids = contract.list_submissions()
        assert set(ids) == {"sub-a", "sub-b"}
