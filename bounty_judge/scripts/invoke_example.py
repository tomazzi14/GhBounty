#!/usr/bin/env python3
"""Invoke BountyJudge.submit_evaluation on a deployed contract.

Uses the genlayer CLI under the hood (you must have unlocked your account
via `genlayer account unlock` first). Reads the Opus report fixture from
disk and passes it along with submission metadata.

Usage:
    invoke_example.py <contract_address> <submission_id> <fixture_name>

Example:
    invoke_example.py 0x9Fc8399a73Df0DcFA4675DEDBdD09ea6d6924AEb \\
        excellent-1 opus_report_excellent.txt
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures"


def invoke(contract_addr: str, submission_id: str, fixture_name: str) -> int:
    fixture_path = FIXTURES / fixture_name
    if not fixture_path.exists():
        print(f"fixture not found: {fixture_path}", file=sys.stderr)
        return 1

    opus_report = fixture_path.read_text(encoding="utf-8")

    cmd = [
        "genlayer",
        "write",
        contract_addr,
        "submit_evaluation",
        "--args",
        submission_id,
        opus_report,
        "",  # pr_url (not used on testnet)
        "",  # issue_url
        "",  # github_token
    ]

    print(f"→ calling submit_evaluation({submission_id!r}, <{len(opus_report)} chars>)")
    result = subprocess.run(cmd)
    return result.returncode


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(2)
    sys.exit(invoke(sys.argv[1], sys.argv[2], sys.argv[3]))
