// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// XeSS fast mode (xess-xmx-linux) and the update checks: installed, live, log out needed, failed
// check and repair, not installed with the install card, the update card with exact lines, old
// folders, the default driver, release rows; GitHub redirect, API fallback, rate limit, offline
// retry, the setting off, the daily schedule (F3, G1–G12, G17, G20, J1–J5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { BrokerError, findAll } from "../.bathysphere/packages/fake-host/dist/index.js";
import { clean, open, oxp3Fixtures, panelTab, redirectRoute as redirect, run, start, text, toolRoute as tool, XESS_API, XESS_ENV, XESS_HOME, XESS_PKG, XESS_REPO as REPO } from "./fixtures.mjs";

const cards = (s) => findAll(s.tree, { type: "instructions" }).map((n) => `${n.id}:${(n.steps ?? []).join(",")}`);
const codes = (s) => findAll(s.tree, { type: "code" }).map((n) => n.text);

test("installed and live: state, driver check, services, uninstall line, release rows (G1–G5, G11, G20)", async () => {
  const host = await start();
  try {
    const p = await panelTab(host, "xess");
    const t = text(p);
    assert.match(t, /XeSS fast mode: On \(20261031\)\nDriver Mesa 26\.3\.0-rc2/);
    assert.match(t, /Driver check\nPassed \(2026-11-01 09:26:46\)/);
    assert.match(t, /Services\nDriver check enabled · watcher active/);
    assert.match(t, /Release older than 20261104/);
    assert.ok(cards(p).includes("xess-manage:2,4"));
    assert.ok(codes(p).includes(`bash '${XESS_PKG}'/uninstall.sh`) || codes(p).some((c) => c.includes("uninstall.sh")), codes(p).join("\n"));
    assert.ok(cards(p).includes("ge-proton:"), "games on a system Proton: the GE-Proton card");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("log out needed when Steam still runs with the old driver setting (G4)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ env: { session: XESS_ENV.session, steam: {} } }) });
  try {
    const p = await panelTab(host, "xess");
    assert.match(text(p), /XeSS fast mode: Log out needed/);
    assert.match(text(p), /Log out of Game Mode and back in/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("failed driver check: repair with the exact line (G3, G10)", async () => {
  const home = { ...XESS_HOME, ".cache/xess-xmx/driver-status": `FAILED 2026-11-02 08:00:01 ${XESS_PKG}/lib/mesa-26.3.0-rc2/libvulkan_intel.so: device lost\n` };
  const host = await start({ fixtures: oxp3Fixtures({ home }) });
  try {
    const p = await panelTab(host, "xess");
    assert.match(text(p), /XeSS fast mode: Off\nThe fast driver failed its check/);
    assert.match(text(p), /Driver check\nFAILED: device lost/);
    assert.ok(cards(p).includes("xess-manage:0,4"));
    assert.ok(codes(p).includes(`cd '${XESS_PKG}' && bash install.sh`));
    clean(host);
  } finally {
    await host.stop();
  }
});

test("not installed: the tools and install cards; the install lines once the newest tag is known (G8, G12, G15)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ home: {}, env: { session: {}, steam: {} }, units: {}, net: { routes: [redirect("20261104"), tool("0.4.4")] } }) });
  try {
    const p = await panelTab(host, "xess");
    assert.match(text(p), /XeSS fast mode: Off\nNot installed/);
    assert.ok(cards(p).includes("xess-tools:"));
    assert.ok(cards(p).includes("xess-install:"));
    assert.match(text(p), /Newest release not known yet/);
    await p.click("Check for updates now");
    await run(host, 500);
    assert.ok(codes(p).some((c) => c.includes("releases/download/20261104/xess-xmx-linux-20261104.zip")), codes(p).join("\n"));
    clean(host);
  } finally {
    await host.stop();
  }
});

test("update available: the redirect's tag, the update card with both folders, the closed header (G9, J2, J5)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ net: { routes: [redirect("20261104"), tool("0.4.5")] } }) });
  try {
    const p = await panelTab(host, "xess");
    await p.click("Check for updates now");
    await run(host, 500);
    assert.match(text(p), /Update to 20261104\nInstalled: 20261031/);
    assert.ok(cards(p).includes("xess-update:"));
    const line = codes(p).find((c) => c.includes("20261104") && c.includes("uninstall.sh"));
    assert.ok(line, codes(p).join("\n"));
    assert.match(text(p), /Last update check\nxess-xmx-linux 20261104 · oxp3-tool 0.4.5/);
    const u = host.state.storage.get("updates");
    assert.equal(u.xess, "20261104");
    assert.equal(u.oxp3, "0.4.5");
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(q.find({ key: "g-xess" }).subtitle, /Update available|20261104/);
    assert.match(q.find({ key: "g-fixes" }).subtitle, /Update available/);
    assert.deepEqual(host.state.fetches.map((f) => f.method + " " + new URL(f.url).host), ["GET api.github.com", "HEAD github.com"], "no host that serves user content");
    assert.equal(host.state.fetches[0].headers.accept, "application/vnd.github.raw+json");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("API fallback, GitHub's rate limit, offline (G12)", async () => {
  const api = (response) => ({ url: XESS_API, response });
  const noRedirect = { url: `${REPO}/releases/latest`, method: "HEAD", response: { status: 200 } };
  let host = await start({ fixtures: oxp3Fixtures({ net: { routes: [noRedirect, api({ status: 200, body: { tag_name: "20261104" } }), tool("0.4.4")] } }) });
  try {
    const p = await panelTab(host, "xess");
    await p.click("Check for updates now");
    await run(host, 500);
    assert.equal(host.state.storage.get("updates").xess, "20261104");
    assert.equal(host.state.fetches.find((f) => f.url === XESS_API).headers.accept, "application/vnd.github+json");
    clean(host);
  } finally {
    await host.stop();
  }
  host = await start({ fixtures: oxp3Fixtures({ net: { routes: [noRedirect, api({ status: 403, body: { message: "rate limited" } }), tool("0.4.4")] } }) });
  try {
    const p = await panelTab(host, "xess");
    await p.click("Check for updates now");
    await run(host, 500);
    assert.match(text(p), /Update check\nGitHub is limiting requests/);
    clean(host);
  } finally {
    await host.stop();
  }
  host = await start({ fixtures: oxp3Fixtures({ net: { routes: [] } }) });
  try {
    const p = await panelTab(host, "xess");
    await p.click("Check for updates now");
    await run(host, 500);
    const u = host.state.storage.get("updates");
    assert.ok(u.retryAt > u.lastTry, "offline: try again in an hour");
    assert.equal(u.lastOk, null);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("update checks off: nothing leaves the device (J3, §5.4 when)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ settings: { checkUpdates: false }, net: { routes: [redirect("20261104"), tool("0.4.5")] } }) });
  try {
    const p = await panelTab(host, "xess");
    await p.click("Check for updates now");
    await run(host, 500);
    assert.match(text(p), /Turn on update checks first/);
    await run(host, 30 * 60_000, 60_000);
    assert.deepEqual(host.state.fetches, []);
    assert.equal(host.callsTo("net.fetch").length, 0);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("daily schedule: first check 3 min after start, not while a game runs, then after 24 h (J1)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ net: { routes: [redirect("20261104"), tool("0.4.4")] } }) });
  try {
    await host.launchGame(570);
    await run(host, 15 * 60_000, 60_000);
    assert.equal(host.state.fetches.length, 0, "never during a game");
    await host.stopGame(570);
    await run(host, 15 * 60_000, 60_000);
    assert.equal(host.state.fetches.length, 2);
    await run(host, 12 * 3600_000, 600_000);
    assert.equal(host.state.fetches.length, 2, "once a day");
    await run(host, 13 * 3600_000, 600_000);
    assert.equal(host.state.fetches.length, 4);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("old release folders and the default driver (G6, G7, G17)", async () => {
  const old = "/home/deck/.local/share/oxp3deck/xess/xess-xmx-linux-20261020";
  const host = await start({ fixtures: oxp3Fixtures({ storage: { xess: { v: 1, seen: [old, XESS_PKG], preferredDriver: null } } }) });
  try {
    const p = await panelTab(host, "xess");
    assert.match(text(p), /Old release 20261020: nothing uses it/);
    assert.ok(cards(p).includes("xess-manage:3"));
    assert.ok(codes(p).includes(`rm -rf '${old}'`));
    await p.change({ label: "Default driver for every game" }, "26.3.0-rc2");
    await host.settle();
    assert.equal(host.state.storage.get("xess").preferredDriver, "26.3.0-rc2");
    assert.ok(cards(p).includes("xess-manage:1,4"));
    assert.ok(codes(p).includes(`cd '${XESS_PKG}' && bash tools/switch-driver.sh 26.3`));
    clean(host);
  } finally {
    await host.stop();
  }
});

// ---- review findings -------------------------------------------------------------------------------

test("an optional file that cannot be read never hides XeSS's state; the compile log's end keeps its lines", async () => {
  let host = await start({ fixtures: oxp3Fixtures({ home: { ...XESS_HOME, ".cache/xess-xmx/compile.log": "x".repeat(600 * 1024) } }) });
  try {
    const p = await panelTab(host, "xess");
    assert.match(text(p), /XeSS fast mode: On \(20261031\)/, "a compile log over 512 KiB is left out");
    clean(host);
  } finally {
    await host.stop();
  }
  host = await start({ fixtures: oxp3Fixtures({ home: { ...XESS_HOME, ".cache/xess-xmx/compile.log": "line one\nline two\r\nkernel ok\n" } }) });
  try {
    const p = await panelTab(host, "xess");
    const row = p.find({ label: "Driver check" });
    assert.match(row.details.body, /Compile log \(end\):\nline one\nline two\nkernel ok/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a failed XeSS read shows why with Retry instead of Reading… (Quick.tsx Problem)", async () => {
  const responders = { "session.env.read": () => { throw new BrokerError("EINTERNAL", "systemd user manager not answering"); } };
  const host = await start({ fixtures: oxp3Fixtures({ responders }) });
  try {
    const p = await panelTab(host, "xess");
    await run(host, 12_000, 2000);
    assert.match(text(p), /XeSS fast mode: not read\nSomething went wrong|XeSS fast mode: not read\nsystemd user manager not answering/);
    delete responders["session.env.read"];
    await p.click({ type: "button", label: "Retry" });
    await run(host, 1000);
    assert.match(text(p), /XeSS fast mode: On/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("the proton-cachyos driver store bug shows on CachyOS for releases up to 20261104 (xessoffer.ts)", async () => {
  const host = await start();
  try {
    const p = await panelTab(host, "xess");
    assert.match(text(p), /Known bug: proton-cachyos driver store/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Bazzite: the rpm-ostree tools card, and no pacman install card for the hardware helper (xess.py _how_to_get)", async () => {
  const device = { os: { id: "bazzite", name: "Bazzite", version: "43" }, provider: null, knobs: { boost: null, epp: null, cpuLimits: null, socBalance: null, gpuRange: null, fan: null, chargeBehaviour: null } };
  const host = await start({ fixtures: oxp3Fixtures({ device, home: {}, env: { session: {}, steam: {} }, units: {} }) });
  try {
    const x = await panelTab(host, "xess");
    assert.ok(cards(x).includes("xess-tools-bazzite:"));
    assert.ok(!cards(x).includes("xess-tools:"));
    const p = await panelTab(host, "power");
    assert.match(text(p), /packaged for CachyOS only/);
    assert.ok(!cards(p).some((c) => c.startsWith("hw-install")));
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a failed check is tried again after an hour, not a day (updates.py due)", async () => {
  const noRedirect = { url: `${REPO}/releases/latest`, method: "HEAD", response: { status: 200 } };
  const routes = [noRedirect, { url: XESS_API, response: { status: 429, body: { message: "slow down" } } }, tool("0.4.4")];
  const host = await start({ fixtures: oxp3Fixtures({ net: { routes } }) });
  try {
    await run(host, 4 * 60_000, 60_000);
    assert.equal(host.state.fetches.length, 3, "the first check after 3 min");
    const u = host.state.storage.get("updates");
    assert.equal(u.lastOk, null, "a partly failed check does not count for the day");
    assert.ok(Math.abs(u.retryAt - u.lastTry - 3600_000) < 5000, "retry in an hour");
    routes[1] = { url: XESS_API, response: { status: 200, body: { tag_name: "20261104" } } };
    await run(host, 70 * 60_000, 10 * 60_000);
    assert.equal(host.state.fetches.length, 6, "again after an hour");
    assert.equal(host.state.storage.get("updates").xess, "20261104");
    assert.ok(host.state.storage.get("updates").lastOk !== null);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a stored check time that lies ahead does not stop the daily check", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: { updates: { v: 1, lastOk: 9e15, lastTry: 9e15, retryAt: 9e15 } }, net: { routes: [redirect("20261104"), tool("0.4.4")] } }) });
  try {
    await run(host, 30 * 60_000, 60_000);
    assert.equal(host.state.fetches.length, 2);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("Check for updates now on a slow network: the handler answers at once, one check at a time", async () => {
  const slow = (r) => ({ ...r, delayMs: 20_000 });
  const routes = [slow(tool("0.4.4")), slow({ url: `${REPO}/releases/latest`, method: "HEAD", response: { status: 200 } }), slow({ url: XESS_API, response: { status: 200, body: { tag_name: "20261104" } } })];
  const host = await start({ fixtures: oxp3Fixtures({ net: { routes } }) });
  try {
    const p = await panelTab(host, "xess");
    await p.click("Check for updates now");
    await host.settle();
    assert.match(text(p), /Update check\nChecking…/);
    assert.equal(p.find({ label: "Check for updates now" }).disabled, true);
    await p.click("Check for updates now").catch(() => {}); // disabled while it runs: a second tap starts nothing
    await run(host, 60_000, 1000);
    assert.equal(host.state.fetches.length, 2, "oxp3-tool's request, then github.com's (the API is not asked after a timeout); no second check");
    assert.ok(host.callsTo("net.fetch").every((c) => c.params.timeoutMs === 10_000), "each request gives up after 10 s");
    assert.match(text(p), /Update check\nNo answer in time/);
    assert.deepEqual(host.problems, [], "no late reply to ui.event");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("GitHub's odd answers: a broken redirect falls back to the API; an HTML page is not a release", async () => {
  const broken = { url: `${REPO}/releases/latest`, method: "HEAD", response: { status: 302, headers: { location: `${REPO}/releases/tag/%E0%A4%A` } } };
  let host = await start({ fixtures: oxp3Fixtures({ net: { routes: [broken, { url: XESS_API, response: { status: 200, body: { tag_name: "20261104" } } }, tool("0.4.4")] } }) });
  try {
    const p = await panelTab(host, "xess");
    await p.click("Check for updates now");
    await run(host, 1000);
    assert.equal(host.state.storage.get("updates").xess, "20261104");
    clean(host);
  } finally {
    await host.stop();
  }
  const html = { url: XESS_API, response: { status: 200, headers: { "content-type": "text/html" }, body: "<!DOCTYPE html><html>busy</html>" } };
  host = await start({ fixtures: oxp3Fixtures({ net: { routes: [{ url: `${REPO}/releases/latest`, method: "HEAD", response: { status: 200 } }, html, tool("0.4.4")] } }) });
  try {
    const p = await panelTab(host, "xess");
    await p.click("Check for updates now");
    await run(host, 1000);
    assert.match(text(p), /Update check\nGitHub answered something that is not a release/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("network not granted while the setting is on: says so, not 'turn on update checks'", async () => {
  const manifest = JSON.parse(readFileSync(new URL("../dist/manifest.json", import.meta.url), "utf8"));
  const host = await start({ granted: manifest.permissions.filter((p) => p !== "network"), fixtures: oxp3Fixtures({ net: { routes: [redirect("20261104"), tool("0.4.4")] } }) });
  try {
    const p = await panelTab(host, "xess");
    await p.click("Check for updates now");
    await run(host, 1000);
    assert.match(text(p), /Update check\nBathysphere did not grant network access/);
    assert.doesNotMatch(text(p), /Turn on update checks first/);
    clean(host);
  } finally {
    await host.stop();
  }
});
