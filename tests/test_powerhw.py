"""powerhw.py against fake sysfs trees (tests/powerfake.py): discovery, reading, the write order, what is never
written, and every refusal sysfs can give."""
import errno
import os
import tempfile
import unittest
from unittest import mock

from oxp3deck import powerhw
from tests import powerfake as pf
from tests import stub_decky

MW = pf.MW


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ctx = stub_decky.make_ctx(self.tmp.name)
        self.w = pf.Writer()
        for name, value in (("_write", self.w), ("_sleep", lambda s: None)):
            p = mock.patch.object(powerhw, name, value)
            p.start()
            self.addCleanup(p.stop)

    def hw(self):
        return powerhw.discover(self.ctx)

    def apply(self, target, locked=()):
        return powerhw.apply(self.ctx, self.hw(), target, list(locked))


class DiscoverTest(Base):
    def test_the_oxp3(self):
        pf.oxp3(self.ctx)
        hw = self.hw()
        self.assertEqual([(z["id"], z["iface"], z["name"]) for z in hw["rapl"]],
                         [("intel-rapl-mmio:0", "mmio", "package-0"), ("intel-rapl:0", "msr", "package-0")])
        z = hw["rapl"][1]
        self.assertEqual((z["pl1"], z["pl2"], z["pl4"]), ({"n": 0, "max_uw": 25 * MW}, {"n": 1, "max_uw": 0},
                                                          {"n": 2}))
        self.assertEqual(hw["gpu"]["card"], "card1")
        self.assertEqual((hw["gpu"]["gt"], hw["gpu"]["media_gt"]), ("gt0", "gt1"))
        self.assertEqual((hw["gpu"]["rpn"], hw["gpu"]["rpe"], hw["gpu"]["rp0"]), (100, 900, 2300))
        self.assertEqual(hw["cpu"]["pstate"], "active")
        self.assertEqual(len(hw["cpu"]["policies"]), 14)
        self.assertEqual(hw["cpu"]["policies"][:3], ["policy0", "policy1", "policy2"])
        self.assertEqual(hw["cpu"]["policies"][-1], "policy13")          # by number, not by name
        self.assertEqual(hw["cpu"]["epp_choices"], list(powerhw.EPP_CHOICES))   # never "default"
        self.assertTrue(hw["cpu"]["turbo"])
        self.assertEqual(hw["ac_supply"], "ADP1")
        self.assertEqual(hw["problems"], [])

    def test_one_interface_or_none(self):
        pf.oxp3(self.ctx, mmio=False)
        self.assertEqual([z["id"] for z in self.hw()["rapl"]], ["intel-rapl:0"])
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ctx = stub_decky.make_ctx(tmp.name)
        pf.oxp3(self.ctx, msr=False)
        self.assertEqual([z["id"] for z in self.hw()["rapl"]], ["intel-rapl-mmio:0"])
        tmp2 = tempfile.TemporaryDirectory()
        self.addCleanup(tmp2.cleanup)
        self.ctx = stub_decky.make_ctx(tmp2.name)
        hw = self.hw()
        self.assertEqual(hw["rapl"], [])
        self.assertIsNone(hw["gpu"])
        self.assertIsNone(hw["cpu"])
        self.assertTrue(any("RAPL" in p for p in hw["problems"]))

    def test_constraints_by_name_and_zones_without_long_term(self):
        pf.rapl(self.ctx, "intel-rapl:0", order=("peak_power", "short_term", "long_term"))
        pf.rapl(self.ctx, "intel-rapl-mmio:0", order=("short_term", "peak_power"))
        hw = self.hw()
        self.assertEqual([z["id"] for z in hw["rapl"]], ["intel-rapl:0"])
        self.assertEqual((hw["rapl"][0]["pl1"]["n"], hw["rapl"][0]["pl2"]["n"], hw["rapl"][0]["pl4"]["n"]),
                         (2, 1, 0))
        r = powerhw.read(self.ctx, hw, gpu=False)
        self.assertEqual(r["rapl"]["intel-rapl:0"], {"pl1_uw": 25 * MW, "pl2_uw": 52 * MW, "pl4_uw": 160 * MW})

    def test_psys_and_child_zones_are_ignored_and_a_tpmi_zone_is_kept(self):
        pf.oxp3(self.ctx)
        pf.rapl(self.ctx, "intel-rapl:2", name="package-1")
        ids = [z["id"] for z in self.hw()["rapl"]]
        self.assertEqual(ids, ["intel-rapl-mmio:0", "intel-rapl:0", "intel-rapl:2"])
        res = self.apply({"rapl": {i: {"pl1_uw": 15 * MW, "pl2_uw": 30 * MW} for i in ids}})
        self.assertTrue(res["ok"], res)
        self.assertEqual(pf.watts(self.ctx, "intel-rapl:2", "long_term"), 15)
        self.assertEqual(pf.watts(self.ctx, "intel-rapl:1", "long_term"), 0)


