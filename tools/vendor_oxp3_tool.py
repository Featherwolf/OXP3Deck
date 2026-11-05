#!/usr/bin/env python3
"""Refresh vendor/oxp3-tool, the copy of oxp3-tool that the zip carries as bin/oxp3-tool.

    python3 tools/vendor_oxp3_tool.py                         # the newest dist/oxp3-tool on GitHub
    python3 tools/vendor_oxp3_tool.py --ref v0.4.1            # a tag, branch or commit there
    python3 tools/vendor_oxp3_tool.py --from ../OXP3-Tool-for-Bazzite   # a local checkout's dist/

oxp3-tool lives in https://github.com/Featherwolf/OXP3-Tool-for-Bazzite. vendor/ is only replaced when the file
matches its .sha256 and `python3 -I FILE --version` names an oxp3-tool at least as new as the plugin's
MIN_VERSION. Then run `pnpm zip` to put it into release/OXP3Deck.zip.

Runs on the developer's machine with the standard library only, not inside Decky.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
VENDOR = PLUGIN / "vendor"
REPO = "Featherwolf/OXP3-Tool-for-Bazzite"
TOOL = "oxp3-tool"
USER_AGENT = "OXP3Deck-vendor-script"
MAX_BYTES = 16 * 1024 * 1024
VERSION_RE = re.compile(r"^oxp3-tool (\d+(?:\.\d+)*)\s*$")


class VendorError(Exception):
    pass


def _get(url: str, accept: str | None = None) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, **({"Accept": accept} if accept else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read(MAX_BYTES + 1)
    except (urllib.error.URLError, OSError) as e:
        raise VendorError(f"{url}: {e}") from e
    if len(data) > MAX_BYTES:
        raise VendorError(f"{url}: larger than {MAX_BYTES} bytes")
    return data


def _commit(ref: str) -> str:
    """The commit `ref` names, so the file and its .sha256 come from the same one (HEAD can move in between)."""
    try:
        sha = _get(f"https://api.github.com/repos/{REPO}/commits/{ref}", "application/vnd.github.sha").decode().strip()
    except VendorError as e:
        print(f"warning: {e}; using {ref} as it is", file=sys.stderr)
        return ref
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise VendorError(f"GitHub answered {sha[:80]!r} for {ref}")
    return sha


def fetch(ref: str) -> tuple[bytes, str, str]:
    commit = _commit(ref)
    base = f"https://raw.githubusercontent.com/{REPO}/{commit}/dist/{TOOL}"
    return _get(base), _get(base + ".sha256").decode("utf-8", "replace"), f"{REPO}@{commit}"


def read_local(checkout: Path) -> tuple[bytes, str, str]:
    dist = checkout / "dist"
    for p in (dist / TOOL, dist / f"{TOOL}.sha256"):
        if p.is_symlink() or not p.is_file():
            raise VendorError(f"{p} is missing (run python3 tools/build_zipapp.py in {checkout})")
    return (dist / TOOL).read_bytes(), (dist / f"{TOOL}.sha256").read_text(encoding="utf-8", errors="replace"), \
        str(checkout)


def min_version() -> tuple[int, ...]:
    sys.path.insert(0, str(PLUGIN / "py_modules"))
    try:
        from oxp3deck import oxp3tool
    finally:
        sys.path.pop(0)
    return tuple(oxp3tool.MIN_VERSION)


def check(tool: bytes, sums: str, minimum: tuple[int, ...]) -> str:
    """The version of a tool that may be vendored, or VendorError."""
    words = sums.split()
    if len(words) != 2 or words[1] != TOOL or not re.fullmatch(r"[0-9a-f]{64}", words[0]):
        raise VendorError(f"{TOOL}.sha256 is not '<sha256>  {TOOL}'")
    if hashlib.sha256(tool).hexdigest() != words[0]:
        raise VendorError(f"{TOOL} does not match {TOOL}.sha256")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp, TOOL)
        path.write_bytes(tool)
        try:
            res = subprocess.run([sys.executable, "-I", str(path), "--version"], capture_output=True, text=True,
                                 timeout=60, stdin=subprocess.DEVNULL, cwd=tmp)
        except (OSError, subprocess.TimeoutExpired) as e:
            raise VendorError(f"{TOOL} --version: {e}") from e
    m = VERSION_RE.match(res.stdout.strip()) if res.returncode == 0 else None
    if not m:
        raise VendorError(f"{TOOL} --version said {(res.stdout or res.stderr).strip()[:200]!r}")
    version = m.group(1)
    if tuple(int(x) for x in version.split(".")) < minimum:
        need = ".".join(map(str, minimum))
        raise VendorError(f"it is oxp3-tool {version}; the plugin needs {need} or newer (MIN_VERSION in oxp3tool.py)")
    return version


def install(tool: bytes, sums: str, vendor: Path) -> None:
    vendor.mkdir(parents=True, exist_ok=True)
    for name, data, mode in ((TOOL, tool, 0o755), (f"{TOOL}.sha256", sums.encode(), 0o644)):
        fd, tmp = tempfile.mkstemp(dir=vendor, prefix=f".{name}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(data)
            os.chmod(tmp, mode)
            os.replace(tmp, vendor / name)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    src = p.add_mutually_exclusive_group()
    src.add_argument("--ref", default="HEAD", help="tag, branch or commit on GitHub (default: HEAD)")
    src.add_argument("--from", dest="checkout", type=Path, help="a local checkout of OXP3-Tool-for-Bazzite")
    args = p.parse_args(argv)
    try:
        tool, sums, where = read_local(args.checkout.resolve()) if args.checkout else fetch(args.ref)
        version = check(tool, sums, min_version())
        install(tool, sums, VENDOR)
    except (VendorError, OSError) as e:
        print(f"vendor_oxp3_tool: {e}", file=sys.stderr)
        return 1
    print(json.dumps({"version": version, "from": where, "sha256": sums.split()[0]}))
    print("vendor/oxp3-tool updated; run pnpm zip to put it into release/OXP3Deck.zip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
