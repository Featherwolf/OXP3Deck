// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Host errors (SPEC §5.2 codes, §11.5 provider reasons) in plain words: one line for the row, the
 * full message for its Details. Nothing here decides what to do next; callers check `code`.
 */
import { HostError, isHostError, type ErrorCode, type Tone } from "@bathysphere/sdk";
import { firstSentence } from "./text";

export interface Explained {
  code: ErrorCode | "EPLUGIN";
  /** One plain line (≤ 80 chars). */
  line: string;
  /** The host's own message, for Details. */
  message: string;
  tone: Tone;
}

/** Any thrown value as a HostError (plugin bugs become EPLUGIN-like EINTERNAL with their message). */
export function asHostError(e: unknown): HostError {
  if (isHostError(e)) return e;
  return new HostError("EINTERNAL", e instanceof Error ? e.message : String(e));
}

/** The lease holder an EBUSY names ("leased by X", "lease:X", "held by X"), if any. */
export function leaseHolder(message: string): string | null {
  const m = /leased by ([^;.,]+)|held by ([^;.,]+)|lease:(\S+)/i.exec(message);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() || null : null;
}

const NAMES: Record<string, string> = {
  "power-profiles-daemon": "Power Profiles",
  "tuned-ppd": "TuneD",
  tuned: "TuneD",
  hhd: "Handheld Daemon",
  powerstation: "PowerStation",
};

function busyLine(m: string): string {
  const holder = leaseHolder(m);
  if (holder) return `Held by ${holder}: move it in Bathysphere Home → Hardware`;
  if (/confirm in Bathysphere Home/i.test(m)) return "Confirm this once in Bathysphere Home";
  if (/not applied/i.test(m)) {
    const v = /\b([A-Za-z]+)=(\S+)/.exec(m);
    return v ? `Did not take: reads ${v[2]}` : "Did not take: the device kept another value";
  }
  if (/read back a different value|changed it/i.test(m)) {
    const who = /:\s*([^:]+?) changed it/i.exec(m);
    return `Did not take: ${who ? who[1] : "something else"} changed it`;
  }
  if (/session not active/i.test(m)) return "Only the user at the device can change this";
  const cool = /cooldown:(\d+)/.exec(m);
  if (cool) return `Quiet is blocked for ${Math.ceil(Number(cool[1]) / 60)} min after the fan got hot`;
  if (/\bsleep\b/.test(m)) return "The device is going to sleep";
  if (/locked/i.test(m)) return "The firmware locked this limit until the next reboot";
  if (/only while on AC|"?battery"?\b/i.test(m)) return "Only while plugged in";
  if (/governor/i.test(m)) return "The CPU speed policy is Performance, so this cannot change";
  for (const [id, name] of Object.entries(NAMES)) if (m.includes(id)) return `${name} changes this too`;
  return firstSentence(m) || "Busy, try again";
}

function notSupportedLine(m: string): string {
  if (/provider not installed|unrecognised provider/i.test(m)) return "Needs the ONEXPLAYER 3 hardware helper";
  if (/kernel/i.test(m)) return "Needs Linux 7.4 or newer";
  if (/power-profiles-daemon owns EPP|busy:power-profiles-daemon|busy:tuned/i.test(m)) return "Power Profiles controls this";
  if (/grants/i.test(m)) return "The hardware helper lacks access: reboot once";
  if (/disabled/i.test(m)) return "The hardware helper is turned off";
  if (/L2|shim|unhealthy/i.test(m)) return "Not available in Steam right now";
  return firstSentence(m) || "Not available on this device";
}

/** An error in plain words. */
export function explain(e: unknown): Explained {
  const err = asHostError(e);
  const m = err.message ?? "";
  const code = err.code as ErrorCode;
  const out = (line: string, tone: Tone = "bad"): Explained => ({ code, line: firstSentence(line), message: m, tone });
  switch (code) {
    case "EBUSY":
      return out(busyLine(m), /confirm in Bathysphere Home/i.test(m) ? "warn" : "bad");
    case "ENOTSUP":
      return out(notSupportedLine(m), "warn");
    case "EPERM":
      if (/declined/i.test(m)) return out("Not changed", "warn");
      if (/open surface/i.test(m)) return out("Open OXP3 Deck to change this", "warn");
      if (/toggle|setting|when/i.test(m) && /net|fetch|host/i.test(m)) return out("Turn on update checks first", "warn");
      return out(`Not allowed: ${firstSentence(m, 60)}`);
    case "EINVAL":
      return out(`Outside this device's range: ${firstSentence(m, 50)}`);
    case "ERATE":
      return out("Busy, try again in a moment", "warn");
    case "ENET":
      return out("No connection", "warn");
    case "ETIMEDOUT":
      return out("No answer in time", "warn");
    case "ENOENT":
      return out("Not found", "warn");
    case "EQUOTA":
      return out("Too large to read here");
    default:
      return out(firstSentence(m) || "Something went wrong");
  }
}

/** True for a host error with one of `codes`. */
export const hasCode = (e: unknown, ...codes: ErrorCode[]): boolean => isHostError(e) && codes.includes(e.code);
