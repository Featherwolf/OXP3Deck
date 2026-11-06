"""OptiScaler for any game (DESIGN.md "OptiScaler for any game"): the known-games table, the games it is not offered
for, and the pure rules that find a game's exe folder, its graphics API and a free proxy name from a listing of its
install folder. optiscaler.py does the reading and the installing; everything here is pure, so it is tested
without a game.

The table's facts come from OptiScaler's wiki (github.com/optiscaler/OptiScaler/wiki, the page named in each entry's
sources, read at commit 288adff) and OptiScaler's misc/GameConfigs.cpp (master d6b0245, the same table as the pinned
nightly), which already sets most per-game OptiScaler.ini defaults by exe name. Only facts are taken: the wiki has
no licence file, so none of its text is copied (every note here is written for OXP3 Deck), and no code of
GameConfigs.cpp (GPL-3.0) is used. Nothing from ClawDeck's assets/games.json.

Install-level only: an entry says where the exe is, which proxy names the wiki names, the API, what to pick in the
game and which frame-generation inputs are documented. It repeats no OptiScaler.ini key GameConfigs sets: those
stay "auto" so OptiScaler's own per-game defaults apply. Not tested on the OXP3 unless kind is "tested" (The
Witcher 3, optiscaler.GAMES).
"""
from __future__ import annotations

import re

WIKI = "github.com/optiscaler/OptiScaler/wiki/"
GC = "OptiScaler master OptiScaler/misc/GameConfigs.cpp"

APIS = ("dx12", "dx11", "vulkan")
# OptiScaler's own proxy names (dllmain.cpp), in setup_linux.sh's order; OptiScaler.asi is left out: it needs
# Ultimate ASI Loader, which OXP3 Deck does not download.
ALL_PROXIES = ("dxgi", "winmm", "version", "dbghelp", "d3d12", "wininet", "winhttp")
# By API, for a game without a table entry. A Vulkan game may never load dxgi.dll (wiki: DOOM: The Dark Ages,
# Enshrouded use winmm), so the generic setup never gives it dxgi; only a table entry whose wiki page names dxgi may
# (No Man's Sky, after dbghelp). d3d12.dll only for a DirectX 12 game; wininet / winhttp only when the table says so.
PROXIES_BY_API = {
    "dx12": ("dxgi", "winmm", "version", "dbghelp", "d3d12"),
    "dx11": ("dxgi", "winmm", "version", "dbghelp"),
    "vulkan": ("winmm", "dbghelp", "version"),
}
FG_INPUTS = ("dlssg", "fsrfg", "xefg", "upscaler")


def _k(name, exe, folder, api, proxies, pick, fg=(), notes=(), page="", gc=True, args=(), conf="H", fit="good",
       auto=None):
    """One known-games entry. exe: lower-case name(s), or None (found by the generic rules); folder: where the wiki
    puts it ("." the install folder), a hint only; fg: the frame-generation inputs the wiki documents (OptiFG,
    "upscaler", is added for every DirectX 12 game); conf: H = appid and folder checked, M = from memory. auto:
    {choices, why, short} when the automatic setup installs OptiScaler by itself (DESIGN.md "Automatic setup"); no
    entry has it now (none is tested on this device), a later one only with a source."""
    exes = (exe,) if isinstance(exe, str) else tuple(exe or ())
    inputs = tuple(fg) + (("upscaler",) if api == "dx12" and "upscaler" not in fg else ())
    srcs = [WIKI + page] if page else []
    if gc and exes:
        srcs.append(f"{GC} ({exes[0]})")
    return {"name": name, "exes": exes, "folder": folder, "api": api, "proxies": tuple(proxies), "pick": pick,
            "fg_inputs": inputs if api == "dx12" else (), "fg_input": inputs[0] if api == "dx12" else "upscaler",
            "notes": tuple(notes), "args": tuple(args), "sources": tuple(srcs), "conf": conf, "fit": fit,
            "auto": auto}


