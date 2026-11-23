"""updates.py: the daily update checks (ROADMAP T1-9 + C-5). No network: the steps are fakes and the plugin's own
release check goes through a patched downloads.newest_release_tag."""
import os
import tempfile
import unittest
from unittest import mock

from oxp3deck import context, downloads, updates
from tests import stub_decky

ROUTE_HEAD = "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n"
ROUTE_DEFAULT = "wlan0\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0\n"
ROUTE_LAN = "wlan0\t0002A8C0\t00000000\t0001\t0\t0\t600\t00FFFFFF\t0\t0\t0\n"
V6_DEFAULT = " ".join(["0" * 32, "00", "0" * 32, "00", "fe800000000000000000000000000001", "00000400",
                       "00000001", "00000000", "00450003", "wlan0"]) + "\n"
V6_LO = " ".join(["0" * 32, "00", "0" * 32, "00", "0" * 32, "ffffffff", "00000001", "00000000", "00200200",
                  "lo"]) + "\n"
NOW = 1_800_000_000.0


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.ctx = stub_decky.make_ctx(tmp.name)
        self.settings = context.Settings(os.path.join(self.ctx.settings_dir, "settings.json"))
        self.route(ROUTE_HEAD + ROUTE_DEFAULT)
        self.calls = []

    def route(self, v4, v6=""):
        d = self.ctx.sys_path("/proc/net")
        os.makedirs(d, exist_ok=True)
        for name, text in (("route", v4), ("ipv6_route", v6)):
            path = os.path.join(d, name)
            if text is None:
                if os.path.exists(path):
                    os.remove(path)
                continue
            with open(path, "w") as f:
                f.write(text)

    def steps(self, **answers):
        def step(name):
            def fn():
                self.calls.append(name)
                a = answers.get(name, {"ok": True, "error": None})
                if isinstance(a, Exception):
                    raise a
                return a
            return fn
        return {n: step(n) for n in ("oxp3", "xess", "plugin")}

    def tick(self, now=NOW, busy=None, game=None, **answers):
        return updates.tick(self.ctx, self.settings, busy=busy, game=game, steps=self.steps(**answers), now=now)


class OnlineTest(Base):
    def test_default_route(self):
        self.assertTrue(updates.online(self.ctx))
        self.route(ROUTE_HEAD + ROUTE_LAN)
        self.assertFalse(updates.online(self.ctx))
        self.route(ROUTE_HEAD + ROUTE_LAN, V6_LO)
        self.assertFalse(updates.online(self.ctx))       # the kernel's unreachable ::/0 on lo
        self.route(ROUTE_HEAD, V6_DEFAULT)
        self.assertTrue(updates.online(self.ctx))
        self.route(None, None)
        self.assertFalse(updates.online(self.ctx))
        self.route(ROUTE_HEAD + "wlan0\t00000000\t0102A8C0\t0002\t0\t0\t600\t00000000\t0\t0\t0\n")   # not up
        self.assertFalse(updates.online(self.ctx))


