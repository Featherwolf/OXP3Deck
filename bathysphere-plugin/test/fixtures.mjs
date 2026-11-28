// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// The fake world the tests run OXP3 Deck in: an ONEXPLAYER 3 on CachyOS with the oxp3-hw helper, a
// Steam library, xess-xmx-linux files, oxp3-tool's state file. No real network: every request goes
// to a route here or fails with ENET.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeHost, textContent } from "../.bathysphere/packages/fake-host/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = join(here, "..", "dist");
const RUNTIME = process.env.BATHYS_RUNTIME_BIN ?? join(here, "..", ".bathysphere", "target", "debug", "bathys-runtime");
// fake-host looks for the runtime above the working directory; point it at the checkout's build.
if (existsSync(RUNTIME)) process.env.BATHYS_RUNTIME_BIN = RUNTIME;
/** Modes to run surface tests in: vm always, native when the runtime is built. */
export const MODES = existsSync(RUNTIME) ? ["vm", "native"] : ["vm"];

export const OXP3_DEVICE = {
  vendor: "ONE-NETBOOK",
  product: "ONEXPLAYER 3",
  board: "ONEXPLAYER 3",
  os: { id: "cachyos", name: "CachyOS", version: "2026.11" },
  kernel: "7.4.0-1-cachyos",
  battery: { percent: 72, charging: false, ac: false },
  sensors: { cpuTempC: 64, gpu: { busyPct: 55, reasons: [] }, throttle: { cpuMs: 0 }, fanRpm: 3100, battery: { drawW: 14.2, timeLeftMin: 190 }, packageW: 12.4 },
  provider: { name: "oxp3-hw", version: "0.1.0", device: "onexplayer-3", api: "1", state: "ok" },
  knobs: {
    tdp: { watts: 17, min: 5, max: 35 },
    gpu: { level: "auto", levels: ["auto", "manual"], clockMhz: 1500, min: 100, max: 2300 },
    gpuPowerProfile: { profile: "base", available: ["base", "power_saving"] },
    profile: null,
    cpuBoost: { enabled: true },
    chargeLimit: { percent: 100, min: 50, max: 100 },
    governor: { governor: "powersave", available: ["performance", "powersave"] },
    energy: null,
    boost: { mode: "firmware", modes: ["firmware", "follow", "manual"], watts: 52, offsetW: 0, min: 5, max: 52, offsetMax: 47, effective: 52 },
    epp: { byType: { p: "balance_performance", e: "balance_performance", lpe: "balance_performance" }, types: ["all", "p", "e", "lpe"], available: ["default", "performance", "balance_performance", "balance_power", "power"] },
    cpuLimits: { maxPerfPct: 100, minPerfPct: 8, maxPerfPctMin: 30, coreTypeMaxMhz: { p: 4800, e: 3700, lpe: 2500 }, coreTypeRange: { p: [400, 4800], e: [400, 3700], lpe: [400, 2500] } },
    socBalance: { balance: 3, offset: 0, balanceMin: 1, balanceMax: 5, offsetMax: 3, active: true },
    gpuRange: { minMhz: 100, maxMhz: 2300, floorMhz: 100, ceilMhz: 2300 },
    fan: { mode: "auto", modes: ["auto", "quiet", "max"] },
    chargeBehaviour: { value: "auto", available: ["auto", "inhibit-charge-awake"] },
  },
  conflicts: [],
};

export const OTHER_DEVICE = {
  vendor: "Valve",
  product: "Jupiter",
  board: "Jupiter",
  os: { id: "steamos", name: "SteamOS", version: "3.7.8" },
  kernel: "6.11.11-valve12-1-neptune-611",
};

const PKG = "/home/deck/.local/share/oxp3deck/xess/xess-xmx-linux-20261031";

