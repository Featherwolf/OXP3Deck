"""The in-game overhead budget (DESIGN.md "Performance batch" E, ROADMAP N-7): one minute of the watch loop on the
full fake OXP3 tree with a game running, counting every sysfs read of powerhw and readouts. No GPU clock file is
read (they wake the GPU), the drift check runs every 10 s with no panel open, and the whole minute stays under
READ_BUDGET_PER_MIN."""
import collections
from unittest import mock

from oxp3deck import power, powerhw, readouts, sampler
from tests import powerfake as pf
from tests import test_power as tp

# Measured on this tree when it was written (2026-11): 471 reads in the minute (power.tick, sampler.tick with
# readouts.cheap). Budget: + 20 %. With the drift check every 2 s as before N-7, the same minute reads 1575.
MEASURED_PER_MIN = 471
READ_BUDGET_PER_MIN = int(MEASURED_PER_MIN * 1.2)
CLOCKS = ("/min_freq", "/max_freq", "/cur_freq", "/act_freq")


class BudgetTest(tp.Base):
    oxp3 = False

    def setUp(self):
        super().setUp()
        pf.oxp3_full(self.ctx)
        self.addCleanup(sampler._STATES.clear)
        self.addCleanup(readouts._STATES.clear)
        for target in (sampler, readouts):
            p = mock.patch.object(target, "_monotonic", lambda: self.t)
            p.start()
            self.addCleanup(p.stop)
        self.on()
        self.set(pl1_w=20)
        power.profile(self.ctx, "1091500", "Cyberpunk 2077", True)
        power.game(self.ctx, "1091500")
        for _ in range(int(power.CALM_S / power.TICK_S) + 2):     # settled: the calm window after the apply ended
            self.watch_pass()
        self.e, self.idle = 1_000_000, 10_000

    def watch_pass(self, panel=False):
        """One pass of main.py's watch loop: power.tick, then sampler.tick(power.game_now) (2 s of play first)."""
        self.t += power.TICK_S
        self.e = getattr(self, "e", 1_000_000) + 40_000_000
        self.idle = getattr(self, "idle", 10_000) + 400
        pf.energy(self.ctx, self.e)
        pf.gtidle(self.ctx, self.idle)
        if panel:
            power.state(self.ctx)
        self.assertTrue(power.tick(self.ctx)["ok"])
        self.assertTrue(sampler.tick(self.ctx, power.game_now(self.ctx))["ok"])

    def minute(self, panel=False):
        reads = []
        real_hw, real_ro = powerhw._read, readouts._read
        with mock.patch.object(powerhw, "_read", lambda p: reads.append(p) or real_hw(p)), \
                mock.patch.object(readouts, "_read", lambda p: reads.append(p) or real_ro(p)):
            for _ in range(30):
                self.watch_pass(panel)
        return reads

    def test_one_minute_in_game(self):
        reads = self.minute()
        self.assertFalse([p for p in reads if p.endswith(CLOCKS)], "a GPU clock was read")
        msr = pf.limit(self.ctx, tp.MSR, "long_term")
        self.assertLessEqual(reads.count(msr), 7)
        counts = collections.Counter(reads)
        self.assertLessEqual(len(reads), READ_BUDGET_PER_MIN, counts.most_common(10))
        self.assertGreaterEqual(len(reads), MEASURED_PER_MIN * 0.5)      # the count is real, not a broken patch

    def test_with_a_panel_open_the_drift_check_runs_every_pass(self):
        msr = pf.limit(self.ctx, tp.MSR, "long_term")
        reads = self.minute(panel=True)
        self.assertGreaterEqual(reads.count(msr), 30)

    def test_reasons_only_while_the_gpu_is_busy(self):
        reasons = self.ctx.sys_path("/sys/class/drm/card1/device/tile0/gt0/freq0/throttle/reasons")
        reads = self.minute()
        self.assertGreater(reads.count(reasons), 0)               # 80 % busy here
        orig = self.watch_pass

        def idle_pass(panel=False):
            self.idle += 2000 - 400                               # all idle: 0 % busy
            orig(panel)

        self.watch_pass = idle_pass
        self.minute()                                             # the first sample still sees the busy one
        reads = self.minute()
        self.assertEqual(reads.count(reasons), 0)
