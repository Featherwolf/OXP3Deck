"""power.py on fake OXP3 trees (tests/powerfake.py): the range, clamping, both RAPL interfaces, the boot snapshot,
settings and profiles, events (game, AC, resume), drift, conflicts and the SimpleDeckyTDP import."""
import errno
import json
import logging
import os
import sys
import tempfile
import types
import unittest
from unittest import mock

from oxp3deck import power, powerhw, sysexec
from tests import powerfake as pf
from tests import stub_decky

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "power")
MW = pf.MW
MSR, MMIO = "intel-rapl:0", "intel-rapl-mmio:0"


def units(name):
    with open(os.path.join(FIX, f"units-{name}.txt")) as f:
        return f.read()


class Base(unittest.TestCase):
    oxp3 = True

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(power._STATES.clear)
        logger = logging.getLogger("oxp3deck")     # what power.py logs on purpose here
        self.addCleanup(logger.setLevel, logger.level)
        logger.setLevel(logging.CRITICAL)
        self.ctx = stub_decky.make_ctx(self.tmp.name)
        if self.oxp3:
            pf.oxp3(self.ctx)
        self.w = pf.Writer()
        self.t = 1000.0
        self.gap = 0.0
        self.units = units("none")
        self.systemctl_rc = 0
        self.runs = []

        def run(argv, **kw):
            self.runs.append(argv)
            return sysexec.Result(self.systemctl_rc, self.units if self.systemctl_rc == 0 else "",
                                  "" if self.systemctl_rc == 0 else "Failed to connect to bus")

        for target, name, value in ((powerhw, "_write", self.w), (powerhw, "_sleep", lambda s: None),
                                    (power, "_monotonic", lambda: self.t), (power, "_clock_gap", lambda: self.gap),
                                    (sysexec, "run", run), (sysexec, "which", lambda n: "/usr/bin/" + n)):
            p = mock.patch.object(target, name, value)
            p.start()
            self.addCleanup(p.stop)

    def restart(self):
        """A new plugin process: a fresh _Power reading power.json and the run state."""
        power._STATES.clear()

    def watts(self, zone, which="long_term"):
        return pf.watts(self.ctx, zone, which)

    def on(self):
        res = power.enable(self.ctx, True)
        self.assertTrue(res["ok"], res)
        return res

    def set(self, key="default", slot="main", **values):
        res = power.set_values(self.ctx, key, slot, values)
        self.assertTrue(res["ok"], res)
        return res

    def tick(self, dt=power.TICK_S):
        self.t += dt
        res = power.tick(self.ctx)
        self.assertTrue(res["ok"], res)
        return res["did"]

    def plug(self, online):
        pf.ac(self.ctx, online=online)


class LimitsTest(Base):
    def lim(self, ac):
        p = power._get(self.ctx)
        return power.limits(self.ctx, power._hw(self.ctx, p), ac)

    def test_oxp3(self):
        r = self.lim(False)
        self.assertEqual((r["pl1_min"], r["pl1_max"], r["pl2_max"]), (5, 35, 52))
        self.assertEqual((r["pl1_max_battery"], r["pl1_max_ac"], r["extended_max"]), (35, 40, 52))
        self.assertEqual((r["gpu_min"], r["gpu_max"], r["gpu_efficient"], r["spec"]), (100, 2300, 900, "oxp3"))
        self.assertEqual(self.lim(True)["pl1_max"], 40)
        self.assertEqual(self.lim(None)["pl1_max"], 35)
        self.assertTrue(power.options(self.ctx, {"extended": True})["ok"])
        self.assertEqual(self.lim(True)["pl1_max"], 52)
        self.assertEqual(self.lim(False)["pl1_max"], 35)     # extended is AC only

    def test_another_device_is_capped_at_its_firmware(self):
        pf.dmi(self.ctx, "MSI", "Claw 8 AI+ A2VM")
        r = self.lim(True)
        self.assertEqual((r["pl1_max"], r["pl1_max_ac"], r["extended_max"], r["spec"]), (35, 35, None, "firmware"))

    def test_pl2_capped_by_a_short_term_maximum_above_zero(self):
        pf.rapl(self.ctx, MSR, pl2_max=45)
        self.assertEqual(self.lim(False)["pl2_max"], 45)
        self.assertEqual(self.lim(True)["pl1_max"], 40)
        pf.rapl(self.ctx, MSR, pl2_max=0, base=10)      # PL1's max_power_uw is base power, not a bound
        power._STATES.clear()
        r = self.lim(False)
        self.assertEqual((r["pl2_max"], r["pl1_max"]), (52, 35))

    def test_rounded_down_to_an_eighth(self):
        self.assertEqual(power._w(52_100_000), 52)
        self.assertEqual(power._w(25_130_000), 25.125)


class ApplyTest(Base):
    def test_enabling_with_all_null_writes_nothing(self):
        res = self.on()
        self.assertEqual(self.w.calls, [])
        self.assertEqual(res["applied"]["written"], [])
        self.assertEqual(res["state"]["applied_values"]["pl1_w"], 25)    # the lowest of MSR 25 and MMIO 35

    def test_both_interfaces_get_the_same_values(self):
        self.on()
        res = self.set(pl1_w=15, pl2_w=25)
        for z in (MSR, MMIO):
            self.assertEqual((self.watts(z), self.watts(z, "short_term")), (15, 25), z)
        self.assertEqual(self.watts(MSR, "peak_power"), 160)
        self.assertEqual(res["state"]["now"]["pl1_w"], 15)
        self.assertEqual(res["state"]["values"]["pl1_w"], 15)

    def test_clamping(self):
        self.on()
        self.set(pl1_w=5)
        self.assertEqual(self.watts(MSR), 5)
        self.set(pl1_w=60, pl2_w=None)
        self.assertEqual(self.watts(MSR), 35)         # battery
        self.set(pl1_w=30, pl2_w=10)
        self.assertEqual(self.watts(MMIO, "short_term"), 30)
        self.set(pl2_w=90)
        self.assertEqual(self.watts(MSR, "short_term"), 52)
        self.set(gpu_min_mhz=0, gpu_max_mhz=5000)
        f = self.ctx.sys_path("/sys/class/drm/card1/device/tile0/gt0/freq0")
        self.assertEqual((pf.get(f + "/min_freq"), pf.get(f + "/max_freq")), ("100", "2300"))
        self.assertFalse(power.set_values(self.ctx, "default", "main", {"pl1_w": 3})["ok"])   # stored bounds

    def test_null_pl2_is_the_firmware_boost_but_not_below_pl1(self):
        pf.set_watts(self.ctx, MMIO, "short_term", 40)   # another tool's leftover: firmware sets 52 W on both
        self.on()
        self.set(pl1_w=20)
        self.assertEqual((self.watts(MSR, "short_term"), self.watts(MMIO, "short_term")), (52, 52))
        self.plug(True)
        self.set(pl1_w=40)                             # AC: up to 40 W
        self.assertEqual((self.watts(MSR, "short_term"), self.watts(MMIO, "short_term")), (52, 52))
        self.set(pl1_w=None)
        self.assertEqual((self.watts(MSR), self.watts(MMIO)), (25, 35))   # null: firmware again

    def test_gpu_epp_turbo(self):
        self.on()
        self.set(gpu_min_mhz=300, gpu_max_mhz=1800, epp="balance_power", turbo=False)
        f = self.ctx.sys_path("/sys/class/drm/card1/device/tile0/gt0/freq0")
        self.assertEqual((pf.get(f + "/min_freq"), pf.get(f + "/max_freq")), ("300", "1800"))
        self.assertEqual(pf.get(pf.epp_path(self.ctx, "policy7")), "balance_power")
        self.assertEqual(pf.get(pf.no_turbo_path(self.ctx)), "1")
        st = power.state(self.ctx)["state"]
        self.assertEqual((st["now"]["epp"], st["now"]["turbo"], st["now"]["gpu"]["max"]), ("balance_power", False,
                                                                                           1800))
        self.set(gpu_min_mhz=None, gpu_max_mhz=None, epp=None, turbo=None)
        self.assertEqual((pf.get(f + "/min_freq"), pf.get(f + "/max_freq")), ("850", "2300"))
        self.assertEqual(pf.get(pf.epp_path(self.ctx)), "balance_performance")
        self.assertEqual(pf.get(pf.no_turbo_path(self.ctx)), "0")

    def test_a_locked_msr_limit_is_not_tried_again(self):
        self.w.fail[pf.limit(self.ctx, MSR, "long_term")] = errno.EACCES
        self.on()
        res = self.set(pl1_w=15)
        self.assertTrue(res["ok"])                    # partly applied
        self.assertEqual(res["applied"]["failed"][0]["id"], f"{MSR}/pl1")
        self.assertEqual(self.watts(MMIO), 15)
        zone = next(z for z in res["state"]["now"]["zones"] if z["id"] == MSR)
        self.assertEqual(zone["locked"], ["pl1"])
        n = len(self.w.calls)
        self.set(pl1_w=12)
        self.assertNotIn(pf.limit(self.ctx, MSR, "long_term"), self.w.paths()[n:])

    def test_everything_failing_is_not_ok(self):
        self.on()
        for z in (MSR, MMIO):
            self.w.fail[pf.limit(self.ctx, z, "long_term")] = errno.EIO
        res = power.set_values(self.ctx, "default", "main", {"pl1_w": 15})
        self.assertFalse(res["ok"])
        self.assertIn("Input/output error", res["error"])

    def test_cpu_conflict_leaves_epp_and_turbo(self):
        self.units = units("cachyos-lpmd")
        self.on()
        res = self.set(pl1_w=15, epp="power", turbo=False)
        self.assertEqual(self.watts(MSR), 15)
        self.assertEqual(pf.get(pf.epp_path(self.ctx)), "balance_performance")
        self.assertEqual(pf.get(pf.no_turbo_path(self.ctx)), "0")
        self.assertIn("intel_lpmd", res["state"]["cpu_blocked"])
        self.assertTrue(power.options(self.ctx, {"ignore": ["intel_lpmd"]})["ok"])
        self.assertEqual(pf.get(pf.epp_path(self.ctx)), "power")
        self.assertIsNone(power.state(self.ctx)["state"]["cpu_blocked"])


class SnapshotTest(Base):
    def test_taken_before_the_first_write_and_restored_when_off(self):
        self.on()
        self.set(pl1_w=15, pl2_w=20, gpu_max_mhz=1200, epp="power", turbo=False)
        snap = power._get(self.ctx).run["snapshot"]
        self.assertEqual(snap["rapl"][MSR], {"pl1_uw": 25 * MW, "pl2_uw": 52 * MW})
        self.assertEqual(snap["gpu"], {"min": 850, "max": 2300})
        res = power.enable(self.ctx, False)
        self.assertTrue(res["ok"], res)
        self.assertEqual((self.watts(MSR), self.watts(MSR, "short_term")), (25, 52))
        self.assertEqual((self.watts(MMIO), self.watts(MMIO, "short_term")), (35, 52))
        self.assertEqual(pf.get(pf.epp_path(self.ctx)), "balance_performance")
        self.assertEqual(pf.get(pf.no_turbo_path(self.ctx)), "0")
        self.assertFalse(res["state"]["enabled"])

    def test_kept_per_boot_across_a_plugin_restart(self):
        self.on()
        self.set(pl1_w=15)
        path = os.path.join(sysexec.run_dir(self.ctx), power.RUN_FILE)
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.restart()
        self.assertEqual(power._get(self.ctx).run["snapshot"]["rapl"][MSR]["pl1_uw"], 25 * MW)  # not 15
        self.assertEqual(self.tick(), "nothing")       # the boot apply finds everything in place
        pf.boot_id(self.ctx, "boot-2")                 # rebooted: firmware values again
        pf.set_watts(self.ctx, MSR, "long_term", 25)
        self.restart()
        self.assertIsNone(power._get(self.ctx).run["snapshot"])
        self.assertEqual(self.tick(), "applied")
        self.assertEqual(self.watts(MSR), 15)
        self.assertEqual(power._get(self.ctx).run["snapshot"]["rapl"][MSR]["pl1_uw"], 25 * MW)


