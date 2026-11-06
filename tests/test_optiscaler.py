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

from oxp3deck import downloads, optigames, optiscaler, pe, steamlib, sysexec, userexec
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
        c = {"upscaler": "xess", "fg": 2, "fg_input": "xefg"}       # The Witcher 3's default input
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

    def test_not_installed_and_not_a_steam_game(self):
        self.assertEqual(optiscaler.exe_dir(self.ctx, "1091500"), (None, "Cyberpunk 2077 is not installed."))
        self.assertEqual(optiscaler.exe_dir(self.ctx, "../x"), (None, optiscaler.NO_SETUP))
        os.unlink(os.path.join(self.w.steam, "steamapps", f"appmanifest_{WITCHER}.acf"))
        self.assertEqual(optiscaler.exe_dir(self.ctx, WITCHER), (None, "The Witcher 3 is not installed."))


class RefusalTest(Base):
    def refused(self, why, appid=WITCHER):
        before = snapshot(self.tmp.name)
        res = optiscaler.install(self.ctx, None, self.job, appid,
                                 self.choices(**({} if appid == WITCHER else {"fg_input": "dlssg"})))
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

    def test_not_installed(self):
        self.refused("Cyberpunk 2077 is not installed.", "1091500")
        self.refused("This game is not installed.", "1234567")
        self.refused(optiscaler.NO_SETUP, "12x")

    def test_exe_folder_missing(self):
        shutil.rmtree(self.folder)
        self.refused("Can't find witcher3.exe in bin/x64_dx12 of the game's folder.")

    def test_anticheat(self):
        for rel, what, shown in (("EasyAntiCheat/x", "EasyAntiCheat", "EasyAntiCheat/"),
                                 ("bin/BattlEye/x", "BattlEye", "bin/BattlEye/"),
                                 ("bin/x64/start_protected_game.exe", "EasyAntiCheat",
                                  "bin/x64/start_protected_game.exe"),
                                 ("Game_BE.exe", "BattlEye", "Game_BE.exe"),
                                 ("bin/EAAntiCheat.GameServiceLauncher.dll", "EA AntiCheat",
                                  "bin/EAAntiCheat.GameServiceLauncher.dll"),
                                 ("BEClient_x64.dll", "BattlEye", "BEClient_x64.dll"),
                                 ("bin/ace-setup64.exe", "ACE", "bin/ace-setup64.exe")):
            with self.subTest(rel=rel):
                p = write(os.path.join(self.game, rel), b"x")
                self.refused(f"The Witcher 3 uses anti-cheat ({what}: {shown} found). OptiScaler's guide says not "
                             "to use it with online games: it can stop the game starting or get the account banned.")
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
        self.assertEqual(res["next"], "Start the game, pick XeSS and XeSS frame generation in a borderless window, "
                                      "then restart it once.")
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
        for line in ("Dx12Upscaler=xess", "Enabled=true", "FGInput=xefg", "FGOutput=xefg", "InterpolationCount=3",
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


class AutoTest(Base):
    """The automatic setup's install (DESIGN.md "Automatic setup"): auto=True replaces no file, origin is
    recorded, anticheat() names online games and anti-cheat files."""

    def test_check_refuses_a_file_in_the_way_and_writes_nothing(self):
        for name, shown in (("DXGI.dll", "dxgi.dll"), ("OptiScaler.ini", "OptiScaler.ini"),
                            ("optiscaler/x.dll", "OptiScaler/")):
            with self.subTest(name=name):
                p = write(os.path.join(self.folder, name), b"x")
                before = snapshot(self.tmp.name)
                why = optiscaler.IN_THE_WAY.format(shown)
                self.assertEqual(optiscaler.check(self.ctx, WITCHER, installing=True, auto=True)["why"], why)
                res = optiscaler.install(self.ctx, None, self.job, WITCHER, self.choices(), auto=True,
                                         origin="auto")
                self.assertEqual((res["ok"], res["error"]), (False, why))
                self.assertEqual(snapshot(self.tmp.name), before)
                self.assertEqual((self.shell.calls, self.downloads), ([], []))
                os.unlink(p)
                if "/" in name:
                    os.rmdir(os.path.dirname(p))
        self.assertTrue(optiscaler.check(self.ctx, WITCHER, installing=True, auto=True)["ok"])

    def test_install_never_backs_up(self):
        """A file that appears after the check (here: the check is skipped) stops the install before any copy."""
        real_check = optiscaler.check
        with mock.patch.object(optiscaler, "check", lambda ctx, appid, installing, auto=False:
                               {"ok": True, "error": None, "why": None}):
            write(os.path.join(self.folder, "OptiScaler.ini"), b"someone's ini")
            own_tree(self.game, self.w.uid)
            before = snapshot(self.game)
            with mock.patch.object(userexec, "copy_new", side_effect=AssertionError("nothing is copied")):
                res = optiscaler.install(self.ctx, None, self.job, WITCHER, self.choices(), auto=True,
                                         origin="auto")
        self.assertEqual((res["ok"], res["error"]), (False, optiscaler.IN_THE_WAY.format("OptiScaler.ini")))
        self.assertEqual(snapshot(self.game), before)
        self.assertIsNone(optiscaler.game_record(self.ctx, WITCHER))
        self.assertIs(optiscaler.check, real_check)

    def test_a_game_started_during_the_download_gets_no_files(self):
        """The check runs before the download, which can take minutes: right before the first copy it asks again."""
        real_fetch = optiscaler.fetch
        started = []

        def fetch(*a, **kw):
            started.append(True)
            return real_fetch(*a, **kw)
        with mock.patch.object(optiscaler, "fetch", fetch), \
                mock.patch.object(steamlib, "running_game", lambda ctx: WITCHER if started else None), \
                mock.patch.object(userexec, "copy_new", side_effect=AssertionError("nothing is copied")):
            res = optiscaler.install(self.ctx, None, self.job, WITCHER, self.choices(), auto=True, origin="auto")
        self.assertEqual(started, [True])
        self.assertEqual((res["ok"], res["error"]), (False, "Quit The Witcher 3 first."))
        self.assertIsNone(optiscaler.game_record(self.ctx, WITCHER))

    def test_check_can_leave_out_the_running_game(self):
        write(os.path.join(self.folder, "dxgi.dll"), b"x")
        with mock.patch.object(steamlib, "running_game", return_value=WITCHER):
            self.assertRegex(optiscaler.check(self.ctx, WITCHER, installing=True, auto=True)["why"], "^Quit ")
            self.assertEqual(optiscaler.check(self.ctx, WITCHER, installing=True, auto=True,
                                              ignore_running=True)["why"], optiscaler.IN_THE_WAY.format("dxgi.dll"))

    def test_origin_is_recorded_and_kept_by_update(self):
        res = optiscaler.install(self.ctx, None, self.job, WITCHER, self.choices(), auto=True, origin="auto")
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["backed_up"], [])
        self.assertEqual(optiscaler.game_record(self.ctx, WITCHER)["origin"], "auto")
        self.assertTrue(optiscaler.update(self.ctx, None, self.job, WITCHER)["ok"])
        self.assertEqual(optiscaler.game_record(self.ctx, WITCHER)["origin"], "auto")
        self.assertTrue(self.remove()["ok"])
        self.assertTrue(self.install()["ok"])
        self.assertEqual(optiscaler.game_record(self.ctx, WITCHER)["origin"], "user")
        self.assertIsNone(optiscaler.game_record(self.ctx, "12x"))

    def test_the_witchers_entry_has_its_automatic_setup(self):
        auto = optiscaler.entry(WITCHER)["auto"]
        self.assertEqual(auto["choices"], {"upscaler": "xess", "fg": 2, "fg_input": "xefg"})
        self.assertEqual(optiscaler.check_choices(optiscaler.entry(WITCHER), auto["choices"])[1], None)
        self.assertLessEqual(len(auto["why"]), 200)
        self.assertLessEqual(len(auto["short"]), 40)
        for appid in optigames.KNOWN:
            self.assertIsNone(optiscaler.entry(appid)["auto"], appid)     # none tested on this device

    def old_install(self, origin: str, **extra):
        """An install from 0.4.3 before the correction: choices and OptiScaler.ini on the dlssg input."""
        res = optiscaler.install(self.ctx, None, self.job, WITCHER, self.choices(), auto=origin == "auto",
                                 origin=origin)
        self.assertTrue(res["ok"], res)
        rec = self.record()
        rec["games"][WITCHER]["choices"] = self.choices(fg_input="dlssg")
        rec["games"][WITCHER].update(extra)
        with open(os.path.join(self.ctx.settings_dir, "optiscaler.json"), "w") as f:
            json.dump(rec, f)
        p = os.path.join(self.folder, "OptiScaler.ini")
        text = self.ini().replace("FGInput=xefg", "FGInput=dlssg")
        os.chmod(p, 0o644)
        with open(p, "w") as f:
            f.write(text)
        self.assertIn("FGInput=dlssg", self.ini())

    def test_an_old_automatic_install_moves_to_the_new_choices(self):
        self.old_install("auto")
        info = optiscaler.info(self.ctx, WITCHER)["opti"]
        self.assertEqual((info["choices"], info["choices_stale"]), (None, True))
        with mock.patch.object(steamlib, "running_game", return_value=WITCHER):
            self.assertFalse(optiscaler.migrate_auto(self.ctx, WITCHER))         # not while it runs
        self.assertIn("FGInput=dlssg", self.ini())
        self.assertTrue(optiscaler.migrate_auto(self.ctx, WITCHER))
        self.assertIn("FGInput=xefg", self.ini())
        self.assertNotIn("FGInput=dlssg", self.ini())
        g = self.record()["games"][WITCHER]
        self.assertEqual((g["choices"], g["origin"]), (self.choices(), "auto"))
        info = optiscaler.info(self.ctx, WITCHER)["opti"]
        self.assertEqual((info["choices"], info["choices_stale"]), (self.choices(), False))
        self.assertFalse(optiscaler.migrate_auto(self.ctx, WITCHER))             # once

    def test_choices_picked_by_hand_are_not_moved(self):
        for origin, extra in (("user", {}), ("auto", {"picked": True}),
                              ("auto", {"choices": self.choices(fg=3, fg_input="dlssg")})):
            with self.subTest(origin=origin, extra=extra):
                self.old_install(origin, **extra)
                before = self.record()["games"][WITCHER]
                self.assertFalse(optiscaler.migrate_auto(self.ctx, WITCHER))
                self.assertIn("FGInput=dlssg", self.ini())
                self.assertEqual(self.record()["games"][WITCHER], before)
                self.assertTrue(optiscaler.info(self.ctx, WITCHER)["opti"]["choices_stale"])
                self.assertTrue(self.remove()["ok"])

    def test_set_choices_marks_them_picked(self):
        self.old_install("auto")
        res = optiscaler.set_choices(self.ctx, WITCHER, self.choices(fg=0))
        self.assertTrue(res["ok"], res)
        self.assertIs(self.record()["games"][WITCHER]["picked"], True)

    def test_anticheat(self):
        self.assertIsNone(optiscaler.anticheat(self.ctx, WITCHER))
        self.assertEqual(optiscaler.anticheat(self.ctx, "730"), {"which": "online", "file": None})
        p = write(os.path.join(self.game, "EasyAntiCheat/x"), b"x")
        self.assertEqual(optiscaler.anticheat(self.ctx, WITCHER),
                         {"which": "EasyAntiCheat", "file": os.path.dirname(os.path.realpath(p))})
        self.assertIsNone(optiscaler.anticheat(self.ctx, "1234567"))       # not installed
        self.assertIsNone(optiscaler.anticheat(self.ctx, "12x"))


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


