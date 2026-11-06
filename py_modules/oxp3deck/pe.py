"""The file version of a Windows DLL (a game's libxess.dll), read from its VS_FIXEDFILEINFO.

Read as xess-xmx-linux's tools/proton-hook.py version() reads it, which decides what XESS=latest swaps: the
signature 0xFEEF04BD, then dwFileVersionMS and dwFileVersionLS. Unlike version(), which takes the first hit, this
prefers a hit whose dwStrucVersion is 0x00010000, so a stray copy of the four bytes earlier in the file is skipped.
Game DLLs reach 50 MB and more, so the file is read in 4 MB chunks, never loaded whole. It is not mapped: a page
that cannot be read (a worn microSD card, a card pulled out, a file that shrinks) would kill the whole root backend
with SIGBUS, where read() gives OSError.
"""
from __future__ import annotations

import os
import stat

SIGNATURE = b"\xbd\x04\xef\xfe"
STRUC_VERSION = 0x00010000
CHUNK = 4 << 20
MAX_HITS = 64      # a file full of the signature bytes is not worth scanning to the end


def _fields(buf, i: int) -> tuple[int, int, int] | None:
    if i + 16 > len(buf):
        return None
    sv, ms, ls = (int.from_bytes(buf[i + o:i + o + 4], "little") for o in (4, 8, 12))
    return sv, ms, ls


def _pick(hits: list[tuple[int, int, int]]) -> str | None:
    if not hits:
        return None
    good = [h for h in hits if h[0] == STRUC_VERSION]
    _sv, ms, ls = (good or hits)[0]
    return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"


def _scan_chunks(fd: int) -> list[tuple[int, int, int]]:
    hits = []
    tail = b""
    while len(hits) < MAX_HITS:
        chunk = os.read(fd, CHUNK)
        if not chunk:
            break
        buf = tail + chunk
        i = buf.find(SIGNATURE)
        last = -1
        while i >= 0:
            f = _fields(buf, i)
            if f is None:
                break        # the fields continue in the next chunk: keep this hit in the tail
            hits.append(f)
            if f[0] == STRUC_VERSION or len(hits) >= MAX_HITS:   # one chunk can hold a million copies
                return hits
            last = i
            i = buf.find(SIGNATURE, i + 1)
        keep_from = max(len(buf) - 15, last + 1, 0) if i < 0 else i
        tail = buf[keep_from:]
    return hits


def file_version(path: str) -> str | None:
    """'a.b.c.d', or None when the file is missing, not a regular file or has no version resource. Never raises."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except (OSError, ValueError):
        return None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size < 16:
            return None
        return _pick(_scan_chunks(fd))
    except (OSError, ValueError, OverflowError):
        return None
    finally:
        os.close(fd)


def version_tuple(v: str | None) -> tuple[int, ...] | None:
    """'2.0.1.41' -> (2, 0, 1, 41); None for anything else."""
    if not v:
        return None
    try:
        return tuple(int(p) for p in v.split("."))
    except ValueError:
        return None


# ---- imported DLL names (optiscaler.py: which graphics API an exe can use, which proxy name it loads) --------------

MAX_IMPORTS = 512
SEARCH_BYTES = 32 << 20


def _cstr(fd: int, off: int, n: int = 256) -> str | None:
    raw = os.pread(fd, n, off)
    end = raw.find(b"\0")
    if end <= 0:
        return None
    try:
        return raw[:end].decode("ascii")
    except UnicodeDecodeError:
        return None


def imports(path: str) -> list[str] | None:
    """The DLL names (lower case) in an exe's import and delay-import tables, in table order, or None when the file
    is not a readable PE image. Only the headers and the tables are read (pread), never the whole file. Never
    raises."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except (OSError, ValueError):
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        return _imports_fd(fd)
    except (OSError, ValueError, OverflowError, IndexError):
        return None
    finally:
        os.close(fd)


def _u(buf: bytes, off: int, n: int) -> int:
    if off + n > len(buf):
        raise ValueError("short header")
    return int.from_bytes(buf[off:off + n], "little")


def _imports_fd(fd: int) -> list[str] | None:
    dos = os.pread(fd, 64, 0)
    if len(dos) < 64 or dos[:2] != b"MZ":
        return None
    lfanew = _u(dos, 0x3C, 4)
    if lfanew <= 0 or lfanew > 1 << 20:
        return None
    hdr = os.pread(fd, 24 + 240 + 40 * 96, lfanew)
    if hdr[:4] != b"PE\0\0":
        return None
    nsec, opt_size = _u(hdr, 6, 2), _u(hdr, 20, 2)
    opt = 24
    magic = _u(hdr, opt, 2)
    if magic == 0x20B:
        dd, ndd_off = opt + 112, opt + 108
    elif magic == 0x10B:
        dd, ndd_off = opt + 96, opt + 92
    else:
        return None
    ndd = min(_u(hdr, ndd_off, 4), 16)
    sec = opt + opt_size
    if nsec > 96:
        return None
    sections = []
    for i in range(nsec):
        s = sec + 40 * i
        vsize, va, rsize, raw = _u(hdr, s + 8, 4), _u(hdr, s + 12, 4), _u(hdr, s + 16, 4), _u(hdr, s + 20, 4)
        sections.append((va, max(vsize, rsize), raw, rsize))

    def off_of(rva: int) -> int | None:
        for va, size, raw, rsize in sections:
            if va <= rva < va + size and rva - va < rsize:
                return raw + rva - va
        return None

    names: list[str] = []
    for index, step, name_at in ((1, 20, 12), (13, 32, 4)):        # imports; delay imports
        if index >= ndd:
            continue
        rva, size = _u(hdr, dd + 8 * index, 4), _u(hdr, dd + 8 * index + 4, 4)
        if not rva or not size:
            continue
        at = off_of(rva)
        if at is None:
            continue
        table = os.pread(fd, min(size, step * MAX_IMPORTS), at)
        for k in range(0, len(table) - step + 1, step):
            desc = table[k:k + step]
            if not any(desc):
                break
            n_off = off_of(_u(desc, name_at, 4))
            name = _cstr(fd, n_off) if n_off is not None else None
            if name and name.lower() not in names:
                names.append(name.lower())
    return names


def mentions(path: str, words: tuple[bytes, ...], limit: int = SEARCH_BYTES) -> set[bytes]:
    """Which of `words` (lower-case ASCII) occur in the first `limit` bytes of the file, without regard to case:
    the fallback for an exe that loads its graphics DLL by name at run time. Never raises."""
    found: set[bytes] = set()
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except (OSError, ValueError):
        return found
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return found
        keep = max(len(w) for w in words) - 1
        tail = b""
        done = 0
        while done < limit and len(found) < len(words):
            chunk = os.read(fd, min(CHUNK, limit - done))
            if not chunk:
                break
            done += len(chunk)
            buf = (tail + chunk).lower()
            found.update(w for w in words if w in buf)
            tail = buf[-keep:] if keep else b""
        return found
    except OSError:
        return found
    finally:
        os.close(fd)