class SettingsTest(Base):
    def path(self):
        return os.path.join(self.ctx.settings_dir, power.SETTINGS_FILE)

    def write(self, data):
        with open(self.path(), "w") as f:
            f.write(data if isinstance(data, str) else json.dumps(data))
        self.restart()

    def info(self):
        res = power.info(self.ctx, False)
        self.assertTrue(res["ok"], res)
        return res["info"]

    def test_defaults_and_bad_json(self):
        for content in (None, "{not json", "[]"):
            if content is not None:
                self.write(content)
            i = self.info()
            self.assertEqual(i["options"], {"per_game": True, "split_ac": False, "extended": False, "ignore": [],
                                            "poll_s": 2})
            self.assertEqual(i["profiles"], {"default": {"name": None, "main": power._empty_values(), "ac": None}})
            self.assertFalse(i["state"]["enabled"])

    def test_wrong_types_read_as_null_and_bad_keys_are_dropped(self):
        self.write({"version": 7, "enabled": "yes", "split_ac": 1, "ignore": ["hhd", "thermald", 3], "junk": 1,
                    "profiles": {"default": {"main": {"pl1_w": "15", "pl2_w": 30, "gpu_max_mhz": 9000,
                                                      "epp": "fast", "turbo": True}},
                                 "123": {"name": "X", "main": {"pl1_w": 3.0}, "ac": {"pl1_w": 20.0}},
                                 "../x": {}, "12345678901": {}}})
        with self.assertLogs("oxp3deck", "WARNING"):
            i = self.info()
        d = i["profiles"]["default"]["main"]
        self.assertEqual((d["pl1_w"], d["pl2_w"], d["gpu_max_mhz"], d["epp"], d["turbo"]), (None, 30, None, None, True))
        self.assertEqual(sorted(i["profiles"]), ["123", "default"])
        self.assertEqual((i["profiles"]["123"]["main"]["pl1_w"], i["profiles"]["123"]["ac"]["pl1_w"]), (None, 20))
        self.assertEqual(i["options"]["ignore"], ["hhd"])
        self.assertFalse(i["state"]["enabled"])
        self.assertTrue(power.options(self.ctx, {"per_game": False})["ok"])
        with open(self.path()) as f:
            saved = json.load(f)
        self.assertNotIn("junk", saved)
        self.assertEqual(saved["version"], 1)

    def test_profiles(self):
        self.set(pl1_w=12)
        self.assertTrue(power.profile(self.ctx, "1091500", "Cyberpunk 2077", True)["ok"])
        prof = self.info()["profiles"]["1091500"]
        self.assertEqual((prof["name"], prof["main"]["pl1_w"], prof["ac"]), ("Cyberpunk 2077", 12, None))
        self.set("1091500", pl2_w=20)
        self.set("1091500", pl1_w=None)
        main = self.info()["profiles"]["1091500"]["main"]
        self.assertEqual((main["pl1_w"], main["pl2_w"]), (None, 20))     # merged; null replaces
        self.set("1091500", "ac", turbo=False)
        ac = self.info()["profiles"]["1091500"]["ac"]
        self.assertEqual((ac["pl2_w"], ac["turbo"]), (20, False))        # main copied in first
        for args, why in ((("999", "main", {"pl1_w": 10}), "no profile"), (("default", "dc", {}), "slot"),
                          (("default", "main", {"tdp": 10}), "unknown field"),
                          (("default", "main", {"epp": "fast"}), "epp must be")):
            res = power.set_values(self.ctx, *args)
            self.assertFalse(res["ok"])
            self.assertIn(why, res["error"])
        self.assertFalse(power.profile(self.ctx, "default", None, False)["ok"])
        self.assertFalse(power.profile(self.ctx, "x1", None, True)["ok"])
        self.assertTrue(power.profile(self.ctx, "1091500", None, False)["ok"])
        self.assertNotIn("1091500", self.info()["profiles"])

    def test_max_profiles(self):
        with mock.patch.object(power, "MAX_PROFILES", 3):
            for i in range(3):
                self.assertTrue(power.profile(self.ctx, str(i + 1), None, True)["ok"])
            res = power.profile(self.ctx, "4", None, True)
            self.assertFalse(res["ok"])
            self.assertIn("at most 3", res["error"])

    def test_options(self):
        for opts, why in (({"per_game": 1}, "true or false"), ({"enabled": True}, "unknown option"),
                          ({"ignore": ["thermald"]}, "cannot be ignored"), ("x", "object")):
            res = power.options(self.ctx, opts)
            self.assertFalse(res["ok"], opts)
            self.assertIn(why, res["error"])
        self.assertTrue(power.options(self.ctx, {"ignore": ["hhd", "ppd", "hhd"], "split_ac": True})["ok"])
        self.assertEqual(self.info()["options"]["ignore"], ["hhd", "ppd"])


class ActiveTest(Base):
    def active(self):
        return power.state(self.ctx)["state"]["active"]

    def test_which_profile_runs(self):
        self.on()
        self.set(pl1_w=10)
        power.game(self.ctx, "1091500")
        self.assertEqual(self.active()["key"], "default")              # no profile for it
        power.profile(self.ctx, "1091500", "Cyberpunk 2077", True)
        self.assertEqual((self.active()["key"], self.active()["name"]), ("1091500", "Cyberpunk 2077"))
        power.options(self.ctx, {"per_game": False})
        self.assertEqual(self.active()["key"], "default")
        power.options(self.ctx, {"per_game": True, "split_ac": True})
        self.assertEqual(self.active()["slot"], "main")                 # on battery
        self.plug(True)
        self.assertEqual(self.active()["slot"], "main")                 # ac is null
        self.set("1091500", "ac", pl1_w=30)
        self.assertEqual((self.active()["slot"], self.watts(MSR)), ("ac", 30))
        power.options(self.ctx, {"split_ac": False})
        self.assertEqual(self.active()["slot"], "main")

    def test_a_game_change_applies_its_profile(self):
        self.on()
        power.profile(self.ctx, "1091500", "Cyberpunk 2077", True)
        self.set("1091500", pl1_w=15)
        self.assertEqual(self.watts(MSR), 25)              # not running: saved only
        res = power.game(self.ctx, "1091500")
        self.assertEqual(res["applied"]["written"], [f"{MMIO}/pl1", f"{MSR}/pl1"])   # PL2 null: firmware's
        self.assertEqual(self.watts(MSR), 15)
        power.game(self.ctx, None)
        self.assertEqual(self.watts(MSR), 25)
        self.assertFalse(power.game(self.ctx, "abc")["ok"])

    def test_disabled_writes_nothing(self):
        power.profile(self.ctx, "1", None, True)
        self.set("1", pl1_w=10)
        power.game(self.ctx, "1")
        for _ in range(3):
            self.assertEqual(self.tick(), "idle")
        self.plug(True)
        self.assertEqual(self.tick(), "idle")
        self.assertEqual(self.w.calls, [])


class EventsTest(Base):
    def setUp(self):
        super().setUp()
        self.on()
        self.set(pl1_w=15, pl2_w=25)
        self.assertEqual(self.tick(), "nothing")          # the first tick: conflicts, boot apply (all in place)

    def firmware_resets_mmio(self):
        pf.set_watts(self.ctx, MMIO, "long_term", 35)
        pf.set_watts(self.ctx, MMIO, "short_term", 52)

    def test_ac_flapping_gives_one_apply_after_it_settles(self):
        for i in range(5):                              # 5 changes in 6 s (one per tick here)
            self.plug(i % 2 == 0)
            self.firmware_resets_mmio()
            self.assertEqual(self.tick(1.2), "nothing")
        n = len(self.w.calls)
        self.assertEqual(self.tick(1.0), "nothing")      # 1 s after the last change
        self.assertEqual(self.tick(1.0), "applied")      # 2 s after it
        self.assertEqual(self.watts(MMIO), 15)
        self.assertEqual(len(self.w.calls) - n, 2)       # MMIO PL1 and PL2 only
        self.firmware_resets_mmio()                      # firmware, a little later: inside the grace window
        self.assertEqual(self.tick(), "applied")
        self.assertEqual(self.watts(MMIO), 15)
        self.assertEqual(self.tick(), "nothing")

    def test_resume_by_suspend_count(self):
        pf.suspend(self.ctx, 1)
        self.firmware_resets_mmio()
        self.assertEqual(self.tick(1), "nothing")          # seen
        self.assertEqual(self.tick(1), "nothing")
        self.assertEqual(self.tick(1), "nothing")
        self.assertEqual(self.tick(1), "applied")          # +3 s
        self.assertEqual(self.watts(MMIO), 15)
        self.firmware_resets_mmio()                        # seen again at the verify, still in grace
        self.assertEqual(self.tick(7), "applied")
        self.assertEqual(self.tick(), "nothing")

    def test_resume_by_a_boottime_jump(self):
        self.gap += 600
        self.firmware_resets_mmio()
        self.assertEqual(self.tick(1), "nothing")
        self.assertEqual(self.tick(2), "nothing")
        self.assertEqual(self.tick(1), "applied")
        self.assertEqual(self.watts(MMIO), 15)

    def test_grace_reapplies_at_most_three_times(self):
        self.plug(True)
        self.tick(1)
        self.assertEqual(self.tick(2), "applied")
        for _ in range(3):
            self.firmware_resets_mmio()
            self.assertEqual(self.tick(1), "applied")
        self.firmware_resets_mmio()
        self.assertEqual(self.tick(1), "nothing")          # seen once
        self.assertEqual(self.tick(1), "overridden")