# The wiki documents these (its per-game pages); appid -> entry. The Witcher 3 is optiscaler.GAMES (tested).
KNOWN = {
    "1091500": _k("Cyberpunk 2077", "cyberpunk2077.exe", "bin/x64", "dx12", ("dxgi", "wininet"), "XeSS",
                  ("dlssg",), ("With path tracing, avoid DLSS in the game on Intel: it forces Ray Reconstruction "
                               "and gets noisy.", "Avoid the game's FSR frame generation as the input."),
                  "Cyberpunk-2077"),
    "2358720": _k("Black Myth: Wukong", "b1-win64-shipping.exe", "b1/Binaries/Win64", "dx12", ("dxgi", "winmm"),
                  "XeSS", (), ("FSR 3.1 in the game does not work as the input.",), "Black-Myth-Wukong"),
    "1903340": _k("Clair Obscur: Expedition 33", "sandfall-win64-shipping.exe", "Sandfall/Binaries/Win64", "dx12",
                  ("dxgi",), "FSR 3.1", ("upscaler",), ("Ultra Quality can flicker or crash: use another quality.",),
                  "Clair-Obscur-Expedition-33", gc=False),
    "870780": _k("Control Ultimate Edition", "control_dx12.exe", ".", "dx12", ("dxgi", "winmm"), "DLSS",
                 ("upscaler",), (), "Control-Ultimate-Edition"),
    "990080": _k("Hogwarts Legacy", "hogwartslegacy.exe", "Phoenix/Binaries/Win64", "dx12", ("dxgi",),
                 "FSR 3.1 or XeSS", ("dlssg",), (), "Hogwarts-Legacy", gc=False),
    "1716740": _k("Starfield", "starfield.exe", ".", "dx12", ("dxgi", "d3d12"), "DLSS or XeSS", (),
                  ("OptiScaler turns the game's FSR 3 inputs off by itself.",), "Starfield"),
    "2124490": _k("Silent Hill 2", "shproto-win64-shipping.exe", "SHProto/Binaries/Win64", "dx12", ("dxgi",),
                  "XeSS or DLSS", (), ("FSR 3.1 in the game may crash when starting a new game.",),
                  "Silent-Hill-2-Remake", gc=False, conf="M"),
    "1643320": _k("S.T.A.L.K.E.R. 2", "stalker2-win64-shipping.exe", "Stalker2/Binaries/Win64", "dx12",
                  ("dxgi", "winmm"), "XeSS or FSR 3.1", (), ("Intel Arc shows rainbow artifacts when the GPU is "
                                                            "spoofed; OXP3 Deck turns the spoof off.",),
                  "S.T.A.L.K.E.R.-2-Heart-of-Chornobyl", gc=False, conf="M"),
    "1627720": _k("Lies of P", "lop-win64-shipping.exe", "LiesofP/Binaries/Win64", "dx12", ("dxgi",), "FSR 3.1",
                  ("fsrfg",), ("Game versions before 1.8.0.0 need Fsr2Pattern=true in OptiScaler.ini.",),
                  "Lies-of-P", conf="M"),
    "1182900": _k("A Plague Tale: Requiem", "aplaguetalerequiem_x64.exe", ".", "dx12", ("dxgi",), "DLSS",
                  ("upscaler",), ("A Streamline 1 game: the game's DLSS frame generation is not an input.",),
                  "A-Plague-Tale-Requiem", gc=False, conf="M"),
    "1693980": _k("Dead Space (2023)", "dead space.exe", ".", "dx12", ("dxgi",), "FSR 2 or DLSS", ("upscaler",),
                  ("The game caps its frame rate in a borderless window.",), "Dead-Space-(2023)"),
    "1850570": _k("Death Stranding Director's Cut", "ds.exe", ".", "dx12", ("dxgi",), "XeSS", ("upscaler",),
                  ("DLSS in the game shimmers: use XeSS.",), "Death-Stranding-Director's-Cut"),
    "3017860": _k("DOOM: The Dark Ages", "doomthedarkages.exe", ".", "vulkan", ("winmm",), "XeSS or FSR 3.1", (),
                  ("The mouse does not work in OptiScaler's menu outside the game's pause menu.",),
                  "Doom-The-Dark-Ages", conf="M"),
    "534380": _k("Dying Light 2", "dyinglightgame_x64_rwdi.exe", "ph/work/bin/x64", "dx12", ("dxgi", "version"),
                 "XeSS", (), ("Run the game in DirectX 12.", "Use the keyboard in OptiScaler's menu."),
                 "Dying-Light-2", conf="M"),
    "2215430": _k("Ghost of Tsushima Director's Cut", "ghostoftsushima.exe", ".", "dx12", ("dxgi",),
                  "FSR 3.1 or XeSS", ("dlssg",), (), "Ghost-of-Tsushima-DIRECTORS-CUT"),
    "1593500": _k("God of War (2018)", "gow.exe", ".", "dx11", ("dxgi",), "DLSS", (),
                  ("FSR 2 in the game does not work as the input.",), "God-of-War-2018"),
    "414340": _k("Hellblade: Senua's Sacrifice", "hellbladegame-win64-shipping.exe", "HellbladeGame/Binaries/Win64",
                 "dx12", ("dxgi", "winmm"), "DLSS", ("upscaler",), ("Tested on Linux by OptiScaler's wiki.",),
                 "Hellblade-Senuas-Sacrifice", args=("-dx12",), conf="M"),
    "1659040": _k("HITMAN World of Assassination", "hitman3.exe", "Retail", "dx12", ("dxgi",), "XeSS or DLSS",
                  ("dlssg",), ("A render scale of 1.0 turns upscaling off: use 1.01.",
                               "The game connects online; it has no anti-cheat files."),
                  "HITMAN-3-World-of-Assassination"),
    "2420110": _k("Horizon Forbidden West", "horizonforbiddenwest.exe", ".", "dx12", ("dxgi",), "FSR 3.1 or XeSS",
                  (), ("Turn motion blur off.",), "Horizon-Forbidden-West-Complete-Edition"),
    "2561580": _k("Horizon Zero Dawn Remastered", "horizonzerodawnremastered.exe", ".", "dx12",
                  ("dxgi", "version", "winmm"), "FSR 3.1 or XeSS", (), (), "Horizon-Zero-Dawn-Remastered"),
    "1771300": _k("Kingdom Come: Deliverance II", "kingdomcome.exe", "Bin/Win64MasterMasterSteamPGO", "dx12",
                  ("dxgi",), "XeSS or FSR 3.1", ("upscaler",), ("HDR with XeSS frame generation may need "
                                                               "r_HDRPipeline=2 in the game's console.",),
                  "Kingdom-Come-Deliverance-II", conf="M"),
    "1817070": _k("Marvel's Spider-Man Remastered", "spider-man.exe", ".", "dx12", ("dxgi",), "FSR 3.1 or XeSS",
                  (), (), "Marvels-Spider‐Man-Remastered"),
    "1817190": _k("Marvel's Spider-Man: Miles Morales", "milesmorales.exe", ".", "dx12", ("dxgi",),
                  "FSR 3.1 or XeSS", (), (), "Marvels-Spider‐Man-Miles-Morales"),
    "2651280": _k("Marvel's Spider-Man 2", "spider-man2.exe", ".", "dx12", ("dxgi",), "FSR 3.1 or XeSS", ("dlssg",),
                  (), "Marvels-Spider‐Man-2", conf="M"),
    "1449560": _k("Metro Exodus Enhanced Edition", "metroexodus.exe", ".", "dx12", ("dxgi",), "DLSS", (),
                  ("Only the Enhanced Edition: the standard edition has DLSS 1, which OptiScaler cannot replace.",),
                  "Metro-Exodus-Enhanced-Edition", conf="M"),
    "275850": _k("No Man's Sky", "nms.exe", "Binaries", "vulkan", ("dbghelp", "dxgi"), "XeSS", (),
                 ("Online, but without anti-cheat files.",), "No-Man's-Sky"),
    "1895880": _k("Ratchet & Clank: Rift Apart", "riftapart.exe", ".", "dx12", ("dxgi",), "FSR 3.1 or XeSS", (), (),
                  "Ratchet-&-Clank-Rift-Apart"),
    "1649240": _k("Returnal", "returnal-win64-shipping.exe", "Returnal/Binaries/Win64", "dx12", ("dxgi",),
                  "DLSS or XeSS", (), ("A Streamline 1 game; FSR 2 in the game is not an input.",), "Returnal",
                  conf="M"),
    "750920": _k("Shadow of the Tomb Raider", "sottr.exe", ".", "dx12", ("dxgi",), "XeSS", (),
                 ("Coloured specks: turn Screen Effects off in the game.",), "Shadow-of-the-Tomb-Raider", gc=False),
    "3489700": _k("Stellar Blade", "sb-win64-shipping.exe", "SB/Binaries/Win64", "dx12", ("dxgi",), "FSR 3.1",
                  ("dlssg",), ("The first start may crash.",), "Stellar-Blade", conf="M"),
    "1888930": _k("The Last of Us Part I", ("tlou-i.exe", "tlou-i-l.exe"), ".", "dx12", ("dxgi",), "FSR 3.1",
                  ("fsrfg",), ("Turn Fullscreen Effects off in the game.",), "The-Last-of-Us-Part-I"),
    "2531310": _k("The Last of Us Part II Remastered", ("tlou-ii.exe", "tlou-ii-l.exe"), ".", "dx12", ("dxgi",),
                  "FSR 3.1 or XeSS", ("dlssg",), (), "The-Last-of-Us-Part-II-Remastered", conf="M"),
    "2623190": _k("The Elder Scrolls IV: Oblivion Remastered", "oblivionremastered-win64-shipping.exe",
                  "OblivionRemastered/Binaries/Win64", "dx12", ("dxgi",), "XeSS or DLSS", (),
                  ("FSR 3.1 as the input needs Streamline spoofing off in OptiScaler.ini.",),
                  "The-Elder-Scrolls-IV-Oblivion-Remastered", gc=False, conf="M"),
    "2515020": _k("Final Fantasy XVI", "ffxvi.exe", ".", "dx12", ("dxgi",), "XeSS or FSR 3.1", ("dlssg",),
                  ("Turn the game's V-Sync off before its DLSS frame generation.",), "FINAL-FANTASY-XVI", gc=False,
                  conf="M"),
    "934700": _k("Dead Island 2", "deadisland-win64-shipping.exe", "DeadIsland/Binaries/Win64", "dx12", ("dxgi",),
                 "FSR 2", ("upscaler",), ("Use a render scale of at least 1.01.",), "Dead-Island-2", conf="M"),
    "835960": _k("The Talos Principle 2", "talos2-win64-shipping.exe", "Talos2/Binaries/Win64", "dx12", ("dxgi",),
                 "FSR 3 or XeSS", (), ("XeSS may need auto exposure on in OptiScaler's menu.",),
                 "The-Talos-Principle-2"),
    "1544020": _k("The Callisto Protocol", "thecallistoprotocol-win64-shipping.exe",
                  "TheCallistoProtocol/Binaries/Win64", "dx12", ("dxgi",), "FSR 2", (),
                  ("Use a render scale of at least 1.01.",), "The-Callisto-Protocol", conf="M"),
    # documented, but a poorer fit here
    "1659420": _k("UNCHARTED: Legacy of Thieves Collection", ("u4.exe", "tll.exe"), ".", "dx12", ("dxgi",),
                  "DLSS or FSR 2", (), (), "UNCHARTED-Legacy-of-Thieves-Collection", conf="M", fit="poor"),
    "1845910": _k("Dragon Age: The Veilguard", "dragon age the veilguard.exe", ".", "dx12", ("dxgi",), "XeSS", (),
                  ("Ray tracing with the GPU spoof crashes the game.",), "Dragon-Age-The-Veilguard", conf="M",
                  fit="poor"),
    "1088850": _k("Marvel's Guardians of the Galaxy", "gotg.exe", None, "dx12", ("version",), "DLSS", (),
                  ("OptiScaler's HUD fix does not work here.",), "Guardians-of-the-Galaxy", conf="M", fit="poor"),
    "391220": _k("Rise of the Tomb Raider", "rottr.exe", ".", "dx12", ("dxgi",), "DLSS", (), (),
                 "Rise-of-the-Tomb-Raider", conf="M", fit="poor"),
    "1551360": _k("Forza Horizon 5", "forzahorizon5.exe", ".", "dx12", ("dxgi",), "DLSS or XeSS", (),
                  ("Online game: play it offline with OptiScaler.",), "Forza-Horizon-5", conf="M", fit="poor"),
}

