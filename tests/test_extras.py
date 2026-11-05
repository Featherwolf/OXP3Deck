"""extras.py against fake sysfs trees and a fake busctl / systemctl (tests/extrasfake.py)."""
import json
import logging
import os
import tempfile
import threading
import time
import unittest
from unittest import mock

from oxp3deck import extras, sysexec
from tests import extrasfake as ef
from tests import stub_decky

GAME = "1091500"
REAL_WATCH = extras._Watch
LAVD_CALL = ["/usr/bin/busctl", "--system", "--auto-start=no", "call", "org.scx.Loader", "/org/scx/Loader",
             "org.scx.Loader"]


def active(app=None, key="default", **values):
    return {"key": key, "slot": "main", "app": app, "ac": False, "enabled": True, "values": values}


class FakeWatch:
    """Stands in for extras._Watch: start() answers FakeWatch.ok."""
    ok = True
    made: list = []

    def __init__(self, ctx, st):
        self.alive = False
        self.stopped = False
        FakeWatch.made.append(self)

    def start(self):
        self.alive = FakeWatch.ok
        return FakeWatch.ok

    def stop(self):
        self.alive = False
        self.stopped = True


class Writer:
    """extras._write: records (path, text), writes the file as sysfs shows it, fails paths in `fail`."""

    def __init__(self):
        self.log: list = []
        self.fail: dict = {}

    def __call__(self, path, text):
        if path in self.fail:
            raise self.fail[path]
        self.log.append((os.path.basename(path), text))
        if os.path.basename(path) == "charge_behaviour":
            ef.set_behaviour(path, text)
        else:
            ef.put(path, text)

    def names(self):
        return [n for n, _t in self.log]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ctx = stub_decky.make_ctx(self.tmp.name)
        logger = logging.getLogger("oxp3deck")
        self.addCleanup(logger.setLevel, logger.level)
        logger.setLevel(logging.CRITICAL)
        extras._reset()
        self.addCleanup(extras._reset)
        self.bus = ef.Bus()
        self.w = Writer()
        self.now = [1000.0]
        FakeWatch.ok = True
        FakeWatch.made = []
        for target, name, value in ((sysexec, "run", self.bus), (sysexec, "which", lambda n: "/usr/bin/" + n),
                                    (extras, "_write", self.w), (extras, "_monotonic", lambda: self.now[0]),
                                    (extras, "_clock_gap", lambda: None), (extras, "_Watch", FakeWatch)):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)
        ef.board(self.ctx)

    def tick(self, act=None, step=2):
        self.now[0] += step
        res = extras.tick(self.ctx, act if act is not None else active())
        self.assertTrue(res["ok"], res)
        return res

    def info(self):
        res = extras.info(self.ctx)
        self.assertTrue(res["ok"], res)
        return res["extras"]

    def run_file(self):
        with open(os.path.join(self.ctx.sys_path(sysexec.RUN_DIR), extras.RUN_FILE)) as f:
            return json.load(f)


