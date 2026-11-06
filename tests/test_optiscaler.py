"""optiscaler.py against a fake home, a fake Steam library with The Witcher 3 and a fake OptiScaler package.

Nothing real runs: sysexec.run is replaced by FakeShell, which checks that every command runs as the user
(runuser -u jordan -- env -i ...), does mkdir, rm and mv itself and answers a canned `7z l -slt` listing and
unpack; downloads.download is a fake too. No 7z is needed."""
import hashlib
import json
import os
import shutil
import stat
import tempfile
import unittest
from unittest import mock

from oxp3deck import downloads, optiscaler, steamlib, sysexec, userexec
from tests.test_steamlib import ROOT, World, write

WITCHER = "292030"
BUILD = "v10-20261105"
OWN_XESS = b"the game's own libxess 1.3"

PACKAGE_INI = """; OptiScaler.ini (cut down)
[Upscalers]
Dx11Upscaler=auto
Dx12Upscaler=auto

[FrameGen]
Enabled=auto
FGInput=auto
FGOutput=auto

[XeFG]
InterpolationCount=auto
ForceBorderless=auto

[OptiFG]
HUDFix=auto

[Libraries]
OptiDllPath=auto

[Menu]
UseHQFont=auto
ShowFps=auto
Scale=auto

[Spoofing]
Dxgi=auto

[Plugins]
LoadAsiPlugins=auto
""".replace("\n", "\r\n")

# The v10 package's own layout: OptiScaler.dll and the ini at the top, the libraries in OptiScaler/.
PACKAGE = {
    "OptiScaler.dll": b"MZ optiscaler",
    "OptiScaler.ini": PACKAGE_INI.encode(),
    "setup_linux.sh": b"#!/bin/sh\n",
    "setup_windows.bat": b"@echo off\n",
    "!! EXTRACT ALL FILES TO GAME FOLDER !!": b"",
    "Licenses/XeSS_LICENSE.txt": b"Intel licence",
    "OptiScaler/libxess.dll": b"MZ xess 2.1",
    "OptiScaler/libxess_fg.dll": b"MZ xess fg 1.2",
    "OptiScaler/libxell.dll": b"MZ xell 1.3",
    "OptiScaler/D3D12_Optiscaler/D3D12Core.dll": b"MZ agility",
    "OptiScaler/Streamlined_fetcher_windows.bat": b"@echo off\n",
}


def listing_7z(tree, extra=()):
    """`7z l -slt -ba` text for {rel: bytes}; extra: more blocks as dicts."""
    dirs = sorted({"/".join(r.split("/")[:i]) for r in tree for i in range(1, r.count("/") + 1)})
    blocks = [{"Path": d, "Folder": "+", "Size": "0", "Attributes": "D"} for d in dirs]
    blocks += [{"Path": r, "Folder": "-", "Size": str(len(b)), "Attributes": "A"} for r, b in sorted(tree.items())]
    blocks += list(extra)
    return "\n".join("\n".join(f"{k} = {v}" for k, v in b.items()) + "\n" for b in blocks)


def own_tree(path, uid):
    if not ROOT:
        return
    os.chown(path, uid, uid, follow_symlinks=False)
    for top, dirs, files in os.walk(path):
        for n in dirs + files:
            os.chown(os.path.join(top, n), uid, uid, follow_symlinks=False)


def snapshot(path):
    """Every entry under path: kind, size, sha256, mtime and owner (folders: kind and owner)."""
    out = {}
    for top, dirs, files in os.walk(path):
        for n in dirs + files:
            p = os.path.join(top, n)
            st = os.lstat(p)
            rel = os.path.relpath(p, path)
            if stat.S_ISDIR(st.st_mode):
                out[rel + "/"] = ("dir", st.st_uid)
            elif stat.S_ISLNK(st.st_mode):
                out[rel] = ("link", os.readlink(p))
            else:
                with open(p, "rb") as f:
                    out[rel] = ("file", st.st_size, hashlib.sha256(f.read()).hexdigest(), st.st_mtime_ns,
                                st.st_uid)
    return out


class FakeShell:
    """sysexec.run as userexec.run calls it."""

    def __init__(self, uid):
        self.uid = uid
        self.calls = []
        self.listing = listing_7z(PACKAGE)
        self.tree = dict(PACKAGE)
        self.fail = {}

    def _made(self, path):
        if ROOT:
            os.chown(path, self.uid, self.uid, follow_symlinks=False)

    def __call__(self, argv, **kw):
        assert argv[1:4] == ["-u", "jordan", "--"], argv
        assert argv[4:6] == ["/usr/bin/env", "-i"], argv
        i = 6
        while "=" in argv[i]:
            i += 1
        cmd = argv[i:]
        self.calls.append(cmd)
        name = os.path.basename(cmd[0])
        if name in self.fail:
            return self.fail[name]
        if name == "mkdir":
            path = cmd[-1]
            todo = []
            p = path
            while not os.path.exists(p):
                todo.append(p)
                p = os.path.dirname(p)
            for p in reversed(todo):
                os.mkdir(p)
                self._made(p)
        elif name == "rm":
            p = cmd[-1]
            if os.path.isdir(p) and not os.path.islink(p):
                shutil.rmtree(p)
            elif os.path.lexists(p):
                os.unlink(p)
        elif name == "mv":
            os.rename(cmd[-2], cmd[-1])
        elif name == "7z" and cmd[1] == "l":
            return sysexec.Result(0, self.listing, "")
        elif name == "7z" and cmd[1] == "x":
            dest = next(a[2:] for a in cmd if a.startswith("-o"))
            for rel, data in self.tree.items():
                p = os.path.join(dest, rel)
                parts = rel.split("/")
                for k in range(1, len(parts)):
                    d = os.path.join(dest, *parts[:k])
                    if not os.path.isdir(d):
                        os.mkdir(d)
                        self._made(d)
                with open(p, "wb") as f:
                    f.write(data)
                self._made(p)
        else:
            return sysexec.Result(127, "", f"FakeShell: {name} not faked")
        return sysexec.Result(0, "", "")

    def names(self):
        return [os.path.basename(c[0]) + (" " + c[1] if c[0].endswith("7z") else "") for c in self.calls]