# Not offered: the wiki's only setup needs another mod or setting OXP3 Deck does not set up. appid -> (name, what it
# needs).
NOT_OFFERED = {
    "782330": ("DOOM Eternal", "OptiPatcher on Intel GPUs"),
    "2677660": ("Indiana Jones and the Great Circle", "Ultimate ASI Loader"),
    "1203620": ("Enshrouded", "a Vulkan low-latency proxy on Linux"),
    "2246340": ("Monster Hunter Wilds", "REFramework"),
    "2054970": ("Dragon's Dogma 2", "REFramework"),
    "2050650": ("Resident Evil 4", "REFramework"),
    "883710": ("Resident Evil 2", "REFramework"),
    "952060": ("Resident Evil 3", "REFramework"),
    "418370": ("Resident Evil 7", "REFramework"),
    "1196590": ("Resident Evil Village", "REFramework"),
    "601150": ("Devil May Cry 5", "REFramework"),
    "2161700": ("Persona 3 Reload", "another mod"),
    "2679460": ("Metaphor: ReFantazio", "another mod"),
    "1462040": ("Final Fantasy VII Remake Intergrade", "the Luma mod"),
    "1245620": ("ELDEN RING", "the ERSS-FG mod"),
    # DLSS is the game's only working input, and on Intel it shows only with OptiPatcher or the GPU spoof, which
    # OXP3 Deck keeps off (Arc artifacts, libxess on DP4a): with neither, OptiScaler gets no input.
    "1623730": ("Palworld", "OptiPatcher or the GPU spoof"),
    "1139900": ("Ghostrunner", "OptiPatcher or the GPU spoof"),
    "2457220": ("Avowed", "OptiPatcher or the GPU spoof"),
    "1774580": ("STAR WARS Jedi: Survivor", "OptiPatcher or the GPU spoof"),
}