class GatesTest(Base):
    def test_available(self):
        ef.oxp_ec(self.ctx)
        ef.battery(self.ctx, limit=80)
        x = self.info()
        self.assertTrue(x["board_ok"])
        self.assertEqual(x["kernel"], "7.4.0-rc1-1-cachyos")
        self.assertEqual({k: x["charge"][k] for k in ("available", "why", "limit", "behaviour", "behaviours")},
                         {"available": True, "why": None, "limit": 80, "behaviour": "auto",
                          "behaviours": ["auto", "inhibit-charge-awake"]})
        self.assertEqual({k: x["fan"][k] for k in ("available", "rpm", "mode_now", "ours")},
                         {"available": True, "rpm": 2900, "mode_now": "auto", "ours": None})
        self.assertEqual(x["options"], {"charge_limit": None, "charge_behaviour": None, "lpmd_game_off": False})
        self.assertFalse(x["scx"]["shown"])
        self.assertFalse(x["lpmd"]["shown"])

    def test_other_board_or_older_kernel(self):
        ef.oxp_ec(self.ctx)
        ef.battery(self.ctx)
        ef.board(self.ctx, name="ONEXPLAYER 3 EVA")
        x = self.info()
        self.assertFalse(x["charge"]["available"])
        self.assertFalse(x["fan"]["available"])
        self.assertEqual(x["fan"]["why"], "Only on the ONEXPLAYER 3.")
        res = extras.set_options(self.ctx, {"charge_limit": 80})
        self.assertEqual(res["error"], "Only on the ONEXPLAYER 3.")
        extras._reset()
        ef.board(self.ctx, release="7.2.11-vsw")
        os.unlink(self.ctx.sys_path("/sys/class/hwmon/hwmon5/name"))
        x = self.info()
        self.assertEqual(x["charge"]["why"], "Needs Linux 7.4 or newer (this is 7.2.11-vsw).")
        self.assertEqual(x["fan"]["why"], "Needs Linux 7.4 or newer (this is 7.2.11-vsw).")
        self.assertEqual(self.w.log, [])

    def test_scx_gate(self):
        self.assertFalse(self.info()["scx"]["shown"])
        self.assertEqual(self.bus.bus_calls(), [])
        ef.sched_ext(self.ctx)
        extras._reset()
        x = self.info()["scx"]
        self.assertEqual((x["shown"], x["available"], x["scheduler"], x["mode"]), (True, True, "scx_lavd", "auto"))
        for loader, why in (({"sched": "unknown", "mode": 0, "args": []}, "No scheduler runs now."),
                            ({"sched": "scx_bpfland", "mode": 0, "args": []},
                             "Only for the LAVD scheduler; scx_bpfland runs now."),
                            (None, "The scheduler loader isn't running.")):
            self.bus.loader = loader
            extras._reset()
            x = self.info()["scx"]
            self.assertEqual((x["available"], x["why"]), (False, why))
        for argv in self.bus.bus_calls():
            self.assertEqual(argv[1:3], ["--system", "--auto-start=no"])

    def test_lpmd_shown_only_when_active(self):
        self.assertFalse(self.info()["lpmd"]["shown"])
        self.bus.lpmd_active = True
        extras._reset()
        x = self.info()["lpmd"]
        self.assertEqual((x["shown"], x["paused"], x["state"]), (True, False, "AUTO"))


