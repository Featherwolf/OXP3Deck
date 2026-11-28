// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Is XeSS fast mode (xess-xmx-linux) installed and live (original xess.py detect, parse_status,
 * _session_env, _units)? Read only, from the manifest's homeRead files, the session and Steam
 * environments and the user units; at most every 10 s while a surface shows it.
 */
import { host, type UserUnit } from "@bathysphere/sdk";
import { Cached } from "../core/cache";
import { hasCode } from "../core/errors";
import { Stored, type Obj } from "../core/storage";
import { logTail } from "../core/text";
import { packageVersion } from "./releases";

export const ENV_FILE = ".config/environment.d/50-xess-xmx.conf";
export const STATUS_FILE = ".cache/xess-xmx/driver-status";
export const COMPILE_LOG = ".cache/xess-xmx/compile.log";
export const CHECK_UNIT_FILE = ".config/systemd/user/xess-xmx-check.service";
export const CHECK_UNIT = "xess-xmx-check.service";
export const WATCH_PATH = "xess-xmx-shim.path";

/** The env file as a map (quotes removed), xess.py env_values. */
export function envValues(text: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of (text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const at = line.indexOf("=");
    let v = line.slice(at + 1).trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && (v[0] === "'" || v[0] === '"')) v = v.slice(1, -1);
    out[line.slice(0, at).trim()] = v;
  }
  return out;
}

const parentOf = (p: string, levels: number): string => p.split("/").slice(0, -levels).join("/");

/** The package a VK_DRIVER_FILES value puts first (PKG/run/intel_icd.json). */
export function icdPackage(vk: string | null | undefined): string | null {
  const first = (vk ?? "").split(":")[0] ?? "";
  return first.endsWith("/run/intel_icd.json") ? parentOf(first, 2) : null;
}

/** The package folders the env file names: VK_DRIVER_FILES (any entry), then ANV_CM_HELPER. */
export function packagesFromEnv(env: Record<string, string>): string[] {
  const out: string[] = [];
  const icd = (env.VK_DRIVER_FILES ?? "").split(":").find((e) => e.endsWith("/run/intel_icd.json"));
  if (icd) out.push(parentOf(icd, 2));
  const helper = env.ANV_CM_HELPER ?? "";
  if (helper.endsWith("/tools/cm-compile.sh")) {
    const h = parentOf(helper, 2);
    if (!out.includes(h)) out.push(h);
  }
  return out;
}

/** The package the driver check unit runs session-check.sh of. */
export function packageFromUnit(text: string | null): string | null {
  const m = /^ExecStart=\S*bash\s+"([^"]+)\/tools\/session-check\.sh"/m.exec(text ?? "") ?? /^ExecStart=\S*bash\s+(\S+)\/tools\/session-check\.sh\s*$/m.exec(text ?? "");
  return m ? m[1]! : null;
}

export interface DriverStatus {
  state: "ok" | "failed" | "unknown";
  line: string | null;
  /** The Mesa version of the driver checked. */
  driver: string | null;
  notes: string[];
  date: string | null;
  lib: string | null;
  reason: string | null;
  switchedTo: string | null;
}

const OK = /^ok (\S+) (\S+) (.*?\/libvulkan_intel\.so)(?: (.*))?$/;
const FAILED = /^FAILED (\S+) (\S+) (.*?\/libvulkan_intel\.so): (.*)$/;
const SWITCHED = /\s*\(the previous driver failed: (.*); switched to Mesa (\S+?)\)\s*$/;
const NOTE = /\s*\(note: ([^)]*)\)/g;
const LIB_MESA = /\/lib\/mesa-([^/]+)\/libvulkan_intel\.so$/;
const INFO_MESA = /\bMesa ([0-9][0-9A-Za-z.+-]*)/;