# Online games: OptiScaler's guide says not to use it with them; anti-cheat on the server leaves no files. Appids
# from memory where marked in DESIGN.md (check on SteamDB).
ONLINE = {
    "730": "Counter-Strike 2", "570": "Dota 2", "440": "Team Fortress 2", "1422450": "Deadlock",
    "2694490": "Path of Exile 2", "238960": "Path of Exile", "3240220": "Grand Theft Auto V Enhanced",
    "271590": "Grand Theft Auto V Legacy", "2344520": "Diablo IV",
    # server-side anti-cheat only (no files to find); appids from memory
    "1938090": "Call of Duty", "2357570": "Overwatch 2", "2767030": "Marvel Rivals", "230410": "Warframe",
}

# ---- anti-cheat file markers (lower case), searched optiscaler.SCAN_DEPTH levels under the install folder ----------

ANTICHEAT_DIRS = {"easyanticheat": "EasyAntiCheat", "battleye": "BattlEye", "anticheatexpert": "ACE",
                  "gameguard": "nProtect GameGuard", "xigncode": "XIGNCODE3"}
ANTICHEAT_FILES = {"easyanticheat*": "EasyAntiCheat", "start_protected_game.exe": "EasyAntiCheat",
                   "eaanticheat*": "EA AntiCheat", "*_be.exe": "BattlEye", "beclient*.dll": "BattlEye",
                   "beservice*.exe": "BattlEye", "ace-setup64.exe": "ACE", "ace-service64.exe": "ACE",
                   "mhypbase.dll": "HoYoverse's anti-cheat", "hoyokprotect.sys": "HoYoverse's anti-cheat",
                   "x3.xem": "XIGNCODE3", "pbsvc.exe": "PunkBuster", "vgk.sys": "Riot Vanguard"}