class FakeJob:
    def __init__(self):
        self.lines = []

    def say(self, line):
        self.lines.append(str(line))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.w = World(self.tmp.name)
        self.ctx = self.w.ctx
        self.w.make_steam()
        os.makedirs(self.w.sys("/proc"))
        self.game, _pfx = self.w.app(WITCHER, "The Witcher 3")
        write(os.path.join(self.game, "bin/x64/witcher3.exe"), b"MZ dx11")
        write(os.path.join(self.game, "bin/x64_dx12/witcher3.exe"), b"MZ dx12")
        write(os.path.join(self.game, "bin/x64_dx12/libxess.dll"), OWN_XESS)
        write(os.path.join(self.game, "bin/x64_dx12/libxell.dll"), b"MZ xell 1.2.1.13")
        own_tree(self.game, self.w.uid)
        self.folder = os.path.join(self.game, "bin/x64_dx12")
        self.shell = FakeShell(self.w.uid)
        p = mock.patch.object(sysexec, "run", self.shell)
        p.start()
        self.addCleanup(p.stop)
        self.downloads = []
        p = mock.patch.object(downloads, "download", self.fake_download)
        p.start()
        self.addCleanup(p.stop)
        self.tmp_parent = os.path.join(self.tmp.name, "tmp")
        os.mkdir(self.tmp_parent)
        p = mock.patch.object(optiscaler, "TMP_PARENT", self.tmp_parent)
        p.start()
        self.addCleanup(p.stop)
        write(self.w.sys("/usr/bin/7z"), "#!/bin/sh\n", 0o755)
        self.download_error = None
        self.job = FakeJob()

    def fake_download(self, url, dest, *, expected_sha256=None, max_bytes, on_progress=None):
        self.downloads.append((url, expected_sha256, max_bytes))
        if self.download_error:
            raise downloads.DownloadError(self.download_error)
        with open(dest, "wb") as f:
            f.write(b"7z archive")
        return expected_sha256

    def choices(self, **kw):
        c = {"upscaler": "xess", "fg": 2, "fg_input": "dlssg"}
        c.update(kw)
        return c

    def install(self, **kw):
        return optiscaler.install(self.ctx, None, self.job, WITCHER, self.choices(**kw))

    def remove(self):
        return optiscaler.remove(self.ctx, None, self.job, WITCHER)

    def record(self):
        with open(os.path.join(self.ctx.settings_dir, "optiscaler.json")) as f:
            return json.load(f)

    def read(self, rel):
        with open(os.path.join(self.folder, rel), "rb") as f:
            return f.read()

    def ini(self):
        return self.read("OptiScaler.ini").decode()


class ExeDirTest(Base):
    def test_dx12_folder_not_dx11(self):
        self.assertEqual(optiscaler.exe_dir(self.ctx, WITCHER), (self.folder, None))
        # whatever order the folder lists in
        real = os.listdir
        with mock.patch.object(os, "listdir", side_effect=lambda p: sorted(real(p), reverse=True)):
            self.assertEqual(optiscaler.exe_dir(self.ctx, WITCHER), (self.folder, None))

    def test_case_differences(self):
        os.rename(os.path.join(self.game, "bin"), os.path.join(self.game, "BIN"))
        os.rename(os.path.join(self.game, "BIN/x64_dx12"), os.path.join(self.game, "BIN/X64_DX12"))
        os.rename(os.path.join(self.game, "BIN/X64_DX12/witcher3.exe"),
                  os.path.join(self.game, "BIN/X64_DX12/Witcher3.EXE"))
        self.assertEqual(optiscaler.exe_dir(self.ctx, WITCHER), (os.path.join(self.game, "BIN/X64_DX12"), None))

    def test_a_link_in_the_path_is_refused(self):
        real = os.path.join(self.game, "bin/x64_dx12")
        os.rename(real, os.path.join(self.game, "elsewhere"))
        os.symlink("../elsewhere", real)
        folder, why = optiscaler.exe_dir(self.ctx, WITCHER)
        self.assertIsNone(folder)
        self.assertEqual(why, "Can't find witcher3.exe in bin/x64_dx12 of the game's folder.")

    def test_exe_missing(self):
        os.unlink(os.path.join(self.folder, "witcher3.exe"))
        self.assertEqual(optiscaler.exe_dir(self.ctx, WITCHER),
                         (None, "Can't find witcher3.exe in bin/x64_dx12 of the game's folder."))
        os.mkdir(os.path.join(self.folder, "witcher3.exe"))        # a folder by that name is not the exe
        self.assertIsNone(optiscaler.exe_dir(self.ctx, WITCHER)[0])

    def test_not_installed_and_not_in_the_table(self):
        self.assertEqual(optiscaler.exe_dir(self.ctx, "1091500"), (None, optiscaler.NO_SETUP))
        os.unlink(os.path.join(self.w.steam, "steamapps", f"appmanifest_{WITCHER}.acf"))
        self.assertEqual(optiscaler.exe_dir(self.ctx, WITCHER), (None, "The Witcher 3 is not installed."))


