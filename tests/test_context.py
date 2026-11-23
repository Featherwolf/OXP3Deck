import json
import os
import pwd
import stat
import tempfile
import threading
import time
import unittest
from unittest import mock

from oxp3deck import context
from oxp3deck.context import Ctx, Settings
from tests import stub_decky


class SysPathTest(unittest.TestCase):
    def ctx(self, root):
        return Ctx("jordan", 1000, 1000, "/home/jordan", "/s", "/r", "/l", "/p", root)

    def test_real_root_unchanged(self):
        self.assertEqual(self.ctx("/").sys_path("/sys/class/dmi/id/product_name"), "/sys/class/dmi/id/product_name")

    def test_fake_root(self):
        c = self.ctx("/tmp/fake/")
        self.assertEqual(c.sys_path("/etc/os-release"), "/tmp/fake/etc/os-release")
        self.assertEqual(c.sys_path("/run/oxp3-tool.lock"), "/tmp/fake/run/oxp3-tool.lock")

    def test_home_and_rerooted_paths_unchanged(self):
        c = self.ctx("/tmp/fake")
        self.assertEqual(c.sys_path("/home/jordan/.config/x"), "/home/jordan/.config/x")
        self.assertEqual(c.sys_path("/tmp/fake/etc/x"), "/tmp/fake/etc/x")
        self.assertEqual(c.sys_path("/home/jordanx"), "/tmp/fake/home/jordanx")


class FromDeckyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(stub_decky.uninstall)

    def test_from_stub(self):
        mod = stub_decky.install(self.tmp.name)
        c = context.from_decky()
        me = pwd.getpwuid(os.getuid())
        self.assertEqual((c.user, c.uid, c.gid), (me.pw_name, me.pw_uid, me.pw_gid))   # owner of the home
        self.assertEqual(c.home, os.path.realpath(mod.DECKY_USER_HOME))
        self.assertEqual(c.settings_dir, os.path.realpath(mod.DECKY_PLUGIN_SETTINGS_DIR))
        self.assertEqual(c.runtime_dir, os.path.realpath(mod.DECKY_PLUGIN_RUNTIME_DIR))
        self.assertEqual(c.log_dir, os.path.realpath(mod.DECKY_PLUGIN_LOG_DIR))
        self.assertEqual(c.plugin_dir, os.path.realpath(mod.DECKY_PLUGIN_DIR))
        self.assertEqual(c.root, "/")

    def test_linked_home_like_bazzite(self):
        real = os.path.realpath(self.tmp.name)
        os.makedirs(os.path.join(real, "var", "home"))
        os.symlink("var/home", os.path.join(real, "home"))      # /home -> var/home
        mod = stub_decky.install(real)                           # creates home/jordan through the link
        c = context.from_decky()
        self.assertEqual(c.home, os.path.join(real, "var", "home", "jordan"))
        self.assertEqual(c.settings_dir, os.path.join(c.home, "homebrew", "settings", "OXP3Deck"))
        self.assertTrue(mod.DECKY_USER_HOME.startswith(os.path.join(real, "home")))

    def test_missing_home(self):
        mod = stub_decky.install(self.tmp.name)
        mod.DECKY_USER_HOME = os.path.join(self.tmp.name, "nobody")
        with self.assertRaises(RuntimeError):
            context.from_decky()


class SettingsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "settings.json")

    def test_roundtrip_and_persistence(self):
        s = Settings(self.path)
        self.assertIsNone(s.get("x"))
        self.assertEqual(s.get("x", 5), 5)
        self.assertIsNone(s.set("driver", "26.3"))
        self.assertIsNone(s.update({"a": [1, 2], "b": {"c": True}}))
        self.assertEqual(Settings(self.path).all(), {"driver": "26.3", "a": [1, 2], "b": {"c": True}})
        with open(self.path) as f:
            self.assertEqual(json.load(f)["driver"], "26.3")
        self.assertEqual(os.listdir(self.tmp.name), ["settings.json"])      # no temp files left

    def test_values_are_copies(self):
        s = Settings(self.path)
        v = {"k": [1]}
        s.set("v", v)
        v["k"].append(2)
        s.get("v")["k"].append(3)
        self.assertEqual(s.get("v"), {"k": [1]})

    def test_not_json(self):
        s = Settings(self.path)
        s.set("ok", 1)
        err = s.set("bad", {1, 2})
        self.assertIn("not JSON", err)
        self.assertEqual(s.all(), {"ok": 1})

    def test_corrupt_or_odd_file_starts_empty(self):
        for content in ("{not json", "[1, 2]", "", "\xff\xfe"):
            with open(self.path, "w", encoding="latin-1") as f:
                f.write(content)
            with self.assertLogs("oxp3deck", "WARNING"):
                self.assertEqual(Settings(self.path).all(), {})
            self.assertFalse(os.path.exists(self.path))      # set aside, not overwritten by the next save
        self.addCleanup(context.dismiss_reset, self.path)

    def test_a_damaged_file_is_set_aside_and_reported(self):
        self.addCleanup(context.dismiss_reset, self.path)
        stamps = iter(range(10))
        with mock.patch.object(context, "_now", lambda: 1_800_000_000 + 60 * next(stamps)):
            for n in range(5):
                with open(self.path, "w") as f:
                    f.write(f"{{damaged {n}")
                with self.assertLogs("oxp3deck", "WARNING"):
                    s = Settings(self.path)
        names = sorted(n for n in os.listdir(self.tmp.name) if n.startswith("settings.json.corrupt-"))
        self.assertEqual(len(names), context.KEEP_COPIES)            # the oldest went
        with open(os.path.join(self.tmp.name, names[-1])) as f:
            self.assertEqual(f.read(), "{damaged 4")                # the newest is kept as it was
        with open(os.path.join(self.tmp.name, names[0])) as f:
            self.assertEqual(f.read(), "{damaged 2")
        self.assertEqual(context.reset_problems(self.tmp.name),
                         [{"file": "settings.json", "kind": "reset", "copy": names[-1]}])
        self.assertIsNone(s.set("a", 1))                             # it started empty and saves again
        self.assertEqual(Settings(self.path).all(), {"a": 1})
        self.assertTrue(context.dismiss_reset(self.path))
        self.assertEqual(context.reset_problems(self.tmp.name), [])

    def test_copies_within_one_second_get_a_number(self):
        with mock.patch.object(context, "_now", lambda: 1_800_000_000):
            for n in range(12):
                with open(self.path, "w") as f:
                    f.write(str(n))
                self.assertIsNotNone(context.quarantine(self.path))
        names = context.copies(self.path)
        self.assertEqual(len(names), 3)
        got = []
        for n in names:
            with open(os.path.join(self.tmp.name, n)) as f:
                got.append(f.read())
        self.assertEqual(got, ["9", "10", "11"])                    # the newest three, oldest first

    def test_copies_stay_in_order_when_the_clock_goes_back(self):
        stamps = iter([1_800_003_600 + 60 * n for n in range(3)] + [1_800_000_000])   # then an hour back
        with mock.patch.object(context, "_now", lambda: next(stamps)):
            for n in range(4):
                with open(self.path, "w") as f:
                    f.write(str(n))
                with self.assertLogs("oxp3deck", "WARNING"):
                    new = context.quarantine(self.path)
                self.assertTrue(os.path.exists(os.path.join(self.tmp.name, new)))   # the copy just made stays
        names = context.copies(self.path)
        self.assertEqual(names[-1], new)                            # and is the newest
        got = []
        for n in names:
            with open(os.path.join(self.tmp.name, n)) as f:
                got.append(f.read())
        self.assertEqual(got, ["1", "2", "3"])

    def test_a_read_error_is_not_damage(self):
        self.addCleanup(context.dismiss_reset, self.path)
        with open(self.path, "w") as f:
            json.dump({"keep": 1}, f)
        real = context._read_regular

        def fail(*a, **k):
            raise OSError(24, "Too many open files")
        with mock.patch.object(context, "_read_regular", fail):
            with self.assertLogs("oxp3deck", "WARNING"):
                s = Settings(self.path)
            self.assertIn("cannot read", s.set("a", 1))             # never written over the unread file
        self.assertEqual(context.copies(self.path), [])             # not set aside
        self.assertEqual(context.reset_problems(self.tmp.name), [])
        with open(self.path) as f:
            self.assertEqual(json.load(f), {"keep": 1})
        self.assertIs(context._read_regular, real)
        self.assertIsNone(s.set("b", 2))                            # it reads now: the file's values and ours
        self.assertEqual(Settings(self.path).all(), {"keep": 1, "a": 1, "b": 2})

    def test_fifo_does_not_hang(self):
        os.mkfifo(self.path)
        t = time.monotonic()
        self.assertEqual(Settings(self.path).all(), {})
        self.assertLess(time.monotonic() - t, 2)

    def test_link_at_path_is_replaced_not_followed(self):
        outside = os.path.join(self.tmp.name, "outside")
        with open(outside, "w") as f:
            f.write("keep")
        os.symlink(outside, self.path)
        s = Settings(self.path)
        self.assertEqual(s.all(), {})          # links are not read either
        self.assertIsNone(s.set("a", 1))
        self.assertFalse(os.path.islink(self.path))
        with open(outside) as f:
            self.assertEqual(f.read(), "keep")

    def test_linked_folder_refused(self):
        real = os.path.join(self.tmp.name, "real")
        os.mkdir(real)
        os.symlink(real, os.path.join(self.tmp.name, "link"))
        s = Settings(os.path.join(self.tmp.name, "link", "settings.json"))
        with self.assertLogs("oxp3deck", "WARNING"):
            err = s.set("a", 1)
        self.assertIn("cannot write", err)
        self.assertEqual(s.get("a"), 1)        # kept in memory
        self.assertEqual(os.listdir(real), [])

    def test_user_owned_link_above_the_folder_refused(self):
        # Decky gives ~/homebrew/settings/<dir> to the user: a link planted above it must not redirect root
        target = os.path.join(self.tmp.name, "etc")
        os.makedirs(os.path.join(target, "OXP3Deck"))
        link = os.path.join(self.tmp.name, "settings")
        os.symlink(target, link)
        if os.geteuid() == 0:
            os.lchown(link, 1000, 1000)     # as the user would have made it
        s = Settings(os.path.join(link, "OXP3Deck", "settings.json"))
        with self.assertLogs("oxp3deck", "WARNING"):
            self.assertIn("cannot write", s.set("a", 1))
        self.assertEqual(os.listdir(os.path.join(target, "OXP3Deck")), [])

    def test_threads(self):
        s = Settings(self.path)

        def worker(n):
            for i in range(20):
                s.set(f"k{n}", i)

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(Settings(self.path).all(), {f"k{n}": 19 for n in range(5)})


