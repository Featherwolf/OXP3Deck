// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// Cross-cutting behaviour: protected stored values (newer or damaged), remembered UI choices,
// section error boundaries, toasts, running-game tracking, and unloading without writes (A7, A8,
// A12, A14, A15, A17, B5, B8, I10).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BrokerError } from "../.bathysphere/packages/fake-host/dist/index.js";
import { clean, hardwareState, hwWrites, open, oxp3Fixtures, panelTab, run, start, text } from "./fixtures.mjs";

test("a value saved by a newer version is read-only until Start fresh; edits do not overwrite it (A14, I10)", async () => {
  const newer = { v: 99, enabled: true, futureField: 1 };
  const host = await start({ fixtures: oxp3Fixtures({ storage: { power: newer, auto: { v: 7, on: true } }, dialogs: { confirm: [true, true] } }) });
  try {
    const p = await panelTab(host, "setup");
    assert.match(text(p), /Power profiles: read-only/);
    assert.match(text(p), /Saved by a newer OXP3 Deck \(data version 99\)/);
    assert.ok(p.find({ label: "Start automatic setup fresh" }) || p.find({ label: /^Start .* fresh$/ }));
    await p.change({ type: "tabs" }, "power");
    await host.settle();
    await p.change({ label: "Power control" }, false);
    await run(host, 1000);
    assert.deepEqual(host.state.storage.get("power"), newer, "not overwritten");
    await p.change({ type: "tabs" }, "setup");
    await host.settle();
    await p.click("Start power profiles fresh");
    await run(host, 500);
    assert.equal(host.state.storage.get("power")?.v ?? 1, 1);
    assert.doesNotMatch(text(p), /Power profiles: read-only/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("damaged values are normalised field by field; the tab choice is remembered across restarts (A12, A14)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: { ui: { v: 1, tab: "nonsense", groups: { cpu: "yes", live: true } }, power: { v: 1, enabled: "on", profiles: { default: { main: { boostW: 9999 } } } } } }) });
  try {
    let p = await open(host, "panel", "main");
    assert.equal(p.find({ type: "tabs" }).value, "power");
    assert.match(text(p), /Power control: off/);
    await p.change({ type: "tabs" }, "xess");
    await host.settle();
    assert.equal(host.state.storage.get("ui").tab, "xess");
    await host.restart();
    p = await open(host, "panel", "main");
    assert.equal(p.find({ type: "tabs" }).value, "xess");
    const q = await open(host, "quickAccessTab", "qam");
    assert.ok(q.find({ key: "g-live" }).defaultOpen, "the open groups too");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("one section failing draws its error; the rest still renders (A8)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ responders: { "steam.apps.launchOptions.get": () => ({ text: "", managed: null, warnings: null }) } }) });
  try {
    const g = await open(host, "gamePageSection", "game", { appid: 292030 });
    assert.equal(g.errorCard, undefined);
    assert.ok(g.find({ type: "callout", title: "This game: this section hit an error" }));
    await host.launchGame(292030);
    const q = await open(host, "quickAccessTab", "qam");
    assert.ok(q.find({ type: "callout", title: /This game: this section hit an error/ }));
    assert.ok(q.find({ key: "g-power" }), "the other groups render");
    assert.match(text(q), /All settings: OXP3 Deck in Bathysphere Home/);
    assert.ok(host.pluginLogs("error").every((l) => /^section /.test(l.msg)));
    assert.deepEqual(host.problems, []);
  } finally {
    await host.stop();
  }
});

test("toasts for changes made in the background (A7)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: { auto: { v: 1, on: true, games: {} } } }) });
  try {
    await host.launchGame(292030);
    await host.stopGame(292030);
    await run(host, 8000, 1000);
    assert.equal(host.toasts.length, 1);
    assert.match(host.toasts[0].title, /^Set up The Witcher 3/);
    assert.ok([...host.toasts[0].title].length <= 64);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("running games from Steam's list; resume re-reads (B5, B8)", async () => {
  const host = await start();
  try {
    const q = await open(host, "quickAccessTab", "qam");
    assert.equal(q.find({ key: "g-game" }), undefined, "no game group with no game");
    await host.events.emit("steam.apps.running", { appids: [570] });
    await host.settle();
    assert.ok(q.find({ key: "g-game" }));
    assert.match(text(q), /Dota 2/);
    const n = host.callsTo("system.hardware.get").length;
    await host.events.emit("session.resume", {});
    await run(host, 3000, 1000);
    assert.ok(host.callsTo("system.hardware.get").length > n);
    assert.ok(host.pluginLogs("info").some((l) => l.msg === "OXP3 Deck started on ONE-NETBOOK ONEXPLAYER 3"), "the plugin log (A15)");
    clean(host);
  } finally {
    await host.stop();
  }
});

test("unloading writes nothing: the helper and hostd restore what they own (A17)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: { power: { v: 1, enabled: true }, ui: { v: 1, powerConfirmed: true } } }) });
  const p = await panelTab(host, "power");
  await p.change({ label: "Boost power" }, 25);
  await run(host, 2500);
  const before = hwWrites(host).length;
  await host.stop();
  assert.equal(hwWrites(host).length, before);
  assert.ok(host.invokes.some((i) => i.method === "deactivate"));
});

// ---- review findings -------------------------------------------------------------------------------

test("a damaged stored value is kept and never saved over until Start fresh (DESIGN.md: never silently wipe them)", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ storage: { auto: "garbage" }, dialogs: { confirm: [true, true] } }) });
  try {
    const p = await panelTab(host, "setup");
    assert.match(text(p), /Automatic setup: read-only/);
    assert.match(text(p), /damaged/);
    await p.change({ type: "tabs" }, "games");
    await host.settle();
    await p.change({ label: "Set up games automatically" }, true);
    await host.settle();
    assert.equal(host.state.storage.get("auto"), "garbage", "the undo records are not overwritten");
    await p.change({ type: "tabs" }, "setup");
    await host.settle();
    await p.click("Start automatic setup fresh");
    await run(host, 500);
    assert.notEqual(host.state.storage.get("auto"), "garbage");
    assert.doesNotMatch(text(p), /Automatic setup: read-only/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a full plugin storage says so, not 'too large to read'", async () => {
  const host = await start({ fixtures: oxp3Fixtures({ responders: { "storage.set": () => { throw new BrokerError("EQUOTA", "storage quota of 1 MiB exceeded"); } } }) });
  try {
    const p = await panelTab(host, "setup");
    await p.change({ type: "tabs" }, "setup");
    await host.settle();
    assert.match(text(p), /Display choices: not saved\nStorage is full/);
    assert.doesNotMatch(text(p), /Too large to read here/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("system.info that failed is read again on the next render; meanwhile its error shows with Retry", async () => {
  const responders = { "system.info": () => { throw new BrokerError("EINTERNAL", "hostd: DMI unreadable"); } };
  const host = await start({ fixtures: oxp3Fixtures({ responders }) });
  try {
    const q = await open(host, "quickAccessTab", "qam");
    assert.match(text(q), /This device: not read/);
    assert.equal(host.callsTo("system.info").length, 2, "at activation and again for the render");
    delete responders["system.info"];
    await q.click({ type: "button", label: "Retry" });
    await host.settle();
    assert.match(text(q), /ONEXPLAYER 3\nCachyOS 2026\.11/);
    clean(host);
  } finally {
    await host.stop();
  }
});

test("a slow hardware helper never makes a render miss the host's 5 s (SPEC §5.2): drawn with what is there, then again", async () => {
  let state;
  const host = await start({
    clock: "real",
    fixtures: oxp3Fixtures({
      responders: {
        "system.hardware.get": async () => {
          await new Promise((r) => setTimeout(r, 6000));
          return hardwareState(state);
        },
      },
    }),
  });
  state = host.state;
  try {
    const g = await host.render("gamePageSection", "game", { appid: 570 });
    assert.equal(g.errorCard, undefined, "the game page needs no hardware read");
    const t0 = Date.now();
    const p = await host.render("panel", "main");
    assert.ok(Date.now() - t0 < 5000, `the panel rendered in ${Date.now() - t0} ms`);
    assert.match(text(p), /Reading…/);
    await host.waitFor(() => /Power control: off/.test(text(p)), 15_000);
    assert.deepEqual(host.problems.filter((x) => x.kind === "late-reply"), []);
  } finally {
    await host.stop();
  }
});
