"""Tests for the wyc backend feed (sessions/transcripts/threads/watcher).

pytest-style: plain `def test_*` with bare asserts, small inline fixtures via
`tmp_path`. No shared conftest. Run: `python3 -m pytest -q tests/test_feed.py`.

The `__main__` block at the bottom is a READ-ONLY live demo (constitution H10 /
Principle XI step 3): it polls the REAL contract.SESSIONS_DIR once and prints the
discovered sessions + their resolved projects. It never writes to ~/.claude.
"""
from __future__ import annotations

import json
import os
import sys

# Make the repo root importable when run directly (python3 tests/test_feed.py).
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from wyc import contract
from wyc.transcripts import TranscriptReader, parse_ts, cwd_to_slug
from wyc.threads import ThreadStitcher, levenshtein, name_stem
from wyc.sessions import SessionPoller


# --------------------------------------------------------------------------
# parse(): assistant tool_use line
# --------------------------------------------------------------------------
def test_parse_assistant_tool_use():
    line = {
        "type": "assistant",
        "timestamp": "2026-06-04T02:53:40.639Z",
        "sessionId": "sess-abc",
        "cwd": "/home/user/projects/foo",
        "message": {
            "content": [
                {"type": "text", "text": "I'll edit it."},
                {"type": "tool_use", "id": "toolu_01", "name": "Edit",
                 "input": {"file_path": "/x/y.py", "old_string": "a", "new_string": "b"}},
                {"type": "tool_use", "id": "toolu_02", "name": "Bash",
                 "input": {"command": "ls -la", "description": "list"}},
            ],
        },
    }
    out = TranscriptReader.parse(line)
    assert len(out) == 2, "one RawLine per tool_use block"
    edit, bash = out
    assert edit.tool == "Edit"
    assert edit.tool_use_id == "toolu_01"
    assert edit.file_path == "/x/y.py"
    assert edit.inp["old_string"] == "a" and edit.inp["new_string"] == "b"
    assert edit.is_result is False
    assert edit.session_id == "sess-abc"
    assert edit.cwd == "/home/user/projects/foo"
    # timestamp parsed to epoch seconds (UTC), not left as a string.
    assert isinstance(edit.ts, float) and edit.ts > 1.0e9
    assert bash.tool == "Bash" and bash.inp["command"] == "ls -la"


def test_parse_sets_agent_id():
    line = {
        "type": "assistant", "timestamp": "2026-06-04T02:53:40Z",
        "sessionId": "s", "cwd": "/c",
        "message": {"content": [
            {"type": "tool_use", "id": "t", "name": "Read", "input": {"file_path": "/f"}},
        ]},
    }
    out = TranscriptReader.parse(line, agent_id="aab4eb1c")
    assert len(out) == 1 and out[0].agent_id == "aab4eb1c"


# --------------------------------------------------------------------------
# parse(): tool_result line (str content AND list content, error flag)
# --------------------------------------------------------------------------
def test_parse_tool_result_str():
    line = {
        "type": "user",
        "timestamp": "2026-06-04T02:53:40.783Z",
        "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_02",
             "content": "total 0\nfile.txt", "is_error": False},
        ]},
    }
    out = TranscriptReader.parse(line)
    assert len(out) == 1
    r = out[0]
    assert r.is_result is True
    assert r.tool_use_id == "toolu_02"
    assert r.result_text == "total 0\nfile.txt"
    assert r.is_error is False
    assert r.tool == "", "tool name is unknown at the result line"


def test_parse_tool_result_list_and_error():
    line = {
        "type": "user", "timestamp": "2026-06-04T02:53:40.783Z",
        "message": {"content": [
            {"type": "tool_result", "tool_use_id": "toolu_03",
             "content": [{"type": "text", "text": "boom "}, {"type": "text", "text": "fail"}],
             "is_error": True},
        ]},
    }
    out = TranscriptReader.parse(line)
    assert len(out) == 1
    assert out[0].result_text == "boom fail", "list content is flattened"
    assert out[0].is_error is True


def test_parse_ignores_other_lines():
    for t in ("system", "mode", "attachment", "ai-title", "file-history-snapshot"):
        assert TranscriptReader.parse({"type": t, "message": {"content": []}}) == []
    # Non-dict / missing message must not crash.
    assert TranscriptReader.parse({"type": "assistant"}) == []
    assert TranscriptReader.parse({}) == []


