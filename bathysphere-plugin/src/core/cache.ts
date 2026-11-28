// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * One value read from the host, kept for `ttlMs`. Reads that overlap share one call; a failed read
 * keeps the last good value and records the error, so a row can show both.
 */
import type { HostError } from "@bathysphere/sdk";
import { now } from "./clock";
import { asHostError } from "./errors";

export class Cached<T> {
  value: T | undefined;
  error: HostError | undefined;
  private at = -Infinity;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly loader: () => Promise<T>,
    private readonly ttlMs: number,
  ) {}

  /** Reads again when the value is older than the TTL (or was invalidated); resolves when done. */
  async load(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (now() - this.at < this.ttlMs) return;
    this.inflight = this.loader().then(
      (v) => {
        this.value = v;
        this.error = undefined;
      },
      (e: unknown) => {
        this.error = asHostError(e);
      },
    );
    try {
      await this.inflight;
    } finally {
      this.at = now();
      this.inflight = undefined;
    }
  }

  /** The next `load()` reads again. */
  invalidate(): void {
    this.at = -Infinity;
  }

  /** Sets the value directly (a write's known result). */
  set(v: T): void {
    this.value = v;
    this.error = undefined;
    this.at = now();
  }
}

/** One Cached per key (per appid). */
export class CachedMap<K, T> {
  private readonly map = new Map<K, Cached<T>>();
  constructor(
    private readonly loader: (key: K) => Promise<T>,
    private readonly ttlMs: number,
  ) {}

  get(key: K): Cached<T> {
    let c = this.map.get(key);
    if (!c) {
      c = new Cached(() => this.loader(key), this.ttlMs);
      this.map.set(key, c);
    }
    return c;
  }

  invalidate(key?: K): void {
    if (key === undefined) for (const c of this.map.values()) c.invalidate();
    else this.map.get(key)?.invalidate();
  }
}