class GpuTest(Base):
    def test_render_gt_is_picked(self):
        pf.xe(self.ctx, gts={"gt0": "gt0-mc", "gt1": "gt1-rc"})
        self.assertEqual((self.hw()["gpu"]["gt"], self.hw()["gpu"]["media_gt"]), ("gt1", "gt0"))

    def test_without_gtidle_the_lowest(self):
        pf.xe(self.ctx, gts={"gt1": None, "gt0": None})
        self.assertEqual(self.hw()["gpu"]["gt"], "gt0")

    def test_i915_is_not_used(self):
        pf.xe(self.ctx, card="card0", driver="i915")
        hw = self.hw()
        self.assertIsNone(hw["gpu"])
        self.assertIn("GPU clocks need the xe driver (card0 uses i915)", hw["problems"])

    def test_reading_without_the_gpu_opens_no_clock_file(self):
        pf.oxp3(self.ctx)
        hw = self.hw()
        seen = []
        real = powerhw._read
        with mock.patch.object(powerhw, "_read", lambda p: seen.append(p) or real(p)):
            r = powerhw.read(self.ctx, hw, gpu=False)
            self.assertEqual(r["gpu"], {"min": None, "max": None, "act": None, "cur": None, "reasons": [],
                                        "profile": None})
            self.assertFalse([p for p in seen if "/drm/" in p], seen)
            seen.clear()
            r = powerhw.read(self.ctx, hw, gpu=True)
        self.assertEqual((r["gpu"]["min"], r["gpu"]["max"], r["gpu"]["act"]), (850, 2300, 1450))
        self.assertTrue([p for p in seen if p.endswith("act_freq")])

    def test_throttle_reasons(self):
        f = pf.xe(self.ctx)
        hw = self.hw()
        for text, want in (("none", []), ("pl1 prochot", ["pl1", "prochot"]), ("reason_pl2,soc_thermal",
                                                                              ["pl2", "soc_thermal"])):
            pf.put(os.path.join(f, "throttle", "reasons"), text)
            self.assertEqual(powerhw.read(self.ctx, hw, gpu=True)["gpu"]["reasons"], want)

    def test_rp_files_and_the_media_gt_never_change(self):
        pf.oxp3(self.ctx)
        dev = self.ctx.sys_path("/sys/class/drm/card1/device/tile0")
        files = []
        for root, _d, names in os.walk(dev):
            files += [os.path.join(root, n) for n in names if "rp" in n or "/gt1/" in root + "/"]
        def snap():
            out = {}
            for p in files:
                with open(p, "rb") as f:
                    out[p] = f.read()
            return out

        before = snap()
        self.apply({"gpu": {"min": 300, "max": 1800}})
        self.apply({"gpu": {"min": 2000, "max": 2300}})
        self.assertEqual(snap(), before)
        self.assertFalse([p for p in self.w.paths() if "/gt1/" in p or "rp" in os.path.basename(p)])


