"""selftest.py on the full fake OXP3 tree (tests/powerfake.py): when it may run, each probe written and put back
(nothing left changed), locked / ignored / unsupported / not_restored / skipped outcomes, stopping when a game starts,
the finally that re-applies, the 60 s measurement and what is stored."""
import errno
import json
import os
from unittest import mock

from oxp3deck import power, readouts, selftest
from tests import powerfake as pf
from tests import test_power as tp

MSR, MMIO = tp.MSR, tp.MMIO


class Job:
    def __init__(self, on_say=None):
        self.lines = []
        self.on_say = on_say

    def say(self, line):
        self.lines.append(str(line))
        if self.on_say:
            self.on_say(self, str(line))


def tree(root: str) -> dict:
    out = {}
    for base, _dirs, files in os.walk(os.path.join(root, "sys")):
        for f in files:
            path = os.path.join(base, f)
            if not os.path.islink(path):
                with open(path, "rb") as fh:
                    out[path] = fh.read()
    return out


class Base(tp.Base):
    oxp3 = False

    def setUp(self):
        super().setUp()
        self.freq = pf.oxp3_full(self.ctx)
        self.addCleanup(selftest._STORES.clear)
        self.addCleanup(readouts._STATES.clear)
        self.addCleanup(selftest._STOP.clear)
        for target, name, value in ((selftest, "_monotonic", lambda: self.t), (readouts, "_monotonic", lambda: self.t),
                                    (selftest, "_sleep", self.sleep)):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.on_sleep = None

    def sleep(self, s):
        self.t += s
        if self.on_sleep:
            self.on_sleep()

    def ready(self):
        self.on()
        self.tick()
        self.t += 200

    def check(self, job=None):
        return selftest.run_test(self.ctx, job or Job())

    def rows(self, res):
        return {r["id"]: r for r in res["selftest"]["probes"]}


class PrecheckTest(Base):
    def test_refusals_in_order(self):
        self.assertEqual(selftest.precheck(self.ctx, "test"), "Turn on power control first.")
        self.ready()
        self.assertIsNone(selftest.precheck(self.ctx, "test"))
        power.game(self.ctx, "1091500")
        self.assertEqual(selftest.precheck(self.ctx, "test"), "Quit the game first.")
        power.game(self.ctx, None)
        self.plug(True)
        self.tick()
        self.assertEqual(selftest.precheck(self.ctx, "test"), "The charger just changed: wait 20 s and try again.")
        self.t += 30
        self.tick()
        self.assertIsNone(selftest.precheck(self.ctx, "test"))
        power._get(self.ctx).run["overridden"] = {"what": "x"}
        self.assertEqual(selftest.precheck(self.ctx, "test"),
                         "Something else changes the power limits: take control first.")
        power._get(self.ctx).blocked = "another power manager is active: thermald"
        self.assertEqual(selftest.precheck(self.ctx, "test"),
                         "Power control is paused: another power manager is active: thermald")
        res = self.check()
        self.assertFalse(res["ok"])
        self.assertEqual(self.w.calls, [])

    def test_measure_modes(self):
        self.assertIn("mode must be", selftest.precheck(self.ctx, "measure", "busy"))
        self.assertEqual(selftest.precheck(self.ctx, "measure", "game"), "Start the game first.")
        self.assertIsNone(selftest.precheck(self.ctx, "measure", "idle"))       # with power control off too
        power.game(self.ctx, "1091500")
        self.assertEqual(selftest.precheck(self.ctx, "measure", "idle"),
                         "A game is running: tap Measure 60 s again to measure it.")
        self.assertIsNone(selftest.precheck(self.ctx, "measure", "game"))

    def test_the_steps_match_power(self):
        self.assertEqual((selftest.PROBE_W, selftest.PROBE_MHZ, selftest.PROBE_PCT, selftest.PROBE_CAP_MHZ),
                         (power.PROBE_W, power.PROBE_MHZ, power.PROBE_PCT, power.PROBE_CAP_MHZ))


