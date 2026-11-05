"""One game as xess-xmx-linux sees it: the XeSS (and FidelityFX) DLLs in its folder with their versions, what the
shim left in its prefix at the last run, which Proton it runs on and whether that Proton carries the shim, and
short advice taken from the package's docs.

Doc references are to the 20261104 release (docs/*.md); the 20261031 docs say the same where both have the text.
"""
from __future__ import annotations

import collections
import logging
import os
import re
import stat

from . import pe, steamlib, xess

log = logging.getLogger("oxp3deck")

# The four libraries XESS=latest swaps (launch-options.md:82-83, tools/get-xess.sh:2-3).
XESS_DLLS = ("libxess.dll", "libxess_dx11.dll", "libxess_fg.dll", "libxell.dll")
# FSR 3.1+, which FSR=xess / FSR_FG=xess run on XeSS (fsr-frame-generation.md:17-19, proton-hook.py:38-42).
FFX_DLLS = ("amd_fidelityfx_dx12.dll", "amd_fidelityfx_loader_dx12.dll", "amd_fidelityfx_upscaler_dx12.dll",
            "amd_fidelityfx_framegeneration_dx12.dll")
MAX_DEPTH = 10        # tools/proton-hook.py game_libs() searches this deep, so XESS=latest finds the same files
MAX_ENTRIES = 20000
LOG_MAX = 16 << 20    # bytes of a log read from its end
_APPID = re.compile(r"^[0-9]+$")

# Per-game known issues (DESIGN.md "Known issues per game"). fg_crash: XeSS frame generation (XESS_FG, and the FSR
# routes that bring it in) crashes the game, so the frontend warns and asks first, and the automatic launch options
# add no FSR key (they never add XESS_FG for any game). fsr_risk: FSR=xess / FSR_FG replace the game's signed
# FidelityFX DLL. Each entry names its source.
KNOWN_ISSUES: dict[str, tuple[dict, ...]] = {
    "2246340": ({
        "id": "fg_crash", "fg_crash": True, "fsr_risk": True,
        "label": "Frame generation crashes this game",
        "line": "Frame generation crashes the game. Leave it on Game default.",
        "detail": "Monster Hunter Wilds crashes with XeSS frame generation set in its launch options (owner report, "
                  "ONEXPLAYER 3, November 2026). The game has no XeSS frame generation of its own (no "
                  "libxess_fg.dll; its frame generation is DLSS-G or FSR 3.1), so XESS_FG has nothing to act on, and "
                  "the FSR routes (FSR=xess, FSR_FG=xess) replace Capcom's signed FidelityFX DLL, the crash pattern "
                  "of xess-xmx-linux issue #42 (the maintainer suspects Capcom's anti-tamper check). Use the game's "
                  "own FSR 3.1 frame generation and leave XeSS frame generation and FSR → XeSS off. XESS=latest "
                  "also swaps files in this game: if it crashes with it, take that off too.",
        "source": "owner report; github.com/HHHHanasak1/xess-xmx-linux/issues/42; "
                  "github.com/optiscaler/OptiScaler/wiki/Monster-Hunter-Wilds",
    },),
    "292030": ({
        "id": "xell12", "fg_crash": False, "fsr_risk": False,
        "label": "Frame generation may not start",
        "line": "Its XeLL 1.2 refuses the add-on's GPU report, so frame gen stays off.",
        "detail": "The Witcher 3 ships Intel's XeSS SDK 2.1.1 files, with XeLL 1.2.1.13. That XeLL does not check "
                  "for Wine: when the GPU shows as Intel it asks the xess-xmx-linux add-on for the GPU generation and "
                  "accepts only 1270–1276 and 1300. The add-on reports 30 on Panther Lake, so XeLL stops (\"XeLL "
                  "context creation failed - unsupported device\") and XeSS frame generation never starts: the "
                  "menu option does nothing. On SteamOS the game most likely ran on Valve's Proton, where XeSS "
                  "version: Latest swaps in XeLL 1.3.2.10, which sees Wine and keeps its own context. What to try: "
                  "1. Pick Proton Experimental for the game (it gets the add-on and the hook), then XeSS version: "
                  "Latest and Save XeSS logs. 2. A quick test on proton-cachyos: Compatibility mode (XeLL and frame "
                  "generation then take the cross-vendor path: frame generation 2x, upscaling on the slower mode; "
                  "not verified). 3. Experimental: IGDEXT_GTGEN=1300 in the launch options makes the add-on report a "
                  "generation XeLL 1.2 accepts (affects every caller; untested). proton-cachyos 11.0-20261005 hides "
                  "Wine from this game, so even with its hook XeLL 1.3 refuses the GPU there too.",
        "source": "XeLL 1.2.1.13 disassembly (xellAILIsSupportedDevice); xess-xmx-linux shim GpuInfo.cpp "
                  "(GTGeneration 30); proton-cachyos 11.0-20261005 release notes",
    },),
}


