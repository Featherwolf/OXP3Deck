// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Per-game tables (pure), each entry with its source, as in the original: known issues
 * (games.py KNOWN_ISSUES), DirectX 12 arguments (src/launchopts.ts DX12_ARGS), online games and
 * anti-cheat markers the automatic setup leaves alone (optigames.py ONLINE, ANTICHEAT_FILES).
 */

export interface KnownIssue {
  id: string;
  /** Frame generation crashes the game: asked before, never added automatically. */
  fgCrash: boolean;
  /** FSR=xess / FSR_FG replace the game's signed FidelityFX DLL. */
  fsrRisk: boolean;
  label: string;
  line: string;
  detail: string;
  source: string;
  /** Keys the automatic setup takes out (known to crash the game) and keys it never adds. */
  autoDrop: string[];
  autoNever: string[];
}

export const KNOWN_ISSUES: Record<number, KnownIssue[]> = {
  2246340: [
    {
      id: "fg_crash",
      fgCrash: true,
      fsrRisk: true,
      label: "Frame generation crashes this game",
      line: "Frame generation crashes the game. Leave it on Game default.",
      detail:
        "Monster Hunter Wilds crashes with XeSS frame generation set in its launch options (owner report, ONEXPLAYER 3, November 2026). The game has no XeSS frame generation of its own (no libxess_fg.dll; its frame generation is DLSS-G or FSR 3.1), so XESS_FG has nothing to act on, and the FSR routes (FSR=xess, FSR_FG=xess) replace Capcom's signed FidelityFX DLL, the crash pattern of xess-xmx-linux issue #42. Use the game's own FSR 3.1 frame generation and leave XeSS frame generation and FSR → XeSS off. XESS=latest also swaps files in this game: if it crashes with it, take that off too.",
      source: "owner report; github.com/HHHHanasak1/xess-xmx-linux/issues/42",
      autoDrop: ["XESS_FG", "FSR", "FSR_FG"],
      autoNever: ["XESS", "FSR"],
    },
  ],
  292030: [
    {
      id: "fg_no_gain",
      fgCrash: false,
      fsrRisk: false,
      label: "XeSS frame generation does not add fps",
      line: "XeSS frame gen added no fps on GE-Proton here. Try Proton Experimental.",
      detail:
        "Tested on the ONEXPLAYER 3 (Arc B390, GE-Proton11-11, xess-xmx-linux 20261104, November 2026): about 50 fps with XeSS frame generation on or off with Intel's newer libraries (frame generation refuses every frame, \"Latency reduction is not enabled\", -15), the game's own libraries and the cross-vendor path. Windows users with Intel GPUs report the same since patch 5.00. It is reported working on SteamOS with the same chip, where Valve's Proton is the main difference, so try Proton Experimental first. XeSS frame generation needs DirectX 12 (-dx12) and borderless to stay on at all. What works: XeSS upscaling on XMX, and the game's FSR frame generation. Leave FSR=xess and FSR_FG off for this game.",
      source: "owner tests with shim logs (igdext_xefg.log, igdext_xell.log), 2026-11-05/06; Intel IGCIT #1572",
      autoDrop: ["FSR", "FSR_FG"],
      autoNever: ["FSR"],
    },
  ],
};

export const knownIssues = (appid: number): KnownIssue[] => KNOWN_ISSUES[appid] ?? [];

/**
 * The DirectX 12 argument per game; add one only with a source. 292030 The Witcher 3 (next-gen):
 * "-dx12" after %command% starts its DirectX 12 renderer (owner report, ONEXPLAYER 3, GE-Proton11-11,
 * November 2026: the XeSS frame generation option stays on only with it).
 */
export const DX12_APPIDS: readonly number[] = [292030];
export const DX12_ARG = "-dx12";

/** Online games: anti-cheat on the server (no files to find), so the automatic setup leaves them alone. */
export const ONLINE: Record<number, string> = {
  730: "Counter-Strike 2",
  570: "Dota 2",
  440: "Team Fortress 2",
  1422450: "Deadlock",
  2694490: "Path of Exile 2",
  238960: "Path of Exile",
  3240220: "Grand Theft Auto V Enhanced",
  271590: "Grand Theft Auto V Legacy",
  2344520: "Diablo IV",
  1938090: "Call of Duty",
  2357570: "Overwatch 2",
  2767030: "Marvel Rivals",
  230410: "Warframe",
};

/**
 * Anti-cheat file names (case-insensitive globs for steam.gamefiles.find, at most 16). The
 * original also matched folder names; the files inside those folders match these globs.
 */
export const ANTICHEAT_GLOBS: Record<string, string> = {
  "easyanticheat*": "EasyAntiCheat",
  "start_protected_game.exe": "EasyAntiCheat",
  "eaanticheat*": "EA AntiCheat",
  "*_be.exe": "BattlEye",
  "beclient*.dll": "BattlEye",
  "beservice*.exe": "BattlEye",
  "ace-setup64.exe": "ACE",
  "ace-service64.exe": "ACE",
  "mhypbase.dll": "HoYoverse's anti-cheat",
  "hoyokprotect.sys": "HoYoverse's anti-cheat",
  "x3.xem": "XIGNCODE3",
  "pbsvc.exe": "PunkBuster",
  "vgk.sys": "Riot Vanguard",
  "gameguard.des": "nProtect GameGuard",
};

/** What an anti-cheat file name is, by the glob it matches. */
export function antiCheatOf(fileName: string): string | null {
  const n = fileName.toLowerCase();
  for (const [glob, what] of Object.entries(ANTICHEAT_GLOBS)) {
    const re = new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    if (re.test(n)) return what;
  }
  return null;
}
