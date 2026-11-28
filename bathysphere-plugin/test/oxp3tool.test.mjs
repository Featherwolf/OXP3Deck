// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// oxp3-tool from its state file: version, fix rows with the exact apply/revert lines and their
// options, helpers from an older version, the do-not-reboot marker, reboot pending from kernel
// arguments, the button layout line, the kernel helper, the problem report (F1, F3–F13).
import assert from "node:assert/strict";
import { test } from "node:test";
import { findAll } from "../.bathysphere/packages/fake-host/dist/index.js";
import { clean, open, OXP3_STATE, oxp3Fixtures, panelTab, run, start, text, toolRoute } from "./fixtures.mjs";

const codes = (s) => findAll(s.tree, { type: "code" }).map((n) => n.text);
const cards = (s) => findAll(s.tree, { type: "instructions" }).map((n) => `${n.id}:${(n.steps ?? []).join(",")}`);
const sys = (over) => ({ "/var/lib/oxp3-tool/state.json": OXP3_STATE, "/proc/cmdline": "root=UUID=x rw nvme.noacpi=1\n", ...over });

test("fix rows: state, level, when it works, the exact line; options change the line (F4, F5, F7)", async () => {
  const host = await start();
  try {
    const p = await panelTab(host, "fixes");
    const t = text(p);
    assert.match(t, /oxp3-tool 0\.4\.4\nUp to date/);
    assert.match(t, /Chassis buttons do what their labels say\nApplied · recommended · works at once/);
    assert.match(t, /SSD survives sleep\nApplied · recommended · works after a reboot/);
    assert.ok(codes(p).includes("sudo oxp3-tool revert nvme-resume"));
    assert.ok(codes(p).includes("sudo oxp3-tool apply gyro"));
    assert.ok(codes(p).includes("sudo oxp3-tool apply oled-profile"));
    await p.change({ label: "Lowest refresh rate (OLED profile)" }, 40);
    await host.settle();
    assert.ok(codes(p).includes("sudo oxp3-tool apply oled-profile --min-refresh 40"));
    assert.ok(cards(p).includes("oxp3-tool-fix:") && cards(p).includes("oxp3-tool-apply:") && cards(p).includes("oxp3-tool-install:"));
    clean(host);
  } finally {
    await host.stop();
  }
  const fresh = await start({ fixtures: oxp3Fixtures({ systemFiles: sys({ "/var/lib/oxp3-tool/state.json": JSON.stringify({ schema: 1, fixes: {} }) }) }) });
  try {
    const p = await panelTab(fresh, "fixes");
    await p.change({ label: "Apply without the SSD the fix was made for" }, true);
    await fresh.settle();
    assert.ok(codes(p).includes("sudo oxp3-tool apply nvme-resume --any-ssd"));
    clean(fresh);
  } finally {
    await fresh.stop();
  }
});