# ---- finding the exe -----------------------------------------------------------------------------------------------

# Not the game: uninstallers, crash reporters, set-ups, launchers, anti-cheat, browsers, helpers, editors, servers,
# tools, benchmarks and settings apps (CD MAIN_EXE_SKIP's
# idea and OptiScaler's Config.h ProcessExclusionList, written here).
SKIP_EXE = re.compile(r"unins|crash|setup|redist|dxsetup|launcher|easyanticheat|^eac|battleye|_be$|prereq|^cef|"
                      r"cefview|cefsharp|helper|report|bugsplat|installer|^ace-|pspcsdk|^edcef|steamerror|^dotnet|"
                      r"^python|^7z|^vc_|^ue4|^ue5|^dxwebsetup|^activation|^touchup|^cleanup|editor|server|tool|benchmark|"
                      r"config|settings")
SKIP_DIRS = {"_commonredist", "__installer", "redist", "directx", "support", "engine", "optiscaler",
             ".oxp3deck-optiscaler", "installers", "_redist", "vcredist", "dotnet"}
MAX_DEPTH = 6
MAX_EXE_DEPTH = 5
LARGE_SHARE = 4


def _parts(rel: str) -> list[str]:
    return rel.split("/") if rel else []


def _skipped_dir(rel_dir: str) -> bool:
    return any(p.lower() in SKIP_DIRS for p in _parts(rel_dir))


def exes_of(files: list[tuple[str, int]]) -> list[tuple[str, str, int]]:
    """(rel_dir, name, size) of each .exe that could be the game (not in a skipped folder, not a helper's name)."""
    out = []
    for rel, size in files:
        d, _, n = rel.rpartition("/")
        low = n.lower()
        if not low.endswith(".exe") or len(_parts(d)) > MAX_EXE_DEPTH or _skipped_dir(d):
            continue
        if SKIP_EXE.search(low[:-4]):
            continue
        out.append((d, n, size))
    return out


def _folder_rank(rel_dir: str) -> int:
    low = [p.lower() for p in _parts(rel_dir)]
    if any("dx12" in p for p in low):
        return 2
    if low and low[-1] in ("x64", "win64", "bin64", "x86_64"):
        return 1
    return 0