class ChargeTest(Base):
    def setUp(self):
        super().setUp()
        ef.oxp_ec(self.ctx)
        self.bat = ef.battery(self.ctx)
        self.limit = os.path.join(self.bat, "charge_control_end_threshold")
        self.beh = os.path.join(self.bat, "charge_behaviour")

    def test_refused_values(self):
        for opts in ({"charge_limit": 49}, {"charge_limit": 101}, {"charge_limit": True}, {"charge_limit": "80"},
                     {"charge_behaviour": "inhibit-charge"}, {"charge_behaviour": "force-discharge"},
                     {"lpmd_game_off": 1}, {"fan": "max"}, ["charge_limit"]):
            res = extras.set_options(self.ctx, opts)
            self.assertFalse(res["ok"], opts)
            self.assertTrue(res["error"])
        self.assertIn("never set", extras.set_options(self.ctx, {"charge_behaviour": "inhibit-charge"})["error"])
        self.assertEqual(self.w.log, [])
        self.assertFalse(os.path.exists(os.path.join(self.ctx.settings_dir, extras.SETTINGS_FILE)))

    def test_written_and_read_back(self):
        res = extras.set_options(self.ctx, {"charge_limit": 80, "charge_behaviour": "inhibit-charge-awake"})
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.w.log, [("charge_control_end_threshold", "80"),
                                      ("charge_behaviour", "inhibit-charge-awake")])
        self.assertEqual((res["extras"]["charge"]["limit"], res["extras"]["charge"]["behaviour"]),
                         (80, "inhibit-charge-awake"))
        with open(os.path.join(self.ctx.settings_dir, extras.SETTINGS_FILE)) as f:
            self.assertEqual(json.load(f), {"version": 1, "charge_limit": 80,
                                            "charge_behaviour": "inhibit-charge-awake", "lpmd_game_off": False})
        self.tick()
        self.tick()
        self.assertEqual(len(self.w.log), 2)              # the same value is not written again
        self.assertEqual(self.run_file()["charge"]["limit"], 80)

    def test_first_tick_and_resume_write_again(self):
        extras.set_options(self.ctx, {"charge_limit": 80})
        extras._reset()                                  # a new plugin process
        ef.put(self.limit, 100)
        self.tick()
        self.assertEqual(ef.get(self.limit), "80")
        ef.put(self.ctx.sys_path(extras.SUSPEND_SUCCESS), 1)
        self.tick()
        ef.put(self.limit, 100)                           # the EC forgot it while asleep
        ef.put(self.ctx.sys_path(extras.SUSPEND_SUCCESS), 2)
        self.tick(step=1)
        self.assertEqual(ef.get(self.limit), "100")
        self.tick(step=3)
        self.assertEqual(ef.get(self.limit), "80")        # 3 s after the resume
        self.assertIsNone(self.info()["charge"]["overridden"]["limit"])

    def test_changed_by_someone_else(self):
        extras.set_options(self.ctx, {"charge_limit": 80})
        self.tick()
        ef.put(self.limit, 90)                            # Handheld Daemon
        self.tick(step=extras.CHARGE_CHECK_S)
        self.assertEqual(self.info()["charge"]["overridden"]["limit"], "Something else changed the charge limit")
        for _ in range(10):
            self.tick(step=extras.CHARGE_CHECK_S)
        self.assertEqual(ef.get(self.limit), "90")
        res = extras.take_control(self.ctx, "charge_limit")
        self.assertTrue(res["ok"], res)
        self.assertEqual(ef.get(self.limit), "80")
        self.assertIsNone(res["extras"]["charge"]["overridden"]["limit"])

    def test_a_write_error(self):
        self.w.fail[self.limit] = OSError(5, "Input/output error")
        res = extras.set_options(self.ctx, {"charge_limit": 80})
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "cannot set the charge limit: Input/output error")