class RefusalTest(Base):
    def refused(self, why, appid=WITCHER):
        before = snapshot(self.tmp.name)
        res = optiscaler.install(self.ctx, None, self.job, appid, self.choices())
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], why)
        self.assertEqual(optiscaler.check(self.ctx, appid, installing=True)["why"], why)
        self.assertEqual(snapshot(self.tmp.name), before)          # nothing written anywhere
        self.assertEqual(self.shell.calls, [])
        self.assertEqual(self.downloads, [])

    def test_game_running(self):
        with mock.patch.object(steamlib, "running_game", return_value=WITCHER):
            self.refused("Quit The Witcher 3 first.")
            res = self.remove()
        self.assertEqual(res["error"], "Quit The Witcher 3 first.")

    def test_not_in_the_table(self):
        self.refused(optiscaler.NO_SETUP, "1091500")

    def test_exe_folder_missing(self):
        shutil.rmtree(self.folder)
        self.refused("Can't find witcher3.exe in bin/x64_dx12 of the game's folder.")

    def test_anticheat(self):
        for rel in ("EasyAntiCheat/x", "bin/BattlEye/x", "bin/x64/start_protected_game.exe", "Game_BE.exe",
                    "bin/EAAntiCheat.GameServiceLauncher.dll"):
            with self.subTest(rel=rel):
                p = write(os.path.join(self.game, rel), b"x")
                self.refused(optiscaler.ANTICHEAT)
                os.unlink(p)
                if os.path.basename(os.path.dirname(p)) in ("EasyAntiCheat", "BattlEye"):
                    os.rmdir(os.path.dirname(p))
        write(os.path.join(self.game, "a/b/c/d/EasyAntiCheat/x"), b"x")        # deeper than 3 levels: not looked at
        self.assertTrue(optiscaler.check(self.ctx, WITCHER, installing=True)["ok"])

    def test_flatpak_steam(self):
        shutil.rmtree(self.w.steam)
        os.makedirs(os.path.join(self.ctx.home, ".var/app/com.valvesoftware.Steam"))
        self.refused(optiscaler.FLATPAK)

    def test_another_optiscaler(self):
        for name in ("OptiScaler.ini", "optiscaler.log", "OptiScaler.dll", "nvngx.ini", "framegen_patch",
                     "dxgi.dll.b", "winmm.dll.b", ".clawdeck-optiscaler/manifest.json", "OptiScaler/x.dll",
                     ".oxp3deck-optiscaler/state.json"):
            with self.subTest(name=name):
                p = write(os.path.join(self.folder, name), b"x")
                self.refused(optiscaler.FOREIGN)
                self.assertEqual(optiscaler.info(self.ctx, WITCHER)["opti"]["state"], "other")
                os.unlink(p)
                if "/" in name:
                    os.rmdir(os.path.dirname(p))
        self.assertEqual(self.remove()["error"], "OXP3 Deck has not installed OptiScaler in The Witcher 3.")

    def test_a_dxgi_that_is_not_ours(self):
        write(os.path.join(self.folder, "DXGI.dll"), b"reshade")
        self.refused("The game folder already has a dxgi.dll (another mod). Remove it first.")

    def test_no_unpacker(self):
        os.unlink(self.w.sys("/usr/bin/7z"))
        write(self.w.sys("/etc/os-release"), "ID=cachyos\n")
        self.refused("Needs 7z or bsdtar: 7zip (sudo pacman -S 7zip) is not installed.")
        write(self.w.sys("/usr/bin/bsdtar"), "#!/bin/sh\n", 0o755)
        self.assertEqual(optiscaler.unpacker(self.ctx), ("bsdtar", "/usr/bin/bsdtar"))

    def test_the_game_moved_library(self):
        optiscaler._put_game(self.ctx, WITCHER, {"build": BUILD, "folder": "/old/lib/steamapps/common/x",
                                                 "files": []})
        self.refused("OptiScaler was installed in /old/lib/steamapps/common/x; remove it there first.")

    def test_bad_choices(self):
        for bad in ({"upscaler": "dlss", "fg": 2}, {"upscaler": "xess", "fg": 5}, {"upscaler": "xess", "fg": True},
                    {"upscaler": "xess", "fg": 2, "fg_input": "fsrfg"}, "xess", None):
            with self.subTest(bad=bad):
                res = optiscaler.install(self.ctx, None, self.job, WITCHER, bad)
                self.assertFalse(res["ok"])
                self.assertTrue(res["error"].startswith("OptiScaler: "), res["error"])
        self.assertEqual(self.shell.calls, [])


