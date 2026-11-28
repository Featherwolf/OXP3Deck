// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Reads one game's files for XeSS (SPEC §5.3 steam.gamefiles, read-only): the DLLs in its folder
 * and their versions, the logs the shim left in its prefix, the prefix's driver store, and
 * anti-cheat files. `find` is 1/s and one at a time, so every read goes through one queue. Kept per
 * game until it runs again or its build changes; never read while it runs.
 */
import { host, type AppDetails } from "@bathysphere/sdk";
import { CachedMap } from "../core/cache";
import { hasCode } from "../core/errors";
import { serial } from "../core/queue";
import { redraw } from "../core/redraw";
import { FFX_DLLS, isSystemProton, lastMatch, XESS_DLLS, xefgCheck, type Dll, type GameFacts, type LastRun } from "./advice";
import { antiCheatOf, ANTICHEAT_GLOBS } from "./known";

const oneAtATime = serial(1000);
const LOG_TAIL = 262144;

export const details = new CachedMap<number, AppDetails>((appid) => host.steam.apps.details(appid), 60_000);

async function statMs(appid: number, path: string): Promise<number | null> {
  try {
    return (await host.steam.gamefiles.stat(appid, "prefix", path)).modifiedMs;
  } catch {
    return null;
  }
}

async function tail(appid: number, path: string): Promise<string | null> {
  try {
    return (await host.steam.gamefiles.read(appid, "prefix", path, { fromEnd: true, maxBytes: LOG_TAIL })).data;
  } catch {
    return null;
  }
}

/** What the shim and the driver left in drive_c (games.py last_run). */
async function lastRun(appid: number): Promise<LastRun> {
  const p = (f: string) => `drive_c/${f}`;
  const [traceAt, xellAt, xefgAt, stubAt, failedAt, canaryAt] = await Promise.all(
    ["igdext_trace.log", "igdext_xell.log", "igdext_xefg.log", "igcl_stub.log", "igdext_kernels/compile_failed.txt", "igdext_kernels/anv_canary"].map((f) => statMs(appid, p(f))),
  );
  const trace = traceAt !== null ? await tail(appid, p("igdext_trace.log")) : null;
  const xell = xellAt !== null ? await tail(appid, p("igdext_xell.log")) : null;
  const xefg = xefgAt !== null ? await tail(appid, p("igdext_xefg.log")) : null;
  const logs = [trace, xell].filter((t): t is string => t !== null);
  const times = [traceAt, xellAt, xefgAt, failedAt, canaryAt].filter((t): t is number => t !== null);
  const logTimes = [traceAt, xellAt, xefgAt, stubAt].filter((t): t is number => t !== null);
  return {
    trace: trace !== null,
    fallback: trace !== null ? lastMatch(trace, /fallback:\s*([^\r\n]{1,200})/i) : null,
    compileFailed: failedAt !== null,
    canary: canaryAt !== null,
    xellUnsupported: logs.length ? logs.some((t) => /unsupported device/i.test(t)) : null,
    xellBuiltin: xell !== null ? /using built-in context/i.test(xell) : null,
    fgFullscreen: xefg !== null ? /not supported in fullscreen/i.test(xefg) : null,
    xefg: xefg !== null ? xefgCheck(xefg, xefgAt ?? null) : null,
    loggedAt: times.length ? Math.max(...times) : null,
    logAt: logTimes.length ? Math.max(...logTimes) : null,
  };
}

async function readFacts(appid: number): Promise<GameFacts> {
  const dc = details.get(appid);
  await dc.load();
  const d = dc.value;
  if (!d) throw dc.error ?? new Error(`no details for app ${appid}`);
  const facts: GameFacts = {
    appid,
    installed: d.installed,
    dlls: [],
    leftovers: [],
    truncated: false,
    hasPrefix: false,
    lastRun: null,
    driverStoreCapital: false,
    compatTool: d.compatTool ?? null,
    systemProton: isSystemProton(d.compatTool?.name),
    antiCheat: null,
  };
  if (d.isShortcut) return facts;
  if (d.installed) {
    const found = await oneAtATime(() => host.steam.gamefiles.find(appid, "install", ["libxess*.dll", "libxell.dll", "amd_fidelityfx_*.dll", "*.xmx-orig"], { depth: 10, max: 20000 }));
    facts.truncated = found.truncated;
    const wanted = new Set([...XESS_DLLS, ...FFX_DLLS]);
    for (const f of found.files) {
      const name = f.path.split("/").pop()!.toLowerCase();
      if (name.endsWith(".xmx-orig")) {
        if (wanted.has(name.slice(0, -".xmx-orig".length))) facts.leftovers.push(f.path);
        continue;
      }
      if (!wanted.has(name)) continue;
      let version: string | null = null;
      try {
        version = (await host.steam.gamefiles.fileVersion(appid, "install", f.path))?.fileVersion ?? null;
      } catch {
        version = null;
      }
      const dll: Dll = { name, path: f.path, version, kind: XESS_DLLS.includes(name) ? "xess" : "ffx" };
      facts.dlls.push(dll);
    }
    const ac = await oneAtATime(() => host.steam.gamefiles.find(appid, "install", Object.keys(ANTICHEAT_GLOBS), { depth: 6, max: 20000 }));
    const hit = ac.files[0];
    facts.antiCheat = hit ? antiCheatOf(hit.path.split("/").pop()!) : null;
  }
  try {
    facts.hasPrefix = (await host.steam.gamefiles.stat(appid, "prefix", "drive_c")).dir;
  } catch (e) {
    if (!hasCode(e, "ENOENT", "EPERM", "ENOTSUP")) throw e;
  }
  if (facts.hasPrefix) {
    facts.lastRun = await lastRun(appid);
    try {
      facts.driverStoreCapital = (await host.steam.gamefiles.stat(appid, "prefix", "drive_c/windows/system32/DriverStore")).dir;
    } catch {
      facts.driverStoreCapital = false;
    }
  }
  return facts;
}

export const facts = new CachedMap<number, GameFacts>(readFacts, Infinity);

/** A game ran or was updated: read it again next time. */
export function forgetFacts(appid: number): void {
  facts.invalidate(appid);
  details.invalidate(appid);
}

/**
 * Starts reading a game's facts in the background (the section shows "Checking…" meanwhile), once;
 * `again` reads them anew (the user's "Read the game's files again", also after a failed read).
 */
export function loadFacts(appid: number, again = false): void {
  const c = facts.get(appid);
  if (again) forgetFacts(appid);
  if (again || (c.value === undefined && c.error === undefined)) void c.load().then(redraw);
}