def pick_exe(files: list[tuple[str, int]], dirs: set[str]) -> tuple[str, str, str] | None:
    """(rel_dir, exe name, how) of the game's exe from a listing of its install folder: files [(rel, size)], dirs
    {rel lower}. how: "unreal" (…/Binaries/Win64/*-Win64-Shipping.exe, never under Engine/), "unity" (<Name>.exe
    next to <Name>_Data/), "largest" (the shallowest exe at least a quarter the size of the largest, then the larger;
    among exes of the same name a dx12 / x64 folder first)."""
    cands = exes_of(files)
    if not cands:
        return None
    unreal = [c for c in cands if re.search(r"-win(64|gdk)-shipping\.exe$", c[1].lower())
              and [p.lower() for p in _parts(c[0])][-2:] in (["binaries", "win64"], ["binaries", "wingdk"])]
    if unreal:
        c = max(unreal, key=lambda c: (c[0].lower().endswith("win64"), c[2]))
        return c[0], c[1], "unreal"
    binaries = [c for c in cands if [p.lower() for p in _parts(c[0])][-2:] == ["binaries", "win64"]]
    if binaries:
        c = max(binaries, key=lambda c: c[2])
        return c[0], c[1], "unreal"
    unity = [c for c in cands if (f"{c[0]}/{c[1][:-4]}_data" if c[0] else f"{c[1][:-4]}_data").lower() in dirs]
    if unity:
        c = max(unity, key=lambda c: c[2])
        return c[0], c[1], "unity"
    best: dict[str, tuple[str, str, int]] = {}
    for c in cands:
        k = c[1].lower()
        if k not in best or (_folder_rank(c[0]), c[2]) > (_folder_rank(best[k][0]), best[k][2]):
            best[k] = c
    # The shallowest of the exes at least a quarter the size of the largest (a tool deeper down is not the game;
    # a tiny root stub that starts the real exe is), then the largest.
    top = max(c[2] for c in best.values())
    big = [c for c in best.values() if c[2] * LARGE_SHARE >= top]
    c = max(big, key=lambda c: (-len(_parts(c[0])), c[2], _folder_rank(c[0])))
    return c[0], c[1], "largest"


def find_named(files: list[tuple[str, int]], names: tuple[str, ...], hint: str | None) -> tuple[str, str] | None:
    """(rel_dir, name) of a known exe: in the hinted folder first (any case), else the shallowest copy outside
    skipped folders."""
    want = {n.lower() for n in names}
    hits = []
    for rel, _size in files:
        d, _, n = rel.rpartition("/")
        if n.lower() in want and not _skipped_dir(d):
            hits.append((d, n))
    if not hits:
        return None
    h = "" if hint in (None, ".") else hint.lower()
    for d, n in hits:
        if d.lower() == h:
            return d, n
    return min(hits, key=lambda x: (len(_parts(x[0])), -_folder_rank(x[0]), x[0]))


# ---- the graphics API ----------------------------------------------------------------------------------------------

DX12_LIBS = ("d3d12core.dll", "amd_fidelityfx_dx12.dll", "amd_fidelityfx_upscaler_dx12.dll",
             "amd_fidelityfx_loader_dx12.dll", "ffx_fsr2_api_dx12_x64.dll", "sl.interposer.dll", "libxess_fg.dll")
VK_LIBS = ("amd_fidelityfx_vk.dll", "ffx_fsr2_api_vk_x64.dll")
DX11_LIBS = ("ffx_fsr2_api_dx11_x64.dll", "libxess_dx11.dll")
UPSCALER_HINTS = re.compile(r"^(nvngx_dlss\.dll|sl\.interposer\.dll|libxess.*\.dll|amd_fidelityfx_.*\.dll|"
                            r"ffx_fsr[23].*\.dll)$")
API_DLLS = (b"d3d12.dll", b"d3d11.dll", b"vulkan-1.dll", b"d3d9.dll", b"opengl32.dll")
API_NAMES = {"dx12": "DirectX 12", "dx11": "DirectX 11", "vulkan": "Vulkan"}


def lib_names(files: list[tuple[str, int]]) -> set[str]:
    """Lower-case names of the files in the listing, outside OptiScaler's and OXP3 Deck's own folders."""
    out = set()
    for rel, _s in files:
        parts = [p.lower() for p in _parts(rel)]
        if any(p in ("optiscaler", ".oxp3deck-optiscaler") for p in parts[:-1]):
            continue
        out.add(parts[-1])
    return out


def has_upscaler(names: set[str]) -> bool:
    return any(UPSCALER_HINTS.match(n) for n in names)


