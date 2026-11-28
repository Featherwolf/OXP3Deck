// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * One game as xess-xmx-linux sees it (pure; original games.py): its XeSS and FidelityFX DLLs and
 * their versions, what the shim and the driver left in the prefix at the last run, its Proton, and
 * short advice from the package's docs. The reads that feed this are in files.ts.
 */
import { knownIssues } from "./known";

/** The four libraries XESS=latest swaps (launch-options.md), and FSR 3.1+'s. */
export const XESS_DLLS = ["libxess.dll", "libxess_dx11.dll", "libxess_fg.dll", "libxell.dll"];
export const FFX_DLLS = ["amd_fidelityfx_dx12.dll", "amd_fidelityfx_loader_dx12.dll", "amd_fidelityfx_upscaler_dx12.dll", "amd_fidelityfx_framegeneration_dx12.dll"];

export interface Dll {
  name: string;
  path: string;
  version: string | null;
  kind: "xess" | "ffx";
}

export interface XefgCheck {
  loggedAt: number | null;
  refused: boolean;
  reason: "latency_reduction_off" | "refused" | null;
  code: number | null;
  call: string | null;
  lines: string[];
}

export interface LastRun {
  trace: boolean;
  fallback: string | null;
  compileFailed: boolean;
  canary: boolean;
  xellUnsupported: boolean | null;
  xellBuiltin: boolean | null;
  fgFullscreen: boolean | null;
  xefg: XefgCheck | null;
  /** Newest time any of these files changed (Unix ms). */
  loggedAt: number | null;
  /** Newest time a log only XESS_LOG writes changed (Unix ms): one-run logging ends after it. */
  logAt: number | null;
}

export interface GameFacts {
  appid: number;
  installed: boolean;
  dlls: Dll[];
  leftovers: string[];
  truncated: boolean;
  hasPrefix: boolean;
  lastRun: LastRun | null;
  /** system32 has a capitalised DriverStore next to install.sh's lowercase one (issue #46). */
  driverStoreCapital: boolean;
  compatTool: { name: string; perGame: boolean } | null;
  /** A distribution's Proton package (isSystemProton): it cannot carry the add-on or its hook. */
  systemProton: boolean;
  antiCheat: string | null;
}

/** "2.0.2.68" → [2, 0, 2, 68]; null when not a version. */
export function versionTuple(v: string | null): number[] | null {
  if (!v || !/^\d+(\.\d+){0,3}$/.test(v)) return null;
  return v.split(".").map(Number);
}

const less = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};

/** The oldest version of `name` among the game's copies. */
export function versionOf(dlls: readonly Dll[], name: string): { text: string; tuple: number[] } | null {
  let best: { text: string; tuple: number[] } | null = null;
  for (const d of dlls) {
    if (d.name.toLowerCase() !== name) continue;
    const t = versionTuple(d.version);
    if (t && (!best || less(t, best.tuple))) best = { text: d.version!, tuple: t };
  }
  return best;
}

/**
 * A distribution's Proton package. The original decided by the tool's folder
 * (/usr/share/steam/compatibilitytools.d); steam.apps.details gives only the tool's internal name,
 * so this matches the names CachyOS's packages register (proton-cachyos, proton-cachyos-slr,
 * proton-cachyos-native). Builds a user installs (ProtonUp-Qt's "proton-cachyos-10.0-…") carry a
 * version in the name and are not system Protons: their prefix can get the add-on.
 */
export const isSystemProton = (name: string | undefined): boolean => !!name && /^proton[-_]cachyos(?:[-_](?:slr|native))?$/i.test(name);

// ---- logs -------------------------------------------------------------------------------------

/** The last match (group 1) of `re` in `text`, or null. */
export function lastMatch(text: string, re: RegExp): string | null {
  let last: string | null = null;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  for (const m of text.matchAll(g)) last = (m[1] ?? m[0]).trim();
  return last;
}

const XEFG_SET = /xefgSwapChainSetEnabled\(\s*1\s*\)\s*->\s*(-?\d+)/;
const XEFG_CALL = /\b(xefg\w+)\([^)\r\n]{0,200}\)\s*->\s*(-\d+)/;
const XEFG_LATENCY = /latency reduction is not enabled/i;
export const XEFG_LATENCY_CODE = -15;