export const XESS_HOME = {
  ".config/environment.d/50-xess-xmx.conf": `VK_DRIVER_FILES=${PKG}/run/intel_icd.json\nANV_CM_HELPER=${PKG}/tools/cm-compile.sh\n`,
  ".cache/xess-xmx/driver-status": `ok 2026-11-01 09:26:46 ${PKG}/lib/mesa-26.3.0-rc2/libvulkan_intel.so Mesa 26.3.0-rc2 (note: vulkaninfo not installed)\n`,
  ".config/systemd/user/xess-xmx-check.service": `[Service]\nExecStart=/usr/bin/bash "${PKG}/tools/session-check.sh"\n`,
};
export const XESS_ENV = { session: { VK_DRIVER_FILES: `${PKG}/run/intel_icd.json` }, steam: { VK_DRIVER_FILES: `${PKG}/run/intel_icd.json` } };
export const XESS_UNITS = {
  "xess-xmx-check.service": { load: "loaded", active: "inactive", file: "enabled" },
  "xess-xmx-shim.path": { load: "loaded", active: "active", file: "enabled" },
  "xess-xmx-shim.service": { load: "loaded", active: "inactive", file: "static" },
};
export const XESS_PKG = PKG;

export const OXP3_STATE = JSON.stringify({
  schema: 1,
  fixes: {
    buttons: { applied_at: "2026-11-02T10:00:00+00:00", tool_version: "0.4.4", files: [], kargs: [], options: { actions: { onex: "quick-access", keyboard: "keyboard", home: "guide", xbox: "guide" } }, notes: {} },
    "nvme-resume": { applied_at: "2026-11-02T10:00:00+00:00", tool_version: "0.4.4", files: [], kargs: ["nvme.noacpi=1"], options: {}, notes: {} },
    "volume-keys": { applied_at: "2026-10-01T10:00:00+00:00", tool_version: "0.4.2", files: [], kargs: [], options: {}, notes: {} },
  },
});

/** The Witcher 3 with XeSS and XeSS-FG in its folder and the shim's logs in its prefix; MH Wilds; Dota 2. */
export const APPS = [
  {
    appid: 292030,
    name: "The Witcher 3: Wild Hunt",
    installed: true,
    installDir: "The Witcher 3",
    buildId: 100,
    compatTool: { name: "GE-Proton11-11", perGame: true },
    launchOptions: "",
    files: {
      install: { "bin/x64_dx12/libxess.dll": "MZ fake", "bin/x64_dx12/libxess_fg.dll": "MZ fake", "bin/x64_dx12/libxell.dll": "MZ fake" },
      prefix: { "drive_c/igdext_trace.log": "igdext: loaded\nXMX path active\n", "drive_c/igdext_xefg.log": "XeFG[3] Latency reduction is not enabled.\nxefgSwapChainSetEnabled(1) -> -15\n", "drive_c/windows/system32/driverstore/x": "" },
    },
    fileVersions: { "bin/x64_dx12/libxess.dll": { fileVersion: "1.3.0.0", productVersion: "1.3.0.0" }, "bin/x64_dx12/libxess_fg.dll": { fileVersion: "1.2.0.10", productVersion: "1.2.0.10" }, "bin/x64_dx12/libxell.dll": { fileVersion: "1.2.1.13", productVersion: "1.2.1.13" } },
  },
  { appid: 2246340, name: "Monster Hunter Wilds", installed: true, installDir: "MonsterHunterWilds", buildId: 7, launchOptions: "XESS_FG=3 %command%", files: { install: { "MonsterHunterWilds.exe": "MZ" }, prefix: { "drive_c/windows/x": "" } } },
  { appid: 570, name: "Dota 2", installed: true, installDir: "dota 2 beta", buildId: 1, launchOptions: "", files: { install: { "game/bin/win64/dota2.exe": "MZ" }, prefix: {} } },
];

/**
 * A fixture set: the OXP3 with everything installed, overridable per test. The data parts are deep
 * copies (the fake host changes knob values and files in place); net routes and responders, which
 * may hold functions, are passed as they are.
 */
export function oxp3Fixtures(over = {}) {
  const { device, steam, home, env, units, systemFiles, net, responders, ...rest } = over;
  return {
    device: structuredClone({ ...OXP3_DEVICE, ...(device ?? {}), knobs: { ...OXP3_DEVICE.knobs, ...(device?.knobs ?? {}) } }),
    steam: structuredClone({ apps: APPS, ...(steam ?? {}) }),
    home: structuredClone(home ?? XESS_HOME),
    env: structuredClone(env ?? XESS_ENV),
    units: structuredClone(units ?? XESS_UNITS),
    systemFiles: structuredClone(systemFiles ?? { "/var/lib/oxp3-tool/state.json": OXP3_STATE, "/proc/cmdline": "BOOT_IMAGE=/vmlinuz-linux-cachyos root=UUID=x rw nvme.noacpi=1\n" }),
    net: net ?? { routes: [] },
    ...(responders ? { responders } : {}),
    ...structuredClone(rest),
  };
}

