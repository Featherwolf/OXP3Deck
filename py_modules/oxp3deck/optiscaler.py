"""OptiScaler per game (DESIGN.md "OptiScaler (0.5)" and "OptiScaler for any game"): a pinned OptiScaler build is
downloaded once, unpacked as the desktop user into ~/.local/share/oxp3deck/optiscaler/<build>/, and put into a game's
exe folder with backups of anything in the way; Remove takes it out again from root's record and puts the backups
back. The Witcher 3 has a tested setup (GAMES); a game OptiScaler's wiki documents gets its install-level facts from
optigames.KNOWN; any other game gets the generic, experimental setup (its exe, API and a free proxy name found from
its files, optigames.py).

Written for OXP3 Deck. It follows ClawDeck's approach (download once, put into a game with a manifest and backups,
take out again) as of ClawDeck commit 07918cc (2026-11-05, MIT); no code from later ClawDeck commits (AGPLv3) and
nothing from ClawDeck's assets/games.json (GPL-3.0). OptiScaler itself (GPL-3.0) is never shipped with the plugin
and never run by it: only the host's 7z or bsdtar runs, as the user, to unpack it.

Root writes nothing in the user's folders: files are created by userexec.copy_new / write_new (owned by the user),
folders by userexec.user_mkdirs (as the user), and root only unlinks or renames files the user owns, in folders the
user owns, inside a Steam library's steamapps/common. The record in the settings folder decides what Remove deletes;
the game folder's .oxp3deck-optiscaler/state.json only marks the install as ours.
"""
from __future__ import annotations

import copy
import errno
import fnmatch
import hashlib
import json
import logging
import os
import re
import shutil
import stat
import tempfile
import threading
import time

from . import context, downloads, optigames, pe, steamlib, userexec

log = logging.getLogger("oxp3deck")

# ---- pins and the games table --------------------------------------------------------------------------------------

# One entry per pinned build. A new pin is a plugin update; a game whose record names another build shows an update.
BUILDS = {
    "v10-20261105": {
        "version": "OptiScaler v10.0.0-pre1 (nightly 2026-11-05)",
        "repo": "optiscaler/OptiScaler-nightly",
        "tag": "nightly-20261105",
        "asset": "OptiScaler_v10.0.0-pre1_20261105.7z",
        "url": "https://github.com/optiscaler/OptiScaler-nightly/releases/download/nightly-20261105/"
               "OptiScaler_v10.0.0-pre1_20261105.7z",
        "sha256": "e26810c76451666da0bcc40be62722e7b4a5d36c550036830b98f5eb69e0648c",
        "size_mb": 69,
        "size_max": 96 << 20,
        "layout": "subfolder",
    },
}

DEFAULT_BUILD = "v10-20261105"

# Hand-written, one entry per game tested on the device, each with its sources; a game is added only with a source.
# Games OptiScaler's wiki documents are optigames.KNOWN; every other game gets the generic setup (resolve()).
GAMES = {
    "292030": {                                   # The Witcher 3: Wild Hunt
        "kind": "tested",
        "name": "The Witcher 3",
        "exe": "witcher3.exe",
        "proxies": ("dxgi",),                     # the tested name only: a dxgi.dll that is not ours is a refusal
        "folder": "bin/x64_dx12",                 # wiki: install in "The Witcher 3\bin\x64_dx12"; bin/x64 is DX11
        "proxy": "dxgi",                          # wiki Filename: dxgi.dll
        "api": "dx12",
        "build": "v10-20261105",
        "ini": {"Spoofing_Dxgi": "false"},        # OptiScaler GameConfigs.cpp (master) and 0.9.4 Quirks.h;
                                                  # xess-xmx-linux games.md: NVIDIA spoof -> libxess on DP4a
        # The game's own XeFG first (FGInput=xefg: OptiScaler takes over its XeSS frame generation, with the
        # witcher3.exe XeFGCameraMotionFill quirk made for exactly this input), then OptiFG. Not dlssg: the game
        # uses Streamline 1, and "DLSSG via SL FG inputs are not supported" (wiki Notes); its DLSS-FG stays greyed.
        "fg_inputs": ("xefg", "upscaler"),
        "fg_input": "xefg",
        "args": ("-dx12",),                       # wiki: run in DirectX 12 (and launchopts.DX12_ARGS)
        "notes": ("In the game pick XeSS upscaling and XeSS frame generation (DLSS frame generation stays greyed: the game uses Streamline 1).",
                  "If XeSS frame generation still adds no fps, set the input to OptiFG (frame generation from the upscaler) and keep the game's gamma and brightness at their defaults (wiki).",
                  "DLSS upscaling can flicker: pick XeSS in the game if it does (wiki, Known Issues).",
                  "XeFG needs a borderless window, not exclusive fullscreen (OptiScaler 0.9.0 notes)."),
        "sources": ("github.com/optiscaler/OptiScaler/wiki/The-Witcher-3-Wild-Hunt",
                    "OptiScaler master OptiScaler/GameConfigs.cpp (witcher3.exe)",
                    "ClawDeck assets/games.json witcher3.exe entry, read only as a pointer"),
        # Automatic setup (DESIGN.md "Automatic setup"): games.KNOWN_ISSUES 292030 fg_no_gain (XeSS frame generation
        # adds no fps through the launch options); OptiScaler takes the game's XeFG over (input xefg, output XeFG)
        "auto": {"choices": {"upscaler": "xess", "fg": 2, "fg_input": "xefg"},
                 "why": "XeSS frame generation adds no fps here; OptiScaler's XeFG is the known way.",
                 "short": "for frame generation"},
    },
}

UPSCALERS = ("xess", "fsr31")
FG_MULTIPLIERS = (0, 2, 3, 4)
# What the "fsr31" choice is called in OptiScaler.ini: for DirectX 12 the FidelityFX upscalers are "ffx" since v10
# (OptiTypes.cpp CodeToUpscalerFfx reads an old "fsr31" as ffx); for DirectX 11 "fsr31" is still its own upscaler.
# Vulkan: "ffx" is native FidelityFX 2.3 / 3.1 (OptiScaler.ini [Upscalers] VulkanUpscaler).
UPSCALER_INI = {"dx12": {"xess": "xess", "fsr31": "ffx"}, "dx11": {"xess": "xess", "fsr31": "fsr31"},
                "vulkan": {"xess": "xess", "fsr31": "ffx"}}
UPSCALER_KEY = {"dx12": "Upscalers_Dx12Upscaler", "dx11": "Upscalers_Dx11Upscaler",
                "vulkan": "Upscalers_VulkanUpscaler"}

CACHE_REL = ".local/share/oxp3deck/optiscaler"
PACKAGE_LIST = ".oxp3deck-package.json"
RECORD_NAME = "optiscaler.json"
MARK_DIR = ".oxp3deck-optiscaler"
STATE_NAME = "state.json"
BACKUP_DIR = MARK_DIR + "/backup"
TMP_PARENT: str | None = None    # where the root-only download folder is made (tests)
UNPACKERS = (("7z", "7z"), ("7za", "7z"), ("7zz", "7z"), ("bsdtar", "bsdtar"))
MAX_ENTRIES = 2000
MAX_UNPACKED = 400 << 20
MAX_NAME = 240
SCAN_DEPTH = 3
SCAN_MAX = 20000
LIST_TIMEOUT = 120
UNPACK_TIMEOUT = 600
LAUNCH_REMOVE = ("XESS", "FSR", "FSR_FG", "force_vk_vendor")
DXVK_VENDOR = "dxgi.customVendorId = 8086"

INI_KEY = re.compile(r"^[A-Za-z0-9]{1,32}_[A-Za-z0-9]{1,48}$")
INI_VAL = re.compile(r"^(true|false|auto|-?[0-9]+(\.[0-9]+)?|[a-z0-9_]{1,16}|\.\\OptiScaler)$")
_APPID = re.compile(r"^[0-9]+$")
_BUILD = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_HEX = re.compile(r"^[0-9a-f]{64}$")

# Another tool's OptiScaler in the exe folder (lower-case names): OptiScaler's own files, Decky Framegen's markers,
# ClawDeck's manifest folder. `<proxy>.dll.b` (Decky Framegen's backup) is checked for every proxy name.
FOREIGN_NAMES = ("optiscaler.ini", "optiscaler.log", "optiscaler.dll", "optiscaler", "nvngx.ini", "fgmod",
                 "framegen_patch", ".clawdeck-optiscaler")
PROXIES = optigames.ALL_PROXIES
# Anti-cheat: folders and file patterns (lower case) searched SCAN_DEPTH levels under the install folder.
ANTICHEAT_DIRS = optigames.ANTICHEAT_DIRS
ANTICHEAT_FILES = optigames.ANTICHEAT_FILES
# The install folder is listed this deep, at most this many entries, for the exe and API of a game without a tested
# setup; the listing is kept for LIST_TTL seconds (info() runs for every game page).
LIST_MAX = 40000
LIST_TTL = 30.0
# Package files that stay in the cache (Windows set-up helpers, licences, the "extract all files" note).
SKIP_NAMES = ("setup_linux.sh", "setup_windows.bat")
# Files OptiScaler writes next to the exe at run time (not in the record), removed by fixed names only.
RUNTIME_LOGS = ("optiscaler*.log",)
RUNTIME_DIRS = ("D3D12_Optiscaler",)

NO_SETUP = "OptiScaler: not a Steam game."
FLATPAK = "Not supported with Flatpak Steam."
ANTICHEAT = "This game has anti-cheat; OptiScaler could get the account banned."      # (fallback wording)
GUIDE = "OptiScaler's guide says not to use it with online games"
FOREIGN = "Another OptiScaler install is in this game. Remove it with the tool that added it."
GONE = "This OptiScaler build is no longer published: update OXP3 Deck."

_LOCK = threading.RLock()     # the record: read, changed and written by one thread at a time


class OptiError(Exception):
    """A step that cannot go on: its text is the answer's error."""


# ---- small helpers -------------------------------------------------------------------------------------------------

def _say(job, line: str) -> None:
    if job is not None:
        job.say(line)
    else:
        log.info("optiscaler: %s", line)


def _tail(r, n: int = 3) -> str:
    lines = [s for s in (r.out + "\n" + r.err).splitlines() if s.strip()]
    return " / ".join(lines[-n:]) or f"exit {r.rc}"


def _under(path: str, folder: str) -> bool:
    folder = folder.rstrip("/")
    return path == folder or path.startswith(folder + "/")


def _root() -> bool:
    return os.geteuid() == 0


def _users(ctx, st) -> bool:
    """Whether root may unlink or rename this: the user owns it (as the backend is not root, anything goes)."""
    return not _root() or st.st_uid == ctx.uid


def _sha256_fd(fd: int) -> tuple[int, str]:
    h = hashlib.sha256()
    n = 0
    while True:
        chunk = os.read(fd, 1 << 20)
        if not chunk:
            return n, h.hexdigest()
        n += len(chunk)
        h.update(chunk)