class OrderTest(Base):
    def setUp(self):
        super().setUp()
        pf.oxp3(self.ctx)
        pf.set_watts(self.ctx, "intel-rapl:0", "long_term", 15)
        pf.set_watts(self.ctx, "intel-rapl-mmio:0", "long_term", 15)
        pf.set_watts(self.ctx, "intel-rapl:0", "short_term", 20)
        pf.set_watts(self.ctx, "intel-rapl-mmio:0", "short_term", 20)

    def both(self, pl1, pl2):
        return {"rapl": {z: {"pl1_uw": pl1 * MW, "pl2_uw": pl2 * MW} for z in ("intel-rapl:0", "intel-rapl-mmio:0")}}

    def test_raising_writes_pl2_first_and_mmio_first(self):
        res = self.apply(self.both(30, 40))
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.w.names(self.ctx), ["intel-rapl-mmio:0/short_term", "intel-rapl-mmio:0/long_term",
                                                  "intel-rapl:0/short_term", "intel-rapl:0/long_term"])
        self.assertEqual(res["written"], ["intel-rapl-mmio:0/pl2", "intel-rapl-mmio:0/pl1", "intel-rapl:0/pl2",
                                          "intel-rapl:0/pl1"])
        self.assertEqual(pf.watts(self.ctx, "intel-rapl:0", "long_term"), 30)

    def test_lowering_writes_pl1_first(self):
        self.apply(self.both(10, 12))
        self.assertEqual(self.w.names(self.ctx)[:2], ["intel-rapl-mmio:0/long_term", "intel-rapl-mmio:0/short_term"])

    def test_an_equal_value_is_not_written(self):
        res = self.apply({"rapl": {"intel-rapl:0": {"pl1_uw": 15 * MW + 100_000, "pl2_uw": 25 * MW}}})
        self.assertEqual(res["written"], ["intel-rapl:0/pl2"])
        self.assertTrue(res["ok"])

    def test_pl2_below_pl1_is_raised(self):
        self.apply({"rapl": {"intel-rapl:0": {"pl1_uw": 30 * MW, "pl2_uw": 10 * MW}}})
        self.assertEqual(pf.watts(self.ctx, "intel-rapl:0", "short_term"), 30)

    def test_gpu_order(self):
        res = self.apply({"gpu": {"min": 1000, "max": 2000}})     # raising the minimum: max first
        self.assertEqual(self.w.names(self.ctx), ["gpu/max_freq", "gpu/min_freq"])
        self.assertEqual(res["written"], ["gpu/max", "gpu/min"])
        self.w.calls.clear()
        self.apply({"gpu": {"min": 300, "max": 600}})
        self.assertEqual(self.w.names(self.ctx), ["gpu/min_freq", "gpu/max_freq"])

    def test_never_written(self):
        self.apply(self.both(30, 40))
        self.apply(self.both(10, 12))
        self.apply({"gpu": {"min": 300, "max": 600}, "epp": "power", "turbo": False})
        for p in self.w.paths():
            name = os.path.basename(p)
            self.assertNotIn("time_window", name)
            self.assertNotEqual(name, "enabled")
            self.assertFalse("intel-rapl:1" in p or "intel-rapl:0:0" in p, p)
        self.assertNotIn("intel-rapl:0/peak_power", self.w.names(self.ctx))
        self.assertNotIn("intel-rapl-mmio:0/peak_power", self.w.names(self.ctx))


