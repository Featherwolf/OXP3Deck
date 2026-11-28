// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/** A slider's value must lie in [min, max] (SPEC §6.2); this puts `v` there, on the step grid. */
export function snap(v: number, min: number, max: number, step: number): number {
  const inside = Math.min(max, Math.max(min, v));
  return Math.min(max, min + Math.round((inside - min) / step) * step);
}