def _file_sum(dfd: int, name: str) -> tuple[int, str] | None:
    """(size, sha256) of a regular file in folder dfd (no link followed, no FIFO opened), else None."""
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=dfd)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        return _sha256_fd(fd)
    except OSError:
        return None
    finally:
        os.close(fd)


def _ci_name(dfd: int, want: str) -> str | None:
    """The entry of folder dfd named `want` without regard to case (Wine's view), the exact spelling first."""
    try:
        names = os.listdir(dfd)
    except OSError:
        return None
    if want in names:
        return want
    low = want.lower()
    return next((n for n in sorted(names) if n.lower() == low), None)


def _lstat(dfd: int, name: str):
    try:
        return os.stat(name, dir_fd=dfd, follow_symlinks=False)
    except OSError:
        return None


def _safe_rel(rel) -> bool:
    if not isinstance(rel, str) or not rel or len(rel) > 1024 or "\\" in rel or rel.startswith("/"):
        return False
    parts = rel.split("/")
    return all(p not in ("", ".", "..") and len(p) <= MAX_NAME and not any(ord(c) < 32 for c in p) for p in parts)


def _open_in(folder: str, rel_dir: str = "") -> int:
    """folder/rel_dir for *at() calls, no link the user could have planted followed. Raises OSError."""
    return userexec.open_dir(os.path.join(folder, rel_dir) if rel_dir else folder)


def entry(appid) -> dict | None:
    """The table entry of a game: the tested setup (GAMES) or the wiki's facts (optigames.KNOWN), else None (the
    generic setup). Cheap: no folder is read."""
    appid = str(appid)
    if appid in GAMES:
        return GAMES[appid]
    k = optigames.KNOWN.get(appid)
    return dict(k, kind="known") if k else None


def offered(appid) -> bool:
    """Whether the game's row shows OptiScaler at all: every Steam game (a refusal is shown in the row)."""
    return bool(_APPID.match(str(appid or "")))


def defaults(e: dict) -> dict:
    """The tested game starts with frame generation 2x; every other game with upscaling only."""
    if e.get("kind") == "tested":
        return {"upscaler": "xess", "fg": 2, "fg_input": e["fg_input"]}
    return {"upscaler": "xess", "fg": 0, "fg_input": e.get("fg_input") or "upscaler"}


def check_choices(e: dict | None, choices) -> tuple[dict | None, str | None]:
    """The choices as stored ({upscaler, fg, fg_input}), or (None, why). Frame generation only for a DirectX 12
    game, with one of its inputs; with it off any input is kept (it is used when frame generation is turned on)."""
    if e is None:
        return None, NO_SETUP
    if not isinstance(choices, dict):
        return None, "OptiScaler: the choices must be an object"
    up, fg, inp = choices.get("upscaler"), choices.get("fg"), choices.get("fg_input", e["fg_input"])
    if up not in UPSCALERS:
        return None, f"OptiScaler: unknown upscaler {str(up)[:20]!r}"
    if isinstance(fg, bool) or not isinstance(fg, int) or fg not in FG_MULTIPLIERS:
        return None, f"OptiScaler: frame generation must be 0, 2, 3 or 4, not {str(fg)[:10]!r}"
    if fg and e.get("api", "dx12") != "dx12":
        return None, f"OptiScaler: frame generation needs DirectX 12; {e['name']} runs in " \
                     f"{optigames.API_NAMES.get(e.get('api'), e.get('api'))}"
    if inp not in (e["fg_inputs"] if fg else optigames.FG_INPUTS):
        return None, f"OptiScaler: unknown frame generation input {str(inp)[:20]!r}"
    return {"upscaler": up, "fg": fg, "fg_input": inp}, None


def choices_why(ctx, appid, choices) -> str | None:
    """main.py's check before a job starts: the choices against the game's setup (the table's, the record's or
    the generic one), None when they are fine or the game is refused anyway (check() then says why)."""
    try:
        e, _why = resolve(ctx, appid)
    except Exception:
        log.exception("optiscaler: resolving %s", appid)
        e = None
    e = e or entry(appid) or _generic_base(str(appid), "This game")
    return check_choices(e, choices)[1]


# ---- the record (root's, in the settings folder) -------------------------------------------------------------------

def _record_path(ctx) -> str:
    return os.path.join(ctx.settings_dir, RECORD_NAME)


def _empty() -> dict:
    return {"version": 1, "global": {"overlay": False}, "games": {}, "packages": {}}


def _load(ctx) -> dict:
    raw = context.read_small(_record_path(ctx), 4 << 20)
    rec = _empty()
    if raw is None:
        return rec
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:
        log.warning("optiscaler: %s is not valid JSON; starting empty", _record_path(ctx))
        return rec
    if not isinstance(data, dict):
        return rec
    g = data.get("global")
    if isinstance(g, dict):
        rec["global"]["overlay"] = g.get("overlay") is True
    games = data.get("games")
    if isinstance(games, dict):
        rec["games"] = {k: v for k, v in games.items() if _APPID.match(str(k)) and isinstance(v, dict)}
    pk = data.get("packages")
    if isinstance(pk, dict):
        rec["packages"] = {k: v for k, v in pk.items() if isinstance(k, str) and isinstance(v, str) and _HEX.match(v)}
    return rec


def _save(ctx, rec: dict) -> None:
    blob = (json.dumps(rec, indent=1, sort_keys=True) + "\n").encode("utf-8")
    context.write_atomic(_record_path(ctx), blob, 0o644)


def _game_rec(ctx, appid: str) -> dict | None:
    with _LOCK:
        g = _load(ctx)["games"].get(appid)
    return copy.deepcopy(g) if g is not None else None


def _put_game(ctx, appid: str, g: dict | None) -> None:
    with _LOCK:
        rec = _load(ctx)
        if g is None:
            rec["games"].pop(appid, None)
        else:
            rec["games"][appid] = g
        _save(ctx, rec)


def game_record(ctx, appid) -> dict | None:
    """A copy of the record's entry for the game ({build, choices, origin, ...}), or None: the automatic setup reads
    origin ("user" | "auto"; records from 0.5 have none: "user") and choices."""
    appid = str(appid or "")
    if not _APPID.match(appid):
        return None
    return _game_rec(ctx, appid)


def installed_for(ctx, appid) -> bool:
    """The record has OptiScaler (installed, or partly removed) in this game: games.py asks, no folder scan."""
    try:
        return _game_rec(ctx, str(appid)) is not None
    except Exception:
        log.exception("optiscaler: reading the record")
        return False


# ---- folders -------------------------------------------------------------------------------------------------------

def _in_library(ctx, folder: str | None) -> bool:
    """folder is resolved and sits under a Steam library's steamapps/common/<game>/: the only place root touches."""
    if not folder or not folder.startswith("/") or os.path.realpath(folder) != folder.rstrip("/"):
        return False
    for lib in steamlib.libraries(ctx):
        common = os.path.join(os.path.realpath(lib), "steamapps", "common")
        if folder.startswith(common.rstrip("/") + "/"):
            return True
    return False


def _install_root(ctx, folder: str) -> str | None:
    """LIB/steamapps/common/<game> above `folder`."""
    for lib in steamlib.libraries(ctx):
        common = os.path.join(os.path.realpath(lib), "steamapps", "common").rstrip("/") + "/"
        if folder.startswith(common):
            return common + folder[len(common):].split("/", 1)[0]
    return None


def game_name(ctx, appid) -> str | None:
    """The game's name: its appmanifest's, else the table's, else None."""
    appid = str(appid or "")
    if not _APPID.match(appid):
        return None
    try:
        for lib in steamlib.libraries(ctx):
            acf = steamlib.read_vdf(os.path.join(lib, "steamapps", f"appmanifest_{appid}.acf"))
            name = steamlib.vdf_get(acf, "AppState", "name") if acf else None
            if isinstance(name, str) and name.strip():
                return name.strip()[:120]
    except Exception:
        log.exception("optiscaler: the name of %s", appid)
    e = entry(appid)
    if e:
        return e["name"]
    if appid in optigames.ONLINE:
        return optigames.ONLINE[appid]
    if appid in optigames.NOT_OFFERED:
        return optigames.NOT_OFFERED[appid][0]
    return None


def _name(ctx, appid: str) -> str:
    e = GAMES.get(appid)
    return e["name"] if e else game_name(ctx, appid) or "This game"


def _real_dir(install: str, rel: str) -> str | None:
    """install/rel resolved, each part a real folder (no link), matched without regard to case; else None."""
    cur = os.path.realpath(install)
    for part in _parts(rel):
        try:
            dfd = userexec.open_dir(cur)
        except OSError:
            return None
        try:
            name = _ci_name(dfd, part)
            st = _lstat(dfd, name) if name else None
        finally:
            os.close(dfd)
        if st is None or not stat.S_ISDIR(st.st_mode):
            return None
        cur = os.path.join(cur, name)
    return cur


def _parts(rel: str) -> list[str]:
    return [p for p in rel.split("/") if p and p != "."] if rel else []


def _has_exe(folder: str, exe: str) -> str | None:
    """The exe's spelling in folder when it is a regular file there (any case), else None."""
    try:
        dfd = userexec.open_dir(folder)
    except OSError:
        return None
    try:
        name = _ci_name(dfd, exe)
        st = _lstat(dfd, name) if name else None
    finally:
        os.close(dfd)
    return name if st is not None and stat.S_ISREG(st.st_mode) else None


def _tested_dir(ctx, appid: str, e: dict) -> tuple[str | None, str | None]:
    """The tested setup's folder exactly: the install folder + the entry's folder, holding its exe."""
    install = steamlib.app_install_dir(ctx, appid)
    if not install:
        return None, f"{e['name']} is not installed."
    missing = f"Can't find {e['exe']} in {e['folder']} of the game's folder."
    cur = _real_dir(install, e["folder"])
    if cur is None or _has_exe(cur, e["exe"]) is None:
        return None, missing
    return cur, None


_LISTINGS: dict[str, tuple[float, str, dict]] = {}


