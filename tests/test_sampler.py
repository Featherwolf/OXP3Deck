"""sampler.py on the full fake OXP3 tree: when it samples (and when not), the load skip and the stall baseline, the
buckets per sustained limit and power source, each advice kind at its threshold and just outside it, dismissals, the
run file's boot id, and no GPU clock read."""
import collections
import json
import os
import tempfile
import types
import unittest
from unittest import mock

from oxp3deck import power, readouts, sampler, sysexec
from tests import powerfake as pf
from tests import stub_decky

GAME = {"app": "1091500", "name": None, "enabled": True, "advisor": True, "blocked": None, "overridden": False,
        "testing": False, "slot": "main", "key": "1091500", "pl1_w": 25, "pl2_w": None, "ac": False, "grace": False,
        "pl1_min": 5, "pl1_max": 35, "pl1_max_ac": 40, "low": False}


def game(**kw):
    return dict(GAME, **kw)


def bucket(n=60, pkg=12.0, busy=60.0, limited=0, thermal=0, secs=None):
    """A bucket of n samples 5 s apart at a constant package power and GPU busy, `limited` of them limited."""
    s = types.SimpleNamespace(apps={}, ring=collections.deque(maxlen=10), dirty=False)
    g = game(pl1_w=1000)                 # nothing counts as limited by its package power
    for i in range(n):
        sampler._count(s, "1", g, {"t": 0, "package_w": pkg, "gpu_busy_pct": busy,
                                   "reasons": ["pl1"] if i < limited else [],
                                   "cpu_throttle_ms": 5 if i < thermal else 0, "battery_w": 10,
                                   "battery_status": "Discharging"}, 5.0)
    b = s.apps["1"]["buckets"]["1000|bat"]
    if secs is not None:
        b["secs"] = secs
    return b


class AdviseTest(unittest.TestCase):
    def kind(self, b, **kw):
        a = sampler._advise(b, game(**kw))
        return (a["kind"], a["suggest_w"]) if a else None

    def test_headroom(self):
        self.assertEqual(self.kind(bucket(pkg=12.4)), ("headroom", 15))     # p90 13 W + 2
        a = sampler._advise(bucket(pkg=12.4), game())
        self.assertEqual((a["pl1_w"], a["seconds"], a["stats"]["p90_package_w"], a["stats"]["avg_gpu_busy_pct"],
                          a["stats"]["limited_share"]), (25, 300, 13, 60.0, 0.0))

    def test_headroom_thresholds(self):
        self.assertEqual(self.kind(bucket(pkg=20.5)), ("headroom", 22))     # p90 21 = PL1 - 4; clamped to PL1 - 3
        self.assertIsNone(self.kind(bucket(pkg=21.5)))                      # p90 22 > PL1 - 4
        self.assertEqual(self.kind(bucket(busy=79)), ("headroom", 15))      # busy p90 80 < 85
        self.assertIsNone(self.kind(bucket(busy=80)))                       # busy p90 90
        self.assertEqual(self.kind(bucket(limited=5)), ("headroom", 15))    # 8 % limited
        self.assertIsNone(self.kind(bucket(limited=6)))                     # 10 %
        self.assertIsNone(self.kind(bucket(pkg=1), pl1_w=7))                # 5 W (the floor) is only 2 W lower
        self.assertEqual(self.kind(bucket(pkg=1), pl1_w=8), ("headroom", 5))

    def test_not_before_five_minutes(self):
        self.assertIsNone(self.kind(bucket(secs=299)))
        self.assertIsNotNone(self.kind(bucket(secs=300)))

    def test_raise_plug_cpu(self):
        self.assertEqual(self.kind(bucket(pkg=25, busy=95, limited=30)), ("raise", 30))
        self.assertIsNone(self.kind(bucket(pkg=25, busy=95, limited=29)))     # 48 % limited
        self.assertIsNone(self.kind(bucket(pkg=25, busy=89.9, limited=60)))
        self.assertEqual(self.kind(bucket(busy=95, limited=60), pl1_w=33), ("raise", 35))   # up to the ceiling
        self.assertEqual(self.kind(bucket(busy=95, limited=60), pl1_w=34), ("plug", None))
        self.assertEqual(self.kind(bucket(busy=95, limited=60), pl1_w=35, pl1_max_ac=35), ("cpu", None))
        self.assertEqual(self.kind(bucket(busy=95, limited=60), pl1_w=39, pl1_max=40, ac=True), ("cpu", None))

    def test_limited_by_the_package_power_and_thermal(self):
        s = types.SimpleNamespace(apps={}, ring=collections.deque(maxlen=10), dirty=False)
        smp = {"t": 0, "package_w": 24.2, "gpu_busy_pct": 99, "reasons": None, "cpu_throttle_ms": None,
               "battery_w": None, "battery_status": "Charging"}
        sampler._count(s, "1", game(), smp, 5)
        sampler._count(s, "1", game(), dict(smp, package_w=23.9, reasons=["prochot"]), 5)
        b = s.apps["1"]["buckets"]["25|bat"]
        self.assertEqual((b["limited_n"], b["thermal_n"], b["bat_n"], b["busy_hist"][9]), (1, 1, 0, 2))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(sampler._STATES.clear)
        self.ctx = stub_decky.make_ctx(self.tmp.name)
        pf.oxp3_full(self.ctx)
        self.t = 1000.0
        for target, name in ((sampler, "_monotonic"), (readouts, "_monotonic")):
            p = mock.patch.object(target, name, lambda: self.t)
            p.start()
            self.addCleanup(p.stop)
        self.e, self.idle = 1_000_000, 10_000
        self.pkg, self.busy = 12.0, 60.0

    def tick(self, g=None, dt=2.0):
        """dt seconds of play at self.pkg W and self.busy %, then one tick."""
        self.t += dt
        self.e += int(self.pkg * dt * 1e6)
        self.idle += int((100 - self.busy) / 100 * dt * 1000)
        pf.energy(self.ctx, self.e)
        pf.gtidle(self.ctx, self.idle)
        res = sampler.tick(self.ctx, g or game())
        self.assertTrue(res["ok"], res)
        return res["did"]

    def play(self, seconds, g=None):
        dids = collections.Counter()
        for _ in range(int(seconds / 2)):
            dids[self.tick(g)] += 1
        return dids


