// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * The plugin's stored values (host.storage, SPEC §5.3). Every value carries `v`, its schema version.
 * A value from a newer OXP3 Deck is read as far as this version understands it and never written,
 * and so is a value that is not an object at all (damaged: never silently wiped, DESIGN.md "Stored
 * files"); the user can start such a value fresh. Malformed fields are normalised one by one, the
 * way the original's power.py and autosetup.py normalise their JSON files.
 */
import { host, log, type Json } from "@bathysphere/sdk";
import { explain, hasCode } from "./errors";

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stored value of one key. */
export class Stored<T> {
  value: T;
  /** Why this value is read-only (saved by a newer version, or damaged), else null. */
  readOnly: string | null = null;
  /** The last failed write, in words. */
  writeError: string | null = null;

  constructor(
    readonly key: string,
    readonly title: string,
    readonly version: number,
    private readonly normalise: (raw: Obj) => T,
  ) {
    this.value = normalise({});
  }

  async load(): Promise<void> {
    let raw: unknown;
    try {
      raw = await host.storage.get(this.key);
    } catch (e) {
      log.warn(`storage ${this.key}: ${explain(e).message}`);
      return;
    }
    if (raw !== null && raw !== undefined && !isObj(raw)) {
      log.warn(`storage ${this.key} is not an object; kept as it is until Start fresh`);
      this.readOnly = "The stored value is damaged (not what OXP3 Deck writes), so it is kept as it is and nothing new is saved. Start fresh to replace it with the defaults.";
      this.value = this.normalise({});
      return;
    }
    const obj = isObj(raw) ? raw : {};
    const v = typeof obj.v === "number" ? obj.v : this.version;
    this.readOnly = v > this.version ? `Saved by a newer OXP3 Deck (data version ${v}); this version only reads it.` : null;
    this.value = this.normalise(obj);
  }

  /** Stores `next` (or the current value). False when read-only or the write failed. */
  async save(next?: T): Promise<boolean> {
    if (next !== undefined) this.value = next;
    if (this.readOnly) return false;
    try {
      await host.storage.set(this.key, { ...(this.value as Obj), v: this.version } as Json);
      this.writeError = null;
      return true;
    } catch (e) {
      // EQUOTA here is the plugin's storage quota, not a file too large to read
      this.writeError = hasCode(e, "EQUOTA") ? "Storage is full" : explain(e).line;
      log.warn(`storage ${this.key}: ${explain(e).message}`);
      return false;
    }
  }

  /** Deletes the stored value and starts from defaults ("Start fresh"). */
  async startFresh(): Promise<void> {
    await host.storage.delete(this.key);
    this.readOnly = null;
    this.writeError = null;
    this.value = this.normalise({});
  }
}

// ---- normalising helpers ---------------------------------------------------------------------

export const bool = (v: unknown, d: boolean): boolean => (typeof v === "boolean" ? v : d);

export function int(v: unknown, lo: number, hi: number): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A short word from a backend's list (levels, modes, preferences): letters, digits, `_` and `-`. */
export function word(v: unknown): string | null {
  return typeof v === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(v) ? v : null;
}

export function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
}

/** A Steam appid as a record key. */
export const isAppidKey = (k: string): boolean => /^[1-9][0-9]{0,9}$/.test(k) && Number(k) <= 4294967295;

/** The entries of `v` whose key is an appid, each normalised (null drops it), newest `max` by `at`. */
export function appidMap<T extends { at?: number }>(v: unknown, each: (raw: Obj) => T | null, max: number): Record<string, T> {
  const out: Array<[string, T]> = [];
  if (isObj(v)) {
    for (const [k, raw] of Object.entries(v)) {
      if (!isAppidKey(k) || !isObj(raw)) continue;
      const n = each(raw);
      if (n) out.push([k, n]);
    }
  }
  out.sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0));
  return Object.fromEntries(out.slice(0, max));
}