/** The first line of driver-status in the forms tools/session-check.sh writes (xess.py parse_status). */
export function parseStatus(text: string | null): DriverStatus {
  const out: DriverStatus = { state: "unknown", line: null, driver: null, notes: [], date: null, lib: null, reason: null, switchedTo: null };
  const first = (text ?? "").split(/\r?\n/)[0]?.trim() ?? "";
  if (!first) return out;
  out.line = first;
  let info: string | null = null;
  const ok = OK.exec(first);
  if (ok) {
    out.state = "ok";
    out.date = `${ok[1]} ${ok[2]}`;
    out.lib = ok[3]!;
    let rest = ok[4] ?? "";
    const sw = SWITCHED.exec(rest);
    if (sw) {
      rest = rest.slice(0, sw.index);
      out.reason = sw[1]!;
      out.switchedTo = sw[2]!;
    }
    out.notes = [...rest.matchAll(NOTE)].map((m) => m[1]!.trim());
    info = rest.replace(NOTE, "").trim() || null;
    if (sw) out.notes.push(`the previous driver failed: ${sw[1]}; switched to Mesa ${sw[2]}`);
  } else {
    const f = FAILED.exec(first);
    if (!f) return out;
    out.state = "failed";
    out.date = `${f[1]} ${f[2]}`;
    out.lib = f[3]!;
    out.reason = f[4]!;
    out.notes = [f[4]!];
  }
  out.driver = LIB_MESA.exec(out.lib ?? "")?.[1] ?? INFO_MESA.exec(info ?? "")?.[1] ?? null;
  return out;
}

export interface XessState {
  installed: boolean;
  /** The package folder and how it was found. */
  path: string | null;
  how: "env" | "check-unit" | null;
  version: string | null;
  status: DriverStatus;
  compileLog: string | null;
  /** VK_DRIVER_FILES of the session manager and of the running Steam (undefined: Steam not running). */
  sessionVk: string | null;
  steamVk: string | null | undefined;
  /** Steam runs with this package's driver (null: unknown). */
  live: boolean | null;
  /** The env file and Steam's environment disagree: log out and back in. */
  relogin: boolean;
  units: Record<string, UserUnit | undefined>;
  /** Why install.sh should run again in place, else null. */
  repair: string | null;
}

/** A file the state depends on: missing reads as absent, any other failure fails the read (its row shows it). */
async function homeText(path: string, maxBytes: number): Promise<string | null> {
  try {
    return await host.fs.home.read(path, { maxBytes });
  } catch (e) {
    if (hasCode(e, "ENOENT")) return null;
    throw e;
  }
}

/** A file that only adds detail (the check unit, the compile log): any failure reads as absent. */
async function optionalText(path: string): Promise<string | null> {
  try {
    return await host.fs.home.read(path);
  } catch {
    return null;
  }
}

/** How much of the compile log's end the Driver check's Details show (they hold 4 KiB in all). */
const COMPILE_LOG_TAIL = 2048;

async function envOf(source: "session" | "steam"): Promise<Record<string, string> | undefined> {
  try {
    return await host.session.env.read(source);
  } catch (e) {
    if (hasCode(e, "ENOENT")) return undefined;
    throw e;
  }
}

/** The package VK_DRIVER_FILES points at, compared as written (hostd gives no realpath). */
const pointsAt = (vk: string | null | undefined, pkg: string | null): boolean => !!pkg && icdPackage(vk) === pkg;

