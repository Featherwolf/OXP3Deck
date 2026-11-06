# Adapted from ClawDeck (MIT, Copyright (c) 2026 IHulkSmashI and ClawDeck contributors). See THIRD_PARTY_NOTICES.md.
"""main.py loaded the way Decky loads it (a stub `decky` module, then exec of the file), with fake feature modules:
every call answers a dict with ok, jobs start one at a time, settings are whitelisted, and the frontend's
src/api.ts names exactly the backend's methods."""
import asyncio
import importlib.util
import inspect
import json
import logging
import os
import re
import tempfile
import threading
import time
import types
import unittest
from unittest import mock

from oxp3deck import sysexec
from tests import stub_decky

PLUGIN = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN = os.path.join(PLUGIN, "main.py")
API_TS = os.path.join(PLUGIN, "src", "api.ts")

# One plausible call per public method; test_every_method_is_covered keeps it complete.
CALLS = {
    "get_overview": (), "oxp3_status": (), "oxp3_catalog": (), "oxp3_plan": (["buttons"], {"home": "guide"}),
    "oxp3_apply": (["buttons"], {}), "oxp3_revert": (["buttons"],), "oxp3_kernel": (),
    "oxp3_kernel_try": ("linux-cachyos-deckify-vsw",), "oxp3_kernel_keep": (), "oxp3_diagnose": (),
    "oxp3_update_check": (), "oxp3_install": ("bundled",), "xess_state": (), "xess_check_update": (),
    "xess_install": (), "xess_uninstall": (), "xess_set_driver": ("26.3",), "xess_shim_system_protons": (),
    "xess_remove_folder": ("/home/jordan/xess-old",), "game_info": ("1091500",), "job_status": (None,),
    "job_list": (), "reboot": (), "get_setting": ("ui_tab",), "set_setting": ("ui_tab", "fixes"),
    "power_info": (False,), "power_state": (), "power_enable": (True,), "power_options": ({"split_ac": True},),
    "power_set": ("default", "main", {"pl1_w": 15}), "power_profile": ("1091500", "Cyberpunk 2077", True),
    "power_game": ("1091500",), "power_take_control": (), "power_import_sdtdp": (),
    "power_fix": ("ppd",), "power_unfix": ("ppd",), "power_live": (), "extras_info": (),
    "extras_set": ({"lpmd_game_off": True},), "extras_take_control": ("fan",),
    "opti_info": ("292030",), "opti_install": ("292030", {"upscaler": "xess", "fg": 2, "fg_input": "dlssg"}),
    "opti_set": ("292030", {"upscaler": "fsr31", "fg": 3, "fg_input": "dlssg"}), "opti_remove": ("292030",),
    "opti_update": ("292030",), "opti_options": ({"overlay": True},),
}


def quiet(test):
    """The errors main.py logs on purpose here would fill the test output."""
    logger = logging.getLogger("oxp3deck")
    level = logger.level
    logger.setLevel(logging.CRITICAL)
    test.addCleanup(logger.setLevel, level)


def load_main(tmpdir):
    stub_decky.install(tmpdir)
    saved = dict(os.environ)
    try:
        spec = importlib.util.spec_from_file_location("oxp3deck_main_under_test", MAIN)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
    finally:
        os.environ.clear()
        os.environ.update(saved)   # main.py scrubs Decky's loader variables at import
    return mod


class Raising:
    """A feature module whose every function raises."""

    def __getattr__(self, name):
        def boom(*args, **kwargs):
            raise RuntimeError(f"boom in {name}")
        return boom


def call(plugin, name, *args):
    return asyncio.run(getattr(plugin, name)(*args))


def wait_idle(plugin, timeout=10):
    end = time.monotonic() + timeout
    while plugin.jobs.running() is not None and time.monotonic() < end:
        time.sleep(0.01)
    return plugin.jobs.running() is None


def public_methods(cls):
    return sorted(n for n, v in vars(cls).items() if not n.startswith("_") and inspect.iscoroutinefunction(v))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(stub_decky.uninstall)
        quiet(self)
        self.m = load_main(self.tmp.name)
        # nothing real runs (runuser, oxp3-tool, sysfs writes) unless a test says so (and Plugin()'s _after_restart
        # leaves the real /run alone)
        for name in ("oxp3tool", "xess", "games", "power", "readouts", "extras", "optiscaler"):
            setattr(self.m, name, Raising())
        self.p = self.m.Plugin()
        self.assertIsNone(self.p._broken)
        self.p.ctx = stub_decky.make_ctx(self.tmp.name)   # uid 1000 and a fake root for /etc, /sys, /proc
        self.addCleanup(wait_idle, self.p)

    def fake(self, name, **fns):
        mod = types.SimpleNamespace(**fns)
        setattr(self.m, name, mod)
        return mod