def test_parse_ts_formats():
    assert parse_ts("2026-06-04T02:53:40.639Z") > 1.0e9
    assert parse_ts("2026-06-04T02:53:40Z") > 1.0e9
    assert parse_ts(1781315919.0) == 1781315919.0
    assert parse_ts(1781315919951) == 1781315919.951   # ms heuristic
    assert parse_ts(None) == 0.0
    assert parse_ts("garbage") == 0.0


# --------------------------------------------------------------------------
# kind_for_tool: TOTALITY (Principle IV) — unknown -> other, never a crash
# --------------------------------------------------------------------------
def test_kind_for_tool_totality():
    known = {
        "Edit": "edit", "MultiEdit": "edit", "Write": "write", "Read": "read",
        "Bash": "bash", "Grep": "search", "Glob": "search", "LS": "search",
        "Task": "task", "TodoWrite": "todo", "WebFetch": "web", "WebSearch": "web",
    }
    for tool, kind in known.items():
        assert contract.kind_for_tool(tool) == kind
    # Unknown / weird inputs all collapse to KIND_OTHER, no exception.
    for weird in ("TotallyNewTool", "", "x" * 200, "Edit ", "bash"):
        assert contract.kind_for_tool(weird) == contract.KIND_OTHER
    # Every mapped kind is a valid wire enum.
    valid = {"edit", "write", "read", "bash", "search", "task", "todo", "web", "other"}
    for v in contract.TOOL_KIND.values():
        assert v in valid


# --------------------------------------------------------------------------
# read_new: offset / append + rotation reset
# --------------------------------------------------------------------------
def _assistant_line(tool, file_path=None, **inp):
    d = {"type": "assistant", "timestamp": "2026-06-04T02:53:40Z",
         "sessionId": "s", "cwd": "/c",
         "message": {"content": [{"type": "tool_use", "id": "t", "name": tool,
                                  "input": dict(inp)}]}}
    if file_path:
        d["message"]["content"][0]["input"]["file_path"] = file_path
    return json.dumps(d) + "\n"


