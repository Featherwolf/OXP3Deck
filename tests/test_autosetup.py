"""autosetup.py (DESIGN.md "Automatic setup (0.6)") against a fake home: the owner's Witcher 3 and Monster Hunter
Wilds, a plain game with old XeSS, a game with FSR only, and Protons: GE-Proton12-1 (no hook), GE-Proton11-11 and
GE-Proton10-25 (hooked), GE-Proton9-27 (no hook), Proton Experimental (hooked) and the system proton-cachyos (no
hook). xess-xmx-linux is installed (its session environment file names the package) unless a test says not."""
import json
import os
import shutil
import unittest
from unittest import mock

from oxp3deck import autosetup, optiscaler, steamlib, xess
from tests.test_games import MH_WILDS, WITCHER, GameBase
from tests.test_optiscaler import make_pe
from tests.test_pe import fake_dll
from tests.test_steamlib import write
from tests.test_xess import SHIM_OLD, STOCK

PLAIN = "1234560"
FSRGAME = "1234570"
EAC = "1234580"
CS2 = "730"

TOOLS = [{"name": n, "display": n} for n in ("GE-Proton12-1", "GE-Proton9-27", "GE-Proton11-11", "GE-Proton10-25",
                                              "proton-cachyos")] + \
    [{"name": "proton_experimental", "display": "Proton Experimental"}]


class AutoBase(GameBase):
    def setUp(self):
        super().setUp()
        os.makedirs(self.ctx.settings_dir, exist_ok=True)
        self.t = 1_800_000_000.0
        p = mock.patch.object(autosetup, "_now", lambda: self.t)
        p.start()
        self.addCleanup(p.stop)
        w = self.w
        w.proton("GE-Proton12-1", "tools", dll=SHIM_OLD, hook=False)
        w.proton("GE-Proton11-11", "tools", dll=SHIM_OLD, hook=True)
        w.proton("GE-Proton10-25", "tools", dll=SHIM_OLD, hook=True)
        w.proton("GE-Proton9-27", "tools", dll=SHIM_OLD, hook=False)
        w.proton("Proton - Experimental", "common", dll=SHIM_OLD, hook=True)
        w.proton("proton-cachyos", "system", dll=SHIM_OLD)
        w.compat({"0": "proton-cachyos"})
        # The Witcher 3 (SD card): DirectX 12 exe, its own XeSS 1.3 and XeLL 1.2
        write(os.path.join(self.game, "bin/x64_dx12/witcher3.exe"), b"MZ dx12")
        self.dll("bin/x64_dx12/libxess.dll", (1, 3, 1, 0))
        self.dll("bin/x64_dx12/libxell.dll", (1, 2, 1, 13))
        self.dll("bin/x64_dx12/libxess_fg.dll", (1, 1, 0, 39))        # the game's XeSS frame generation
        self.dll("bin/x64_dx12/sl.interposer.dll", (1, 5, 10, 0))     # Streamline 1
        write(w.sys("/usr/bin/7z"), "#!/bin/sh\n", 0o755)
        write(os.path.join(self.pkg, "tools", "fsr-fg.sh"), "#!/bin/sh\n")      # FSR=xess (20261104 and newer)
        self.mh, _ = w.app(MH_WILDS, "MonsterHunterWilds")
        fake_dll(os.path.join(self.mh, "libxess.dll"), (1, 3, 1, 32))
        fake_dll(os.path.join(self.mh, "amd_fidelityfx_dx12.dll"), (1, 0, 1, 39157))
        self.plain, _ = w.app(PLAIN, "PlainGame")
        write(os.path.join(self.plain, "PlainGame.exe"), make_pe(imports=("d3d12.dll",)))
        fake_dll(os.path.join(self.plain, "libxess.dll"), (1, 3, 1, 0))
        self.fsr, _ = w.app(FSRGAME, "FsrGame")
        fake_dll(os.path.join(self.fsr, "amd_fidelityfx_dx12.dll"), (1, 0, 1, 1))
        eac, _ = w.app(EAC, "Shooter")
        write(os.path.join(eac, "EasyAntiCheat", "x.dll"), b"x")
        fake_dll(os.path.join(eac, "libxess.dll"), (1, 3, 1, 0))
        cs, _ = w.app(CS2, "Counter-Strike Global Offensive")
        fake_dll(os.path.join(cs, "libxess.dll"), (1, 3, 1, 0))

    # helpers

    def on(self):
        self.assertTrue(autosetup.enable(self.ctx, True, True)["on"])

    def facts(self, name="GE-Proton11-11", prio=250, tools=None, hand=(), display=None):
        compat = None if name is None else {"name": name, "display": display or name, "priority": prio}
        return {"compat": compat, "tools": TOOLS if tools is None else tools, "hand": list(hand), "running": False}

    def plan(self, appid, **kw):
        r = autosetup.plan(self.ctx, self.settings, appid, self.facts(**kw))
        self.assertTrue(r["ok"], r)
        return r["plan"]

    def state(self):
        return autosetup.state(self.ctx)

    def agame(self, appid):
        return self.state()["games"][appid]

    def record(self, appid, change):
        r = autosetup.record(self.ctx, appid, change)
        self.assertTrue(r["ok"], r)
        return r["game"]["changes"][-1]

    def launch_change(self, appid=PLAIN, **set_):
        return self.record(appid, {"kind": "launch", "launch": {"set": set_ or {"XESS": "latest"}, "dropped": {},
                                                                 "args": []},
                                   "label": "XESS=latest", "why": "XeSS 1.3 is old.", "short": "for XeSS"})

    def proton_change(self, appid=PLAIN, to="GE-Proton11-11", frm="proton-cachyos", prio=100):
        return self.record(appid, {"kind": "proton", "proton": {"from": frm, "from_priority": prio, "to": to,
                                                                 "to_display": to}, "label": to})

    def play(self, appid, seconds):
        self.assertTrue(autosetup.session(self.ctx, appid, "start")["ok"])
        self.t += seconds
        r = autosetup.session(self.ctx, appid, "exit")
        self.assertTrue(r["ok"], r)
        self.t += 1
        return r["rollback"]