def known_issues(appid: str) -> list[dict]:
    """The known issues of a game (copies), [] for any other."""
    return [dict(i) for i in KNOWN_ISSUES.get(str(appid), ())]


def _scan(folder: str) -> tuple[list[str], list[str], bool]:
    """(DLL paths, .xmx-orig leftovers, cut short): breadth first, so a huge game folder still gets its upper
    levels searched; folder symlinks are not followed."""
    wanted = set(XESS_DLLS + FFX_DLLS)
    hits, leftovers = [], []
    seen = 0
    queue = collections.deque([(folder, 0)])
    while queue:
        d, depth = queue.popleft()
        try:
            it = os.scandir(d)
        except OSError:
            continue
        with it:
            for e in it:
                seen += 1
                if seen > MAX_ENTRIES:
                    return sorted(hits), sorted(leftovers), True
                name = e.name.lower()
                try:
                    if e.is_dir(follow_symlinks=False):
                        if depth < MAX_DEPTH:
                            queue.append((e.path, depth + 1))
                    elif name in wanted:
                        hits.append(e.path)
                    elif name.endswith(".xmx-orig") and name[:-len(".xmx-orig")] in wanted:
                        leftovers.append(e.path)
                except OSError:
                    continue
    return sorted(hits), sorted(leftovers), False


def _dll_list(ctx, paths: list[str]) -> list[dict]:
    """Name, path and file version of each DLL. The backend reads as root, so a file is read only when it really
    lies in the home or a Steam library (a killed XESS=latest run leaves links into the package, which is fine)."""
    roots = [os.path.realpath(ctx.home)] + steamlib.libraries(ctx)
    out = []
    for p in paths:
        name = os.path.basename(p)
        link = os.path.islink(p)
        readable = any(xess._under(os.path.realpath(p), r) for r in roots)
        out.append({"name": name, "path": p, "version": pe.file_version(p) if readable else None,
                    "kind": "xess" if name.lower() in XESS_DLLS else "ffx", "link": link})
    return out


def _last_match(path: str, pattern: bytes) -> str | None:
    """The last match (group 1) of `pattern` in the last LOG_MAX bytes of a log, or None."""
    rx = re.compile(pattern, re.I)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError:
        return None
    last = None
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return None
        os.lseek(fd, max(0, st.st_size - LOG_MAX), os.SEEK_SET)
        carry = b""
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            buf = carry + chunk
            for m in rx.finditer(buf):
                last = m.group(1) if m.groups() else m.group(0)
            carry = buf[-512:]
        return last.decode("utf-8", errors="replace").strip() if last is not None else None
    except OSError:
        return last.decode("utf-8", errors="replace").strip() if last is not None else None
    finally:
        os.close(fd)