class DriftTest(Base):
    def setUp(self):
        super().setUp()
        self.units = units("hhd")
        power.options(self.ctx, {"ignore": ["hhd", "ppd"]})
        self.on()
        self.set(pl1_w=15, pl2_w=25)
        self.tick()

    def test_something_else_changes_a_limit(self):
        pf.set_watts(self.ctx, MSR, "long_term", 35)
        self.assertEqual(self.tick(), "nothing")
        self.assertEqual(self.tick(), "overridden")
        st = power.state(self.ctx)["state"]
        self.assertEqual({k: st["overridden"][k] for k in ("what", "ours", "now")},
                         {"what": f"{MSR}/pl1", "ours": "15 W", "now": "35 W"})
        self.assertEqual(st["overridden"]["suspects"], ["hhd"])   # ppd sets EPP, not the power limits
        self.assertTrue(power.summary(self.ctx)["overridden"])
        n = len(self.w.calls)
        self.plug(True)                                     # AC, resume, game: nothing is written now
        pf.suspend(self.ctx, 3)
        for _ in range(5):
            self.assertEqual(self.tick(), "overridden")
        power.profile(self.ctx, "7", None, True)
        power.game(self.ctx, "7")
        self.assertEqual(len(self.w.calls), n)
        res = power.take_control(self.ctx)
        self.assertTrue(res["ok"], res)
        self.assertIsNone(res["state"]["overridden"])
        self.assertEqual(self.watts(MSR), 15)

    def test_set_values_on_the_active_profile_takes_control(self):
        pf.set_watts(self.ctx, MSR, "long_term", 35)
        self.tick()
        self.tick()
        self.set(pl1_w=16)
        self.assertEqual(self.watts(MSR), 16)
        self.assertIsNone(power.state(self.ctx)["state"]["overridden"])

    def test_suspect_steam(self):
        self.units = units("none")
        self.tick(power.CONFLICT_RECHECK_S)
        pf.set_watts(self.ctx, MMIO, "long_term", 20)
        self.tick()
        self.tick()
        self.assertEqual(power.state(self.ctx)["state"]["overridden"]["suspects"], ["steam"])

    def test_gpu_drift_is_seen_by_state_only(self):
        self.set(gpu_max_mhz=1500)
        f = self.ctx.sys_path("/sys/class/drm/card1/device/tile0/gt0/freq0/max_freq")
        pf.put(f, 2300)
        for _ in range(3):
            self.assertEqual(self.tick(), "nothing")
        st = power.state(self.ctx)["state"]
        self.assertEqual(st["overridden"]["what"], "gpu/max")


class ConflictTest(Base):
    def blocked_by(self, name):
        self.units = units(name)
        res = power.enable(self.ctx, False)
        res = power.enable(self.ctx, True)
        return res

    def test_blockers_refuse_enable(self):
        for fixture, names in (("bazzite", "PowerStation, thermald"), ("cachyos-owner", "thermald"),
                               ("hhd", "Handheld Daemon")):
            res = self.blocked_by(fixture)
            self.assertFalse(res["ok"], fixture)
            self.assertEqual(res["error"], f"another power manager is active: {names}")
            self.assertTrue(res["conflicts"])
            self.assertFalse(res["state"]["enabled"])
        self.assertEqual(self.w.calls, [])
        power.options(self.ctx, {"ignore": ["hhd"]})
        self.assertTrue(self.blocked_by("hhd")["ok"])     # an ignored hhd does not block

    def test_rows(self):
        self.units = units("bazzite")
        rows = {r["id"]: r for r in power.conflicts(self.ctx)}
        self.assertEqual(sorted(rows), ["powerstation", "thermald", "tuned"])
        self.assertEqual(rows["tuned"]["kind"], "cpu")
        self.assertIn("systemctl disable --now powerstation.service", rows["powerstation"]["fix"])
        self.assertEqual(set(rows["thermald"]), {"id", "name", "kind", "ignorable", "ignored", "why", "fix",
                                                 "fix_units", "fix_plan", "fixed"})
        self.assertEqual(rows["tuned"]["fix_units"], ["tuned-ppd.service", "tuned.service"])
        self.assertIsNone(rows["thermald"]["fixed"])
        self.assertEqual(self.runs[0][1:], ["list-units", "--all", "--type=service", "--plain", "--no-legend",
                                            "--no-pager"])
        self.assertEqual(sum("list-units" in r for r in self.runs), 1)
        self.assertTrue(all("show" in r for r in self.runs[1:]), self.runs)     # fix_plan: read-only show
        n = len(self.runs)
        power.conflicts(self.ctx)
        self.assertEqual(len(self.runs), n)                 # cached
        self.units = units("cachyos-lpmd")
        self.t += power.CONFLICT_RECHECK_S
        self.assertEqual([r["id"] for r in power.conflicts(self.ctx)], ["intel_lpmd"])

    def test_decky_plugins(self):
        pf.plugins(self.ctx, {"SimpleDeckyTDP": True, "PowerTools": False, "OXP3Deck": True})
        ids = [r["id"] for r in power.conflicts(self.ctx)]
        self.assertEqual(ids, ["simpledeckytdp"])
        power._STATES.clear()
        pf.plugins(self.ctx, {"SimpleDeckyTDP": False, "PowerTools": True})
        rows = power.conflicts(self.ctx)
        self.assertEqual([(r["id"], r["name"]) for r in rows], [("powercontrol", "PowerTools")])
        self.assertIn("uninstall PowerTools", rows[0]["fix"])

    def test_steamos_remote_and_comm(self):
        pf.put(self.ctx.sys_path("/usr/share/steamos-manager/remotes.d/powerstation.toml"),
               "[performance.tdp_limit]\nmethod = \"TdpLimit1\"")
        pf.put(self.ctx.sys_path("/proc/4242/comm"), "thermald")
        rows = {r["id"]: r for r in power.conflicts(self.ctx)}
        self.assertEqual(sorted(rows), ["steamos-remote", "thermald"])
        self.assertTrue(rows["steamos-remote"]["ignorable"])
        self.assertIn("remotes.d/powerstation.toml", rows["steamos-remote"]["why"])
        self.assertNotIn("remove", rows["steamos-remote"]["fix"])          # under /usr/share it cannot be
        self.assertEqual(rows["thermald"]["fix_units"], [])                # not started by systemd
        self.assertFalse(power.fix(self.ctx, "thermald")["ok"])

    def test_systemctl_failing(self):
        self.systemctl_rc = 1
        rows = power.conflicts(self.ctx)
        self.assertEqual([(r["id"], r["kind"]) for r in rows], [("unknown", "suspect")])
        self.assertIn("Failed to connect to bus", rows[0]["why"])
        self.on()

    def test_a_blocker_appearing_while_enabled(self):
        self.on()
        self.set(pl1_w=15)
        self.tick()
        self.units = units("bazzite")
        self.assertEqual(self.tick(power.CONFLICT_RECHECK_S), "blocked")
        self.assertEqual(self.watts(MSR), 15)                # nothing restored
        st = power.state(self.ctx)["state"]
        self.assertIn("PowerStation", st["blocked"])
        self.assertEqual(power.summary(self.ctx)["blocked"], st["blocked"])
        n = len(self.w.calls)
        self.set(pl1_w=10)                                  # saved, not written
        self.assertEqual(len(self.w.calls), n)
        self.assertFalse(power.take_control(self.ctx)["ok"])
        self.units = units("none")
        self.assertEqual(self.tick(power.CONFLICT_RECHECK_S), "applied")   # it has gone
        self.assertEqual(self.watts(MSR), 10)


class ImportTest(Base):
    def put_sdtdp(self, text):
        pf.put(os.path.join(pf.homebrew(self.ctx), "settings", "SimpleDeckyTDP", "settings.json"), text)

    def test_import(self):
        with open(os.path.join(FIX, "sdtdp-settings.json")) as f:
            self.put_sdtdp(f.read())
        self.assertTrue(power.info(self.ctx, False)["info"]["sdtdp_found"])
        res = power.import_sdtdp(self.ctx)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["imported"], ["Default", "Default (AC)", "1091500", "1091500 (AC)"])
        self.assertIn("notanapp: not a profile", res["skipped"])
        self.assertIn("Default: gpuMode BALANCE", res["skipped"])
        self.assertIn("Default: smt", res["skipped"])
        i = power.info(self.ctx, False)["info"]
        d = i["profiles"]["default"]
        self.assertEqual(d["main"], dict(power._empty_values(), pl1_w=12, epp="balance_power", turbo=False))
        self.assertEqual((d["ac"]["pl1_w"], d["ac"]["gpu_min_mhz"], d["ac"]["gpu_max_mhz"], d["ac"]["turbo"]),
                         (28, 400, 2000, True))
        g = i["profiles"]["1091500"]
        self.assertEqual((g["name"], g["main"]["pl1_w"], g["main"]["gpu_min_mhz"], g["main"]["gpu_max_mhz"],
                          g["main"]["epp"]), (None, 18, 1500, 1500, "performance"))
        self.assertEqual(g["ac"]["pl1_w"], 5)                  # stored within 5..100 W
        self.assertTrue(i["options"]["split_ac"])
        self.assertEqual(self.w.calls, [])                     # off: nothing applied

    def test_per_game_off_imports_only_the_defaults(self):
        self.put_sdtdp(json.dumps({"enableTdpProfiles": False, "tdpProfiles": {"default": {"tdp": 9},
                                                                                "42": {"tdp": 20}}}))
        res = power.import_sdtdp(self.ctx)
        self.assertEqual(res["imported"], ["Default"])
        self.assertNotIn("42", power.info(self.ctx, False)["info"]["profiles"])

    def test_missing_switches_read_as_off_like_simpledeckytdp(self):
        # SimpleDeckyTDP: enableTdpProfiles defaults to false; -ac-power entries run only with advanced
        # acPowerProfiles on, and stay in the file after it is turned off
        self.put_sdtdp(json.dumps({"tdpProfiles": {"default": {"tdp": 9}, "default-ac-power": {"tdp": 20},
                                                   "123": {"tdp": 15}}}))
        res = power.import_sdtdp(self.ctx)
        self.assertEqual(res["imported"], ["Default"])
        self.assertIn("default-ac-power: AC power profiles were off in SimpleDeckyTDP", res["skipped"])
        i = power.info(self.ctx, False)["info"]
        self.assertFalse(i["options"]["split_ac"])
        self.assertIsNone(i["profiles"]["default"]["ac"])
        self.put_sdtdp(json.dumps({"enableTdpProfiles": True, "advanced": {"acPowerProfiles": False},
                                   "tdpProfiles": {"default": {"tdp": 9}, "123-ac-power": {"tdp": 20},
                                                   "123": {"tdp": 15}}}))
        res = power.import_sdtdp(self.ctx)
        self.assertEqual(res["imported"], ["Default", "123"])
        self.assertFalse(power.info(self.ctx, False)["info"]["options"]["split_ac"])

    def test_missing_and_too_big(self):
        res = power.import_sdtdp(self.ctx)
        self.assertFalse(res["ok"])
        self.assertIn("not found", res["error"])
        self.put_sdtdp("x" * 2_000_000)
        res = power.import_sdtdp(self.ctx)
        self.assertFalse(res["ok"])
        self.assertIn("more than 1 MB", res["error"])