class FetchTest(Base):
    def fetch(self):
        return optiscaler.fetch(self.ctx, self.job, BUILD)

    def cache(self):
        return os.path.join(self.ctx.home, optiscaler.CACHE_REL)

    def assert_nothing_left(self):
        self.assertEqual(os.listdir(self.tmp_parent), [])
        self.assertFalse(optiscaler.package_ok(self.ctx, BUILD))
        if os.path.isdir(self.cache()):
            self.assertEqual(os.listdir(self.cache()), [])

    def test_download_list_unpack_as_the_user(self):
        res = self.fetch()
        self.assertTrue(res["ok"], res)
        b = optiscaler.BUILDS[BUILD]
        self.assertEqual(self.downloads, [(b["url"], b["sha256"], 96 << 20)])
        self.assertTrue(b["url"].startswith("https://github.com/optiscaler/OptiScaler-nightly/releases/download/"))
        self.assertEqual(self.shell.names(), ["7z l", "mkdir", "mkdir", "7z x", "mv"])
        lst = [c for c in self.shell.calls if c[0] == "/usr/bin/7z"]
        arc = lst[0][-1]
        self.assertEqual(lst[0], ["/usr/bin/7z", "l", "-slt", "-ba", arc])
        self.assertEqual(lst[1], ["/usr/bin/7z", "x", "-y", "-bd", "-o" + res["path"] + ".new", arc])
        self.assertTrue(arc.startswith(self.tmp_parent + "/"))
        self.assertTrue(optiscaler.package_ok(self.ctx, BUILD))
        self.assertEqual(os.listdir(self.tmp_parent), [])                       # the download folder is gone
        with open(os.path.join(res["path"], optiscaler.PACKAGE_LIST)) as f:
            lst = json.load(f)
        self.assertEqual(len(lst["files"]), len(PACKAGE))
        if ROOT:
            self.assertEqual(os.stat(os.path.join(res["path"], optiscaler.PACKAGE_LIST)).st_uid, self.w.uid)
        # a cached package is used again: no download
        self.shell.calls.clear()
        self.assertTrue(self.fetch()["ok"])
        self.assertEqual(len(self.downloads), 1)
        self.assertEqual(self.shell.calls, [])

    def test_a_package_changed_since_unpacking_is_fetched_again(self):
        path = self.fetch()["path"]
        with open(os.path.join(path, "OptiScaler.dll"), "ab") as f:
            f.write(b"more")
        self.assertFalse(optiscaler.package_ok(self.ctx, BUILD))
        self.assertTrue(self.fetch()["ok"])
        self.assertEqual(len(self.downloads), 2)
        # the list itself edited: not trusted (root keeps its sha256)
        lp = os.path.join(path, optiscaler.PACKAGE_LIST)
        with open(lp) as f:
            lst = json.load(f)
        lst["files"] = lst["files"][:1]
        with open(lp, "w") as f:
            json.dump(lst, f)
        self.assertFalse(optiscaler.package_ok(self.ctx, BUILD))

    def test_sha256_mismatch_and_size_cap(self):
        for err in ("download x.7z: sha256 is 00, expected e2", "download x.7z: more than the 100663296 bytes "
                                                                 "allowed"):
            with self.subTest(err=err):
                self.download_error = err
                res = self.fetch()
                self.assertEqual(res["error"], err)
                self.assert_nothing_left()
                self.assertEqual(self.shell.calls, [])

    def test_a_deleted_nightly(self):
        self.download_error = "download x.7z: HTTP 404 Not Found"
        self.assertEqual(self.fetch()["error"], optiscaler.GONE)

    def test_unsafe_listings_are_refused_before_unpacking(self):
        many = {f"OptiScaler/f{i}": b"" for i in range(2001)}
        cases = {
            "..": listing_7z(PACKAGE, [{"Path": "OptiScaler/../../evil.dll", "Folder": "-", "Size": "1",
                                        "Attributes": "A"}]),
            "absolute": listing_7z(PACKAGE, [{"Path": "/etc/evil", "Folder": "-", "Size": "1", "Attributes": "A"}]),
            "backslash": listing_7z(PACKAGE, [{"Path": "OptiScaler\\x.dll", "Folder": "-", "Size": "1",
                                               "Attributes": "A"}]),
            "link": listing_7z(PACKAGE, [{"Path": "OptiScaler/l", "Folder": "-", "Size": "4",
                                          "Attributes": "A_ lrwxrwxrwx", "Symbolic Link": "/etc"}]),
            "unix link": listing_7z(PACKAGE, [{"Path": "OptiScaler/l", "Folder": "-", "Size": "4",
                                               "Attributes": "A_ lrwxrwxrwx"}]),
            "device": listing_7z(PACKAGE, [{"Path": "OptiScaler/d", "Folder": "-", "Size": "0",
                                            "Attributes": "A_ crw-r--r--"}]),
            "too many": listing_7z({**PACKAGE, **many}),
            "too big": listing_7z(PACKAGE, [{"Path": "OptiScaler/big", "Folder": "-", "Size": str(401 << 20),
                                             "Attributes": "A"}]),
            "no dll": listing_7z({k: v for k, v in PACKAGE.items() if k != "OptiScaler.dll"}),
            "two dlls": listing_7z({**PACKAGE, "Other/OptiScaler.dll": b"x"}),
            "reserved": listing_7z({**PACKAGE, "OptiScaler/.oxp3deck-package.json": b"{}"}),
        }
        for why, text in cases.items():
            with self.subTest(why=why):
                self.shell.calls.clear()
                self.shell.listing = text
                res = self.fetch()
                self.assertFalse(res["ok"], why)
                self.assertNotIn("7z x", self.shell.names())
                self.assert_nothing_left()

    def test_a_top_folder(self):
        tree = {"OptiScaler_v10/" + k: v for k, v in PACKAGE.items()}
        self.shell.listing = listing_7z(tree)
        self.shell.tree = tree
        res = self.fetch()
        self.assertTrue(res["ok"], res)
        with open(os.path.join(res["path"], optiscaler.PACKAGE_LIST)) as f:
            lst = json.load(f)
        self.assertEqual(lst["root"], "OptiScaler_v10")
        self.assertIn("OptiScaler.dll", [f["rel"] for f in lst["files"]])
        self.assertTrue(self.install()["ok"])
        self.assertEqual(self.read("dxgi.dll"), PACKAGE["OptiScaler.dll"])
        # something outside the top folder is refused
        with self.assertRaisesRegex(optiscaler.OptiError, "outside the archive's top folder"):
            optiscaler.check_listing(optiscaler.parse_7z_listing(listing_7z({**tree, "stray.txt": b"x"})))

    def test_unpacked_tree_differs_from_the_listing(self):
        for change in ("extra", "size", "link"):
            with self.subTest(change=change):
                self.shell.calls.clear()
                tree = dict(PACKAGE)
                if change == "extra":
                    tree["OptiScaler/extra.dll"] = b"not listed"
                elif change == "size":
                    tree["OptiScaler/libxess.dll"] = b"longer than listed"
                self.shell.tree = tree
                if change == "link":
                    real = self.shell.__call__

                    def with_link(argv, real=real, **kw):
                        r = real(argv, **kw)
                        cmd = self.shell.calls[-1]
                        if cmd[0].endswith("7z") and cmd[1] == "x":
                            dest = next(a[2:] for a in cmd if a.startswith("-o"))
                            os.unlink(os.path.join(dest, "OptiScaler/libxell.dll"))
                            os.symlink("/etc/passwd", os.path.join(dest, "OptiScaler/libxell.dll"))
                        return r
                    with mock.patch.object(sysexec, "run", with_link):
                        res = self.fetch()
                else:
                    res = self.fetch()
                self.assertFalse(res["ok"], change)
                self.assert_nothing_left()

    def test_bsdtar_listing(self):
        text = ("drwxr-xr-x  0 0      0           0 Nov  5 12:00 OptiScaler/\n"
                "-rw-r--r--  0 0      0          13 Nov  5 12:00 OptiScaler.dll\n"
                "-rw-r--r--  0 0      0          13 Nov  5 12:00 !! EXTRACT ALL FILES TO GAME FOLDER !!\n"
                "lrwxr-xr-x  0 0      0           0 Nov  5 12:00 OptiScaler/l -> /etc\n"
                "hrw-r--r--  0 0      0           0 Nov  5 12:00 OptiScaler/h link to OptiScaler.dll\n")
        got = optiscaler.parse_bsdtar_listing(text)
        self.assertEqual([(e["name"], e["kind"], e["size"]) for e in got], [
            ("OptiScaler/", "dir", 0), ("OptiScaler.dll", "file", 13),
            ("!! EXTRACT ALL FILES TO GAME FOLDER !!", "file", 13), ("OptiScaler/l -> /etc", "link", 0),
            ("OptiScaler/h link to OptiScaler.dll", "link", 0)])
        self.assertEqual(optiscaler._list_argv("bsdtar", "/usr/bin/bsdtar", "/t/a.7z"),
                         ["/usr/bin/bsdtar", "-tvf", "/t/a.7z"])
        self.assertEqual(optiscaler._unpack_argv("bsdtar", "/usr/bin/bsdtar", "/t/a.7z", "/c/b.new"),
                         ["/usr/bin/bsdtar", "-xf", "/t/a.7z", "-C", "/c/b.new"])

    def test_7z_listing_skips_the_archive_block(self):
        text = "Path = /t/a.7z\nType = 7z\nPhysical Size = 10\n\n" + listing_7z({"OptiScaler.dll": b"x"})
        self.assertEqual(optiscaler.parse_7z_listing(text), [{"name": "OptiScaler.dll", "kind": "file", "size": 1}])


