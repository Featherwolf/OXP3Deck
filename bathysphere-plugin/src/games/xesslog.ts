// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * "Save XeSS logs" for one run (original src/xesslog.ts): XESS_LOG is taken out again after a run
 * that wrote a fresh log, unless the game is set to keep logging. The record per game is storage
 * `xessLog`.
 */
import { appidMap, num, type Obj, Stored } from "../core/storage";

export interface LogRec {
  /** Unix ms when logging was turned on: a log older than this is from before. */
  onAt: number;
  keep: boolean;
  /** Unix ms when it was turned off after a run (the note shows until the next run ends). */
  offAt: number | null;
  at: number;
}

const normOne = (r: Obj): LogRec | null => {
  const onAt = num(r.onAt);
  if (onAt === null) return null;
  const offAt = num(r.offAt);
  return { onAt, keep: r.keep === true, offAt, at: Math.max(onAt, offAt ?? 0) };
};

export const xessLog = new Stored("xessLog", "One-run XeSS logging", 1, (raw: Obj) => ({ games: appidMap(raw.games, normOne, 40) }));

/** A note ends at an exit at least this long after the turn-off (so at the end of the next run). */
export const NOTE_MIN_MS = 120_000;

export type ExitStep = { do: "nothing" } | { do: "record"; rec: LogRec | null } | { do: "off"; rec: LogRec };

/**
 * After a game quit: whether logging is on now, its record, the newest log time (ms, null: no log)
 * and now (ms). Off with an old note → drop it; kept on → nothing; on without a record → the record
 * starts (the next run decides); on with a log newer than the turn-on → take XESS_LOG out.
 */
export function exitStep(on: boolean, rec: LogRec | undefined, logAt: number | null, now: number): ExitStep {
  if (!on) {
    if (!rec || (rec.offAt !== null && now - rec.offAt < NOTE_MIN_MS)) return { do: "nothing" };
    return { do: "record", rec: null };
  }
  if (rec?.keep) return { do: "nothing" };
  if (!rec || rec.offAt !== null) return { do: "record", rec: { onAt: now, keep: false, offAt: null, at: now } };
  if (logAt !== null && logAt > rec.onAt) return { do: "off", rec: { ...rec, offAt: now, at: now } };
  return { do: "nothing" };
}

export async function setRecord(appid: number, rec: LogRec | null): Promise<void> {
  const games = { ...xessLog.value.games };
  if (rec) games[String(appid)] = rec;
  else delete games[String(appid)];
  await xessLog.save({ games: appidMap(games, (r) => normOne(r as Obj), 40) });
}