class ReviewTest(Base):
    """Cases from the hardware and UX reviews of the first build."""

    def test_another_tools_leftover_is_not_taken_for_firmware(self):
        for k in ("long_term", "short_term", "peak_power"):     # SimpleDeckyTDP: PL1 = PL2 = PL4, MMIO only
            pf.set_watts(self.ctx, MMIO, k, 15)
        self.on()
        res = self.set(pl1_w=30)
        self.assertEqual((self.watts(MMIO, "short_term"), self.watts(MSR, "short_term")), (52, 52))
        self.assertEqual(res["state"]["applied_values"]["pl2_w"], 52)
        self.assertTrue(power.enable(self.ctx, False)["ok"])
        self.assertEqual((self.watts(MMIO), self.watts(MMIO, "short_term")), (15, 52))

    def test_the_oxp3_ceiling_is_a_constant_not_the_registers(self):
        for z in (MSR, MMIO):
            pf.set_watts(self.ctx, z, "short_term", 90)
        self.plug(True)
        self.assertTrue(power.options(self.ctx, {"extended": True})["ok"])
        self.on()
        res = self.set(pl1_w=100)
        r = res["state"]["range"]
        self.assertEqual((r["pl1_max"], r["pl2_max"], r["extended_max"]), (52, 52, 52))
        self.assertEqual((self.watts(MSR), self.watts(MSR, "short_term")), (52, 52))

    def test_a_low_pl4_is_reported(self):
        pf.set_watts(self.ctx, MMIO, "peak_power", 15)          # Handheld Daemon's or SimpleDeckyTDP's leftover
        self.on()
        res = self.set(pl1_w=30)
        self.assertTrue(res["ok"])
        f = [x for x in res["applied"]["failed"] if x["id"] == f"{MMIO}/pl4"]
        self.assertEqual(len(f), 1)
        self.assertIn("peak limit 15 W is below boost", f[0]["error"])
        self.assertEqual(self.watts(MMIO, "peak_power"), 15)    # never written
        self.assertTrue(self.set(pl1_w=30)["ok"])               # nothing else to write: still ok

    def test_a_cpu_daemon_starting_later_does_not_stop_power_limits(self):
        self.on()
        self.set(pl1_w=15, epp="power")
        self.tick()
        self.units = units("cachyos-lpmd")                       # intel_lpmd starts and sets EPP
        for i in range(14):
            pf.put(pf.epp_path(self.ctx, f"policy{i}"), "balance_performance")
        self.assertEqual(self.tick(), "nothing")
        self.assertEqual(self.tick(), "nothing")
        st = power.state(self.ctx)["state"]
        self.assertIsNone(st["overridden"])
        self.assertIn("intel_lpmd", st["cpu_blocked"])
        self.plug(True)                                          # firmware resets MMIO PL1 on an AC change
        pf.set_watts(self.ctx, MMIO, "long_term", 35)
        dids = [self.tick() for _ in range(3)]
        self.assertIn("applied", dids)
        self.assertEqual(self.watts(MMIO), 15)
        self.assertEqual(pf.get(pf.epp_path(self.ctx)), "balance_performance")   # left to intel_lpmd

    def test_a_blocker_starting_mid_session_blocks_and_then_resumes(self):
        self.on()
        self.set(pl1_w=15)
        self.tick()
        self.units = units("bazzite")                            # PowerStation and thermald start
        for z in (MSR, MMIO):
            pf.set_watts(self.ctx, z, "long_term", 30)
        self.assertEqual(self.tick(), "blocked")
        st = power.state(self.ctx)["state"]
        self.assertIsNone(st["overridden"])
        self.assertIn("PowerStation", st["blocked"])
        self.units = units("none")                               # the user stops them, as told
        dids = [self.tick() for _ in range(power.CONFLICT_RECHECK_S // power.TICK_S + 1)]
        self.assertIn("applied", dids)
        self.assertEqual(self.watts(MSR), 15)

    def test_a_raw_epp_in_the_snapshot_is_restored(self):
        for i in range(14):
            pf.put(pf.epp_path(self.ctx, f"policy{i}"), "128")
        self.on()
        self.set(epp="power")
        res = self.set(epp=None)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["applied"]["failed"], [])
        self.assertEqual(pf.get(pf.epp_path(self.ctx, "policy5")), "128")
        self.assertFalse(power.set_values(self.ctx, "default", "main", {"epp": "128"})["ok"])   # not for a user

    def test_nothing_is_written_over_a_blocker_before_the_first_tick(self):
        self.on()
        self.assertTrue(power.profile(self.ctx, "1091500", "Cyberpunk 2077", True)["ok"])
        self.set("1091500", pl1_w=12)
        pf.plugins(self.ctx, {"SimpleDeckyTDP": True})
        self.restart()                                           # a new plugin process; no tick yet
        n = len(self.w.calls)
        res = power.game(self.ctx, "1091500")
        self.assertEqual(len(self.w.calls), n)
        self.assertIn("SimpleDeckyTDP", res["state"]["blocked"])
        self.restart()
        power.enable(self.ctx, False)                           # off: nothing restored over it either
        self.assertEqual(len(self.w.calls), n)


OWNER = {   # the owner's CachyOS units (tests/fixtures/power/units-cachyos-owner.txt), as [load, file state, active]
    "inputplumber.service": ["loaded", "enabled", True],
    "intel_lpmd.service": ["loaded", "disabled", False],
    "power-profiles-daemon.service": ["loaded", "enabled", True],
    "powerstation.service": ["not-found", "", False],
    "thermald.service": ["loaded", "enabled", True],
    "tuned.service": ["loaded", "disabled", False],
    "tuned-ppd.service": ["loaded", "disabled", False],
}
PPD = "power-profiles-daemon.service"
FORBIDDEN = ("mask", "--now", "--runtime", "kill", "unmask", "--force")


class FixTest(Base):
    """Fix for me / Undo against a stateful fake systemctl (tests/powerfake.py Systemctl)."""

    def setUp(self):
        super().setUp()
        self.sc = pf.Systemctl(OWNER)
        p = mock.patch.object(sysexec, "run", self.sc)
        p.start()
        self.addCleanup(p.stop)

    def record(self):
        path = os.path.join(self.ctx.settings_dir, "power.json")
        with open(path) as f:
            return json.load(f).get("fixed", {})

    def only(self, *names):
        """Keep only these units of the table (plus inputplumber)."""
        for u in list(self.sc.units):
            if u not in names and u != "inputplumber.service":
                del self.sc.units[u]

    def check_safe(self, cid):
        for argv in self.sc.calls:
            self.assertTrue(argv[0].startswith("/"), argv)
            self.assertFalse(any(f in a for a in argv for f in FORBIDDEN), argv)
            if "list-units" not in argv:
                units = argv[argv.index("--") + 1:]
                allowed = {u for us in power.FIXABLE.values() for u in us} if "show" in argv else power.FIXABLE[cid]
                self.assertTrue(set(units) <= set(allowed), argv)     # show only reads (the dialog's fix_plan)
        self.assertNotIn("env_extra", self.sc.kw)

    def test_fix_ppd_on_the_owners_device(self):
        seen = []
        real = self.sc.__call__

        def spy(argv, **kw):          # the record is on disk before the first command that changes something
            if "--no-ask-password" in argv and not seen:
                seen.append(self.record())
            return real(argv, **kw)

        with mock.patch.object(sysexec, "run", spy):
            res = power.fix(self.ctx, "ppd")
        self.assertTrue(res["ok"], res)
        self.assertEqual(seen[0]["ppd"]["units"], [{"unit": PPD, "was_enabled": "enabled", "was_active": True}])
        self.assertEqual(self.sc.actions(), [["/usr/bin/systemctl", "--no-ask-password", "disable", "--", PPD],
                                             ["/usr/bin/systemctl", "--no-ask-password", "stop", "--", PPD]])
        self.check_safe("ppd")
        self.assertEqual([(s["action"], s["ok"]) for s in res["steps"]], [("disable", True), ("stop", True)])
        self.assertEqual(self.sc.units[PPD], ["loaded", "disabled", False])      # disabled, not masked
        self.assertEqual(self.sc.units["thermald.service"], ["loaded", "enabled", True])   # untouched
        self.assertIsNone(res["state"]["cpu_blocked"])
        self.assertEqual(res["state"]["cpu_blocked_by"], [])
        self.assertEqual([r["id"] for r in res["conflicts"]], ["thermald"])
        self.assertEqual([(f["id"], f["came_back"]) for f in res["fixed"]], [("ppd", False)])
        self.assertIsNone(res["applied"])                                       # TDP control is off
        self.assertEqual(self.w.calls, [])
        self.assertEqual(self.record()["ppd"]["boot_id"], "boot-1")

    def test_fix_ppd_while_enabled_sets_epp_and_turbo_at_once(self):
        self.only(PPD)
        self.on()
        self.set(pl1_w=15, epp="power", turbo=False)
        self.assertEqual(pf.get(pf.epp_path(self.ctx)), "balance_performance")    # left to ppd
        self.assertEqual(power.state(self.ctx)["state"]["cpu_blocked_by"], ["ppd"])
        self.assertEqual(power.state(self.ctx)["state"]["cpu_blocked"],
                         "power-profiles-daemon controls energy preference and CPU boost")
        res = power.fix(self.ctx, "ppd")
        self.assertTrue(res["ok"], res)
        self.assertEqual(pf.get(pf.epp_path(self.ctx)), "power")
        self.assertEqual(pf.get(pf.no_turbo_path(self.ctx)), "1")
        self.assertTrue(res["applied"]["ok"])
        p = power._get(self.ctx)
        self.assertEqual(p.recheck_at, self.t + power.FIX_RECHECK_S)
        n = sum("list-units" in c for c in self.sc.calls)
        self.tick(4)
        self.assertEqual(sum("list-units" in c for c in self.sc.calls), n)
        self.tick(power.FIX_RECHECK_S - 4)                                      # 10 s after: looks again
        self.assertEqual(sum("list-units" in c for c in self.sc.calls), n + 1)
        self.assertIsNone(p.recheck_at)
        self.assertEqual(self.sc.actions()[2:], [])

    def test_came_back_and_fix_again_keeps_the_first_state(self):
        self.only(PPD)
        self.assertTrue(power.fix(self.ctx, "ppd")["ok"])
        self.sc.units[PPD][2] = True                         # D-Bus activation: running again, still disabled
        rows = power.info(self.ctx, True)["info"]
        row = {r["id"]: r for r in rows["conflicts"]}["ppd"]
        self.assertTrue(row["fixed"]["came_back"])
        self.assertEqual(row["fix_units"], [PPD])
        self.assertEqual([(f["id"], f["came_back"]) for f in rows["fixed"]], [("ppd", True)])
        self.sc.calls.clear()
        res = power.fix(self.ctx, "ppd")
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.sc.actions(), [["/usr/bin/systemctl", "--no-ask-password", "stop", "--", PPD]])
        self.assertEqual(self.record()["ppd"]["units"],
                         [{"unit": PPD, "was_enabled": "enabled", "was_active": True}])   # not "disabled"
        self.assertTrue(power.unfix(self.ctx, "ppd")["ok"])
        self.assertEqual(self.sc.units[PPD], ["loaded", "enabled", True])

    def test_fix_again_after_something_enabled_it_records_enabled(self):
        self.only(PPD)
        self.sc.units[PPD] = ["loaded", "disabled", True]    # running only because something asked over D-Bus
        self.assertTrue(power.fix(self.ctx, "ppd")["ok"])
        self.assertEqual(self.record()["ppd"]["units"][0]["was_enabled"], "disabled")
        self.sc.units[PPD] = ["loaded", "enabled", True]     # e.g. an update enabled it again
        power._get(self.ctx).rows = None
        self.sc.calls.clear()
        self.assertTrue(power.fix(self.ctx, "ppd")["ok"])
        self.assertEqual(self.sc.actions(), [["/usr/bin/systemctl", "--no-ask-password", "disable", "--", PPD],
                                             ["/usr/bin/systemctl", "--no-ask-password", "stop", "--", PPD]])
        self.assertEqual(self.record()["ppd"]["units"], [{"unit": PPD, "was_enabled": "enabled", "was_active": True}])
        self.assertTrue(power.unfix(self.ctx, "ppd")["ok"])
        self.assertEqual(self.sc.units[PPD], ["loaded", "enabled", True])   # the enable it removed is back

    def test_undo_of_a_unit_uninstalled_or_masked_since_clears_the_record(self):
        for state in (None, ["masked", "masked", False]):
            with self.subTest(state=state):
                self.only(PPD)
                self.sc.units[PPD] = ["loaded", "enabled", True]
                self.assertTrue(power.fix(self.ctx, "ppd")["ok"])
                if state is None:
                    del self.sc.units[PPD]                   # package removed
                else:
                    self.sc.units[PPD] = state               # the user masked it
                self.sc.calls.clear()
                res = power.unfix(self.ctx, "ppd")
                self.assertTrue(res["ok"], res)
                self.assertEqual(self.sc.actions(), [])          # no enable / start of a missing or masked unit
                self.assertEqual(res["notes"], [f"{PPD} is no longer installed (or is masked); nothing to turn "
                                                "back on"])
                self.assertNotIn("ppd", self.record())
                self.assertEqual(res["fixed"], [])
                self.assertFalse(power.unfix(self.ctx, "ppd")["ok"])     # nothing left to undo

    def test_fix_again_drops_a_recorded_unit_that_is_gone(self):
        self.only("tuned-ppd.service", "tuned.service")
        self.sc.units["tuned-ppd.service"] = ["loaded", "enabled", True]
        self.sc.units["tuned.service"] = ["loaded", "enabled", True]
        self.assertTrue(power.fix(self.ctx, "tuned")["ok"])
        del self.sc.units["tuned.service"]                     # uninstalled
        self.sc.units["tuned-ppd.service"][2] = True           # came back
        power._get(self.ctx).rows = None
        self.assertTrue(power.fix(self.ctx, "tuned")["ok"])
        self.assertEqual([u["unit"] for u in self.record()["tuned"]["units"]], ["tuned-ppd.service"])

    def test_fix_of_a_masked_but_running_unit_says_masked(self):
        self.only()
        self.sc.units["thermald.service"] = ["masked", "masked", True]
        row = {r["id"]: r for r in power.conflicts(self.ctx)}["thermald"]
        self.assertEqual((row["fix_units"], row["fix_plan"]), ([], None))
        res = power.fix(self.ctx, "thermald")
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "thermald is masked; OXP3 Deck does not unmask services")
        self.assertEqual(self.sc.actions(), [])

    def test_fix_plan_is_what_fix_runs(self):
        self.only("tuned-ppd.service", "tuned.service")
        self.sc.units["tuned-ppd.service"] = ["loaded", "static", True]
        self.sc.units["tuned.service"] = ["loaded", "enabled", False]
        row = {r["id"]: r for r in power.conflicts(self.ctx)}["tuned"]
        self.assertEqual(row["fix_plan"], {"disable": ["tuned.service"], "stop": ["tuned-ppd.service"]})
        self.assertTrue(power.fix(self.ctx, "tuned")["ok"])
        self.assertEqual(self.sc.actions(), [["/usr/bin/systemctl", "--no-ask-password", "disable", "--",
                                              "tuned.service"],
                                             ["/usr/bin/systemctl", "--no-ask-password", "stop", "--",
                                              "tuned-ppd.service"]])
        self.assertEqual({r["id"]: r for r in power.conflicts(self.ctx)}.get("ppd", {}).get("fix_plan"), None)

    def test_a_restart_right_away_is_not_ok(self):
        self.only(PPD)
        self.sc.restart = {PPD}
        res = power.fix(self.ctx, "ppd")
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "power-profiles-daemon is still running")
        self.assertEqual([s["ok"] for s in res["steps"]], [True, False])
        self.assertTrue(res["conflicts"][0]["fixed"]["came_back"])
        self.assertIn("ppd", self.record())                  # Undo still offered

    def test_tuned_static_masked_and_not_found(self):
        self.only("tuned-ppd.service")
        self.sc.units["tuned-ppd.service"] = ["loaded", "enabled", True]
        res = power.fix(self.ctx, "tuned")
        self.assertTrue(res["ok"], res)
        self.assertEqual([u["unit"] for u in self.record()["tuned"]["units"]], ["tuned-ppd.service"])
        self.assertEqual(len(self.sc.actions()), 2)
        power.unfix(self.ctx, "tuned")
        self.sc.calls.clear()
        self.sc.units["tuned-ppd.service"] = ["loaded", "static", True]
        self.sc.units["tuned.service"] = ["masked", "masked", False]
        power.conflicts(self.ctx)
        power._get(self.ctx).rows = None
        res = power.fix(self.ctx, "tuned")
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.sc.actions(), [["/usr/bin/systemctl", "--no-ask-password", "stop", "--",
                                              "tuned-ppd.service"]])          # static: nothing to disable
        self.assertFalse(any("tuned.service" in c for c in self.sc.calls))    # masked: not touched
        self.sc.calls.clear()
        res = power.unfix(self.ctx, "tuned")
        self.assertEqual(self.sc.actions(), [["/usr/bin/systemctl", "--no-ask-password", "start", "--",
                                              "tuned-ppd.service"]])          # a static unit is never enabled
        self.check_safe("tuned")

    def test_fix_thermald_while_blocked(self):
        self.only()
        self.on()
        self.set(pl1_w=15)
        self.tick()
        self.sc.units["thermald.service"] = ["loaded", "enabled", True]
        self.assertEqual(self.tick(power.CONFLICT_RECHECK_S), "blocked")
        res = power.fix(self.ctx, "thermald")
        self.assertTrue(res["ok"], res)
        self.assertIsNone(res["state"]["blocked"])
        self.assertEqual(power._get(self.ctx).apply_at, self.t)
        pf.set_watts(self.ctx, MSR, "long_term", 25)          # what thermald did meanwhile
        self.assertEqual(self.tick(), "applied")
        self.assertEqual(self.watts(MSR), 15)
        res = power.unfix(self.ctx, "thermald")
        self.assertTrue(res["ok"], res)
        self.assertIn("thermald", res["state"]["blocked"])    # blocks again, nothing restored
        self.assertEqual(self.watts(MSR), 15)

    def test_intel_lpmd_note(self):
        self.only("intel_lpmd.service")
        self.sc.units["intel_lpmd.service"] = ["loaded", "enabled", True]
        path = self.ctx.sys_path("/sys/devices/system/cpu/intel_pstate/max_perf_pct")
        pf.put(path, 60)
        res = power.fix(self.ctx, "intel_lpmd")
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["notes"], ["Intel's low-power daemon left the CPU's top speed at 60 %; a reboot "
                                        "restores it"])
        self.assertEqual(pf.get(path), "60")                  # not written
        power.unfix(self.ctx, "intel_lpmd")
        pf.put(path, 100)
        self.assertEqual(power.fix(self.ctx, "intel_lpmd")["notes"], [])

    def test_refused_with_nothing_run(self):
        pf.plugins(self.ctx, {"SimpleDeckyTDP": True})
        self.sc.units["hhd@jordan.service"] = ["loaded", "enabled", True]
        for cid in ("hhd", "simpledeckytdp", "steamos-remote", "../x", None, ["ppd"], {"a": 1}, 3, "tuned",
                    "intel_lpmd", "powerstation"):
            res = power.fix(self.ctx, cid)
            self.assertFalse(res["ok"], cid)
            self.assertTrue(res["error"], cid)
            json.dumps(res)
        self.assertIn("cannot be fixed", power.fix(self.ctx, "hhd")["error"])
        self.assertEqual(power.fix(self.ctx, "tuned")["error"], "tuned is not running")
        self.sc.listing_rc = 1
        res = power.fix(self.ctx, "ppd")
        self.assertIn("could not list services", res["error"])
        self.assertEqual(self.sc.actions(), [])
        self.assertEqual(self.record() if os.path.exists(os.path.join(self.ctx.settings_dir, "power.json"))
                         else {}, {})

    def test_a_failing_disable_keeps_the_record(self):
        self.only(PPD)
        self.sc.rc["disable"] = (1, "Failed to disable unit: Access denied")
        res = power.fix(self.ctx, "ppd")
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], f"{PPD}: Failed to disable unit: Access denied")
        self.assertEqual([(s["action"], s["ok"]) for s in res["steps"]], [("disable", False), ("stop", True)])
        self.assertIn("ppd", self.record())
        del self.sc.rc["disable"]
        self.sc.calls.clear()
        res = power.unfix(self.ctx, "ppd")
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.sc.actions(), [["/usr/bin/systemctl", "--no-ask-password", "enable", "--", PPD],
                                             ["/usr/bin/systemctl", "--no-ask-password", "start", "--", PPD]])

    def test_unfix(self):
        self.only(PPD)
        self.on()
        self.assertTrue(power.fix(self.ctx, "ppd")["ok"])
        self.sc.calls.clear()
        res = power.unfix(self.ctx, "ppd")
        self.assertTrue(res["ok"], res)
        self.assertEqual([(s["action"], s["unit"], s["ok"]) for s in res["steps"]],
                         [("enable", PPD, True), ("start", PPD, True)])
        self.assertNotIn("ppd", self.record())
        self.assertEqual(res["fixed"], [])
        self.assertEqual(res["state"]["cpu_blocked_by"], ["ppd"])
        self.assertIsNone(res["state"]["blocked"])
        self.check_safe("ppd")
        self.assertFalse(power.unfix(self.ctx, "ppd")["ok"])          # no record
        for cid in (None, "../x", ["ppd"], "hhd"):
            self.assertFalse(power.unfix(self.ctx, cid)["ok"], cid)
        self.assertEqual(len(self.sc.actions()), 2)

    def test_unfix_does_only_what_the_record_says(self):
        path = os.path.join(self.ctx.settings_dir, "power.json")
        pf.put(path, json.dumps({"fixed": {"tuned": {"at": 1.0, "boot_id": "b", "units": [
            {"unit": "tuned-ppd.service", "was_enabled": "static", "was_active": True},
            {"unit": "tuned.service", "was_enabled": "disabled", "was_active": False}]}}}))
        self.restart()
        res = power.unfix(self.ctx, "tuned")
        self.assertTrue(res["ok"], res)
        self.assertEqual(self.sc.actions(), [["/usr/bin/systemctl", "--no-ask-password", "start", "--",
                                              "tuned-ppd.service"]])

    def test_records_are_checked_when_read(self):
        path = os.path.join(self.ctx.settings_dir, "power.json")
        good = {"unit": PPD, "was_enabled": "enabled", "was_active": True}
        pf.put(path, json.dumps({"fixed": {
            "ppd": {"at": 5, "boot_id": "b", "units": [
                good, dict(good), {"unit": "sshd.service", "was_enabled": "enabled", "was_active": True},
                {"unit": "../../x", "was_enabled": "enabled", "was_active": True}]},
            "tuned": {"at": 5, "units": [{"unit": "tuned.service", "was_enabled": "enabled", "was_active": "yes"}]},
            "intel_lpmd": {"at": 5, "units": [{"unit": "intel_lpmd.service", "was_enabled": "x" * 1000,
                                                "was_active": True}]},
            "thermald": {"at": "now", "units": [{"unit": "thermald.service", "was_enabled": "enabled",
                                                  "was_active": True}]},
            "hhd": {"at": 5, "units": [{"unit": "hhd.service", "was_enabled": "enabled", "was_active": True}]},
            "sshd": {"at": 5, "units": [{"unit": "sshd.service", "was_enabled": "enabled", "was_active": True}]},
        }}))
        self.restart()
        fixed = power._get(self.ctx).data["fixed"]
        self.assertEqual(fixed, {"ppd": {"at": 5, "boot_id": "b", "units": [good]}})
        self.assertFalse(power.options(self.ctx, {"fixed": {}})["ok"])
        self.assertEqual(power._get(self.ctx).data["fixed"], fixed)
        pf.put(path, json.dumps({"fixed": ["ppd"]}))
        self.restart()
        self.assertEqual(power._get(self.ctx).data["fixed"], {})

    def test_nothing_fixes_or_undoes_without_a_call(self):
        self.only(PPD, "thermald.service")
        self.sc.units["thermald.service"] = ["loaded", "enabled", False]
        self.on()
        path = os.path.join(self.ctx.settings_dir, "power.json")
        data = json.loads(pf.get(path))      # a record of an earlier fix whose unit came back
        data["fixed"] = {"thermald": {"at": 1.0, "boot_id": "b", "units": [
            {"unit": "thermald.service", "was_enabled": "enabled", "was_active": True}]}}
        pf.put(path, json.dumps(data))
        self.restart()
        power.profile(self.ctx, "1", None, True)
        for _ in range(3):
            self.tick()
        power.game(self.ctx, "1")
        self.plug(True)
        self.tick()
        pf.suspend(self.ctx, 1)
        self.tick(power.CONFLICT_RECHECK_S)
        self.sc.units["thermald.service"][2] = True          # came back: blocks, is not fixed again
        self.assertEqual(self.tick(power.CONFLICT_RECHECK_S), "blocked")
        power.enable(self.ctx, False)
        power.enable(self.ctx, True)
        power.info(self.ctx, True)
        power.state(self.ctx)
        power.take_control(self.ctx)
        self.assertEqual(self.sc.actions(), [])
        self.assertIn("thermald", self.record())

    def test_texts_and_detection(self):
        for cid, (_n, _k, _i, why, fix) in power.CONFLICTS.items():
            self.assertNotIn("mask", fix, cid)
            self.assertNotIn("mask", why, cid)
        self.assertNotIn("turbo", power.CONFLICTS["ppd"][3])
        self.assertTrue(set(power.FIXABLE) <= set(power.CONFLICTS))
        self.assertFalse({"hhd", "simpledeckytdp", "powercontrol", "steamos-remote"} & set(power.FIXABLE))
        self.assertTrue(power._UNITS["hhd"].match("hhd_local@jordan.service"))
        self.assertTrue(power._UNITS["hhd"].match("hhd@jordan.service"))
        self.only()
        self.sc.units["hhd_local@jordan.service"] = ["loaded", "enabled", True]
        rows = power.conflicts(self.ctx)
        self.assertEqual([(r["id"], r["fix_units"]) for r in rows], [("hhd", [])])
        hw = powerhw.discover(stub_decky.make_ctx(os.path.join(self.tmp.name, "empty")))
        self.assertTrue(any("processor_thermal_rapl" in x for x in hw["problems"]))
        self.assertFalse(any("intel_rapl_mmio" in x for x in hw["problems"]))