class TickTest(Base):
    def test_nothing_while_it_should_not(self):
        reads = []
        with mock.patch.object(readouts, "_read", lambda p: reads.append(p)):
            for g in (game(enabled=False), game(app=None), game(slot="low"), game(testing=True), game(advisor=False),
                      game(overridden=True), game(blocked="thermald"), game(pl1_w=None)):
                self.assertEqual(self.tick(g), "idle", g)
        self.assertEqual(reads, [])

    def test_load_skip_then_samples_every_5_s(self):
        dids = self.play(30)
        self.assertEqual(dids["sampled"], 0)
        dids = self.play(60)
        self.assertGreaterEqual(dids["sampled"], 9)          # every 5 s at the latest tick after it: 6 s apart
        b = sampler._get(self.ctx).apps["1091500"]["buckets"]["25|bat"]
        self.assertEqual(round(b["pkg_sum"] / b["n"]), 12)
        self.assertEqual(round(b["busy_sum"] / b["n"]), 60)
        self.assertEqual(b["bat_n"], b["n"])

    def test_a_stall_restarts_the_baseline(self):
        self.play(60)
        n = sampler._get(self.ctx).apps["1091500"]["buckets"]["25|bat"]["n"]
        self.assertEqual(self.tick(dt=60), "skipped")
        self.assertEqual(sampler._get(self.ctx).apps["1091500"]["buckets"]["25|bat"]["n"], n)
        self.assertEqual(self.tick(dt=5), "sampled")

    def test_buckets_per_limit_and_source(self):
        self.play(60)
        self.play(40, game(pl1_w=15))           # a new limit: 30 s skipped again
        self.play(40, game(ac=True))
        self.assertEqual(sorted(sampler._get(self.ctx).apps["1091500"]["buckets"]), ["15|bat", "25|ac", "25|bat"])

    def test_grace_skips(self):
        self.play(40)
        self.tick(game(grace=True))
        self.assertEqual(self.play(28)["sampled"], 0)

    def test_reasons_only_when_busy_and_never_a_clock(self):
        reads = []
        real = readouts._read
        with mock.patch.object(readouts, "_read", lambda p: reads.append(p) or real(p)):
            self.busy = 2
            self.play(60)
            self.assertFalse([p for p in reads if p.endswith("throttle/reasons")])
            self.busy = 50
            self.play(20)
        self.assertTrue([p for p in reads if p.endswith("throttle/reasons")])
        self.assertFalse([p for p in reads if p.endswith(("/min_freq", "/max_freq", "/cur_freq", "/act_freq"))])