class SwitchTest(AutoBase):
    def test_on_needs_the_dialog(self):
        r = autosetup.enable(self.ctx, True)
        self.assertFalse(r["ok"])
        self.assertFalse(self.state()["on"])
        self.assertFalse(autosetup.enable(self.ctx, "yes", True)["ok"])
        self.on()
        self.assertEqual(self.state()["confirmed_at"], self.t)
        self.assertFalse(autosetup.enable(self.ctx, False)["on"])

    def test_off_records_nothing(self):
        p = self.plan(PLAIN, name="proton-cachyos", prio=100)
        self.assertFalse(p["on"])
        self.assertEqual(p["proton"]["to"], "GE-Proton11-11")           # what it would do
        self.assertEqual(self.state()["games"], {})
        self.assertEqual(autosetup.pending(self.ctx, [PLAIN])["appids"], [])


class ClassTest(AutoBase):
    def test_classes(self):
        self.on()
        self.assertEqual(self.plan(WITCHER)["class"], "known")
        self.assertEqual(self.plan(MH_WILDS)["class"], "known")
        self.assertEqual(self.plan(PLAIN, name="proton-cachyos", prio=100)["class"], "unknown")

    def test_anticheat_and_online_games_get_nothing_not_even_proton(self):
        self.on()
        for appid, why in ((EAC, "Shooter uses anti-cheat (EasyAntiCheat), so OXP3 Deck changes nothing by itself."),
                           (CS2, "Counter-Strike Global Offensive is an online game, so OXP3 Deck changes nothing "
                                 "by itself."),
                           ("999999", "This game is not installed."),
                           ("3000000000", "Not a Steam game, so OXP3 Deck changes nothing by itself.")):
            with self.subTest(appid=appid):
                p = self.plan(appid, name="proton-cachyos", prio=100)
                self.assertEqual((p["class"], p["skip_why"]), ("skipped", why))
                self.assertEqual((p["opti"], p["launch"], p["proton"], p["proton_note"], p["offers"]),
                                 (None, None, None, None, []))
        self.assertEqual(autosetup.classify(self.ctx, EAC)["class"], "skipped")

    def test_bad_input(self):
        self.assertFalse(autosetup.plan(self.ctx, self.settings, "12x", self.facts())["ok"])
        for bad in (None, {"tools": "x"}, {"compat": {"name": "a/b", "priority": 1}}, {"hand": "XESS"},
                    {"compat": {"name": "GE", "priority": True}}, {"running": "no"},
                    {"tools": [{"name": "x;rm"}]}):
            with self.subTest(bad=bad):
                r = autosetup.plan(self.ctx, self.settings, PLAIN, bad)
                self.assertFalse(r["ok"])
                self.assertIsNone(r["plan"])


class FirstSightTest(AutoBase):
    def test_manual_when_the_user_set_it_up(self):
        self.on()
        self.settings.set("ui_autolaunch", {"on": True, "games": {PLAIN: False}})
        p = self.plan(PLAIN, name="proton-cachyos", prio=100)
        self.assertEqual((p["mode"], p["mode_why"]), ("manual", "Automatic launch options were off for this game."))
        # an OptiScaler record from 0.5 (no origin)
        write(os.path.join(self.ctx.settings_dir, "optiscaler.json"),
              json.dumps({"version": 1, "global": {}, "games": {FSRGAME: {"build": "v10-20261105"}}}))
        self.assertEqual(self.plan(FSRGAME)["mode_why"], "You installed OptiScaler yourself.")
        p = self.plan(MH_WILDS, hand=["XESS_FG"])
        self.assertEqual((p["mode"], p["mode_why"]), ("manual", "You set its launch options yourself."))
        self.assertEqual(self.agame(MH_WILDS)["mode_by"], "detected")
        self.assertEqual(self.plan(WITCHER)["mode"], "auto")

    def test_hand_is_ignored_after_picking_automatic(self):
        self.on()
        self.assertEqual(self.plan(MH_WILDS, hand=["XESS_FG"])["mode"], "manual")
        g = autosetup.set_mode(self.ctx, MH_WILDS, "auto")["game"]
        self.assertEqual((g["mode"], g["mode_by"]), ("auto", "user"))
        p = self.plan(MH_WILDS, hand=["XESS_FG"])
        self.assertEqual(p["mode"], "auto")
        self.assertEqual(p["launch"]["plan"]["remove"], ["XESS_FG", "FSR", "FSR_FG"])

    def test_modes(self):
        self.on()
        self.plan(PLAIN, name="proton-cachyos", prio=100)
        g = autosetup.set_mode(self.ctx, PLAIN, "manual", "You changed its launch options in Steam.")["game"]
        self.assertEqual((g["mode"], g["mode_why"], g["mode_by"]),
                         ("manual", "You changed its launch options in Steam.", "detected"))
        g = autosetup.set_mode(self.ctx, PLAIN, "manual", "Another reason.")["game"]
        self.assertEqual(g["mode_why"], "You changed its launch options in Steam.")    # already Manual: kept
        g = autosetup.set_mode(self.ctx, PLAIN, "manual")["game"]
        self.assertEqual((g["mode_why"], g["mode_by"]), ("You picked Manual.", "user"))
        self.assertFalse(autosetup.set_mode(self.ctx, PLAIN, "off")["ok"])
        g = autosetup.set_mode(self.ctx, FSRGAME, "auto")["game"]           # before any plan
        self.assertEqual((g["mode"], g["plan_version"]), ("auto", 0))
        self.assertIn(FSRGAME, autosetup.pending(self.ctx, [FSRGAME])["appids"])