def last_run(prefix: str | None) -> dict | None:
    """What the shim and the driver left in drive_c (how-it-works.md:67-83, debugging.md:11-14, :28-33)."""
    if not prefix:
        return None
    c = os.path.join(prefix, "drive_c")
    trace = os.path.join(c, "igdext_trace.log")
    xell = os.path.join(c, "igdext_xell.log")
    xefg = os.path.join(c, "igdext_xefg.log")
    failed = os.path.join(c, "igdext_kernels", "compile_failed.txt")
    canary = os.path.join(c, "igdext_kernels", "anv_canary")
    has_trace = os.path.isfile(trace)
    logs = [p for p in (xell, trace) if os.path.isfile(p)]
    unsupported = None
    if logs:
        unsupported = any(_last_match(p, rb"(unsupported device)") is not None for p in logs)
    times = []
    for p in (trace, xell, xefg, failed, canary):
        try:
            times.append(os.lstat(p).st_mtime)
        except OSError:
            pass
    return {
        "trace": has_trace,
        # the trace's "fallback: unknown Intel device id" / "fallback: self-test failed" (debugging.md:11-12)
        "fallback": _last_match(trace, rb"fallback:\s*([^\r\n]{1,200})") if has_trace else None,
        "compile_failed": os.path.isfile(failed),
        "canary": os.path.isfile(canary),
        "xell_unsupported": unsupported,
        # XeLL's own log: "[XeLL] Using built-in context" = cross-vendor mode (how-it-works.md:130-131)
        "xell_builtin": (_last_match(xell, rb"(using built-in context)") is not None) if os.path.isfile(xell) else None,
        # XeSS-FG refuses exclusive fullscreen ("Interpolation is not supported in fullscreen mode",
        # fsr-frame-generation.md:162, launch-options.md:79)
        "fg_fullscreen": (_last_match(xefg, rb"(not supported in fullscreen)") is not None)
        if os.path.isfile(xefg) else None,
        "logged_at": max(times) if times else None,
    }


def _ci_join(folder: str, names: tuple[str, ...]) -> str | None:
    """folder/a/b/c matching each name without regard to case (Wine's view), or None."""
    cur = folder
    for want in names:
        try:
            hit = next((n for n in sorted(os.listdir(cur)) if n.lower() == want), None)
        except OSError:
            return None
        if hit is None:
            return None
        cur = os.path.join(cur, hit)
    return cur


def prefix_checks(ctx, prefix: str | None) -> dict | None:
    """What in the prefix decides whether the shim loads and how XeLL behaves:

    - driverstore_capital: system32 has a `DriverStore` spelled otherwise than install.sh's `driverstore`
      (proton-cachyos makes one, with a link to its own igdext64.dll; Wine picks that one: xess-xmx-linux issue #46,
      fixed on main by PR #47, in no release up to 20261104). driverstore_capital_shimmed: whether its igdext64.dll
      is the shim (None: none there, or it cannot be read).
    - hides_wine: user.reg names HideWineExports (protonfixes hide Wine from the game; XeLL 1.3 then also takes the
      Intel path). None: no user.reg."""
    if not prefix:
        return None
    sys32 = os.path.join(prefix, "drive_c", "windows", "system32")
    try:
        names = os.listdir(sys32)
    except OSError:
        names = []
    other = sorted(n for n in names if n.lower() == "driverstore" and n != "driverstore")
    shimmed = None
    if other:
        dll = _ci_join(os.path.join(sys32, other[0]), ("filerepository", "igd_faux.inf_1", "igdext64.dll"))
        if dll:
            real = os.path.realpath(dll)
            roots = [os.path.realpath(ctx.home)] + steamlib.libraries(ctx) + \
                [ctx.sys_path(d) for d in steamlib.SYSTEM_TOOL_DIRS]
            if any(xess._under(real, r) for r in roots):
                shimmed = xess.has_marker(real)
    reg = os.path.join(prefix, "user.reg")
    hides = (_last_match(reg, rb"(HideWineExports)") is not None) if os.path.isfile(reg) else None
    return {"driverstore_capital": bool(other), "driverstore_capital_shimmed": shimmed, "hides_wine": hides}


def _version_of(dlls: list[dict], name: str) -> tuple[str | None, tuple | None]:
    """The oldest version of `name` among the game's copies (the one a rule is about)."""
    vs = [(pe.version_tuple(d["version"]), d["version"]) for d in dlls if d["name"].lower() == name and d["version"]]
    vs = [v for v in vs if v[0] is not None]
    if not vs:
        return None, None
    t, s = min(vs)
    return s, t