def decide_api(exe_dir: str, exe: str, names: set[str], imports: list[str] | None,
               mentioned: set[bytes] | None = None) -> tuple[str | None, str]:
    """(api, why) from the exe's folder and name, the libraries the game ships and the DLLs the exe imports (or,
    failing those, names it mentions). api None: none of DirectX 11, DirectX 12 or Vulkan; why says what was found.
    A hit only means the game can use that API: Unreal and other engines carry DirectX 11 and 12."""
    low_dir = exe_dir.lower()
    low = exe.lower()[:-4] if exe.lower().endswith(".exe") else exe.lower()
    if low.endswith("_dx11") or low.endswith("dx11"):
        return "dx11", f"the exe's name ({exe})"
    if "dx12" in low or "d3d12" in low:
        return "dx12", f"the exe's name ({exe})"
    if low.endswith("vk") or low.endswith("_vulkan"):
        return "vulkan", f"the exe's name ({exe})"
    if any("dx12" in p for p in low_dir.split("/")):
        return "dx12", f"the exe's folder ({exe_dir})"
    imp = set(imports or ())
    said = {m.decode() for m in (mentioned or set())}
    dx12_lib = next((n for n in DX12_LIBS if n in names), None)
    vk_lib = next((n for n in VK_LIBS if n in names), None)
    dx11_lib = next((n for n in DX11_LIBS if n in names), None)
    if "d3d12.dll" in imp:
        return "dx12", "the exe loads d3d12.dll"
    if dx12_lib:
        return "dx12", f"the game ships {dx12_lib}"
    if "vulkan-1.dll" in imp and "d3d11.dll" not in imp:
        return "vulkan", "the exe loads vulkan-1.dll"
    if vk_lib and "d3d11.dll" not in imp:
        return "vulkan", f"the game ships {vk_lib}"
    if "d3d12.dll" in said:
        return "dx12", "the exe names d3d12.dll"
    if "d3d11.dll" in imp or dx11_lib:
        return "dx11", "the exe loads d3d11.dll" if "d3d11.dll" in imp else f"the game ships {dx11_lib}"
    if "vulkan-1.dll" in said and "d3d11.dll" not in said:
        return "vulkan", "the exe names vulkan-1.dll"
    if "d3d11.dll" in said:
        return "dx11", "the exe names d3d11.dll"
    if "d3d9.dll" in imp or "d3d9.dll" in said:
        return None, "DirectX 9"
    if "opengl32.dll" in imp or "opengl32.dll" in said:
        return None, "OpenGL"
    return None, ""


def pick_proxy(api: str, names: set[str], table: tuple[str, ...] | None = None,
               imports: list[str] | None = None) -> tuple[str | None, list[str]]:
    """(proxy name, the names already taken) for the exe folder's file names (lower case): the table's names, else
    the API's, in order; the first one the folder does not have, preferring one the exe imports (Windows then loads
    it for sure). Never d3d12 for a game that is not DirectX 12. None when every name is taken."""
    cands = [p for p in (table or PROXIES_BY_API.get(api, ())) if p in ALL_PROXIES and (p != "d3d12" or api == "dx12")]
    taken = [p for p in cands if f"{p}.dll" in names]
    free = [p for p in cands if p not in taken]
    if not free:
        return None, taken
    if not table and imports:
        imported = [p for p in free if f"{p}.dll" in imports]
        if imported:
            return imported[0], taken
    return free[0], taken


# ---- which frame-generation inputs the game's own files allow (DESIGN.md "Frame-generation inputs from the files") --

# The automatic default, most preferred first: the game's own XeSS frame generation (on Intel its output is XeFG
# anyway, and OptiScaler gets the game's HUD-less image and XeLL), then its FSR 3.1 frame generation and its DLSS
# frame generation (both native inputs with the HUD-less image, OptiScaler's wiki: "Always best to use native FG
# inputs"), then OptiFG ("upscaler"), which works without any game frame generation but needs the HUD fix.
FG_ORDER = ("xefg", "fsrfg", "dlssg", "upscaler")
# The files that show each input (lower case). FSR: FidelityFX 3.1.4+ ships frame generation as its own DLL;
# 3.1.0-3.1.3's amd_fidelityfx_dx12.dll holds upscaling and frame generation together (OptiScaler DllNames.h
# ffxDx12 / ffxDx12FG; OptiScaler.ini FGOutput fsrfg). DLSS: Streamline's sl.interposer.dll plus its DLSS-G plugin
# (sl.dlss_g.dll) or NVIDIA's nvngx_dlssg.dll.
FG_FILES = {"libxess_fg.dll": "xefg", "amd_fidelityfx_framegeneration_dx12.dll": "fsrfg",
            "amd_fidelityfx_dx12.dll": "fsrfg", "sl.interposer.dll": "dlssg", "sl.dlss_g.dll": "dlssg",
            "nvngx_dlssg.dll": "dlssg"}
FG_LABELS = {"xefg": "XeSS frame generation", "fsrfg": "FSR frame generation", "dlssg": "DLSS frame generation",
             "upscaler": "OptiFG (OptiScaler's own frame generation)"}
# OptiScaler's "DLSSG via SL" input needs Streamline 2 or newer (wiki Frame-Generation-Options: "Only supports DX12
# and Streamline 2+ games", "It's not possible to update SL1 games to SL2"; Config.cpp FGCanFollowGame:
# streamlineVersion.major >= 2, the major of sl.interposer.dll's file version, Streamline_Hooks.cpp).
SL_MIN_MAJOR = 2