def make_pe(imports=(), delay=(), pad=0, text=b""):
    """A minimal PE32+ image whose import (and delay-import) tables name `imports` (`delay`); pad: extra bytes."""
    names = b""
    offs = []
    for n in list(imports) + list(delay):
        offs.append(len(names))
        names += n.encode() + b"\0"
    nimp, ndel = len(imports), len(delay)
    imp_size = 20 * (nimp + 1)
    del_size = 32 * (ndel + 1)
    va, raw = 0x1000, 0x400
    names_rva = va + imp_size + del_size
    sec = bytearray()
    for i in range(nimp):
        d = bytearray(20)
        d[12:16] = (names_rva + offs[i]).to_bytes(4, "little")
        sec += d
    sec += bytes(20)
    for i in range(ndel):
        d = bytearray(32)
        d[0:4] = (1).to_bytes(4, "little")
        d[4:8] = (names_rva + offs[nimp + i]).to_bytes(4, "little")
        sec += d
    sec += bytes(32)
    sec += names
    hdr = bytearray(raw)
    hdr[0:2] = b"MZ"
    hdr[0x3C:0x40] = (64).to_bytes(4, "little")
    hdr[64:68] = b"PE\0\0"
    coff = 68
    hdr[coff:coff + 2] = (0x8664).to_bytes(2, "little")
    hdr[coff + 2:coff + 4] = (1).to_bytes(2, "little")
    hdr[coff + 16:coff + 18] = (240).to_bytes(2, "little")
    opt = coff + 20
    hdr[opt:opt + 2] = (0x20B).to_bytes(2, "little")
    hdr[opt + 108:opt + 112] = (16).to_bytes(4, "little")
    dd = opt + 112
    if nimp:
        hdr[dd + 8:dd + 12] = va.to_bytes(4, "little")
        hdr[dd + 12:dd + 16] = imp_size.to_bytes(4, "little")
    if ndel:
        hdr[dd + 104:dd + 108] = (va + imp_size).to_bytes(4, "little")
        hdr[dd + 108:dd + 112] = del_size.to_bytes(4, "little")
    sh = opt + 240
    hdr[sh:sh + 8] = b".idata\0\0"
    hdr[sh + 8:sh + 12] = len(sec).to_bytes(4, "little")
    hdr[sh + 12:sh + 16] = va.to_bytes(4, "little")
    hdr[sh + 16:sh + 20] = len(sec).to_bytes(4, "little")
    hdr[sh + 20:sh + 24] = raw.to_bytes(4, "little")
    return bytes(hdr) + bytes(sec) + text + b"\0" * pad