def _advice(ctx, settings, game: dict, tool: dict, leftovers: list[str], truncated: bool,
            det: dict | None = None) -> list[str]:
    out = []
    det = xess.detect(ctx, settings) if det is None else det
    if not det["installed"]:
        out.append("xess-xmx-linux is not installed: XeSS runs on DP4a (install it from the XeSS page).")
    dlls = game["dlls"]
    tool_name = game["compat_tool"] or tool["default"]
    system = tool["system"]

    # Older than 2.0.2.68: DXVK reports the Intel GPU as AMD's to it (launch-options.md:56-58, games.md:20-24,
    # debugging.md:9). The shorthands need the Proton hook (launch-options.md:12-17).
    xv, xt = _version_of(dlls, "libxess.dll")
    if xt is not None and xt < (2, 0, 2, 68):
        line = (f"XeSS {xv} is older than 2.0.2.68: DXVK hides the Intel GPU from it (DP4a, maybe no frame "
                "generation). Add XESS=latest to the launch options.")
        if system:
            line += f" That needs the Proton hook, which {tool_name} (a system Proton) does not have."
        out.append(line)
    # XeSS-FG older than 1.2 is not offered on Intel (games.md:23-24); XESS_FG needs 1.2+ (launch-options.md:65).
    fv, ft = _version_of(dlls, "libxess_fg.dll")
    if ft is not None and ft < (1, 2):
        out.append(f"XeSS frame generation {fv} is older than 1.2: the game does not offer it on Intel GPUs. "
                   "XESS=latest swaps in the SDK's 1.3.1.78 while the game runs.")
    # XeLL 1.2 accepts only some GT generations: the owner's report from The Witcher 3 (libxell 1.2.1.13). The log
    # line is "XeLL context creation failed - unsupported device" (debugging.md:78). XESS=latest swaps every one of
    # the four libraries that is older than the SDK's (launch-options.md:82-86).
    lv, lt = _version_of(dlls, "libxell.dll")
    lr = game["last_run"] or {}
    if lt is not None and lt[:2] == (1, 2):
        line = f"XeLL {lv}: XeLL 1.2 may refuse this GPU (unsupported device), so frame generation can stay off."
        if lr.get("xell_unsupported"):
            line += " The last run's log says it did."
        if game["compat_tool_hook"] is False:
            # the shorthands need the hook (launch-options.md:12-17); a system Proton gets none (install.sh)
            line += (f" XESS=latest would swap in XeLL 1.3.2.10, but it needs the Proton hook, which {tool_name} "
                     "does not have: pick Proton Experimental for this game.")
        else:
            line += " XESS=latest swaps in XeLL 1.3.2.10 while the game runs."
        if (game.get("prefix_checks") or {}).get("hides_wine"):
            line += (" This prefix hides Wine from the game (HideWineExports), so XeLL 1.3 may refuse the GPU too: "
                     "Proton Experimental does not hide it.")
        out.append(line)
    elif lr.get("xell_unsupported"):
        out.append("XeLL refused this GPU at the last run (unsupported device), so frame generation stayed off.")
    # A failed compile: DP4a until a retry (debugging.md:14, how-it-works.md:67-75).
    if lr.get("compile_failed"):
        out.append("A kernel failed to compile at the last run: the game falls back to DP4a until a retry (the "
                   "next launch retries once; after that a game or driver update, deleting "
                   "drive_c/igdext_kernels/compile_failed.txt, or running install.sh again).")
    fb = lr.get("fallback")
    if fb:
        if "self-test" in fb:      # debugging.md:12
            out.append("The shim fell back to DP4a: the patched driver was not active in the game (self-test "
                       "failed). Check the driver status; log out and back in after an install.")
        elif "unknown intel device" in fb.lower():   # debugging.md:11
            out.append("The shim fell back to DP4a: it does not know this GPU (unknown Intel device id).")
        else:
            out.append(f"The shim fell back to DP4a at the last run: {fb}")
    # A system Proton without the shim: Proton copies its stock igdext64.dll into the prefix (debugging.md:8).
    if system and tool["shimmed"] is False:
        out.append(f"{tool_name} is a system Proton without the shim, so XeSS stays on DP4a: shim it from the XeSS "
                   "page, or pick a Proton in ~/.local/share/Steam/compatibilitytools.d.")
    # A Proton without a driver store of its own (Proton 11.0) finds the shim only through
    # INTC_ALT_DRIVER_EXTENSIONS_PATH, which install.sh sets from 20261104 on (debugging.md:101).
    if tool["dir"] and tool["has_igdext"] is False and det["installed"] \
            and "INTC_ALT_DRIVER_EXTENSIONS_PATH" not in det["env"]:
        out.append(f"{tool_name} has no driver store of its own: XeSS loads the shim there only with "
                   "xess-xmx-linux 20261104 or newer (INTC_ALT_DRIVER_EXTENSIONS_PATH).")
    if not game["compat_tool"]:
        if tool["default"]:
            if not tool["dir"]:
                out.append(f"This game uses Steam's default tool ({tool['default']}), whose folder was not found.")
        else:
            out.append("This game uses Steam's default compatibility tool, which Steam's config.vdf does not name: "
                       "whether it carries the shim is unknown.")
    elif not tool["dir"]:
        out.append(f"The folder of {game['compat_tool']} was not found: whether it carries the shim is unknown.")
    # FSR 3.1+ without XeSS: FSR=xess (fsr-frame-generation.md:1-2, :12-13 a game with XeSS should use its XeSS).
    names = {d["name"].lower() for d in dlls}
    if names & set(FFX_DLLS) and not names & set(XESS_DLLS):
        line = "The game has FSR 3.1+ and no XeSS: FSR=xess runs its upscaling and frame generation on XeSS."
        if not xess.features(det["path"])["fsr"]:
            line += " That needs xess-xmx-linux 20261104 or newer."
        out.append(line)
    if leftovers:      # launch-options.md:86-88
        out.append("A killed XESS=latest run left the game's own libraries renamed (.xmx-orig); the game's next "
                   "start puts them back.")
    if not game["prefix"]:
        out.append("No Proton prefix yet: the game has not run with Proton (or it runs natively).")
    if not game["install_dir"]:
        out.append("The game's folder was not found in any Steam library.")
    elif not dlls:
        out.append("No XeSS or FidelityFX DLL in the game's folder.")
    if truncated:
        out.append(f"The game's folder has more than {MAX_ENTRIES} entries; only part of it was searched.")
    return out