class TickTest(Base):
    def test_first_check_fills_every_step(self):
        a = {"ok": True, "error": None, "installed": "0.4.2", "bundled": "0.4.3", "update": "bundled"}
        self.assertEqual(self.tick(oxp3=a), "checked")
        self.assertEqual(self.calls, ["oxp3", "xess", "plugin"])
        rec = self.settings.get(updates.AUTO_KEY)
        self.assertEqual(rec["checked_at"], NOW)
        self.assertEqual(rec["tried_at"], NOW)
        self.assertEqual(rec["oxp3"], {**a, "checked_at": NOW})

    def test_once_a_day(self):
        self.tick()
        self.calls.clear()
        self.assertEqual(self.tick(now=NOW + updates.DAY_S - 1), "not due")
        self.assertEqual(self.calls, [])
        self.assertEqual(self.tick(now=NOW + updates.DAY_S), "checked")
        self.assertEqual(len(self.calls), 3)
        self.assertEqual(self.tick(now=NOW - 10 * updates.DAY_S), "checked")   # the clock went back

    def test_skips(self):
        self.assertEqual(self.tick(game="1091500"), "game")
        self.assertEqual(self.tick(busy="Apply buttons"), "busy")
        self.route(ROUTE_HEAD + ROUTE_LAN)
        self.assertEqual(self.tick(), "offline")
        self.assertEqual(self.calls, [])
        self.assertIsNone(self.settings.get(updates.AUTO_KEY))   # nothing tried: the next look tries again
        self.route(ROUTE_HEAD + ROUTE_DEFAULT)
        self.settings.set(updates.SWITCH_KEY, False)
        self.assertEqual(self.tick(), "off")
        self.settings.set(updates.SWITCH_KEY, True)
        self.assertEqual(self.tick(), "checked")

    def test_a_failure_is_silent_keeps_the_last_answer_and_retries_in_an_hour(self):
        old = {"ok": True, "error": None, "latest": "20261104", "update_available": True}
        self.tick(xess=old)
        with self.assertLogs("oxp3deck", "INFO") as logs:
            did = self.tick(now=NOW + updates.DAY_S, xess={"ok": False, "error": "HTTP 403"},
                            plugin=RuntimeError("boom"))
        self.assertEqual(did, "failed")
        self.assertTrue(any("HTTP 403" in m for m in logs.output))
        self.assertTrue(any("boom" in m for m in logs.output))
        rec = self.settings.get(updates.AUTO_KEY)
        self.assertEqual(rec["xess"], {**old, "checked_at": NOW})        # the old answer stays
        self.assertEqual(rec["checked_at"], NOW)
        self.assertEqual(rec["oxp3"]["checked_at"], NOW + updates.DAY_S)  # the step that worked is new
        self.calls.clear()
        self.assertEqual(self.tick(now=NOW + updates.DAY_S + updates.RETRY_S - 1), "not due")
        self.assertEqual(self.tick(now=NOW + updates.DAY_S + updates.RETRY_S), "checked")

    def test_a_damaged_record_is_no_record(self):
        self.settings.set(updates.AUTO_KEY, ["junk"])
        self.assertEqual(self.tick(), "checked")
        self.settings.set(updates.AUTO_KEY, {"checked_at": "yesterday", "tried_at": True})
        self.assertEqual(self.tick(), "checked")


class PluginCheckTest(Base):
    def test_newer_and_not(self):
        with mock.patch.object(downloads, "newest_release_tag", return_value="v0.6.0-rc.1") as nrt:
            self.assertEqual(updates.plugin_check("0.5.0"), {"ok": True, "error": None, "current": "0.5.0",
                                                             "latest": "0.6.0-rc.1", "update": True})
            nrt.assert_called_with("Featherwolf/OXP3Deck")
            self.assertFalse(updates.plugin_check("0.6.0")["update"])
            self.assertFalse(updates.plugin_check("")["update"])
        with mock.patch.object(downloads, "newest_release_tag", side_effect=downloads.DownloadError("HTTP 403")):
            r = updates.plugin_check("0.5.0")
        self.assertFalse(r["ok"])
        self.assertIn("HTTP 403", r["error"])

    def test_install_url(self):
        self.assertEqual(updates.INSTALL_URL,
                         "https://raw.githubusercontent.com/Featherwolf/OXP3Deck/HEAD/release/OXP3Deck.zip")


class StateTest(Base):
    def test_nothing_yet(self):
        self.assertEqual(updates.state(self.settings, "0.5.0"),
                         {"on": True, "checked_at": None, "install_url": updates.INSTALL_URL, "oxp3": None,
                          "xess": None, "plugin": None})

    def test_after_a_check_and_an_update_of_the_plugin(self):
        self.tick(plugin={"ok": True, "error": None, "current": "0.5.0", "latest": "0.6.0", "update": True})
        s = updates.state(self.settings, "0.5.0")
        self.assertEqual(s["plugin"], {"current": "0.5.0", "latest": "0.6.0", "checked_at": NOW, "update": True})
        self.assertEqual(s["checked_at"], NOW)
        self.assertEqual(s["oxp3"], {"ok": True, "error": None, "checked_at": NOW})
        self.assertFalse(updates.state(self.settings, "0.6.0")["plugin"]["update"])   # installed since
        self.settings.set(updates.SWITCH_KEY, False)
        self.assertFalse(updates.state(self.settings, "0.5.0")["on"])


if __name__ == "__main__":
    unittest.main()