def _listing(install: str) -> dict:
    """The install folder, optigames.MAX_DEPTH levels deep, no link followed: {files: [(rel, size)] (size only for
    .exe files, which are regular files), dirs: {rel lower}, any_exe, truncated}. Kept LIST_TTL seconds."""
    now = time.monotonic()
    hit = _LISTINGS.get(install)
    if hit and now - hit[0] < LIST_TTL and hit[1] == install:
        return hit[2]
    files: list[tuple[str, int]] = []
    dirs: set[str] = set()
    out = {"files": files, "dirs": dirs, "any_exe": False, "truncated": False}
    base = install.rstrip("/")
    n = 0
    try:
        for top, dnames, fnames, dfd in os.fwalk(install, follow_symlinks=False):
            rel_top = "" if top == base else top[len(base) + 1:]
            depth = len(_parts(rel_top))
            for d in dnames:
                dirs.add(f"{rel_top}/{d}".lower() if rel_top else d.lower())
            for f in fnames:
                size = 0
                if f.lower().endswith(".exe"):
                    st = _lstat(dfd, f)
                    if st is None or not stat.S_ISREG(st.st_mode):
                        continue
                    size = st.st_size
                    out["any_exe"] = True
                files.append((f"{rel_top}/{f}" if rel_top else f, size))
            n += len(dnames) + len(fnames)
            if n > LIST_MAX:
                out["truncated"] = True
                dnames[:] = []
            elif depth >= optigames.MAX_DEPTH - 1:
                dnames[:] = []
            else:
                dnames[:] = [d for d in dnames if d.lower() not in ("optiscaler", MARK_DIR)]
    except OSError:
        out["truncated"] = True
    if len(_LISTINGS) > 32:
        _LISTINGS.clear()
    _LISTINGS[install] = (now, install, out)
    return out


def forget_listing() -> None:
    _LISTINGS.clear()


def _generic_base(appid: str, name: str) -> dict:
    return {"kind": "generic", "name": name, "exe": None, "folder": "", "api": "dx12", "proxies": None,
            "build": DEFAULT_BUILD, "ini": {}, "fg_inputs": ("dlssg", "fsrfg", "xefg", "upscaler"),
            "fg_input": "upscaler", "args": (), "notes": (), "sources": (), "pick": None, "how": None,
            "api_why": None, "has_upscaler": None}


def _known_base(appid: str, k: dict) -> dict:
    return {"kind": "known", "name": k["name"], "exe": k["exes"][0] if k["exes"] else None, "folder": k["folder"],
            "api": k["api"], "proxies": k["proxies"], "build": DEFAULT_BUILD, "ini": {},
            "fg_inputs": k["fg_inputs"], "fg_input": k["fg_input"], "args": k["args"], "notes": k["notes"],
            "sources": k["sources"], "pick": k["pick"], "how": "known", "api_why": "OptiScaler's wiki",
            "has_upscaler": None, "fit": k["fit"], "conf": k["conf"]}


EXPERIMENTAL = ("Experimental: OXP3 Deck chose this setup from the game's files; nobody has tested OptiScaler with "
                "this game here. Remove puts everything back if it does not work.")
NO_UPSCALER = "No DLSS, FSR 2+ or XeSS found; OptiScaler only works when the game offers one of them."


def _api_note(api: str) -> str | None:
    if api == "dx12":
        return None
    return (f"{optigames.API_NAMES[api]} game: OptiScaler replaces its upscaler only; its frame generation (XeSS "
            "frame generation) needs DirectX 12.")


def _with_api(e: dict, api: str, files: list | None, names: set[str] | None) -> dict:
    e["api"] = api
    if api != "dx12":
        e["fg_inputs"] = ()
        e["fg_input"] = "upscaler"
    note = _api_note(api)
    if note and note not in e["notes"]:
        e["notes"] = (*e["notes"], note)
    if names is not None:
        e["has_upscaler"] = optigames.has_upscaler(names)
    return e


def resolve(ctx, appid, *, fresh: bool = False) -> tuple[dict | None, str | None]:
    """(entry, None) or (None, why): the game's setup with its exe folder found. Installed (the record exists, and
    not fresh): the record's folder, proxy and API. The tested game: its fixed folder. A known game: its exe where
    the wiki puts it, else anywhere; not found: the generic setup. Any other game: the generic rules (optigames).
    The entry gains dir (the resolved exe folder), proxy (None when every name is taken) and taken."""
    appid = str(appid or "")
    if not _APPID.match(appid):
        return None, NO_SETUP
    name = _name(ctx, appid)
    g = None if fresh else _game_rec(ctx, appid)
    tested = GAMES.get(appid)
    known = optigames.KNOWN.get(appid)
    if g is not None:
        e = copy.deepcopy(tested) if tested else _known_base(appid, known) if known else _generic_base(appid, name)
        e["build"] = tested["build"] if tested else DEFAULT_BUILD
        kind = g.get("kind") if g.get("kind") in ("tested", "known", "generic") else e.get("kind", "tested")
        if kind == "generic" and e.get("kind") == "known":
            e = dict(_generic_base(appid, name), sources=e["sources"], notes=e["notes"], pick=e["pick"])
        api = g.get("api") if g.get("api") in optigames.APIS else e.get("api", "dx12")
        if not tested:
            _with_api(e, api, None, None)
        if kind == "generic" and EXPERIMENTAL not in e["notes"]:
            e["notes"] = (EXPERIMENTAL, *e["notes"])
        e.update(kind=kind, name=name, dir=g.get("folder"), proxy=g.get("proxy") or e.get("proxy"), taken=[])
        if isinstance(g.get("exe"), str):
            e["exe"] = g["exe"]
        return e, None
    if tested:
        folder, why = _tested_dir(ctx, appid, tested)
        if folder is None:
            return None, why
        e = copy.deepcopy(tested)
        e.update(dir=folder, folder=tested["folder"])
        e["proxy"], e["taken"] = optigames.pick_proxy(e["api"], _names(folder), e["proxies"])
        return e, None
    install = steamlib.app_install_dir(ctx, appid)
    if not install:
        return None, f"{name} is not installed."
    install = os.path.realpath(install)
    lst = _listing(install)
    files = lst["files"]
    if not lst["any_exe"]:
        if lst["truncated"]:
            return None, f"Can't find {name}'s exe: its folder is too big to search."
        return None, f"{name} runs as a Linux game here; OptiScaler needs its Windows version (Proton)."
    names = optigames.lib_names(files)
    e = None
    if known:
        hit = optigames.find_named(files, known["exes"], known["folder"]) if known["exes"] else None
        if hit:
            e = _known_base(appid, known)
            e.update(folder=hit[0], exe=hit[1])
            _with_api(e, known["api"], files, names)
    if e is None:
        e = _generic_base(appid, name)
        if known:
            want = known["exes"][0] if known["exes"] else "its exe"
            e.update(sources=known["sources"], pick=known["pick"],
                     notes=(f"OptiScaler's wiki has a page for this game, but {want} was not found in its folder, "
                            "so the generic setup is used.", *known["notes"]))
        hit = optigames.pick_exe(files, lst["dirs"])
        if hit is None:
            return None, f"Can't tell which file is {name}'s exe, so OXP3 Deck does not install OptiScaler."
        e.update(folder=hit[0], exe=hit[1], how=hit[2])
    folder = _real_dir(install, e["folder"])
    if folder is None or _has_exe(folder, e["exe"]) is None:
        return None, f"Can't find {e['exe']} in the game's folder."
    exe_path = os.path.join(folder, _has_exe(folder, e["exe"]))
    imports = None
    if e["kind"] == "generic":
        imports, mentioned = _exe_dlls(exe_path)
        if e["how"] == "unity":
            # a Unity <Name>.exe is a stub: UnityPlayer.dll next to it holds the graphics imports
            up = _has_exe(folder, "UnityPlayer.dll")
            if up:
                up_imports, up_mentioned = _exe_dlls(os.path.join(folder, up))
                if up_imports is not None:
                    imports = [*(imports or []), *(n for n in up_imports if n not in (imports or []))]
                if up_mentioned is not None:
                    mentioned = (mentioned or set()) | up_mentioned
        api, why = optigames.decide_api(e["folder"], e["exe"], names, imports, mentioned)
        if api is None:
            if why in ("DirectX 9", "OpenGL"):
                return None, f"{name} uses {why}; OptiScaler needs DirectX 11, DirectX 12 or Vulkan."
            return None, (f"OXP3 Deck can't tell whether {name} uses DirectX 11, DirectX 12 or Vulkan, so it does "
                          "not install OptiScaler.")
        e["api_why"] = why
        _with_api(e, api, files, names)
        notes = [EXPERIMENTAL, *e["notes"]]
        if not e["has_upscaler"]:
            notes.append(NO_UPSCALER)
        e["notes"] = tuple(notes)
    e.update(dir=folder, name=name)
    e["proxy"], e["taken"] = optigames.pick_proxy(e["api"], _names(folder), e["proxies"], imports)
    return e, None


_EXE_DLLS: dict[tuple, tuple] = {}


def _exe_dlls(path: str) -> tuple[list[str] | None, set[bytes] | None]:
    """The exe's imported DLLs, and (when none of them is a graphics API) the API DLL names it mentions; kept per
    (path, size, mtime)."""
    try:
        st = os.stat(path, follow_symlinks=False)
    except OSError:
        return None, None
    key = (path, st.st_size, st.st_mtime_ns)
    if key not in _EXE_DLLS:
        imports = pe.imports(path)
        graphics = ("d3d12.dll", "d3d11.dll", "vulkan-1.dll")
        mentioned = None if any(n in graphics for n in imports or ()) else pe.mentions(path, optigames.API_DLLS)
        if len(_EXE_DLLS) > 64:
            _EXE_DLLS.clear()
        _EXE_DLLS[key] = (imports, mentioned)
    return _EXE_DLLS[key]


def exe_dir(ctx, appid) -> tuple[str | None, str | None]:
    """(the resolved exe folder, None) or (None, why), found afresh (resolve(fresh=True))."""
    e, why = resolve(ctx, appid, fresh=True)
    return (e["dir"], None) if e else (None, why)


def _anticheat(folder: str) -> tuple[str, str] | None:
    """(the first anti-cheat file or folder SCAN_DEPTH levels under `folder`, which anti-cheat), links not
    followed; else None."""
    seen = 0
    base = folder.rstrip("/")
    for top, dirs, files, _fd in os.fwalk(folder, follow_symlinks=False):
        depth = 0 if top == base else top[len(base) + 1:].count("/") + 1
        for d in dirs:
            if d.lower() in ANTICHEAT_DIRS:
                return os.path.join(top, d), ANTICHEAT_DIRS[d.lower()]
        for f in files:
            low = f.lower()
            for pat, what in ANTICHEAT_FILES.items():
                if fnmatch.fnmatchcase(low, pat):
                    return os.path.join(top, f), what
        seen += len(dirs) + len(files)
        if depth >= SCAN_DEPTH - 1 or seen > SCAN_MAX:
            dirs[:] = []
    return None


def anticheat(ctx, appid) -> dict | None:
    """{which, file} when the game is an online game (optigames.ONLINE: which "online", file None) or has anti-cheat
    files SCAN_DEPTH levels under its install folder (also for table games); else None. The automatic setup does
    nothing for such a game."""
    appid = str(appid or "")
    if appid in optigames.ONLINE:
        return {"which": "online", "file": None}
    install = steamlib.app_install_dir(ctx, appid) if _APPID.match(appid) else None
    if not install:
        return None
    found = _anticheat(os.path.realpath(install))
    return {"which": found[1], "file": found[0]} if found else None


