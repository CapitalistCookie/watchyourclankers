"""Behavioral tests for tools/check_handoff_fresh.py — the freshness gate logic.

Covers the two harness-gap fixes:
  * R14 — the HEAD~1-only allowance is generalised to "no CODE changed since the
    cited commit", so a CHAIN of docs-only commits no longer false-blocks the gate
    (the bug that forced a SKIP_CI push).
  * R15 — the PROSE currency markers (constitution version + `main@<sha>`) are
    gated, while HISTORICAL version mentions are NOT flagged (AP-8: a gate that
    false-fails is as bad as one that false-passes).

The git layer (`_git`) is monkeypatched so these run with no real repo state.
"""
import importlib.util
import os

import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_MOD = os.path.join(os.path.dirname(_HERE), "tools", "check_handoff_fresh.py")


def _load():
    spec = importlib.util.spec_from_file_location("check_handoff_fresh", _MOD)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture()
def chf():
    return _load()


def _fake_git(*, head="aaaaaaa", ancestors=(), diff_files=None):
    """Build a fake `_git` matching only the calls check_handoff_fresh makes.

    ancestors  : set of shas for which `merge-base --is-ancestor <sha> HEAD` is True
    diff_files : dict {cited_sha: "file\nlist"} for `diff --name-only <sha> HEAD`
    """
    diff_files = diff_files or {}

    def fake(*args):
        if args[:2] == ("rev-parse", "--short"):
            return head
        if args[:2] == ("merge-base", "--is-ancestor"):
            cited = args[2]
            return "" if cited in ancestors else None
        if args[:2] == ("diff", "--name-only"):
            cited = args[2]
            return diff_files.get(cited)
        return None
    return fake


# --------------------------------------------------------------------------- R14
def test_cited_equals_head_is_fresh(chf, monkeypatch):
    monkeypatch.setattr(chf, "_git", _fake_git(head="abcdef0"))
    assert chf._is_fresh("abcdef0", "abcdef0") is True


def test_chain_of_docs_only_commits_is_fresh(chf, monkeypatch):
    # THE false-block bug: cited is HEAD~2, both commits since touch only docs/.
    monkeypatch.setattr(chf, "_git", _fake_git(
        head="head000",
        ancestors={"cited00"},
        diff_files={"cited00": "docs/HANDOFF.md\ndocs/REMEDIATION.md"},
    ))
    assert chf._only_docs_since("cited00") is True
    assert chf._is_fresh("cited00", "head000") is True


def test_code_change_since_cited_is_stale(chf, monkeypatch):
    monkeypatch.setattr(chf, "_git", _fake_git(
        head="head000",
        ancestors={"cited00"},
        diff_files={"cited00": "docs/HANDOFF.md\ntools/check_handoff_fresh.py"},
    ))
    assert chf._only_docs_since("cited00") is False
    assert chf._is_fresh("cited00", "head000") is False


def test_cited_not_an_ancestor_is_stale(chf, monkeypatch):
    # rewritten history / unrelated sha: not an ancestor -> not fresh.
    monkeypatch.setattr(chf, "_git", _fake_git(head="head000", ancestors=set()))
    assert chf._only_docs_since("orphan0") is False


# --------------------------------------------------------------------------- R15
def test_prose_version_mismatch_fails(chf, monkeypatch):
    monkeypatch.setattr(chf, "_real_constitution_version", lambda: "1.2.0")
    body = "read `.specify/memory/constitution.md` (v1.1.0) first"
    errs = chf._check_prose_currency(body, head="head000")
    assert any("v1.1.0" in e and "v1.2.0" in e for e in errs), errs


def test_prose_version_match_passes(chf, monkeypatch):
    monkeypatch.setattr(chf, "_real_constitution_version", lambda: "1.2.0")
    body = "read `.specify/memory/constitution.md` (v1.2.0) first"
    assert chf._check_prose_currency(body, head="head000") == []


def test_historical_version_mentions_not_flagged(chf, monkeypatch):
    # AP-8: these are legitimate PAST mentions, not currency claims. None has a
    # `constitution.md (vX.Y.Z)` shape, so none must be flagged even though the
    # numbers differ from the real version.
    monkeypatch.setattr(chf, "_real_constitution_version", lambda: "1.2.0")
    body = ("constitution **1.0.0→1.1.0**; the prose once said v1.1.0 / 'W4 next'. "
            "Constitution 1.2.0 is current. Version 0.9.9 was the prototype.")
    assert chf._check_prose_currency(body, head="head000") == []


def test_stale_prose_resume_pointer_fails(chf, monkeypatch):
    monkeypatch.setattr(chf, "_real_constitution_version", lambda: "1.2.0")
    monkeypatch.setattr(chf, "_git", _fake_git(head="head000", ancestors=set()))
    body = "Resume (`main@deadbee`): ..."
    errs = chf._check_prose_currency(body, head="head000")
    assert any("deadbee" in e and "stale" in e for e in errs), errs


def test_fresh_prose_resume_pointer_passes(chf, monkeypatch):
    monkeypatch.setattr(chf, "_real_constitution_version", lambda: "1.2.0")
    # cited pointer is HEAD~1 and only docs changed since -> still fresh.
    monkeypatch.setattr(chf, "_git", _fake_git(
        head="head000", ancestors={"olddoc0"},
        diff_files={"olddoc0": "docs/HANDOFF.md"}))
    body = "Resume (`main@olddoc0`): ..."
    assert chf._check_prose_currency(body, head="head000") == []
