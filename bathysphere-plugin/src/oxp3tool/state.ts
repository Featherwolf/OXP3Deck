// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * What oxp3-tool did on this device, read from its world-readable state file (schema 1,
 * /var/lib/oxp3-tool/state.json), its "boot entries unfinished" marker and /proc/cmdline (SPEC §5.3
 * fs.system.read; the manifest's systemRead). oxp3-tool itself runs as root, so the plugin only
 * reads; `sudo oxp3-tool status` has what needs root to see.
 */
import { host } from "@bathysphere/sdk";
import { Cached } from "../core/cache";
import { hasCode } from "../core/errors";
import { isObj } from "../core/storage";

export const STATE_FILE = "/var/lib/oxp3-tool/state.json";
export const BOOT_MARKER = "/run/oxp3-tool-boot-entries-unfinished";
export const CMDLINE = "/proc/cmdline";

export interface FixEntry {
  id: string;
  /** null until the fix was fully applied (an interrupted apply). */
  appliedAt: string | null;
  toolVersion: string | null;
  kargs: string[];
  kargsPendingAdd: string[];
  kargsRemovalPending: string[];
  reverted: boolean;
  options: Record<string, unknown>;
}

export interface Oxp3State {
  /** The state file exists (oxp3-tool applied something). */
  present: boolean;
  /** The file exists but is not schema 1. */
  error: string | null;
  fixes: Record<string, FixEntry>;
  /** The newest tool version that applied a fix (the installed tool is at least this). */
  toolVersion: string | null;
  /** oxp3-tool's last boot-entry update did not finish (its marker exists). */
  bootUnfinished: boolean;
  /** The marker's command when it is one oxp3-tool writes, else null (the card then says what to run). */
  bootCommand: string | null;
  cmdline: string | null;
  /** Fixes whose kernel arguments or revert wait for a reboot. */
  rebootPending: string[];
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** state.json (oxp3_tool/state.py) as this plugin reads it. */
export function parseState(text: string | null): Pick<Oxp3State, "present" | "error" | "fixes"> {
  if (text === null) return { present: false, error: null, fixes: {} };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { present: true, error: "oxp3-tool's state file is damaged; run sudo oxp3-tool status.", fixes: {} };
  }
  if (!isObj(data) || data.schema !== 1 || !isObj(data.fixes)) return { present: true, error: "oxp3-tool's state file has a format this version does not know.", fixes: {} };
  const fixes: Record<string, FixEntry> = {};
  for (const [id, e] of Object.entries(data.fixes)) {
    if (!/^[a-z0-9-]{1,40}$/.test(id) || !isObj(e)) continue;
    fixes[id] = {
      id,
      appliedAt: typeof e.applied_at === "string" ? e.applied_at : null,
      toolVersion: typeof e.tool_version === "string" ? e.tool_version : null,
      kargs: strs(e.kargs),
      kargsPendingAdd: strs(e.kargs_pending_add),
      kargsRemovalPending: strs(e.kargs_removal_pending),
      reverted: e.reverted === true,
      options: isObj(e.options) ? e.options : {},
    };
  }
  return { present: true, error: null, fixes };
}

/** "0.4.2" → [0, 4, 2]. */
export function parseVersion(v: string | null | undefined): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function versionNewer(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x) return false;
  if (!y) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

/** Fixes that wait for a reboot: kernel arguments not active yet or not gone yet, or a revert. */
export function rebootPending(fixes: Record<string, FixEntry>, cmdline: string | null): string[] {
  if (cmdline === null) return Object.values(fixes).filter((f) => f.reverted).map((f) => f.id);
  const words = new Set(cmdline.trim().split(/\s+/));
  return Object.values(fixes)
    .filter((f) => f.reverted || f.kargsPendingAdd.some((k) => !words.has(k)) || f.kargsRemovalPending.some((k) => words.has(k)) || (f.appliedAt !== null && f.kargs.some((k) => !words.has(k))))
    .map((f) => f.id);
}

/** Applied fixes from an older oxp3-tool than the newest one seen: their helpers need Apply again. */
export function staleFixes(s: Pick<Oxp3State, "fixes" | "toolVersion">): string[] {
  return Object.values(s.fixes)
    .filter((f) => f.appliedAt !== null && !f.reverted && s.toolVersion !== null && versionNewer(s.toolVersion, f.toolVersion))
    .map((f) => f.id);
}

/** The commands oxp3-tool writes into its marker (oxp3_tool/kargs.py: each boot loader's regen or finish_command). */
export const FINISH_COMMANDS: readonly string[] = ["limine-update", "limine-mkinitcpio", "sdboot-manage gen", "grub-mkconfig -o /boot/grub/grub.cfg"];

/** The marker's first line if it is one of those commands: it is shown as `sudo <line>`, so nothing else is. */
export function markerCommand(text: string): string | null {
  const first = (text.split(/\r?\n/)[0] ?? "").trim();
  return FINISH_COMMANDS.includes(first) ? first : null;
}

async function readText(path: string, maxBytes?: number): Promise<string | null> {
  try {
    return await host.fs.system.read(path, maxBytes ? { maxBytes } : undefined);
  } catch (e) {
    if (hasCode(e, "ENOENT")) return null;
    throw e;
  }
}

async function readOxp3(): Promise<Oxp3State> {
  const [stateText, marker, cmdline] = await Promise.all([readText(STATE_FILE), readText(BOOT_MARKER, 4096), readText(CMDLINE, 4096)]);
  const st = parseState(stateText);
  const versions = Object.values(st.fixes).map((f) => f.toolVersion).filter((v): v is string => !!v);
  const toolVersion = versions.reduce<string | null>((best, v) => (versionNewer(v, best) ? v : best), null);
  return { ...st, toolVersion, bootUnfinished: marker !== null, bootCommand: marker === null ? null : markerCommand(marker), cmdline, rebootPending: rebootPending(st.fixes, cmdline) };
}

export const oxp3 = new Cached<Oxp3State>(readOxp3, 10_000);

/** applied / incomplete / reverting / not applied. */
export function fixState(e: FixEntry | undefined): "applied" | "incomplete" | "reverting" | "none" {
  if (!e) return "none";
  if (e.reverted) return "reverting";
  return e.appliedAt === null ? "incomplete" : "applied";
}