class AnyGameTest(Base):
    """The generic setup and the known-games table against fake game folders (DESIGN.md "OptiScaler for any
    game")."""

    def setUp(self):
        super().setUp()
        optiscaler.forget_listing()
        self.addCleanup(optiscaler.forget_listing)

    def make(self, appid, name, tree):
        game, _pfx = self.w.app(appid, name)
        for rel, data in tree.items():
            write(os.path.join(game, rel), data)
        own_tree(game, self.w.uid)
        return game

    def unreal(self):
        return self.make("999001", "Fake Unreal", {
            "FakeUnreal.exe": make_pe(["kernel32.dll"]),                              # the root stub
            "Engine/Binaries/Win64/CrashReportClient.exe": make_pe(["d3d11.dll"], pad=4000),
            "Engine/Binaries/ThirdParty/D3D12/D3D12Core.dll": b"MZ agility",
            "Fake/Binaries/Win64/Fake-Win64-Shipping.exe": make_pe(["kernel32.dll", "dxgi.dll", "d3d12.dll"],
                                                                   pad=2000),
            "Fake/Plugins/DLSS/nvngx_dlss.dll": b"MZ dlss",
            "Fake/Content/Paks/fake.pak": b"pak",
        })

    def plain(self, extra=None):
        tree = {"bin/game.exe": make_pe(["kernel32.dll", "d3d11.dll", "dxgi.dll"], pad=9000),
                "bin/unins000.exe": make_pe([], pad=20000),
                "launcher.exe": make_pe(["d3d12.dll"], pad=30000),
                "_CommonRedist/vcredist_x64.exe": make_pe([], pad=40000),
                "data/levels.bin": b"data"}
        tree.update(extra or {})
        return self.make("999002", "Plain Game", tree)

    def run_install(self, appid, **kw):
        return optiscaler.install(self.ctx, None, self.job, appid, self.choices(**kw))

    def test_unreal_round_trip(self):
        game = self.unreal()
        before = snapshot(game)
        e, why = optiscaler.resolve(self.ctx, "999001")
        self.assertIsNone(why)
        self.assertEqual((e["kind"], e["folder"], e["exe"], e["how"], e["api"], e["proxy"], e["has_upscaler"]),
                         ("generic", "Fake/Binaries/Win64", "Fake-Win64-Shipping.exe", "unreal", "dx12", "dxgi", True))
        self.assertEqual(e["api_why"], "the exe loads d3d12.dll")
        info = optiscaler.info(self.ctx, "999001")["opti"]
        self.assertEqual((info["kind"], info["api"], info["fg_ok"], info["why"], info["name"]),
                         ("generic", "dx12", True, None, "Fake Unreal"))
        self.assertEqual(info["defaults"], {"upscaler": "xess", "fg": 0, "fg_input": "upscaler"})
        self.assertIn(optiscaler.EXPERIMENTAL, info["notes"])
        self.assertNotIn(optiscaler.NO_UPSCALER, info["notes"])
        res = self.run_install("999001", fg=2, fg_input="upscaler")
        self.assertTrue(res["ok"], res)
        folder = os.path.join(game, "Fake/Binaries/Win64")
        self.assertEqual(sorted(os.listdir(folder)), [".oxp3deck-optiscaler", "Fake-Win64-Shipping.exe", "OptiScaler",
                                                      "OptiScaler.ini", "dxgi.dll"])
        self.assertIn("in its graphics settings", res["next"])
        self.assertTrue(any("the generic setup (experimental)" in line for line in self.job.lines), self.job.lines)
        with open(os.path.join(folder, "OptiScaler.ini")) as f:
            ini = f.read()
        for line in ("Dx12Upscaler=xess", "Dxgi=false", "FGInput=upscaler", "HUDFix=true", "DisableOverlays=false"):
            self.assertIn(line, ini)
        g = self.record()["games"]["999001"]
        self.assertEqual((g["kind"], g["api"], g["exe"], g["proxy"]), ("generic", "dx12", "Fake-Win64-Shipping.exe",
                                                                         "dxgi"))
        info = optiscaler.info(self.ctx, "999001")["opti"]
        self.assertEqual((info["state"], info["kind"], info["proxy"]), ("installed", "generic", "dxgi"))
        # a choice change keeps the record's setup (our dxgi.dll is in the folder now: the proxy stays dxgi)
        res = optiscaler.set_choices(self.ctx, "999001", self.choices(upscaler="fsr31", fg=0))
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["opti"]["launch"]["dll_override"], "dxgi")
        res = optiscaler.remove(self.ctx, None, self.job, "999001")
        self.assertTrue(res["ok"], res)
        self.assertEqual(snapshot(game), before)

    def test_plain_dx11_layout(self):
        game = self.plain()
        e, _why = optiscaler.resolve(self.ctx, "999002")
        self.assertEqual((e["folder"], e["exe"], e["how"], e["api"], e["proxy"], e["fg_inputs"]),
                         ("bin", "game.exe", "largest", "dx11", "dxgi", ()))
        info = optiscaler.info(self.ctx, "999002")["opti"]
        self.assertFalse(info["fg_ok"])
        self.assertIn(optiscaler.NO_UPSCALER, info["notes"])
        self.assertTrue(any(n.startswith("DirectX 11 game: OptiScaler replaces its upscaler only") for n in
                            info["notes"]))
        res = self.run_install("999002", fg=2)
        self.assertFalse(res["ok"])
        self.assertEqual(res["error"], "OptiScaler: frame generation needs DirectX 12; Plain Game runs in DirectX 11")
        self.assertTrue(self.run_install("999002", fg=0, upscaler="fsr31")["ok"])
        with open(os.path.join(game, "bin/OptiScaler.ini")) as f:
            ini = f.read()
        self.assertIn("Dx11Upscaler=fsr31", ini)
        self.assertIn("Dx12Upscaler=ffx", ini)          # both: OptiScaler reads only the running API's key
        self.assertEqual(self.record()["games"]["999002"]["launch"]["set"], {})

    def test_an_existing_dxgi_is_never_overwritten(self):
        game = self.plain({"bin/dxgi.dll": b"reshade", "bin/WINMM.dll": b"another"})
        before = self.read_game(game, "bin/dxgi.dll")
        e, _why = optiscaler.resolve(self.ctx, "999002")
        self.assertEqual((e["proxy"], e["taken"]), ("version", ["dxgi", "winmm"]))
        res = self.run_install("999002", fg=0)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["launch"]["dll_override"], "version")
        self.assertEqual(self.read_game(game, "bin/dxgi.dll"), before)
        self.assertEqual(self.read_game(game, "bin/version.dll"), PACKAGE["OptiScaler.dll"])
        self.assertTrue(optiscaler.remove(self.ctx, None, self.job, "999002")["ok"])
        # every name taken: refused, and nothing written
        for n in ("version.dll", "dbghelp.dll"):
            write(os.path.join(game, "bin", n), b"another")
        snap = snapshot(game)
        why = ("The game folder already has dxgi.dll, winmm.dll, version.dll and dbghelp.dll (other mods); "
               "OptiScaler needs one of these names free.")
        self.assertEqual(optiscaler.check(self.ctx, "999002", installing=True)["why"], why)
        self.assertEqual(self.run_install("999002", fg=0)["error"], why)
        self.assertEqual(snapshot(game), snap)

    def read_game(self, game, rel):
        with open(os.path.join(game, rel), "rb") as f:
            return f.read()

    def test_anticheat_folder(self):
        game = self.plain({"EasyAntiCheat/EasyAntiCheat_EOS_Setup.exe": b"MZ"})
        snap = snapshot(game)
        why = ("Plain Game uses anti-cheat (EasyAntiCheat: EasyAntiCheat/ found). OptiScaler's guide says not to use "
               "it with online games: it can stop the game starting or get the account banned.")
        self.assertEqual(self.run_install("999002", fg=0)["error"], why)
        self.assertEqual(optiscaler.info(self.ctx, "999002")["opti"]["why"], why)
        self.assertEqual(snapshot(game), snap)
        self.assertEqual(self.downloads, [])

    def test_vulkan_only(self):
        game = self.make("999003", "Vulkan Game", {"VulkanGame.exe": make_pe(["vulkan-1.dll", "kernel32.dll"]),
                                                   "amd_fidelityfx_vk.dll": b"MZ fsr"})
        e, _why = optiscaler.resolve(self.ctx, "999003")
        self.assertEqual((e["folder"], e["api"], e["proxy"], e["fg_inputs"]), ("", "vulkan", "winmm", ()))
        info = optiscaler.info(self.ctx, "999003")["opti"]
        self.assertEqual((info["fg_ok"], info["fg_inputs"], info["upscaler_found"]), (False, [], True))
        self.assertTrue(any(n.startswith("Vulkan game") for n in info["notes"]))
        self.assertIn("needs DirectX 12", self.run_install("999003", fg=2)["error"])
        res = self.run_install("999003", fg=0)
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["launch"], {"set": {}, "remove": ["XESS", "FSR", "FSR_FG", "force_vk_vendor", "XESS_FG"],
                                         "dll_override": "winmm", "dxvk_config": None, "args": []})
        with open(os.path.join(game, "OptiScaler.ini")) as f:
            ini = f.read()
        self.assertIn("VulkanUpscaler=xess", ini)
        self.assertTrue(os.path.isfile(os.path.join(game, "winmm.dll")))
        self.assertFalse(os.path.exists(os.path.join(game, "dxgi.dll")))

    def test_unsupported_cases_are_refused_with_a_reason(self):
        self.make("999004", "Linux Game", {"game.x86_64": b"\x7fELF", "lib/libfoo.so": b"x"})
        self.assertEqual(optiscaler.check(self.ctx, "999004", installing=True)["why"],
                         "Linux Game runs as a Linux game here; OptiScaler needs its Windows version (Proton).")
        self.make("999005", "Old Game", {"old.exe": make_pe(["d3d9.dll"])})
        self.assertEqual(optiscaler.check(self.ctx, "999005", installing=True)["why"],
                         "Old Game uses DirectX 9; OptiScaler needs DirectX 11, DirectX 12 or Vulkan.")
        self.make("999006", "Mystery", {"m.exe": b"MZ not a real image"})
        self.assertIn("can't tell whether Mystery uses DirectX 11, DirectX 12 or Vulkan",
                      optiscaler.check(self.ctx, "999006", installing=True)["why"])
        self.make("999007", "Only Helpers", {"UnityCrashHandler64.exe": make_pe(["d3d11.dll"]),
                                             "unins000.exe": make_pe([])})
        self.assertIn("Can't tell which file is Only Helpers's exe",
                      optiscaler.check(self.ctx, "999007", installing=True)["why"])
        self.make("730", "Counter-Strike Global Offensive", {"game/bin/win64/cs2.exe": make_pe(["d3d11.dll"])})
        self.assertEqual(optiscaler.check(self.ctx, "730", installing=True)["why"],
                         "Counter-Strike Global Offensive is an online game. OptiScaler's guide says not to use it "
                         "with online games, so OXP3 Deck does not install it.")
        self.make("782330", "DOOMEternal", {"DOOMEternalx64vk.exe": make_pe(["vulkan-1.dll"])})
        self.assertEqual(optiscaler.check(self.ctx, "782330", installing=True)["why"],
                         "OptiScaler's wiki documents DOOMEternal only with OptiPatcher on Intel GPUs, which OXP3 "
                         "Deck does not set up.")
        for appid in ("999004", "730"):
            info = optiscaler.info(self.ctx, appid)["opti"]
            self.assertTrue(info["why"])
        self.assertEqual(self.downloads, [])

    def test_known_game(self):
        game = self.make("1091500", "Cyberpunk 2077", {
            "REDprelauncher.exe": make_pe(["d3d11.dll"], pad=50000),
            "bin/x64/Cyberpunk2077.exe": make_pe(["d3d12.dll"], pad=1000),
            "bin/x64/nvngx_dlss.dll": b"MZ"})
        e, _why = optiscaler.resolve(self.ctx, "1091500")
        self.assertEqual((e["kind"], e["folder"], e["exe"], e["api"], e["proxy"], e["pick"]),
                         ("known", "bin/x64", "Cyberpunk2077.exe", "dx12", "dxgi", "XeSS"))
        self.assertEqual(e["fg_inputs"], ("dlssg", "upscaler"))
        info = optiscaler.info(self.ctx, "1091500")["opti"]
        self.assertEqual(info["sources"][0], "github.com/optiscaler/OptiScaler/wiki/Cyberpunk-2077")
        self.assertNotIn(optiscaler.EXPERIMENTAL, info["notes"])
        self.assertIn("xefg", optiscaler.check_choices(e, self.choices(fg=2, fg_input="xefg"))[1])
        # the wiki's second name when dxgi.dll is taken
        write(os.path.join(game, "bin/x64/dxgi.dll"), b"another mod")
        e, _why = optiscaler.resolve(self.ctx, "1091500", fresh=True)
        self.assertEqual(e["proxy"], "wininet")
        res = self.run_install("1091500", fg=2, fg_input="dlssg")     # Cyberpunk 2077's documented input
        self.assertTrue(res["ok"], res)
        self.assertEqual(res["launch"]["dll_override"], "wininet")
        self.assertIn("pick XeSS and DLSS frame generation", res["next"])

    def test_a_known_game_whose_exe_moved_gets_the_generic_setup(self):
        self.make("1091500", "Cyberpunk 2077", {"bin/x64/Cyberpunk2077_new.exe": make_pe(["d3d12.dll"])})
        e, _why = optiscaler.resolve(self.ctx, "1091500")
        self.assertEqual((e["kind"], e["exe"], e["api"]), ("generic", "Cyberpunk2077_new.exe", "dx12"))
        self.assertIn("was not found in its folder", e["notes"][1])
        self.assertTrue(e["sources"])

    def test_unity_layout(self):
        # a real Unity <Name>.exe is a stub that imports UnityPlayer.dll; the graphics imports are in the player
        self.make("999008", "Unity Game", {"UnityGame.exe": make_pe(["unityplayer.dll", "kernel32.dll"]),
                                           "UnityPlayer.dll": make_pe(["d3d11.dll", "dxgi.dll"], pad=18000),
                                           "UnityGame_Data/globalgamemanagers": b"x",
                                           "UnityCrashHandler64.exe": make_pe([], pad=2000),
                                           "Tools/Editor.exe": make_pe(["d3d11.dll"], pad=90000)})
        e, why = optiscaler.resolve(self.ctx, "999008")
        self.assertIsNone(why)
        self.assertEqual((e["exe"], e["how"], e["api"], e["proxy"]), ("UnityGame.exe", "unity", "dx11", "dxgi"))
        # a DirectX 12 Unity player names d3d12.dll (loaded at run time)
        self.make("999009", "Unity DX12", {"U.exe": make_pe(["unityplayer.dll"]),
                                           "UnityPlayer.dll": make_pe(["kernel32.dll"], text=b"..d3d12.dll..d3d11.dll"),
                                           "U_Data/globalgamemanagers": b"x"})
        e, why = optiscaler.resolve(self.ctx, "999009")
        self.assertEqual((e["how"], e["api"], e["api_why"]), ("unity", "dx12", "the exe names d3d12.dll"), why)

    def test_anticheat_in_the_exe_folder(self):
        # below SCAN_DEPTH of the install folder, in Unreal's Binaries/Win64
        for appid, ac, tree in (
                ("999101", "BattlEye", {"BEGame/Binaries/Win64/BEGame-Win64-Shipping.exe": make_pe(["d3d12.dll"]),
                                        "BEGame/Binaries/Win64/BattlEye/BEClient_x64.dll": b"MZ"}),
                ("999102", "EasyAntiCheat", {"G/Binaries/Win64/G-Win64-Shipping.exe": make_pe(["d3d12.dll"]),
                                             "G/Binaries/Win64/EasyAntiCheat/Settings.json": b"{}"})):
            with self.subTest(ac=ac):
                game = self.make(appid, f"AC {appid}", tree)
                snap = snapshot(game)
                why = optiscaler.check(self.ctx, appid, installing=True)["why"]
                self.assertTrue(why and why.startswith(f"AC {appid} uses anti-cheat ({ac}: "), why)
                self.assertIn("Binaries/Win64/", why)
                self.assertEqual(optiscaler.info(self.ctx, appid)["opti"]["why"], why)
                self.assertEqual(self.run_install(appid, fg=0)["error"], why)
                self.assertEqual(snapshot(game), snap)
        self.assertEqual(self.downloads, [])

    def test_unreal_with_both_apis_gets_both_upscaler_keys(self):
        game = self.make("999103", "UE4 Both", {"G/Binaries/Win64/G-Win64-Shipping.exe": make_pe(
            ["kernel32.dll"], ["d3d11.dll", "d3d12.dll"], pad=3000)})
        e, _why = optiscaler.resolve(self.ctx, "999103")
        self.assertEqual(e["api"], "dx12")
        self.assertTrue(self.run_install("999103", fg=0, upscaler="xess")["ok"])
        with open(os.path.join(game, "G/Binaries/Win64/OptiScaler.ini")) as f:
            ini = f.read()
        self.assertIn("Dx11Upscaler=xess", ini)
        self.assertIn("Dx12Upscaler=xess", ini)

    def test_not_offered_and_online_messages(self):
        for appid, name, why in (
                ("1245620", "ELDEN RING", "OptiScaler's wiki documents ELDEN RING only with the ERSS-FG mod, which "
                                          "OXP3 Deck does not set up."),
                ("1623730", "Palworld", "OptiScaler's wiki documents Palworld only with OptiPatcher or the GPU spoof, "
                                        "which OXP3 Deck does not set up."),
                ("230410", "Warframe", "Warframe is an online game. OptiScaler's guide says not to use it with online "
                                       "games, so OXP3 Deck does not install it.")):
            with self.subTest(name=name):
                self.make(appid, name, {"g.exe": make_pe(["d3d12.dll"])})
                self.assertEqual(optiscaler.check(self.ctx, appid, installing=True)["why"], why)
        for appid in ("1623730", "1139900", "2457220", "1774580", "1245620"):
            self.assertNotIn(appid, optigames.KNOWN)
            self.assertNotIn(appid, optigames.ONLINE)