async function readXess(): Promise<XessState> {
  const [envText, unitText, statusText, compileLog, session, steam, units] = await Promise.all([
    homeText(ENV_FILE, 65536),
    optionalText(CHECK_UNIT_FILE),
    homeText(STATUS_FILE, 65536),
    optionalText(COMPILE_LOG),
    envOf("session"),
    envOf("steam"),
    host.systemd.user.units().catch(() => [] as UserUnit[]),
  ]);
  const env = envValues(envText);
  const fromEnv = packagesFromEnv(env);
  const fromUnit = packageFromUnit(unitText);
  const path = fromEnv[0] ?? fromUnit;
  const installed = path !== null && path !== undefined;
  const status = parseStatus(statusText);
  const sessionVk = session?.VK_DRIVER_FILES ?? null;
  const steamVk = steam === undefined ? undefined : (steam.VK_DRIVER_FILES ?? null);
  const live = steamVk === undefined ? null : installed && pointsAt(steamVk, path ?? null);
  // after an install, update or uninstall the env file changes at once; Steam keeps the old value until a re-login
  const fileVk = env.VK_DRIVER_FILES ?? null;
  const relogin = (steamVk !== undefined && (installed ? !live : icdPackage(steamVk) !== null)) || (sessionVk !== null && fileVk !== null && sessionVk !== fileVk);
  const byName = Object.fromEntries(units.map((u) => [u.unit, u]));
  let repair: string | null = null;
  if (installed) {
    const check = byName[CHECK_UNIT];
    const watch = byName[WATCH_PATH];
    if (status.state === "failed") repair = "The driver failed its check at the last log-in.";
    else if (check && (check.load === "not-found" || check.file === "disabled")) repair = "The driver check unit is missing or turned off.";
    else if (watch && watch.load !== "not-found" && watch.active !== "active") repair = "The watcher that adds the add-on to new Protons is not running.";
  }
  return {
    installed,
    path: path ?? null,
    how: fromEnv.length ? "env" : fromUnit ? "check-unit" : null,
    version: packageVersion(path),
    status,
    compileLog: compileLog ? logTail(compileLog, COMPILE_LOG_TAIL).trim() || null : null,
    sessionVk,
    steamVk,
    live,
    relogin,
    units: byName,
    repair,
  };
}

export const xess = new Cached<XessState>(readXess, 10_000);

// ---- the plugin's own record: package folders seen, the default driver chosen ---------------------

export interface XessRecord {
  /** Package folders seen in the env file (newest first): an old one can be removed after a re-login. */
  seen: string[];
  preferredDriver: string | null;
}

function normXess(raw: Obj): XessRecord {
  const seen = Array.isArray(raw.seen) ? raw.seen.filter((p): p is string => typeof p === "string" && p.startsWith("/") && !/[\u0000-\u001f]/.test(p) && p.length <= 512) : [];
  const d = typeof raw.preferredDriver === "string" && /^[0-9][0-9A-Za-z.+-]{0,31}$/.test(raw.preferredDriver) ? raw.preferredDriver : null;
  return { seen: [...new Set(seen)].slice(0, 10), preferredDriver: d };
}

export const xessRecord = new Stored("xess", "XeSS folders seen", 1, normXess);

/** Records the package folder now in use (called after a read). */
export async function rememberPackage(s: XessState): Promise<void> {
  if (!s.path || xessRecord.value.seen[0] === s.path) return;
  await xessRecord.save({ ...xessRecord.value, seen: [s.path, ...xessRecord.value.seen.filter((p) => p !== s.path)].slice(0, 10) });
}

/** Earlier package folders no environment names any more (safe to remove after a re-login). */
export function oldFolders(s: XessState): string[] {
  const inUse = (p: string) => p === s.path || pointsAt(s.sessionVk, p) || pointsAt(s.steamVk ?? null, p);
  return xessRecord.value.seen.filter((p) => !inUse(p));
}

/** The XeSS row: label and one line (original quickgroups xessLine). */
export function xessLine(x: XessState | undefined): { tone: "good" | "warn" | "bad" | "neutral"; label: string; line: string } {
  if (!x) return { tone: "neutral", label: "XeSS fast mode", line: "Reading…" };
  if (!x.installed) return { tone: "neutral", label: "XeSS fast mode: Off", line: "Not installed. Games use the slower DP4a mode." };
  const v = x.version ? ` (${x.version})` : "";
  if (x.relogin) return { tone: "warn", label: "XeSS fast mode: Log out needed", line: "Log out of Game Mode and back in to turn it on." };
  if (x.status.state === "failed") return { tone: "bad", label: "XeSS fast mode: Off", line: "The fast driver failed its check." };
  if (x.status.state === "unknown") return { tone: "neutral", label: `XeSS fast mode: Not checked${v}`, line: "The driver check runs at the next log-in." };
  if (x.live === false) return { tone: "warn", label: "XeSS fast mode: Log out needed", line: "Steam does not use the fast driver yet." };
  return { tone: "good", label: `XeSS fast mode: On${v}`, line: x.live === null ? "Installed; Steam is not running, so live state unknown." : `Driver Mesa ${x.status.driver ?? "?"}` };
}