/** Whether XeSS frame generation refused to turn on, from the tail of igdext_xefg.log (games.py xefg_check). */
export function xefgCheck(text: string, loggedAt: number | null): XefgCheck {
  const out: XefgCheck = { loggedAt, refused: false, reason: null, code: null, call: null, lines: [] };
  const lines = text.split(/\r?\n/);
  const sets: Array<[number, number]> = [];
  lines.forEach((ln, i) => {
    const m = XEFG_SET.exec(ln);
    if (m) sets.push([i, Number(m[1])]);
  });
  let hit: [number, string, number] | null = null;
  if (sets.length) {
    const [i, code] = sets[sets.length - 1]!;
    if (code < 0) hit = [i, "xefgSwapChainSetEnabled", code];
  } else {
    const calls: Array<[number, string, number]> = [];
    lines.forEach((ln, i) => {
      const m = XEFG_CALL.exec(ln);
      if (m) calls.push([i, m[1]!, Number(m[2])]);
    });
    hit = calls[calls.length - 1] ?? null;
  }
  if (!hit) return out;
  const [i, call, code] = hit;
  const latency = lines.map((ln, j) => (XEFG_LATENCY.test(ln) ? j : -1)).filter((j) => j >= 0);
  const before = latency.filter((j) => j <= i).slice(-1);
  return {
    ...out,
    refused: true,
    code,
    call,
    reason: code === XEFG_LATENCY_CODE && latency.length ? "latency_reduction_off" : "refused",
    lines: [...before.map((j) => lines[j]!), lines[i]!].map((l) => l.trim().slice(0, 200)),
  };
}

// ---- advice -----------------------------------------------------------------------------------

/** The advice lines (games.py _advice), without what Bathysphere cannot see (Proton folders, user.reg). */
export function advice(g: GameFacts, xessInstalled: boolean, fsrOk: boolean): string[] {
  const out: string[] = [];
  if (!xessInstalled) out.push("xess-xmx-linux is not installed: XeSS runs on DP4a (install it from the XeSS tab).");
  const tool = g.compatTool?.name ?? "its Proton";
  const xv = versionOf(g.dlls, "libxess.dll");
  if (xv && less(xv.tuple, [2, 0, 2, 68])) {
    let line = `XeSS ${xv.text} is older than 2.0.2.68: DXVK hides the Intel GPU from it (DP4a, maybe no frame generation). Choose Latest under XeSS version.`;
    if (g.systemProton) line += ` That needs the Proton hook, which ${tool} (a system Proton) does not have.`;
    out.push(line);
  }
  const fv = versionOf(g.dlls, "libxess_fg.dll");
  if (fv && less(fv.tuple, [1, 2])) out.push(`XeSS frame generation ${fv.text} is older than 1.2: the game does not offer it on Intel GPUs. Latest swaps in the SDK's 1.3.1.78 while the game runs.`);
  const lv = versionOf(g.dlls, "libxell.dll");
  const lr = g.lastRun;
  if (lv && lv.tuple[0] === 1 && lv.tuple[1] === 2) {
    let line = `XeLL ${lv.text}: XeLL 1.2 may refuse this GPU (unsupported device), so frame generation can stay off.`;
    if (lr?.xellUnsupported) line += " The last run's log says it did.";
    line += g.systemProton ? ` Latest would swap in XeLL 1.3.2.10, but it needs the Proton hook, which ${tool} does not have: pick GE-Proton or Proton Experimental.` : " Latest swaps in XeLL 1.3.2.10 while the game runs.";
    out.push(line);
  } else if (lr?.xellUnsupported) out.push("XeLL refused this GPU at the last run (unsupported device), so frame generation stayed off.");
  if (lr?.compileFailed) out.push("A kernel failed to compile at the last run: the game falls back to DP4a until a retry (the next launch retries once; after that a game or driver update, or the XeSS repair).");
  if (lr?.fallback) {
    if (lr.fallback.includes("self-test")) out.push("The shim fell back to DP4a: the patched driver was not active in the game (self-test failed). Check the driver status; log out and back in after an install.");
    else if (/unknown intel device/i.test(lr.fallback)) out.push("The shim fell back to DP4a: it does not know this GPU (unknown Intel device id).");
    else out.push(`The shim fell back to DP4a at the last run: ${lr.fallback}`);
  }
  if (g.systemProton) out.push(`${tool} is a system Proton: it cannot carry the XeSS add-on, so XeSS stays on DP4a. Get GE-Proton (the card below).`);
  const names = new Set(g.dlls.map((d) => d.name.toLowerCase()));
  if (FFX_DLLS.some((n) => names.has(n)) && !XESS_DLLS.some((n) => names.has(n))) {
    out.push(`The game has FSR 3.1+ and no XeSS: FSR → XeSS runs its upscaling and frame generation on XeSS.${fsrOk ? "" : " That needs xess-xmx-linux 20261104 or newer."}`);
  }
  if (g.leftovers.length) out.push("A killed XESS=latest run left the game's own libraries renamed (.xmx-orig); the game's next start puts them back.");
  if (!g.hasPrefix) out.push("No Proton prefix yet: the game has not run with Proton (or it runs natively).");
  if (!g.installed) out.push("The game is not installed.");
  else if (!g.dlls.length) out.push("No XeSS or FidelityFX DLL in the game's folder.");
  if (g.truncated) out.push("The game's folder is very large; only part of it was searched.");
  return out;
}

export interface Suggestion {
  key: "XESS" | "FSR";
  value: string;
  why: string;
}