class FanTest(Base):
    def setUp(self):
        super().setUp()
        self.ec = ef.oxp_ec(self.ctx)
        self.temp = ef.coretemp(self.ctx)
        self.en = os.path.join(self.ec, "pwm1_enable")

    def test_auto_writes_nothing_when_nothing_changed(self):
        for _ in range(3):
            self.tick(active(fan_mode="auto"))
            self.tick(active())
        self.assertEqual(self.w.log, [])
        self.assertEqual(FakeWatch.made, [])

    def test_quiet_then_max_then_auto(self):
        res = self.tick(active(fan_mode="quiet"))
        self.assertEqual(self.w.log, [("pwm1_enable", "1"), ("pwm1", "102")])
        self.assertEqual(res["did"], ["fan quiet"])
        x = self.info()["fan"]
        self.assertEqual((x["ours"], x["mode_now"], x["sleep_watch"]), ("quiet", "quiet", True))
        self.tick(active(fan_mode="quiet"))
        self.assertEqual(len(self.w.log), 2)
        self.w.log.clear()
        extras.sync(self.ctx, active(fan_mode="max"))
        self.assertEqual(self.w.log, [("pwm1_enable", "0")])
        self.w.log.clear()
        extras.sync(self.ctx, active())
        self.assertEqual(self.w.log, [("pwm1_enable", "2")])
        self.assertTrue(FakeWatch.made[0].stopped)
        self.assertIsNone(self.info()["fan"]["ours"])

    def test_hot_goes_back_to_auto_and_stays(self):
        self.tick(active(fan_mode="quiet"))
        ef.put(self.temp, 90000)
        self.w.log.clear()
        self.tick(active(fan_mode="quiet"))
        self.assertEqual(self.w.log, [("pwm1_enable", "2")])
        x = self.info()["fan"]
        self.assertEqual((x["ours"], x["reverted"]), (None, "The CPU reached 90 °C"))
        ef.put(self.temp, 50000)
        for _ in range(5):
            self.tick(active(fan_mode="quiet"))
        self.assertEqual(self.w.log, [("pwm1_enable", "2")])     # no oscillation
        self.tick(active(fan_mode="max"))                       # a fan setting change
        self.assertEqual(self.w.log[-1], ("pwm1_enable", "0"))
        self.assertIsNone(self.info()["fan"]["reverted"])

    def test_max_stays_when_hot_but_not_when_unreadable(self):
        self.tick(active(fan_mode="max"))
        ef.put(self.temp, 95000)
        self.w.log.clear()
        self.tick(active(fan_mode="max"))
        self.assertEqual(self.w.log, [])                       # Auto could slow the fan down while hot
        self.assertEqual(self.info()["fan"]["ours"], "max")
        os.unlink(self.temp)
        self.tick(active(fan_mode="max"))
        self.assertEqual(self.w.log, [("pwm1_enable", "2")])
        self.assertEqual(self.info()["fan"]["reverted"], "The temperature couldn't be read")

    def test_profile_change_lifts_a_revert(self):
        self.tick(active(fan_mode="quiet"))
        os.unlink(self.temp)
        self.tick(active(fan_mode="quiet"))
        self.assertEqual(self.info()["fan"]["reverted"], "The temperature couldn't be read")
        self.assertEqual(ef.get(self.en), "2")
        ef.coretemp(self.ctx)
        self.tick(active(GAME, key=GAME, fan_mode="quiet"))
        self.assertEqual(self.info()["fan"]["ours"], "quiet")

    def test_write_error(self):
        self.w.fail[os.path.join(self.ec, "pwm1")] = OSError(5, "Input/output error")
        self.tick(active(fan_mode="quiet"))
        x = self.info()["fan"]
        self.assertEqual(x["reverted"], "Fan control failed: back to Auto (Input/output error)")
        self.assertEqual(self.w.log, [("pwm1_enable", "1"), ("pwm1_enable", "2")])
        self.assertIsNone(x["ours"])

    def test_overridden_and_take_control(self):
        self.tick(active(fan_mode="quiet"))
        ef.put(self.en, 2)                                     # Handheld Daemon
        self.tick(active(fan_mode="quiet"))
        self.assertEqual(self.info()["fan"]["overridden"], "Something else set the fan back to Auto")
        n = len(self.w.log)
        for _ in range(5):
            self.tick(active(fan_mode="quiet"))
        self.assertEqual(len(self.w.log), n)
        extras.tick(self.ctx, active(fan_mode="quiet"))
        res = extras.take_control(self.ctx, "fan")
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["extras"]["fan"]["ours"], "quiet")
        self.assertEqual(self.w.log[n:], [("pwm1_enable", "1"), ("pwm1", "102")])

    def test_no_override_right_after_a_resume(self):
        self.tick(active(fan_mode="max"))
        ef.put(self.ctx.sys_path(extras.SUSPEND_SUCCESS), 1)
        self.tick(active(fan_mode="max"))
        ef.put(self.en, 2)                                     # the EC came back on Auto
        ef.put(self.ctx.sys_path(extras.SUSPEND_SUCCESS), 2)
        self.tick(active(fan_mode="max"), step=1)
        self.assertIsNone(self.info()["fan"]["overridden"])
        self.tick(active(fan_mode="max"), step=3)
        self.assertEqual(ef.get(self.en), "0")                 # written again after the resume delay
        self.assertIsNone(self.info()["fan"]["overridden"])

    def test_sleep_watch_that_cannot_start(self):
        FakeWatch.ok = False
        self.tick(active(fan_mode="quiet"))
        self.assertEqual(self.w.log, [])                       # nothing was changed, so nothing to put back
        self.assertEqual(self.info()["fan"]["reverted"], "Can't watch for sleep, so the fan stays on Auto")

    def test_unload_puts_auto_back(self):
        self.tick(active(fan_mode="max"))
        extras.unload(self.ctx)
        self.assertEqual(self.w.log[-1], ("pwm1_enable", "2"))
        self.assertTrue(FakeWatch.made[0].stopped)
        self.assertIsNone(self.run_file()["fan"]["ours"])