class NothingThereTest(Base):
    oxp3 = False

    def test_every_public_function_answers(self):
        calls = [("info", (True,)), ("state", ()), ("enable", (True,)), ("options", ({"split_ac": True},)),
                 ("set_values", ("default", "main", {"pl1_w": 15})), ("profile", ("1", "A", True)),
                 ("game", ("1",)), ("take_control", ()), ("import_sdtdp", ()), ("tick", ()), ("summary", ()),
                 ("enable", (False,)), ("fix", ("ppd",)), ("unfix", ("ppd",))]
        for name, args in calls:
            res = getattr(power, name)(self.ctx, *args)
            self.assertIsInstance(res, dict, name)
            self.assertIn("ok", res, name)
            self.assertIn("error", res, name)
            json.dumps(res)
        hw = power._hw(self.ctx, power._get(self.ctx))
        self.assertEqual(power.limits(self.ctx, hw, None)["pl1_max"], 5)
        self.assertEqual(self.w.calls, [])

    def test_state_fields_match_types_ts(self):
        from tests.test_xess import ts_fields
        pf.oxp3(self.ctx)
        info = power.info(self.ctx, True)["info"]
        self.assertEqual(set(info), ts_fields("PowerInfo"))
        self.assertEqual(set(info["state"]), ts_fields("PowerState"))
        self.assertEqual(set(info["state"]["range"]), ts_fields("PowerRange"))
        self.assertEqual(set(info["state"]["now"]["zones"][0]), ts_fields("PowerZone"))
        self.assertEqual(set(info["profiles"]["default"]["main"]), ts_fields("PowerValues"))
        self.assertEqual(set(power.summary(self.ctx)) - {"ok", "error"}, ts_fields("PowerSummary"))
        res = power.enable(self.ctx, True)
        self.assertEqual(set(res) - {"conflicts"}, ts_fields("PowerChangeRes") - {"conflicts"})
        self.assertEqual(set(res["applied"]), ts_fields("PowerApply"))
        self.assertEqual(set(power.fix(self.ctx, "ppd")), ts_fields("PowerFixRes") | {"ok", "error"})
        self.units = units("bazzite")
        rows = power.info(self.ctx, True)["info"]["conflicts"]
        self.assertTrue(rows)
        for r in rows:
            self.assertEqual(set(r), ts_fields("PowerConflict"))


