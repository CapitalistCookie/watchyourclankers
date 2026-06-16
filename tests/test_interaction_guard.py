"""Tests for the interaction_guard PreToolUse hook (audit #4)."""
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from tools.interaction_guard import is_interaction_file, build_context  # noqa: E402

GUARD = os.path.join(ROOT, "tools", "interaction_guard.py")


def test_is_interaction_file_matches_wyc_interaction_modules():
    assert is_interaction_file("/home/user/projects/watchyourclankers/web/ide.js")
    assert is_interaction_file("/home/user/projects/watchyourclankers/web/mosaic.js")
    assert is_interaction_file("watchyourclankers/web/resize.js")
    assert is_interaction_file("watchyourclankers/web/debug.js")


def test_is_interaction_file_ignores_others():
    assert not is_interaction_file("/home/user/projects/watchyourclankers/web/store.js")
    assert not is_interaction_file("/home/user/projects/watchyourclankers/wyc/server.py")
    assert not is_interaction_file("/home/user/projects/other/web/ide.js")  # wrong repo
    assert not is_interaction_file(None)
    assert not is_interaction_file("")


def test_build_context_carries_the_discipline():
    ac = build_context("web/ide.js")["hookSpecificOutput"]["additionalContext"]
    # contract-first (step 0, L9) MUST lead — the recurring failure was editing the
    # symptomatic file without first reading the contract seam.
    for needle in ("CONTRACT SEAM FIRST", "contract.py", "RED-FIRST", "ci/interaction.mjs", "H9", "PURE"):
        assert needle in ac, needle


def test_hook_emits_reminder_for_interaction_file():
    payload = json.dumps({"tool_name": "Edit",
                          "tool_input": {"file_path": "/x/watchyourclankers/web/ide.js"}})
    out = subprocess.run([sys.executable, GUARD], input=payload, capture_output=True, text=True)
    assert out.returncode == 0
    assert "interaction-guard" in out.stdout
    parsed = json.loads(out.stdout)  # valid hook JSON
    assert parsed["hookSpecificOutput"]["hookEventName"] == "PreToolUse"


def test_hook_silent_for_non_interaction_file():
    payload = json.dumps({"tool_name": "Edit", "tool_input": {"file_path": "/x/foo.py"}})
    out = subprocess.run([sys.executable, GUARD], input=payload, capture_output=True, text=True)
    assert out.returncode == 0 and out.stdout.strip() == ""


def test_hook_survives_bad_payload():
    out = subprocess.run([sys.executable, GUARD], input="not json", capture_output=True, text=True)
    assert out.returncode == 0  # never break a tool call
