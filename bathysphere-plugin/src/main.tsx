// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * OXP3 Deck for Bathysphere: power limits, GPU, CPU, fan and charging for the ONEXPLAYER 3 through
 * its hardware helper, per-game XeSS launch options, and guided oxp3-tool and xess-xmx-linux setup.
 * This file wires the surfaces, the host events and the background schedule together.
 */
import { definePlugin, host, log } from "@bathysphere/sdk";
import { redraw } from "./core/redraw";
import type { Stored } from "./core/storage";
import { info, onAc, onBattery, onOxp3 } from "./device/info";
import { hw, onHardwareChanged } from "./hw/knobs";
import { auto, onStarted, onStopped } from "./games/autosetup";
import { forgetFacts } from "./games/files";
import { pendingLaunch } from "./games/launch";
import { appName, library, setRunning, started, stopped } from "./games/running";
import { xessLog } from "./games/xesslog";
import { advisorStore, restartWindow } from "./power/advisor";
import { conflicts, power, profiles, turnedOff } from "./power/apply";
import { interruptTask, selftest } from "./power/selftest";
import { afterExit, startSchedule, syncLive, syncTips } from "./schedule";
import { renderGameSection } from "./ui/gameSection";
import { renderPanel } from "./ui/panel";
import { prefs } from "./ui/prefs";
import { renderQam } from "./ui/qam";
import { updates } from "./updates/check";
import { xess, xessRecord } from "./xess/detect";

/** Every stored value (Setup & updates lists the ones a newer version saved). */
const STORES: ReadonlyArray<Stored<unknown>> = [power, prefs, auto, xessLog, pendingLaunch, advisorStore, selftest, updates, xessRecord, turnedOff] as ReadonlyArray<Stored<unknown>>;

function listen(): void {
  host.events.on("app.started", ({ appid }) => {
    started(appid);
    void prefs.save({ ...prefs.value, lastGame: { appid, name: appName(appid) } });
    onStarted(appid);
    interruptTask("a game started");
    restartWindow();
    syncTips();
    redraw();
  });
  host.events.on("app.stopped", ({ appid }) => {
    stopped(appid);
    forgetFacts(appid);
    void onStopped(appid);
    afterExit(appid);
    syncTips();
    redraw();
  });
  host.events.on("steam.apps.running", ({ appids }) => {
    setRunning(appids);
    syncTips();
    redraw();
  });
  host.events.on("session.resume", () => {
    hw.invalidate();
    conflicts.invalidate();
    xess.invalidate();
    restartWindow();
    redraw();
  });
  host.events.on("battery.changed", (b) => {
    onBattery(b);
    redraw();
  });
  host.events.on("power.ac", ({ online }) => {
    onAc(online);
    interruptTask("the charger changed");
    hw.invalidate();
    redraw();
  });
  host.events.on("hardware.changed", ({ knob, reason }) => {
    onHardwareChanged(knob, reason);
    profiles.invalidate();
    redraw();
  });
}

export default definePlugin({
  async activate() {
    await Promise.all(STORES.map((s) => s.load()));
    await info.load();
    try {
      const cur = await host.steam.apps.current();
      if (cur) started(cur.appid);
    } catch (e) {
      log.warn(`steam.apps.current: ${e instanceof Error ? e.message : String(e)}`);
    }
    void library.load();
    listen();
    startSchedule();
    log.info(`OXP3 Deck started on ${info.value ? `${info.value.vendor} ${info.value.board}` : "an unknown device"}${onOxp3() ? "" : " (not an ONEXPLAYER 3: no hardware calls)"}`);
  },

  // Nothing is written here: the hardware helper ties the fan and charging pause to Bathysphere's
  // lease and restores them itself, and Steam's sustained power stays as Steam set it.
  deactivate() {},

  quickAccessTabs: {
    qam: async (ctx) => {
      const tree = await renderQam(ctx);
      syncLive();
      return tree;
    },
  },
  panels: {
    main: async (ctx) => {
      const tree = await renderPanel(ctx, STORES);
      syncLive();
      return tree;
    },
  },
  gamePageSections: {
    game: (ctx) => renderGameSection(ctx),
  },

  onSettingsChanged() {
    syncTips();
  },
});