class PlanTest(AutoBase):
    def test_witcher_on_ge_proton_11_11(self):
        self.on()
        p = self.plan(WITCHER)
        self.assertEqual(p["opti"]["choices"], {"upscaler": "xess", "fg": 2, "fg_input": "xefg"})
        self.assertEqual(p["opti"]["short"], "for frame generation")
        self.assertIsNone(p["proton"])
        self.assertIsNone(p["proton_note"])
        self.assertIsNone(p["launch"])            # no XESS=latest: OptiScaler drops it; its FSR keys go with it
        self.assertEqual(p["offers"], [])
        self.assertFalse(p["needs_xess"])

    def test_witcher_with_a_file_in_the_way_falls_back_to_the_launch_options(self):
        self.on()
        write(os.path.join(self.game, "bin/x64_dx12/OptiScaler.ini"), b"someone's")
        p = self.plan(WITCHER)
        self.assertIsNone(p["opti"])
        self.assertEqual(p["opti_why"], optiscaler.IN_THE_WAY.format("OptiScaler.ini"))
        self.assertEqual(p["launch"]["plan"]["set"], {"XESS": "latest"})
        self.assertEqual(p["launch"]["plan"]["remove"], ["FSR", "FSR_FG"])
        self.assertNotIn("opti", [o["id"] for o in p["offers"]])

    def test_mh_wilds_on_ge_proton_11_11(self):
        self.on()
        p = self.plan(MH_WILDS)
        self.assertIsNone(p["opti"])
        self.assertIsNone(p["proton"])
        lp = p["launch"]["plan"]
        self.assertEqual((lp["set"], lp["remove"], lp["dll_override"], lp["dxvk_config"], lp["args"]),
                         ({}, ["XESS_FG", "FSR", "FSR_FG"], None, None, []))
        self.assertIn("known to break", p["launch"]["why"])
        self.assertEqual([o["id"] for o in p["offers"]], [])         # no OptiScaler (REFramework), no FSR

    def test_unknown_game_on_proton_cachyos_moves_to_the_newest_hooked_ge(self):
        self.on()
        p = self.plan(PLAIN, name="proton-cachyos", prio=100)
        self.assertEqual(p["proton"]["to"], "GE-Proton11-11")      # 12-1 has no hook; 11-11 over 10-25 over 9-27
        self.assertIn("lacks the XeSS add-on", p["proton"]["why"])
        self.assertEqual(p["launch"]["plan"]["set"], {"XESS": "latest"})   # against the Proton after the move
        self.assertIsNone(p["opti"])
        self.assertEqual([o["id"] for o in p["offers"]], ["opti"])
        self.assertLessEqual(len(p["offers"][0]["line"]), 80)

    def test_steams_default_counts_when_no_tool_is_set(self):
        self.on()
        p = self.plan(PLAIN, name="", prio=0)                       # config.vdf "0": proton-cachyos
        self.assertEqual(p["proton"]["to"], "GE-Proton11-11")
        self.assertIsNone(self.plan(PLAIN, name=None)["proton"])    # AppDetails unread: no move

    def test_fsr_is_only_offered(self):
        self.on()
        p = self.plan(FSRGAME)
        self.assertIsNone(p["launch"])
        fsr = [o for o in p["offers"] if o["id"] == "fsr"]
        self.assertEqual(fsr[0]["line"], "FSR → XeSS: the game's FSR runs on XeSS.")
        self.assertIsNone(p["proton"])                              # no XeSS DLLs: no move

    def test_experimental_when_no_hooked_ge(self):
        self.on()
        tools = [t for t in TOOLS if t["name"] not in ("GE-Proton11-11", "GE-Proton10-25")]
        p = self.plan(PLAIN, name="proton-cachyos", prio=100, tools=tools)
        self.assertEqual((p["proton"]["to"], p["proton"]["to_display"]), ("proton_experimental",
                                                                           "Proton Experimental"))
        self.assertEqual(autosetup.pick_proton(self.ctx, tools)["name"], "proton_experimental")
        self.assertEqual(autosetup.pick_proton(self.ctx, TOOLS)["name"], "GE-Proton11-11")
        self.assertIsNone(autosetup.pick_proton(self.ctx, "x"))

    def test_notes_without_a_target(self):
        self.on()
        tools = [{"name": "proton-cachyos", "display": "proton-cachyos"}]
        p = self.plan(PLAIN, name="proton-cachyos", prio=100, tools=tools)
        self.assertIsNone(p["proton"])
        self.assertEqual((p["proton_note"]["kind"], p["proton_note"]["line"]),
                         ("restart", "Restart Steam to use GE-Proton11-11."))
        self.assertIsNone(p["launch"])                              # XESS=latest needs the hook
        for n in ("GE-Proton11-11", "GE-Proton10-25"):
            shutil.rmtree(os.path.join(self.w.steam, "compatibilitytools.d", n))
        tools9 = tools + [{"name": "GE-Proton9-27", "display": "GE-Proton9-27"}]
        note = self.plan(PLAIN, name="proton-cachyos", prio=100, tools=tools9)["proton_note"]
        self.assertEqual((note["kind"], note["line"]),
                         ("unhooked", "GE-Proton9-27 lacks the XeSS add-on: repair XeSS fast mode (XeSS tab)."))
        note = self.plan(PLAIN, name="proton-cachyos", prio=100, tools=tools)["proton_note"]
        self.assertEqual((note["kind"], note["line"]), ("none", autosetup.NOTE_NONE))
        self.assertIn("ProtonUp-Qt", note["detail"])
        self.assertIn("Wine Cellar", note["detail"])

    def test_a_proton_the_user_picked_is_never_moved(self):
        self.on()
        p = self.plan(PLAIN, name="proton-cachyos", prio=250)
        self.assertIsNone(p["proton"])
        self.assertEqual((p["proton_note"]["kind"], p["proton_note"]["line"]),
                         ("user_pick", "Your Proton for PlainGame lacks the XeSS add-on."))
        offer = [o for o in p["offers"] if o["id"] == "proton"][0]
        self.assertEqual(offer["line"], "Use GE-Proton11-11 for XeSS.")
        self.assertIsNone(p["launch"])
        self.assertEqual(p["mode"], "auto")

    def test_our_own_pick_is_not_the_users_and_another_pick_supersedes_it(self):
        self.on()
        self.plan(PLAIN, name="proton-cachyos", prio=100)
        c = self.proton_change()
        p = self.plan(PLAIN, name="GE-Proton11-11", prio=250)
        self.assertIsNone(p["proton_note"])
        self.assertEqual(p["mode"], "auto")
        self.assertEqual(p["launch"]["plan"]["set"], {"XESS": "latest"})
        p = self.plan(PLAIN, name="GE-Proton10-25", prio=250)
        self.assertEqual((p["mode"], p["mode_why"]), ("manual", "You picked another Proton."))
        self.assertEqual([x["state"] for x in p["game"]["changes"] if x["id"] == c["id"]], ["superseded"])

    def test_without_xess_nothing_xess_related(self):
        self.on()
        with mock.patch.object(xess, "detect", return_value={"installed": False, "path": None, "how": None,
                                                              "env_pkg": None, "env": {}}):
            p = self.plan(PLAIN, name="proton-cachyos", prio=100)
            self.assertTrue(p["needs_xess"])
            self.assertEqual((p["proton"], p["launch"]), (None, None))
            w = self.plan(WITCHER)
            self.assertIsNone(w["opti"])
            self.assertEqual(w["opti_why"], autosetup.NEEDS_XESS)
            self.assertEqual(self.plan(MH_WILDS)["launch"]["plan"]["remove"], ["XESS_FG", "FSR", "FSR_FG"])

    def test_optiscaler_removed_outside_supersedes(self):
        self.on()
        self.plan(WITCHER)
        with mock.patch.object(optiscaler, "game_record", return_value={"build": "v10-20261105", "origin": "auto",
                                                                        "choices": {"upscaler": "xess", "fg": 2,
                                                                                    "fg_input": "xefg"}}):
            self.assertTrue(autosetup.opti_done(self.ctx, WITCHER, {"ok": True})["ok"])
            p = self.plan(WITCHER)
            self.assertIsNone(p["opti"])
            self.assertIsNone(p["launch"])                          # OptiScaler in the game: its keys stay out
        c = self.agame(WITCHER)["changes"][-1]
        self.assertEqual((c["kind"], c["label"], c["state"], c["short"]), ("opti", "OptiScaler", "live",
                                                                           "for frame generation"))
        p = self.plan(WITCHER)                                      # the record is gone
        self.assertEqual((p["mode"], p["mode_why"]), ("manual", "OptiScaler was removed outside OXP3 Deck."))


    def test_plan_moves_an_old_automatic_install_only_when_automatic(self):
        self.on()
        self.plan(WITCHER)
        old = {"build": "v10-20261105", "origin": "auto", "choices": {"upscaler": "xess", "fg": 2,
                                                                      "fg_input": "dlssg"}}
        for rec, mode, called in ((old, "auto", True), (dict(old, origin="user"), "auto", False),
                                  (old, "manual", False), (None, "auto", False)):
            with self.subTest(rec=rec, mode=mode):
                autosetup.set_mode(self.ctx, WITCHER, mode)
                with mock.patch.object(optiscaler, "game_record", return_value=rec), \
                        mock.patch.object(optiscaler, "migrate_auto", return_value=False) as m:
                    self.plan(WITCHER)
                self.assertEqual(m.called, called)
        autosetup.enable(self.ctx, False)
        with mock.patch.object(optiscaler, "game_record", return_value=old), \
                mock.patch.object(optiscaler, "migrate_auto", return_value=False) as m:
            autosetup.set_mode(self.ctx, WITCHER, "auto")
            self.plan(WITCHER)
        self.assertFalse(m.called)                                  # the switch off: nothing changes

    def test_witcher_without_xess_fg_plans_optifg(self):
        """The check is general: without libxess_fg.dll the automatic choices take OptiFG, not a greyed input."""
        os.unlink(os.path.join(self.game, "bin/x64_dx12/libxess_fg.dll"))
        optiscaler.forget_listing()
        self.on()
        p = self.plan(WITCHER)
        self.assertEqual(p["opti"]["choices"], {"upscaler": "xess", "fg": 2, "fg_input": "upscaler"})
        self.assertEqual(autosetup._opti_choices(self.ctx, WITCHER), p["opti"]["choices"])

    def test_plan_version_covers_the_files_check(self):
        self.assertGreaterEqual(autosetup.PLAN_VERSION, 3)


    def test_validation(self):
        self.on()
        self.assertFalse(autosetup.record(self.ctx, PLAIN, {"kind": "launch"})["ok"])     # not planned yet
        self.plan(PLAIN, name="proton-cachyos", prio=100)
        for bad in ({"kind": "opti", "opti": {"build": "v10-20261105"}},
                    {"kind": "sound"},
                    {"kind": "launch", "launch": {"set": {"LD_PRELOAD": "x"}, "dropped": {}, "args": []}},
                    {"kind": "launch", "launch": {"set": {"XESS": "latest; rm -rf"}, "dropped": {}, "args": []}},
                    {"kind": "launch", "launch": {"set": {}, "dropped": {}, "args": ["-dx12 && x"]}},
                    {"kind": "launch", "launch": {"set": {}, "dropped": {}, "args": []}},
                    {"kind": "launch", "launch": {"set": {f"XESS{i}": "1" for i in range(9)}, "dropped": {},
                                                  "args": []}},
                    {"kind": "proton", "proton": {"from": "", "from_priority": 0, "to": "../x", "to_display": "x"}},
                    {"kind": "proton", "proton": {"from": "a", "from_priority": 99999, "to": "GE-Proton11-11"}},
                    "launch"):
            with self.subTest(bad=bad):
                self.assertFalse(autosetup.record(self.ctx, PLAIN, bad)["ok"])
        c = self.record(PLAIN, {"kind": "launch", "launch": {"set": {"XESS": "latest"}, "dropped": {"FSR": "xess"},
                                                              "args": ["-dx12"]},
                                "label": "x" * 100, "why": "y" * 500, "short": "z" * 100, "at": 1})
        self.assertEqual((len(c["label"]), len(c["why"]), len(c["short"])), (40, 200, 40))
        self.assertEqual((c["at"], c["state"], c["tested"], c["accepted"], c["id"]),
                         (self.t, "live", False, False, f"launch-{int(self.t)}"))
        c2 = self.launch_change()
        self.assertEqual(c2["id"], f"launch-{int(self.t)}-2")
        p = self.proton_change(frm="")
        self.assertEqual(p["proton"], {"from": "", "from_priority": 100, "to": "GE-Proton11-11",
                                       "to_display": "GE-Proton11-11"})
        acc = self.record(PLAIN, {"kind": "launch", "accepted": True,
                                  "launch": {"set": {"FSR": "xess"}, "dropped": {}, "args": []}})
        self.assertEqual((acc["accepted"], acc["tested"]), (True, True))

    def test_a_second_proton_change_supersedes_the_first(self):
        self.on()
        self.plan(PLAIN, name="proton-cachyos", prio=100)
        a = self.proton_change()
        self.t += 5
        self.proton_change(to="GE-Proton10-25")
        states = {c["id"]: c["state"] for c in self.agame(PLAIN)["changes"]}
        self.assertEqual(states[a["id"]], "superseded")

    def test_limits(self):
        self.on()
        self.plan(PLAIN, name="proton-cachyos", prio=100)
        first = self.launch_change()
        autosetup.undone(self.ctx, PLAIN, first["id"])
        for _ in range(13):
            self.t += 1
            self.launch_change()
        changes = self.agame(PLAIN)["changes"]
        self.assertEqual(len(changes), autosetup.MAX_CHANGES)
        self.assertNotIn(first["id"], [c["id"] for c in changes])     # the undone one went first
        with mock.patch.object(autosetup, "MAX_GAMES", 3):
            for appid in ("11", "12", "13"):
                self.t += 1
                self.plan(appid)
            ids = set(self.state()["games"])
        self.assertEqual(len(ids), 3)
        self.assertIn(PLAIN, ids)                                      # it has live changes
        self.assertNotIn("11", ids)                                    # the oldest seen without one

    def test_a_planted_file_is_normalised(self):
        good = {"id": "launch-5", "kind": "launch", "at": 5, "state": "live",
                "launch": {"set": {"XESS": "latest"}, "dropped": {}, "args": []}}
        planted = {"version": 1, "on": "yes", "confirmed_at": "never", "games": {
            "12x": {}, PLAIN: {"name": 7, "class": "evil", "mode": "root", "mode_by": 1, "seen_at": "x",
                               "changes": [good, dict(good), {"id": "rm -rf", "kind": "launch"},
                                           {"id": "proton-6", "kind": "proton", "at": 6,
                                            "proton": {"from": "", "from_priority": 0, "to": "/bin/sh"}},
                                           {"id": "opti-7", "kind": "launch", "at": 7,
                                            "launch": {"set": {}, "dropped": {}, "args": []}}],
                               "session": {"started_at": "now", "quick_exits": -4}, "rollback_due": "launch-9",
                               "notice": "x" * 1000}}}
        write(os.path.join(self.ctx.settings_dir, "auto.json"), json.dumps(planted))
        st = self.state()
        self.assertFalse(st["on"])
        self.assertIsNone(st["confirmed_at"])
        self.assertEqual(list(st["games"]), [PLAIN])
        g = st["games"][PLAIN]
        self.assertEqual((g["name"], g["class"], g["mode"], g["mode_by"], g["seen_at"]),
                         (PLAIN, "unknown", "auto", "default", 0.0))
        self.assertEqual([c["id"] for c in g["changes"]], ["launch-5"])
        self.assertEqual(g["session"], {"started_at": None, "quick_exits": 0, "last_run_s": None})
        self.assertIsNone(g["rollback_due"])
        self.assertEqual(len(g["notice"]), 300)
        write(os.path.join(self.ctx.settings_dir, "auto.json"), "{not json")
        with self.assertLogs("oxp3deck", "WARNING"):
            self.assertEqual(self.state()["games"], {})