class Procs:
    """sysexec.run for the sleep watch's programs: each one runs until _killpg ends it; the monitor's on_line is
    kept to feed it lines. Anything else goes to `rest`."""

    def __init__(self, rest):
        self.rest = rest
        self.procs: dict = {}
        self.next = 100
        self.fail = set()               # program names that cannot start
        self.lock = threading.Lock()

    def __call__(self, argv, **kw):
        name = os.path.basename(argv[0])
        if not (name == "busctl" and "monitor" in argv) and name != "systemd-inhibit":
            return self.rest(argv, **kw)
        kind = "monitor" if name == "busctl" else name
        if kind in self.fail:
            return sysexec.Result(-1, "", f"{argv[0]}: cannot start")
        with self.lock:
            pid = self.next
            self.next += 1
            self.procs[pid] = {"kind": kind, "argv": list(argv), "done": threading.Event(), "on_line": kw["on_line"]}
        kw["on_start"](pid)
        self.procs[pid]["done"].wait(10)
        return sysexec.Result(143, "", "")

    def kill(self, pid):
        self.procs[pid]["done"].set()

    def running(self, kind):
        return [p for p, v in self.procs.items() if v["kind"] == kind and not v["done"].is_set()]

    def say(self, going):
        mon = self.procs[self.running("monitor")[0]]
        mon["on_line"]("not json")
        mon["on_line"](json.dumps({"type": "signal", "member": "PrepareForSleep",
                                   "payload": {"type": "b", "data": [going]}}))


class SleepWatchTest(Base):
    def setUp(self):
        super().setUp()
        self.ec = ef.oxp_ec(self.ctx)
        ef.coretemp(self.ctx)
        self.en = os.path.join(self.ec, "pwm1_enable")
        self.procs = Procs(self.bus)
        for target, name, value in ((sysexec, "run", self.procs), (extras, "_killpg", self.procs.kill),
                                    (extras, "_Watch", REAL_WATCH)):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)

    def wait(self, cond):
        end = time.monotonic() + 5
        while not cond() and time.monotonic() < end:
            time.sleep(0.01)
        self.assertTrue(cond())

    def test_before_and_after_sleep(self):
        self.tick(active(fan_mode="quiet"))
        self.assertEqual(ef.get(self.en), "1")
        self.assertEqual(len(self.procs.running("monitor")), 1)
        inh = self.procs.running("systemd-inhibit")
        self.assertEqual(len(inh), 1)
        self.assertEqual(self.procs.procs[inh[0]]["argv"],
                         ["/usr/bin/systemd-inhibit", "--what=sleep", "--mode=delay", "--who=OXP3Deck",
                          "--why=Fan back to Auto before sleep", "/usr/bin/sleep", "infinity"])
        mon = self.procs.procs[self.procs.running("monitor")[0]]["argv"]
        self.assertEqual(mon, ["/usr/bin/busctl", "--system", "--json=short", "monitor", extras.SLEEP_MATCH])
        self.assertTrue(self.info()["fan"]["sleep_watch"])
        self.procs.say(True)
        self.assertEqual(ef.get(self.en), "2")                    # before the inhibitor ends
        self.assertEqual(self.procs.running("systemd-inhibit"), [])
        self.tick(active(fan_mode="quiet"))
        self.assertEqual(ef.get(self.en), "2")                    # asleep: not written again
        self.procs.say(False)
        self.wait(lambda: len(self.procs.running("systemd-inhibit")) == 1)
        self.tick(active(fan_mode="quiet"), step=1)
        self.assertEqual(ef.get(self.en), "2")
        self.tick(active(fan_mode="quiet"), step=3)
        self.assertEqual(ef.get(self.en), "1")                    # the mode comes back after the delay
        self.assertEqual(ef.get(os.path.join(self.ec, "pwm1")), "102")
        self.assertTrue(self.info()["fan"]["sleep_watch"])
        self.tick(active())
        self.assertEqual(ef.get(self.en), "2")
        self.wait(lambda: not self.procs.running("monitor") and not self.procs.running("systemd-inhibit"))

    def test_an_inhibitor_that_cannot_start(self):
        self.procs.fail.add("systemd-inhibit")
        self.tick(active(fan_mode="max"))
        self.assertEqual(self.w.log, [])
        self.assertEqual(self.info()["fan"]["reverted"], "Can't watch for sleep, so the fan stays on Auto")
        self.wait(lambda: not self.procs.running("monitor"))

    def test_a_monitor_that_ends(self):
        self.tick(active(fan_mode="max"))
        self.assertEqual(ef.get(self.en), "0")
        self.procs.kill(self.procs.running("monitor")[0])        # busctl died
        self.wait(lambda: ef.get(self.en) == "2")                # at once, not at the next tick
        self.tick(active(fan_mode="max"))
        self.assertEqual(self.info()["fan"]["reverted"], "Can't watch for sleep, so the fan stays on Auto")
        self.wait(lambda: not self.procs.running("systemd-inhibit"))

    def test_unload_stops_it(self):
        self.tick(active(fan_mode="max"))
        extras.unload(self.ctx)
        self.assertEqual(ef.get(self.en), "2")
        self.wait(lambda: not self.procs.running("monitor") and not self.procs.running("systemd-inhibit"))