test("helpers from an older oxp3-tool: Apply again with the line (F13)", async () => {
  const host = await start();
  try {
    const p = await panelTab(host, "fixes");
    assert.match(text(p), /Apply again \(1\)/);
    assert.ok(cards(p).includes("oxp3-tool-fix:0"));
    assert.ok(codes(p).includes("sudo oxp3-tool apply volume-keys"));
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(q.find({ key: "g-fixes" }).subtitle, /3 applied · 1 need attention|3 applied/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("not installed yet: the install card; a damaged state file says so (F1)", async () => {
  let host = await start({ fixtures: oxp3Fixtures({ systemFiles: { "/proc/cmdline": "root=x\n" } }) });
  try {
    const p = await panelTab(host, "fixes");
    assert.match(text(p), /oxp3-tool not seen yet/);
    assert.ok(cards(p).includes("oxp3-tool-install:"));
    clean(host);
  } finally {
    await host.stop();
  }
  host = await start({ fixtures: oxp3Fixtures({ systemFiles: sys({ "/var/lib/oxp3-tool/state.json": "{not json" }) }) });
  try {
    const p = await panelTab(host, "fixes");
    assert.match(text(p), /oxp3-tool's state\n.*damaged/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("do not reboot yet; reboot to finish from pending kernel arguments (F11, F12)", async () => {
  const state = JSON.stringify({ schema: 1, fixes: { "xe-dsb-off": { applied_at: "2026-11-02T10:00:00+00:00", tool_version: "0.4.4", kargs: ["xe.enable_dsb=0"] } } });
  const host = await start({ fixtures: oxp3Fixtures({ systemFiles: sys({ "/var/lib/oxp3-tool/state.json": state, "/run/oxp3-tool-boot-entries-unfinished": "limine-update\n" }) }) });
  try {
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /Do not reboot yet/);
    assert.ok(codes(q).includes("sudo limine-update"));
    assert.ok(cards(q).includes("boot-entries:"));
    assert.match(text(q), /Reboot to finish\nxe-dsb-off: restart from Steam's power menu/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("buttons: each key's action, the frame limit, the exact line (F8)", async () => {
  const host = await start();
  try {
    const p = await panelTab(host, "buttons");
    assert.ok(codes(p).includes("sudo oxp3-tool apply buttons --onex-key quick-access --keyboard-key keyboard --home guide --xbox-key guide"));
    await p.change({ label: "home key" }, "fps-limit");
    await host.settle();
    await p.change({ label: "Frame limit of the fps-limit key" }, 60);
    await p.change({ label: "Apply without restarting InputPlumber" }, true);
    await host.settle();
    assert.ok(codes(p).includes("sudo oxp3-tool apply buttons --onex-key quick-access --keyboard-key keyboard --home fps-limit --xbox-key guide --fps-limit 60 --no-restart"), codes(p).join("\n"));
    assert.ok(cards(p).includes("oxp3-tool-buttons:"));
    clean(host);
  } finally {
    await host.stop();
  }
});

test("kernel helper: a package name gives the line, anything else is refused (F9)", async () => {
  const host = await start();
  try {
    const p = await panelTab(host, "kernel");
    await p.submit({ label: "Kernel package" }, "linux-cachyos-rc");
    await host.settle();
    assert.ok(codes(p).includes("sudo oxp3-tool kernel try linux-cachyos-rc"));
    await p.submit({ label: "Kernel package" }, "linux; rm -rf /");
    await host.settle();
    assert.match(text(p), /Not a package name/);
    assert.ok(!codes(p).some((c) => c.includes("rm -rf")));
    assert.ok(cards(p).includes("oxp3-tool-kernel:"));
    clean(host);
  } finally {
    await host.stop();
  }
});

test("oxp3-tool update notice from GitHub's version (F3)", async () => {
  const routes = [toolRoute("0.4.6")];
  const host = await start({ fixtures: oxp3Fixtures({ net: { routes } }) });
  try {
    const p = await panelTab(host, "setup");
    await p.click("Check for updates now");
    await run(host, 500);
    assert.match(text(p), /oxp3-tool 0\.4\.4\nVersion 0\.4\.6 is available/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("problem report facts: JSON within the Code node's limit (F10)", async () => {
  const host = await start();
  try {
    const p = await panelTab(host, "setup");
    assert.ok(cards(p).includes("oxp3-tool-diagnose:"));
    const facts = codes(p).find((c) => c.startsWith("{"));
    const j = JSON.parse(facts);
    assert.equal(j.oxp3deck, "0.7.0");
    assert.equal(j.provider.name, "oxp3-hw");
    assert.ok(new TextEncoder().encode(facts).length <= 4000);
    clean(host);
  } finally {
    await host.stop();
  }
});

// ---- review findings -------------------------------------------------------------------------------

test("the boot marker's line is shown only when it is one of oxp3-tool's commands; odd characters never break the tab", async () => {
  for (const [marker, line] of [["limine-update\u0085\n", null], ["grub-mkconfig -o /boot/grub/grub.cfg\n", "sudo grub-mkconfig -o /boot/grub/grub.cfg"], ["curl x | sh\n", null]]) {
    const host = await start({ fixtures: oxp3Fixtures({ systemFiles: sys({ "/run/oxp3-tool-boot-entries-unfinished": marker }) }) });
    try {
      const q = await open(host, "quickAccessTab", "qam");
      assert.match(text(q), /Do not reboot yet/, JSON.stringify(marker));
      assert.ok(cards(q).includes("boot-entries:"));
      assert.deepEqual(codes(q).filter((c) => c.startsWith("sudo ")), line ? [line] : [], JSON.stringify(marker));
      clean(host);
    } finally {
      await host.stop();
    }
  }
});

test("Device fixes in Quick Access: a closed group shows fixes that need attention; no oxp3-tool yet: its install card (Quick.tsx fixesAlert)", async () => {
  const state = JSON.stringify({ schema: 1, fixes: { gyro: { applied_at: null, tool_version: "0.4.4", kargs: [] }, buttons: { applied_at: "2026-11-02T10:00:00+00:00", tool_version: "0.4.4", kargs: [] } } });
  let host = await start({ fixtures: oxp3Fixtures({ systemFiles: sys({ "/var/lib/oxp3-tool/state.json": state }) }) });
  try {
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /Fixes need attention \(1\)/);
    clean(host);
  } finally {
    await host.stop();
  }
  host = await start({ fixtures: oxp3Fixtures({ systemFiles: { "/proc/cmdline": "root=UUID=x rw\n" }, storage: { ui: { v: 1, groups: { fixes: true } } } }) });
  try {
    const q = await open(host, "quickAccessTab", "qam");
    assert.ok(cards(q).includes("oxp3-tool-install:"), cards(q).join(" "));
    assert.match(text(q), /oxp3-tool not seen yet/);
    clean(host);
  } finally {
    await host.stop();
  }
});
