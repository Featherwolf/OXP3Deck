// Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors). See THIRD_PARTY_NOTICES.md.
// Steam client calls, each behind try/catch so a Steam update that renames one turns a feature off instead of
// breaking the panel. Names checked against @decky/ui's typings: Router = CSteamUIStore (MainRunningApp),
// SteamClient.Apps.RegisterForAppDetails / SetAppLaunchOptions, GameSessions.RegisterForAppLifetimeNotifications.
import { Router } from "@decky/ui";
import { useEffect, useState } from "react";

import { remember } from "./util";

export type RunningApp = { appid: string; name: string };

/** A Steam game's appid: a non-Steam shortcut has one of 2^31 or more, and its launch options work differently. */
export const isSteamApp = (appid: string | null | undefined): boolean =>
  !!appid && /^\d+$/.test(appid) && Number(appid) > 0 && Number(appid) < 2 ** 31;

const client = () => (window as any).SteamClient as Window["SteamClient"] | undefined;

export const runningApp = (): RunningApp | null => {
  try {
    const a = Router?.MainRunningApp;
    if (!a) return null;
    // typed number in @decky/ui 4.16 and string in 4.12 (Decky 3.2's copy)
    const appid = String(a.appid);
    return { appid, name: a.display_name || `App ${appid}` };
  } catch {
    return null;
  }
};

/**
 * True while `appid` runs (Router.RunningApps, else the main running app). When Steam cannot tell, true: the callers
 * use it to refuse writing a running game's launch options, so not knowing must not let a write through.
 */
export const isRunning = (appid: string): boolean => {
  try {
    if (runningApp()?.appid === appid) return true;
    const apps = (Router as any)?.RunningApps;
    if (!Array.isArray(apps)) return runningApp() !== null;
    return apps.some((a: any) => String(a?.appid) === appid);
  } catch {
    return true;
  }
};

/** The last game seen running, for the Games tab when none runs now. */
export const lastGame = (): RunningApp | null => {
  try {
    const g = JSON.parse(remember.get("lastGame") ?? "null");
    return g && typeof g.appid === "string" ? { appid: g.appid, name: String(g.name ?? g.appid) } : null;
  } catch {
    return null;
  }
};

// One shared watch of the main running app for every user (the panel, the pages, power_game): Steam's app lifetime
// notifications (Router catches up a moment later, so it is read at once and after 1 s) plus a 3 s check, which also
// sees the focus moving between two running apps. Listeners hear only changes.
type AppListener = (app: RunningApp | null) => void;
const listeners = new Set<AppListener>();
let seen: RunningApp | null = null;
let stopWatch: (() => void) | null = null;

const sameApp = (a: RunningApp | null, b: RunningApp | null) => a?.appid === b?.appid && a?.name === b?.name;

const checkApp = () => {
  const now = runningApp();
  if (sameApp(seen, now)) return;
  seen = now;
  listeners.forEach((f) => { try { f(now); } catch { /* a dead listener */ } });
};

const startWatch = () => {
  seen = runningApp();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let reg: { unregister(): void } | null = null;
  try {
    reg = client()?.GameSessions?.RegisterForAppLifetimeNotifications?.(() => {
      checkApp();
      const t = setTimeout(() => { timers.delete(t); checkApp(); }, 1000);
      timers.add(t);
    }) ?? null;
  } catch {
    reg = null;
  }
  const poll = setInterval(checkApp, 3000);
  stopWatch = () => {
    clearInterval(poll);
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
    try { reg?.unregister(); } catch { /* already gone */ }
    stopWatch = null;
  };
};

/** cb(app) on every change of the running app (or its name); the returned function stops it. */
export const watchRunningApp = (cb: AppListener): (() => void) => {
  listeners.add(cb);
  if (!stopWatch) startWatch();
  return () => {
    listeners.delete(cb);
    if (!listeners.size) stopWatch?.();
  };
};

