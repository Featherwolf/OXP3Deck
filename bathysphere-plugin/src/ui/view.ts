// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * What a render needs: where it draws, and the reads every surface shares, loaded before the tree
 * is built (each is cached, so re-renders cost little). A render waits for them only so long: the
 * host gives a render 5 s (SPEC §5.2), so a slow helper or D-Bus call finishes in the background and
 * the surface is drawn again when it has.
 */
import { after, type Timer } from "../core/clock";
import { redraw } from "../core/redraw";
import { info, onOxp3 } from "../device/info";
import { hw } from "../hw/knobs";
import { profiles, readConflicts } from "../power/apply";
import { library } from "../games/running";
import { oxp3 } from "../oxp3tool/state";
import { rememberPackage, xess } from "../xess/detect";

export interface View {
  where: "qam" | "panel" | "game";
  /** The surface instance ("surface:id:inst"): per-view state and the live readouts follow it. */
  key: string;
  /** The game this view is about (the section's game, or the panel's ctx), else null. */
  appid: number | null;
}

/** How long a render waits for the shared reads before it draws with what it has ("Reading…"). */
const READ_WAIT_MS = 3000;

async function readBase(hardware: boolean): Promise<void> {
  // system.info is read once per activation, and again on every render until it has worked
  if (info.value === undefined) info.invalidate();
  await info.load();
  const work: Array<Promise<void>> = [xess.load(), library.load()];
  if (hardware && onOxp3()) work.push(hw.load(), profiles.load(), readConflicts(), oxp3.load());
  await Promise.all(work);
  if (xess.value) await rememberPackage(xess.value);
}

/**
 * The reads a surface shows; on another device no hardware is read at all. `hardware`: also the
 * helper's knobs, the rules, the other power programs and oxp3-tool's state (not for a game page).
 */
export async function loadBase(hardware = true): Promise<void> {
  const reads = readBase(hardware);
  let timer: Timer | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = after(READ_WAIT_MS, () => resolve(true));
  });
  const slow = await Promise.race([reads.then(() => false), late]);
  timer?.cancel();
  if (slow) void reads.then(redraw);
}

/** Views that show live readouts now, and whether they show GPU clocks (the panel only). */
export const liveViews = new Map<string, { gpuClocks: boolean }>();

/** Per-view choices that are not worth storing (which profile the editor shows, which game is picked). */
export const viewState = new Map<string, Record<string, unknown>>();

export function stateOf<T>(v: View, key: string, initial: T): T {
  const s = viewState.get(v.key) ?? {};
  viewState.set(v.key, s);
  if (!(key in s)) s[key] = initial;
  return s[key] as T;
}

export function setState(v: View, key: string, value: unknown): void {
  const s = viewState.get(v.key) ?? {};
  s[key] = value;
  viewState.set(v.key, s);
}