class UndoTest(AutoBase):
    def test_user_undo_makes_the_game_manual(self):
        self.on()
        self.plan(PLAIN, name="proton-cachyos", prio=100)
        c = self.launch_change()
        r = autosetup.undone(self.ctx, PLAIN, c["id"])
        self.assertEqual(r["kind"], "launch")
        g = r["game"]
        self.assertEqual((g["mode"], g["mode_why"]), ("manual", "You tapped Undo."))
        self.assertEqual(g["changes"][-1]["state"], "undone")
        self.assertFalse(autosetup.undone(self.ctx, PLAIN, c["id"])["ok"])          # not live any more
        self.assertFalse(autosetup.undone(self.ctx, PLAIN, c["id"], "later")["ok"])

    def test_optiscaler_undo_goes_through_the_remove_job(self):
        self.on()
        self.plan(WITCHER)
        rec = {"build": "v10-20261105", "origin": "auto", "choices": {"upscaler": "xess", "fg": 2,
                                                                      "fg_input": "xefg"}}
        with mock.patch.object(optiscaler, "game_record", return_value=rec):
            autosetup.opti_done(self.ctx, WITCHER, {"ok": True})
            cid = self.agame(WITCHER)["changes"][-1]["id"]
            r = autosetup.undone(self.ctx, WITCHER, cid, "rollback")
            self.assertEqual(r["kind"], "opti")
            self.assertEqual(self.agame(WITCHER)["changes"][-1]["state"], "live")     # marked by the job
        with mock.patch.object(optiscaler, "remove", return_value={"ok": True, "kept": [], "launch": None}):
            res = autosetup.opti_undo(self.ctx, None, None, WITCHER, cid, "rollback")
        self.assertEqual(res["game"]["changes"][-1]["state"], "rolled_back")
        self.assertIn("installed OptiScaler", res["game"]["notice"])
        self.assertEqual(res["game"]["mode"], "auto")

    def test_opti_install_job(self):
        self.on()
        self.plan(WITCHER)
        seen = {}

        def install(ctx, settings, job, appid, choices, *, auto=False, origin="user"):
            seen["args"] = (appid, choices, auto, origin)
            return {"ok": True, "error": None}
        rec = {"build": "v10-20261105", "origin": "auto", "choices": {"upscaler": "xess", "fg": 2,
                                                                      "fg_input": "xefg"}}
        self.assertIsNone(autosetup.opti_precheck(self.ctx, self.settings, WITCHER))
        with mock.patch.object(optiscaler, "install", install), \
                mock.patch.object(optiscaler, "game_record", return_value=rec):
            res = autosetup.opti_install(self.ctx, self.settings, None, WITCHER)
        self.assertEqual(seen["args"], (WITCHER, rec["choices"], True, "auto"))
        c = res["game"]["changes"][-1]
        self.assertEqual((c["kind"], c["opti"]["build"], c["accepted"], c["tested"]),
                         ("opti", "v10-20261105", False, False))
        with mock.patch.object(optiscaler, "install", return_value={"ok": False, "error": "A file is in the way"}):
            autosetup.opti_install(self.ctx, self.settings, None, WITCHER)
        self.assertIn("A file is in the way", self.agame(WITCHER)["last_error"])
        autosetup.enable(self.ctx, False)
        self.assertEqual(autosetup.opti_precheck(self.ctx, self.settings, WITCHER), "Automatic setup is off.")
        self.assertIsNone(autosetup.opti_precheck(self.ctx, self.settings, WITCHER, True))
        autosetup.set_mode(self.ctx, WITCHER, "manual")
        self.assertEqual(autosetup.opti_precheck(self.ctx, self.settings, WITCHER, True),
                         "The Witcher 3 is set to Manual.")
        self.assertEqual(autosetup.opti_precheck(self.ctx, self.settings, EAC, True),
                         "automatic setup: OXP3 Deck has not planned this game yet")