# ---- 0.4: CPU speed cap and floor, per-core caps, EPP split, SoC slider, GPU power profile, polling rate ---------

class NewBase(Base):
    """The OXP3 with the 0.4 controls: 4 P (policy0-3), 6 E (policy4-9), 4 LP-E (policy10-13) cores, intel_pstate
    max/min_perf_pct 100/9, the SoC slider (03/00, balanced), the GPU power profile (base)."""

    def setUp(self):
        super().setUp()
        pf.types(self.ctx, p="0-3", atom="4-13", no_l3=(10, 11, 12, 13))
        pf.perf(self.ctx)
        self.soc = pf.soc(self.ctx)
        self.gprof = pf.gpu_profile(self.ctx)

    def pct(self, which="max"):
        return int(pf.get(pf.perf_path(self.ctx, which)))

    def cap(self, policy):
        return int(pf.get(pf.cap_path(self.ctx, policy)))

    def param(self, which="balance"):
        return pf.get(pf.soc_param(self.ctx, which))

    def refused(self, error_part, key="default", slot="main", **values):
        res = power.set_values(self.ctx, key, slot, values)
        self.assertFalse(res["ok"], res)
        self.assertIn(error_part, res["error"])
        return res


class NewFieldsTest(NewBase):
    def test_bounds_and_nulls(self):
        for field, bad, good in (("cpu_max_pct", 29, 30), ("cpu_max_pct", 101, 100), ("cpu_min_pct", 51, 50),
                                 ("cpu_min_pct", 0, 1), ("soc_balance", 0, 1), ("soc_balance", 6, 5),
                                 ("soc_offset", 4, 3), ("cpu_cap_p_mhz", 399, 400), ("cpu_cap_lpe_mhz", 6001, 6000),
                                 ("gpu_power_profile", "fast", "power_saving"), ("epp_e", "default", "power"),
                                 ("fan_mode", "loud", "quiet"), ("scx_mode", "lowlatency", "gaming"),
                                 ("soc_balance", True, 3), ("cpu_max_pct", "70", 70)):
            self.refused(field, **{field: bad})
            self.set(**{field: good})
            self.set(**{field: None})
        self.assertEqual(len(power.FIELDS), 19)

    def test_bad_values_in_the_file_read_as_null(self):
        main = dict(power._empty_values(), cpu_max_pct=20, soc_balance=4, fan_mode="loud", epp_p="power",
                    cpu_cap_e_mhz=2000)
        with open(os.path.join(self.ctx.settings_dir, "power.json"), "w") as f:
            json.dump({"profiles": {"default": {"main": main}}, "poll_s": 7}, f)
        info = power.info(self.ctx, False)["info"]
        got = info["profiles"]["default"]["main"]
        self.assertEqual((got["cpu_max_pct"], got["soc_balance"], got["fan_mode"], got["epp_p"],
                          got["cpu_cap_e_mhz"]), (None, 4, None, "power", 2000))
        self.assertEqual(info["options"]["poll_s"], 7)

    def test_a_file_with_both_caps_reads_the_per_core_caps_as_null(self):
        main = dict(power._empty_values(), cpu_max_pct=70, cpu_cap_p_mhz=2400)
        with open(os.path.join(self.ctx.settings_dir, "power.json"), "w") as f:
            json.dump({"profiles": {"default": {"main": main}}}, f)
        got = power.info(self.ctx, False)["info"]["profiles"]["default"]["main"]
        self.assertEqual((got["cpu_max_pct"], got["cpu_cap_p_mhz"]), (70, None))

    def test_speed_cap_and_per_core_caps_are_exclusive(self):
        self.on()
        self.set(cpu_max_pct=70)
        self.refused("either the CPU speed cap or the per-core caps", cpu_cap_p_mhz=2400)
        self.assertIsNone(power.info(self.ctx, False)["info"]["profiles"]["default"]["main"]["cpu_cap_p_mhz"])
        self.assertEqual(self.pct(), 70)
        res = self.set(cpu_max_pct=None, cpu_cap_p_mhz=2400)        # the switch, as one change
        self.assertEqual((self.pct(), self.cap("policy0"), self.cap("policy4")), (100, 2400000, 3800000))
        self.assertEqual(res["state"]["applied_values"]["cpu_cap_p_mhz"], 2400)
        self.assertEqual(res["state"]["now"]["caps_mhz"], {"p": 2400, "e": 3800, "lpe": 2500})
        self.refused("either", cpu_max_pct=60)
        power.profile(self.ctx, "7", None, True)                    # a copy of default: still one of them
        self.refused("either", key="7", slot="ac", cpu_max_pct=60)

    def test_speed_cap_and_floor_floor_on_ac_only(self):
        self.on()
        self.set(cpu_max_pct=70, cpu_min_pct=40)
        self.tick()
        self.assertEqual((self.pct(), self.pct("min")), (70, 9))     # battery: the firmware floor
        res = power.state(self.ctx)["state"]
        self.assertEqual((res["applied_values"]["cpu_min_pct"], res["now"]["cpu_min_pct"]), (9, 9))
        self.assertEqual((res["range"]["cpu_pct_min"], res["range"]["cpu_min_pct_fw"],
                          res["range"]["cpu_min_pct_max"]), (30, 9, 50))
        self.plug(True)
        self.tick()
        self.assertEqual(self.tick(), "applied")
        self.assertEqual((self.pct(), self.pct("min")), (70, 40))
        self.set(cpu_max_pct=35, cpu_min_pct=50)                    # never above the cap
        self.assertEqual((self.pct(), self.pct("min")), (35, 35))
        self.plug(False)
        for _ in range(3):
            self.tick()
        self.assertEqual((self.pct(), self.pct("min")), (35, 9))

    def test_soc_slider(self):
        self.on()
        self.set(soc_balance=4, soc_offset=2)
        self.assertEqual((self.param(), self.param("offset")), ("04", "02"))
        names = self.w.names(self.ctx)
        self.assertEqual(names[-3:], ["slider_offset", "slider_balance", "profile"])
        self.assertEqual(self.w.calls[-1][1], "balanced")
        st = power.state(self.ctx)["state"]
        self.assertEqual(st["now"]["soc"]["balance"], 4)
        self.assertEqual(st["applied_values"]["soc_balance"], 4)
        pf.put(os.path.join(self.soc, "profile"), "performance")    # power-profiles-daemon's choice
        n = len(self.w.calls)
        self.set(soc_balance=2)
        self.assertEqual(self.param(), "02")
        self.assertEqual(len(self.w.calls) - n, 1)                   # the profile is left alone
        self.assertEqual(pf.get(os.path.join(self.soc, "profile")), "performance")

    def test_gpu_power_profile_and_its_retry(self):
        self.on()
        self.w.fail["power_profile"] = errno.EIO                    # the GPU asleep
        res = self.set(gpu_power_profile="power_saving")
        self.assertTrue(res["ok"], res)
        self.assertEqual([(f["id"], f["transient"]) for f in res["applied"]["failed"]], [("gpu/profile", True)])
        self.assertEqual(power._get(self.ctx).pending, ["gpu/profile"])
        self.w.fail.clear()
        self.assertEqual(self.tick(), "applied")                    # the first tick: retried
        self.assertEqual(pf.get(self.gprof), "base    [power_saving]")
        self.assertEqual(power._get(self.ctx).pending, [])

    def test_pending_retries_are_limited(self):
        self.on()
        self.w.fail["power_profile"] = errno.EIO
        self.set(gpu_power_profile="power_saving")
        for _ in range(power.PENDING_RETRIES + 5):
            self.tick()
        tries = [c for c in self.w.calls if c[0] == self.gprof]
        self.assertEqual(len(tries), 1 + power.PENDING_RETRIES)

    def test_epp_split_by_core_type(self):
        self.on()
        res = self.set(epp="balance_performance", epp_e="power")
        got = [pf.get(pf.epp_path(self.ctx, f"policy{i}")) for i in (0, 3, 4, 9, 10, 13)]
        self.assertEqual(got, ["balance_performance"] * 2 + ["power"] * 2 + ["balance_performance"] * 2)
        ours = power._get(self.ctx).run["ours"]
        self.assertEqual({k: v for k, v in ours.items() if k.startswith("epp")},
                         {"epp/policy0": "balance_performance", "epp/policy4": "power",
                          "epp/policy10": "balance_performance"})
        self.assertEqual(res["state"]["now"]["epp_types"], {"p": "balance_performance", "e": "power",
                                                            "lpe": "balance_performance"})
        self.assertEqual(res["state"]["applied_values"]["epp_e"], "power")
        self.set(epp=None, epp_e=None, epp_lpe="balance_power")      # no epp: the snapshot for the others
        self.assertEqual(pf.get(pf.epp_path(self.ctx, "policy4")), "balance_performance")
        self.assertEqual(pf.get(pf.epp_path(self.ctx, "policy12")), "balance_power")
        pf.put(pf.epp_path(self.ctx, "policy4"), "performance")      # drift on one type
        self.tick()
        self.tick()
        self.assertEqual(power.state(self.ctx)["state"]["overridden"]["what"], "epp/policy4")

    def test_fan_and_scx_are_stored_and_copied_never_written(self):
        self.on()
        n = len(self.w.calls)
        self.set(fan_mode="quiet", scx_mode="gaming")
        self.assertEqual(len(self.w.calls), n)
        power.profile(self.ctx, "7", None, True)
        prof = power.info(self.ctx, False)["info"]["profiles"]["7"]["main"]
        self.assertEqual((prof["fan_mode"], prof["scx_mode"]), ("quiet", "gaming"))
        power.game(self.ctx, "7")
        a = power.active(self.ctx)
        self.assertEqual(a, {"key": "7", "slot": "main", "app": "7", "ac": False, "enabled": True,
                             "values": prof})
        self.assertFalse([p for p in self.w.paths() if "hwmon" in p or "pwm" in p])

    def test_info_hw_and_range(self):
        info = power.info(self.ctx, True)["info"]
        self.assertEqual((info["hw"]["cpu"]["perf_pct"], info["hw"]["cpu"]["types"], info["hw"]["soc"],
                          info["hw"]["gpu"]["power_profile"]), (True, ["p", "e", "lpe"], True, True))
        self.assertEqual(info["state"]["range"]["core_types"],
                         {"p": {"min_mhz": 400, "max_mhz": 5100, "policies": 4},
                          "e": {"min_mhz": 400, "max_mhz": 3800, "policies": 6},
                          "lpe": {"min_mhz": 400, "max_mhz": 2500, "policies": 4}})
        self.assertEqual(info["state"]["now"]["gpu_profile"], "base")
        self.assertEqual(info["state"]["blocked_fields"], {})