class RefusalTest(Base):
    def setUp(self):
        super().setUp()
        pf.oxp3(self.ctx)
        self.target = {"rapl": {z: {"pl1_uw": 15 * MW, "pl2_uw": 30 * MW}
                                for z in ("intel-rapl:0", "intel-rapl-mmio:0")}}

    def test_a_locked_msr_limit(self):
        self.w.fail[pf.limit(self.ctx, "intel-rapl:0", "long_term")] = errno.EACCES
        res = self.apply(self.target)
        self.assertFalse(res["ok"])
        self.assertEqual(res["failed"], [{"id": "intel-rapl:0/pl1", "error": "locked by firmware", "locked": True,
                                         "transient": False}])
        self.assertIn("intel-rapl-mmio:0/pl1", res["written"])
        self.assertIn("intel-rapl:0/pl2", res["written"])          # the other constraint of that zone is tried
        self.assertEqual(pf.watts(self.ctx, "intel-rapl-mmio:0", "long_term"), 15)
        self.assertEqual(res["error"], "intel-rapl:0/pl1: locked by firmware")

    def test_a_locked_id_is_skipped(self):
        res = self.apply(self.target, locked=["intel-rapl:0/pl1"])
        self.assertTrue(res["ok"], res)
        self.assertNotIn("intel-rapl:0/long_term", self.w.names(self.ctx))
        self.assertEqual(pf.watts(self.ctx, "intel-rapl:0", "long_term"), 25)

    def test_an_mmio_write_that_is_ignored(self):
        self.w.ignore.add(pf.limit(self.ctx, "intel-rapl-mmio:0", "long_term"))
        res = self.apply(self.target)
        self.assertEqual(res["failed"], [{"id": "intel-rapl-mmio:0/pl1", "error": "did not take: reads 35 W",
                                          "locked": False, "transient": False}])
        self.assertNotIn("intel-rapl-mmio:0/pl1", res["written"])

    def test_gpu_eagain_then_success_and_einval(self):
        self.w.fail["min_freq"] = [errno.EAGAIN, errno.EAGAIN, None]
        res = self.apply({"gpu": {"min": 300}})
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.w.names(self.ctx).count("gpu/min_freq"), 3)
        self.w.fail["min_freq"] = errno.EINVAL
        res = self.apply({"gpu": {"min": 3000}})
        self.assertEqual(res["failed"][0]["error"], "3000 MHz is outside 100..2300 MHz")
        self.w.fail["min_freq"] = errno.EAGAIN
        res = self.apply({"gpu": {"min": 400}})
        self.assertIn("busy", res["failed"][0]["error"])

    def test_epp(self):
        res = self.apply({"epp": "balance_power"})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["written"], ["epp"])
        self.assertEqual(pf.get(pf.epp_path(self.ctx, "policy13")), "balance_power")
        self.w.calls.clear()
        self.assertEqual(self.apply({"epp": "balance_power"})["written"], [])   # nothing differs
        self.assertEqual(self.w.calls, [])

    def test_epp_refusals(self):
        res = self.apply({"epp": "default"})
        self.assertEqual(res["failed"][0]["id"], "epp")
        for i in range(14):
            pf.put(self.ctx.sys_path(f"/sys/devices/system/cpu/cpufreq/policy{i}/scaling_governor"), "performance")
        res = self.apply({"epp": "power"})
        self.assertEqual(res["failed"], [{"id": "epp", "error": "the CPU governor is performance: EPP cannot "
                                                                "change", "locked": False, "transient": False}])
        self.assertEqual(self.w.calls, [])

    def test_epp_busy_on_one_policy(self):
        self.w.fail["policy3/energy_performance_preference"] = errno.EBUSY
        res = self.apply({"epp": "power"})
        self.assertEqual([f["id"] for f in res["failed"]], ["epp/policy3"])
        self.assertEqual(pf.get(pf.epp_path(self.ctx, "policy4")), "power")
        self.assertEqual(pf.get(pf.epp_path(self.ctx, "policy3")), "balance_performance")

    def test_epp_per_policy(self):
        res = self.apply({"epp": {"policy0": "power", "policy1": "performance"}})
        self.assertTrue(res["ok"], res)
        self.assertEqual(pf.get(pf.epp_path(self.ctx, "policy1")), "performance")
        self.assertEqual(pf.get(pf.epp_path(self.ctx, "policy2")), "balance_performance")

    def test_turbo(self):
        res = self.apply({"turbo": False})
        self.assertEqual((res["ok"], res["written"]), (True, ["turbo"]))
        self.assertEqual(pf.get(pf.no_turbo_path(self.ctx)), "1")
        self.w.fail["no_turbo"] = errno.EPERM
        res = self.apply({"turbo": True})
        self.assertEqual(res["failed"], [{"id": "turbo", "error": "firmware has turned turbo off", "locked": False,
                                          "transient": False}])

    def test_missing_pieces(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ctx = stub_decky.make_ctx(tmp.name)
        res = self.apply({"gpu": {"min": 300}, "epp": "power", "turbo": True, "rapl": {"intel-rapl:0": {}}})
        self.assertFalse(res["ok"])
        self.assertEqual(sorted(f["id"] for f in res["failed"]), ["epp", "gpu", "turbo"])


class SupplyTest(Base):
    def test_ac_online(self):
        self.assertIsNone(powerhw.ac_online(self.ctx))
        pf.battery(self.ctx, "Charging")
        self.assertTrue(powerhw.ac_online(self.ctx))
        pf.battery(self.ctx, "Discharging")
        self.assertFalse(powerhw.ac_online(self.ctx))
        pf.ac(self.ctx, online=True, name="ucsi-source-psy-USBC000:001", kind="USB")
        self.assertTrue(powerhw.ac_online(self.ctx))
        pf.ac(self.ctx, online=False, name="ADP1")
        self.assertFalse(powerhw.ac_online(self.ctx))   # Mains wins over USB
        pf.ac(self.ctx, online=True, name="ADP1")
        self.assertTrue(powerhw.ac_online(self.ctx))

    def test_suspend_count(self):
        self.assertIsNone(powerhw.suspend_count(self.ctx))
        pf.suspend(self.ctx, 4)
        self.assertEqual(powerhw.suspend_count(self.ctx), 4)


class WriterTest(unittest.TestCase):
    def test_no_symlink_is_followed(self):
        with tempfile.TemporaryDirectory() as tmp:
            real = os.path.join(tmp, "victim")
            pf.put(real, "keep")
            link = os.path.join(tmp, "constraint_0_power_limit_uw")
            os.symlink(real, link)
            with self.assertRaises(OSError):
                powerhw._write(link, "15000000")
            self.assertEqual(pf.get(real), "keep")
            plain = os.path.join(tmp, "plain")
            pf.put(plain, "0")
            powerhw._write(plain, "15000000")
            self.assertEqual(pf.get(plain), "15000000")


if __name__ == "__main__":
    unittest.main()


class OwnerReadingsTest(Base):
    """The owner's OXP3 as read on 2026-11-05 with SimpleDeckyTDP installed: MSR 25/52/160 W, MMIO 35/35/160 W
    (SimpleDeckyTDP's leftover), render GT on card0 (min 900, 100..2300 MHz), media GT 100..1200 MHz."""

    def setUp(self):
        super().setUp()
        pf.oxp3(self.ctx, gpu=False)
        pf.set_watts(self.ctx, "intel-rapl-mmio:0", "short_term", 35)
        pf.xe(self.ctx, card="card0", minf=900, maxf=2300)

    def test_found_and_both_interfaces_written(self):
        hw = self.hw()
        self.assertEqual(hw["gpu"]["card"], "card0")
        self.assertEqual((hw["gpu"]["gt"], hw["gpu"]["media_gt"]), ("gt0", "gt1"))
        zones = ("intel-rapl:0", "intel-rapl-mmio:0")
        res = self.apply({"rapl": {z: {"pl1_uw": 30 * MW, "pl2_uw": 45 * MW} for z in zones},
                          "gpu": {"min": 300, "max": 2300}})
        self.assertTrue(res["ok"], res)
        for z in ("intel-rapl:0", "intel-rapl-mmio:0"):
            self.assertEqual((pf.watts(self.ctx, z, "long_term"), pf.watts(self.ctx, z, "short_term"),
                              pf.watts(self.ctx, z, "peak_power")), (30, 45, 160))
        self.assertFalse(any("/gt1/" in p for p in self.w.paths()))


class CoreTypesTest(Base):
    def test_p_e_and_lp_e_by_l3(self):
        pf.cpu(self.ctx, policies=12)
        pf.types(self.ctx)
        cpu = self.hw()["cpu"]
        self.assertEqual(cpu["types"], {"p": [f"policy{i}" for i in range(4)],
                                        "e": [f"policy{i}" for i in range(4, 8)],
                                        "lpe": [f"policy{i}" for i in range(8, 12)]})
        self.assertEqual(cpu["type_range"], {"p": {"min_mhz": 400, "max_mhz": 5100},
                                             "e": {"min_mhz": 400, "max_mhz": 3800},
                                             "lpe": {"min_mhz": 400, "max_mhz": 2500}})

    def test_not_hybrid_is_all_p_and_a_cpu_in_neither_list_is_p(self):
        pf.cpu(self.ctx, policies=4)
        pf.types(self.ctx, p=None, atom=None, policies=4)
        self.assertEqual(self.hw()["cpu"]["types"], {"p": ["policy0", "policy1", "policy2", "policy3"]})
        pf.put(self.ctx.sys_path("/sys/devices/cpu_core/cpus"), "0-1")
        pf.put(self.ctx.sys_path("/sys/devices/cpu_atom/cpus"), "2")     # cpu3 is in neither: p
        self.assertEqual(self.hw()["cpu"]["types"], {"p": ["policy0", "policy1", "policy3"], "e": ["policy2"]})

    def test_cpulist(self):
        self.assertEqual(powerhw._cpulist("0-3,8,10-11"), {0, 1, 2, 3, 8, 10, 11})
        self.assertEqual(powerhw._cpulist(""), set())
        self.assertEqual(powerhw._cpulist("x"), set())

    def test_perf_pct_needs_both_files(self):
        pf.cpu(self.ctx, policies=2)
        self.assertFalse(self.hw()["cpu"]["perf_pct"])
        pf.perf(self.ctx)
        hw = self.hw()
        self.assertTrue(hw["cpu"]["perf_pct"])
        self.assertEqual(powerhw.read(self.ctx, hw, gpu=False)["perf"], {"max": 100, "min": 9})


class SocTest(Base):
    def test_found_by_name_among_two_devices(self):
        pf.soc(self.ctx, dev="platform-profile-0", name="asus-wmi", params=False)
        d = pf.soc(self.ctx, dev="platform-profile-1")
        self.assertEqual(self.hw()["soc"]["profile"], d)

    def test_none_when_the_name_differs_or_a_param_is_missing(self):
        pf.soc(self.ctx, name="SoC power slider")
        self.assertIsNone(self.hw()["soc"])
        pf.soc(self.ctx)
        os.remove(pf.soc_param(self.ctx, "offset"))
        self.assertIsNone(self.hw()["soc"])

    def test_hex_read_and_write(self):
        pf.soc(self.ctx, balance="03", offset="00")
        hw = self.hw()
        self.assertEqual(powerhw.read(self.ctx, hw, gpu=False)["soc"],
                         {"balance": 3, "offset": 0, "profile": "balanced",
                          "choices": ["low-power", "balanced", "performance"]})
        res = self.apply({"soc": {"balance": 4, "offset": 2}})
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.w.calls[0], (pf.soc_param(self.ctx, "offset"), "02"))
        self.assertEqual(self.w.calls[1], (pf.soc_param(self.ctx, "balance"), "04"))
        self.assertEqual(self.w.calls[2][1], "balanced")
        self.assertEqual(res["written"], ["soc/offset", "soc/balance", "soc/profile"])

    def test_not_balanced_writes_the_params_only(self):
        d = pf.soc(self.ctx, profile="performance")
        res = self.apply({"soc": {"balance": 4, "offset": 0}})
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.w.paths(), [pf.soc_param(self.ctx, "balance")])
        self.assertEqual(pf.get(os.path.join(d, "profile")), "performance")
        self.assertEqual(res["failed"], [])

    def test_balance_reads_its_old_value_until_a_profile_write(self):
        pf.soc(self.ctx, profile="low-power")
        self.w.ignore.add("slider_balance")      # the kernel shows the old value until a profile is written
        res = self.apply({"soc": {"balance": 4}})
        self.assertEqual(res["failed"], [])
        self.assertEqual(res["written"], ["soc/balance"])

    def test_einval_and_equal_values(self):
        pf.soc(self.ctx)
        self.w.fail["slider_balance"] = errno.EINVAL
        res = self.apply({"soc": {"balance": 4, "offset": 0}})
        self.assertEqual([(f["id"], f["error"]) for f in res["failed"]], [("soc/balance", "the slider takes 1..5")])
        self.w.calls.clear()
        self.w.fail.clear()
        res = self.apply({"soc": {"balance": 3, "offset": 0}})     # nothing differs: no profile write either
        self.assertEqual(self.w.calls, [])

    def test_never_another_profile_or_the_legacy_file(self):
        pf.oxp3(self.ctx)
        pf.soc(self.ctx)
        pf.put(self.ctx.sys_path("/sys/firmware/acpi/platform_profile"), "balanced")
        for b in (1, 5, 3):
            self.apply({"soc": {"balance": b, "offset": 1}})
        for path, text in self.w.calls:
            self.assertNotIn(text, ("performance", "low-power", "custom", "quiet"))
            self.assertFalse(path.endswith("/acpi/platform_profile"), path)


