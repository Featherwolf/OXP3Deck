// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * The running games (original src/steam.ts): `steam.apps.current` at start, then `app.started`,
 * `app.stopped` and `steam.apps.running`; and the installed games' names (steam.apps.list).
 */
import { host, type AppSummary } from "@bathysphere/sdk";
import { Cached } from "../core/cache";

let running: number[] = [];
let current: number | null = null;

export const library = new Cached<AppSummary[]>(() => host.steam.apps.list({ installedOnly: true }), 600_000);

export function setRunning(appids: readonly number[]): void {
  running = [...appids];
  if (current === null || !running.includes(current)) current = running[running.length - 1] ?? null;
}

export function started(appid: number): void {
  if (!running.includes(appid)) running = [...running, appid];
  current = appid;
}

export function stopped(appid: number): void {
  running = running.filter((a) => a !== appid);
  if (current === appid) current = running[running.length - 1] ?? null;
}

export const isRunning = (appid: number): boolean => running.includes(appid);
export const anyRunning = (): boolean => running.length > 0;
/** The game in front (the newest started that still runs). */
export const currentGame = (): number | null => current;

/** A game's name from the library, else "App <id>". */
export function appName(appid: number, fallback?: string | null): string {
  return library.value?.find((a) => a.appid === appid)?.name ?? fallback ?? `App ${appid}`;
}