class ScxTest(Base):
    def setUp(self):
        super().setUp()
        ef.sched_ext(self.ctx)

    def switches(self):
        return [c[len(LAVD_CALL):] for c in self.bus.bus_calls() if c[:len(LAVD_CALL)] == LAVD_CALL]

    def test_mode_set_and_restored(self):
        self.tick(active(GAME, key=GAME, scx_mode="gaming"))
        self.assertEqual(self.switches(), [["SwitchScheduler", "su", "scx_lavd", "1"]])
        self.assertEqual(self.bus.loader["mode"], 1)
        self.assertEqual(self.info()["scx"]["ours"], "gaming")
        for _ in range(10):
            self.tick(active(GAME, key=GAME, scx_mode="gaming"))
        self.assertEqual(len(self.switches()), 1)
        props = [c for c in self.bus.bus_calls() if "get-property" in c]
        self.assertEqual(props[0], ["/usr/bin/busctl", "--system", "--auto-start=no", "--json=short", "get-property",
                                    "org.scx.Loader", "/org/scx/Loader", "org.scx.Loader", "CurrentScheduler"])
        self.assertLess(len(props), 20)                          # read at most every 10 s
        self.tick(active())
        self.assertEqual(self.switches()[-1], ["SwitchScheduler", "su", "scx_lavd", "0"])
        self.assertIsNone(self.info()["scx"]["ours"])
        for c in self.bus.bus_calls():
            self.assertEqual(c[1:3], ["--system", "--auto-start=no"])
            self.assertFalse({"StartScheduler", "StopScheduler", "RestartScheduler", "RestoreDefault"} & set(c))

    def test_restored_with_its_own_arguments(self):
        self.bus.loader = {"sched": "scx_lavd", "mode": 0, "args": ["--slice-us", "5000", "--autopower"]}
        extras.sync(self.ctx, active(scx_mode="powersave"))
        self.assertEqual(self.bus.loader["mode"], 2)
        extras.sync(self.ctx, active())
        self.assertEqual(self.switches()[-1], ["SwitchSchedulerWithArgs", "sas", "scx_lavd", "3", "--slice-us", "5000",
                                               "--autopower"])
        self.assertEqual(self.bus.loader["args"], ["--slice-us", "5000", "--autopower"])

    def test_a_bad_argument_is_not_restored(self):
        self.bus.loader = {"sched": "scx_lavd", "mode": 0, "args": ["--x", "$(reboot)"]}
        extras.sync(self.ctx, active(scx_mode="gaming"))
        extras.sync(self.ctx, active())
        self.assertEqual(self.switches()[-1], ["SwitchScheduler", "su", "scx_lavd", "0"])
        self.assertEqual(self.info()["scx"]["note"], extras.ARGS_NOT_RESTORED)
        self.assertFalse(any("$(reboot)" in c for c in self.bus.calls))

    def test_only_with_lavd(self):
        self.bus.loader = {"sched": "scx_bpfland", "mode": 0, "args": []}
        self.tick(active(scx_mode="gaming"))
        self.bus.loader = None
        self.tick(active(scx_mode="gaming"), step=11)
        self.assertEqual(self.switches(), [])

    def test_changed_by_someone_else(self):
        self.tick(active(scx_mode="gaming"))
        self.bus.loader["mode"] = 2                       # CachyOS's power switch
        self.tick(active(scx_mode="gaming"), step=11)
        self.assertEqual(self.info()["scx"]["overridden"], "Something else changed the scheduler mode")
        for _ in range(5):
            self.tick(active(scx_mode="gaming"), step=11)
        self.tick(active(), step=11)                       # no restore either: that program owns it now
        self.assertEqual(len(self.switches()), 1)
        self.tick(active(scx_mode="powersave"), step=11)   # a change of scx_mode
        self.assertIsNone(self.info()["scx"]["overridden"])
        self.assertEqual(self.bus.loader["mode"], 2)       # already there: no call
        self.tick(active(scx_mode="gaming"), step=11)
        self.assertEqual(self.switches()[-1], ["SwitchScheduler", "su", "scx_lavd", "1"])

    def test_unload_restores(self):
        self.tick(active(scx_mode="gaming"))
        extras.unload(self.ctx)
        self.assertEqual(self.bus.loader["mode"], 0)
        self.assertIsNone(self.run_file()["scx"]["before"])


