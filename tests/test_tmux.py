"""Tests for wyc.tmux (TmuxSource).

Self-contained (no shared conftest). tmux state on this box is LIVE, so the bulk
of the coverage is unit tests over the PURE seams:
  - the list-panes format PARSER (`_parse_panes`) with canned tmux output;
  - ancestor matching (`_match_identity`) with an injected fake ppid map;
  - thread_key derivation (group wins; `foo-10` -> `foo`);
  - the /proc/<pid>/stat ppid parser's robustness.
Plus a READ-ONLY live smoke that runs only when a tmux server is reachable.
"""
import sys
import os
import asyncio

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from wyc.tmux import (  # noqa: E402
    TmuxSource,
    tmux_available,
    _parse_panes,
    _match_identity,
    _ancestors,
    _strip_numeric_suffix,
    _read_ppid,
    _FS,
)


# ---------------------------------------------------------------- canned fixtures
def _row(pane_id, pane, pid, command, session, group,
         win_active="1", pane_active="1", title="x"):
    """Build one _FS-joined list-panes row in the exact field order tmux emits."""
    return _FS.join([
        pane_id, pane, str(pid), command, session, group,
        win_active, pane_active, title,
    ])


# real-shaped sample: a grouped claude pane, an ungrouped claude pane, a shell,
# and a non-claude tool pane.
CANNED = "\n".join([
    _row("%10", "constructionmanagement-10:1.1", 3885131, "claude",
         "constructionmanagement-10", "constructionmanagement", title="cm4"),
    _row("%14", "comms:1.1", 311873, "claude", "comms", "", title="comms4"),
    _row("%99", "scratch:0.0", 555, "bash", "scratch", "", title="$"),
    _row("%98", "htopwin:0.0", 666, "htop", "htopwin", "", title="htop"),
])


# ---------------------------------------------------------------- parser tests
def test_parse_keeps_only_claude():
    panes = _parse_panes(CANNED)
    cmds = sorted(p["command"] for p in panes)
    assert cmds == ["claude", "claude"], cmds          # bash + htop dropped
    sessions = sorted(p["tmux_session"] for p in panes)
    assert sessions == ["comms", "constructionmanagement-10"]


def test_parse_field_mapping():
    panes = _parse_panes(CANNED)
    by_sess = {p["tmux_session"]: p for p in panes}
    cm = by_sess["constructionmanagement-10"]
    assert cm["pane"] == "constructionmanagement-10:1.1"   # capture target
    assert cm["pane_id"] == "%10"
    assert cm["pid"] == 3885131
    assert cm["tmux_group"] == "constructionmanagement"
    assert cm["command"] == "claude"
    assert cm["active"] is True
    assert cm["title"] == "cm4"
    # contract dict shape — exactly these keys, no more, no less
    assert set(cm.keys()) == {
        "pane", "pane_id", "pid", "tmux_session", "tmux_group",
        "command", "active", "title",
    }


def test_parse_empty_group_is_none():
    panes = _parse_panes(CANNED)
    comms = [p for p in panes if p["tmux_session"] == "comms"][0]
    assert comms["tmux_group"] is None                 # tmux emits "" -> None


def test_parse_active_flag_requires_both_window_and_pane():
    rows = "\n".join([
        _row("%1", "s:0.0", 10, "claude", "s", "", win_active="1", pane_active="0"),
        _row("%2", "s:0.1", 11, "claude", "s", "", win_active="0", pane_active="1"),
        _row("%3", "s:1.0", 12, "claude", "s", "", win_active="1", pane_active="1"),
    ])
    panes = _parse_panes(rows)
    active = {p["pane_id"]: p["active"] for p in panes}
    assert active == {"%1": False, "%2": False, "%3": True}


def test_parse_handles_empty_and_blank_input():
    assert _parse_panes("") == []
    assert _parse_panes("\n\n   \n") == []


def test_parse_skips_malformed_rows():
    # a row with too few fields must be skipped, not misaligned
    bad = "only|two|fields"
    good = _row("%5", "k:0.0", 7, "claude", "k", "")
    panes = _parse_panes(bad + "\n" + good)
    assert len(panes) == 1
    assert panes[0]["pid"] == 7


def test_parse_title_with_spaces_preserved():
    # session_name / titles can contain spaces; _FS separation keeps them intact
    row = _row("%7", "gap:0.0", 9, "claude", "gap", "",
               title="Analyze post-gap trading patterns for SPY")
    panes = _parse_panes(row)
    assert panes[0]["title"] == "Analyze post-gap trading patterns for SPY"