class SessionTest(AutoBase):
    def setUp(self):
        super().setUp()
        self.on()
        self.plan(PLAIN, name="proton-cachyos", prio=100)

    def test_a_quick_exit_rolls_back_the_change_before_it(self):
        c = self.launch_change()
        self.t += 10
        rb = self.play(PLAIN, 30)
        self.assertEqual(rb["id"], c["id"])
        self.assertEqual(self.agame(PLAIN)["rollback_due"], c["id"])
        p = self.plan(PLAIN, name="GE-Proton11-11", prio=250)           # after a reload: still due
        self.assertEqual(p["rollback"]["id"], c["id"])
        self.assertIn(PLAIN, autosetup.pending(self.ctx, [PLAIN])["appids"])
        g = autosetup.undone(self.ctx, PLAIN, c["id"], "rollback")["game"]
        self.assertIsNone(g["rollback_due"])
        self.assertEqual(g["changes"][-1]["state"], "rolled_back")
        self.assertEqual(g["mode"], "auto")
        self.assertEqual(g["notice"], "PlainGame closed within a minute after OXP3 Deck changed its launch options "
                                      "(XESS=latest), so that change is undone.")
        self.assertIsNone(self.plan(PLAIN, name="GE-Proton11-11", prio=250)["rollback"])

    def test_a_long_run_marks_changes_tested_and_three_quick_exits_undo_anyway(self):
        c = self.launch_change()
        self.t += 10
        self.assertIsNone(self.play(PLAIN, 90))
        self.assertTrue(self.agame(PLAIN)["changes"][-1]["tested"])
        self.assertEqual(self.agame(PLAIN)["session"]["last_run_s"], 90.0)
        self.assertIsNone(self.play(PLAIN, 5))
        self.assertIsNone(self.play(PLAIN, 5))
        self.assertEqual(self.play(PLAIN, 5)["id"], c["id"])               # the third in a row
        self.assertEqual(self.agame(PLAIN)["session"]["quick_exits"], 0)

    def test_a_change_made_after_the_start_is_not_rolled_back(self):
        self.assertTrue(autosetup.session(self.ctx, PLAIN, "start")["ok"])
        self.t += 5
        self.launch_change()
        self.t += 5
        self.assertIsNone(autosetup.session(self.ctx, PLAIN, "exit")["rollback"])

    def test_the_reapers_start_time_is_used(self):
        """The start event comes 30 s late (a plugin reload while the game runs): the reaper's start time counts."""
        c = self.launch_change()
        started = self.t + 10
        self.t += 40
        with mock.patch.object(steamlib, "game_started_at", return_value=started):
            autosetup.session(self.ctx, PLAIN, "start")
            autosetup.session(self.ctx, PLAIN, "start")                                   # a repeat
        self.t += 40
        self.assertIsNone(autosetup.session(self.ctx, PLAIN, "exit")["rollback"])         # 70 s, not 40 s
        self.assertEqual(self.agame(PLAIN)["session"]["last_run_s"], 70.0)
        self.assertTrue([x for x in self.agame(PLAIN)["changes"] if x["id"] == c["id"]][0]["tested"])
        with mock.patch.object(steamlib, "game_started_at", return_value=self.t + 3600):  # nonsense: now
            autosetup.session(self.ctx, PLAIN, "start")
        self.assertEqual(self.agame(PLAIN)["session"]["started_at"], self.t)

    def test_exit_without_start_and_unknown_games(self):
        self.assertIsNone(autosetup.session(self.ctx, PLAIN, "exit")["rollback"])
        self.assertIsNone(autosetup.session(self.ctx, "42", "start")["game"])
        self.assertFalse(autosetup.session(self.ctx, PLAIN, "pause")["ok"])

    def test_no_rollback_while_the_switch_is_off(self):
        self.launch_change()
        autosetup.enable(self.ctx, False)
        self.t += 10
        self.assertIsNone(self.play(PLAIN, 10))

    def test_a_rolled_back_change_is_not_planned_again_until_try_again(self):
        self.t += 10
        c = self.proton_change()
        self.t += 10
        self.play(PLAIN, 10)
        autosetup.undone(self.ctx, PLAIN, c["id"], "rollback")
        p = self.plan(PLAIN, name="proton-cachyos", prio=100)
        self.assertIsNone(p["proton"])
        lc = self.launch_change()
        self.t += 10
        self.play(PLAIN, 10)
        autosetup.undone(self.ctx, PLAIN, lc["id"], "rollback")
        self.assertIsNone(self.plan(PLAIN, name="GE-Proton11-11", prio=250)["launch"])
        g = autosetup.retry(self.ctx, PLAIN, lc["id"])["game"]
        self.assertIsNone(g["notice"])
        self.assertEqual(self.plan(PLAIN, name="GE-Proton11-11", prio=250)["launch"]["plan"]["set"],
                         {"XESS": "latest"})
        again = self.launch_change()
        self.assertEqual((again["kept"], again["tested"]), (True, True))
        self.t += 10
        self.assertIsNone(self.play(PLAIN, 10))                           # tested: one quick exit keeps it
        self.assertFalse(autosetup.retry(self.ctx, PLAIN, again["id"])["ok"])   # not rolled back