/** GitHub's routes for the update check: oxp3-tool's version file (raw, through the contents API) and xess-xmx-linux's latest release. */
export const TOOL_URL = "https://api.github.com/repos/Featherwolf/OXP3-Tool-for-Bazzite/contents/oxp3_tool/__init__.py";
export const XESS_REPO = "https://github.com/HHHHanasak1/xess-xmx-linux";
export const XESS_API = "https://api.github.com/repos/HHHHanasak1/xess-xmx-linux/releases/latest";
export const toolRoute = (v) => ({ url: TOOL_URL, response: { status: 200, body: `"""oxp3-tool"""\n__version__ = "${v}"\n` } });
export const redirectRoute = (tag) => ({ url: `${XESS_REPO}/releases/latest`, method: "HEAD", response: { status: 302, headers: { location: `${XESS_REPO}/releases/tag/${tag}` } } });

/** Starts OXP3 Deck in the fake host (manual clock unless asked otherwise). */
export async function start(opts = {}) {
  const { fixtures, mode = "vm", clock = "manual", ...rest } = opts;
  return FakeHost.start({ pluginDir: PLUGIN_DIR, mode, clock, fixtures: fixtures ?? oxp3Fixtures(), ...rest });
}

/** Renders a surface and waits for the background reads it started (and the trees they push). */
export async function open(host, surface, id, ctx) {
  const s = await host.render(surface, id, ctx);
  await host.settle();
  return s;
}

/** Lets queued work that waits on the host's clock run (the 1/s game file reads, debounces). */
export async function run(host, ms, step = 500) {
  for (let t = 0; t < ms; t += step) await host.advance(step);
  await host.settle();
}

export const text = (s) => textContent(s.tree);

/** No invalid tree, protocol problem or plugin error log (a refresh with a bad tree logs an error). */
export function clean(host) {
  assert.deepEqual(host.problems, []);
  assert.deepEqual(host.pluginLogs("error").map((l) => l.msg), []);
}

/** Calls of the hardware write methods (system.*.set, profiles, release). */
export const hwWrites = (host) => host.calls.filter((c) => /^system\.(.*\.set|profiles\.(set|clear)|hardware\.release)$/.test(c.method));

const STEAM_KNOBS = ["tdp", "gpu", "gpuPowerProfile", "cpuBoost", "chargeLimit"];
const PROVIDER_KNOBS = ["boost", "epp", "cpuLimits", "socBalance", "gpuRange", "fan", "chargeBehaviour", "packagePower"];

/**
 * A system.hardware.get answer for a responder, built from the fake world, with per-knob changes
 * (the fake host itself never reports a knob as overridden).
 */
export function hardwareState(state, over = {}) {
  const leased = (k) => {
    const l = state.leases.get(k);
    return l === undefined ? { owner: "none" } : l === "self" ? { owner: "self" } : { owner: "other", lease: l };
  };
  const knobs = [
    ...STEAM_KNOBS.map((knob) => ({ knob, backend: "steamos-manager", available: true, owner: "steam", overridden: false })),
    { knob: "profile", backend: "none", available: false, owner: "none", overridden: false, reason: "steamos-manager does not serve this knob" },
    { knob: "governor", backend: "steamos-manager", available: true, owner: "none", overridden: false },
    { knob: "energy", backend: "none", available: false, owner: "none", overridden: false, reason: "power-profiles-daemon is not running" },
    ...PROVIDER_KNOBS.map((knob) => ({ knob, backend: "provider", available: true, overridden: false, ...leased(knob) })),
  ].map((k) => ({ ...k, ...(over[k.knob] ?? {}) }));
  return { provider: state.device.provider, knobs };
}

/** Storage that has power control on and its first-use confirm done. */
export const POWER_ON = { power: { v: 1, enabled: true }, ui: { v: 1, powerConfirmed: true } };

/** Opens the panel on one tab. */
export async function panelTab(host, tab) {
  const p = await open(host, "panel", "main");
  await p.change({ type: "tabs" }, tab);
  await host.settle();
  return p;
}
export { FakeHost, textContent };