def anticheat_why(name: str, install: str, found: tuple[str, str]) -> str:
    rel = os.path.relpath(found[0], install)
    tail = "/" if os.path.isdir(found[0]) else ""
    return (f"{name} uses anti-cheat ({found[1]}: {rel}{tail} found). {GUIDE}: it can stop the game starting or get "
            "the account banned.")


def _names(folder: str) -> set[str]:
    try:
        return {n.lower() for n in os.listdir(folder)}
    except OSError:
        return set()


def _foreign(names: set[str]) -> str | None:
    """The name that shows another tool's OptiScaler in an exe folder holding no OptiScaler of ours."""
    for n in FOREIGN_NAMES:
        if n in names:
            return n
    for p in PROXIES:
        if f"{p}.dll.b" in names:
            return f"{p}.dll.b"
    return None


def unpacker(ctx) -> tuple[str, str] | None:
    """(kind, path) of the host's 7z (7z, 7za, 7zz) or bsdtar in /usr/bin, else None."""
    for name, kind in UNPACKERS:
        p = "/usr/bin/" + name
        real = ctx.sys_path(p)
        if os.path.isfile(real) and os.access(real, os.X_OK):
            return kind, p
    return None


def _unpacker_package(ctx) -> str:
    plat = None
    try:
        from . import xess
        plat = xess.distro(ctx)
    except Exception:
        pass
    if plat == "cachyos":
        return "7zip (sudo pacman -S 7zip)"
    if plat == "bazzite":
        return "bsdtar (or p7zip: rpm-ostree install p7zip, then reboot)"
    return "7zip or bsdtar"


def _no_unpacker(ctx) -> str:
    return f"Needs 7z or bsdtar: {_unpacker_package(ctx)} is not installed."


def _taken_why(e: dict) -> str:
    taken = [f"{p}.dll" for p in e.get("taken") or []]
    if len(taken) == 1:
        return f"The game folder already has a {taken[0]} (another mod). Remove it first."
    names = ", ".join(taken[:-1]) + f" and {taken[-1]}" if len(taken) > 1 else "every name OptiScaler can use"
    return f"The game folder already has {names} (other mods); OptiScaler needs one of these names free."


IN_THE_WAY = "A file is in the way ({}); OXP3 Deck replaces no file automatically."


def _auto_in_the_way(e: dict, names: set[str]) -> str | None:
    """The first name an install would write that is already in the exe folder (lower-case names): the proxy DLL
    (the one picked, else the table's first), OptiScaler.ini, the OptiScaler folder."""
    proxy = e.get("proxy") or ((e.get("proxies") or (None,))[0])
    for want, shown in (((f"{proxy}.dll", f"{proxy}.dll") if proxy else (None, None)),
                        ("optiscaler.ini", "OptiScaler.ini"), ("optiscaler", "OptiScaler/")):
        if want and want in names:
            return shown
    return None


def check(ctx, appid, *, installing: bool, auto: bool = False, ignore_running: bool = False) -> dict:
    """The refusals of DESIGN.md "OptiScaler → Refusals" and "OptiScaler for any game", in order: {ok, error, why}.
    installing=False: for Remove, Update and a choice change (the game must not run and the record must exist).
    auto=True (the automatic setup): also refused when a file the install would write is in the exe folder.
    ignore_running=True: the other refusals while the game runs (the automatic setup's plan; the job checks again)."""
    def no(why: str) -> dict:
        return {"ok": False, "error": why, "why": why}

    appid = str(appid or "")
    if not _APPID.match(appid):
        return no(NO_SETUP)
    name = _name(ctx, appid)
    if not ignore_running and steamlib.running_game(ctx) == appid:
        return no(f"Quit {name} first.")
    g = _game_rec(ctx, appid)
    if not installing:
        if g is None:
            return no(f"OXP3 Deck has not installed OptiScaler in {name}.")
        return {"ok": True, "error": None, "why": None}
    if steamlib.steam_root(ctx) is None and steamlib.flatpak_steam(ctx):
        return no(FLATPAK)             # (before the folder: Flatpak Steam's libraries are not looked at)
    if appid in optigames.ONLINE:
        return no(f"{name} is an online game. {GUIDE}, so OXP3 Deck does not install it.")
    if appid in optigames.NOT_OFFERED:
        return no(f"OptiScaler's wiki documents {name} only with {optigames.NOT_OFFERED[appid][1]}, which OXP3 "
                  "Deck does not set up.")
    if g is not None:
        folder = g.get("folder")
        install = steamlib.app_install_dir(ctx, appid)
        if not isinstance(folder, str) or not install or not _under(folder, os.path.realpath(install)):
            return no(f"OptiScaler was installed in {folder}; remove it there first.")
        if g.get("partial"):
            return no("OptiScaler is partly removed from this game: tap Remove or Update.")
        return no(f"OptiScaler is already installed in {name}.")
    install = steamlib.app_install_dir(ctx, appid)
    if install and appid not in GAMES:
        found = _anticheat(os.path.realpath(install))
        if found:
            return no(anticheat_why(name, os.path.realpath(install), found))
    e, why = resolve(ctx, appid, fresh=True)
    if e is None:
        return no(why)
    root = _install_root(ctx, e["dir"]) or e["dir"]
    # the exe folder too: Unreal games keep BattlEye / EasyAntiCheat in <Game>/Binaries/Win64, below SCAN_DEPTH
    found = _anticheat(e["dir"]) or (_anticheat(root) if appid in GAMES else None)
    if found:
        return no(anticheat_why(name, root, found))
    names = _names(e["dir"])
    if auto:
        hit = _auto_in_the_way(e, names)
        if hit:
            return no(IN_THE_WAY.format(hit))
    if _foreign(names) or MARK_DIR in names:
        return no(FOREIGN)
    if not e.get("proxy"):
        return no(_taken_why(e))
    if not package_ok(ctx, e["build"]) and unpacker(ctx) is None:
        return no(_no_unpacker(ctx))
    return {"ok": True, "error": None, "why": None}


# ---- the package (download, list, unpack as the user) --------------------------------------------------------------

def _cache(ctx) -> str:
    return os.path.join(ctx.home, CACHE_REL)


def _package(ctx, build_id: str) -> dict | None:
    """The package list when the cache folder matches it: the list's sha256 is the one root recorded, and every
    file is there as a regular file of its size (sha256 is checked at install)."""
    if build_id not in BUILDS:
        return None
    with _LOCK:
        want = _load(ctx)["packages"].get(build_id)
    if not want:
        return None
    try:
        dfd = userexec.open_dir(os.path.join(_cache(ctx), build_id))
    except OSError:
        return None
    try:
        raw = context.read_small(PACKAGE_LIST, 4 << 20, dir_fd=dfd)
        if raw is None or hashlib.sha256(raw).hexdigest() != want:
            return None
        try:
            lst = json.loads(raw.decode("utf-8"))
        except ValueError:
            return None
        if not isinstance(lst, dict) or lst.get("build") != build_id or not isinstance(lst.get("files"), list):
            return None
        root = lst.get("root") or ""
        if root and not _safe_rel(root):
            return None
        for f in lst["files"]:
            if not isinstance(f, dict) or not _safe_rel(f.get("rel")) or not isinstance(f.get("size"), int) or \
                    not _HEX.match(str(f.get("sha256"))):
                return None
            st = _lstat(dfd, os.path.join(root, f["rel"]) if root else f["rel"])
            if st is None or not stat.S_ISREG(st.st_mode) or st.st_size != f["size"]:
                return None
        return lst
    finally:
        os.close(dfd)


def package_ok(ctx, build_id: str) -> bool:
    return _package(ctx, build_id) is not None


def parse_7z_listing(text: str) -> list[dict]:
    """`7z l -slt -ba` output as [{name, kind: "file"|"dir"|"link"|"other", size}]. A block with "Type" (the
    archive's own properties) is skipped."""
    out = []
    cur: dict | None = None

    def done(c):
        if c is not None and "Path" in c and "Type" not in c:
            out.append(c)

    for line in text.splitlines():
        if line.startswith("Path = "):
            done(cur)
            cur = {"Path": line[len("Path = "):]}
            continue
        k, sep, v = line.partition(" = ")
        if cur is not None and sep:
            cur[k.strip()] = v
        elif cur is not None and line.endswith(" =") and line[:-2].strip():
            cur[line[:-2].strip()] = ""
    done(cur)
    entries = []
    for c in out:
        attrs = c.get("Attributes", "")
        mode = next((t for t in attrs.split() if len(t) == 10 and t[0] in "-dlcbps"), "")
        if c.get("Symbolic Link") or c.get("Hard Link") or mode[:1] == "l":
            kind = "link"
        elif mode[:1] in ("c", "b", "p", "s"):
            kind = "other"
        elif c.get("Folder") == "+" or mode[:1] == "d" or "D" in (attrs.split()[:1] or [""])[0]:
            kind = "dir"
        else:
            kind = "file"
        size = c.get("Size", "0").strip() or "0"
        entries.append({"name": c["Path"], "kind": kind, "size": int(size) if size.isdigit() else -1})
    return entries


def parse_bsdtar_listing(text: str) -> list[dict]:
    """`bsdtar -tvf` output (ls -l style: mode, links, owner, group, size, month, day, time, name)."""
    entries = []
    for line in text.splitlines():
        if not line.strip():
            continue
        f = line.split(None, 8)
        if len(f) < 9:
            entries.append({"name": line, "kind": "other", "size": -1})
            continue
        mode, size, name = f[0], f[4], f[8]
        kind = {"-": "file", "d": "dir", "l": "link", "h": "link"}.get(mode[:1], "other")
        if " -> " in name or " link to " in name:
            kind = "link"
        entries.append({"name": name, "kind": kind, "size": int(size) if size.isdigit() else -1})
    return entries


