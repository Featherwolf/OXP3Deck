"""readouts.py on fake sysfs trees (tests/powerfake.py): package power from the energy counter (with wrap), battery
draw and time left or to full, coretemp by name, GPU busy from idle residency, the throttle delta, fan RPM."""
import os
import tempfile
import unittest
from unittest import mock

from oxp3deck import readouts
from tests import powerfake as pf
from tests import stub_decky


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(readouts._STATES.clear)
        self.ctx = stub_decky.make_ctx(self.tmp.name)
        self.t = 100.0
        p = mock.patch.object(readouts, "_monotonic", lambda: self.t)
        p.start()
        self.addCleanup(p.stop)

    def sample(self, dt=1.0):
        self.t += dt
        res = readouts.sample(self.ctx)
        self.assertTrue(res["ok"], res)
        return res["live"]

    def bat(self, **files):
        base = self.ctx.sys_path("/sys/class/power_supply/BAT0")
        pf.put(os.path.join(base, "type"), "Battery")
        for k, v in files.items():
            pf.put(os.path.join(base, k), v)


class NothingTest(Base):
    def test_every_value_null(self):
        live = self.sample()
        self.assertEqual(live["package_w"], None)
        self.assertEqual((live["battery"], live["cpu_temp_c"], live["gpu"], live["fan_rpm"]), (None,) * 4)
        self.assertEqual(live["throttle"], {"cpu_ms": None, "cpu": False, "gpu": []})
        self.assertEqual(set(live), {"t", "package_w", "battery", "cpu_temp_c", "gpu", "throttle", "fan_rpm"})
        self.sample()

    def test_never_raises(self):
        with mock.patch.object(readouts, "_discover", lambda ctx: 1 / 0), self.assertLogs("oxp3deck", "ERROR"):
            res = readouts.sample(self.ctx)
        self.assertEqual((res["ok"], res["live"]), (False, None))


class PackageTest(Base):
    def setUp(self):
        super().setUp()
        pf.rapl(self.ctx, "intel-rapl-mmio:0")
        pf.energy(self.ctx, 999_000_000, zone="intel-rapl-mmio:0")    # never counted (it would double)
        pf.rapl(self.ctx, "intel-rapl:1", name="psys")
        pf.energy(self.ctx, 5, zone="intel-rapl:1")
        pf.rapl(self.ctx, "intel-rapl:0")
        pf.energy(self.ctx, 1_000_000, max_uj=10_000_000)

    def test_two_samples_and_the_first_is_null(self):
        self.assertIsNone(self.sample()["package_w"])
        pf.energy(self.ctx, 1_000_000 + 18_400_000, max_uj=100_000_000)
        self.assertEqual(self.sample(1.0)["package_w"], 18.4)
        pf.energy(self.ctx, 1_000_000 + 18_400_000 + 9_000_000, max_uj=100_000_000)
        self.assertEqual(self.sample(2.0)["package_w"], 4.5)

    def test_wrap(self):
        pf.energy(self.ctx, 9_000_000, max_uj=10_000_000)
        self.sample()
        pf.energy(self.ctx, 1_000_000, max_uj=10_000_000)       # wrapped: 1 J to the top, 1 J after
        self.assertEqual(self.sample(0.5)["package_w"], 4.0)

    def test_too_close_or_too_far(self):
        self.sample()
        pf.energy(self.ctx, 2_000_000)
        self.assertIsNone(self.sample(0.1)["package_w"])
        pf.energy(self.ctx, 3_000_000)
        self.assertIsNone(self.sample(40)["package_w"])
        pf.energy(self.ctx, 4_000_000)
        self.assertEqual(self.sample(1)["package_w"], 1.0)


class BatteryTest(Base):
    def test_power_now_and_time_left(self):
        self.bat(status="Discharging", capacity=64, power_now=12_000_000, energy_now=36_000_000,
                 energy_full=60_000_000)
        b = self.sample()["battery"]
        self.assertEqual(b, {"status": "Discharging", "percent": 64, "draw_w": 12.0, "time_left_min": 180,
                             "time_to_full_min": None})

    def test_current_times_voltage_and_time_to_full_at_the_limit(self):
        self.bat(status="Charging", capacity=50, current_now=2_000_000, voltage_now=15_000_000,
                 charge_now=3_000_000, charge_full=6_000_000, charge_control_end_threshold=80)
        b = self.sample()["battery"]
        self.assertEqual((b["draw_w"], b["time_left_min"], b["time_to_full_min"]), (30.0, None, 54))

    def test_tiny_draw_gives_no_time(self):
        self.bat(status="Discharging", capacity=99, power_now=200_000, energy_now=50_000_000)
        b = self.sample()["battery"]
        self.assertEqual((b["draw_w"], b["time_left_min"]), (0.2, None))

    def test_mains_is_not_a_battery(self):
        pf.ac(self.ctx, online=True)
        self.assertIsNone(self.sample()["battery"])