class RunTest(Base):
    def test_full_run_puts_everything_back(self):
        self.ready()
        before = tree(self.ctx.root)
        self.w.calls.clear()
        res = self.check()
        self.assertTrue(res["ok"], res)
        rows = self.rows(res)
        self.assertEqual({r["outcome"] for r in rows.values()}, {"ok"}, rows)
        self.assertEqual(sorted(rows), sorted([f"{MSR}/pl1", f"{MSR}/pl2", f"{MMIO}/pl1", f"{MMIO}/pl2", "gpu/max",
                                               "gpu/min", "epp", "turbo", "cpu/max_pct", "cpu/min_pct",
                                               "cpu/cap/policy0", "cpu/cap/policy4", "cpu/cap/policy12",
                                               "soc/balance", "gpu/profile"]))
        self.assertEqual((rows[f"{MSR}/pl1"]["before"], rows[f"{MSR}/pl1"]["tried"]), ("25 W", "24 W"))
        self.assertEqual((rows["gpu/max"]["tried"], rows["gpu/min"]["tried"]), ("2250 MHz", "900 MHz"))
        self.assertEqual(rows["epp"]["tried"], "balance_power")
        self.assertEqual(rows["cpu/cap/policy0"]["read"], "4900 MHz")
        self.assertEqual(tree(self.ctx.root), before)
        # each probe value is written, then the old value at once (recorder order)
        msr = pf.limit(self.ctx, MSR, "long_term")
        writes = [t for p, t in self.w.calls if p == msr]
        self.assertEqual(writes, [str(24 * pf.MW), str(25 * pf.MW)])
        nt = [t for p, t in self.w.calls if p.endswith("no_turbo")]
        self.assertEqual(nt, ["1", "0"])
        st = power._get(self.ctx)
        self.assertFalse(st.testing)
        self.assertEqual(res["selftest"]["time_windows"][MSR], {"pl1_us": 27983872, "pl2_us": 976})
        stored = selftest.info(self.ctx)
        self.assertEqual(stored["test"]["probes"], res["selftest"]["probes"])
        self.assertFalse(stored["measured"])
        json.dumps(selftest.report(self.ctx))

    def test_locked_ignored_unsupported(self):
        self.ready()
        self.w.fail["intel-rapl:0/constraint_0_power_limit_uw"] = errno.EACCES
        self.w.ignore.add("intel-rapl-mmio:0/constraint_0_power_limit_uw")
        self.w.fail["policy4/scaling_max_freq"] = errno.EINVAL
        before = tree(self.ctx.root)
        rows = self.rows(self.check())
        self.assertEqual(rows[f"{MSR}/pl1"]["outcome"], "locked")
        self.assertIn(f"{MSR}/pl1", power._get(self.ctx).run["locked"])
        self.assertEqual(rows[f"{MMIO}/pl1"]["outcome"], "ignored")
        self.assertEqual(rows["cpu/cap/policy4"]["outcome"], "unsupported")
        self.assertEqual(rows["cpu/cap/policy12"]["outcome"], "ok")          # the rest go on
        self.assertEqual(rows["gpu/profile"]["outcome"], "ok")
        self.assertEqual(tree(self.ctx.root), before)
        again = self.rows(self.check())                     # not tried again this boot
        self.assertEqual((again[f"{MSR}/pl1"]["outcome"], again[f"{MSR}/pl1"]["why"]),
                         ("locked", "locked earlier this boot"))

    def test_a_restore_that_does_not_read_back_reapplies(self):
        self.ready()
        self.set(gpu_max_mhz=2000)
        self.w.fail["freq0/min_freq"] = [None, errno.EINVAL]          # the probe takes, the restore is refused
        res = self.check()
        row = self.rows(res)["gpu/min"]
        self.assertEqual((row["outcome"], row["restored"]), ("not_restored", False))
        self.assertTrue(res["ok"])
        self.assertEqual(pf.get(os.path.join(self.freq, "min_freq")), "850")   # the re-apply put it back

    def test_a_blocked_cpu_group_is_skipped(self):
        self.units = tp.units("cachyos-lpmd")
        self.ready()
        power.conflicts(self.ctx)
        rows = self.rows(self.check())
        for item in ("epp", "turbo", "cpu/max_pct", "cpu/min_pct", "cpu/cap/policy0", "soc/balance"):
            self.assertEqual(rows[item]["outcome"], "skipped", item)
            self.assertIn("intel_lpmd", rows[item]["why"])
        self.assertEqual(rows[f"{MSR}/pl1"]["outcome"], "ok")
        self.assertFalse([p for p, _t in self.w.calls if "energy_performance_preference" in p or "no_turbo" in p])

    def test_a_game_that_starts_stops_it(self):
        self.ready()
        before = tree(self.ctx.root)

        def start_game(job, line):
            if len(job.lines) == 3:
                power.game(self.ctx, "1091500")

        res = self.check(Job(start_game))
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "A game started: stopped. Everything is back as it was.")
        self.assertEqual(len(res["selftest"]["probes"]), 2)
        self.assertEqual(tree(self.ctx.root), before)
        self.assertEqual(selftest.info(self.ctx)["test"]["stopped"], res["error"])

    def test_an_exception_still_ends_the_test(self):
        self.ready()
        real = power.probe
        n = {"calls": 0}

        def probe(ctx, item):
            n["calls"] += 1
            if n["calls"] == 2:
                raise RuntimeError("sysfs went away")
            return real(ctx, item)

        marks = []
        real_mark = power.selftest_mark
        with mock.patch.object(power, "probe", probe), \
                mock.patch.object(power, "selftest_mark", lambda ctx, on: marks.append(on) or real_mark(ctx, on)):
            res = self.check()
        self.assertFalse(res["ok"])
        self.assertIn("RuntimeError: sysfs went away", res["error"])
        self.assertEqual(marks, [True, False])
        self.assertFalse(power._get(self.ctx).testing)

    def test_a_value_changed_after_the_plan_is_not_put_back_stale(self):
        self.ready()
        real = power.probe_plan

        def plan(ctx):
            items = real(ctx)
            self.set(pl1_w=20)                   # a slider tap between the plan and the probes
            return items

        with mock.patch.object(power, "probe_plan", plan):
            res = self.check()
        rows = self.rows(res)
        for item in (f"{MSR}/pl1", f"{MMIO}/pl1"):
            self.assertEqual((rows[item]["outcome"], rows[item]["why"]), ("skipped", "changed during the check"))
        self.assertEqual(pf.get(pf.limit(self.ctx, MSR, "long_term")), str(20 * pf.MW))   # the new value stays
        self.assertFalse(power._get(self.ctx).run.get("overridden"))

    def test_a_transient_gpu_failure_is_skipped_not_unsupported(self):
        self.ready()
        self.w.fail["freq0/power_profile"] = [errno.EAGAIN] * 10
        row = self.rows(self.check())["gpu/profile"]
        self.assertEqual((row["outcome"], row["why"]), ("skipped", "GPU busy or asleep, try again"))

    def test_stop_ends_it_before_the_next_probe(self):
        self.ready()
        before = tree(self.ctx.root)

        def stop(job, line):
            if len(job.lines) == 3:
                self.assertFalse(selftest.stop(0))      # still running: its finally has not run yet
        res = self.check(Job(stop))
        self.assertFalse(res["ok"])
        self.assertIn("plugin is stopping", res["error"])
        self.assertEqual(len(res["selftest"]["probes"]), 2)
        self.assertEqual(tree(self.ctx.root), before)
        self.assertTrue(selftest.stop(0))               # nothing runs now

    def test_turbo_off_is_not_tried(self):
        pf.put(pf.no_turbo_path(self.ctx), 1)
        self.ready()
        row = self.rows(self.check())["turbo"]
        self.assertEqual((row["outcome"], row["why"]), ("skipped", "not tried: CPU boost is off"))