def check_listing(entries: list[dict]) -> tuple[str, dict[str, int]]:
    """(root, {file name: size}) of a safe listing, else OptiError: no absolute names, '..', backslashes, links or
    devices; at most MAX_ENTRIES entries and MAX_UNPACKED bytes; one OptiScaler.dll and one OptiScaler.ini, at the
    top or in one top folder (root), and everything inside root."""
    if len(entries) > MAX_ENTRIES:
        raise OptiError(f"the archive has more than {MAX_ENTRIES} entries")
    files: dict[str, int] = {}
    total = 0
    for en in entries:
        n = en["name"]
        clean = n[:-1] if n.endswith("/") else n
        if "\\" in n:
            raise OptiError(f"unsafe entry {n[:80]!r}: backslash in the name")
        if n.startswith("/"):
            raise OptiError(f"unsafe entry {n[:80]!r}: absolute path")
        if not _safe_rel(clean):
            raise OptiError(f"unsafe entry {n[:80]!r}: '..' or an empty or odd part in the path")
        if en["kind"] == "link":
            raise OptiError(f"unsafe entry {n[:80]!r}: a link")
        if en["kind"] not in ("file", "dir"):
            raise OptiError(f"unsafe entry {n[:80]!r}: not a plain file or folder")
        if clean.split("/")[-1] == PACKAGE_LIST:
            raise OptiError(f"unsafe entry {n[:80]!r}: a reserved name")
        if en["kind"] == "file":
            if en["size"] < 0:
                raise OptiError(f"entry {n[:80]!r}: unknown size")
            if clean in files:
                raise OptiError(f"entry {n[:80]!r} is in the archive twice")
            files[clean] = en["size"]
            total += en["size"]
    if total > MAX_UNPACKED:
        raise OptiError(f"the archive unpacks to more than {MAX_UNPACKED >> 20} MB")
    dlls = [n for n in files if n.split("/")[-1].lower() == "optiscaler.dll"]
    inis = [n for n in files if n.split("/")[-1].lower() == "optiscaler.ini"]
    tops = [n for n in dlls if n.count("/") <= 1]
    if len(tops) != 1 or len([n for n in inis if n.count("/") <= 1]) != 1:
        raise OptiError("the archive has no single OptiScaler.dll and OptiScaler.ini at its top")
    root = tops[0].rsplit("/", 1)[0] if "/" in tops[0] else ""
    if f"{root}/OptiScaler.ini".lstrip("/") not in files:
        raise OptiError("OptiScaler.ini is not next to OptiScaler.dll in the archive")
    if root:
        for en in entries:
            clean = en["name"].rstrip("/")
            if clean != root and not clean.startswith(root + "/"):
                raise OptiError(f"entry {clean[:80]!r} is outside the archive's top folder {root}")
    return root, files


def _list_argv(kind: str, path: str, arc: str) -> list[str]:
    return [path, "l", "-slt", "-ba", arc] if kind == "7z" else [path, "-tvf", arc]


def _unpack_argv(kind: str, path: str, arc: str, dest: str) -> list[str]:
    return [path, "x", "-y", "-bd", "-o" + dest, arc] if kind == "7z" else [path, "-xf", arc, "-C", dest]


def _walk_unpacked(dest: str) -> dict[str, tuple[int, str]]:
    """{rel: (size, sha256)} of every file under dest; a link or special file is an OptiError."""
    out = {}
    total = 0
    for top, dirs, files, dfd in os.fwalk(dest, follow_symlinks=False):
        rel_top = os.path.relpath(top, dest)
        rel_top = "" if rel_top == "." else rel_top
        for name in dirs + files:
            st = _lstat(dfd, name)
            rel = f"{rel_top}/{name}" if rel_top else name
            if st is None:
                raise OptiError(f"unpacked entry {rel[:80]!r} went away")
            if stat.S_ISDIR(st.st_mode):
                if name not in dirs:
                    raise OptiError(f"unpacked entry {rel[:80]!r} is not what was listed")
                continue
            if not stat.S_ISREG(st.st_mode):
                raise OptiError(f"unpacked entry {rel[:80]!r} is a link or a special file")
            total += st.st_size
            if total > MAX_UNPACKED or len(out) >= MAX_ENTRIES:
                raise OptiError("the unpacked package is bigger than the archive's listing allows")
            s = _file_sum(dfd, name)
            if s is None:
                raise OptiError(f"cannot read the unpacked {rel[:80]!r}")
            out[rel] = s
    return out


def _user_rm(ctx, path: str) -> None:
    if os.path.lexists(path):
        r = userexec.run(ctx, ["rm", "-rf", "--", path], timeout=300)
        if r.rc != 0:
            raise OptiError(f"cannot remove {path}: {_tail(r, 2)}")


def fetch(ctx, job, build_id: str) -> dict:
    """The package into the cache: {ok, error, path}. Nothing is done when it is already there (package_ok)."""
    b = BUILDS.get(build_id)
    if b is None:
        return {"ok": False, "error": f"OptiScaler: unknown build {build_id!r}", "path": None}
    final = os.path.join(_cache(ctx), build_id)
    if package_ok(ctx, build_id):
        _say(job, f"{b['version']} is already downloaded")
        return {"ok": True, "error": None, "path": final}
    unp = unpacker(ctx)
    if unp is None:
        return {"ok": False, "error": _no_unpacker(ctx), "path": None}
    kind, tool = unp
    new = final + ".new"
    tmp = tempfile.mkdtemp(prefix="oxp3deck-opti-", dir=TMP_PARENT)    # 0700, root's
    try:
        arc = os.path.join(tmp, b["asset"])
        _say(job, f"Downloading {b['url']} (about {b['size_mb']} MB)")
        marks = [0]

        def progress(done: int, total: int | None) -> None:
            if done - marks[0] >= 8 << 20 or (total and done == total):
                marks[0] = done
                _say(job, f"  {done >> 20} MB" + (f" of {total >> 20} MB" if total else ""))

        try:
            downloads.download(b["url"], arc, expected_sha256=b["sha256"], max_bytes=b["size_max"],
                               on_progress=progress)
        except downloads.DownloadError as e:
            if "HTTP 404" in str(e) or "HTTP 410" in str(e):
                raise OptiError(GONE) from e
            raise OptiError(str(e)) from e
        _say(job, f"Downloaded {b['asset']}, sha256 {b['sha256'][:12]}... as pinned")
        os.chmod(tmp, 0o755)       # the user lists and unpacks it; still only root can write here
        os.chmod(arc, 0o644)
        r = userexec.run(ctx, _list_argv(kind, tool, arc), timeout=LIST_TIMEOUT)
        if r.rc != 0:
            raise OptiError(f"listing the archive with {kind} failed: {_tail(r)}")
        entries = parse_7z_listing(r.out) if kind == "7z" else parse_bsdtar_listing(r.out)
        root, files = check_listing(entries)
        _say(job, f"The archive lists {len(files)} files, all plain files and folders")
        try:
            userexec.user_mkdirs(ctx, _cache(ctx))
        except OSError as e:
            raise OptiError(f"cannot create {_cache(ctx)}: {e.strerror or e}") from e
        _user_rm(ctx, new)
        try:
            userexec.user_mkdirs(ctx, new)
        except OSError as e:
            raise OptiError(f"cannot create {new}: {e.strerror or e}") from e
        r = userexec.run(ctx, _unpack_argv(kind, tool, arc, new), timeout=UNPACK_TIMEOUT)
        if r.rc != 0:
            raise OptiError(f"unpacking with {kind} failed: {_tail(r)}")
        got = _walk_unpacked(new)
        if set(got) != set(files) or any(got[n][0] != files[n] for n in files):
            extra = sorted(set(got) ^ set(files))[:3] or [n for n in files if got[n][0] != files[n]][:3]
            raise OptiError(f"the unpacked files differ from the archive's listing ({', '.join(extra)})")
        cut = len(root) + 1 if root else 0
        lst = {"tool": "oxp3deck", "build": build_id, "version": b["version"], "root": root,
               "files": [{"rel": n[cut:], "size": got[n][0], "sha256": got[n][1]} for n in sorted(got)],
               "made_at": int(time.time())}
        blob = (json.dumps(lst, indent=1) + "\n").encode("utf-8")
        userexec.write_new(ctx, os.path.join(new, PACKAGE_LIST), blob)
        _user_rm(ctx, final)
        r = userexec.run(ctx, ["mv", "-T", "--", new, final], timeout=120)
        if r.rc != 0:
            raise OptiError(f"cannot move the package to {final}: {_tail(r, 2)}")
        with _LOCK:
            rec = _load(ctx)
            rec["packages"][build_id] = hashlib.sha256(blob).hexdigest()
            _save(ctx, rec)
        _say(job, f"Unpacked as {ctx.user} into {final}")
        return {"ok": True, "error": None, "path": final}
    except OptiError as e:
        return {"ok": False, "error": str(e), "path": None}
    except OSError as e:
        return {"ok": False, "error": f"OptiScaler download: {e.strerror or e}", "path": None}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        try:
            if os.path.lexists(new):
                _user_rm(ctx, new)
        except OptiError as e:
            log.warning("optiscaler: %s", e)


def prune_cache(ctx) -> list[str]:
    """Removes, as the user, cache folders of builds no record uses and no longer in BUILDS (and leftover .new
    folders). Returns the names removed."""
    cache = _cache(ctx)
    try:
        names = os.listdir(cache)
    except OSError:
        return []
    with _LOCK:
        rec = _load(ctx)
    used = {g.get("build") for g in rec["games"].values()} | set(BUILDS)
    gone = []
    for n in names:
        base = n[:-4] if n.endswith(".new") else n
        if not _BUILD.match(base) or (base in used and not n.endswith(".new")):
            continue
        try:
            _user_rm(ctx, os.path.join(cache, n))
            gone.append(n)
        except OptiError as e:
            log.warning("optiscaler: %s", e)
    if gone:
        with _LOCK:
            rec = _load(ctx)
            for n in gone:
                rec["packages"].pop(n, None)
            _save(ctx, rec)
    return gone


# ---- OptiScaler.ini ------------------------------------------------------------------------------------------------

def _norm_section(s: str) -> str:
    return s.replace("-", "").replace(".", "").lower()


def set_ini(text: str, changes: dict) -> str:
    """`{"Section_Key": value}` set in place: section names compared without '-' and '.', keys without regard to
    case; a missing key is added at the end of its section, a missing section appended. Raises ValueError on a key
    or value INI_KEY / INI_VAL refuse."""
    want: dict[tuple[str, str], tuple[str, str, str]] = {}
    for k, v in changes.items():
        v = str(v)
        if not isinstance(k, str) or not INI_KEY.match(k):
            raise ValueError(f"OptiScaler.ini: bad key {str(k)[:40]!r}")
        if not INI_VAL.match(v):
            raise ValueError(f"OptiScaler.ini: bad value {v[:40]!r} for {k}")
        sec, key = k.split("_", 1)
        want[(_norm_section(sec), key.lower())] = (sec, key, v)
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines()
    done: set = set()
    section = None
    ends: dict[str, int] = {}          # section -> index after its last non-blank line
    names: dict[str, str] = {}
    for i, line in enumerate(lines):
        s = line.strip()
        if s.startswith("[") and s.endswith("]"):
            section = _norm_section(s[1:-1].strip())
            names.setdefault(section, s[1:-1].strip())
            ends[section] = i + 1
            continue
        if section is None:
            continue
        if s and not s.startswith((";", "#")):
            ends[section] = i + 1
            k, sep, _v = s.partition("=")
            hit = want.get((section, k.strip().lower())) if sep else None
            if hit:
                lines[i] = f"{k.strip()}={hit[2]}"
                done.add((section, k.strip().lower()))
    inserts: dict[int, list[str]] = {}
    appended: dict[str, list[str]] = {}
    for key, (sec, k, v) in want.items():
        if key in done:
            continue
        if key[0] in ends:
            inserts.setdefault(ends[key[0]], []).append(f"{k}={v}")
        else:
            appended.setdefault(sec, []).append(f"{k}={v}")
    for at in sorted(inserts, reverse=True):
        lines[at:at] = inserts[at]
    for sec, items in appended.items():
        lines += ["", f"[{sec}]", *items]
    return nl.join(lines) + nl