class TempTest(Base):
    def test_coretemp_by_name_and_label(self):
        pf.hwmon(self.ctx, 0, "acpitz", {"temp1_input": 99000})
        pf.coretemp(self.ctx, milli=62345, n=4)
        self.assertEqual(self.sample()["cpu_temp_c"], 62.3)

    def test_without_the_package_label_temp1(self):
        pf.hwmon(self.ctx, 2, "coretemp", {"temp1_input": 55000, "temp1_label": "Core 0"})
        self.assertEqual(self.sample()["cpu_temp_c"], 55.0)

    def test_a_renumbered_hwmon_is_found_again(self):
        base = pf.coretemp(self.ctx, milli=60000, n=3)
        self.assertEqual(self.sample()["cpu_temp_c"], 60.0)
        os.rename(base, self.ctx.sys_path("/sys/class/hwmon/hwmon7"))
        self.assertEqual(self.sample()["cpu_temp_c"], 60.0)


class GpuTest(Base):
    def setUp(self):
        super().setUp()
        self.freq = pf.xe(self.ctx)
        pf.gtidle(self.ctx, 10_000)

    def test_busy_from_idle_residency_and_clocks(self):
        g = self.sample()["gpu"]
        self.assertEqual(g, {"busy_pct": None, "cur_mhz": 1500, "act_mhz": 1450, "reasons": []})
        pf.gtidle(self.ctx, 10_250)                  # 250 ms idle in 2 s: 87.5 % busy
        pf.put(os.path.join(self.freq, "throttle", "reasons"), "reason_pl1 prochot")
        live = self.sample(2.0)
        self.assertEqual(live["gpu"]["busy_pct"], 88)
        self.assertEqual(live["gpu"]["reasons"], ["pl1", "prochot"])
        self.assertEqual(live["throttle"]["gpu"], ["pl1", "prochot"])
        pf.gtidle(self.ctx, 13_000)                   # more idle than time (rounding): clamped
        self.assertEqual(self.sample(2.0)["gpu"]["busy_pct"], 0)

    def test_the_media_gt_is_not_read(self):
        pf.gtidle(self.ctx, 1, gt="gt1")
        seen = []
        real = readouts._read
        with mock.patch.object(readouts, "_read", lambda p: seen.append(p) or real(p)):
            self.sample()
        self.assertFalse([p for p in seen if p and "/gt1/" in p and "gtidle/name" not in p])


    def test_no_extra_wakes(self):
        """Each sample reads act_freq once (in _gpu, not again in _stale); the 30 s look-again keeps a GPU folder
        that still exists instead of reading gtidle/name and rpe_freq again (they wake the GPU)."""
        self.sample()
        with mock.patch.object(readouts.powerhw, "_discover_gpu", side_effect=AssertionError("rediscovered")):
            seen = []
            real = readouts._read
            with mock.patch.object(readouts, "_read", lambda p: seen.append(p) or real(p)):
                self.sample(readouts.REDISCOVER_S)
                self.sample()
        self.assertEqual(len([p for p in seen if p and p.endswith("/act_freq")]), 2)
        self.assertFalse([p for p in seen if p and p.endswith(("/rpe_freq", "/gtidle/name"))])


class ThrottleFanTest(Base):
    def test_cpu_throttle_delta(self):
        pf.throttle(self.ctx, 500)
        self.assertEqual(self.sample()["throttle"], {"cpu_ms": None, "cpu": False, "gpu": []})
        self.assertEqual(self.sample()["throttle"]["cpu_ms"], 0)
        pf.throttle(self.ctx, 740)
        t = self.sample()["throttle"]
        self.assertEqual((t["cpu_ms"], t["cpu"]), (240, True))

    def test_fan_rpm_only_with_oxp_ec(self):
        pf.hwmon(self.ctx, 1, "acpi_fan", {"fan1_input": 1234})
        self.assertIsNone(self.sample()["fan_rpm"])
        readouts._STATES.clear()
        pf.oxp_ec_fan(self.ctx, 3100)
        self.assertEqual(self.sample()["fan_rpm"], 3100)


if __name__ == "__main__":
    unittest.main()
