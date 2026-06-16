"""setup.py — thin shim over the PEP 621 metadata in pyproject.toml.

Its ONLY job is a custom build step (M1 of the clanker-merge plan): copy the
repo-root `web/` (the frontend) and `contracts/` (the wire schema) UNDER the `wyc`
package at build time, so a built wheel contains `wyc/web/**` + `wyc/contracts/**`
and `wyc.server._web_dir()` finds them when pip-installed (non-editable).

Why a build-time copy instead of moving the dirs: `web/` + `contracts/` stay at the
repo root where every gate, the constitution, and the H15 agent/parent matrix
already reference them — moving them would ripple across all of that. setuptools
(the available backend; hatchling isn't installed) has no `force-include`, so we
do the copy in a build_py subclass. Editable installs (`pip install -e .`) use the
source tree directly and resolve `web/` via _web_dir()'s repo-root fallback.
"""
from __future__ import annotations

import os
import shutil

from setuptools import setup
from setuptools.command.build_py import build_py

_ASSET_DIRS = ("web", "contracts")
_IGNORE = shutil.ignore_patterns("__pycache__", "*.pyc", "*.test.mjs", ".DS_Store")


class build_py_with_assets(build_py):
    """Standard build_py, then drop web/ + contracts/ into the built wyc package."""

    def run(self) -> None:
        super().run()
        for name in _ASSET_DIRS:
            src = os.path.join(os.path.dirname(os.path.abspath(__file__)), name)
            if not os.path.isdir(src):
                continue
            dst = os.path.join(self.build_lib, "wyc", name)
            if os.path.exists(dst):
                shutil.rmtree(dst)
            shutil.copytree(src, dst, ignore=_IGNORE)
            self.announce(f"[build] vendored {name}/ -> wyc/{name}/ for the wheel", level=2)


setup(cmdclass={"build_py": build_py_with_assets})