class NewSnapshotTest(NewBase):
    def test_restore_writes_the_new_values_back(self):
        self.on()
        self.set(cpu_max_pct=50, soc_balance=5, soc_offset=1, gpu_power_profile="power_saving")
        snap = power._get(self.ctx).run["snapshot"]
        self.assertEqual((snap["perf"], snap["soc"], snap["gpu_profile"], snap["caps"]["policy4"]),
                         ({"max": 100, "min": 9}, {"balance": 3, "offset": 0}, "base", 3800000))
        self.assertEqual(pf.get(self.gprof), "base    [power_saving]")
        self.w.calls.clear()
        res = power.enable(self.ctx, False)
        self.assertTrue(res["ok"], res)
        self.assertEqual((self.pct(), self.param(), self.param("offset"), pf.get(self.gprof)),
                         (100, "03", "00", "[base]    power_saving"))
        names = self.w.names(self.ctx)
        self.assertLess(names.index("max_perf_pct"), names.index("slider_offset"))
        self.assertEqual(names[names.index("slider_offset"):names.index("slider_offset") + 3],
                         ["slider_offset", "slider_balance", "profile"])

    def test_caps_restored(self):
        self.on()
        self.set(cpu_cap_e_mhz=2000, cpu_cap_lpe_mhz=1500)
        self.assertEqual((self.cap("policy0"), self.cap("policy4"), self.cap("policy13")), (5100000, 2000000,
                                                                                           1500000))
        power.enable(self.ctx, False)
        self.assertEqual((self.cap("policy4"), self.cap("policy13")), (3800000, 2500000))

    def test_an_old_snapshot_gets_the_new_keys_filled_not_retaken(self):
        p = power._get(self.ctx)
        p.run["snapshot"] = {"taken_at": 5.0, "rapl": {MSR: {"pl1_uw": 20 * MW, "pl2_uw": 52 * MW}},
                             "gpu": {"min": 850, "max": 2300}, "epp": None, "turbo": True}   # written by 0.3
        power._save_run(self.ctx, p)
        self.restart()
        pf.perf(self.ctx, max=90, min=9)
        self.on()
        snap = power._get(self.ctx).run["snapshot"]
        self.assertEqual((snap["taken_at"], snap["rapl"][MSR]["pl1_uw"], snap["perf"], snap["soc"]),
                         (5.0, 20 * MW, {"max": 90, "min": 9}, {"balance": 3, "offset": 0}))
        pf.perf(self.ctx, max=60, min=9)
        self.set(cpu_max_pct=70)
        self.assertEqual(power._get(self.ctx).run["snapshot"]["perf"], {"max": 90, "min": 9})   # never retaken


class NewDriftTest(NewBase):
    def setUp(self):
        super().setUp()
        self.units = units("none")
        self.on()
        self.set(cpu_max_pct=70, soc_balance=4, gpu_power_profile="power_saving")
        self.tick()

    def test_ours_has_the_new_ids(self):
        ours = power._get(self.ctx).run["ours"]
        self.assertEqual({k: ours[k] for k in ("cpu/max_pct", "cpu/min_pct", "soc/balance", "soc/offset",
                                                "gpu/profile")},
                         {"cpu/max_pct": 70, "cpu/min_pct": 9, "soc/balance": 4, "soc/offset": 0,
                          "gpu/profile": "power_saving"})
        self.assertEqual(sorted(k for k in ours if k.startswith("cpu/cap/")),
                         ["cpu/cap/policy0", "cpu/cap/policy10", "cpu/cap/policy4"])

    def test_drift_on_the_speed_cap_names_another_program(self):
        pf.put(pf.perf_path(self.ctx), 60)
        self.assertEqual(self.tick(), "nothing")
        self.assertEqual(self.tick(), "overridden")
        o = power.state(self.ctx)["state"]["overridden"]
        self.assertEqual((o["what"], o["ours"], o["now"], o["suspects"]), ("cpu/max_pct", "70 %", "60 %", ["other"]))

    def test_an_ignored_lpmd_gets_the_slider_and_nothing_else_stops(self):
        self.units = units("cachyos-lpmd")
        power.options(self.ctx, {"ignore": ["intel_lpmd"]})
        self.tick(power.CONFLICT_RECHECK_S)
        pf.put(pf.soc_param(self.ctx), "02")
        self.tick()
        self.assertEqual(self.tick(), "nothing")
        st = power.state(self.ctx)["state"]
        self.assertIsNone(st["overridden"])
        self.assertEqual(st["yielded"], ["soc"])
        ours = power._get(self.ctx).run["ours"]
        self.assertFalse([k for k in ours if k.startswith("soc/")], ours)
        self.assertIn("cpu/max_pct", ours)
        self.set(soc_balance=5)                       # a change writes it again
        self.assertEqual(power.state(self.ctx)["state"]["yielded"], [])

    def test_an_ignored_lpmd_is_the_suspect_of_a_field_it_does_not_set(self):
        self.units = units("cachyos-lpmd")
        power.options(self.ctx, {"ignore": ["intel_lpmd"]})
        self.tick(power.CONFLICT_RECHECK_S)
        pf.gpu_profile(self.ctx, "base")
        self.tick()
        self.tick()
        self.assertEqual(power.state(self.ctx)["state"]["overridden"]["what"], "gpu/profile")

    def test_a_platform_profile_switch_is_not_drift(self):
        for word in ("performance", "low-power", "balanced"):
            pf.put(os.path.join(self.soc, "profile"), word)
            self.assertEqual(self.tick(), "nothing")
            self.assertEqual(self.tick(), "nothing")
        self.assertIsNone(power.state(self.ctx)["state"]["overridden"])

    def test_gpu_profile_drift_is_seen_by_tick(self):
        pf.gpu_profile(self.ctx, "base")
        self.tick()
        self.assertEqual(self.tick(), "overridden")
        self.assertEqual(power.state(self.ctx)["state"]["overridden"]["suspects"], ["other"])

    def test_lpmd_starting_drops_its_fields_and_keeps_the_rest(self):
        self.units = units("cachyos-lpmd")
        pf.put(pf.perf_path(self.ctx), 60)
        self.tick()
        self.assertEqual(self.tick(), "nothing")
        ours = power._get(self.ctx).run["ours"]
        self.assertFalse([k for k in ours if k.startswith(("cpu/", "soc/", "epp", "turbo"))], ours)
        self.assertIn("gpu/profile", ours)
        self.assertIsNone(power.state(self.ctx)["state"]["overridden"])
        self.assertEqual(self.pct(), 60)                            # left to it