class PerfTest(Base):
    def setUp(self):
        super().setUp()
        pf.cpu(self.ctx, policies=12)
        pf.types(self.ctx)
        pf.perf(self.ctx)

    def test_raising_writes_the_cap_first_lowering_the_floor_first(self):
        pf.perf(self.ctx, max=60, min=9)
        res = self.apply({"perf": {"max": 100, "min": 40}})
        self.assertEqual(res["written"], ["cpu/max_pct", "cpu/min_pct"])
        self.w.calls.clear()
        res = self.apply({"perf": {"max": 50, "min": 9}})
        self.assertEqual(res["written"], ["cpu/min_pct", "cpu/max_pct"])
        self.assertTrue(res["ok"], res)
        self.assertEqual((pf.get(pf.perf_path(self.ctx, "max")), pf.get(pf.perf_path(self.ctx, "min"))),
                         ("50", "9"))

    def test_floor_above_cap_is_lowered_and_equal_not_written(self):
        res = self.apply({"perf": {"max": 70, "min": 90}})
        self.assertEqual(pf.get(pf.perf_path(self.ctx, "min")), "70")
        self.w.calls.clear()
        res = self.apply({"perf": {"max": 70, "min": 70}})
        self.assertEqual((self.w.calls, res["ok"]), ([], True))

    def test_floor_reread_after_turbo_off(self):
        """7.2 store_no_turbo lowers min_perf_pct to max_pstate/turbo_pstate (about 40 %): the floor that matched
        before the turbo write is written again, not reported as "did not take"."""
        pf.perf(self.ctx, max=100, min=50)
        real = self.w.__call__

        def writer(path, text):
            real(path, text)
            if path.endswith("/no_turbo") and text == "1":
                pf.put(pf.perf_path(self.ctx, "min"), 40)

        with mock.patch.object(powerhw, "_write", writer):
            res = self.apply({"turbo": False, "perf": {"max": 100, "min": 50}})
        self.assertTrue(res["ok"], res)
        self.assertIn("cpu/min_pct", res["written"])
        self.assertEqual(pf.get(pf.perf_path(self.ctx, "min")), "50")

    def test_never_zero(self):
        res = self.apply({"perf": {"max": 0}})
        self.assertEqual([f["id"] for f in res["failed"]], ["cpu/max_pct"])
        self.assertNotIn("0", [t for _, t in self.w.calls])

    def test_caps_clamped_and_read_back_within_tolerance(self):
        pf.put(self.ctx.sys_path("/sys/devices/system/cpu/cpufreq/policy0/scaling_min_freq"), 800000)
        res = self.apply({"caps": {"policy0": 300000, "policy4": 9000000, "policy8": 2000000}})
        self.assertTrue(res["ok"], res)
        self.assertEqual(pf.get(pf.cap_path(self.ctx, "policy0")), "800000")      # its scaling_min_freq
        self.assertEqual(self.w.paths(), [pf.cap_path(self.ctx, "policy0"), pf.cap_path(self.ctx, "policy8")])
        self.w.calls.clear()
        pf.put(pf.cap_path(self.ctx, "policy8"), 2050000)                 # HWP rounding: within 100 MHz
        res = self.apply({"caps": {"policy8": 2000000}})
        self.assertEqual((self.w.calls, res["ok"]), ([], True))

    def test_cap_einval_on_one_policy(self):
        self.w.fail["policy4/scaling_max_freq"] = errno.EINVAL
        res = self.apply({"caps": {"policy4": 2000000, "policy5": 2000000}})
        self.assertEqual([f["id"] for f in res["failed"]], ["cpu/cap/policy4"])
        self.assertEqual(res["written"], ["cpu/cap/policy5"])

    def test_scaling_min_freq_is_never_written(self):
        pf.oxp3(self.ctx)
        self.apply({"perf": {"max": 40, "min": 20}, "caps": {f"policy{i}": 1500000 for i in range(12)},
                    "epp": {"policy0": "power", "policy4": "performance"}})
        self.assertFalse([p for p in self.w.paths() if p.endswith("scaling_min_freq")])