def _suggest(det: dict, game: dict) -> list[dict]:
    """The launch options the automatic launch options may add (DESIGN.md "Automatic launch options"): from the
    conditions of _advice, only with xess-xmx-linux installed and a Proton that has the hook (the shorthands need
    it, launch-options.md:12-17). [{key, value, why}]."""
    if not det["installed"] or game["compat_tool_hook"] is False:
        return []
    out = []
    dlls = game["dlls"]
    why = None
    xv, xt = _version_of(dlls, "libxess.dll")
    fv, ft = _version_of(dlls, "libxess_fg.dll")
    lv, lt = _version_of(dlls, "libxell.dll")
    if xt is not None and xt < (2, 0, 2, 68):
        why = f"XeSS {xv} is older than 2.0.2.68, so it would run in the slower mode."
    elif ft is not None and ft < (1, 2):
        why = f"XeSS frame generation {fv} is older than 1.2, so the game would not offer it."
    elif lt is not None and lt[:2] == (1, 2):
        why = f"XeLL {lv} may refuse this GPU, so frame generation could stay off."
    if why:
        out.append({"key": "XESS", "value": "latest", "why": why})
    names = {d["name"].lower() for d in dlls}
    risky = any(i.get("fsr_risk") or i.get("fg_crash") for i in game.get("known_issues") or [])
    if names & set(FFX_DLLS) and not names & set(XESS_DLLS) and xess.features(det["path"])["fsr"] and not risky:
        out.append({"key": "FSR", "value": "xess", "why": "The game has FSR 3.1+ and no XeSS: its FSR runs on XeSS."})
    # never frame generation: it can crash a game (Monster Hunter Wilds), so only the user turns it on
    return [a for a in out if a["key"] not in NEVER_SUGGESTED]


# Keys the automatic launch options never add, for any game (autolaunch.ts and copyopts.ts drop them too).
NEVER_SUGGESTED = ("XESS_FG", "FSR_FG")