class AdviceTest(Base):
    def setUp(self):
        super().setUp()
        self.g = game()
        p = mock.patch.object(power, "game_now", lambda ctx: self.g)
        p.start()
        self.addCleanup(p.stop)

    def test_after_five_minutes_and_dismiss(self):
        res = sampler.advice(self.ctx, "1091500")
        self.assertEqual((res["ok"], res["advice"], res["sampling"], res["seconds"], res["need_s"]),
                         (True, None, False, 0, 300))
        self.play(200)
        res = sampler.advice(self.ctx, "1091500")
        self.assertEqual((res["advice"], res["sampling"]), (None, True))
        self.assertGreater(res["seconds"], 100)
        self.play(200)
        a = sampler.advice(self.ctx, "1091500")["advice"]
        self.assertEqual((a["kind"], a["appid"], a["pl1_w"], a["suggest_w"], a["ac"], a["pl1_max_ac"]),
                         ("headroom", "1091500", 25, 15, False, 40))
        json.dumps(a)
        self.assertTrue(sampler.dismiss(self.ctx, "1091500", "headroom", 25)["ok"])
        self.assertIsNone(sampler.advice(self.ctx, "1091500")["advice"])
        sampler._STATES.clear()                                # advisor.json survives
        with open(os.path.join(self.ctx.settings_dir, "advisor.json")) as f:
            self.assertEqual(json.load(f)["dismissed"]["1091500"]["kind"], "headroom")
        self.assertIsNone(sampler.advice(self.ctx, "1091500")["advice"])
        self.g = game(pl1_w=20)                                # another limit: its own advice
        self.play(400, self.g)
        self.assertEqual(sampler.advice(self.ctx, "1091500")["advice"]["suggest_w"], 15)

    def test_bad_arguments(self):
        self.assertFalse(sampler.advice(self.ctx, "abc")["ok"])
        self.assertFalse(sampler.dismiss(self.ctx, "1", "louder", 25)["ok"])
        self.assertFalse(sampler.dismiss(self.ctx, "1", "raise", True)["ok"])
        self.assertTrue(sampler.dismiss(self.ctx, 1091500, "raise", 25.5)["ok"])

    def test_another_app_or_off_gives_none(self):
        self.play(400)
        self.assertIsNone(sampler.advice(self.ctx, "2")["advice"])
        self.g = game(advisor=False)
        self.assertIsNone(sampler.advice(self.ctx, "1091500")["advice"])


class RunFileTest(Base):
    def test_boot_id(self):
        pf.boot_id(self.ctx, "boot-1")
        self.play(100)
        sampler._save(self.ctx, sampler._get(self.ctx), self.t)
        path = os.path.join(self.ctx.sys_path(sysexec.RUN_DIR), sampler.RUN_FILE)
        with open(path) as f:
            got = json.load(f)
        self.assertEqual(got["boot_id"], "boot-1")
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        sampler._STATES.clear()
        self.assertIn("1091500", sampler._get(self.ctx).apps)          # the same boot: kept
        sampler._STATES.clear()
        pf.boot_id(self.ctx, "boot-2")
        self.assertEqual(sampler._get(self.ctx).apps, {})               # a new boot: gone

    def test_a_game_change_saves(self):
        pf.boot_id(self.ctx, "boot-1")
        self.play(50)
        sampler._get(self.ctx).saved_at = self.t                        # not due by time
        self.play(10)
        self.tick(game(app=None))
        path = os.path.join(self.ctx.sys_path(sysexec.RUN_DIR), sampler.RUN_FILE)
        with open(path) as f:
            n = json.load(f)["apps"]["1091500"]["buckets"]["25|bat"]["n"]
        self.assertEqual(n, sampler._get(self.ctx).apps["1091500"]["buckets"]["25|bat"]["n"])

    def test_report(self):
        self.play(100)
        r = sampler.report(self.ctx)
        json.dumps(r)
        self.assertEqual(r["apps"]["1091500"]["buckets"]["25|bat"]["p90_package_w"], 13)


if __name__ == "__main__":
    unittest.main()