def test_parse_deep_scan_keeps_claude_under_shell():
    # a `bash` pane whose tree contains claude is kept when a predicate says so
    rows = "\n".join([
        _row("%20", "wrap:0.0", 4000, "bash", "wrap", ""),   # shell wrapping claude
        _row("%21", "plain:0.0", 5000, "bash", "plain", ""), # plain shell, no claude
    ])
    panes = _parse_panes(rows, is_claude_pid=lambda pid: pid == 4000)
    assert len(panes) == 1
    assert panes[0]["pid"] == 4000
    assert panes[0]["tmux_session"] == "wrap"


def test_parse_without_predicate_drops_nonclaude_command():
    rows = _row("%20", "wrap:0.0", 4000, "bash", "wrap", "")
    assert _parse_panes(rows, is_claude_pid=None) == []


# ---------------------------------------------------------------- ancestor walk
def test_ancestors_with_fake_ppid_map():
    # 100 -> 90 -> 80 -> 1
    ppid = {100: 90, 90: 80, 80: 1}
    chain = _ancestors(100, lambda p: ppid.get(p))
    assert chain == [100, 90, 80]                      # stops before pid 1


def test_ancestors_stops_on_cycle():
    ppid = {10: 20, 20: 30, 30: 20}                    # 20 <-> 30 cycle
    chain = _ancestors(10, lambda p: ppid.get(p))
    # must terminate; each node appears at most once
    assert len(chain) == len(set(chain))
    assert chain[0] == 10
    assert set(chain) == {10, 20, 30}


def test_ancestors_pid_one_is_not_walked():
    # the cur > 1 guard means pid 1 (init) is never a chain member
    assert _ancestors(1, lambda p: 0) == []


def test_ancestors_stops_on_none_parent():
    chain = _ancestors(42, lambda p: None)
    assert chain == [42]


# ---------------------------------------------------------------- identity match
# Models the REAL shape: registry pid (claude) -> ppid is the pane's shell, whose
# pid IS the pane_pid. So matching must walk UP from the registry pid to the pane.
def _panes_for_identity():
    return [
        {"pid": 2411917, "pane": "clanker-0:1.1",
         "tmux_session": "clanker-0", "tmux_group": "clanker"},
        {"pid": 311873, "pane": "comms:1.1",
         "tmux_session": "comms", "tmux_group": None},
    ]


def test_identity_matches_via_ancestor_pane_pid():
    # registry claude pid 2411994 -> ppid 2411917 (the clanker-0 pane shell)
    ppid = {2411994: 2411917, 2411917: 2411770, 2411770: 1}
    pane = _match_identity(2411994, _panes_for_identity(), lambda p: ppid.get(p))
    assert pane is not None
    assert pane["pane"] == "clanker-0:1.1"
    assert pane["tmux_session"] == "clanker-0"
    assert pane["tmux_group"] == "clanker"


def test_identity_matches_when_pid_is_the_pane_pid_itself():
    ppid = {311873: 1}
    pane = _match_identity(311873, _panes_for_identity(), lambda p: ppid.get(p))
    assert pane is not None
    assert pane["pane"] == "comms:1.1"


def test_identity_matches_reverse_direction():
    # (b): the pane shell is a DESCENDANT of pid. Here pid 700 is the parent of the
    # comms pane_pid 311873 -> identity_for(700) should resolve to the comms pane.
    panes = _panes_for_identity()
    ppid = {311873: 700, 700: 1, 2411917: 1}
    pane = _match_identity(700, panes, lambda p: ppid.get(p))
    assert pane is not None
    assert pane["pane"] == "comms:1.1"


def test_identity_no_match_returns_none():
    ppid = {9999: 9998, 9998: 1}
    assert _match_identity(9999, _panes_for_identity(), lambda p: ppid.get(p)) is None


def test_identity_empty_panes_returns_none():
    assert _match_identity(123, [], lambda p: None) is None


def test_identity_for_none_pid():
    assert TmuxSource().identity_for(None) is None


# ---------------------------------------------------------------- thread_key
def test_thread_key_group_wins():
    src = TmuxSource()
    ident = {"tmux_session": "constructionmanagement-10",
             "tmux_group": "constructionmanagement", "pane": "x:0.0"}
    assert src.thread_key(ident) == "constructionmanagement"


def test_thread_key_strips_numeric_suffix_when_no_group():
    src = TmuxSource()
    ident = {"tmux_session": "fablenews-4", "tmux_group": None, "pane": "x:0.0"}
    assert src.thread_key(ident) == "fablenews"


