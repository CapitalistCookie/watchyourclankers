"""watchyourclankers (wyc) — a read-only IDE-spectator for Claude Code.

Watch code generation happen live across every Claude Code session on this
machine, rendered as an over-the-shoulder IDE in a web UI. Read-only today;
pin / freeze / flag annotation stubs for tomorrow.

Backend: Python + aiohttp + JSONL (clanker's idiom). Frontend: vanilla JS +
CodeMirror 6, no build step. Designed to merge into clanker later via the
WebSocket contract in `wyc.contract` / `contracts/events.schema.json`.
"""

__version__ = "0.1.0"