class TurboClampTest(NewBase):
    """intel_pstate clamps scaling_max_freq to base_frequency while no_turbo=1 (powerfake.Writer models it): CPU
    boost off must not make the per-core caps fail (the owner's report "CPU settings do nothing")."""

    def setUp(self):
        super().setUp()
        self.units = units("none")
        self.on()

    def test_boost_off_keeps_the_caps_ok(self):
        res = self.set(turbo=False)
        self.assertEqual(res["applied"]["failed"], [])
        self.assertEqual((self.cap("policy0"), self.cap("policy4"), self.cap("policy10")), (2000000, 1800000, 1200000))
        for _ in range(4):
            self.assertIn(self.tick(), ("nothing", None, ""))
        st = power.state(self.ctx)["state"]
        self.assertIsNone(st["overridden"])
        self.assertEqual(st["last"]["failed"], [])

    def test_boost_off_then_a_change_that_writes_nothing_is_ok(self):
        self.set(turbo=False)
        self.set(pl1_w=25)
        res = self.set(pl1_w=25)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["applied"]["failed"] if res["applied"] else [], [])

    def test_per_core_caps_with_boost_off_stop_at_base(self):
        res = self.set(turbo=False, cpu_cap_p_mhz=3000)
        self.assertEqual(res["applied"]["failed"], [])
        self.assertEqual(self.cap("policy0"), 2000000)
        res = self.set(turbo=True)
        self.assertEqual(res["applied"]["failed"], [])
        self.assertEqual(self.cap("policy0"), 3000000)

    def test_turning_control_off_brings_the_boot_caps_back(self):
        self.set(turbo=False)
        res = power.enable(self.ctx, False)
        self.assertTrue(res["ok"], res)
        self.assertEqual(pf.get(pf.no_turbo_path(self.ctx)), "0")
        self.assertEqual((self.cap("policy0"), self.cap("policy4"), self.cap("policy10")), (5100000, 3800000, 2500000))


class IgnoredCpuDaemonTest(NewBase):
    """power-profiles-daemon ignored: when it rewrites energy preference or boost, OXP3 Deck leaves that field to
    it instead of stopping every write (power limits included)."""

    def setUp(self):
        super().setUp()
        self.units = units("ppd")
        self.on()
        self.assertTrue(power.options(self.ctx, {"ignore": ["ppd"]})["ok"])
        self.set(pl1_w=15, epp="power", turbo=False)
        self.assertEqual(pf.get(pf.epp_path(self.ctx)), "power")

    def test_epp_rewritten_by_it_is_left_and_the_rest_keeps_working(self):
        for i in range(14):
            pf.put(pf.epp_path(self.ctx, f"policy{i}"), "balance_performance")
        dids = [self.tick() for _ in range(3)]
        self.assertNotIn("overridden", dids)
        st = power.state(self.ctx)["state"]
        self.assertIsNone(st["overridden"])
        ours = power._get(self.ctx).run["ours"]
        self.assertFalse([k for k in ours if k == "epp" or k.startswith("epp/")], ours)
        self.assertIn("turbo", ours)
        self.assertEqual(st["yielded"], ["epp"])
        res = self.set(pl1_w=18)               # power limits still apply
        self.assertEqual(round(self.watts(MSR)), 18)
        self.assertTrue(res["ok"], res)

    def test_a_speed_cap_change_is_still_an_override(self):
        self.set(cpu_max_pct=70)
        pf.put(pf.perf_path(self.ctx), 60)     # ppd never writes it: someone else did
        self.tick()
        self.assertEqual(self.tick(), "overridden")


class BlockersTest(NewBase):
    def test_ppd_blocks_epp_and_boost_only(self):
        self.units = units("ppd")
        self.on()
        res = self.set(cpu_max_pct=60, soc_balance=2, epp="power")
        self.assertEqual(res["state"]["blocked_fields"], {"epp": ["ppd"], "turbo": ["ppd"]})
        self.assertEqual((self.pct(), self.param()), (60, "02"))
        self.assertEqual(pf.get(pf.epp_path(self.ctx)), "balance_performance")
        self.assertIn("power-profiles-daemon", res["state"]["cpu_blocked"])

    def test_tuned_blocks_the_cpu_speed_controls_not_the_slider(self):
        self.units = units("tuned")
        self.on()
        res = self.set(cpu_max_pct=60, soc_balance=2)
        self.assertEqual(set(res["state"]["blocked_fields"]), {"epp", "turbo", "cpu_pct", "cpu_caps"})
        self.assertEqual((self.pct(), self.param()), (100, "02"))

    def test_lpmd_blocks_cpu_speed_caps_and_slider_unless_paused(self):
        self.units = units("cachyos-lpmd")
        self.on()
        res = self.set(cpu_max_pct=60, soc_balance=2, cpu_min_pct=None, gpu_power_profile="power_saving")
        self.assertEqual(res["state"]["blocked_fields"],
                         {k: ["intel_lpmd"] for k in ("epp", "turbo", "cpu_pct", "cpu_caps", "soc")})
        self.assertEqual((self.pct(), self.param(), pf.get(self.gprof)), (100, "03", "base    [power_saving]"))
        with mock.patch.object(power, "_lpmd_paused", lambda ctx: True):
            self.assertTrue(power.refresh(self.ctx)["ok"])
            self.assertEqual(self.tick(), "applied")
            self.assertEqual((self.pct(), self.param()), (60, "02"))
            st = power.state(self.ctx)["state"]
            self.assertEqual((st["blocked_fields"], st["cpu_blocked"]), ({}, None))
        self.assertIn("cpu_pct", power.state(self.ctx)["state"]["blocked_fields"])

    def test_a_snapshot_taken_under_lpmd_uses_the_driver_defaults(self):
        """intel_lpmd's leftovers (floor 50, slider 1) are not the snapshot: once it is paused (or fixed), blank
        fields go to the driver defaults, the floor is not left at 50 on battery and its range is not 50..50."""
        self.units = units("cachyos-lpmd")
        pf.perf(self.ctx, max=80, min=50)
        pf.soc(self.ctx, balance="01", offset="00")
        self.plug(False)
        self.on()
        self.set(pl1_w=15)
        snap = power._get(self.ctx).run["snapshot"]
        self.assertEqual((snap["perf"], snap["soc"]), ({"max": 100, "min": 8}, {"balance": 3, "offset": 0}))
        self.assertEqual((self.pct(), self.pct("min"), self.param()), (80, 50, "01"))     # left to intel_lpmd
        with mock.patch.object(power, "_lpmd_paused", lambda ctx: True):
            self.assertTrue(power.refresh(self.ctx)["ok"])
            self.assertEqual(self.tick(), "applied")
            self.assertEqual((self.pct(), self.pct("min"), self.param()), (100, 8, "03"))
            rng = power.state(self.ctx)["state"]["range"]
            self.assertEqual(rng["cpu_min_pct_fw"], 8)

    def test_lpmd_note_not_hidden_by_a_blank_cap(self):
        p = power._get(self.ctx)
        p.data["enabled"] = True
        p.run["ours"] = {"cpu/max_pct": 60}           # a blank cap is always in the target
        pf.put(pf.perf_path(self.ctx), 60)
        self.assertIn("60 %", power._lpmd_note(self.ctx, p))
        p.data["profiles"]["default"]["main"]["cpu_max_pct"] = 60
        self.assertIsNone(power._lpmd_note(self.ctx, p))

    def test_lpmd_paused_reads_extras_lazily(self):
        fake = types.ModuleType("oxp3deck.extras")
        fake.lpmd_paused = lambda ctx: True
        with mock.patch.dict(sys.modules, {"oxp3deck.extras": fake}):
            import oxp3deck
            had = getattr(oxp3deck, "extras", None)
            oxp3deck.extras = fake
            try:
                self.assertTrue(power._lpmd_paused(self.ctx))
                fake.lpmd_paused = lambda ctx: 1 / 0
                self.assertFalse(power._lpmd_paused(self.ctx))
            finally:
                if had is None:
                    del oxp3deck.extras
                else:
                    oxp3deck.extras = had

    def test_lpmd_fix_note_not_for_our_own_cap(self):
        self.units = units("cachyos-lpmd")
        power.options(self.ctx, {"ignore": ["intel_lpmd"]})
        self.on()
        self.set(cpu_max_pct=60)
        self.assertIsNone(power._lpmd_note(self.ctx, power._get(self.ctx)))
        power._get(self.ctx).run["ours"].pop("cpu/max_pct")
        self.assertIn("60 %", power._lpmd_note(self.ctx, power._get(self.ctx)))


class PollTest(NewBase):
    def setUp(self):
        super().setUp()
        self.units = units("none")
        self.on()
        self.set(pl1_w=15)
        self.tick()
        self.checks = 0
        real = power._drift

        def counting(p, reading, gpu_only):
            self.checks += 1
            return real(p, reading, gpu_only)

        patcher = mock.patch.object(power, "_drift", counting)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_refused_values(self):
        for bad in (1, 61, -2, True, 2.5, "5", None):
            res = power.options(self.ctx, {"poll_s": bad})
            self.assertFalse(res["ok"], bad)
        for good in (0, 2, 60):
            self.assertTrue(power.options(self.ctx, {"poll_s": good})["ok"])
        self.assertEqual(power.info(self.ctx, False)["info"]["options"]["poll_s"], 60)

    def test_default_checks_every_tick(self):
        for _ in range(5):
            self.tick()
        self.assertEqual(self.checks, 5)

    def test_ten_seconds_is_one_check_every_five_ticks(self):
        power.options(self.ctx, {"poll_s": 10})
        for _ in range(10):
            self.tick()
        self.assertEqual(self.checks, 2)

    def test_off_checks_only_inside_a_grace_window(self):
        n = len(self.w.calls)
        power.options(self.ctx, {"poll_s": 0})
        self.assertEqual(len(self.w.calls), n)                      # changing the rate writes nothing
        pf.set_watts(self.ctx, MSR, "long_term", 35)
        for _ in range(5):
            self.assertEqual(self.tick(), "nothing")
        self.assertEqual(self.checks, 0)
        self.plug(True)
        self.tick()
        self.assertEqual(self.tick(), "applied")                    # the AC apply
        pf.set_watts(self.ctx, MMIO, "long_term", 35)
        self.assertEqual(self.tick(), "applied")                    # grace: checked every tick
        self.assertGreater(self.checks, 0)

    def test_off_does_not_retry_pending_outside_grace(self):
        power.options(self.ctx, {"poll_s": 0})
        self.w.fail["power_profile"] = errno.EIO
        self.set(gpu_power_profile="power_saving")
        self.w.fail.clear()
        for _ in range(3):
            self.tick()
        self.assertEqual(pf.get(self.gprof), "[base]    power_saving")
        power.options(self.ctx, {"poll_s": 2})
        self.tick()
        self.assertEqual(pf.get(self.gprof), "base    [power_saving]")


class ActiveRefreshTest(NewBase):
    def test_active_shape(self):
        a = power.active(self.ctx)
        self.assertEqual(set(a), {"key", "slot", "app", "ac", "enabled", "values"})
        self.assertEqual((a["key"], a["slot"], a["app"], a["ac"], a["enabled"]), ("default", "main", None, False,
                                                                                    False))
        self.assertEqual(set(a["values"]), set(power.FIELDS))
        power.options(self.ctx, {"split_ac": True})
        power.set_values(self.ctx, "default", "ac", {"fan_mode": "max"})
        self.plug(True)
        a = power.active(self.ctx)
        self.assertEqual((a["slot"], a["ac"], a["values"]["fan_mode"]), ("ac", True, "max"))
        power.profile(self.ctx, "9", None, True)
        power.game(self.ctx, "9")
        self.assertEqual(power.active(self.ctx)["key"], "9")
        power.options(self.ctx, {"per_game": False})
        self.assertEqual(power.active(self.ctx)["key"], "default")

    def test_refresh_only_when_writing_is_allowed(self):
        self.assertTrue(power.refresh(self.ctx)["ok"])
        self.assertIsNone(power._get(self.ctx).apply_at)              # TDP control off
        self.on()
        power.refresh(self.ctx)
        self.assertEqual(power._get(self.ctx).apply_at, self.t)


if __name__ == "__main__":
    unittest.main()
