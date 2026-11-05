// Tests for src/effects.ts. Run from the repository root: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import {
  confirmLine, EFFECT_TEXT, EFFECTS, effectText, fixEffect, pendingText, PENDING_TEXT, strongest,
} from "../../src/effects.ts";

const SRC = new URL("../../src/", import.meta.url);
const tsx = () => {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(new URL(dir, SRC), { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${dir}${e.name}/`);
      else if (/\.tsx?$/.test(e.name)) out.push(`${dir}${e.name}`);
    }
  };
  walk("");
  return out;
};

test("every setting id the frontend uses has a tag", () => {
  let n = 0;
  for (const name of tsx()) {
    const s = readFileSync(new URL(name, SRC), "utf8");
    for (const m of s.matchAll(/EFFECTS\["([^"]+)"\]/g)) {
      n++;
      assert.ok(Object.prototype.hasOwnProperty.call(EFFECTS, m[1]), `${name}: EFFECTS["${m[1]}"] is not in effects.ts`);
    }
    for (const m of s.matchAll(/effect=\{?"([a-z][\w.-]*)"/g)) {
      assert.ok(Object.prototype.hasOwnProperty.call(EFFECTS, m[1]) || m[1] in EFFECT_TEXT, `${name}: effect "${m[1]}"`);
    }
  }
  assert.ok(n > 40, `only ${n} uses found`);
});

test("the table of DESIGN.md", () => {
  for (const id of ["power.enable", "power.pl1", "power.cpu_max_pct", "power.soc", "power.gpu_profile", "power.cpu_min_pct",
    "power.cpu_caps", "power.epp_split", "power.poll_s", "extras.fan", "extras.scx", "extras.lpmd", "extras.charge_limit",
    "extras.charge_behaviour", "fix.buttons", "oxp3.install", "reboot", "xess.remove_folder"]) assert.equal(EFFECTS[id], "now", id);
  for (const id of ["fix.gyro", "fix.nvme-resume", "fix.xe-dsb-off", "fix.nvme-resume.any_ssd", "kernel.try", "kernel.keep"]) {
    assert.equal(EFFECTS[id], "reboot", id);
  }
  assert.equal(EFFECTS["fix.oled-profile"], "session");
  for (const id of ["game.xess", "game.fsr", "game.auto", "auto.global", "xess.driver", "xess.shim"]) assert.equal(EFFECTS[id], "game", id);
  assert.deepEqual(EFFECTS["xess.install"], ["idle", "session"]);
});

test("effectText, confirmLine and the pending texts", () => {
  assert.equal(effectText("now"), "Now");
  assert.equal(effectText(["idle", "session"]), "Only while no game runs · Log out of Game Mode or reboot");
  assert.equal(confirmLine("game"), "Takes effect: Restart the game.");
  assert.equal(pendingText("now"), null);
  assert.equal(pendingText("idle"), null);
  assert.equal(pendingText("game", "Cyberpunk 2077"), "Restart Cyberpunk 2077 to apply");
  assert.equal(pendingText("game"), PENDING_TEXT.game);
  assert.equal(pendingText(["idle", "session"]), "Log out of Game Mode or reboot to apply");
  assert.equal(pendingText("reboot"), "Reboot to apply");
});

test("fixEffect: the table for every fixture fix, the text for an unknown one", () => {
  const list = JSON.parse(readFileSync(new URL("../fixtures/oxp3/list.json", import.meta.url), "utf8"));
  const want = { buttons: "now", "xbox-key": "now", "volume-keys": "now", gyro: "reboot", "inputplumber-suspend": "now",
    "nvme-resume": "reboot", "oled-profile": "session", "xe-panel-replay-off": "reboot", "xe-hdr-backlight": "reboot", "xe-dsb-off": "reboot" };
  const fixes = list.fixes ?? list.catalog?.fixes;
  assert.ok(fixes.length >= 10);
  for (const f of fixes) assert.equal(fixEffect(f), want[f.id], f.id);
  assert.equal(fixEffect({ id: "new-thing", takes_effect: "after reboot" }), "reboot");
  assert.equal(fixEffect({ id: "new-thing", takes_effect: "next time Game Mode starts" }), "session");
  assert.equal(fixEffect({ id: "new-thing", takes_effect: "immediately" }), "now");
  assert.equal(fixEffect({ id: "new-thing" }), "now");
});

test("strongest: reboot > session > game > now, idle kept alongside", () => {
  assert.equal(strongest([]), "now");
  assert.equal(strongest(["now", "game"]), "game");
  assert.equal(strongest(["game", "reboot", "session"]), "reboot");
  assert.equal(strongest(["session", "now"]), "session");
  assert.deepEqual(strongest([["idle", "session"], "game"]), ["idle", "session"]);
  assert.deepEqual(strongest(["idle"]), ["idle", "now"]);
});