class GpuProfileTest(Base):
    def setUp(self):
        super().setUp()
        pf.xe(self.ctx)
        self.f = pf.gpu_profile(self.ctx)

    def test_parsing(self):
        hw = self.hw()
        self.assertTrue(hw["gpu"]["power_profile"])
        for text, want in (("[base]    power_saving", "base"), ("base    [power_saving]", "power_saving"),
                           ("invalid", None)):
            pf.put(self.f, text)
            self.assertEqual(powerhw.read(self.ctx, hw, gpu=False)["gpu"]["profile"], want)

    def test_written_and_read_back(self):
        self.w.ignore.add("power_profile")
        pf.put(self.f, "base    [power_saving]")     # what the driver shows after the write
        res = self.apply({"gpu_profile": "power_saving"})
        self.assertEqual((res["written"], res["ok"]), ([], True))
        pf.put(self.f, "[base]    power_saving")
        res = self.apply({"gpu_profile": "power_saving"})
        self.assertEqual(self.w.calls[-1], (self.f, "power_saving"))
        self.assertEqual([(f["id"], f["transient"]) for f in res["failed"]], [("gpu/profile", True)])  # reads base

    def test_eio_is_transient(self):
        self.w.fail["power_profile"] = errno.EIO
        res = self.apply({"gpu_profile": "power_saving"})
        self.assertEqual([(f["id"], f["transient"]) for f in res["failed"]], [("gpu/profile", True)])
        self.w.fail["power_profile"] = [errno.EAGAIN, errno.EAGAIN, errno.EAGAIN]
        res = self.apply({"gpu_profile": "power_saving"})
        self.assertEqual(len([c for c in self.w.calls if c[0] == self.f]), 4)    # 1 + 3 tries
        self.assertTrue(res["failed"][0]["transient"])

    def test_the_media_gt_and_clock_files_are_untouched(self):
        pf.gpu_profile(self.ctx, gt="gt1")
        seen = []
        real = powerhw._read
        hw = self.hw()
        with mock.patch.object(powerhw, "_read", lambda p: seen.append(p) or real(p)):
            powerhw.read(self.ctx, hw, gpu=False)
        self.assertFalse([p for p in seen if p.endswith(("min_freq", "max_freq", "act_freq", "cur_freq"))
                          and "/drm/" in p])
        self.apply({"gpu_profile": "power_saving"})
        self.assertFalse([p for p in self.w.paths() if "/gt1/" in p])