def test_thread_key_plain_session_unchanged():
    src = TmuxSource()
    ident = {"tmux_session": "comms", "tmux_group": None, "pane": "x:0.0"}
    assert src.thread_key(ident) == "comms"


def test_thread_key_none_and_empty():
    src = TmuxSource()
    assert src.thread_key(None) is None
    assert src.thread_key({}) is None
    assert src.thread_key({"tmux_session": None, "tmux_group": None}) is None


def test_strip_numeric_suffix_cases():
    assert _strip_numeric_suffix("foo-10") == "foo"
    assert _strip_numeric_suffix("foo") == "foo"
    assert _strip_numeric_suffix("foo-bar") == "foo-bar"      # non-numeric suffix kept
    assert _strip_numeric_suffix("toxicflow-3") == "toxicflow"
    assert _strip_numeric_suffix("a-b-12") == "a-b"          # only the last -N
    assert _strip_numeric_suffix("-5") == "-5"               # no stem -> unchanged


# ---------------------------------------------------------------- /proc parser
def test_read_ppid_handles_comm_with_parens(tmp_path, monkeypatch):
    # /proc/<pid>/stat: `PID (comm) STATE PPID ...`; comm may contain spaces/parens.
    # We can't fabricate /proc, but we can verify the rfind(')')-based split logic
    # by patching open() to return a crafted stat line.
    crafted = "4242 (weird (cmd) name) S 99 4242 99 0 -1 ...\n"

    import builtins
    real_open = builtins.open

    def fake_open(path, *a, **k):
        if isinstance(path, str) and path.endswith("/4242/stat"):
            import io
            return io.StringIO(crafted)
        return real_open(path, *a, **k)

    monkeypatch.setattr(builtins, "open", fake_open)
    assert _read_ppid(4242) == 99


def test_read_ppid_missing_pid_returns_none():
    # a pid that (effectively) never exists
    assert _read_ppid(2_000_000_000) is None


# ---------------------------------------------------------------- stream (async)
def test_stream_yields_only_on_change(monkeypatch):
    src = TmuxSource()
    frames = iter(["A", "A", "B", "B", "C"])

    def fake_capture(pane, history=0):
        try:
            return next(frames)
        except StopIteration:
            return ""          # pane gone -> empty -> generator should not yield it

    monkeypatch.setattr(src, "capture", fake_capture)

    async def drive():
        out = []
        gen = src.stream("p:0.0", interval=0.01)
        # pull 3 distinct frames (A, B, C); the dupes and trailing "" are filtered
        async for frame in gen:
            out.append(frame)
            if len(out) == 3:
                await gen.aclose()
                break
        return out

    got = asyncio.run(drive())
    assert got == ["A", "B", "C"]


# ---------------------------------------------------------------- LIVE smoke (read-only)
def test_live_smoke_readonly():
    """READ-ONLY: enumerate real claude panes if a tmux server is up; else skip.

    Never writes to tmux. Prints a small diagnostic so the operator can eyeball
    what was discovered."""
    if not tmux_available():
        print("[live-smoke] no tmux server reachable — skipping")
        return
    src = TmuxSource()
    panes = src.panes()
    print(f"[live-smoke] claude panes found: {len(panes)}")
    for p in panes[:6]:
        print(f"  pane={p['pane']!r} session={p['tmux_session']!r} "
              f"group={p['tmux_group']!r} active={p['active']} pid={p['pid']}")
        # every live pane dict must have the contract shape
        assert set(p.keys()) == {
            "pane", "pane_id", "pid", "tmux_session", "tmux_group",
            "command", "active", "title",
        }
        assert p["command"] == "claude" or src._deep_scan

    # identity round-trip on a real pane_pid: its own pid must resolve to itself.
    if panes:
        sample_pid = panes[0]["pid"]
        ident = src.identity_for(sample_pid)
        print(f"[live-smoke] identity_for(pane_pid={sample_pid}) -> {ident}")
        assert ident is not None
        assert ident["pane"] == panes[0]["pane"]
        key = src.thread_key(ident)
        print(f"[live-smoke] thread_key -> {key!r}")
        assert key  # non-empty

        # capture is read-only and returns a string (possibly empty)
        snap = src.capture(panes[0]["pane"])
        print(f"[live-smoke] capture({panes[0]['pane']!r}) -> {len(snap)} chars")
        assert isinstance(snap, str)


if __name__ == "__main__":
    # allow `python3 tests/test_tmux.py` to run the live smoke directly
    test_live_smoke_readonly()
