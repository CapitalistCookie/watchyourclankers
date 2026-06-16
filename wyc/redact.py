"""wyc.redact — secrets never reach the glass (constitution Principle II). PARENT-ONLY.

Transcripts on this box are full of credentials (the global CLAUDE.md is
wall-to-wall secrets). Every string bound for the wire passes through redact()
first. Patterns are intentionally broad and fail-safe: better to mask a
non-secret than leak a real one. Also supports an exact-value denylist loaded
from DATA_DIR/denylist.txt (one secret per line) for known literals.
"""
from __future__ import annotations

import os
import re
from typing import Optional

from . import contract

_MASK = "••••redacted••••"

# Order matters: most specific first.
_PATTERNS: list[re.Pattern] = [
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
    re.compile(r"\b(?:gh[posu]|github_pat)_[A-Za-z0-9_]{20,}\b"),          # GitHub tokens
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),                                    # AWS access key id
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"),                        # Slack
    re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"),                                 # OpenAI-style
    re.compile(r"\bAIza[0-9A-Za-z_\-]{20,}\b"),                             # Google API key
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"),  # JWT
    # connection strings with inline credentials: proto://user:pass@host
    re.compile(r"\b([a-zA-Z][a-zA-Z0-9+.\-]*://)[^\s:/@]+:[^\s:/@]+@"),
    # KEY=VALUE / "key": "value" where the key name smells secret
    re.compile(r"(?i)\b(pass(?:word)?|passwd|secret|token|api[_-]?key|access[_-]?key|"
               r"private[_-]?key|client[_-]?secret|pgpassword|auth)\b\s*[:=]\s*['\"]?([^\s'\"]{4,})"),
    # bearer tokens
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{12,}"),
    # long high-entropy-ish blobs (>=28 chars of token alphabet) as a backstop
    re.compile(r"\b[A-Za-z0-9_\-]{28,}\b"),
]

_denylist: Optional[list[str]] = None


def _load_denylist() -> list[str]:
    global _denylist
    if _denylist is None:
        path = os.path.join(contract.DATA_DIR, "denylist.txt")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                _denylist = [ln.strip() for ln in fh if ln.strip() and not ln.startswith("#")]
        except OSError:
            _denylist = []
    return _denylist


def redact(text: Optional[str]) -> Optional[str]:
    """Mask secrets in a free-text string. Safe on None."""
    if not text:
        return text
    out = text
    for secret in _load_denylist():
        if secret and secret in out:
            out = out.replace(secret, _MASK)
    for pat in _PATTERNS:
        if pat.groups == 2:
            # keep the key name / scheme, mask the value
            out = pat.sub(lambda m: m.group(0).replace(m.group(2), _MASK), out)
        elif pat.groups == 1:
            out = pat.sub(lambda m: m.group(0).replace(m.group(1), _MASK), out)
        else:
            out = pat.sub(_MASK, out)
    return out


def redact_activity(a: "contract.Activity") -> "contract.Activity":
    a.hunk_old = redact(a.hunk_old)
    a.hunk_new = redact(a.hunk_new)
    a.detail = redact(a.detail)
    return a


def redact_terminal(t: "contract.Terminal") -> "contract.Terminal":
    t.data = redact(t.data) or ""
    return t


# Make the contract's stub resolve to the real implementation when imported.
contract.redact = redact  # type: ignore[assignment]