class InstallTest(Base):
    def test_round_trip_leaves_the_folder_exactly_as_before(self):
        before = snapshot(self.game)
        copies = []
        real_copy = userexec.copy_new

        def counting(*a, **kw):
            copies.append(a[2])
            return real_copy(*a, **kw)
        with mock.patch.object(userexec, "copy_new", counting), \
                mock.patch.object(userexec, "chown_tree", side_effect=AssertionError("no chown_tree")):
            res = self.install()
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["next"], "Start the game, pick DLSS and DLSS frame generation, then restart it once.")
        self.assertEqual(res["launch"], {"set": {"XESS_FG": "2"}, "remove": ["XESS", "FSR", "FSR_FG",
                                                                                 "force_vk_vendor"],
                                         "dll_override": "dxgi", "dxvk_config": None, "args": ["-dx12"]})
        names = sorted(os.listdir(self.folder))
        self.assertEqual(names, [".oxp3deck-optiscaler", "OptiScaler", "OptiScaler.ini", "dxgi.dll", "libxell.dll",
                                 "libxess.dll", "witcher3.exe"])
        self.assertEqual(sorted(os.listdir(os.path.join(self.folder, "OptiScaler"))),
                         ["D3D12_Optiscaler", "libxell.dll", "libxess.dll", "libxess_fg.dll"])   # no .bat
        self.assertEqual(self.read("dxgi.dll"), PACKAGE["OptiScaler.dll"])
        self.assertEqual(self.read("libxess.dll"), OWN_XESS)                    # the game's own: untouched
        self.assertEqual(sorted(copies), sorted(os.path.join(self.folder, r) for r in (
            "dxgi.dll", "OptiScaler/libxess.dll", "OptiScaler/libxess_fg.dll", "OptiScaler/libxell.dll",
            "OptiScaler/D3D12_Optiscaler/D3D12Core.dll")))
        self.assertFalse(os.path.exists(os.path.join(self.game, "bin/x64/dxgi.dll")))
        if ROOT:
            for rel, v in snapshot(self.folder).items():
                self.assertEqual(v[-1], self.w.uid, rel)                       # nothing of root's in the game
        with open(os.path.join(self.folder, ".oxp3deck-optiscaler/state.json")) as f:
            self.assertEqual(json.load(f), {"tool": "oxp3deck", "build": BUILD, "appid": WITCHER})
        rec = self.record()["games"][WITCHER]
        self.assertEqual((rec["folder"], rec["build"], rec["proxy"], rec["layout"], rec["partial"]),
                         (self.folder, BUILD, "dxgi", "subfolder", False))
        info = optiscaler.info(self.ctx, WITCHER)["opti"]
        self.assertEqual((info["state"], info["update"], info["cached"], info["choices"]),
                         ("installed", False, True, self.choices()))
        self.assertTrue(optiscaler.installed_for(self.ctx, WITCHER))
        # what OptiScaler writes while the game runs
        write(os.path.join(self.folder, "OptiScaler.log"), b"log")
        write(os.path.join(self.folder, "OptiScaler_dx12.log"), b"log")
        write(os.path.join(self.folder, "D3D12_Optiscaler/cache.bin"), b"cache")
        write(os.path.join(self.folder, "OptiScaler/menu.cache"), b"menu")
        own_tree(self.folder, self.w.uid)
        res = self.remove()
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["kept"], [])
        self.assertEqual(res["launch"]["set"], {"XESS_FG": "2"})                # for the frontend's undo
        self.assertEqual(snapshot(self.game), before)
        self.assertNotIn(WITCHER, self.record()["games"])
        self.assertFalse(optiscaler.installed_for(self.ctx, WITCHER))
        self.assertTrue(optiscaler.package_ok(self.ctx, BUILD))                 # the cache stays for next time

    def test_ini(self):
        self.assertTrue(self.install(fg=4)["ok"])
        text = self.ini()
        self.assertIn("\r\n", text)
        for line in ("Dx12Upscaler=xess", "Enabled=true", "FGInput=dlssg", "FGOutput=xefg", "InterpolationCount=3",
                     "ForceBorderless=true", "OptiDllPath=.\\OptiScaler", "Dxgi=false", "LoadAsiPlugins=false",
                     "UseHQFont=false", "ShowFps=false", "Dx11Upscaler=auto", "HUDFix=auto"):
            self.assertIn(line + "\r\n", text)
        rec = self.record()["games"][WITCHER]
        self.assertEqual(rec["launch"]["dxvk_config"], "dxgi.customVendorId = 8086")
        # a choice change rewrites only the ini (keys OptiScaler's menu saved are kept)
        with open(os.path.join(self.folder, "OptiScaler.ini"), "w") as f:
            f.write(text.replace("Scale=auto", "Scale=1.5"))
        res = optiscaler.set_choices(self.ctx, WITCHER, self.choices(upscaler="fsr31", fg=0))
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["launch_before"]["set"], {"XESS_FG": "4"})
        self.assertEqual(res["opti"]["launch"]["set"], {})
        self.assertIn("XESS_FG", res["opti"]["launch"]["remove"])
        text = self.ini()
        for line in ("Scale=1.5", "Dx12Upscaler=ffx", "Enabled=false", "FGOutput=nofg", "InterpolationCount=auto"):
            self.assertIn(line, text)
        self.assertEqual(self.record()["games"][WITCHER]["choices"], self.choices(upscaler="fsr31", fg=0))
        # the ini changed by the menu is still removed
        self.assertTrue(self.remove()["ok"])
        self.assertFalse(os.path.exists(os.path.join(self.folder, "OptiScaler.ini")))

    def test_overlay_option(self):
        self.assertTrue(self.install()["ok"])
        res = optiscaler.options(self.ctx, {"overlay": True})
        self.assertEqual((res["ok"], res["updated"]), (True, [WITCHER]))
        self.assertIn("ShowFps=true", self.ini())
        self.assertTrue(optiscaler.info(self.ctx, WITCHER)["opti"]["overlay"])
        with mock.patch.object(steamlib, "running_game", return_value=WITCHER):
            res = optiscaler.options(self.ctx, {"overlay": False})
        self.assertEqual(res["not_while_running"], [WITCHER])
        self.assertIn("ShowFps=true", self.ini())
        self.assertFalse(optiscaler.options(self.ctx, {"overlay": "yes"})["ok"])

    def test_a_changed_dll_is_kept_and_reported(self):
        self.assertTrue(self.install()["ok"])
        write(os.path.join(self.folder, "dxgi.dll"), b"changed by hand")
        own_tree(self.folder, self.w.uid)
        res = self.remove()
        self.assertTrue(res["ok"])
        self.assertEqual(res["kept"], ["dxgi.dll (changed since install)"])
        self.assertEqual(self.read("dxgi.dll"), b"changed by hand")
        rec = self.record()["games"][WITCHER]
        self.assertTrue(rec["partial"])
        self.assertEqual([f["rel"] for f in rec["files"]], ["dxgi.dll"])
        info = optiscaler.info(self.ctx, WITCHER)["opti"]
        self.assertEqual((info["state"], info["update"], info["kept"]), ("partial", True, res["kept"]))
        self.assertIn("partly removed", optiscaler.check(self.ctx, WITCHER, installing=True)["why"])
        # put back as it was: the next Remove finishes
        write(os.path.join(self.folder, "dxgi.dll"), PACKAGE["OptiScaler.dll"])
        res = self.remove()
        self.assertEqual(res["kept"], [])
        self.assertNotIn(WITCHER, self.record()["games"])

    def test_root_unlinks_only_the_users_files(self):
        if not ROOT:
            self.skipTest("ownership needs root")
        self.assertTrue(self.install()["ok"])
        os.chown(os.path.join(self.folder, "dxgi.dll"), 0, 0)
        res = self.remove()
        self.assertEqual(res["kept"], ["dxgi.dll (changed since install)"])

    def test_a_failure_halfway_rolls_back(self):
        before = snapshot(self.game)
        real_copy = userexec.copy_new
        n = [0]

        def third_fails(*a, **kw):
            n[0] += 1
            if n[0] == 3:
                raise OSError(28, "No space left on device")
            return real_copy(*a, **kw)
        with mock.patch.object(userexec, "copy_new", third_fails):
            res = self.install()
        self.assertFalse(res["ok"])
        self.assertIn("No space left on device", res["error"])
        self.assertIn("what was put in so far was taken out again", res["error"])
        self.assertEqual(snapshot(self.game), before)
        self.assertNotIn(WITCHER, self.record()["games"])

    def test_a_cache_file_changed_since_unpacking_fails_the_install(self):
        path = optiscaler.fetch(self.ctx, self.job, BUILD)["path"]
        before = snapshot(self.game)
        with open(os.path.join(path, "OptiScaler/libxess.dll"), "r+b") as f:
            f.write(b"XX")                                    # same size, other bytes
        res = self.install()
        self.assertFalse(res["ok"])
        self.assertIn("sha256", res["error"])
        self.assertEqual(snapshot(self.game), before)

    def test_update(self):
        self.assertTrue(self.install(upscaler="fsr31", fg=3)["ok"])
        rec = self.record()
        rec["games"][WITCHER]["build"] = "v9-old"
        with open(os.path.join(self.ctx.settings_dir, "optiscaler.json"), "w") as f:
            json.dump(rec, f)
        info = optiscaler.info(self.ctx, WITCHER)["opti"]
        self.assertEqual((info["update"], info["build"], info["build_wanted"]), (True, "v9-old", BUILD))
        res = optiscaler.update(self.ctx, None, self.job, WITCHER)
        self.assertTrue(res["ok"], res)
        g = self.record()["games"][WITCHER]
        self.assertEqual((g["build"], g["choices"]), (BUILD, self.choices(upscaler="fsr31", fg=3)))
        self.assertGreater(res["removed"], 0)
        self.assertEqual(res["launch_before"]["set"], {"XESS_FG": "3"})
        self.assertFalse(optiscaler.info(self.ctx, WITCHER)["opti"]["update"])

    def test_update_stops_after_a_failed_remove(self):
        self.assertTrue(self.install()["ok"])
        write(os.path.join(self.folder, "dxgi.dll"), b"changed")
        own_tree(self.folder, self.w.uid)
        res = optiscaler.update(self.ctx, None, self.job, WITCHER)
        self.assertFalse(res["ok"])
        self.assertIn("the update stopped", res["error"])
        self.assertEqual(self.read("dxgi.dll"), b"changed")
        self.assertFalse(os.path.exists(os.path.join(self.folder, "OptiScaler.ini")))     # not put in again

    def test_a_failed_download_leaves_the_old_build_in_place(self):
        self.assertTrue(self.install()["ok"])
        files = snapshot(self.folder)
        rec = self.record()
        rec["games"][WITCHER]["build"] = "v9-old"
        rec["packages"] = {}                                   # the new pin is not downloaded yet
        with open(os.path.join(self.ctx.settings_dir, "optiscaler.json"), "w") as f:
            json.dump(rec, f)
        self.download_error = "HTTP 503"
        res = optiscaler.update(self.ctx, None, self.job, WITCHER)
        self.assertFalse(res["ok"])
        self.assertIn("HTTP 503", res["error"])
        self.assertEqual(snapshot(self.folder), files)          # nothing removed
        g = self.record()["games"][WITCHER]
        self.assertEqual((g["build"], g["partial"]), ("v9-old", False))
        self.assertEqual(res["launch"], g["launch"])

    def test_remove_after_the_game_folder_is_gone(self):
        self.assertTrue(self.install(fg=3)["ok"])
        shutil.rmtree(self.game)                                # uninstalled (or moved) by Steam
        res = self.remove()
        self.assertTrue(res["ok"], res)
        self.assertEqual((res["kept"], res["removed"]), ([], 0))
        self.assertEqual(res["launch"]["set"], {"XESS_FG": "3"})   # the frontend undoes the launch options
        self.assertNotIn(WITCHER, self.record()["games"])
        self.assertFalse(optiscaler.installed_for(self.ctx, WITCHER))

    def test_a_folder_outside_a_library_is_still_refused(self):
        outside = os.path.join(self.tmp.name, "elsewhere")
        os.makedirs(outside)
        optiscaler._put_game(self.ctx, WITCHER, {"build": BUILD, "folder": outside, "files": []})
        res = self.remove()
        self.assertFalse(res["ok"])
        self.assertIn(WITCHER, self.record()["games"])

    def test_set_choices_keeps_the_warnings(self):
        self.assertTrue(self.install()["ok"])
        with mock.patch.object(optiscaler, "_game_warnings", return_value=["OptiScaler's XeSS will run in the "
                                                                           "slower mode."]) as w:
            res = optiscaler.set_choices(self.ctx, WITCHER, self.choices(fg=0), {"s": 1})
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["opti"]["warnings"], ["OptiScaler's XeSS will run in the slower mode."])
        w.assert_called_once_with(self.ctx, {"s": 1}, WITCHER)

    def test_prune_cache_keeps_builds_a_record_uses(self):
        cache = os.path.join(self.ctx.home, optiscaler.CACHE_REL)
        for n in ("v9-old", "v8-older", BUILD, "v7.new"):
            os.makedirs(os.path.join(cache, n))
        optiscaler._put_game(self.ctx, "1", {"build": "v9-old", "folder": "/x"})
        self.assertEqual(sorted(optiscaler.prune_cache(self.ctx)), ["v7.new", "v8-older"])
        self.assertEqual(sorted(os.listdir(cache)), [BUILD, "v9-old"])


