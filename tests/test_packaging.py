"""Packaging guards (M1 of the clanker-merge plan): keep the pip-install-from-git
config honest so `pip install git+https://…/watchyourclankers` keeps working (the
chosen distribution mechanism — clanker depends on this package).

Light + offline: parses pyproject.toml + reads setup.py; it does NOT build a wheel
(that's a heavier ci/full.sh step). The full build→install→_web_dir round-trip was
verified by hand; these lock the config that silently rots.
"""
from __future__ import annotations

import os
import py_compile
import sys

import pytest

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

tomllib = pytest.importorskip("tomllib")  # stdlib on 3.11+ (this box is 3.13)


def _pyproject() -> dict:
    with open(os.path.join(_ROOT, "pyproject.toml"), "rb") as fh:
        return tomllib.load(fh)


def test_pyproject_parses_and_has_project_metadata():
    proj = _pyproject()["project"]
    assert proj["name"] == "watchyourclankers"
    assert proj["version"]
    assert proj["requires-python"]


def test_aiohttp_is_the_runtime_dep():
    deps = _pyproject()["project"]["dependencies"]
    assert any(d.replace(" ", "").startswith("aiohttp") for d in deps), deps


def test_console_script_points_at_main():
    scripts = _pyproject()["project"]["scripts"]
    assert scripts.get("wyc") == "wyc.__main__:main"


def test_build_backend_is_setuptools_and_packages_wyc():
    data = _pyproject()
    assert "setuptools" in data["build-system"]["build-backend"]
    assert data["tool"]["setuptools"]["packages"] == ["wyc"]


def test_setup_py_ships_web_and_contracts_under_the_package():
    """The wheel must contain wyc/web/** (+ wyc/contracts/**) or an installed copy
    has no UI. setup.py's custom build_py copies them in; assert that logic is
    present (text-level — importing setup.py would execute setup())."""
    src = open(os.path.join(_ROOT, "setup.py"), encoding="utf-8").read()
    assert "build_py" in src, "no custom build_py to vendor the assets"
    assert "copytree" in src and "self.build_lib" in src, "build_py must copy into build_lib"
    assert '"web"' in src and '"contracts"' in src, "must ship web/ + contracts/"


def test_setup_py_compiles():
    py_compile.compile(os.path.join(_ROOT, "setup.py"), doraise=True)


def test_web_dir_has_packaged_then_repo_candidates():
    """_web_dir() must check the installed (wyc/web) layout before the repo-root
    sibling, so a pip-installed package finds its own bundled UI (M1)."""
    src = open(os.path.join(_ROOT, "wyc", "server.py"), encoding="utf-8").read()
    # the packaged candidate (os.path.join(pkg, "web")) precedes the repo-root one
    i_pkg = src.find('os.path.join(pkg, "web")')
    i_repo = src.find('os.path.dirname(pkg)')
    assert i_pkg != -1 and i_repo != -1 and i_pkg < i_repo, \
        "_web_dir must try the packaged web/ before the repo-root web/"
