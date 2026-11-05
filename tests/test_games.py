import os
import tempfile
import unittest
from unittest import mock

from oxp3deck import context, games, xess
from tests.test_pe import fake_dll
from tests.test_steamlib import World, patch_user, write
from tests.test_xess import SHIM_OLD, STOCK, env_text, make_package

WITCHER = "292030"


class GameBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.w = World(self.tmp.name)
        self.ctx = self.w.ctx
        self.w.make_steam()
        os.makedirs(self.w.sys("/proc"))
        self.u = patch_user(self)
        self.settings = context.Settings(os.path.join(self.ctx.settings_dir, "settings.json"))
        xess._marker_cache.clear()
        self.pkg = make_package(os.path.join(self.ctx.home, "Documents", "xess-xmx-linux-20261031"), "20261031")
        write(os.path.join(self.ctx.home, xess.ENV_FILE), env_text(self.pkg))
        self.sd = self.w.add_library(os.path.join(self.tmp.name, "media", "SD"))
        self.game, self.pfx = self.w.app(WITCHER, "The Witcher 3", lib=self.sd)

    def info(self, appid=WITCHER):
        r = games.game_info(self.ctx, self.settings, appid)
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.u.calls, [])      # nothing runs for a game's info
        return r["game"]

    def dll(self, rel, version):
        p = os.path.join(self.game, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        return fake_dll(p, version)


class GameInfoTest(GameBase):
    def test_witcher3_on_a_stock_system_proton(self):
        """The owner's case: XeLL 1.2.1.13 refuses the GPU, on proton-cachyos-slr without the shim."""
        self.w.compat({"0": "proton_experimental", WITCHER: "proton-cachyos-slr"})
        slr = self.w.proton("proton-cachyos-slr", "system", dll=STOCK)
        self.dll("bin/x64_dx12/libxess.dll", (1, 3, 1, 0))
        self.dll("bin/x64_dx12/libxess_fg.dll", (1, 1, 0, 19))
        self.dll("bin/x64_dx12/libxell.dll", (1, 2, 1, 13))
        deep = "/".join(f"d{i}" for i in range(1, 11))          # 10 folders down: found, as proton-hook.py does
        self.dll(deep + "/libxess_dx11.dll", (1, 3, 1, 0))
        self.dll(deep + "/d11/libxess.dll", (9, 9, 9, 9))       # 11 down: not searched
        write(os.path.join(self.game, "bin/x64_dx12/LIBXESS.DLL.txt"), "not a dll")
        c = os.path.join(self.pfx, "drive_c")
        write(os.path.join(c, "igdext_trace.log"), "igdext: GPU 0xb0a0\nfallback: unknown Intel device id\n"
                                                   "igdext: later\nfallback: self-test failed (no canary)\n")
        write(os.path.join(c, "igdext_xell.log"), "[XeLL] XeLL context creation failed - unsupported device\n")
        write(os.path.join(c, "igdext_kernels", "compile_failed.txt"), "k1\n")
        write(os.path.join(c, "igdext_kernels", "anv_canary"), "")
        g = self.info()
        self.assertEqual((g["appid"], g["install_dir"], g["prefix"]), (WITCHER, self.game, self.pfx))
        self.assertEqual((g["compat_tool"], g["default_compat_tool"]), ("proton-cachyos-slr", "proton_experimental"))
        self.assertEqual((g["compat_tool_dir"], g["compat_tool_system"], g["compat_tool_shimmed"]), (slr, True, False))
        found = {os.path.relpath(d["path"], self.game): d["version"] for d in g["dlls"]}
        self.assertEqual(found, {"bin/x64_dx12/libxess.dll": "1.3.1.0", "bin/x64_dx12/libxess_fg.dll": "1.1.0.19",
                                 "bin/x64_dx12/libxell.dll": "1.2.1.13", deep + "/libxess_dx11.dll": "1.3.1.0"})
        self.assertEqual(g["last_run"]["fallback"], "self-test failed (no canary)")
        self.assertEqual({k: g["last_run"][k] for k in ("trace", "compile_failed", "canary", "xell_unsupported")},
                         {"trace": True, "compile_failed": True, "canary": True, "xell_unsupported": True})
        self.assertIsNotNone(g["last_run"]["logged_at"])
        advice = "\n".join(g["advice"])
        self.assertIn("XeSS 1.3.1.0 is older than 2.0.2.68", advice)
        self.assertIn("needs the Proton hook, which proton-cachyos-slr (a system Proton) does not have", advice)
        self.assertIn("XeSS frame generation 1.1.0.19 is older than 1.2", advice)
        self.assertIn("XeLL 1.2 may refuse this GPU (unsupported device), so frame generation can stay off", advice)
        self.assertIn("The last run's log says it did", advice)
        self.assertNotIn("XeLL refused this GPU at the last run", advice)       # said once
        self.assertIn("falls back to DP4a until a retry", advice)
        self.assertIn("self-test", advice)
        self.assertIn("proton-cachyos-slr is a system Proton without the shim", advice)
        self.assertIn("shim it from the XeSS page", advice)
        # no hook on a system Proton: XESS=latest does nothing there (xess-research: the old line was wrong)
        self.assertIn("needs the Proton hook, which proton-cachyos-slr does not have: pick Proton Experimental", advice)
        self.assertNotIn("XESS=latest swaps in XeLL 1.3.2.10 while the game runs", advice)
        self.assertEqual([i["id"] for i in g["known_issues"]], ["xell12"])
        self.assertFalse(g["fg_crash"])
        self.assertTrue(g["has_fg"])

    def test_shimmed_user_proton_and_current_xess(self):
        self.w.compat({WITCHER: "GE-Proton10-3"})
        self.w.proton("GE-Proton10-3", "tools", dll=SHIM_OLD, hook=True)
        self.dll("bin/x64/libxess.dll", (2, 0, 2, 68))
        self.dll("bin/x64/libxell.dll", (1, 3, 2, 10))
        g = self.info()
        self.assertEqual((g["compat_tool_shimmed"], g["compat_tool_system"], g["compat_tool_hook"]),
                         (True, False, True))
        self.assertEqual(g["last_run"], {"trace": False, "fallback": None, "compile_failed": False, "canary": False,
                                         "xell_unsupported": None, "xell_builtin": None, "fg_fullscreen": None,
                                         "xefg": None, "logged_at": None})
        self.assertEqual(g["advice"], [])
        self.assertEqual(g["prefix_checks"], {"driverstore_capital": False, "driverstore_capital_shimmed": None,
                                              "hides_wine": None})
        self.assertEqual((g["has_fg"], g["checks"]), (False, []))

    def test_xell_refusal_seen_without_xell_12(self):
        self.w.compat({WITCHER: "GE-Proton10-3"})
        self.w.proton("GE-Proton10-3", "tools", dll=SHIM_OLD, hook=True)
        self.dll("libxell.dll", (1, 3, 0, 5))
        write(os.path.join(self.pfx, "drive_c", "igdext_trace.log"),
              "XeLL context creation failed - Unsupported device")
        g = self.info()
        self.assertTrue(g["last_run"]["xell_unsupported"])
        self.assertIn("XeLL refused this GPU at the last run", "\n".join(g["advice"]))
        write(os.path.join(self.pfx, "drive_c", "igdext_trace.log"), "all fine\n")
        self.assertFalse(self.info()["last_run"]["xell_unsupported"])

    def test_default_tool_unknown(self):
        g = self.info()
        self.assertIsNone(g["compat_tool"])
        self.assertIsNone(g["compat_tool_shimmed"])
        self.assertIn("Steam's config.vdf does not name", "\n".join(g["advice"]))
        self.assertIn("No XeSS or FidelityFX DLL", "\n".join(g["advice"]))
        self.w.compat({"0": "proton_experimental"})
        self.assertIn("Steam's default tool (proton_experimental), whose folder was not found",
                      "\n".join(self.info()["advice"]))
        exp = self.w.proton("Proton - Experimental", "common", dll=SHIM_OLD, hook=True)
        g = self.info()
        self.assertEqual((g["compat_tool"], g["compat_tool_dir"], g["compat_tool_shimmed"]), (None, exp, True))
        self.assertNotIn("default", "\n".join(g["advice"]))

    def test_mapped_tool_not_found(self):
        self.w.compat({WITCHER: "GE-Proton9-1"})
        self.assertIn("The folder of GE-Proton9-1 was not found", "\n".join(self.info()["advice"]))

    def test_proton_without_driver_store(self):
        self.w.compat({WITCHER: "proton_11"})
        self.w.proton("Proton 11.0", "common", dll=None, hook=True)
        g = self.info()
        self.assertIsNone(g["compat_tool_shimmed"])
        self.assertIn("XeSS loads the shim there only with xess-xmx-linux 20261104 or newer", "\n".join(g["advice"]))
        write(os.path.join(self.ctx.home, xess.ENV_FILE), env_text(self.pkg, alt=True))
        self.assertNotIn("20261104 or newer", "\n".join(self.info()["advice"]))

    def test_fsr_only_game(self):
        self.w.compat({WITCHER: "GE-Proton10-3"})
        self.w.proton("GE-Proton10-3", "tools", dll=SHIM_OLD, hook=True)
        self.dll("Game/Binaries/Win64/amd_fidelityfx_dx12.dll", (1, 0, 0, 0))
        g = self.info()
        self.assertEqual([d["kind"] for d in g["dlls"]], ["ffx"])
        advice = "\n".join(g["advice"])
        self.assertIn("FSR=xess runs its upscaling and frame generation on XeSS", advice)
        self.assertIn("needs xess-xmx-linux 20261104 or newer", advice)       # the package is 20261031
        self.dll("Game/Binaries/Win64/libxess.dll", (2, 0, 2, 68))
        self.assertNotIn("FSR=xess", "\n".join(self.info()["advice"]))           # a game with XeSS uses its XeSS

    def test_leftover_and_link(self):
        self.w.compat({WITCHER: "GE-Proton10-3"})
        self.w.proton("GE-Proton10-3", "tools", dll=SHIM_OLD, hook=True)
        os.makedirs(os.path.join(self.pkg, "xess"))
        sdk = fake_dll(os.path.join(self.pkg, "xess", "libxess.dll"), (2, 0, 2, 68))
        self.dll("bin/libxess.dll.xmx-orig", (2, 0, 1, 41))
        os.symlink(sdk, os.path.join(self.game, "bin", "libxess.dll"))
        g = self.info()
        self.assertEqual([(d["version"], d["link"]) for d in g["dlls"]], [("2.0.2.68", True)])
        self.assertIn("left the game's own libraries renamed (.xmx-orig)", "\n".join(g["advice"]))
        outside = fake_dll(os.path.join(self.tmp.name, "root-only.dll"), (6, 6, 6, 6))
        os.symlink(outside, os.path.join(self.game, "libxell.dll"))
        versions = {d["name"]: d["version"] for d in self.info()["dlls"]}
        self.assertEqual(versions, {"libxess.dll": "2.0.2.68", "libxell.dll": None})   # a link out is not read

    def test_entry_limit(self):
        for i in range(30):
            write(os.path.join(self.game, f"f{i}.pak"), "")
        with mock.patch.object(games, "MAX_ENTRIES", 10):
            self.assertIn("more than 10 entries", "\n".join(self.info()["advice"]))

    def test_no_prefix_no_folder_not_installed(self):
        os.unlink(os.path.join(self.ctx.home, xess.ENV_FILE))
        self.w.app("10", "Native", prefix=False)
        g = self.info("10")
        self.assertIsNone(g["prefix"])
        self.assertIsNone(g["last_run"])
        advice = "\n".join(g["advice"])
        self.assertTrue(g["advice"][0].startswith("xess-xmx-linux is not installed"))
        self.assertIn("No Proton prefix yet", advice)
        g = self.info("999")
        self.assertIn("The game's folder was not found", "\n".join(g["advice"]))

    def test_not_a_steam_game(self):
        for bad in ("", "abc", "12a", "../1", None, "-1"):
            r = games.game_info(self.ctx, self.settings, bad)
            self.assertEqual((r["ok"], r["error"], r["game"]), (False, "game info: not a Steam game", None), bad)

    def test_never_raises(self):
        with mock.patch.object(games.steamlib, "app_install_dir", side_effect=RuntimeError("boom")), \
                self.assertLogs("oxp3deck", "ERROR"):
            r = games.game_info(self.ctx, self.settings, WITCHER)
        self.assertEqual((r["ok"], r["error"]), (False, "game info: RuntimeError: boom"))


MH_WILDS = "2246340"


class KnownIssuesTest(GameBase):
    def test_mh_wilds_frame_generation_crashes(self):
        game, _pfx = self.w.app(MH_WILDS, "MonsterHunterWilds")
        self.w.compat({MH_WILDS: "GE-Proton10-3"})
        self.w.proton("GE-Proton10-3", "tools", dll=SHIM_OLD, hook=True)
        fake_dll(os.path.join(game, "libxess.dll"), (1, 3, 1, 32))
        fake_dll(os.path.join(game, "amd_fidelityfx_dx12.dll"), (1, 0, 1, 39157))
        g = self.info(MH_WILDS)
        self.assertTrue(g["fg_crash"])
        self.assertEqual(g["known_issues"][0]["line"], "Frame generation crashes the game. Leave it on Game default.")
        self.assertIn("issues/42", g["known_issues"][0]["source"])
        self.assertIs(g["has_fg"], False)                            # no libxess_fg.dll: XESS_FG has nothing to act on
        self.assertEqual([(a["key"], a["value"]) for a in g["suggest"]], [("XESS", "latest")])

    def test_every_issue_names_its_source_and_fits_one_line(self):
        for appid, issues in games.KNOWN_ISSUES.items():
            for i in issues:
                self.assertTrue(i["source"], appid)
                self.assertLessEqual(len(i["line"]), 80, i["line"])
                self.assertEqual(set(i), {"id", "fg_crash", "fsr_risk", "label", "line", "detail", "source"})

    def test_other_games_have_none(self):
        self.assertEqual(games.known_issues("10"), [])
        self.assertEqual(self.info()["known_issues"][0]["id"], "xell12")


class NeverFrameGenerationTest(GameBase):
    """The automatic launch options never add XESS_FG (owner report: XeSS FG from launch options crashed MH Wilds)."""

    def test_no_game_ever_gets_xess_fg_or_fsr_fg(self):
        self.w.compat({WITCHER: "GE-Proton10-3", MH_WILDS: "GE-Proton10-3"})
        self.w.proton("GE-Proton10-3", "tools", dll=SHIM_OLD, hook=True)
        write(os.path.join(self.pkg, "tools", "fsr-fg.sh"), "#!/bin/sh\n")
        game, _pfx = self.w.app(MH_WILDS, "MonsterHunterWilds")
        cases = [((1, 3, 1, 0), (1, 1, 0, 19), (1, 2, 1, 13)), ((2, 0, 2, 68), (1, 3, 1, 78), (1, 3, 2, 10)),
                 (None, None, None)]
        for appid, folder in ((WITCHER, self.game), (MH_WILDS, game)):
            for x, f, ll in cases:
                for n, v in (("libxess.dll", x), ("libxess_fg.dll", f), ("libxell.dll", ll)):
                    path = os.path.join(folder, n)
                    if v is None:
                        if os.path.exists(path):
                            os.unlink(path)
                    else:
                        fake_dll(path, v)
                fake_dll(os.path.join(folder, "amd_fidelityfx_dx12.dll"), (1, 0, 0, 0))
                keys = [a["key"] for a in self.info(appid)["suggest"]]
                self.assertFalse(set(keys) & {"XESS_FG", "FSR_FG"}, (appid, keys))
                if appid == MH_WILDS:
                    self.assertNotIn("FSR", keys)                # its FSR route crashes (issue #42 pattern)
        with mock.patch.object(games, "_version_of", return_value=(None, None)):
            self.assertFalse([a for a in self.info()["suggest"] if a["key"] == "XESS_FG"])

    def test_the_filter_drops_frame_generation_whatever_adds_it(self):
        det = {"installed": True, "path": self.pkg}
        game = {"compat_tool_hook": True, "dlls": [], "known_issues": []}
        with mock.patch.object(games, "_version_of", return_value=(None, None)):
            self.assertEqual(games._suggest(det, game), [])
        self.assertEqual(games.NEVER_SUGGESTED, ("XESS_FG", "FSR_FG"))


class PrefixChecksTest(GameBase):
    def sys32(self):
        return os.path.join(self.pfx, "drive_c", "windows", "system32")

    def test_a_capitalised_driver_store_without_the_shim(self):
        stock = self.w.proton("proton-cachyos-slr", "system", dll=STOCK)
        d = os.path.join(self.sys32(), "DriverStore", "FileRepository", "igd_faux.inf_1")
        os.makedirs(d)
        os.symlink(os.path.join(stock, xess.IGDEXT_REL), os.path.join(d, "igdext64.dll"))
        os.makedirs(os.path.join(self.sys32(), "driverstore", "filerepository", "igd_faux.inf_1"))
        g = self.info()
        self.assertEqual(g["prefix_checks"]["driverstore_capital"], True)
        self.assertIs(g["prefix_checks"]["driverstore_capital_shimmed"], False)
        self.assertIn("driverstore", [c["id"] for c in g["checks"]])
        os.unlink(os.path.join(d, "igdext64.dll"))
        write(os.path.join(d, "igdext64.dll"), SHIM_OLD)
        xess._marker_cache.clear()
        self.assertNotIn("driverstore", [c["id"] for c in self.info()["checks"]])

    def test_lowercase_only_is_fine(self):
        os.makedirs(os.path.join(self.sys32(), "driverstore"))
        g = self.info()
        self.assertFalse(g["prefix_checks"]["driverstore_capital"])
        self.assertEqual(g["checks"], [])

    def test_hidden_wine_and_fullscreen(self):
        self.w.compat({WITCHER: "GE-Proton10-3"})
        self.w.proton("GE-Proton10-3", "tools", dll=SHIM_OLD, hook=True)
        self.dll("bin/libxell.dll", (1, 2, 1, 13))
        write(os.path.join(self.pfx, "user.reg"), '[Software\\\\Wine] 1\n"HideWineExports"="1"\n')
        c = os.path.join(self.pfx, "drive_c")
        write(os.path.join(c, "igdext_xefg.log"), "xefg: Interpolation is not supported in fullscreen mode\n")
        write(os.path.join(c, "igdext_xell.log"), "[XeLL] Using built-in context\n")
        g = self.info()
        self.assertEqual([x["id"] for x in g["checks"]], ["hides_wine", "fullscreen"])
        self.assertTrue(g["last_run"]["fg_fullscreen"])
        self.assertTrue(g["last_run"]["xell_builtin"])
        self.assertIn("This prefix hides Wine from the game (HideWineExports)", "\n".join(g["advice"]))
        self.assertIn("XESS=latest swaps in XeLL 1.3.2.10 while the game runs", "\n".join(g["advice"]))  # hook
        for x in g["checks"]:
            self.assertLessEqual(len(x["line"]), 80)


class SuggestTest(GameBase):
    """GameInfo.suggest: what the automatic launch options may add (DESIGN.md "Automatic launch options")."""

    def hooked(self):
        self.w.compat({WITCHER: "GE-Proton10-3"})
        self.w.proton("GE-Proton10-3", "tools", dll=SHIM_OLD, hook=True)

    def test_old_xess_asks_for_latest(self):
        self.hooked()
        self.dll("bin/libxess.dll", (1, 3, 1, 0))
        self.assertEqual(self.info()["suggest"], [
            {"key": "XESS", "value": "latest",
             "why": "XeSS 1.3.1.0 is older than 2.0.2.68, so it would run in the slower mode."}])

    def test_xell_12_gives_one_entry(self):
        self.hooked()
        self.dll("bin/libxess.dll", (2, 0, 2, 68))
        self.dll("bin/libxess_fg.dll", (1, 1, 0, 19))
        self.dll("bin/libxell.dll", (1, 2, 1, 13))
        sug = self.info()["suggest"]
        self.assertEqual([(s["key"], s["value"]) for s in sug], [("XESS", "latest")])
        self.assertIn("frame generation 1.1.0.19 is older than 1.2", sug[0]["why"])     # the first reason
        os.unlink(os.path.join(self.game, "bin/libxess_fg.dll"))
        self.assertIn("XeLL 1.2.1.13 may refuse this GPU", self.info()["suggest"][0]["why"])

    def test_current_xess_needs_nothing(self):
        self.hooked()
        self.dll("bin/libxess.dll", (2, 0, 2, 68))
        self.dll("bin/libxell.dll", (1, 3, 2, 10))
        self.assertEqual(self.info()["suggest"], [])

    def test_fsr_only_needs_20261104(self):
        self.hooked()
        self.dll("Game/amd_fidelityfx_dx12.dll", (1, 0, 0, 0))
        self.assertEqual(self.info()["suggest"], [])                    # the package is 20261031
        write(os.path.join(self.pkg, "tools", "fsr-fg.sh"), "#!/bin/sh\n")
        self.assertEqual(self.info()["suggest"], [
            {"key": "FSR", "value": "xess", "why": "The game has FSR 3.1+ and no XeSS: its FSR runs on XeSS."}])

    def test_not_installed_or_no_hook(self):
        self.w.compat({WITCHER: "proton-cachyos-slr"})
        self.w.proton("proton-cachyos-slr", "system", dll=STOCK)     # a system Proton without the hook
        self.dll("bin/libxess.dll", (1, 3, 1, 0))
        g = self.info()
        self.assertIs(g["compat_tool_hook"], False)
        self.assertEqual(g["suggest"], [])
        self.hooked()
        self.assertEqual(len(self.info()["suggest"]), 1)
        os.unlink(os.path.join(self.ctx.home, xess.ENV_FILE))
        self.assertEqual(self.info()["suggest"], [])


if __name__ == "__main__":
    unittest.main()


class FrameGenerationRefusedTest(GameBase):
    """The owner's Witcher 3 log (GE-Proton11-11): XeLL latency reduction off, so every frame is refused."""
    W3_LOG = "XeFG[3] Latency reduction is not enabled.\nxefgSwapChainSetEnabled(1) -> -15\n"

    def xefg(self, text):
        p = os.path.join(self.pfx, "drive_c", "igdext_xefg.log")
        write(p, text)
        return p

    def test_latency_reduction_off(self):
        self.xefg("XeFG[2] xefgSwapChainD3D12CreateContext -> 0\n" + self.W3_LOG * 2000)
        g = self.info()
        xf = g["last_run"]["xefg"]
        self.assertEqual((xf["refused"], xf["reason"], xf["code"], xf["call"]),
                         (True, "latency_reduction_off", -15, "xefgSwapChainSetEnabled"))
        self.assertEqual(xf["lines"], ["XeFG[3] Latency reduction is not enabled.",
                                       "xefgSwapChainSetEnabled(1) -> -15"])
        self.assertIsInstance(xf["logged_at"], float)
        row = next(c for c in g["checks"] if c["id"] == "fg_refused")
        self.assertEqual(row["label"] + ": " + row["line"][0].lower() + row["line"][1:],
                         "Frame generation is refused: turn on Xe Low Latency in the game's graphics menu.")
        self.assertLessEqual(len(row["line"]), 80)
        self.assertIn("XESS_LOG=1", row["detail"])
        self.assertIn("IGDEXT_XEFG_LOG=1", row["detail"])
        self.assertIn('"xefgSwapChainSetEnabled(1) -> -15"', row["detail"])
        self.assertEqual(row["at"], xf["logged_at"])
        self.assertEqual(row["lines"], xf["lines"])

    def test_other_errors_are_a_generic_refusal(self):
        self.xefg("xefgSwapChainSetEnabled(1) -> -3\n")
        xf = self.info()["last_run"]["xefg"]
        self.assertEqual((xf["reason"], xf["code"]), ("refused", -3))
        # -15 without the latency line is not called latency
        self.xefg("xefgSwapChainSetEnabled(1) -> -15\n")
        self.assertEqual(self.info()["last_run"]["xefg"]["reason"], "refused")
        # no SetEnabled at all: the last xefg call that failed
        self.xefg("xefgSwapChainD3D12InitFromSwapChain(0x7f, 0x1) -> -7\n")
        g = self.info()
        xf = g["last_run"]["xefg"]
        self.assertEqual((xf["reason"], xf["code"], xf["call"]), ("refused", -7, "xefgSwapChainD3D12InitFromSwapChain"))
        row = next(c for c in g["checks"] if c["id"] == "fg_refused")
        self.assertEqual(row["line"], "XeSS frame generation refused to start (code -7).")

    def test_no_refusal_or_no_log(self):
        self.assertIsNone(self.info()["last_run"]["xefg"])          # no log: the frontend says how to turn it on
        self.xefg(self.W3_LOG + "xefgSwapChainSetEnabled(1) -> 0\n")   # turned on later: fine now
        g = self.info()
        self.assertEqual(g["last_run"]["xefg"]["refused"], False)
        self.assertNotIn("fg_refused", [c["id"] for c in g["checks"]])
        self.xefg("XeFG[2] all good\n")
        self.assertEqual(self.info()["last_run"]["xefg"]["refused"], False)

    def test_bounded_read_and_safe_open(self):
        # only the tail is read: an old refusal far before the last XEFG_TAIL bytes is not seen
        self.xefg(self.W3_LOG + ("x" * 80 + "\n") * (games.XEFG_TAIL // 81 + 10) + "XeFG[2] ok\n")
        self.assertEqual(self.info()["last_run"]["xefg"]["refused"], False)
        with mock.patch.object(games.os, "read", wraps=os.read) as rd:
            p = self.xefg(self.W3_LOG * 100000)
            self.assertTrue(games.xefg_check(p)["refused"])
            self.assertLessEqual(sum(c.args[1] for c in rd.call_args_list), games.XEFG_TAIL)
        # a link (the backend reads as root) and a folder are not read
        link = os.path.join(self.tmp.name, "link.log")
        os.symlink(p, link)
        self.assertIsNone(games.xefg_check(link))
        self.assertIsNone(games.xefg_check(self.tmp.name))
