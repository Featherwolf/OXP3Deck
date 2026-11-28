// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Update checks (original updates.py, oxp3tool.py _online, xess.py check_update): the newest
 * oxp3-tool version number and the newest xess-xmx-linux release tag, once a day while no game runs,
 * and on the user's "Check now". Every request goes to a manifest `network` host whose `when` is the
 * checkUpdates setting, so with it off the host refuses them (EPERM) and nothing leaves the device.
 * Only a check where both steps worked counts for the day; after any failure the next one is due in
 * an hour (updates.py due). Results in storage `updates`.
 */
import { host } from "@bathysphere/sdk";
import { now } from "../core/clock";
import { asHostError, explain } from "../core/errors";
import { redraw } from "../core/redraw";
import { settingOn } from "../core/settings";
import { isObj, num, Stored, text, type Obj } from "../core/storage";
import { REPO, SAFE_TAG } from "../xess/releases";

/** oxp3-tool's version file, raw, through GitHub's contents API (no host that serves user content). */
export const OXP3_INIT_URL = "https://api.github.com/repos/Featherwolf/OXP3-Tool-for-Bazzite/contents/oxp3_tool/__init__.py";
export const XESS_LATEST_URL = `https://github.com/${REPO}/releases/latest`;
export const XESS_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

export const DAY_MS = 24 * 3600 * 1000;
export const RETRY_MS = 3600 * 1000;
/** Per request: three in a row stay well inside a minute on a slow network. */
const REQUEST_TIMEOUT_MS = 10_000;

export interface UpdatesData {
  /** Unix ms of the last check where both steps worked, and of the last try. */
  lastOk: number | null;
  lastTry: number | null;
  /** After a failed check: not before this. */
  retryAt: number | null;
  oxp3: string | null;
  xess: string | null;
  error: string | null;
}

function normUpdates(raw: Obj): UpdatesData {
  const v = text(raw.oxp3, 40);
  const t = text(raw.xess, 100);
  return {
    lastOk: num(raw.lastOk),
    lastTry: num(raw.lastTry),
    retryAt: num(raw.retryAt),
    oxp3: v && /^[0-9][0-9A-Za-z.+-]{0,40}$/.test(v) ? v : null,
    xess: t && SAFE_TAG.test(t) ? t : null,
    error: text(raw.error, 300),
  };
}

export const updates = new Stored("updates", "Update checks", 1, normUpdates);

/** `__version__ = "0.4.4"` in oxp3_tool/__init__.py. */
export function parseToolVersion(src: string): string | null {
  const m = /^__version__\s*=\s*["']([0-9][0-9A-Za-z.+-]{0,40})["']/m.exec(src);
  return m ? m[1]! : null;
}

/** The tag in a releases/latest redirect ("…/releases/tag/20261104"); null for anything else. */
export function tagFromLocation(location: string | null): string | null {
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(location ?? "");
  if (!m) return null;
  let tag: string;
  try {
    tag = decodeURIComponent(m[1]!);
  } catch {
    return null; // a broken %-sequence: the API answers instead
  }
  return SAFE_TAG.test(tag) ? tag : null;
}

class CheckError extends Error {}

const OFF_LINE = "Turn on update checks first (Setup & updates).";
const NOT_GRANTED = "Bathysphere did not grant network access to OXP3 Deck.";
const LIMITED = "GitHub is limiting requests; try again in an hour";

async function newestTool(): Promise<string> {
  const res = await host.net.fetch(OXP3_INIT_URL, { headers: { accept: "application/vnd.github.raw+json" }, timeoutMs: REQUEST_TIMEOUT_MS });
  if (res.status === 403 || res.status === 429) throw new CheckError(LIMITED);
  if (!res.ok) throw new CheckError(`api.github.com answered ${res.status} for oxp3-tool`);
  const v = parseToolVersion(await res.text());
  if (!v) throw new CheckError("oxp3-tool's __init__.py has no version");
  return v;
}

async function newestXess(): Promise<string> {
  // github.com answers releases/latest with a redirect to the tag (not followed: SPEC §5.4)
  const head = await host.net.fetch(XESS_LATEST_URL, { method: "HEAD", timeoutMs: REQUEST_TIMEOUT_MS });
  const fromRedirect = head.status >= 300 && head.status < 400 ? tagFromLocation(head.headers.get("location")) : null;
  if (fromRedirect) return fromRedirect;
  const api = await host.net.fetch(XESS_API_URL, { headers: { accept: "application/vnd.github+json" }, timeoutMs: REQUEST_TIMEOUT_MS });
  if (api.status === 403 || api.status === 429) throw new CheckError(LIMITED);
  if (!api.ok) throw new CheckError(`api.github.com answered ${api.status}`);
  let body: unknown;
  try {
    body = await api.json();
  } catch {
    throw new CheckError("GitHub answered something that is not a release");
  }
  const tag = isObj(body) && typeof body.tag_name === "string" && SAFE_TAG.test(body.tag_name) ? body.tag_name : null;
  if (!tag) throw new CheckError("GitHub named no release");
  return tag;
}

let running = false;

/** A check runs now (the XeSS rows show "Checking…"). */
export const checkRunning = (): boolean => running;

/** Runs both checks now; returns a line to show when something failed. One check at a time. */
export async function checkNow(): Promise<string | null> {
  if (running) return null;
  const prev = updates.value;
  if (!settingOn("checkUpdates")) {
    // the host would refuse every request (EPERM): say so without asking it
    await updates.save({ ...prev, error: OFF_LINE });
    return OFF_LINE;
  }
  running = true;
  redraw();
  try {
    const next: UpdatesData = { ...prev, lastTry: now() };
    const errors: string[] = [];
    for (const [key, run] of [["oxp3", newestTool], ["xess", newestXess]] as const) {
      try {
        next[key] = await run();
      } catch (e) {
        if (e instanceof CheckError) {
          errors.push(e.message);
          continue;
        }
        const err = asHostError(e);
        if (err.code === "EPERM") {
          // the setting is on, so the network permission itself was not granted
          errors.push(NOT_GRANTED);
          break;
        }
        errors.push(explain(err).line);
      }
    }
    const t = now();
    if (errors.length) next.retryAt = t + RETRY_MS;
    else {
      next.lastOk = t;
      next.retryAt = null;
    }
    next.error = errors[0] ?? null;
    await updates.save(next);
    return next.error;
  } finally {
    running = false;
    redraw();
  }
}

/**
 * The daily check is due (the scheduler also checks the setting and that no game runs). A time
 * that lies ahead (the clock was wrong when it was stored, or a damaged value) holds nothing back.
 */
export function dailyDue(t: number = now()): boolean {
  const u = updates.value;
  if (u.retryAt !== null && t < u.retryAt && u.retryAt - t <= RETRY_MS) return false;
  return u.lastOk === null || u.lastOk > t || t - u.lastOk >= DAY_MS;
}