class LpmdTest(Base):
    def setUp(self):
        super().setUp()
        self.bus.lpmd_active = True

    def on(self):
        self.assertTrue(extras.set_options(self.ctx, {"lpmd_game_off": True})["ok"])

    def test_only_with_the_option_the_service_and_a_game(self):
        self.tick(active(GAME))
        self.assertEqual(self.bus.privileged(), [])
        self.on()
        self.tick(active())
        self.assertEqual(self.bus.privileged(), [])
        self.bus.lpmd_active = False
        extras._reset()
        self.tick(active(GAME))
        self.assertEqual(self.bus.privileged(), [])

    def test_pause_and_restore(self):
        self.on()
        res = self.tick(active(GAME))
        self.assertTrue(res["lpmd_changed"])
        self.assertEqual(self.bus.privileged(), ["LPM_FORCE_OFF"])
        self.assertTrue(extras.lpmd_paused(self.ctx))
        self.assertEqual(self.bus.bus_calls("LPM_FORCE_OFF")[0],
                         ["/usr/bin/busctl", "--system", "--auto-start=no", "call", "org.freedesktop.intel_lpmd",
                          "/org/freedesktop/intel_lpmd", "org.freedesktop.intel_lpmd", "LPM_FORCE_OFF"])
        self.assertFalse(self.tick(active(GAME))["lpmd_changed"])
        res = self.tick(active())
        self.assertTrue(res["lpmd_changed"])
        self.assertEqual(self.bus.privileged(), ["LPM_FORCE_OFF", "LPM_AUTO"])
        self.assertFalse(extras.lpmd_paused(self.ctx))

    def test_restore_force_on(self):
        self.on()
        self.bus.lpmd = "ON"
        self.tick(active(GAME))
        self.tick(active())
        self.assertEqual(self.bus.privileged(), ["LPM_FORCE_OFF", "LPM_FORCE_ON"])
        self.assertEqual(self.bus.lpmd, "ON")

    def test_already_off(self):
        self.on()
        self.bus.lpmd = "OFF"
        for _ in range(3):
            self.assertFalse(self.tick(active(GAME))["lpmd_changed"])
        self.assertEqual(self.bus.privileged(), [])
        self.assertLessEqual(len(self.bus.bus_calls("GetState")), 2)

    def test_rate_limited_is_retried(self):
        self.on()
        self.bus.lpmd_errors = ["Call failed: rate limited: too many privileged requests"]
        self.assertFalse(self.tick(active(GAME))["lpmd_changed"])
        self.assertIsNone(self.info()["lpmd"]["error"])
        self.assertTrue(self.tick(active(GAME))["lpmd_changed"])
        self.assertEqual(self.bus.privileged(), ["LPM_FORCE_OFF", "LPM_FORCE_OFF"])

    def test_one_privileged_call_per_tick(self):
        self.on()
        self.tick(active(GAME))
        n = len(self.bus.privileged())
        self.tick(active("292030"))                        # another game: put back first
        self.assertEqual(self.bus.privileged()[n:], ["LPM_AUTO"])
        self.tick(active("292030"))
        self.assertEqual(self.bus.privileged()[n:], ["LPM_AUTO", "LPM_FORCE_OFF"])
        self.assertEqual(self.run_file()["lpmd"]["app"], "292030")

    def test_option_off_restores(self):
        self.on()
        self.tick(active(GAME))
        extras.set_options(self.ctx, {"lpmd_game_off": False})
        self.assertTrue(extras.sync(self.ctx, active(GAME))["lpmd_changed"])
        self.assertEqual(self.bus.privileged(), ["LPM_FORCE_OFF", "LPM_AUTO"])

    def test_a_daemon_restart_is_paused_again_once(self):
        self.on()
        self.tick(active(GAME))
        self.bus.lpmd = "AUTO"                            # it restarted
        self.assertTrue(self.tick(active(GAME), step=11)["lpmd_changed"])
        self.assertFalse(extras.lpmd_paused(self.ctx))
        self.tick(active(GAME))
        self.assertTrue(extras.lpmd_paused(self.ctx))
        self.bus.lpmd = "AUTO"
        self.tick(active(GAME), step=11)
        for _ in range(5):
            self.tick(active(GAME), step=11)
        self.assertEqual(self.bus.privileged(), ["LPM_FORCE_OFF", "LPM_FORCE_OFF"])
        self.assertFalse(extras.lpmd_paused(self.ctx))

    def test_old_build_without_getstate(self):
        self.on()
        self.bus.getstate = False
        self.tick(active(GAME))
        self.tick(active())
        self.assertEqual(self.bus.privileged(), ["LPM_FORCE_OFF", "LPM_AUTO"])

    def test_paused_survives_a_reload_and_unload_restores(self):
        self.on()
        self.tick(active(GAME))
        extras._reset()
        self.assertTrue(extras.lpmd_paused(self.ctx))     # from the run file
        self.tick(active(GAME))
        extras.unload(self.ctx)
        self.assertEqual(self.bus.privileged(), ["LPM_FORCE_OFF", "LPM_AUTO"])
        self.assertFalse(extras.lpmd_paused(self.ctx))