class AlwaysAnswersTest(Base):
    def test_every_method_is_covered(self):
        self.assertEqual(public_methods(self.m.Plugin), sorted(CALLS))

    def test_raising_modules_still_give_a_dict(self):
        for name, args in CALLS.items():
            res = call(self.p, name, *args)
            self.assertTrue(wait_idle(self.p))
            if name == "get_setting":
                self.assertIsNone(res)
                continue
            self.assertIsInstance(res, dict, name)
            self.assertIn("ok", res, name)
            json.dumps(res)
            if name == "get_overview":   # every part falls back to its default
                self.assertTrue(res["ok"])
                self.assertEqual(res["xess"]["line"], "XeSS state unknown: boom in summary")
                self.assertFalse(res["oxp3"]["installed"])
                continue
            if res.get("job"):           # no precheck: the job itself failed
                job = call(self.p, "job_status", res["job"]["id"])["job"]
                self.assertEqual(job["state"], "failed", name)
                self.assertIn("RuntimeError: boom in", job["error"])
                continue
            if name in ("job_status", "job_list", "set_setting"):
                self.assertTrue(res["ok"], name)
                continue
            self.assertFalse(res["ok"], name)
            self.assertTrue(res["error"].startswith(name + ": "), (name, res["error"]))

    def test_a_module_that_did_not_load(self):
        self.m.games = None
        self.m._BROKEN["games"] = "SyntaxError: invalid syntax (games.py, line 3)"
        res = call(self.p, "game_info", "1091500")
        self.assertEqual(res, {"ok": False, "error": "game_info: the games module did not load: SyntaxError: "
                                                     "invalid syntax (games.py, line 3)"})

    def test_bad_results_become_errors(self):
        self.fake("oxp3tool", status=lambda ctx: ["not", "a", "dict"])
        self.assertEqual(call(self.p, "oxp3_status"), {"ok": False, "error": "oxp3_status: returned list, not a dict"})
        self.fake("xess", state=lambda ctx, settings: {"ok": 1, "when": object()})
        res = call(self.p, "xess_state")
        self.assertIs(res["ok"], True)
        self.assertIsNone(res["error"])
        self.assertTrue(res["when"].startswith("<object object"))

    def test_work_runs_off_the_event_loop(self):
        seen = []
        self.fake("oxp3tool", status=lambda ctx: seen.append(threading.current_thread()) or {"ok": True,
                                                                                              "status": {}})
        call(self.p, "oxp3_status")
        self.assertIsNot(seen[0], threading.main_thread())