class MeasureTest(Base):
    def feed(self):
        """Every 2 s: 15 J (7.5 W), 0.5 s idle (75 % busy), 12 W from the battery."""
        self.e = getattr(self, "e", 1_000_000) + 15_000_000
        self.idle = getattr(self, "idle", 10_000) + 500
        pf.energy(self.ctx, self.e)
        pf.gtidle(self.ctx, self.idle)

    def test_idle_minute(self):
        self.on_sleep = self.feed
        res = selftest.run_measure(self.ctx, Job(), "idle")
        self.assertTrue(res["ok"], res)
        m = res["measure"]
        self.assertEqual((m["mode"], m["seconds"], m["avg_package_w"], m["max_package_w"], m["avg_gpu_busy_pct"],
                          m["avg_battery_w"], m["appid"], m["ac"]), ("idle", 60, 7.5, 7.5, 75.0, 12.0, None, False))
        self.assertEqual(self.w.calls, [])               # read only, power control off
        self.assertTrue(selftest.info(self.ctx)["measured"])
        self.assertEqual(selftest.info(self.ctx)["measures"][0], m)

    def test_idle_reads_no_throttle_reasons_while_the_gpu_idles(self):
        def feed():                               # 1.9 of 2 s idle: 5 % busy, not above BUSY_FOR_REASONS
            self.e = getattr(self, "e", 1_000_000) + 2_000_000
            self.idle = getattr(self, "idle", 10_000) + 1900
            pf.energy(self.ctx, self.e)
            pf.gtidle(self.ctx, self.idle)

        self.on_sleep = feed
        reads = []
        real = readouts._read
        with mock.patch.object(readouts, "_read", lambda p: reads.append(p) or real(p)):
            self.assertTrue(selftest.run_measure(self.ctx, Job(), "idle")["ok"])
        self.assertEqual([p for p in reads if p.endswith("throttle/reasons")], [])
        reads.clear()
        self.on_sleep = self.feed                 # 75 % busy: awake anyway, the reasons are read
        with mock.patch.object(readouts, "_read", lambda p: reads.append(p) or real(p)):
            self.assertTrue(selftest.run_measure(self.ctx, Job(), "idle")["ok"])
        self.assertTrue([p for p in reads if p.endswith("throttle/reasons")])

    def test_a_game_that_ends(self):
        power.game(self.ctx, "1091500")
        steps = {"n": 0}

        def feed():
            self.feed()
            steps["n"] += 1
            if steps["n"] == 12:              # 24 s
                power.game(self.ctx, None)

        self.on_sleep = feed
        res = selftest.run_measure(self.ctx, Job(), "game")
        self.assertTrue(res["ok"], res)
        self.assertEqual((res["measure"]["interrupted"], res["measure"]["seconds"], res["measure"]["appid"]),
                         ("the game ended", 24, "1091500"))
        power.game(self.ctx, "1091500")
        steps["n"] = 3
        res = selftest.run_measure(self.ctx, Job(), "game")
        self.assertFalse(res["ok"])
        self.assertIn("not stored", res["error"])
        self.assertEqual(len(selftest.info(self.ctx)["measures"]), 1)

    def test_keeps_ten(self):
        self.on_sleep = self.feed
        for _ in range(12):
            self.assertTrue(selftest.run_measure(self.ctx, Job(), "idle")["ok"])
        self.assertEqual(len(selftest.info(self.ctx)["measures"]), selftest.KEEP_MEASURES)

    def test_summarise(self):
        s = selftest.summarise([
            {"package_w": 10, "gpu_busy_pct": 90, "reasons": ["pl1"], "battery_w": 20, "battery_status": "Discharging",
             "cpu_throttle_ms": 0},
            {"package_w": 20, "gpu_busy_pct": 100, "reasons": ["pl1", "thermal"], "battery_w": 5,
             "battery_status": "Charging", "cpu_throttle_ms": 30}])
        self.assertEqual(s, {"avg_package_w": 15.0, "max_package_w": 20, "avg_gpu_busy_pct": 95.0,
                             "avg_battery_w": 20.0, "reasons": {"pl1": 1.0, "thermal": 0.5}, "cpu_throttle_ms": 30})
