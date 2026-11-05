// The live readouts' texts (DESIGN.md "Live readouts"): the quick panel's one line, why the device is slow, and the
// rows and Details of the Power tab. Pure, so node can test it (tests/js/live.test.mjs).
import { reasonText } from "./power";
import { MAX_LINE } from "./text";
import type { Live } from "./types";

/** "3 h 10 min" / "45 min". */
export const minutesText = (m: number | null | undefined): string | null => {
  if (m == null || !Number.isFinite(m) || m < 0) return null;
  const total = Math.round(m);
  const h = Math.floor(total / 60), min = total % 60;
  return h ? `${h} h ${min} min` : `${min} min`;
};

const one = (x: number) => `${Math.round(x * 10) / 10}`;

export const wattsText = (w: number | null | undefined): string | null => (w == null ? null : `${one(w)} W`);
export const tempText = (c: number | null | undefined): string | null => (c == null ? null : `${Math.round(c)} °C`);

/** The battery part: "3 h 10 min left" while discharging, "full in 40 min" while charging, else the percent. */
export const batteryText = (b: Live["battery"]): string | null => {
  if (!b) return null;
  const left = minutesText(b.time_left_min);
  if (left) return `${left} left`;
  const full = minutesText(b.time_to_full_min);
  if (full) return `full in ${full}`;
  return b.percent != null ? `battery ${Math.round(b.percent)} %` : null;
};

/** "18.4 W · 62 °C · GPU 87 % · 3 h 10 min left" (the parts that are null left out), at most MAX_LINE characters. */
export const liveLine = (live: Live | null | undefined): string => {
  if (!live) return "Reading…";
  const parts = [
    wattsText(live.package_w),
    tempText(live.cpu_temp_c),
    live.gpu?.busy_pct != null ? `GPU ${Math.round(live.gpu.busy_pct)} %` : null,
    batteryText(live.battery),
  ].filter((p): p is string => !!p);
  if (!parts.length) return "Nothing to read on this system.";
  let line = parts.join(" · ");
  while (line.length > MAX_LINE && parts.length > 1) { parts.pop(); line = parts.join(" · "); }
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
};

/** Why the device is slow right now: "CPU too hot", the GPU's limits in words, else "Not held back". */
export const whySlow = (live: Live | null | undefined): string => {
  if (!live) return "Not known yet";
  const parts: string[] = [];
  if (live.throttle?.cpu) parts.push("CPU too hot");
  const gpu = reasonText(live.throttle?.gpu?.length ? live.throttle.gpu : live.gpu?.reasons);
  if (gpu) parts.push(`GPU ${gpu}`);
  return parts.length ? parts.join("; ") : "Not held back";
};

/** "requested 1500 MHz, running 1450 MHz". */
export const gpuClockText = (g: Live["gpu"]): string | null => {
  if (!g || (g.cur_mhz == null && g.act_mhz == null)) return null;
  return `requested ${g.cur_mhz ?? "?"} MHz, running ${g.act_mhz ?? "?"} MHz`;
};

const STATUS: Record<string, string> = { Discharging: "on battery", Charging: "charging", Full: "full", "Not charging": "plugged in, not charging" };

/** The battery row: "62 % · on battery · 9.1 W". */
export const batteryRow = (b: Live["battery"]): string | null => {
  if (!b) return null;
  const t = batteryText(b);
  const time = t && !t.startsWith("battery") ? t : null;
  return [b.percent != null ? `${Math.round(b.percent)} %` : null, STATUS[b.status] ?? (b.status || null), wattsText(b.draw_w), time]
    .filter(Boolean).join(" · ") || null;
};

/** The Power tab's rows (one value each) and the quick panel's Details body, from the same sample. */
export const liveRows = (live: Live | null | undefined): { label: string; value: string }[] => {
  if (!live) return [];
  const rows: { label: string; value: string | null }[] = [
    { label: "Package power", value: wattsText(live.package_w) },
    { label: "Battery", value: batteryRow(live.battery) },
    { label: "CPU temperature", value: tempText(live.cpu_temp_c) },
    { label: "GPU busy", value: live.gpu?.busy_pct != null ? `${Math.round(live.gpu.busy_pct)} %` : null },
    { label: "GPU clock", value: gpuClockText(live.gpu) },
    { label: "Held back", value: whySlow(live) },
    { label: "Fan", value: live.fan_rpm != null ? `${Math.round(live.fan_rpm)} RPM` : null },
  ];
  return rows.filter((r): r is { label: string; value: string } => !!r.value);
};

/** The sources, for the Details' "Technical:" lines. */
export const LIVE_SOURCES = [
  "package power: intel-rapl (MSR) package-0 energy_uj, change per second",
  "battery: power_supply BAT power_now / current_now × voltage_now, energy_now",
  "CPU temperature: hwmon coretemp, Package id 0",
  "GPU busy: xe gt0 gtidle/idle_residency_ms, change per second",
  "GPU clock: xe freq0 cur_freq (requested) / act_freq (running), throttle/reasons",
  "CPU too hot: cpu0 thermal_throttle/package_throttle_total_time_ms",
  "fan: hwmon oxp_ec fan1_input (Linux 7.4+)",
];