class PendingTest(AutoBase):
    def test_pending(self):
        self.assertEqual(autosetup.pending(self.ctx, [PLAIN])["appids"], [])            # off
        self.on()
        self.assertFalse(autosetup.pending(self.ctx, "x")["ok"])
        self.assertFalse(autosetup.pending(self.ctx, [1])["ok"])
        self.assertFalse(autosetup.pending(self.ctx, ["1"] * 2001)["ok"])
        ids = [str(i) for i in range(100, 120)] + [WITCHER, "3000000000"]
        got = autosetup.pending(self.ctx, ids)["appids"]
        self.assertEqual(len(got), autosetup.PENDING_MAX)
        self.assertEqual(got[0], WITCHER)                                              # known first
        self.assertNotIn("3000000000", got)
        self.plan(WITCHER)
        self.assertNotIn(WITCHER, autosetup.pending(self.ctx, [WITCHER])["appids"])
        with mock.patch.object(autosetup, "PLAN_VERSION", autosetup.PLAN_VERSION + 1):
            self.assertEqual(autosetup.pending(self.ctx, [WITCHER])["appids"], [WITCHER])

    def test_from_the_manifests(self):
        self.on()
        write(os.path.join(self.w.steam, "steamapps", f"appmanifest_{PLAIN}.acf"),
              f'"AppState"\n{{\n"appid" "{PLAIN}"\n"name" "PlainGame"\n"installdir" "PlainGame"\n'
              '"StateFlags" "4"\n}\n')
        self.assertEqual(autosetup.pending(self.ctx, None)["appids"], [PLAIN])