class GuardedTest(unittest.TestCase):
    """load_guarded / guard_save / start_fresh: auto.json and optiscaler.json (ROADMAP T1-5)."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "auto.json")

    def put(self, text):
        with open(self.path, "w") as f:
            f.write(text)

    def test_missing_file_is_fine(self):
        self.assertEqual(context.load_guarded(self.path, 1, 1000), (None, None))
        context.guard_save(self.path, None)

    def test_damaged_stays_a_problem_until_start_fresh(self):
        self.put('{"version": 1, "games": {')
        with self.assertLogs("oxp3deck", "WARNING"):
            data, problem = context.load_guarded(self.path, 1, 1000)
        self.assertIsNone(data)
        self.assertEqual(problem["kind"], "damaged")
        self.assertTrue(problem["copy"].startswith("auto.json.corrupt-"))
        self.assertFalse(os.path.exists(self.path))
        # the next load (also after a restart) still refuses: the file is gone but its damaged copy is there
        data, again = context.load_guarded(self.path, 1, 1000)
        self.assertEqual((data, again["kind"], again["copy"]), (None, "damaged", problem["copy"]))
        with self.assertRaises(context.Refused) as e:
            context.guard_save(self.path, again)
        self.assertIn("Start fresh", str(e.exception))
        context.start_fresh(self.path, b'{"version": 1}\n')
        self.assertEqual(context.load_guarded(self.path, 1, 1000), ({"version": 1}, None))
        self.assertEqual(len(context.copies(self.path)), 1)              # the damaged copy stays

    def test_too_big_or_not_a_file_counts_as_damaged(self):
        self.put("{}" + " " * 2000)
        self.assertEqual(context.load_guarded(self.path, 1, 1000)[1]["kind"], "damaged")
        os.mkfifo(self.path)
        self.assertEqual(context.load_guarded(self.path, 1, 1000)[1]["kind"], "damaged")
        self.assertFalse(os.path.exists(self.path))

    def test_a_read_error_raises_and_leaves_the_file(self):
        self.put('{"version": 1, "games": {}}')

        def fail(*a, **k):
            raise OSError(5, "Input/output error")
        with mock.patch.object(context, "_read_regular", fail):
            with self.assertRaises(OSError):
                context.load_guarded(self.path, 1, 1000)
        self.assertEqual(context.copies(self.path), [])
        self.assertEqual(context.load_guarded(self.path, 1, 1000), ({"version": 1, "games": {}}, None))

    def test_a_symlink_still_counts_as_damaged(self):
        os.symlink(os.path.join(self.tmp.name, "elsewhere"), self.path)
        with self.assertLogs("oxp3deck", "WARNING"):
            self.assertEqual(context.load_guarded(self.path, 1, 1000)[1]["kind"], "damaged")

    def test_newer_version_is_read_only(self):
        self.put('{"version": 2, "games": {"1": {}}, "future": true}')
        data, problem = context.load_guarded(self.path, 1, 1000)
        self.assertEqual(data["games"], {"1": {}})                       # still shown
        self.assertEqual(problem, {"kind": "newer", "version": 2})
        with self.assertRaises(context.Refused) as e:
            context.guard_save(self.path, problem)
        self.assertIn("newer OXP3 Deck", str(e.exception))
        self.assertEqual(context.load_guarded(self.path, 2, 1000)[1], None)   # the newer code reads it
        context.start_fresh(self.path, b'{"version": 1}\n')
        self.assertEqual(len(context.copies(self.path, "newer")), 1)
        self.assertEqual(context.copies(self.path), [])
        self.assertEqual(context.load_guarded(self.path, 1, 1000), ({"version": 1}, None))

    def test_start_fresh_never_overwrites_a_file_it_could_not_set_aside(self):
        self.put('{"version": 9}')
        with mock.patch.object(context, "quarantine", return_value=None):
            with self.assertRaises(context.Refused):
                context.start_fresh(self.path, b"{}\n")
        with open(self.path) as f:
            self.assertEqual(f.read(), '{"version": 9}')


class WriteAtomicTest(unittest.TestCase):
    def test_mode_and_content(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "f.json")
            context.write_atomic(p, b"1", 0o600)
            context.write_atomic(p, b"2", 0o640)
            with open(p, "rb") as f:
                self.assertEqual(f.read(), b"2")
            self.assertEqual(os.stat(p).st_mode & 0o777, 0o640)
            self.assertEqual(os.listdir(d), ["f.json"])

    def test_the_folder_is_synced_after_the_rename(self):
        """A power cut right after the save must not bring back the old file (or none): the folder is fsynced."""
        synced = []
        real = os.fsync

        def fsync(fd):
            synced.append(stat.S_ISDIR(os.fstat(fd).st_mode))
            return real(fd)

        with tempfile.TemporaryDirectory() as d, mock.patch.object(context.os, "fsync", fsync):
            context.write_atomic(os.path.join(d, "f.json"), b"1")
        self.assertEqual(synced, [False, True])                     # the file, then its folder

    def test_a_folder_that_cannot_be_synced_is_no_error(self):
        import errno
        real = os.fsync

        def fsync(fd):
            if stat.S_ISDIR(os.fstat(fd).st_mode):
                raise OSError(errno.EINVAL, "Invalid argument")
            return real(fd)

        with tempfile.TemporaryDirectory() as d, mock.patch.object(context.os, "fsync", fsync):
            context.write_atomic(os.path.join(d, "f.json"), b"1")
            with open(os.path.join(d, "f.json"), "rb") as f:
                self.assertEqual(f.read(), b"1")

    def test_read_small_limits(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "f")
            with open(p, "wb") as f:
                f.write(b"x" * 100)
            self.assertEqual(context.read_small(p), b"x" * 100)
            self.assertIsNone(context.read_small(p, 99))
            self.assertIsNone(context.read_small(d))
            self.assertIsNone(context.read_small(os.path.join(d, "missing")))


if __name__ == "__main__":
    unittest.main()