class BackupTest(Base):
    """A flat layout (every package file next to the exe) puts files where the game has its own."""

    def setUp(self):
        super().setUp()
        flat = dict(optiscaler.BUILDS[BUILD], layout="flat")
        p = mock.patch.dict(optiscaler.BUILDS, {"flat": flat})
        p.start()
        self.addCleanup(p.stop)
        p = mock.patch.dict(optiscaler.GAMES, {WITCHER: dict(optiscaler.GAMES[WITCHER], build="flat")})
        p.start()
        self.addCleanup(p.stop)
        self.shell.tree = {"OptiScaler.dll": b"MZ opti", "OptiScaler.ini": PACKAGE_INI.encode(),
                           "libxess.dll": b"MZ xess 2.1 from OptiScaler", "D3D12_Optiscaler/D3D12Core.dll": b"MZ"}
        self.shell.listing = listing_7z(self.shell.tree)

    def test_backed_up_and_put_back_with_the_same_bytes_and_time(self):
        os.utime(os.path.join(self.folder, "libxess.dll"), ns=(1_600_000_000_000_000_000,) * 2)
        before = snapshot(self.game)
        ino = os.stat(os.path.join(self.folder, "libxess.dll")).st_ino
        res = self.install()
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["backed_up"], ["libxess.dll"])
        self.assertEqual(self.read("libxess.dll"), b"MZ xess 2.1 from OptiScaler")
        bak = os.path.join(self.folder, ".oxp3deck-optiscaler/backup/libxess.dll")
        self.assertEqual(os.stat(bak).st_ino, ino)                       # renamed, not copied
        self.assertNotIn("OptiDllPath=.\\OptiScaler", self.ini())
        self.assertIn("Backed up: libxess.dll", self.job.lines)
        info = optiscaler.info(self.ctx, WITCHER)["opti"]
        self.assertEqual(info["backed_up"], ["libxess.dll"])
        self.assertTrue(info["sources"])
        self.assertTrue(self.remove()["ok"])
        self.assertEqual(snapshot(self.game), before)
        self.assertEqual(os.stat(os.path.join(self.folder, "libxess.dll")).st_ino, ino)

    def test_a_backup_whose_name_is_taken_again_is_kept(self):
        self.assertTrue(self.install()["ok"])
        write(os.path.join(self.folder, "libxess.dll"), b"Verify integrity put this back")
        own_tree(self.folder, self.w.uid)
        res = self.remove()
        self.assertEqual(len(res["kept"]), 2, res["kept"])
        self.assertIn("libxess.dll (changed since install)", res["kept"])
        self.assertTrue(any("maybe from Verify integrity" in k for k in res["kept"]))
        self.assertTrue(os.path.isfile(os.path.join(self.folder, ".oxp3deck-optiscaler/backup/libxess.dll")))
        self.assertTrue(self.record()["games"][WITCHER]["partial"])


