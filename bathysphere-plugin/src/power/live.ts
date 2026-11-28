// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * Live readouts (original src/live.ts, readouts.py): one shared `system.sensors.read` (≤ 2/s,
 * SPEC §5.3) and the texts built from it. GPU clocks are asked for only while the panel shows them:
 * reading them wakes the GPU.
 */
import { host, type SensorReadings } from "@bathysphere/sdk";
import { now } from "../core/clock";
import { asHostError } from "../core/errors";
import { MAX_LINE, minutesText, watts } from "../core/text";
import { batteryNow } from "../device/info";

export interface Sample {
  at: number;
  s: SensorReadings;
  /** CPU thermal throttling since the previous sample (ms), when both had the counter. */
  throttledMs: number | null;
}

let last: Sample | null = null;
let inflight: Promise<Sample> | null = null;
/** Readers ask at most this often (two readers, the live view and the advisor, share one read). */
const MIN_GAP_MS = 900;

/** A sensor sample no older than ~1 s. Throws the host error when the read fails. */
export async function readSensors(gpuClocks = false): Promise<Sample> {
  if (last && now() - last.at < MIN_GAP_MS && (!gpuClocks || last.s.gpu?.actMhz !== undefined)) return last;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const s = await host.system.sensors.read(gpuClocks ? { gpuClocks: true } : {});
      const prev = last?.s.throttle?.cpuMs;
      const cur = s.throttle?.cpuMs;
      last = { at: now(), s, throttledMs: prev !== undefined && cur !== undefined ? Math.max(0, cur - prev) : null };
      return last;
    } catch (e) {
      throw asHostError(e);
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export const lastSample = (): Sample | null => last;

const POWER_REASONS = new Set(["pl1", "pl2", "pl4", "vr_tdc", "power"]);
const THERMAL_REASONS = new Set(["thermal", "prochot", "ratl", "vr_thermalert"]);

/** The GPU's throttle reasons in words (original power.ts reasonText). */
export function reasonText(reasons: readonly string[] | undefined): string | null {
  const rs = reasons ?? [];
  if (!rs.length) return null;
  const words: string[] = [];
  if (rs.some((r) => POWER_REASONS.has(r))) words.push("held back by the power limit");
  if (rs.some((r) => THERMAL_REASONS.has(r))) words.push("held back by heat");
  const other = rs.filter((r) => !POWER_REASONS.has(r) && !THERMAL_REASONS.has(r));
  if (other.length) words.push(`limited by ${other.join(", ")}`);
  return words.join(", ");
}

const temp = (c: number | undefined) => (c === undefined ? null : `${Math.round(c)} °C`);

/** "3 h 10 min left" / "full in 40 min" / "battery 62 %". */
function batteryText(s: SensorReadings): string | null {
  const left = minutesText(s.battery?.timeLeftMin);
  if (left) return `${left} left`;
  const full = minutesText(s.battery?.timeToFullMin);
  if (full) return `full in ${full}`;
  const b = batteryNow();
  return b ? `battery ${b.percent} %` : null;
}

/** "18.4 W · 62 °C · GPU 87 % · 3 h 10 min left", at most 80 characters (parts dropped from the end). */
export function liveLine(sample: Sample | null): string {
  if (!sample) return "Reading…";
  const s = sample.s;
  const parts = [
    s.packageW !== undefined ? watts(s.packageW) : null,
    temp(s.cpuTempC),
    s.gpu?.busyPct !== undefined ? `GPU ${Math.round(s.gpu.busyPct)} %` : null,
    batteryText(s),
  ].filter((p): p is string => !!p);
  if (!parts.length) return "Nothing to read on this system.";
  while (parts.join(" · ").length > MAX_LINE && parts.length > 1) parts.pop();
  return parts.join(" · ");
}

/** Why the device is slow right now (original whySlow). */
export function whySlow(sample: Sample | null): string {
  if (!sample) return "Not known yet";
  const parts: string[] = [];
  if ((sample.throttledMs ?? 0) > 0) parts.push("CPU too hot");
  const gpu = reasonText(sample.s.gpu?.reasons);
  if (gpu) parts.push(`GPU ${gpu}`);
  return parts.length ? parts.join("; ") : "Not held back";
}

/** The Power tab's rows (label and one value each). */
export function liveRows(sample: Sample | null): Array<{ label: string; value: string }> {
  if (!sample) return [];
  const s = sample.s;
  const b = batteryNow();
  const battery = [b ? `${b.percent} %` : null, b ? (b.charging ? "charging" : b.ac ? "plugged in" : "on battery") : null, s.battery?.drawW !== undefined ? watts(s.battery.drawW) : null, batteryText(s)?.startsWith("battery") ? null : batteryText(s)]
    .filter(Boolean)
    .join(" · ");
  const rows: Array<{ label: string; value: string | null }> = [
    { label: "Package power", value: s.packageW !== undefined ? watts(s.packageW) : null },
    { label: "Battery", value: battery || null },
    { label: "CPU temperature", value: temp(s.cpuTempC) },
    { label: "GPU busy", value: s.gpu?.busyPct !== undefined ? `${Math.round(s.gpu.busyPct)} %` : null },
    { label: "GPU clock", value: s.gpu?.actMhz !== undefined ? `requested ${s.gpu.curMhz ?? "?"} MHz, running ${s.gpu.actMhz} MHz` : null },
    { label: "Held back", value: whySlow(sample) },
    { label: "Fan", value: s.fanRpm !== undefined ? `${Math.round(s.fanRpm)} RPM` : null },
  ];
  return rows.filter((r): r is { label: string; value: string } => !!r.value);
}

export const LIVE_SOURCES = [
  "package power: the hardware helper's PackagePower1 sample (0.1 W, 1 s window)",
  "battery: power_supply power_now, energy_now",
  "CPU temperature: hwmon coretemp, Package id 0",
  "GPU busy: xe idle residency, change per call",
  "GPU clock: xe freq0 cur_freq (requested) and act_freq (running), throttle reasons",
  "CPU too hot: thermal_throttle package_throttle_total_time_ms",
  "fan: hwmon oxp_ec fan1_input (Linux 7.4 and newer)",
];