/** Launch options the automatic setup may add (games.py _suggest): never frame generation. */
export function suggest(g: GameFacts, xessInstalled: boolean, fsrOk: boolean): Suggestion[] {
  if (!xessInstalled || g.systemProton) return [];
  const out: Suggestion[] = [];
  const xv = versionOf(g.dlls, "libxess.dll");
  const fv = versionOf(g.dlls, "libxess_fg.dll");
  const lv = versionOf(g.dlls, "libxell.dll");
  let why: string | null = null;
  if (xv && less(xv.tuple, [2, 0, 2, 68])) why = `XeSS ${xv.text} is older than 2.0.2.68, so it would run in the slower mode.`;
  else if (fv && less(fv.tuple, [1, 2])) why = `XeSS frame generation ${fv.text} is older than 1.2, so the game would not offer it.`;
  else if (lv && lv.tuple[0] === 1 && lv.tuple[1] === 2) why = `XeLL ${lv.text} may refuse this GPU, so frame generation could stay off.`;
  if (why) out.push({ key: "XESS", value: "latest", why });
  const names = new Set(g.dlls.map((d) => d.name.toLowerCase()));
  const risky = knownIssues(g.appid).some((i) => i.fsrRisk || i.fgCrash);
  if (FFX_DLLS.some((n) => names.has(n)) && !XESS_DLLS.some((n) => names.has(n)) && fsrOk && !risky) {
    out.push({ key: "FSR", value: "xess", why: "The game has FSR 3.1+ and no XeSS: its FSR runs on XeSS." });
  }
  return out;
}

export interface Check {
  id: string;
  label: string;
  line: string;
  detail: string;
  lines?: string[];
}

/** Rows of what the prefix and the last run show (games.py _checks, without HideWineExports). */
export function checks(g: GameFacts): Check[] {
  const out: Check[] = [];
  if (g.driverStoreCapital) {
    out.push({
      id: "driverstore",
      label: "Second driver store in the prefix",
      line: "XeSS may load the Proton's own file instead of the add-on.",
      detail:
        "This game's prefix has a capitalised system32\\DriverStore folder (proton-cachyos makes one, with a link to its own igdext64.dll) next to the lowercase driverstore that xess-xmx-linux fills. Wine picks the capitalised one, so XeSS loads the stock file: no fast mode, frame generation 2x at most (xess-xmx-linux issue #46). Until a release has the fix: delete pfx/drive_c/windows/system32/DriverStore in this game's prefix while the game is closed, or pick Proton Experimental.",
    });
  }
  const lr = g.lastRun;
  if (lr?.fgFullscreen) {
    out.push({
      id: "fullscreen",
      label: "Last run: exclusive fullscreen",
      line: "Frame generation stays off in exclusive fullscreen: pick borderless.",
      detail: "XeSS frame generation's log says \"Interpolation is not supported in fullscreen mode\": in exclusive fullscreen it shows only the real frames. Choose borderless or windowed in the game's display settings.",
    });
  }
  const xf = lr?.xefg;
  if (xf?.refused) {
    const said = xf.lines.map((l) => `"${l}"`).join(" and ");
    const logging = "The log is written only while Save XeSS logs is on and keeps what the last run wrote, so check its time.";
    out.push(
      xf.reason === "latency_reduction_off"
        ? { id: "fg_refused", label: "Frame generation is refused", line: "Turn on Xe Low Latency in the game's graphics menu.", detail: `The game turned XeSS frame generation on, but it needs Xe Low Latency on as well and refuses every frame without it. Its log (C:\\igdext_xefg.log in the game's prefix) says ${said}: -15 is the refusal. Turn on Xe Low Latency (or Low latency mode) next to frame generation; some games offer it only in DirectX 12. ${logging}`, lines: xf.lines }
        : { id: "fg_refused", label: "Frame generation is refused", line: `XeSS frame generation refused to start (code ${xf.code}).`, detail: `XeSS frame generation's log says ${said}: ${xf.call} failed with code ${xf.code}, so frame generation stays off. Check the game's frame generation and latency settings, and use borderless or windowed mode. ${logging}`, lines: xf.lines },
    );
  }
  return out;
}

/**
 * The last run's row (null when there is no log), in the original's order (GameControls.tsx
 * lastRunLine): a fallback or a failed kernel means the slower mode; the patched driver's canary
 * file means it saw XeSS's self-test, so XeSS ran on the XMX cores; a trace log alone only says the
 * shim loaded.
 */
export function lastRunRow(lr: LastRun | null): { label: string; line: string; bad: boolean } | null {
  if (!lr || lr.loggedAt === null) return null;
  if (lr.fallback) return { label: "Last run: slower mode", line: "XeSS fell back to DP4a.", bad: true };
  if (lr.compileFailed) return { label: "Last run: slower mode", line: "A kernel failed to compile: DP4a until a retry.", bad: true };
  if (lr.canary) return { label: "Last run: fast mode used", line: "XeSS ran on the XMX cores.", bad: false };
  if (lr.trace) return { label: "Last run: no sign of fast mode", line: "The shim loaded, but the driver saw no XeSS self-test.", bad: false };
  return { label: "Last run: no sign of fast mode", line: "The game may not have used XeSS.", bad: false };
}