class PureTest(unittest.TestCase):
    E = optiscaler.GAMES[WITCHER]

    def test_set_ini(self):
        text = "[V-Sync]\nForce=auto\n\n[Menu]\n; ShowFps=auto\nshowfps = auto\n\n"
        out = optiscaler.set_ini(text, {"VSync_Force": "true", "Menu_ShowFps": "true", "Menu_Scale": "1.5",
                                        "Hotfix_Thing": "auto"})
        self.assertEqual(out, "[V-Sync]\nForce=true\n\n[Menu]\n; ShowFps=auto\nshowfps=true\nScale=1.5\n\n\n"
                              "[Hotfix]\nThing=auto\n")
        for bad in ({"Menu_ShowFps": "1; rm"}, {"Menu ShowFps": "true"}, {"Menu_Show=Fps": "true"},
                    {"Libraries_OptiDllPath": "C:\\x"}, {"Menu_ShowFps": "a\nb"}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                optiscaler.set_ini(text, bad)

    def test_ini_choices(self):
        def keys(**c):
            ch = {"upscaler": "xess", "fg": 2, "fg_input": "dlssg"}
            ch.update(c)
            return optiscaler._ini_changes(self.E, ch, {"overlay": False}, "subfolder")
        self.assertEqual(keys()["XeFG_InterpolationCount"], "1")
        self.assertEqual(keys(fg=4)["XeFG_InterpolationCount"], "3")
        off = keys(fg=0)
        self.assertEqual((off["FrameGen_Enabled"], off["FrameGen_FGOutput"]), ("false", "nofg"))
        self.assertEqual(keys(fg_input="upscaler")["OptiFG_HUDFix"], "true")
        self.assertEqual(keys(fg_input="xefg")["FrameGen_FGInput"], "xefg")
        self.assertEqual(keys()["Spoofing_Dxgi"], "false")
        self.assertEqual(keys(upscaler="fsr31")["Upscalers_Dx12Upscaler"], "ffx")
        dx11 = optiscaler._ini_changes(dict(self.E, api="dx11"), {"upscaler": "fsr31", "fg": 0, "fg_input": "dlssg"},
                                       {"overlay": True}, "flat")
        self.assertEqual((dx11["Upscalers_Dx11Upscaler"], dx11["Menu_ShowFps"]), ("fsr31", "true"))
        self.assertNotIn("Libraries_OptiDllPath", dx11)

    def test_launch_plan(self):
        def plan(fg):
            return optiscaler.launch_plan(self.E, {"upscaler": "xess", "fg": fg, "fg_input": "dlssg"})
        self.assertEqual(plan(0), {"set": {}, "remove": ["XESS", "FSR", "FSR_FG", "force_vk_vendor", "XESS_FG"],
                                   "dll_override": "dxgi", "dxvk_config": None, "args": ["-dx12"]})
        self.assertEqual(plan(2)["set"], {"XESS_FG": "2"})
        self.assertIsNone(plan(2)["dxvk_config"])
        self.assertEqual(plan(3)["dxvk_config"], "dxgi.customVendorId = 8086")
        self.assertEqual(plan(4)["set"], {"XESS_FG": "4"})

    def test_the_pin(self):
        b = optiscaler.BUILDS[self.E["build"]]
        self.assertEqual(b["sha256"], "e26810c76451666da0bcc40be62722e7b4a5d36c550036830b98f5eb69e0648c")
        self.assertEqual(b["size_max"], 96 << 20)
        self.assertTrue(b["url"].startswith("https://") and b["url"].endswith(b["asset"]))
        self.assertEqual((self.E["folder"], self.E["proxy"], self.E["fg_input"]), ("bin/x64_dx12", "dxgi", "dlssg"))
        for g in optiscaler.GAMES.values():
            self.assertTrue(g["sources"])            # every entry names its sources
            self.assertIn(g["build"], optiscaler.BUILDS)

    def test_info_for_a_game_without_a_setup(self):
        with tempfile.TemporaryDirectory() as d:
            from tests import stub_decky
            ctx = stub_decky.make_ctx(d)
            info = optiscaler.info(ctx, "1091500")["opti"]
            self.assertEqual((info["supported"], info["why"], info["state"]), (False, optiscaler.NO_SETUP, "none"))
            self.assertFalse(optiscaler.info(ctx, "../x")["ok"])


if __name__ == "__main__":
    unittest.main()
