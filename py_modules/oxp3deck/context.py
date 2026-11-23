"""Who the desktop user is, where the plugin keeps its files, and settings.json.

The backend runs as root (plugin.json flag "root"), so HOME is /root: everything about the user comes from
DECKY_USER_HOME. Decky chowns the settings, data and log folders to the user at every load, so files read from
them are untrusted input and files written there must not follow a link the user planted.
"""
from __future__ import annotations

import copy
import errno
import json
import logging
import os
import pwd
import re
import secrets
import stat
import threading
import time
from dataclasses import dataclass

from . import userexec

log = logging.getLogger("oxp3deck")


@dataclass
class Ctx:
    user: str
    uid: int
    gid: int
    home: str
    settings_dir: str
    runtime_dir: str
    log_dir: str
    plugin_dir: str
    root: str = "/"

    def sys_path(self, p: str) -> str:
        """An absolute system path (/proc, /sys, /run, /usr, /etc, /var) under `root`, which tests point at a
        temporary folder. Paths in the home, or already under root, are returned unchanged."""
        root = self.root.rstrip("/")
        if not root or not p.startswith("/"):
            return p
        home = self.home.rstrip("/")
        for keep in (home, root):
            if keep and (p == keep or p.startswith(keep + "/")):
                return p
        return root + "/" + p.lstrip("/")


def from_decky() -> Ctx:
    """The context from Decky's variables. Raises RuntimeError when no user owns DECKY_USER_HOME."""
    try:
        import decky  # injected by Decky Loader; tests install a stub
    except ImportError:
        decky = None

    def var(name: str) -> str:
        return str(getattr(decky, name, "") or os.environ.get(name, ""))

    given = var("DECKY_USER_HOME").rstrip("/")
    if not given:
        raise RuntimeError("context: DECKY_USER_HOME is not set")
    home = os.path.realpath(given)   # Bazzite: /home is a link to /var/home
    try:
        pw = pwd.getpwuid(os.stat(home).st_uid)
    except (OSError, KeyError) as e:
        raise RuntimeError(f"context: no user owns {given}: {e}") from e

    def in_home(p: str) -> str:
        # Same spelling as `home`, without resolving links below it (the user controls those).
        p = os.path.normpath(p) if p else p
        if p == given or p.startswith(given + "/"):
            return home + p[len(given):]
        return p

    return Ctx(user=pw.pw_name, uid=pw.pw_uid, gid=pw.pw_gid, home=home,
               settings_dir=in_home(var("DECKY_PLUGIN_SETTINGS_DIR")),
               runtime_dir=in_home(var("DECKY_PLUGIN_RUNTIME_DIR")),
               log_dir=in_home(var("DECKY_PLUGIN_LOG_DIR")),
               plugin_dir=in_home(var("DECKY_PLUGIN_DIR")))


def read_small(path: str, max_bytes: int = 1_000_000, dir_fd: int | None = None) -> bytes | None:
    """A regular file's content, or None when it is missing, too big, not a regular file or a symlink. Opened
    non-blocking so a FIFO planted in a user folder cannot hang the backend. dir_fd: `path` is relative to that
    folder descriptor."""
    try:
        return _read_regular(path, max_bytes, dir_fd)
    except OSError:
        return None


