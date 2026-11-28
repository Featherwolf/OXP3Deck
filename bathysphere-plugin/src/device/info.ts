// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * The device: `system.info` once per activation (SPEC §5.3), the battery kept current from
 * `battery.changed` and `power.ac`, and the ONEXPLAYER 3 gate. On any other device no hardware
 * method is called at all (not even a release): the original refused the same way (main.py
 * _device, extras.py _gates).
 */
import { host, type BatteryState, type SystemInfo } from "@bathysphere/sdk";
import { Cached } from "../core/cache";

/** DMI of the ONEXPLAYER 3 (main.py OXP3_VENDOR; the board name the fan and charge gates use). */
export const OXP3_VENDOR = "ONE-NETBOOK";
export const OXP3_BOARD = "ONEXPLAYER 3";

export const info = new Cached<SystemInfo>(() => host.system.info(), Infinity);

/** The newest battery state: from events once one arrived, else from system.info. */
let battery: BatteryState | null | undefined;

export function onBattery(b: BatteryState): void {
  battery = b;
}

export function onAc(online: boolean): void {
  const b = battery ?? info.value?.battery;
  if (b) battery = { ...b, ac: online };
}

export const batteryNow = (): BatteryState | null => (battery !== undefined ? battery : (info.value?.battery ?? null));

export const isOxp3 = (i: SystemInfo | undefined): boolean => !!i && i.vendor === OXP3_VENDOR && i.board === OXP3_BOARD;

/** True only once system.info said so: hardware code checks this before every call. */
export const onOxp3 = (): boolean => isOxp3(info.value);

/** CachyOS (os-release ID). An Arch ID with CachyOS's repositories counts as Arch here. */
export const isCachyOs = (i: SystemInfo | undefined): boolean => i?.os.id === "cachyos";

/**
 * A system whose packages are pacman's (CachyOS, Arch): the hardware helper's package and the
 * pacman lines of the cards are for these only. The original also ran on Bazzite (rpm-ostree).
 */
export const usesPacman = (i: SystemInfo | undefined): boolean => i?.os.id === "cachyos" || i?.os.id === "arch";

/** Bazzite (Fedora atomic): its packages come with rpm-ostree and a reboot. */
export const isBazzite = (i: SystemInfo | undefined): boolean => i?.os.id === "bazzite";

/** "CachyOS 2026.11 · Linux 7.4.0-1-cachyos". */
export function platformLine(i: SystemInfo): string {
  const os = [i.os.name || i.os.id || "Linux", i.os.version].filter(Boolean).join(" ");
  return `${os} · Linux ${i.kernel || "?"}`;
}

/** The kernel release as [major, minor], or null. */
export function kernelVersion(i: SystemInfo | undefined): [number, number] | null {
  const m = /^(\d+)\.(\d+)/.exec(i?.kernel ?? "");
  return m ? [Number(m[1]), Number(m[2])] : null;
}

/** Fan mode and charge behaviour need oxpec from Linux 7.4 on this device (extras.py _gates). */
export function kernelAtLeast74(i: SystemInfo | undefined): boolean | null {
  const k = kernelVersion(i);
  return k ? k[0] > 7 || (k[0] === 7 && k[1] >= 4) : null;
}