/** cb(appid) whenever the main running app changes (null: none runs); the returned function stops it. */
export const onMainAppChange = (cb: (appid: string | null) => void): (() => void) => {
  let prev = runningApp()?.appid ?? null;
  return watchRunningApp((a) => {
    const id = a?.appid ?? null;
    if (id === prev) return;
    prev = id;
    cb(id);
  });
};

/** The running game; follows game starts and exits (the shared watch above). */
export const useRunningApp = (): RunningApp | null => {
  const [app, setApp] = useState<RunningApp | null>(runningApp);
  useEffect(() => {
    const update = () => setApp((old) => {
      const now = runningApp();
      return sameApp(old, now) ? old : now;
    });
    const stop = watchRunningApp(update);
    update();
    return stop;
  }, []);
  useEffect(() => { if (app) remember.set("lastGame", JSON.stringify(app)); }, [app?.appid]);
  return app;
};

/** The game's launch options as Steam stores them; null when Steam does not answer within 1.5 s. */
export const getLaunchOptions = (appid: string): Promise<string | null> => new Promise((resolve) => {
  if (!isSteamApp(appid)) { resolve(null); return; }
  let done = false;
  let reg: { unregister(): void } | null = null;
  const finish = (v: string | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { reg?.unregister(); } catch { /* already gone */ }
    resolve(v);
  };
  const timer = setTimeout(() => finish(null), 1500);
  try {
    reg = client()?.Apps?.RegisterForAppDetails?.(Number(appid), (d) => {
      finish(typeof d?.strLaunchOptions === "string" ? d.strLaunchOptions : null);
    }) ?? null;
    // the first answer can come before RegisterForAppDetails returns: unregister now
    if (done) { try { reg?.unregister(); } catch { /* already gone */ } }
    if (!reg && !done) finish(null);
  } catch {
    finish(null);
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type SetResult = { ok: boolean; error: string | null; text: string | null };

/**
 * Write the launch options (they apply at the game's next start), then read them back: SetAppLaunchOptions
 * answers nothing. text is what Steam has now (null when it could not be read back).
 */
export const setLaunchOptions = async (appid: string, text: string): Promise<SetResult> => {
  if (!isSteamApp(appid)) return { ok: false, error: "not a Steam game: paste the launch options by hand", text: null };
  try {
    const apps = client()?.Apps;
    if (!apps?.SetAppLaunchOptions) return { ok: false, error: "Steam has no SetAppLaunchOptions any more", text: null };
    apps.SetAppLaunchOptions(Number(appid), text);
  } catch (e) {
    return { ok: false, error: `Steam refused the launch options: ${e instanceof Error ? e.message : String(e)}`, text: null };
  }
  let back: string | null = null;
  for (const wait of [200, 600]) {
    await sleep(wait);
    back = await getLaunchOptions(appid);
    if (back === text) return { ok: true, error: null, text: back };
  }
  if (back === null) return { ok: true, error: null, text: null };   // written; Steam did not answer the re-read
  return { ok: false, error: `Steam kept different launch options: ${back || "(empty)"}`, text: back };
};

// ---- Proton and the library (DESIGN.md "Automatic setup (0.6)", "Frontend") -----------------------------------------

export type CompatNow = { name: string; display: string; priority: number };

/**
 * The game's compatibility tool as Steam has it now (AppDetails: strCompatToolName, strCompatToolDisplayName,
 * nCompatToolPriority; a priority of 250 or more is a per-game pick); null when Steam does not answer within 1.5 s.
 */
export const getCompat = (appid: string): Promise<CompatNow | null> => new Promise((resolve) => {
  if (!isSteamApp(appid)) { resolve(null); return; }
  let done = false;
  let reg: { unregister(): void } | null = null;
  const finish = (v: CompatNow | null) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { reg?.unregister(); } catch { /* already gone */ }
    resolve(v);
  };
  const timer = setTimeout(() => finish(null), 1500);
  try {
    reg = client()?.Apps?.RegisterForAppDetails?.(Number(appid), (d: any) => {
      if (!d) { finish(null); return; }
      finish({
        name: typeof d.strCompatToolName === "string" ? d.strCompatToolName : "",
        display: typeof d.strCompatToolDisplayName === "string" ? d.strCompatToolDisplayName : "",
        priority: typeof d.nCompatToolPriority === "number" ? d.nCompatToolPriority : 0,
      });
    }) ?? null;
    if (done) { try { reg?.unregister(); } catch { /* already gone */ } }
    if (!reg && !done) finish(null);
  } catch {
    finish(null);
  }
});

/** The compatibility tools Steam offers for the game (GetAvailableCompatTools); [] when it cannot tell. */
export const compatTools = async (appid: string): Promise<{ name: string; display: string }[]> => {
  if (!isSteamApp(appid)) return [];
  try {
    const list = await client()?.Apps?.GetAvailableCompatTools?.(Number(appid));
    if (!Array.isArray(list)) return [];
    return list.filter((t: any) => t && typeof t.strToolName === "string" && t.strToolName)
      .map((t: any) => ({ name: String(t.strToolName), display: String(t.strDisplayName ?? t.strToolName) }));
  } catch {
    return [];
  }
};

export type CompatResult = { ok: boolean; error: string | null; name: string | null };

/**
 * Give the game another compatibility tool ("" clears the per-game choice: Steam's default again), then read it back
 * until Steam has it: SpecifyCompatTool answers nothing. Applies at the game's next start.
 */
export const setCompatTool = async (appid: string, name: string): Promise<CompatResult> => {
  if (!isSteamApp(appid)) return { ok: false, error: "not a Steam game", name: null };
  try {
    const apps = client()?.Apps;
    if (!apps?.SpecifyCompatTool) return { ok: false, error: "Steam has no SpecifyCompatTool any more", name: null };
    apps.SpecifyCompatTool(Number(appid), name);
  } catch (e) {
    return { ok: false, error: `Steam refused the Proton change: ${e instanceof Error ? e.message : String(e)}`, name: null };
  }
  let now: CompatNow | null = null;
  for (let waited = 0; waited < 5000; waited += 250) {
    await sleep(250);
    try { await (window as any).appDetailsStore?.RequestAppDetails?.(Number(appid)); } catch { /* read below anyway */ }
    now = await getCompat(appid);
    if (now && (name ? now.name === name && now.priority >= 250 : now.priority < 250)) return { ok: true, error: null, name: now.name };
  }
  return { ok: false, error: "Steam did not take the Proton change.", name: now?.name ?? null };
};

/** The installed Steam games Steam knows of (collectionStore's local games); [] when it cannot tell. */
export const installedSteamApps = (): RunningApp[] => {
  try {
    const apps = (window as any).collectionStore?.localGamesCollection?.allApps;
    if (!Array.isArray(apps)) return [];
    const out: RunningApp[] = [];
    for (const a of apps) {
      const appid = String(a?.appid ?? "");
      if (a?.app_type !== 1 || !isSteamApp(appid)) continue;
      if (a?.local_per_client_data && a.local_per_client_data.installed === false) continue;
      out.push({ appid, name: String(a.display_name || `App ${appid}`) });
    }
    return out;
  } catch {
    return [];
  }
};

/** The Steam apps running now (Router.RunningApps); [] when Steam cannot tell. */
export const runningApps = (): string[] => {
  try {
    const apps = (Router as any)?.RunningApps;
    return Array.isArray(apps) ? apps.map((a: any) => String(a?.appid ?? "")).filter(isSteamApp) : [];
  } catch {
    return [];
  }
};

/** cb(appid, running, instance) on every app start and exit (Steam's lifetime notifications); returns the stop. */
export const watchLifetime = (cb: (appid: string, running: boolean, instance: number) => void): (() => void) => {
  let reg: { unregister(): void } | null = null;
  try {
    reg = client()?.GameSessions?.RegisterForAppLifetimeNotifications?.((n: any) => {
      try { cb(String(n?.unAppID ?? ""), !!n?.bRunning, Number(n?.nInstanceID ?? 0)); } catch { /* a dead listener */ }
    }) ?? null;
  } catch {
    reg = null;
  }
  return () => { try { reg?.unregister(); } catch { /* already gone */ } };
};