def _ini_changes(e: dict, choices: dict, glob: dict, layout: str) -> dict:
    ch = {"Plugins_LoadAsiPlugins": "false", "Menu_UseHQFont": "false",
          "Menu_ShowFps": "true" if glob.get("overlay") else "false",
          # Intel: with the NVIDIA spoof libxess takes DP4a, and Arc shows artifacts (DESIGN.md); every game
          "Spoofing_Dxgi": "false"}
    if layout == "subfolder":
        ch["Libraries_OptiDllPath"] = ".\\OptiScaler"
    ch.update(e.get("ini") or {})
    api = e.get("api", "dx12") if e.get("api") in UPSCALER_KEY else "dx12"
    ch[UPSCALER_KEY[api]] = UPSCALER_INI[api][choices["upscaler"]]
    if e.get("kind") != "tested" and api in ("dx11", "dx12"):
        # a found API may be wrong (Unreal delay-loads both d3d11 and d3d12): OptiScaler reads only the running
        # API's key, so both get the choice
        for other in ("dx11", "dx12"):
            ch[UPSCALER_KEY[other]] = UPSCALER_INI[other][choices["upscaler"]]
    fg = choices["fg"] if api == "dx12" else 0
    if fg:
        opti_fg = choices["fg_input"] == "upscaler"
        ch.update({"FrameGen_Enabled": "true", "FrameGen_FGInput": choices["fg_input"], "FrameGen_FGOutput": "xefg",
                   "XeFG_InterpolationCount": str(fg - 1), "XeFG_ForceBorderless": "true",
                   "OptiFG_HUDFix": "true" if opti_fg else "auto",
                   # OptiFG's auto blocks the Steam overlay and Steam Input: a handheld's controls need them
                   "Hotfix_DisableOverlays": "false" if opti_fg else "auto"})
    else:
        ch.update({"FrameGen_Enabled": "false", "FrameGen_FGInput": "nofg", "FrameGen_FGOutput": "nofg",
                   "XeFG_InterpolationCount": "auto", "XeFG_ForceBorderless": "auto", "OptiFG_HUDFix": "auto",
                   "Hotfix_DisableOverlays": "auto"})
    return ch


def ini_text(package_ini: str, e: dict, choices: dict, glob: dict, layout: str = "subfolder") -> str:
    """The package's own OptiScaler.ini with our keys set (every other key keeps upstream's value)."""
    return set_ini(package_ini, _ini_changes(e, choices, glob, layout))


def launch_plan(e: dict, choices: dict) -> dict:
    """What the frontend writes into the launch options (opti.ts applies it; the backend never writes them)."""
    fg = choices["fg"] if e.get("api", "dx12") == "dx12" else 0
    return {"set": {"XESS_FG": str(fg)} if fg else {},
            "remove": list(LAUNCH_REMOVE) + ([] if fg else ["XESS_FG"]),
            "dll_override": e["proxy"],
            "dxvk_config": DXVK_VENDOR if fg >= 3 else None,
            "args": list(e.get("args") or ())}


def _next_text(choices: dict, e: dict | None = None) -> str:
    if e is None or e.get("kind") == "tested":
        if choices["fg"] and choices["fg_input"] == "dlssg":
            return "Start the game, pick DLSS and DLSS frame generation, then restart it once."
        if choices["fg"] and choices["fg_input"] == "xefg":
            return "Start the game, pick XeSS and XeSS frame generation, then restart it once."
        return "Start the game, pick DLSS, then restart it once."
    pick = e.get("pick") or "DLSS, FSR or XeSS (whichever it has)"
    fg = {"dlssg": " and DLSS frame generation", "fsrfg": " and FSR frame generation",
          "xefg": " and XeSS frame generation"}.get(choices["fg_input"], "") if choices["fg"] else ""
    return f"Start the game, pick {pick}{fg} in its graphics settings, then restart it once."


# ---- install -------------------------------------------------------------------------------------------------------

def _dest_of(rel: str, proxy: str, layout: str) -> str | None:
    """Where a package file goes in the exe folder (None: it stays in the cache)."""
    base = rel.split("/")[-1]
    low = base.lower()
    if rel.lower() == "optiscaler.dll":
        return f"{proxy}.dll"
    if rel.lower() == "optiscaler.ini":
        return None                       # written by ini_text
    if low in SKIP_NAMES or low.endswith(".bat") or base.startswith("!!") or rel.split("/")[0].lower() == "licenses":
        return None
    if layout == "subfolder" and rel.split("/")[0].lower() != "optiscaler":
        return "OptiScaler/" + rel
    return rel


def _result(appid: str, **kw) -> dict:
    out = {"ok": True, "error": None, "appid": appid, "build": None, "folder": None, "copied": 0, "backed_up": [],
           "removed": 0, "kept": [], "launch": None, "next": None}
    out.update(kw)
    return out


def _mkdirs_recorded(ctx, g: dict, folder: str, root: str, rel_dir: str, appid: str) -> None:
    """Each missing folder of rel_dir, as the user, recorded in g["dirs"] before it is made."""
    parts = rel_dir.split("/") if rel_dir else []
    cur = ""
    for p in parts:
        nxt = f"{cur}/{p}" if cur else p
        dfd = _open_in(folder, cur)
        try:
            have = _ci_name(dfd, p)
            st = _lstat(dfd, have) if have else None
        finally:
            os.close(dfd)
        if st is not None:
            if not stat.S_ISDIR(st.st_mode):
                raise OptiError(f"{nxt} in the game folder is not a folder")
            cur = f"{cur}/{have}" if cur else have
            continue
        if nxt not in g["dirs"]:
            g["dirs"].append(nxt)
            _put_game(ctx, appid, g)
        try:
            userexec.user_mkdirs(ctx, os.path.join(folder, nxt), within=root)
        except OSError as e:
            raise OptiError(f"cannot create {nxt}: {e.strerror or e}") from e
        cur = nxt


def _backup(ctx, g: dict, folder: str, root: str, rel: str, appid: str, job) -> None:
    """A file at rel (any case) is renamed into the backup folder; its size and sha256 are recorded first."""
    rdir, base = os.path.split(rel)
    dfd = _open_in(folder, rdir)
    try:
        have = _ci_name(dfd, base)
        if have is None:
            return
        st = _lstat(dfd, have)
        if st is None:
            return
        real_rel = f"{rdir}/{have}" if rdir else have
        if not stat.S_ISREG(st.st_mode):
            raise OptiError(f"{real_rel} in the game folder is in the way and is not a file")
        if not _users(ctx, st):
            raise OptiError(f"{real_rel} in the game folder is not {ctx.user}'s")
        s = _file_sum(dfd, have)
        if s is None:
            raise OptiError(f"cannot read {real_rel}")
        _mkdirs_recorded(ctx, g, folder, root, f"{BACKUP_DIR}/{rdir}" if rdir else BACKUP_DIR, appid)
        g["backups"].append({"rel": real_rel, "size": s[0], "sha256": s[1]})
        _put_game(ctx, appid, g)
        bfd = _open_in(folder, f"{BACKUP_DIR}/{rdir}" if rdir else BACKUP_DIR)
        try:
            if _lstat(bfd, have) is not None:
                raise OptiError(f"a backup of {real_rel} is already there")
            os.rename(have, have, src_dir_fd=dfd, dst_dir_fd=bfd)
        finally:
            os.close(bfd)
        _say(job, f"Backed up: {real_rel}")
    finally:
        os.close(dfd)


def _package_ini(pkg_dir: str, lst: dict) -> str:
    root = lst.get("root") or ""
    want = next((f for f in lst["files"] if f["rel"] == "OptiScaler.ini"), None)
    if want is None:
        raise OptiError("the package has no OptiScaler.ini")
    dfd = _open_in(pkg_dir, root)
    try:
        raw = context.read_small("OptiScaler.ini", 4 << 20, dir_fd=dfd)
    finally:
        os.close(dfd)
    if raw is None or hashlib.sha256(raw).hexdigest() != want["sha256"]:
        raise OptiError("the package's OptiScaler.ini changed since it was unpacked: install again")
    return raw.decode("utf-8", errors="replace")