class ToolsTest(AutoBase):
    def test_a_stock_shim_is_not_a_target(self):
        """A GE-Proton with the hook but a stock igdext64.dll is skipped."""
        self.w.proton("GE-Proton11-12", "tools", dll=STOCK, hook=True)
        tools = [{"name": "GE-Proton11-12", "display": "GE-Proton11-12"}] + TOOLS
        self.assertEqual(autosetup.pick_proton(self.ctx, tools)["name"], "GE-Proton11-11")


class ReviewFixTest(AutoBase):
    """The review of the automatic setup (2026-11-06): the cases it found."""

    def test_steams_default_after_our_move_is_the_users_pick(self):
        self.on()
        self.plan(PLAIN, name="proton-cachyos", prio=100)
        c = self.proton_change()
        p = self.plan(PLAIN, name="", prio=0)                  # "force" turned off in Steam: Steam's default
        self.assertEqual((p["mode"], p["mode_why"]), ("manual", "You picked another Proton."))
        self.assertEqual([x["state"] for x in p["game"]["changes"] if x["id"] == c["id"]], ["superseded"])
        g = self.agame(PLAIN)
        self.assertEqual((g["mode"], g["mode_by"]), ("manual", "detected"))

    def test_launch_options_set_by_hand_later_make_a_seen_game_manual(self):
        self.on()
        self.assertEqual(self.plan(MH_WILDS)["mode"], "auto")
        p = self.plan(MH_WILDS, hand=["XESS_FG=2"])
        self.assertEqual((p["mode"], p["mode_why"]), ("manual", "You set its launch options yourself."))
        # the user's own Automatic pick is kept
        autosetup.set_mode(self.ctx, MH_WILDS, "auto")
        self.assertEqual(self.plan(MH_WILDS, hand=["XESS_FG=2"])["mode"], "auto")

    def test_our_own_live_keys_are_not_set_by_hand(self):
        self.on()
        self.plan(PLAIN, name="GE-Proton11-11", prio=250)
        self.launch_change()
        p = self.plan(PLAIN, name="GE-Proton11-11", prio=250, hand=["XESS=latest"])
        self.assertEqual(p["mode"], "auto")
        p = self.plan(PLAIN, name="GE-Proton11-11", prio=250, hand=["XESS=latest", "-dx12"])
        self.assertEqual(p["mode"], "manual")

    def test_optiscaler_replaces_a_change_that_only_set_its_keys(self):
        self.on()
        self.plan(WITCHER)
        xc = self.launch_change(WITCHER)
        mixed = self.record(WITCHER, {"kind": "launch", "label": "XESS=latest no FSR",
                                      "launch": {"set": {"XESS": "latest"}, "dropped": {"FSR": "xess"}, "args": []}})
        with mock.patch.object(optiscaler, "game_record", return_value={"build": "v10-20261105", "origin": "auto",
                                                                        "choices": {"upscaler": "xess", "fg": 2,
                                                                                    "fg_input": "xefg"}}):
            g = autosetup.opti_done(self.ctx, WITCHER, {"ok": True}, True)["game"]
        states = {c["id"]: c["state"] for c in g["changes"]}
        self.assertEqual(states[xc["id"]], "superseded")
        self.assertEqual(states[mixed["id"]], "live")
        self.assertEqual(g["mode"], "auto")

    def test_while_running_the_plan_still_sees_a_file_in_the_way(self):
        self.on()
        write(os.path.join(self.game, "bin/x64_dx12/OptiScaler.ini"), b"someone's")
        with mock.patch.object(steamlib, "running_game", return_value=WITCHER):
            p = self.plan(WITCHER)
        self.assertIsNone(p["opti"])
        self.assertEqual(p["opti_why"], optiscaler.IN_THE_WAY.format("OptiScaler.ini"))
        with mock.patch.object(steamlib, "running_game", return_value=WITCHER):
            p = self.plan(PLAIN, name="GE-Proton11-11", prio=250)
        self.assertEqual([o["id"] for o in p["offers"]], ["opti"])        # no file in its way: still offered

    def test_a_rollback_due_is_scanned_first(self):
        self.on()
        self.plan(PLAIN, name="GE-Proton11-11", prio=250)
        self.launch_change()
        self.t += 10
        self.assertIsNotNone(self.play(PLAIN, 5))
        got = autosetup.pending(self.ctx, [str(i) for i in range(100, 120)] + [WITCHER, PLAIN])["appids"]
        self.assertEqual(got[:2], [PLAIN, WITCHER])


if __name__ == "__main__":
    unittest.main()
