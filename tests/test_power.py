"""power.py on fake OXP3 trees (tests/powerfake.py): the range, clamping, both RAPL interfaces, the boot snapshot,
settings and profiles, events (game, AC, resume), drift, conflicts and the SimpleDeckyTDP import."""
import errno
import json
import logging
import os
import tempfile
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
            self.assertEqual(i["options"], {"per_game": True, "split_ac": False, "extended": False, "ignore": []})
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
        self.assertEqual(set(rows["thermald"]), {"id", "name", "kind", "ignorable", "ignored", "why", "fix"})
        self.assertEqual(self.runs[0][1:], ["list-units", "--all", "--type=service", "--plain", "--no-legend",
                                            "--no-pager"])
        power.conflicts(self.ctx)
        self.assertEqual(len(self.runs), 1)                 # cached
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
        self.assertIn("remotes.d/powerstation.toml", rows["steamos-remote"]["fix"])

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
        self.assertEqual(d["main"], {"pl1_w": 12, "pl2_w": None, "gpu_min_mhz": None, "gpu_max_mhz": None,
                                     "epp": "balance_power", "turbo": False})
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


class NothingThereTest(Base):
    oxp3 = False

    def test_every_public_function_answers(self):
        calls = [("info", (True,)), ("state", ()), ("enable", (True,)), ("options", ({"split_ac": True},)),
                 ("set_values", ("default", "main", {"pl1_w": 15})), ("profile", ("1", "A", True)),
                 ("game", ("1",)), ("take_control", ()), ("import_sdtdp", ()), ("tick", ()), ("summary", ()),
                 ("enable", (False,))]
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


if __name__ == "__main__":
    unittest.main()