def test_read_new_offset_and_append(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text(_assistant_line("Read", "/a") + _assistant_line("Edit", "/b"))
    tr = TranscriptReader(projects_dir=str(tmp_path))

    lines1, off1 = tr.read_new(str(p), 0)
    assert [l.tool for l in lines1] == ["Read", "Edit"]
    assert off1 == p.stat().st_size

    # No new bytes -> nothing, offset unchanged.
    lines2, off2 = tr.read_new(str(p), off1)
    assert lines2 == [] and off2 == off1

    # Append one more line -> only the new line is returned.
    with open(p, "a") as fh:
        fh.write(_assistant_line("Bash", command="echo hi"))
    lines3, off3 = tr.read_new(str(p), off2)
    assert [l.tool for l in lines3] == ["Bash"]
    assert off3 == p.stat().st_size


def test_read_new_partial_line_not_consumed(tmp_path):
    p = tmp_path / "t.jsonl"
    full = _assistant_line("Read", "/a")
    # Write a complete line + a trailing partial (no newline).
    p.write_text(full + '{"type":"assistant","timestamp":"2026')
    tr = TranscriptReader(projects_dir=str(tmp_path))
    lines, off = tr.read_new(str(p), 0)
    assert [l.tool for l in lines] == ["Read"]
    # Offset must stop right after the complete line, NOT into the partial.
    assert off == len(full)
    # Now complete the partial line; it should now be read.
    with open(p, "a") as fh:
        fh.write('-06-04T02:53:40Z","sessionId":"s","cwd":"/c",'
                 '"message":{"content":[{"type":"tool_use","id":"t2",'
                 '"name":"Edit","input":{"file_path":"/b"}}]}}\n')
    lines2, off2 = tr.read_new(str(p), off)
    assert [l.tool for l in lines2] == ["Edit"]


def test_read_new_rotation_reset(tmp_path):
    p = tmp_path / "t.jsonl"
    p.write_text(_assistant_line("Read", "/a") + _assistant_line("Edit", "/b"))
    tr = TranscriptReader(projects_dir=str(tmp_path))
    _, off = tr.read_new(str(p), 0)
    assert off > 0

    # Rotate: file shrinks (truncated/replaced) and is now smaller than offset.
    p.write_text(_assistant_line("Bash", command="x"))
    lines, off2 = tr.read_new(str(p), off)
    # Reader must reset to 0 and re-read the whole (smaller) file.
    assert [l.tool for l in lines] == ["Bash"]
    assert off2 == p.stat().st_size


def test_read_new_missing_file(tmp_path):
    tr = TranscriptReader(projects_dir=str(tmp_path))
    lines, off = tr.read_new(str(tmp_path / "nope.jsonl"), 0)
    assert lines == [] and off == 0


# --------------------------------------------------------------------------
# transcript_path / subagent_paths locate by glob
# --------------------------------------------------------------------------
def test_transcript_and_subagent_paths(tmp_path):
    slug = cwd_to_slug("/home/user/projects/foo")  # -home-user-projects-foo
    assert slug == "-home-user-projects-foo"
    sdir = tmp_path / slug
    (sdir / "sess-xyz" / "subagents").mkdir(parents=True)
    (sdir / "sess-xyz.jsonl").write_text(_assistant_line("Read", "/a"))
    (sdir / "sess-xyz" / "subagents" / "agent-aaa111.jsonl").write_text(
        _assistant_line("Grep", pattern="foo"))

    tr = TranscriptReader(projects_dir=str(tmp_path))
    assert tr.transcript_path("sess-xyz") == str(sdir / "sess-xyz.jsonl")
    assert tr.transcript_path("does-not-exist") is None

    subs = tr.subagent_paths("sess-xyz")
    assert len(subs) == 1
    assert subs[0].endswith("subagents/agent-aaa111.jsonl")
    # The agent id is recovered from the path.
    assert TranscriptReader._agent_id_for_path(subs[0]) == "aaa111"


# --------------------------------------------------------------------------
# Levenshtein + name-stem clustering, incl. the TYPO case (comms3 / coms4)
# --------------------------------------------------------------------------
def test_levenshtein():
    assert levenshtein("comms", "comms") == 0
    assert levenshtein("comms", "coms") == 1     # one deletion
    assert levenshtein("kitten", "sitting") == 3
    assert levenshtein("", "abc") == 3
    assert levenshtein("abc", "") == 3


def test_name_stem_strips_versions():
    assert name_stem("comms4") == "comms"
    assert name_stem("comms-v3") == "comms"
    assert name_stem("Comms_final") == "comms"
    assert name_stem("dronespec") == "dronespec"
    assert name_stem("speckiteccdashboard3") == "speckiteccdashboard"
    assert name_stem(None) == ""


def test_name_stem_typo_clusters_via_levenshtein():
    """comms3 and coms4 (a typo) must land in one thread by stem distance <=2."""
    st = ThreadStitcher(data_dir="/tmp/wyc-nonexistent-test-do-not-write", time_window=0.0)
    a = contract.Session(id="A", thread_id="", status="idle", name="comms3",
                         cwd="/home/user/projects/comms", project="comms",
                         started_at=1000.0, updated_at=1000.0)
    b = contract.Session(id="B", thread_id="", status="busy", name="coms4",
                         cwd="/home/user/projects/comms", project="comms",
                         started_at=5_000_000.0, updated_at=5_000_000.0)
    ta = st.assign(a, [])
    tb = st.assign(b, [])
    # Distinct names, same project, stems within edit-distance 1 -> SAME thread.
    assert ta.id == tb.id, "typo'd names should cluster (comms/coms dist=1)"
    assert "name-stem" in tb.stitch
    assert set(tb.session_ids) == {"A", "B"}


def test_different_projects_do_not_cluster():
    st = ThreadStitcher(data_dir="/tmp/wyc-nonexistent-test-2", time_window=0.0)
    a = contract.Session(id="A", thread_id="", status="idle", name="comms",
                         cwd="/p/comms", project="comms",
                         started_at=1000.0, updated_at=1000.0)
    b = contract.Session(id="B", thread_id="", status="idle", name="comms",
                         cwd="/p/other", project="other",
                         started_at=1000.0, updated_at=1000.0)
    assert st.assign(a, []).id != st.assign(b, []).id


# --------------------------------------------------------------------------
# Handoff-doc lineage stitch — A writes HANDOFF.md, B reads it -> same thread,
# EVEN with mismatched names (typo-immune authoritative stitch).
# --------------------------------------------------------------------------
def test_handoff_doc_lineage_stitch_mismatched_names():
    st = ThreadStitcher(data_dir="/tmp/wyc-nonexistent-test-3", time_window=0.0)
    handoff = "/home/user/projects/proj/docs/HANDOFF.md"

    a = contract.Session(id="A", thread_id="", status="idle", name="alpha",
                         cwd="/home/user/projects/proj", project="proj",
                         started_at=1000.0, updated_at=2000.0)
    # A WRITES the handoff doc.
    a_lines = [contract.RawLine(ts=1500.0, session_id="A", cwd="/p", tool="Write",
                                tool_use_id="w1", file_path=handoff,
                                inp={"content": "next steps..."})]
    ta = st.assign(a, a_lines)

    # B has a COMPLETELY DIFFERENT name (no stem overlap) and starts far later
    # (no time-contiguity), but READS the same handoff doc.
    b = contract.Session(id="B", thread_id="", status="busy", name="zeta-unrelated",
                         cwd="/home/user/projects/proj", project="proj",
                         started_at=9_000_000.0, updated_at=9_000_000.0)
    b_lines = [contract.RawLine(ts=9_000_001.0, session_id="B", cwd="/p", tool="Read",
                                tool_use_id="r1", file_path=handoff, inp={"file_path": handoff})]
    tb = st.assign(b, b_lines)

    assert ta.id == tb.id, "handoff Write->Read must stitch across mismatched names"
    assert "handoff-doc" in tb.stitch
    assert set(tb.session_ids) == {"A", "B"}


def test_operator_alias_is_sticky(tmp_path):
    st = ThreadStitcher(data_dir=str(tmp_path))
    st.alias("frontend", "ui")
    # Reload from disk -> alias persisted (sticky across "restart").
    st2 = ThreadStitcher(data_dir=str(tmp_path))
    assert st2._aliases.get("frontend") == "ui"


def test_operator_merge_is_sticky(tmp_path):
    st = ThreadStitcher(data_dir=str(tmp_path), time_window=0.0)
    a = contract.Session(id="A", thread_id="", status="idle", name="aaa",
                         cwd="/p/x", project="x", started_at=1.0, updated_at=2.0)
    b = contract.Session(id="B", thread_id="", status="idle", name="bbb",
                         cwd="/p/x", project="x", started_at=100.0, updated_at=101.0)
    ta = st.assign(a, [])
    tb = st.assign(b, [])
    assert ta.id != tb.id  # different stems, no time overlap -> separate
    merged = st.merge(ta.id, tb.id)
    assert set(merged.session_ids) == {"A", "B"}
    assert "manual" in merged.stitch
    # Sticky: a fresh stitcher loads the override and pins B to A's thread.
    st2 = ThreadStitcher(data_dir=str(tmp_path), time_window=0.0)
    assert st2._overrides.get("B") == ta.id
    tb2 = st2.assign(b, [])
    assert tb2.id == ta.id, "operator merge wins over inference after restart"


# --------------------------------------------------------------------------
# Redaction is applied on the wire (Principle II) — a secret in hunk_new is
# masked by the time it reaches the broadcast envelope.
# --------------------------------------------------------------------------
def test_watcher_redacts_activity_secret():
    from wyc.watcher import Watcher

    secret = "ghp_" + "A" * 36  # GitHub-token shaped
    w = Watcher(poll_interval=999)
    sess = contract.Session(id="S", thread_id="th_x", status="busy",
                            cwd="/p", project="p")
    raw = contract.RawLine(ts=1000.0, session_id="S", cwd="/p", tool="Write",
                           tool_use_id="w1", file_path="/secrets.py",
                           inp={"content": f"TOKEN = '{secret}'"})
    w._emit_activity_from_raw(raw, sess)

    # The broadcast pushed an `activity` envelope into the replay buffer.
    acts = [env for (_s, env) in w._replay if env.get("t") == "activity"]
    assert acts, "an activity envelope was emitted"
    hunk = acts[-1]["activity"]["hunk_new"]
    assert secret not in hunk, "raw secret must NOT reach the wire"
    assert "redacted" in hunk, "secret value replaced by the mask"


def test_watcher_bash_emits_terminal_on_result():
    from wyc.watcher import Watcher
    w = Watcher(poll_interval=999)
    sess = contract.Session(id="S", thread_id="th_x", status="busy", cwd="/p", project="p")
    use = contract.RawLine(ts=1.0, session_id="S", cwd="/p", tool="Bash",
                           tool_use_id="b1", inp={"command": "echo hi"})
    w._emit_activity_from_raw(use, sess)
    res = contract.RawLine(ts=2.0, session_id="S", cwd="/p", tool="",
                           tool_use_id="b1", is_result=True, result_text="hi\n")
    w._emit_result_from_raw(res)

    terms = [env for (_s, env) in w._replay if env.get("t") == "terminal"]
    assert terms, "a terminal envelope follows the bash tool_result"
    t = terms[-1]["terminal"]
    assert t["data"] == "hi\n" and t["done"] is True
    # ref_seq correlates the terminal to the originating bash Activity.
    bash_act = [env for (_s, env) in w._replay
                if env.get("t") == "activity" and env["activity"]["kind"] == "bash"][0]
    assert t["ref_seq"] == bash_act["activity"]["seq"]


def test_watcher_since_replay_and_gap():
    from wyc.watcher import Watcher
    w = Watcher(poll_interval=999)
    sess = contract.Session(id="S", thread_id="th_x", status="busy", cwd="/p", project="p")
    for i in range(5):
        w._emit_activity_from_raw(
            contract.RawLine(ts=float(i), session_id="S", cwd="/p", tool="Read",
                             tool_use_id=f"r{i}", file_path=f"/f{i}"), sess)

    import asyncio as _a
    # since(0) replays everything currently buffered.
    got = _a.run(w.since(0))
    assert len(got) == 5
    # since(current) returns nothing new.
    assert _a.run(w.since(w._seq)) == []


# --------------------------------------------------------------------------
# sessions: malformed registry files are skipped, not fatal
# --------------------------------------------------------------------------
def test_session_poller_skips_malformed(tmp_path):
    good = {"pid": os.getpid(), "sessionId": "uuid-good", "cwd": "/home/user",
            "name": "demo", "status": "busy", "startedAt": 1781315919951,
            "updatedAt": int((__import__("time").time()) * 1000)}
    (tmp_path / "1.json").write_text(json.dumps(good))
    (tmp_path / "2.json").write_text("{not valid json")          # malformed
    (tmp_path / "3.json").write_text("")                          # empty
    (tmp_path / "4.json").write_text(json.dumps({"pid": 1}))      # no sessionId

    poller = SessionPoller(sessions_dir=str(tmp_path),
                           resolve_project=lambda cwd: "global",
                           transcript_mtime=lambda sid: None)
    out = poller.poll()
    ids = {s.id for s in out}
    assert ids == {"uuid-good"}, "only the well-formed, identifiable session survives"
    s = out[0]
    assert s.pid == os.getpid()
    assert s.status == "busy"            # fresh updatedAt + alive pid
    assert s.started_at == 1781315919.951  # ms -> seconds
    assert s.project == "global"


def test_session_poller_status_ended_for_dead_pid(tmp_path):
    # A pid that is essentially never alive + stale timestamps -> ended.
    old_ms = int(((__import__("time").time()) - 10_000) * 1000)
    rec = {"pid": 2_147_480_000, "sessionId": "uuid-dead", "cwd": "/home/user",
           "status": "busy", "startedAt": old_ms, "updatedAt": old_ms}
    (tmp_path / "1.json").write_text(json.dumps(rec))
    poller = SessionPoller(sessions_dir=str(tmp_path),
                           resolve_project=lambda cwd: "global",
                           transcript_mtime=lambda sid: None)
    out = poller.poll()
    assert len(out) == 1 and out[0].status == "ended"


# --------------------------------------------------------------------------
# LIVE READ-ONLY demo (Principle XI step 3 / CLAUDE.md rule 10).
# --------------------------------------------------------------------------
if __name__ == "__main__":
    print(f"[live] polling {contract.SESSIONS_DIR} (READ-ONLY)\n")
    from wyc.threads import resolve_project_source
    print(f"[live] resolve_project source = {resolve_project_source()}\n")
    poller = SessionPoller()
    sessions = poller.poll()
    print(f"[live] discovered {len(sessions)} session(s):")
    for s in sessions:
        print(f"  status={s.status:6s} pid={s.pid} name={s.name!r:28s} "
              f"project={s.project!r:24s} cwd={s.cwd} id={s.id[:8]}")
    print("\n[live] (no files were written under ~/.claude)")