class TypesTest(Base):
    def test_state_fields_match_types_ts(self):
        from tests.test_xess import TYPES_TS, ts_fields
        with open(TYPES_TS) as f:
            if "export type ExtrasState" not in f.read():
                self.skipTest("types.ts has no ExtrasState yet (the frontend is written separately)")
        self.assertEqual(set(self.info()), ts_fields("ExtrasState"))
        self.assertEqual(set(extras.info(self.ctx)), ts_fields("ExtrasInfoRes"))
        self.assertEqual(set(extras.OPTION_DEFAULTS), ts_fields("ExtrasOptions"))


class NeverRaisesTest(Base):
    def test_bad_inputs(self):
        for act in (None, "x", {"values": "x"}, {"app": 5, "values": {"fan_mode": "turbo", "scx_mode": 9}}):
            self.assertTrue(extras.tick(self.ctx, act)["ok"])
            self.assertTrue(extras.sync(self.ctx, act)["ok"])
        self.assertFalse(extras.take_control(self.ctx, "everything")["ok"])
        with mock.patch.object(extras, "_gates", side_effect=RuntimeError("boom")):
            self.assertEqual(extras.tick(self.ctx, active())["error"], "extras: RuntimeError: boom")
            self.assertFalse(extras.info(self.ctx)["ok"])
        extras.unload(self.ctx)


if __name__ == "__main__":
    unittest.main()