def _read_regular(path: str, max_bytes: int, dir_fd: int | None = None) -> bytes | None:
    """As read_small, but a failed open or read raises OSError (a missing file or a symlink too); None only for a
    file that is too big or not a regular file."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dir_fd)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > max_bytes:
            return None
        chunks = []
        size = 0
        while size <= max_bytes:
            chunk = os.read(fd, 65536)
            if not chunk:
                return b"".join(chunks)
            chunks.append(chunk)
            size += len(chunk)
        return None
    finally:
        os.close(fd)


def _open_folder(folder: str) -> int:
    """The folder for *at() calls. Its parents are walked with userexec.open_dir (no symlink the user could have
    planted in Decky's user-owned folders), and the folder itself must not be a link at all."""
    parent, base = os.path.split(folder.rstrip("/") or "/")
    if not base:
        return os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    pfd = userexec.open_dir(parent or "/")
    try:
        return os.open(base, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=pfd)
    finally:
        os.close(pfd)


def write_atomic(path: str, data: bytes, mode: int = 0o644) -> None:
    """Replace `path` with `data` through a new temporary file in the same folder, then os.replace. The folder is
    opened without following a link (_open_folder) and the temporary file is created exclusively; the rename
    replaces a link at `path` instead of writing through it. Raises OSError."""
    folder, name = os.path.split(os.path.abspath(path))
    dfd = _open_folder(folder)
    try:
        tmp = f".{name}.{secrets.token_hex(4)}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=dfd)
        try:
            with os.fdopen(fd, "wb") as f:
                os.fchmod(f.fileno(), mode)   # not reduced by the umask
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
        except BaseException:
            try:
                os.unlink(tmp, dir_fd=dfd)
            except OSError:
                pass
            raise
        _fsync_dir(dfd)
    finally:
        os.close(dfd)


def _fsync_dir(dfd: int) -> None:
    """The folder's entries to disk (the rename survives a power cut). A file system that cannot sync a folder is
    no error."""
    try:
        os.fsync(dfd)
    except OSError as e:
        if e.errno not in (errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP, errno.EBADF):
            raise


# ---- damaged and newer settings files (ROADMAP T1-5) ---------------------------------------------------------------

KEEP_COPIES = 3              # damaged (or set-aside) copies kept per file and kind
_now = time.time             # tests replace it


class Refused(OSError):
    """A save the file's guard refuses: damaged until the user taps Start fresh, or written by a newer OXP3 Deck.
    Its text is plain (it is shown as is)."""


_STAMP = re.compile(r"\d{8}-\d{6}")


def _copy_prefix(name: str, tag: str) -> str:
    return f"{name}.{tag}-"


def _copy_names(dfd: int, name: str, tag: str) -> list[str]:
    """Oldest first: by the time in the name, then by the -2, -3 ... added within one second."""
    pre = _copy_prefix(name, tag)
    n = len(pre) + 15                                    # YYYYmmdd-HHMMSS
    return sorted((x for x in os.listdir(dfd) if x.startswith(pre) and not x.endswith(".tmp")),
                  key=lambda x: (x[:n], len(x), x))


def copies(path: str, tag: str = "corrupt") -> list[str]:
    """The names of `path`'s set-aside copies (<name>.<tag>-<time>), oldest first; [] when the folder cannot be
    read."""
    folder, name = os.path.split(os.path.abspath(path))
    try:
        dfd = _open_folder(folder)
    except OSError:
        return []
    try:
        return _copy_names(dfd, name, tag)
    except OSError:
        return []
    finally:
        os.close(dfd)


def quarantine(path: str, tag: str = "corrupt") -> str | None:
    """Rename `path` to <name>.<tag>-<YYYYmmdd-HHMMSS> in its folder (the link itself when it is one), keeping the
    newest KEEP_COPIES such copies. The new name, or None when nothing could be moved (logged)."""
    folder, name = os.path.split(os.path.abspath(path))
    try:
        dfd = _open_folder(folder)
    except OSError as e:
        log.warning("settings: cannot open the folder of %s to set it aside: %s", path, e)
        return None
    try:
        pre = _copy_prefix(name, tag)
        base = pre + time.strftime("%Y%m%d-%H%M%S", time.localtime(_now()))
        # never before the newest copy there (the clock went back: DST, NTP, another timezone): the copies are
        # ordered by the time in their names, so an earlier one would be the oldest and pruned at once
        newest = _copy_names(dfd, name, tag)
        last = newest[-1][len(pre):len(base)] if newest else ""
        if _STAMP.fullmatch(last) and pre + last > base:
            base = pre + last
        # within one second: base-2, base-3 ... after the highest one there (an older one may have been removed)
        nums = [1 if x == base else int(x[len(base) + 1:]) for x in os.listdir(dfd)
                if x == base or (x.startswith(base + "-") and x[len(base) + 1:].isdigit())]
        new = f"{base}-{max(nums) + 1}" if nums else base
        os.rename(name, new, src_dir_fd=dfd, dst_dir_fd=dfd)
        _fsync_dir(dfd)
        for x in _copy_names(dfd, name, tag)[:-KEEP_COPIES]:
            try:
                os.unlink(x, dir_fd=dfd)
            except OSError as e:
                log.warning("settings: cannot remove the old copy %s: %s", x, e)
        log.warning("settings: %s set aside as %s", path, new)
        return new
    except OSError as e:
        log.warning("settings: cannot set %s aside: %s", path, e)
        return None
    finally:
        os.close(dfd)


def read_json(path: str, max_bytes: int = 1_000_000) -> tuple[dict | None, bool]:
    """(the file's JSON object, False), (None, False) when there is no file, or (None, True) when it is damaged: not
    JSON, not an object, too big, or not a regular file (a symlink too). A damaged file is NOT moved here
    (quarantine). Raises OSError when the file is there but could not be opened or read (EIO, EMFILE ...): that is
    no damage, and the file must stay where it is."""
    try:
        raw = _read_regular(path, max_bytes)
    except (FileNotFoundError, NotADirectoryError):
        return None, False
    except OSError as e:
        if e.errno != errno.ELOOP:      # O_NOFOLLOW on a symlink
            raise
        raw = None
    if raw is None:
        return None, True
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError as e:              # UnicodeDecodeError too
        log.warning("settings: %s is not valid JSON: %s", path, e)
        return None, True
    if not isinstance(data, dict):
        log.warning("settings: %s does not hold a JSON object", path)
        return None, True
    return data, False


def _version(data: dict) -> int | None:
    v = data.get("version")
    return v if isinstance(v, int) and not isinstance(v, bool) else None


def load_guarded(path: str, version: int, max_bytes: int) -> tuple[dict | None, dict | None]:
    """A state file the user must not lose (auto.json, optiscaler.json): (data, problem). A damaged file is set aside
    (quarantine) and stays a problem until Start fresh writes a new one: also while no file is there and a damaged
    copy is (problem {kind "damaged", copy}). A file whose "version" is above `version` loads (data) but is
    read-only (problem {kind "newer", version}). Saves are refused while there is a problem (guard_save). Raises
    OSError when the file could not be read (read_json): it is not set aside."""
    data, bad = read_json(path, max_bytes)
    if bad:
        moved = quarantine(path)
        return None, {"kind": "damaged", "copy": moved, "moved": moved is not None}
    if data is None:
        old = copies(path)
        return None, ({"kind": "damaged", "copy": old[-1], "moved": True} if old else None)
    v = _version(data)
    if v is not None and v > version:
        return data, {"kind": "newer", "version": v}
    return data, None


def refused_text(name: str, problem: dict) -> str:
    """The error of a save the problem refuses."""
    if problem.get("kind") == "newer":
        return (f"{name} is from a newer OXP3 Deck, so it is read-only here. Update OXP3 Deck, or tap Start fresh "
                "in the Status section.")
    return f"{name} was damaged, so saving is paused. Tap Start fresh in the Status section."


def guard_save(path: str, problem: dict | None) -> None:
    """Raises Refused while the file has a problem (load_guarded)."""
    if problem:
        raise Refused(refused_text(os.path.basename(path), problem))


def start_fresh(path: str, blob: bytes, mode: int = 0o644) -> None:
    """Start fresh: a file still at `path` is set aside first (a newer one as <name>.newer-<time>, a damaged one as
    .corrupt-), then `blob` is written. Raises OSError (Refused when the old file could not be set aside: it is
    never overwritten)."""
    data, bad = read_json(path, 64 << 20)
    if bad or data is not None:
        tag = "corrupt" if bad else "newer"
        if quarantine(path, tag) is None:
            raise Refused(f"{os.path.basename(path)} could not be set aside, so nothing was changed.")
    write_atomic(path, blob, mode)


_PROBLEMS: dict[str, dict] = {}      # path: FileProblem of a Settings file found damaged in this process
_PLOCK = threading.Lock()


def note_reset(path: str, moved: str | None) -> None:
    with _PLOCK:
        _PROBLEMS[os.path.abspath(path)] = {"file": os.path.basename(path), "kind": "reset", "copy": moved}


def reset_problems(folder: str | None = None) -> list[dict]:
    """The Settings files found damaged and started afresh in this process (in `folder` when given), until
    dismissed: FileProblem {file, kind "reset", copy}."""
    with _PLOCK:
        return [dict(p) for k, p in sorted(_PROBLEMS.items())
                if folder is None or os.path.dirname(k) == os.path.abspath(folder)]


def dismiss_reset(path: str) -> bool:
    with _PLOCK:
        return _PROBLEMS.pop(os.path.abspath(path), None) is not None


class Settings:
    """settings.json: a flat JSON object, kept in memory and written whole on every change. Never raises: set()
    and update() return None, or an error text when the value is not JSON or the file could not be written (the
    value is then kept in memory only; so too while the file is there but cannot be read, which is retried and never
    taken for damage). A damaged file is set aside (<name>.corrupt-<time>, quarantine) and noted
    for the Status section (reset_problems); it starts empty."""

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._data: dict = {}
        self._unread: OSError | None = None     # the file is there but could not be read: never written over
        self._whole = False                     # replace() ran while unread: the file's values are dropped
        self._read()

    def _read(self) -> None:
        """Load the file (under the lock, or from __init__). A read error (EIO, EMFILE ...) is no damage: the file
        stays, nothing is written over it, and the next get/all/update tries again; values set meanwhile are kept
        in memory and go over the file's once it reads."""
        try:
            data, bad = read_json(self.path)
        except OSError as e:
            if self._unread is None:
                log.warning("settings: cannot read %s: %s", self.path, e)
            self._unread = e
            return
        self._unread = None
        if self._whole:
            data, self._whole = None, False
        if bad:
            log.warning("settings: %s is damaged; it starts empty", self.path)
            note_reset(self.path, quarantine(self.path))
        self._data = dict(data or {}, **self._data)

    def get(self, key: str, default=None):
        with self._lock:
            if self._unread is not None:
                self._read()
            return copy.deepcopy(self._data.get(key, default))

    def all(self) -> dict:
        with self._lock:
            if self._unread is not None:
                self._read()
            return copy.deepcopy(self._data)

    def set(self, key: str, value) -> str | None:
        return self.update({key: value})

    def replace(self, values: dict) -> str | None:
        """The whole file becomes `values` (keys not in it are dropped); otherwise as update()."""
        return self.update(values, keep=False)

    def update(self, values: dict, keep: bool = True) -> str | None:
        with self._lock:
            if self._unread is not None:
                self._read()
            new = dict(self._data) if keep else {}
            new.update(values)
            try:
                blob = (json.dumps(new, indent=2, sort_keys=True) + "\n").encode("utf-8")
            except (TypeError, ValueError) as e:
                return f"settings: not JSON: {e}"
            self._data = json.loads(blob)   # a private copy, so callers' objects can change freely
            if self._unread is not None:
                self._whole = self._whole or not keep
                e = self._unread
                return f"settings: cannot read {self.path}, so it is not saved: {e.strerror or e}"
            try:
                write_atomic(self.path, blob)
            except OSError as e:
                log.warning("settings: cannot write %s: %s", self.path, e)
                return f"settings: cannot write {self.path}: {e.strerror or e}"
        return None