class BrokenStartTest(unittest.TestCase):
    def test_every_call_says_why(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.addCleanup(stub_decky.uninstall)
        quiet(self)
        m = load_main(tmp.name)
        m.decky.DECKY_USER_HOME = ""
        p = m.Plugin()
        self.assertIn("DECKY_USER_HOME is not set", p._broken)
        for name, args in CALLS.items():
            res = call(p, name, *args)
            if name == "get_setting":
                self.assertIsNone(res)
                continue
            self.assertFalse(res["ok"], name)
            self.assertIn("the plugin could not start: RuntimeError: context: DECKY_USER_HOME is not set",
                          res["error"])
        asyncio.run(p._main())       # logs and returns
        asyncio.run(p._unload())
        asyncio.run(p._uninstall())


class JobsTest(Base):
    def test_start_one_at_a_time_and_status(self):
        go = threading.Event()
        seen = {}

        def apply(ctx, job, fixes, opts):
            seen["args"] = (fixes, opts)
            job.say("applying")
            go.wait(10)
            return {"ok": True, "error": None, "outcome": {"reboot_needed": True}}

        self.fake("oxp3tool", apply_args=lambda ctx, fixes, opts: (["apply", *fixes], None), apply=apply,
                  check_fixes=lambda ctx, fixes, what: (fixes, None), rebuild_unfinished=lambda ctx: None,
                  installed=lambda ctx: dict(self.m.NO_OXP3))
        res = call(self.p, "oxp3_apply", ["buttons", "volume-keys"], {"home": "guide"})
        self.assertTrue(res["ok"], res)
        job = res["job"]
        self.assertEqual((job["kind"], job["title"], job["state"]), ("oxp3-apply", "Apply buttons, volume-keys",
                                                                     "running"))
        again = call(self.p, "oxp3_revert", ["buttons"])
        self.assertEqual(again, {"ok": False, "error": "another task is running: Apply buttons, volume-keys",
                                 "job": None})
        self.assertEqual(call(self.p, "get_overview")["job"]["id"], job["id"])
        self.assertIn("is running", call(self.p, "reboot")["error"])
        go.set()
        self.assertTrue(wait_idle(self.p))
        done = call(self.p, "job_status", job["id"])
        self.assertEqual((done["ok"], done["job"]["state"], done["job"]["log"]), (True, "done", ["applying"]))
        self.assertEqual(seen["args"], (["buttons", "volume-keys"], {"home": "guide"}))
        self.assertEqual(call(self.p, "job_status", None)["job"]["id"], job["id"])   # the newest
        self.assertEqual([j["id"] for j in call(self.p, "job_list")["jobs"]], [job["id"]])
        self.assertEqual(call(self.p, "job_status", "nope"), {"ok": False, "error": "job_status: no task nope",
                                                              "job": None})
        self.assertTrue(call(self.p, "get_overview")["reboot_pending"])   # the outcome asked for a reboot

    def test_a_revert_that_needs_a_reboot_is_noted(self):
        self.fake("oxp3tool", check_fixes=lambda ctx, fixes, what: (fixes, None), rebuild_unfinished=lambda ctx: None,
                  installed=lambda ctx: dict(self.m.NO_OXP3),
                  revert=lambda ctx, job, fixes: {"ok": True, "error": None, "outcome": {"reboot_needed": True}})
        self.assertFalse(call(self.p, "get_overview")["reboot_pending"])
        self.assertTrue(call(self.p, "oxp3_revert", ["nvme-resume"])["ok"])
        self.assertTrue(wait_idle(self.p))
        self.assertTrue(call(self.p, "get_overview")["reboot_pending"])

    def test_a_refused_precheck_starts_nothing(self):
        self.fake("oxp3tool", apply_args=lambda ctx, fixes, opts: (None, "apply: unknown fix nope"),
                  check_kernel_package=lambda pkg: "kernel try: '-x' is not a package name")
        self.assertEqual(call(self.p, "oxp3_apply", ["nope"], {}),
                         {"ok": False, "error": "apply: unknown fix nope", "job": None})
        self.assertFalse(call(self.p, "oxp3_kernel_try", "-x")["ok"])
        res = call(self.p, "oxp3_install", "somewhere")
        self.assertEqual(res["error"], "oxp3_install: source must be 'bundled' or 'online', not 'somewhere'")
        self.assertEqual(call(self.p, "job_list")["jobs"], [])

    def test_optiscaler_jobs(self):
        """Bad choices and check()'s refusals start no job; the job gets the arguments; opti_set and
        opti_options wait for an OptiScaler job."""
        from oxp3deck import optiscaler as real
        go = threading.Event()
        seen = {}

        def install(ctx, settings, job, appid, choices):
            seen["install"] = (appid, choices)
            go.wait(10)
            return {"ok": True, "error": None}
        why = {"value": None}
        self.fake("optiscaler", entry=real.entry, check_choices=real.check_choices,
                  check=lambda ctx, appid, installing: {"ok": why["value"] is None, "error": why["value"],
                                                        "why": why["value"]},
                  install=install, set_choices=lambda ctx, appid, choices, settings: {"ok": True, "opti": None},
                  options=lambda ctx, opts: {"ok": True, "opti": None},
                  remove=lambda ctx, settings, job, appid: {"ok": True},
                  info=lambda ctx, appid, settings: {"ok": True, "opti": {"appid": appid}})
        bad = call(self.p, "opti_install", "292030", {"upscaler": "dlss", "fg": 2})
        self.assertEqual((bad["ok"], bad["job"]), (False, None))
        self.assertIn("unknown upscaler", bad["error"])
        why["value"] = "Quit The Witcher 3 first."
        self.assertEqual(call(self.p, "opti_remove", "292030"),
                         {"ok": False, "error": "Quit The Witcher 3 first.", "job": None})
        self.assertEqual(call(self.p, "job_list")["jobs"], [])
        why["value"] = None
        res = call(self.p, "opti_install", "292030", {"upscaler": "xess", "fg": 2})
        self.assertTrue(res["ok"], res)
        self.assertEqual((res["job"]["kind"], res["job"]["title"]), ("opti-install", "OptiScaler for The Witcher 3"))
        busy = call(self.p, "opti_set", "292030", {"upscaler": "xess", "fg": 0})
        self.assertEqual(busy["error"], "opti_set: OptiScaler for The Witcher 3 is running; try again when it has "
                                        "ended")
        self.assertFalse(call(self.p, "opti_options", {"overlay": True})["ok"])
        self.assertTrue(call(self.p, "opti_info", "292030")["ok"])        # info answers during the job
        go.set()
        self.assertTrue(wait_idle(self.p))
        self.assertEqual(seen["install"], ("292030", {"upscaler": "xess", "fg": 2}))
        self.assertTrue(call(self.p, "opti_set", "292030", {"upscaler": "xess", "fg": 0})["ok"])
        self.assertTrue(call(self.p, "opti_options", {"overlay": True})["ok"])

    def test_xess_calls_wait_for_an_xess_job(self):
        go = threading.Event()
        self.fake("xess", install=lambda ctx, settings, job: {"ok": go.wait(10)},
                  set_driver=lambda ctx, settings, prefix: {"ok": True, "drivers": []})
        self.assertTrue(call(self.p, "xess_install")["ok"])
        res = call(self.p, "xess_set_driver", "26.3")
        self.assertEqual(res["error"], "xess_set_driver: Install xess-xmx-linux is running; switch the driver when "
                                       "it has ended")
        go.set()
        self.assertTrue(wait_idle(self.p))
        self.assertTrue(call(self.p, "xess_set_driver", "26.3")["ok"])


class LifecycleTest(Base):
    def test_main_shims_the_system_protons_again(self):
        shimmed = threading.Event()

        def shim(ctx, settings, job):
            job.say("shimmed")
            shimmed.set()
            return {"ok": True, "error": None, "done": ["proton-cachyos-slr"], "failed": []}

        self.fake("xess", system_protons_need_shim=lambda ctx, settings: True, shim_system_protons=shim)
        asyncio.run(self.p._main())
        self.assertTrue(shimmed.wait(10))
        self.assertTrue(wait_idle(self.p))
        jobs = call(self.p, "job_list")["jobs"]
        self.assertEqual([(j["kind"], j["state"]) for j in jobs], [("xess-reshim", "done")])

    def test_main_carries_on_after_an_error(self):
        self.fake("xess", system_protons_need_shim=lambda ctx, settings: False)
        asyncio.run(self.p._main())
        self.m.xess = Raising()
        asyncio.run(self.p._main())
        self.assertEqual(call(self.p, "job_list")["jobs"], [])

    def watch(self, seconds, **fns):
        """_main, then `seconds` of the power watch loop, then _unload: (the task, how many ticks ran)."""
        ticks = []
        fake = self.fake("power", tick=lambda ctx: ticks.append(ctx) or {"ok": True, "did": "nothing"})
        for k, v in fns.items():
            setattr(fake, k, v)
        self.fake("xess", system_protons_need_shim=lambda ctx, settings: False)

        async def go():
            with mock.patch.object(self.m, "POWER_TICK_S", 0.01):
                await self.p._main()
                task = self.p._watch
                self.assertIsNotNone(task)
                await asyncio.sleep(seconds)
                done_early = task.done()
                await self.p._unload()
                await asyncio.sleep(0.05)
                return task, done_early

        task, done_early = asyncio.run(go())
        self.assertTrue(task.done())
        self.assertIsNone(self.p._watch)
        return task, done_early, ticks

    def test_main_starts_the_power_watch_and_unload_stops_it(self):
        from oxp3deck import power
        self.assertEqual(self.m.POWER_TICK_S, power.TICK_S)
        task, done_early, ticks = self.watch(0.3)
        self.assertFalse(done_early)
        self.assertTrue(task.cancelled())
        self.assertGreater(len(ticks), 2)
        self.assertIs(ticks[0], self.p.ctx)

    def test_a_raising_tick_does_not_end_the_loop(self):
        calls = []

        def tick(ctx):
            calls.append(1)
            raise RuntimeError("sysfs went away")

        task, done_early, _ticks = self.watch(0.3, tick=tick)
        self.assertFalse(done_early)
        self.assertGreater(len(calls), 2)

    def test_a_power_module_that_did_not_load_ends_the_loop(self):
        self.m.power = None
        self.m.extras = None                     # neither part is left
        self.fake("xess", system_protons_need_shim=lambda ctx, settings: False)

        async def go():
            with mock.patch.object(self.m, "POWER_TICK_S", 0.01):
                await self.p._main()
                task = self.p._watch
                await asyncio.sleep(0.1)
                return task

        task = asyncio.run(go())
        self.assertTrue(task.done())
        self.assertFalse(task.cancelled())

    def test_power_calls_answer_while_a_job_runs(self):
        go = threading.Event()
        self.addCleanup(go.set)
        self.fake("xess", install=lambda ctx, settings, job: {"ok": go.wait(10)})
        self.fake("power", state=lambda ctx: {"ok": True, "error": None, "state": {"enabled": True}},
                  set_values=lambda ctx, key, slot, values: {"ok": True, "error": None, "state": None,
                                                             "applied": {"written": [key, slot]}})
        self.assertTrue(call(self.p, "xess_install")["ok"])
        self.assertEqual(call(self.p, "power_state")["state"], {"enabled": True})
        self.assertEqual(call(self.p, "power_set", "default", "main", {"pl1_w": 15})["applied"]["written"],
                         ["default", "main"])
        go.set()

    def test_power_info_takes_a_boolean(self):
        seen = []
        self.fake("power", info=lambda ctx, refresh: seen.append(refresh) or {"ok": True, "info": None})
        for value, want in ((True, True), (False, False), ("yes", False), (None, False)):
            call(self.p, "power_info", value)
            self.assertIs(seen[-1], want)

    def run_watch(self, seconds, power=None, extras=None):
        """_main, `seconds` of the watch loop, _unload, with the given fake modules (None: not loaded)."""
        self.m.power, self.m.extras = power, extras
        self.fake("xess", system_protons_need_shim=lambda ctx, settings: False)

        async def go():
            with mock.patch.object(self.m, "POWER_TICK_S", 0.01):
                await self.p._main()
                task = self.p._watch
                await asyncio.sleep(seconds)
                done_early = task.done()
                await self.p._unload()
                return done_early

        return asyncio.run(go())

    def test_extras_tick_after_power_tick(self):
        order = []
        act = {"key": "default", "slot": "main", "app": None, "ac": False, "enabled": True, "values": {}}
        power = types.SimpleNamespace(tick=lambda ctx: order.append("power"),
                                      active=lambda ctx: order.append("active") or act,
                                      refresh=lambda ctx: order.append("refresh") or {"ok": True})
        seen = []

        def tick(ctx, active):
            seen.append(active)
            order.append("extras")
            return {"ok": True, "did": [], "lpmd_changed": len(seen) == 2}

        extras = types.SimpleNamespace(tick=tick, unload=lambda ctx: order.append("unload"))
        self.assertFalse(self.run_watch(0.3, power, extras))
        self.assertEqual(order[:6], ["power", "active", "extras", "power", "active", "extras"])
        self.assertEqual(order[6], "refresh")                 # the second tick changed intel_lpmd
        self.assertEqual(order.count("refresh"), 1)
        self.assertIs(seen[0], act)
        self.assertEqual(order[-1], "unload")

    def test_a_raising_or_missing_extras_keeps_power_going(self):
        ticks = []
        power = types.SimpleNamespace(tick=lambda ctx: ticks.append(1), active=lambda ctx: None,
                                      refresh=lambda ctx: None)
        self.assertFalse(self.run_watch(0.2, power, Raising()))
        self.assertGreater(len(ticks), 2)
        ticks.clear()
        self.assertFalse(self.run_watch(0.2, power, None))
        self.assertGreater(len(ticks), 2)

    def test_a_hung_extras_step_does_not_stop_the_power_tick(self):
        gate = threading.Event()
        self.addCleanup(gate.set)
        ticks, seen = [], []
        power = types.SimpleNamespace(tick=lambda ctx: ticks.append(1), active=lambda ctx: None,
                                      refresh=lambda ctx: None)
        extras = types.SimpleNamespace(tick=lambda ctx, active: seen.append(1) or gate.wait(10) or {"ok": True},
                                       unload=lambda ctx: None)
        with self.assertLogs("oxp3deck", "WARNING"):
            self.assertFalse(self.run_watch(0.3, power, extras))
        gate.set()
        self.assertGreater(len(ticks), 5)
        self.assertEqual(len(seen), 1)                  # not started again while it hangs

    def test_extras_go_on_without_power(self):
        seen = []
        extras = types.SimpleNamespace(tick=lambda ctx, active: seen.append(active) or {"ok": True},
                                       unload=lambda ctx: None)
        self.assertFalse(self.run_watch(0.2, None, extras))
        self.assertGreater(len(seen), 2)
        self.assertEqual(set(map(type, seen)), {type(None)})   # no power module: no active profile
        seen.clear()
        self.assertFalse(self.run_watch(0.2, Raising(), extras))
        self.assertGreater(len(seen), 2)

    def test_unload_puts_the_extras_back_within_its_budget(self):
        done = []
        self.fake("extras", unload=lambda ctx: done.append(ctx))
        asyncio.run(self.p._unload())
        self.assertEqual(done, [self.p.ctx])
        slow = threading.Event()
        self.addCleanup(slow.set)
        self.fake("extras", unload=lambda ctx: slow.wait(5))
        async def timed():
            start = time.monotonic()
            await self.p._unload()               # asyncio.run itself waits for the executor thread afterwards
            return time.monotonic() - start

        with mock.patch.object(self.m, "UNLOAD_EXTRAS_S", 0.05):
            loop = asyncio.new_event_loop()
            try:
                self.assertLess(loop.run_until_complete(timed()), 2)
            finally:
                slow.set()
                loop.close()

    def test_power_changes_sync_the_extras(self):
        answer = {"ok": True, "error": None, "state": {"enabled": True}, "applied": None}
        act = {"key": "1091500", "app": "1091500", "values": {"fan_mode": "quiet"}}
        refreshed = []
        self.fake("power", set_values=lambda ctx, key, slot, values: dict(answer), enable=lambda ctx, on: dict(answer),
                  options=lambda ctx, opts: dict(answer), profile=lambda ctx, appid, name, on: dict(answer),
                  game=lambda ctx, appid: dict(answer), take_control=lambda ctx: dict(answer),
                  active=lambda ctx: act, refresh=lambda ctx: refreshed.append(1))
        synced = []
        self.fake("extras", sync=lambda ctx, active: synced.append(active) or {"ok": True, "lpmd_changed": True})
        for name in ("power_set", "power_enable", "power_options", "power_profile", "power_game",
                     "power_take_control"):
            self.assertEqual(call(self.p, name, *CALLS[name]), answer, name)
        self.assertEqual(synced, [act] * 6)
        self.assertEqual(len(refreshed), 6)
        self.m.extras = Raising()                               # a raising sync never changes the power answer
        self.assertEqual(call(self.p, "power_set", *CALLS["power_set"]), answer)
        self.m.extras = None
        self.assertEqual(call(self.p, "power_game", "1091500"), answer)

    def test_extras_calls(self):
        state = {"fan": {"ours": None}}
        synced = []
        self.fake("power", active=lambda ctx: {"key": "default", "values": {}}, refresh=lambda ctx: None)
        self.fake("extras", info=lambda ctx: {"ok": True, "error": None, "extras": dict(state)},
                  set_options=lambda ctx, opts: {"ok": True, "error": None, "extras": {"old": True}},
                  take_control=lambda ctx, what: {"ok": what == "fan", "error": None if what == "fan" else "what?",
                                                  "extras": {"old": True}},
                  sync=lambda ctx, active: synced.append(active) or {"ok": True})
        self.fake("readouts", sample=lambda ctx: {"ok": True, "error": None, "live": {"package_w": 18.4}})
        self.assertEqual(call(self.p, "extras_info"), {"ok": True, "error": None, "extras": state})
        self.assertEqual(call(self.p, "extras_set", {"lpmd_game_off": True})["extras"], state)   # after the sync
        self.assertEqual(call(self.p, "extras_take_control", "fan")["extras"], state)
        self.assertEqual(call(self.p, "extras_take_control", "x")["extras"], {"old": True})
        self.assertEqual(len(synced), 3)
        self.assertEqual(call(self.p, "power_live")["live"], {"package_w": 18.4})

    def test_unload_and_uninstall_change_nothing(self):
        with mock.patch.object(sysexec, "run", side_effect=AssertionError("ran a program")):
            self.assertIsNone(asyncio.run(self.p._unload()))
            self.assertIsNone(asyncio.run(self.p._uninstall()))


class OverviewTest(Base):
    def write(self, path, text):
        p = self.p.ctx.sys_path(path)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(text)

    def setUp(self):
        super().setUp()
        self.inst = {"installed": True, "path": "/usr/local/bin/oxp3-tool", "version": "0.4.1", "json_ok": True,
                     "min_version": "0.4.1", "bundled_version": "0.4.1"}
        self.marker = None
        self.fake("oxp3tool", installed=lambda ctx: self.inst, rebuild_unfinished=lambda ctx: self.marker,
                  status=lambda ctx: {"ok": True, "error": None, "status": {"reboot_pending": self.pending}})
        self.summary = {"installed": True, "version": "20261031", "status": "ok", "line": "ok 2026-11-01",
                        "live": True, "relogin_needed": False}
        self.fake("xess", summary=lambda ctx, settings: self.summary)
        self.pending = False

    def test_the_fallback_install_names_the_real_minimum(self):
        """NO_OXP3 (shown when oxp3tool.py did not load) keeps Oxp3Install's keys and oxp3tool's MIN_VERSION."""
        from oxp3deck import oxp3tool
        from tests.test_xess import ts_fields
        self.assertEqual(self.m.NO_OXP3["min_version"], oxp3tool.MIN_VERSION_TEXT)
        self.assertEqual(sorted(self.m.NO_OXP3), sorted(self.inst))
        self.assertEqual(set(self.m.NO_OXP3), ts_fields("Oxp3Install"))    # what the frontend reads

    def test_fields(self):
        self.write("/etc/os-release", 'NAME="CachyOS Linux"\nID=cachyos\nID_LIKE=arch\n')
        self.write("/sys/class/dmi/id/sys_vendor", "ONE-NETBOOK\n")
        self.write("/sys/class/dmi/id/product_name", "ONEXPLAYER 3\n")
        self.marker = "limine-mkinitcpio"
        res = call(self.p, "get_overview")
        self.assertEqual(res, {"ok": True, "error": None, "plugin_version": "0.1.0", "user": "jordan",
                               "home": self.p.ctx.home, "platform": "cachyos",
                               "device": {"vendor": "ONE-NETBOOK", "product": "ONEXPLAYER 3", "supported": True},
                               "oxp3": self.inst, "xess": self.summary, "job": None, "reboot_pending": False,
                               "do_not_reboot": "limine-mkinitcpio", "power": None})   # power: Raising
        line = {"ok": True, "error": None, "enabled": True, "line": "15 W / 25 W · Default", "overridden": False,
                "blocked": None}
        self.fake("power", summary=lambda ctx: line)
        self.assertEqual(call(self.p, "get_overview")["power"], line)

    def test_platforms_and_devices(self):
        for text, want in (("ID=bazzite\nID_LIKE=\"fedora\"\n", "bazzite"), ("ID=custom\nID_LIKE=\"bazzite fedora\"\n",
                                                                            "bazzite"),
                           ("ID=fedora\n", None), ("ID=arch\n", None)):
            self.write("/etc/os-release", text)
            self.assertEqual(call(self.p, "get_overview")["platform"], want, text)
        self.write("/etc/pacman.conf", "[options]\n\n[cachyos-v3]\nInclude = x\n")
        self.assertEqual(call(self.p, "get_overview")["platform"], "cachyos")
        self.write("/sys/class/dmi/id/sys_vendor", "MSI\n")
        self.write("/sys/class/dmi/id/product_name", "Claw 8 AI+ A2VM\n")
        self.assertEqual(call(self.p, "get_overview")["device"],
                         {"vendor": "MSI", "product": "Claw 8 AI+ A2VM", "supported": False})

    def test_reboot_pending_comes_from_the_last_status_of_this_boot(self):
        self.write("/proc/sys/kernel/random/boot_id", "boot-1\n")
        self.pending = True
        self.assertTrue(call(self.p, "oxp3_status")["ok"])
        self.assertTrue(call(self.p, "get_overview")["reboot_pending"])
        self.pending = False
        call(self.p, "oxp3_status")
        self.assertFalse(call(self.p, "get_overview")["reboot_pending"])
        self.pending = True
        call(self.p, "oxp3_status")
        self.p._boot = None
        self.write("/proc/sys/kernel/random/boot_id", "boot-2\n")   # rebooted since
        self.assertFalse(call(self.p, "get_overview")["reboot_pending"])


class RebootTest(Base):
    def setUp(self):
        super().setUp()
        self.marker = None
        self.tool_busy = False
        self.fake("oxp3tool", rebuild_unfinished=lambda ctx: self.marker, tool_running=lambda ctx: self.tool_busy)
        self.fake("xess", script_running=lambda ctx: None)
        self.runs = []

        def run(argv, **kw):
            self.runs.append((argv, kw))
            return sysexec.Result(0, "", "")

        for name, value in (("run", run), ("which", lambda name: "/usr/bin/" + name)):
            p = mock.patch.object(sysexec, name, value)
            p.start()
            self.addCleanup(p.stop)

    def test_reboot(self):
        self.assertEqual(call(self.p, "reboot"), {"ok": True, "error": None})
        argv, kw = self.runs[0]
        self.assertEqual(argv, ["/usr/bin/systemctl", "reboot"])
        self.assertTrue(kw["start_new_session"])

    def test_not_while_a_rebuild_is_unfinished(self):
        self.marker = "limine-mkinitcpio"
        res = call(self.p, "reboot")
        self.assertFalse(res["ok"])
        self.assertIn("do not reboot", res["error"])
        self.assertIn("`sudo limine-mkinitcpio`", res["error"])
        self.assertEqual(self.runs, [])

    def test_not_while_oxp3_tool_runs(self):
        """RT-2: an oxp3-tool run that outlived a plugin restart holds its lock; no job of ours runs."""
        self.tool_busy = True
        self.marker = "limine-mkinitcpio"
        res = call(self.p, "reboot")
        self.assertEqual(res, {"ok": False, "error": "reboot: oxp3-tool is still running; reboot when it has ended"})
        self.assertEqual(self.runs, [])

    def test_not_while_an_xess_script_from_before_a_restart_runs(self):
        """RS-3: install.sh outlives a plugin restart (RT-1); a reboot would cut it off half done."""
        self.fake("xess", script_running=lambda ctx: "bash /home/jordan/x/install.sh")
        res = call(self.p, "reboot")
        self.assertEqual(res, {"ok": False, "error": "reboot: an xess-xmx-linux script is still running (bash "
                                                     "/home/jordan/x/install.sh); reboot when it has ended"})
        self.assertEqual(self.runs, [])
        self.fake("xess", script_running=lambda ctx: None)
        self.assertTrue(call(self.p, "reboot")["ok"])
        self.m.xess = None                      # the module did not load: the other checks still decide
        self.assertTrue(call(self.p, "reboot")["ok"])

    def test_systemctl_failure(self):
        failed = sysexec.Result(1, "", "Call to Reboot failed: Access denied\n")
        with mock.patch.object(sysexec, "run", lambda argv, **kw: failed):
            res = call(self.p, "reboot")
        self.assertEqual(res["error"], "reboot: systemctl reboot: Call to Reboot failed: Access denied")


class RestartTest(Base):
    """_after_restart: what an earlier plugin process left behind (RT-2)."""

    def setUp(self):
        super().setUp()
        self.busy = False
        self.fake("oxp3tool", tool_running=lambda ctx: self.busy)
        self.script = "bash /home/jordan/x/install.sh"     # xess.script_running: one from before still runs
        self.fake("xess", script_running=lambda ctx: self.script)
        folder = os.path.join(self.p.ctx.runtime_dir, "jobs")
        for jid, kind in (("1-apply", "oxp3-apply"), ("2-install", "oxp3-install"), ("3-xess", "xess-install")):
            with open(os.path.join(folder, jid + ".json"), "w") as f:
                json.dump({"id": jid, "kind": kind, "title": kind, "state": "running", "started": 1}, f)
        self.run_dir = sysexec.run_dir(self.p.ctx)
        self.files = ["apply-20261104-120000-abcdef.out", "apply-20261104-120000-abcdef.err",
                      "kernel-try-20261104-120001-0a1b2c.out", "oxp3-diagnose-20261104-120002-123456.tar.gz",
                      "user-20261104-120003-abcdef.log", "xess-script.json", "notes.out"]
        for name in self.files:
            open(os.path.join(self.run_dir, name), "w").close()

    def restart(self):
        with mock.patch.object(self.m.context, "from_decky", lambda: stub_decky.make_ctx(self.tmp.name)):
            p = self.m.Plugin()
        self.assertIsNone(p._broken)
        return {j.id: j.error for j in p.jobs.recent()}

    def test_oxp3_tool_still_running(self):
        self.busy = True
        errors = self.restart()
        self.assertEqual(errors, {"1-apply": self.m.OXP3_STILL_RUNNING, "2-install": self.m.jobs.INTERRUPTED,
                                  "3-xess": self.m.jobs.INTERRUPTED})
        self.assertEqual(self.restart()["1-apply"], self.m.OXP3_STILL_RUNNING)    # saved
        self.assertEqual(sorted(os.listdir(self.run_dir)), sorted(self.files))  # its files stay while it runs

    def test_nothing_runs_any_more(self):
        self.script = None
        errors = self.restart()
        self.assertEqual(set(errors.values()), {self.m.jobs.INTERRUPTED})
        self.assertEqual(sorted(os.listdir(self.run_dir)), ["notes.out", "xess-script.json"])

    def test_a_scripts_output_stays_while_it_runs(self):
        """A detached xess-xmx-linux script's user-*.log goes only once that script has ended (xess.script_running
        removes its record then); oxp3-tool's files go by oxp3-tool's lock alone."""
        self.restart()
        self.assertEqual(sorted(os.listdir(self.run_dir)),
                         ["notes.out", "user-20261104-120003-abcdef.log", "xess-script.json"])

    def test_a_failing_tidy_up_does_not_stop_the_start(self):
        self.m.oxp3tool = Raising()
        self.m.xess = Raising()
        self.assertEqual(set(self.restart().values()), {self.m.jobs.INTERRUPTED})
        self.assertEqual(sorted(os.listdir(self.run_dir)), sorted(self.files))


class AnswerTest(Base):
    """RT-3: Decky encodes every answer as UTF-8; a lone surrogate (a file name that is not UTF-8) would make it
    drop the answer, and the frontend's call would never settle."""

    def sendable(self, res):
        json.dumps(res, ensure_ascii=False).encode("utf-8")     # what Decky does (sandboxed_plugin, localsocket)

    def test_a_path_that_is_not_utf8(self):
        bad = os.fsdecode(b"/games/Mods\x93Japanese\x94/libxess.dll")
        self.fake("games", game_info=lambda ctx, settings, appid: {"ok": True, "game": {"dlls": [{"path": bad}]}})
        res = call(self.p, "game_info", "1091500")
        self.sendable(res)
        self.assertEqual(res["game"]["dlls"][0]["path"], "/games/Mods?Japanese?/libxess.dll")
        self.fake("oxp3tool", status=lambda ctx: {"ok": True, bad: [bad], "status": {}})
        self.sendable(call(self.p, "oxp3_status"))

    def test_in_an_error(self):
        bad = os.fsdecode(b"/home/jordan/\xff")

        def boom(ctx, settings):
            raise OSError(f"cannot read {bad}")

        def unavailable(ctx, settings):
            raise self.m.Unavailable(f"no {bad}")

        for fn, want in ((boom, "xess_state: OSError: cannot read /home/jordan/?"),
                         (unavailable, "xess_state: no /home/jordan/?")):
            self.fake("xess", state=fn)
            res = call(self.p, "xess_state")
            self.sendable(res)
            self.assertEqual(res, {"ok": False, "error": want})

    def test_a_setting(self):
        self.p.settings.set("ui_name", "a\udc93b")      # settings.json may say "\udc93"
        res = call(self.p, "get_setting", "ui_name")
        self.sendable(res)
        self.assertEqual(res, "a?b")


class SettingsTest(Base):
    def test_whitelist(self):
        for key, value in (("xess_driver", "26.3"), ("xess_driver", None), ("xess_shim_system", True),
                           ("ui_tab", "fixes"), ("ui_open", {"kernel": False, "list": [1, 2]})):
            self.assertEqual(call(self.p, "set_setting", key, value), {"ok": True, "error": None}, key)
            self.assertEqual(call(self.p, "get_setting", key), value)
        for key, value, why in (("xess_package", "/tmp/x", "not a setting the frontend may use"),
                                ("ui_", 1, "not a setting"), ("ui_a-b", 1, "not a setting"), (7, 1, "not a setting"),
                                ("xess_shim_system", "yes", "xess_shim_system cannot be str"),
                                ("xess_driver", "../../x", "not a driver version"),
                                ("ui_big", "x" * 5000, "more than 4096 bytes"),
                                ("ui_nan", float("nan"), "not a JSON value"),
                                ("ui_obj", object(), "not a JSON value")):
            res = call(self.p, "set_setting", key, value)
            self.assertFalse(res["ok"], key)
            self.assertIn(why, res["error"])
        self.assertIsNone(call(self.p, "get_setting", "xess_package"))
        with open(os.path.join(self.p.ctx.settings_dir, "settings.json")) as f:
            self.assertEqual(json.load(f)["ui_tab"], "fixes")   # Decky's copy of the plugin settings folder

    def test_ui_keys_are_limited(self):
        for i in range(self.m.MAX_UI_KEYS):
            self.assertTrue(call(self.p, "set_setting", f"ui_k{i}", i)["ok"])
        self.assertIn("more than", call(self.p, "set_setting", "ui_one_more", 1)["error"])
        self.assertTrue(call(self.p, "set_setting", "ui_k0", "changed")["ok"])   # an existing one may change


class WiringTest(unittest.TestCase):
    def test_api_ts_and_main_name_the_same_methods(self):
        if not os.path.isfile(API_TS):
            self.skipTest("src/api.ts does not exist yet (the frontend is written separately)")
        with open(API_TS) as f:
            names = re.findall(r'callable<.*?>\(\s*"([A-Za-z0-9_]+)"\s*\)', f.read())
        with open(MAIN) as f:
            main = f.read()
        self.assertTrue(names)
        for name in names:
            self.assertIn(f"async def {name}(self", main, f"api.ts calls {name}, main.py has no such method")
        public = re.findall(r"^    async def ([a-z][A-Za-z0-9_]*)\(self", main, re.M)
        self.assertEqual(sorted(public), sorted(set(names)), "every public backend method is in api.ts")
        self.assertEqual(len(names), len(set(names)))

    def test_main_calls_the_real_modules_with_their_signatures(self):
        """Every `_mod("name").fn(...)` (and `x.fn(...)` after `x = _mod("xess")`) in main.py names a function the
        real module has, with as many arguments as it takes: the other tests use fake modules."""
        import importlib
        with open(MAIN) as f:
            main = f.read()
        calls = re.findall(r'_mod\("(\w+)"\)\.(\w+)\(([^()]*)\)', main)
        calls += [("xess", fn, args) for fn, args in re.findall(r"\bx\.(\w+)\(([^()]*)\)", main)]
        self.assertGreater(len(calls), 25)
        for modname, fn, args in calls:
            mod = importlib.import_module("oxp3deck." + modname)
            self.assertTrue(hasattr(mod, fn), f"main.py calls {modname}.{fn}, which does not exist")
            n = len([a for a in args.split(",") if a.strip()])
            try:
                inspect.signature(getattr(mod, fn)).bind(*([None] * n))
            except TypeError as e:
                self.fail(f"main.py calls {modname}.{fn} with {n} arguments: {e}")


if __name__ == "__main__":
    unittest.main()