def _write_ini(ctx, g: dict, folder: str, text: str, appid: str) -> None:
    data = text.encode("utf-8")
    userexec.write_new(ctx, os.path.join(folder, "OptiScaler.ini"), data)
    g["files"] = [f for f in g["files"] if f["rel"] != "OptiScaler.ini"]
    g["files"].append({"rel": "OptiScaler.ini", "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    _put_game(ctx, appid, g)


def _first_in_the_way(folder: str, dests: list[str]) -> str | None:
    """The first of `dests` (paths in the exe folder) that is already there in any case: a file a backup would be
    needed for."""
    for rel in dests:
        cur = folder
        parts = rel.split("/")
        for i, part in enumerate(parts):
            try:
                dfd = _open_in(cur)
            except OSError:
                break
            try:
                have = _ci_name(dfd, part)
                st = _lstat(dfd, have) if have else None
            finally:
                os.close(dfd)
            if st is None:
                break
            if i == len(parts) - 1 or not stat.S_ISDIR(st.st_mode):
                return "/".join(parts[:i] + [have])
            cur = os.path.join(cur, have)
    return None


def _put_in(ctx, job, appid: str, e: dict, choices: dict, folder: str, pkg_dir: str, lst: dict,
            origin: str = "user") -> dict:
    build_id = e["build"]
    layout = BUILDS[build_id]["layout"]
    root = _install_root(ctx, folder) or folder
    with _LOCK:
        glob = dict(_load(ctx)["global"])
    plan = []
    for f in lst["files"]:
        dest = _dest_of(f["rel"], e["proxy"], layout)
        if dest is not None:
            plan.append((f, dest))
    ini_src = _package_ini(pkg_dir, lst)
    ini = ini_text(ini_src, e, choices, glob, layout)
    g = {"build": build_id, "folder": folder, "proxy": e["proxy"], "layout": layout, "choices": choices,
         "files": [], "dirs": [], "backups": [], "launch": launch_plan(e, choices), "installed_at": int(time.time()),
         "partial": True, "kind": e.get("kind", "tested"), "api": e.get("api", "dx12"), "exe": e.get("exe"),
         "origin": origin if origin in ("user", "auto") else "user"}
    _put_game(ctx, appid, g)
    rel_folder = os.path.relpath(folder, root)
    _say(job, f"Copying {len(plan) + 1} files into {rel_folder} as {ctx.user}")
    _mkdirs_recorded(ctx, g, folder, root, MARK_DIR, appid)
    state = (json.dumps({"tool": "oxp3deck", "build": build_id, "appid": appid}) + "\n").encode("utf-8")
    userexec.write_new(ctx, os.path.join(folder, MARK_DIR, STATE_NAME), state)
    g["files"].append({"rel": f"{MARK_DIR}/{STATE_NAME}", "size": len(state),
                       "sha256": hashlib.sha256(state).hexdigest()})
    _put_game(ctx, appid, g)
    proot = lst.get("root") or ""
    for f, dest in plan:
        ddir = os.path.dirname(dest)
        _mkdirs_recorded(ctx, g, folder, root, ddir, appid)
        _backup(ctx, g, folder, root, dest, appid, job)
        src = os.path.join(pkg_dir, proot, f["rel"]) if proot else os.path.join(pkg_dir, f["rel"])
        try:
            userexec.copy_new(ctx, src, os.path.join(folder, dest), expect_sha256=f["sha256"],
                              expect_size=f["size"])
        except OSError as ex:
            raise OptiError(f"copying {f['rel']}: {ex.strerror or ex}") from ex
        g["files"].append({"rel": dest, "size": f["size"], "sha256": f["sha256"]})
        _put_game(ctx, appid, g)
    _backup(ctx, g, folder, root, "OptiScaler.ini", appid, job)
    _write_ini(ctx, g, folder, ini, appid)
    g["partial"] = False
    _put_game(ctx, appid, g)
    _say(job, f"OptiScaler is in {rel_folder} as {e['proxy']}.dll")
    return _result(appid, build=build_id, folder=folder, copied=len(g["files"]),
                   backed_up=[b["rel"] for b in g["backups"]], launch=g["launch"], next=_next_text(choices, e))


def install(ctx, settings, job, appid, choices, *, auto: bool = False, origin: str = "user") -> dict:
    """check, fetch, then put the files in (DESIGN.md "Install into the game"). OptiJobResult. auto=True (the
    automatic setup): refused when any file would need a backup, before the first file is copied. origin: who
    asked ("user" | "auto"), kept in the record."""
    appid = str(appid or "")
    why = choices_why(ctx, appid, choices)
    if why:
        return _result(appid, ok=False, error=why)
    c = check(ctx, appid, installing=True, auto=auto)
    if not c["ok"]:
        return _result(appid, ok=False, error=c["error"])
    e, why = resolve(ctx, appid, fresh=True)
    folder = e["dir"] if e else None
    if e is None or not _in_library(ctx, folder):
        return _result(appid, ok=False, error=why or f"{folder} is not inside a Steam library")
    choices, why = check_choices(e, choices)
    if why:
        return _result(appid, ok=False, error=why)
    _say(job, _setup_line(e))
    got = fetch(ctx, job, e["build"])
    if not got["ok"]:
        return _result(appid, ok=False, error=got["error"])
    lst = _package(ctx, e["build"])
    if lst is None:
        return _result(appid, ok=False, error="the downloaded package does not match its list: try again")
    if auto:
        layout = BUILDS[e["build"]]["layout"]
        dests = [d for d in (_dest_of(f["rel"], e["proxy"], layout) for f in lst["files"]) if d is not None]
        hit = _first_in_the_way(folder, [*dests, "OptiScaler.ini"])
        if hit:
            _say(job, IN_THE_WAY.format(hit))
            return _result(appid, ok=False, error=IN_THE_WAY.format(hit), folder=folder)
        if steamlib.running_game(ctx) == appid:     # the download can take minutes: the game may have started
            why = f"Quit {_name(ctx, appid)} first."
            _say(job, why)
            return _result(appid, ok=False, error=why, folder=folder)
    try:
        res = _put_in(ctx, job, appid, e, choices, folder, got["path"], lst, origin)
    except (OptiError, OSError, ValueError) as ex:
        why = str(ex) if isinstance(ex, (OptiError, ValueError)) else f"{ex.strerror or ex}"
        _say(job, f"Failed: {why}; taking out what was put in so far")
        undo = _take_out(ctx, job, appid)
        tail = "what was put in so far was taken out again" if undo["ok"] and not undo["kept"] else \
            "some files are left in the game folder: see Details"
        return _result(appid, ok=False, error=f"OptiScaler install: {why}; {tail}", folder=folder,
                       kept=undo["kept"], removed=undo["removed"])
    forget_listing()
    prune_cache(ctx)
    return res


def _setup_line(e: dict) -> str:
    kind = {"tested": "the tested setup", "known": "the setup OptiScaler's wiki documents",
            "generic": "the generic setup (experimental)"}.get(e.get("kind"), "the generic setup")
    api = optigames.API_NAMES.get(e.get("api"), e.get("api"))
    why = f" ({e['api_why']})" if e.get("api_why") and e.get("kind") == "generic" else ""
    return f"{e['name']}: {kind}; {e.get('exe')} in {e.get('folder') or 'the game folder'}, {api}{why}, " \
           f"as {e.get('proxy')}.dll"


# ---- remove --------------------------------------------------------------------------------------------------------

def _take_out(ctx, job, appid: str) -> dict:
    """Everything the record holds for appid, put back (DESIGN.md "Remove" steps 2-6): {ok, error, removed, kept,
    launch, folder, build}."""
    g = _game_rec(ctx, appid)
    if g is None:
        return {"ok": True, "error": None, "removed": 0, "kept": [], "launch": None, "folder": None, "build": None}
    folder = g.get("folder")
    launch = g.get("launch")
    if isinstance(folder, str) and folder.startswith("/") and not os.path.lexists(folder):
        # the game was uninstalled or moved: nothing is left to take out, so the record goes (and the frontend
        # undoes the launch options)
        _say(job, f"The recorded game folder {folder} is gone; forgetting OptiScaler's install there")
        _put_game(ctx, appid, None)
        return {"ok": True, "error": None, "removed": 0, "kept": [], "launch": launch, "folder": folder,
                "build": g.get("build")}
    if not isinstance(folder, str) or not _in_library(ctx, folder) or not os.path.isdir(folder):
        return {"ok": False, "error": f"the recorded game folder {folder} is gone or not in a Steam library; "
                                      "OptiScaler's files there (if any) were left alone",
                "removed": 0, "kept": [], "launch": launch, "folder": folder, "build": g.get("build")}
    kept: list[str] = []
    kept_files, kept_backups = [], []
    removed = 0
    files = [f for f in g.get("files") or [] if isinstance(f, dict) and _safe_rel(f.get("rel"))]
    backups = [b for b in g.get("backups") or [] if isinstance(b, dict) and _safe_rel(b.get("rel"))]
    dirs = [d for d in g.get("dirs") or [] if _safe_rel(d)]
    # 2. our files, when unchanged (OptiScaler.ini and the marker always)
    for f in reversed(files):
        rdir, base = os.path.split(f["rel"])
        try:
            dfd = _open_in(folder, rdir)
        except OSError:
            continue                     # its folder is gone: so is the file
        try:
            st = _lstat(dfd, base)
            if st is None:
                continue
            always = f["rel"] in ("OptiScaler.ini", f"{MARK_DIR}/{STATE_NAME}")
            same = stat.S_ISREG(st.st_mode) and _file_sum(dfd, base) == (f.get("size"), f.get("sha256"))
            if (always and stat.S_ISREG(st.st_mode) or same) and _users(ctx, st):
                os.unlink(base, dir_fd=dfd)
                removed += 1
            else:
                kept.append(f"{f['rel']} (changed since install)")
                kept_files.append(f)
        finally:
            os.close(dfd)
    # 3. what OptiScaler writes at run time, by fixed names only
    try:
        dfd = _open_in(folder)
        try:
            for n in os.listdir(dfd):
                st = _lstat(dfd, n)
                if st is not None and stat.S_ISREG(st.st_mode) and _users(ctx, st) and \
                        any(fnmatch.fnmatchcase(n.lower(), p) for p in RUNTIME_LOGS):
                    os.unlink(n, dir_fd=dfd)
                    removed += 1
            for d in RUNTIME_DIRS:
                have = _ci_name(dfd, d)
                st = _lstat(dfd, have) if have else None
                if st is not None and stat.S_ISDIR(st.st_mode):
                    _user_rm(ctx, os.path.join(folder, have))
        finally:
            os.close(dfd)
        for d in dirs:
            if "/" in d or d.startswith("."):
                continue                 # only our own top folders (OptiScaler/), never the marker folder here
            if any(k["rel"].startswith(d + "/") for k in kept_files):
                continue
            p = os.path.join(folder, d)
            if os.path.isdir(p) and not os.path.islink(p):
                _user_rm(ctx, p)
    except (OSError, OptiError) as ex:
        kept.append(f"run-time files: {ex}")
    # 4. backups back where nothing took their place
    for b in reversed(backups):
        rdir, base = os.path.split(b["rel"])
        bdir = f"{BACKUP_DIR}/{rdir}" if rdir else BACKUP_DIR
        try:
            bfd = _open_in(folder, bdir)
        except OSError:
            kept.append(f"{b['rel']} (its backup is gone)")
            continue
        try:
            st = _lstat(bfd, base)
            if st is None:
                kept.append(f"{b['rel']} (its backup is gone)")
                continue
            if not stat.S_ISREG(st.st_mode) or _file_sum(bfd, base) != (b.get("size"), b.get("sha256")) or \
                    not _users(ctx, st):
                kept.append(f"{b['rel']} (the backup in {bdir} changed; left there)")
                kept_backups.append(b)
                continue
            try:
                dfd = _open_in(folder, rdir)
            except OSError:
                kept.append(f"{b['rel']} (its folder is gone; the backup is in {bdir})")
                kept_backups.append(b)
                continue
            try:
                if _ci_name(dfd, base) is not None:
                    kept.append(f"{b['rel']} (a new file has that name, maybe from Verify integrity; the old one "
                                f"is in {bdir})")
                    kept_backups.append(b)
                    continue
                os.rename(base, base, src_dir_fd=bfd, dst_dir_fd=dfd)
                _say(job, f"Restored: {b['rel']}")
            finally:
                os.close(dfd)
        finally:
            os.close(bfd)
    # 5. our folders when empty, deepest first; then the marker folder
    for d in sorted(set(dirs), key=lambda x: x.count("/"), reverse=True):
        _rmdir_empty(ctx, folder, d)
    _rmdir_empty(ctx, folder, BACKUP_DIR)
    _rmdir_empty(ctx, folder, MARK_DIR)
    # 6. the record goes only when nothing is left
    if kept:
        g.update({"partial": True, "files": kept_files, "backups": kept_backups, "kept": kept,
                  "dirs": [d for d in dirs if os.path.isdir(os.path.join(folder, d))]})
        _put_game(ctx, appid, g)
    else:
        _put_game(ctx, appid, None)
    return {"ok": True, "error": None, "removed": removed, "kept": kept, "launch": launch, "folder": folder,
            "build": g.get("build")}


def _rmdir_empty(ctx, folder: str, rel: str) -> None:
    rdir, base = os.path.split(rel)
    try:
        dfd = _open_in(folder, rdir)
    except OSError:
        return
    try:
        st = _lstat(dfd, base)
        if st is not None and stat.S_ISDIR(st.st_mode) and _users(ctx, st):
            try:
                os.rmdir(base, dir_fd=dfd)
            except OSError as e:
                if e.errno not in (errno.ENOTEMPTY, errno.EEXIST, errno.ENOENT):
                    raise
    finally:
        os.close(dfd)


def remove(ctx, settings, job, appid) -> dict:
    """Puts everything back from the record (DESIGN.md "Remove"). OptiJobResult; launch: the plan to undo."""
    appid = str(appid or "")
    c = check(ctx, appid, installing=False)
    if not c["ok"]:
        return _result(appid, ok=False, error=c["error"])
    try:
        r = _take_out(ctx, job, appid)
    except (OSError, OptiError) as ex:
        return _result(appid, ok=False, error=f"OptiScaler remove: {ex}")
    prune_cache(ctx)
    forget_listing()
    if not r["ok"]:
        return _result(appid, ok=False, error=r["error"], launch=r["launch"], folder=r["folder"])
    if r["kept"]:
        _say(job, f"Left in the game folder: {'; '.join(r['kept'])}")
    else:
        _say(job, f"OptiScaler is out of {r['folder']}; {r['removed']} files removed")
    return _result(appid, build=r["build"], folder=r["folder"], removed=r["removed"], kept=r["kept"],
                   launch=r["launch"])


def update(ctx, settings, job, appid) -> dict:
    """remove, then install with the recorded choices, in one job; stops after a failed or partial remove."""
    appid = str(appid or "")
    g = _game_rec(ctx, appid)
    e = resolve(ctx, appid)[0] if g is not None else None
    if g is None or e is None:
        return _result(appid, ok=False, error=check(ctx, appid, installing=False)["error"] or NO_SETUP)
    choices, why = check_choices(e, g.get("choices"))
    choices = choices or defaults(e)
    old_launch = g.get("launch")
    got = fetch(ctx, job, e["build"])          # first: a failed download leaves the old build in place
    if not got["ok"]:
        return _result(appid, ok=False, error=got["error"], launch=old_launch, folder=g.get("folder"))
    r = remove(ctx, settings, job, appid)
    if not r["ok"]:
        return r
    if r["kept"]:
        return _result(appid, ok=False, error="OptiScaler could not be taken out completely, so the update stopped: "
                                              "see Details", kept=r["kept"], removed=r["removed"],
                       launch=old_launch, folder=r["folder"])
    res = install(ctx, settings, job, appid, choices, origin=g.get("origin") if g.get("origin") == "auto" else "user")
    res["removed"] = r["removed"]
    res["launch_before"] = old_launch
    return res


# ---- choices, options, info ----------------------------------------------------------------------------------------

def _rewrite_ini(ctx, appid: str, g: dict, e: dict, choices: dict, glob: dict) -> None:
    """The game folder's OptiScaler.ini with our keys set (keys OptiScaler's menu saved are kept); the package's
    ini when the game's is gone."""
    folder = g["folder"]
    if not _in_library(ctx, folder):
        raise OptiError(f"{folder} is not inside a Steam library")
    dfd = _open_in(folder)
    try:
        raw = context.read_small("OptiScaler.ini", 4 << 20, dir_fd=dfd)
    finally:
        os.close(dfd)
    if raw is None:
        lst = _package(ctx, g.get("build") or "")
        if lst is None:
            raise OptiError("OptiScaler.ini is gone from the game folder and the package is not downloaded: "
                            "tap Update")
        text = _package_ini(os.path.join(_cache(ctx), g["build"]), lst)
    else:
        text = raw.decode("utf-8", errors="replace")
    _write_ini(ctx, g, folder, set_ini(text, _ini_changes(e, choices, glob, g.get("layout") or "subfolder")), appid)


def set_choices(ctx, appid, choices, settings=None) -> dict:
    """Rewrites only OptiScaler.ini and the record; not a job. OptiInfoRes with the new launch plan (launch) and
    the one before (launch_before)."""
    appid = str(appid or "")
    c = check(ctx, appid, installing=False)
    if not c["ok"]:
        return {"ok": False, "error": c["error"], "opti": None}
    e, why = resolve(ctx, appid)
    choices, why = check_choices(e, choices) if e else (None, why)
    if why:
        return {"ok": False, "error": why, "opti": None}
    c = check(ctx, appid, installing=False)
    if not c["ok"]:
        return {"ok": False, "error": c["error"], "opti": None}
    with _LOCK:
        g = _game_rec(ctx, appid)
        if g is None or g.get("partial"):
            return {"ok": False, "error": "OptiScaler is partly removed from this game: tap Remove or Update.",
                    "opti": None}
        before = g.get("launch")
        glob = dict(_load(ctx)["global"])
        try:
            _rewrite_ini(ctx, appid, g, e, choices, glob)
        except (OSError, OptiError, ValueError) as ex:
            return {"ok": False, "error": f"OptiScaler: {getattr(ex, 'strerror', None) or ex}", "opti": None}
        g["choices"] = choices
        g["launch"] = launch_plan(e, choices)
        _put_game(ctx, appid, g)
    res = info(ctx, appid, settings)
    res["launch_before"] = before
    return res


def options(ctx, opts) -> dict:
    """{overlay: bool}: global; each installed game's ini is rewritten when that game is not running."""
    if not isinstance(opts, dict) or not isinstance(opts.get("overlay"), bool):
        return {"ok": False, "error": "OptiScaler options: overlay must be true or false", "opti": None}
    running = steamlib.running_game(ctx)
    done, later, failed = [], [], []
    with _LOCK:
        rec = _load(ctx)
        rec["global"]["overlay"] = opts["overlay"]
        _save(ctx, rec)
        for appid, g in rec["games"].items():
            e = resolve(ctx, appid)[0] if not g.get("partial") else None
            if e is None or g.get("partial"):
                continue
            if appid == running:
                later.append(appid)
                continue
            choices, _why = check_choices(e, g.get("choices"))
            try:
                _rewrite_ini(ctx, appid, g, e, choices or defaults(e), rec["global"])
                done.append(appid)
            except (OSError, OptiError, ValueError) as ex:
                failed.append(f"{e['name']}: {getattr(ex, 'strerror', None) or ex}")
    return {"ok": not failed, "error": "; ".join(failed) or None, "opti": None, "overlay": opts["overlay"],
            "updated": done, "not_while_running": later}


def _game_warnings(ctx, settings, appid: str) -> list[str]:
    out = []
    try:
        from . import xess
        det = xess.detect(ctx, settings)
        mapped = steamlib.compat_tool(ctx, appid)
        tool = mapped or steamlib.default_compat_tool(ctx)
        tool_dir = steamlib.find_tool_dir(ctx, tool)
        dll = os.path.join(tool_dir, xess.IGDEXT_REL) if tool_dir else None
        shimmed = xess.has_marker(dll) if dll and os.path.isfile(dll) else None
        if not det["installed"] or shimmed is False:
            out.append("OptiScaler's XeSS will run in the slower mode.")
        if tool and "cachyos" in tool.lower():
            out.append("Use Proton Experimental or GE-Proton for this game.")
    except Exception:
        log.exception("optiscaler: warnings for %s", appid)
    return out


def info(ctx, appid, settings=None) -> dict:
    """{ok, error, opti: OptiInfo} (DESIGN.md "types.ts and api.ts", "OptiScaler for any game")."""
    appid = str(appid or "")
    if not _APPID.match(appid):
        return {"ok": False, "error": "OptiScaler: not a Steam game", "opti": None}
    with _LOCK:
        rec = _load(ctx)
    g = rec["games"].get(appid)
    e, rwhy = resolve(ctx, appid)
    unp = unpacker(ctx)
    t = entry(appid)
    out = {"appid": appid, "supported": e is not None, "why": None, "state": "none", "build": None,
           "build_wanted": e["build"] if e else None, "update": False, "folder": None, "choices": None,
           "defaults": defaults(e) if e else None, "fg_inputs": list(e["fg_inputs"]) if e else [],
           "launch": None, "launch_new": None, "cached": False, "download_mb": None,
           "unpacker": unp[0] if unp else None, "notes": list(e["notes"]) if e else [], "warnings": [], "kept": [],
           "overlay": rec["global"]["overlay"], "version": None, "backed_up": [],
           "sources": list(e["sources"]) if e else list(t["sources"]) if t else [],
           "kind": e.get("kind") if e else (t.get("kind") if t else "generic"),
           "name": e["name"] if e else _name(ctx, appid), "api": e.get("api") if e else None,
           "api_why": e.get("api_why") if e else None, "exe": e.get("exe") if e else None,
           "proxy": e.get("proxy") if e else None, "pick": e.get("pick") if e else None,
           "fg_ok": bool(e) and e.get("api", "dx12") == "dx12",
           "upscaler_found": e.get("has_upscaler") if e else None,
           "fit": e.get("fit") if e else None}
    if e is None and g is None:
        out["why"] = check(ctx, appid, installing=True)["why"] or rwhy
        return {"ok": True, "error": None, "opti": out}
    if e is None:                      # a record, but its entry cannot be built: Remove still works
        out["state"] = "partial" if g.get("partial") else "installed"
        out["folder"] = g.get("folder")
        out["launch"] = g.get("launch")
        out["why"] = check(ctx, appid, installing=False)["why"]
        return {"ok": True, "error": None, "opti": out}
    b = BUILDS[e["build"]]
    out["cached"] = package_ok(ctx, e["build"])
    out["download_mb"] = b["size_mb"]
    out["version"] = b["version"]
    if e.get("proxy"):
        out["launch_new"] = launch_plan(e, defaults(e))
    if g is not None:
        out["state"] = "partial" if g.get("partial") else "installed"
        out["build"] = g.get("build")
        out["update"] = bool(g.get("partial")) or g.get("build") != e["build"]
        out["folder"] = g.get("folder")
        choices, _why = check_choices(e, g.get("choices"))
        out["choices"] = choices
        out["launch"] = g.get("launch")
        out["kept"] = [k for k in g.get("kept") or [] if isinstance(k, str)]
        out["backed_up"] = [b["rel"] for b in g.get("backups") or [] if isinstance(b, dict) and
                            isinstance(b.get("rel"), str)]
        out["why"] = check(ctx, appid, installing=False)["why"]
    else:
        folder = e["dir"]
        out["folder"] = folder
        if folder and (_foreign(_names(folder)) or MARK_DIR in _names(folder)):
            out["state"] = "other"
        out["why"] = check(ctx, appid, installing=True)["why"]
    if settings is not None:
        out["warnings"] = _game_warnings(ctx, settings, appid)
    return {"ok": True, "error": None, "opti": out}
