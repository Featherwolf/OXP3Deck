#!/usr/bin/env python3
"""Check that two OXP3Deck.zip files hold the same files with the same bytes (release.yml: the committed zip
against one rebuilt from the tagged sources).

    python3 tools/compare_zips.py release/OXP3Deck.zip "$RUNNER_TEMP/OXP3Deck.zip"

Entry times and compression are ignored; names, modes and contents must match. build_zip.py writes fixed times
anyway, and rollup builds the same dist/ from the same sources and lockfile (checked by building twice), so dist/
is compared too.

Runs on the developer's machine or in CI with the standard library only, not inside Decky.
"""

from __future__ import annotations

import sys
import zipfile


def entries(path: str) -> dict[str, tuple[int, bytes]]:
    with zipfile.ZipFile(path) as zf:
        return {i.filename: (i.external_attr >> 16, b"" if i.is_dir() else zf.read(i)) for i in zf.infolist()}


def duplicates(path: str) -> list[str]:
    """Names stored more than once (entries() keeps only the last copy; some extractors use another)."""
    with zipfile.ZipFile(path) as zf:
        names = [i.filename for i in zf.infolist()]
    return sorted({n for n in names if names.count(n) > 1})


def differences(a: str, b: str) -> list[str]:
    left, right = entries(a), entries(b)
    out = [f"{p}: {n} is in the zip more than once" for p in (a, b) for n in duplicates(p)]
    out += [f"only in {a}: {n}" for n in sorted(left.keys() - right.keys())]
    out += [f"only in {b}: {n}" for n in sorted(right.keys() - left.keys())]
    for name in sorted(left.keys() & right.keys()):
        (mode_a, data_a), (mode_b, data_b) = left[name], right[name]
        if mode_a != mode_b:
            out.append(f"{name}: mode {oct(mode_a)} != {oct(mode_b)}")
        if data_a != data_b:
            out.append(f"{name}: contents differ")
    return out


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 2:
        print("usage: compare_zips.py COMMITTED.zip REBUILT.zip", file=sys.stderr)
        return 2
    try:
        diff = differences(*args)
    except (OSError, zipfile.BadZipFile) as e:
        print(f"compare_zips: {e}", file=sys.stderr)
        return 1
    for line in diff:
        print(line)
    if diff:
        print(f"{args[0]} does not match a fresh build: run pnpm build && pnpm zip and commit it", file=sys.stderr)
        return 1
    print("the zips match")
    return 0


if __name__ == "__main__":
    sys.exit(main())