def _major(v: str | None) -> int | None:
    try:
        return int(str(v).split(".")[0]) if v else None
    except ValueError:
        return None


def fg_caps(found: dict[str, dict]) -> dict:
    """Pure: the frame-generation inputs a DirectX 12 game's files allow. found: {lower file name: {rel, version}}
    (version None when unread). {inputs: in FG_ORDER, upscaler always; why: {input: reason}; line: one short line
    (<= 80 characters) saying which and why; sl1: Streamline 1 found; files: [{name, rel, version, input}]}."""
    why: dict[str, str] = {}
    ok: list[str] = []

    def has(*names):
        return next((n for n in names if n in found), None)

    def ver(n):
        v = found[n].get("version")
        return f"{n} {v}" if v else n

    x = has("libxess_fg.dll")
    if x:
        ok.append("xefg")
        why["xefg"] = f"{ver(x)}: the game has XeSS frame generation."
    else:
        why["xefg"] = "No libxess_fg.dll: the game has no XeSS frame generation."
    f = has("amd_fidelityfx_framegeneration_dx12.dll", "amd_fidelityfx_dx12.dll")
    if f:
        ok.append("fsrfg")
        why["fsrfg"] = f"{ver(f)}: the game has FSR 3.1 frame generation (pick it in the game, if it offers it)."
    else:
        why["fsrfg"] = "No amd_fidelityfx_framegeneration_dx12.dll or amd_fidelityfx_dx12.dll: the game has no " \
                       "FSR 3.1 frame generation."
    sl = found.get("sl.interposer.dll")
    g = has("sl.dlss_g.dll", "nvngx_dlssg.dll")
    major = _major(sl.get("version")) if sl else None
    sl1 = sl is not None and major is not None and major < SL_MIN_MAJOR
    if sl is None:
        why["dlssg"] = "No sl.interposer.dll: the game has no Streamline DLSS frame generation."
    elif sl1:
        why["dlssg"] = f"Streamline {major} ({ver('sl.interposer.dll')}): OptiScaler's DLSS frame generation input " \
                       "needs Streamline 2 or newer, so it isn't possible here."
    elif not g:
        why["dlssg"] = f"{ver('sl.interposer.dll')} without sl.dlss_g.dll or nvngx_dlssg.dll: the game has no DLSS " \
                       "frame generation."
    else:
        ok.append("dlssg")
        why["dlssg"] = f"{ver('sl.interposer.dll')} and {ver(g)}: Streamline 2 or newer with DLSS frame generation." \
            if major is not None else f"sl.interposer.dll (version unread) and {ver(g)}: DLSS frame generation."
    ok.append("upscaler")
    why["upscaler"] = "Always possible in DirectX 12: OptiScaler makes the frames from the upscaler's input."
    inputs = [i for i in FG_ORDER if i in ok]
    if sl1:
        line = "Streamline 1: DLSS frame generation isn't possible here."
    elif inputs == ["upscaler"]:
        line = "No frame generation in the game's files: OptiScaler makes its own."
    else:
        names = [{"xefg": "XeSS", "fsrfg": "FSR", "dlssg": "DLSS"}[i] for i in inputs if i != "upscaler"]
        line = f"The game's files have {' and '.join(names) if len(names) < 3 else 'XeSS, FSR and DLSS'} frame " \
               "generation."
    files = [{"name": n, "rel": found[n].get("rel"), "version": found[n].get("version"), "input": FG_FILES[n]}
             for n in FG_FILES if n in found]
    return {"inputs": inputs, "why": why, "line": line, "sl1": sl1, "files": files}


def fg_narrow(inputs: tuple[str, ...], pinned: str, caps: dict | None, generic: bool) -> tuple[tuple, str]:
    """Pure: (the inputs offered, the default input) once the files are known. A known or tested setup keeps its
    documented inputs and order, minus the ones the files rule out; a generic setup offers what the files allow, in
    FG_ORDER. The default: the pinned input when still offered (a generic setup: the first in FG_ORDER), else the
    first offered in FG_ORDER. caps None (the files could not be searched): unchanged."""
    if caps is None or not inputs:
        return tuple(inputs), pinned
    allowed = set(caps["inputs"])
    if generic:
        out = tuple(i for i in FG_ORDER if i in allowed and i in inputs)
    else:
        out = tuple(i for i in inputs if i in allowed)
    if not out:
        out = ("upscaler",)
    if pinned in out and not generic:
        return out, pinned
    return out, next(i for i in FG_ORDER if i in out)