class OptigamesTest(unittest.TestCase):
    def test_pick_exe(self):
        files = [("bin/x64/witcher3.exe", 100), ("bin/x64_dx12/witcher3.exe", 100), ("REDprelauncher.exe", 500)]
        self.assertEqual(optigames.pick_exe(files, set()), ("bin/x64_dx12", "witcher3.exe", "largest"))
        self.assertEqual(optigames.pick_exe(list(reversed(files)), set()), ("bin/x64_dx12", "witcher3.exe", "largest"))
        files = [("Phoenix/Binaries/Win64/HogwartsLegacy.exe", 9), ("HogwartsLegacy.exe", 1),
                 ("Engine/Binaries/Win64/x.exe", 99)]
        self.assertEqual(optigames.pick_exe(files, set()), ("Phoenix/Binaries/Win64", "HogwartsLegacy.exe", "unreal"))
        self.assertIsNone(optigames.pick_exe([("_CommonRedist/DirectX/game.exe", 9), ("uninstall.exe", 9)], set()))
        # a tool deeper down is not the game, even when larger
        files = [("Game.exe", 3000), ("tools/ModEditor.exe", 90000), ("bin/DedicatedServer.exe", 90000),
                 ("Benchmark.exe", 90000), ("GameConfig.exe", 90000)]
        self.assertEqual(optigames.pick_exe(files, set()), ("", "Game.exe", "largest"))
        files = [("Game.exe", 3000), ("data/Other.exe", 90000)]
        self.assertEqual(optigames.pick_exe(files, set()), ("data", "Other.exe", "largest"))   # a tiny root stub
        files = [("Game.exe", 30000), ("data/Other.exe", 90000)]
        self.assertEqual(optigames.pick_exe(files, set()), ("", "Game.exe", "largest"))        # shallower first

    def test_decide_api(self):
        d = optigames.decide_api
        self.assertEqual(d("bin/x64_dx12", "witcher3.exe", set(), None)[0], "dx12")
        self.assertEqual(d("", "control_dx12.exe", set(), None)[0], "dx12")
        self.assertEqual(d("", "ffxiv_dx11.exe", set(), ["d3d12.dll"])[0], "dx11")
        self.assertEqual(d("", "DOOMEternalx64vk.exe", set(), None)[0], "vulkan")
        self.assertEqual(d("", "g.exe", {"sl.interposer.dll"}, ["d3d11.dll"]),
                         ("dx12", "the game ships sl.interposer.dll"))
        self.assertEqual(d("", "g.exe", set(), ["vulkan-1.dll", "d3d11.dll"])[0], "dx11")
        self.assertEqual(d("", "g.exe", set(), [], {b"d3d12.dll", b"d3d11.dll"}), ("dx12", "the exe names d3d12.dll"))
        self.assertEqual(d("", "g.exe", set(), ["opengl32.dll"]), (None, "OpenGL"))
        self.assertEqual(d("", "g.exe", set(), None), (None, ""))

    def test_pick_proxy(self):
        p = optigames.pick_proxy
        self.assertEqual(p("dx12", set()), ("dxgi", []))
        self.assertEqual(p("dx11", {"dxgi.dll", "winmm.dll", "version.dll", "dbghelp.dll"}),
                         (None, ["dxgi", "winmm", "version", "dbghelp"]))           # never d3d12 for DirectX 11
        self.assertEqual(p("vulkan", set()), ("winmm", []))
        self.assertEqual(p("dx12", set(), None, ["version.dll", "kernel32.dll"]), ("version", []))
        self.assertEqual(p("dx12", {"dxgi.dll"}, ("dxgi",)), (None, ["dxgi"]))
        self.assertEqual(p("dx11", set(), ("d3d12", "dxgi")), ("dxgi", []))
        nms = optigames.KNOWN["275850"]
        self.assertEqual((nms["api"], nms["proxies"]), ("vulkan", ("dbghelp", "dxgi")))
        self.assertEqual(p("vulkan", set(), nms["proxies"]), ("dbghelp", []))
        self.assertNotIn("dxgi", optigames.PROXIES_BY_API["vulkan"])

    def test_pe_imports(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "a.exe")
            with open(path, "wb") as f:
                f.write(make_pe(["KERNEL32.dll", "d3d12.dll"], ["dxgi.dll"], text=b"..Vulkan-1.DLL.."))
            self.assertEqual(pe.imports(path), ["kernel32.dll", "d3d12.dll", "dxgi.dll"])
            self.assertEqual(pe.mentions(path, (b"vulkan-1.dll", b"d3d9.dll")), {b"vulkan-1.dll"})
            with open(path, "wb") as f:
                f.write(b"MZ" + b"\0" * 100)
            self.assertIsNone(pe.imports(path))
            self.assertIsNone(pe.imports(os.path.join(d, "missing.exe")))

    def test_table(self):
        self.assertNotIn(WITCHER, optigames.KNOWN)
        for appid, k in optigames.KNOWN.items():
            with self.subTest(appid=appid):
                self.assertTrue(appid.isdigit())
                self.assertIn(k["api"], optigames.APIS)
                self.assertTrue(k["sources"] and k["sources"][0].startswith(optigames.WIKI))
                self.assertTrue(all(p in optigames.ALL_PROXIES for p in k["proxies"]))
                self.assertTrue(all(i in optigames.FG_INPUTS for i in k["fg_inputs"]))
                self.assertEqual(bool(k["fg_inputs"]), k["api"] == "dx12")
                self.assertTrue(all(e == e.lower() and e.endswith(".exe") for e in k["exes"]))
                self.assertNotIn(appid, optigames.ONLINE)
                self.assertNotIn(appid, optigames.NOT_OFFERED)
        self.assertGreaterEqual(len(optigames.KNOWN), 39)


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
            ch = {"upscaler": "xess", "fg": 2, "fg_input": "xefg"}
            ch.update(c)
            return optiscaler._ini_changes(self.E, ch, {"overlay": False}, "subfolder")
        self.assertEqual(keys()["XeFG_InterpolationCount"], "1")
        self.assertEqual(keys(fg=4)["XeFG_InterpolationCount"], "3")
        off = keys(fg=0)
        self.assertEqual((off["FrameGen_Enabled"], off["FrameGen_FGOutput"]), ("false", "nofg"))
        self.assertEqual((keys()["FrameGen_FGInput"], keys()["FrameGen_FGOutput"]), ("xefg", "xefg"))
        self.assertEqual((keys()["OptiFG_HUDFix"], keys()["OptiFG_HUDLimit"], keys()["OptiFG_ResourceBlocking"]),
                         ("auto", "auto", "auto"))
        # OptiFG as the wiki's FG-Settings say: HUDfix with limit 1 and Resource Blocking
        opti = keys(fg_input="upscaler")
        self.assertEqual((opti["FrameGen_FGInput"], opti["FrameGen_FGOutput"], opti["OptiFG_HUDFix"],
                          opti["OptiFG_HUDLimit"], opti["OptiFG_ResourceBlocking"], opti["Hotfix_DisableOverlays"]),
                         ("upscaler", "xefg", "true", "1", "true", "false"))
        self.assertEqual(keys(fg=0, fg_input="upscaler")["OptiFG_HUDLimit"], "auto")
        # another game's OptiFG gets no HUDLimit or ResourceBlocking key
        other = optiscaler._ini_changes(dict(self.E, optifg_ini={}, kind="known"), {"upscaler": "xess", "fg": 2,
                                        "fg_input": "upscaler"}, {"overlay": False}, "subfolder")
        self.assertNotIn("OptiFG_HUDLimit", other)
        self.assertNotIn("OptiFG_ResourceBlocking", other)
        self.assertEqual(keys()["Spoofing_Dxgi"], "false")
        self.assertEqual(keys(upscaler="fsr31")["Upscalers_Dx12Upscaler"], "ffx")
        dx11 = optiscaler._ini_changes(dict(self.E, api="dx11"), {"upscaler": "fsr31", "fg": 0, "fg_input": "xefg"},
                                       {"overlay": True}, "flat")
        self.assertEqual((dx11["Upscalers_Dx11Upscaler"], dx11["Menu_ShowFps"]), ("fsr31", "true"))
        self.assertNotIn("Libraries_OptiDllPath", dx11)

    def test_launch_plan(self):
        def plan(fg):
            return optiscaler.launch_plan(self.E, {"upscaler": "xess", "fg": fg, "fg_input": "xefg"})
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
        self.assertEqual((self.E["folder"], self.E["proxy"], self.E["fg_input"]), ("bin/x64_dx12", "dxgi", "xefg"))
        self.assertEqual(self.E["fg_inputs"], ("xefg", "upscaler"))       # Streamline 1: no dlssg (wiki Notes)
        self.assertIn("dlssg", optiscaler.check_choices(self.E, {"upscaler": "xess", "fg": 2, "fg_input": "dlssg"})[1])
        for g in optiscaler.GAMES.values():
            self.assertTrue(g["sources"])            # every entry names its sources
            self.assertIn(g["build"], optiscaler.BUILDS)

    def test_info_for_a_game_without_a_setup(self):
        with tempfile.TemporaryDirectory() as d:
            from tests import stub_decky
            ctx = stub_decky.make_ctx(d)
            info = optiscaler.info(ctx, "1091500")["opti"]
            self.assertEqual((info["supported"], info["why"], info["state"], info["kind"]),
                             (False, "Cyberpunk 2077 is not installed.", "none", "known"))
            self.assertTrue(info["sources"][0].endswith("/wiki/Cyberpunk-2077"))
            self.assertFalse(optiscaler.info(ctx, "../x")["ok"])


if __name__ == "__main__":
    unittest.main()