def _checks(game: dict) -> list[dict]:
    """Short rows of what the prefix and the last run show ({id, label, line, detail}): the frontend shows each as a
    row with Details on the Games tab."""
    out = []
    pc = game.get("prefix_checks") or {}
    names = {d["name"].lower() for d in game["dlls"]}
    if pc.get("driverstore_capital") and pc.get("driverstore_capital_shimmed") is not True:
        out.append({"id": "driverstore", "label": "Second driver store in the prefix",
                    "line": "XeSS may load the Proton's own file instead of the add-on.",
                    "detail": "This game's prefix has a capitalised system32\\DriverStore folder (proton-cachyos makes "
                              "one, with a link to its own igdext64.dll) next to the lowercase driverstore that "
                              "xess-xmx-linux fills. Wine picks the capitalised one, so XeSS loads the stock file: "
                              "no fast mode, frame generation 2x at most. xess-xmx-linux issue #46: the fix (write "
                              "both folders) is merged on its main branch but in no release up to 20261104. Until "
                              "then: delete pfx/drive_c/windows/system32/DriverStore in this game's prefix while the "
                              "game is closed (the lowercase driverstore stays), or pick Proton Experimental."})
    if pc.get("hides_wine") and "libxell.dll" in names:
        out.append({"id": "hides_wine", "label": "Proton hides Wine from this game",
                    "line": "XeLL then treats the GPU as Intel's and may refuse it.",
                    "detail": "The prefix's user.reg has HideWineExports (protonfixes, proton-cachyos). XeLL 1.3 "
                              "checks for Wine to keep its own cross-vendor context; with Wine hidden it asks the "
                              "add-on and can refuse the GPU (unsupported device), so frame generation stays off. "
                              "Proton Experimental does not hide Wine."})
    lr = game.get("last_run") or {}
    if lr.get("fg_fullscreen"):
        out.append({"id": "fullscreen", "label": "Last run: exclusive fullscreen",
                    "line": "Frame generation stays off in exclusive fullscreen: pick borderless.",
                    "detail": "XeSS frame generation's log says \"Interpolation is not supported in fullscreen "
                              "mode\": in exclusive fullscreen it shows only the real frames. Choose borderless or "
                              "windowed in the game's display settings."})
    return out


def game_info(ctx, settings, appid: str) -> dict:
    """{ok, error, game: GameInfo}."""
    appid = str(appid or "")
    if not _APPID.match(appid):
        return {"ok": False, "error": "game info: not a Steam game", "game": None}
    try:
        install_dir = steamlib.app_install_dir(ctx, appid)
        prefix = steamlib.prefix_dir(ctx, appid)
        mapped = steamlib.compat_tool(ctx, appid)
        default = steamlib.default_compat_tool(ctx)
        tool_dir = steamlib.find_tool_dir(ctx, mapped or default)
        dll = os.path.join(tool_dir, xess.IGDEXT_REL) if tool_dir else None
        has_igdext = os.path.isfile(dll) if dll else None
        shimmed = xess.has_marker(dll) if has_igdext else None
        tool = {"default": default, "dir": tool_dir, "has_igdext": has_igdext, "shimmed": shimmed,
                "system": steamlib.is_system_tool(ctx, tool_dir),
                "hook": xess.has_hook(tool_dir) if tool_dir else None}
        paths, leftovers, truncated = _scan(install_dir) if install_dir else ([], [], False)
        game = {
            "appid": appid,
            "install_dir": install_dir,
            "prefix": prefix,
            "compat_tool": mapped,
            "compat_tool_shimmed": shimmed,
            "default_compat_tool": default,
            "compat_tool_dir": tool_dir,
            "compat_tool_system": tool["system"],
            "compat_tool_hook": tool["hook"],
            "dlls": _dll_list(ctx, paths),
            "last_run": last_run(prefix),
            "prefix_checks": prefix_checks(ctx, prefix),
            "known_issues": known_issues(appid),
        }
        names = {d["name"].lower() for d in game["dlls"]}
        # None: the folder is unknown or was searched only in part
        game["has_fg"] = None if not install_dir or truncated else "libxess_fg.dll" in names
        game["fg_crash"] = any(i["fg_crash"] for i in game["known_issues"])
        det = xess.detect(ctx, settings)
        game["advice"] = _advice(ctx, settings, game, tool, leftovers, truncated, det)
        game["suggest"] = _suggest(det, game)
        game["checks"] = _checks(game)
        return {"ok": True, "error": None, "game": game}
    except Exception as e:      # a Plugin method never raises
        log.exception("game info %s", appid)
        return {"ok": False, "error": f"game info: {type(e).__name__}: {e}", "game": None}
