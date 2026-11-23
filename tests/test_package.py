"""The manifest files and tools/build_zip.py (the OXP3Deck.zip users install with Decky)."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

PLUGIN = Path(__file__).resolve().parent.parent   # the repository root
BUILDER = PLUGIN / "tools" / "build_zip.py"
COMPARER = PLUGIN / "tools" / "compare_zips.py"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$")


def load_builder():
    name = "oxp3deck_build_zip"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, BUILDER)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod   # dataclasses look the module up there
        spec.loader.exec_module(mod)
    return sys.modules[name]


def mode_of(info: zipfile.ZipInfo) -> int:
    return info.external_attr >> 16


class ManifestTest(unittest.TestCase):
    def test_plugin_json(self):
        manifest = json.loads((PLUGIN / "plugin.json").read_text())
        self.assertEqual(manifest["name"], "OXP3Deck")
        self.assertEqual(manifest["flags"], ["root"])   # "_root" or no flag: every root write fails
        self.assertEqual(manifest["api_version"], 1)
        image = manifest.get("publish", {}).get("image")
        if image:   # only an asset that exists in the repository
            rel = image.split("/HEAD/", 1)[-1]
            self.assertTrue((PLUGIN / rel).is_file(), image)

    def test_package_json(self):
        package = json.loads((PLUGIN / "package.json").read_text())
        self.assertRegex(package["version"], SEMVER)
        self.assertEqual(package["type"], "module")
        self.assertEqual(package["scripts"]["zip"], "python3 tools/build_zip.py")
        self.assertEqual(package["scripts"]["test:js"], "node --test tests/js")
        for script in ("test", "test:js", "typecheck"):
            self.assertIn(f"pnpm {script}", package["scripts"]["check"])
        # release.yml and ci.yml take pnpm's version from here
        self.assertRegex(package.get("packageManager", ""), r"^pnpm@\d+\.\d+\.\d+$")

    def test_builder_runs_what_check_runs(self):
        """build_zip runs pnpm check's commands itself, so it needs no pnpm; keep the two lists the same."""
        scripts = json.loads((PLUGIN / "package.json").read_text())["scripts"]
        argvs = [argv for _label, argv in load_builder().CHECKS]
        self.assertEqual(argvs[0][1:], scripts["test"].split()[1:])
        self.assertEqual(argvs[1], scripts["test:js"].split())
        self.assertEqual(argvs[2][-1], scripts["typecheck"].split()[-1])
        self.assertEqual(Path(argvs[2][1]).parts[:2], ("node_modules", "typescript"))
        # node 22 runs a folder given to --test as its index.js, which imports every *.test.mjs there
        self.assertTrue((PLUGIN / "tests" / "js" / "index.js").is_file())


class WorkflowTest(unittest.TestCase):
    """The release only publishes after the checks and a rebuild that matches the committed zip."""

    def read(self, name):
        return (PLUGIN / ".github" / "workflows" / name).read_text()

    def test_release_checks_before_publish(self):
        text = self.read("release.yml")
        publish = text.index("- name: Publish")
        for step in ("python -m unittest discover -s tests -t .", "pnpm test:js", "pnpm typecheck",
                     "pnpm install --frozen-lockfile", "pnpm build", "--skip-checks", "tools/compare_zips.py"):
            self.assertIn(step, text[:publish], step)

    def test_ci_runs_on_push_and_pull_request(self):
        text = self.read("ci.yml")
        for step in ("push:", "pull_request:", "pnpm install --frozen-lockfile", "pnpm test:js", "pnpm typecheck",
                     "python -m unittest discover -s tests -t .", "pnpm build", "--skip-checks"):
            self.assertIn(step, text, step)

    def test_yaml_parses(self):
        try:
            import yaml
        except ImportError:
            self.skipTest("pyyaml is not installed")
        for name in ("release.yml", "ci.yml"):
            data = yaml.safe_load(self.read(name))
            self.assertIn("jobs", data, name)


class CompareZipsTest(unittest.TestCase):
    """tools/compare_zips.py: release.yml's check that the committed zip is what the sources build."""

    def setUp(self):
        spec = importlib.util.spec_from_file_location("oxp3deck_compare_zips", COMPARER)
        self.cz = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cz)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def make(self, name, files, stamp=(1980, 1, 1, 0, 0, 0), mode=0o644):
        path = Path(self.tmp.name) / name
        with zipfile.ZipFile(path, "w") as zf:
            for fname, data in files.items():
                zi = zipfile.ZipInfo(fname, date_time=stamp)
                zi.external_attr = (stat.S_IFREG | mode) << 16
                zf.writestr(zi, data)
        return str(path)

    def test_same_files_other_times_match(self):
        a = self.make("a.zip", {"x/a": b"1", "x/b": b"2"})
        b = self.make("b.zip", {"x/b": b"2", "x/a": b"1"}, stamp=(2026, 11, 23, 1, 2, 4))
        self.assertEqual(self.cz.differences(a, b), [])
        self.assertEqual(self.cz.main([a, b]), 0)

    def test_reports_contents_names_and_modes(self):
        a = self.make("a.zip", {"x/a": b"1", "x/old": b""})
        b = self.make("b.zip", {"x/a": b"2", "x/new": b""}, mode=0o755)
        diff = self.cz.differences(a, b)
        self.assertIn(f"only in {a}: x/old", diff)
        self.assertIn(f"only in {b}: x/new", diff)
        self.assertIn("x/a: contents differ", diff)
        self.assertTrue(any(line.startswith("x/a: mode") for line in diff), diff)
        with mock.patch("sys.stdout", io.StringIO()), mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(self.cz.main([a, b]), 1)

    def test_reports_a_name_stored_twice(self):
        a = self.make("a.zip", {"x/a": b"1"})
        b = Path(self.tmp.name) / "b.zip"
        with zipfile.ZipFile(b, "w") as zf, mock.patch("warnings.warn"):
            for data in (b"other", b"1"):                                  # the last copy matches a.zip
                zi = zipfile.ZipInfo("x/a", date_time=(1980, 1, 1, 0, 0, 0))
                zi.external_attr = (stat.S_IFREG | 0o644) << 16
                zf.writestr(zi, data)
        self.assertEqual(self.cz.differences(a, str(b)), [f"{b}: x/a is in the zip more than once"])

    def test_bad_zip(self):
        bad = Path(self.tmp.name) / "bad.zip"
        bad.write_bytes(b"not a zip")
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(self.cz.main([str(bad), str(bad)]), 1)


class ChecksTest(unittest.TestCase):
    """build_zip refuses to build when a check fails, unless --skip-checks."""

    def setUp(self):
        self.bz = load_builder()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def checks(self, *codes):
        return tuple((f"check {i}", [sys.executable, "-c", f"print('out {i}'); raise SystemExit({c})"])
                     for i, c in enumerate(codes))

    def test_all_pass(self):
        self.assertEqual(self.bz.run_checks(self.checks(0, 0), cwd=Path(self.tmp.name)), [])

    def test_reports_each_failure_with_its_output(self):
        failed = self.bz.run_checks(self.checks(0, 1, 2), cwd=Path(self.tmp.name))
        self.assertEqual([label for label, _ in failed], ["check 1", "check 2"])
        self.assertIn("out 1", failed[0][1])

    def test_missing_program_fails(self):
        failed = self.bz.run_checks((("gone", [str(Path(self.tmp.name) / "no-such-program")]),),
                                    cwd=Path(self.tmp.name))
        self.assertEqual(len(failed), 1)
        self.assertIn("could not start", failed[0][1])

    def test_checks_know_they_are_nested(self):
        code = f"import os; raise SystemExit(0 if os.environ.get({self.bz.NESTED!r}) == '1' else 1)"
        self.assertEqual(self.bz.run_checks((("env", [sys.executable, "-c", code]),), cwd=Path(self.tmp.name)), [])

    def run_main(self, *args, codes=(0,)):
        out = Path(self.tmp.name) / "OXP3Deck.zip"
        err = io.StringIO()
        built = mock.Mock(return_value=(out, "0" * 64, self.bz.Plan(top="OXP3Deck", version="1.0.0",
                                                                   tool_version="1.0.0")))
        env = {k: v for k, v in os.environ.items() if k != self.bz.NESTED}
        with mock.patch.object(self.bz, "CHECKS", self.checks(*codes)), \
                mock.patch.object(self.bz, "build", built), mock.patch.dict(os.environ, env, clear=True), \
                contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
            code = self.bz.main(["--out", str(out), *args])
        return code, built.called, err.getvalue()

    def test_refuses_to_build_when_a_check_fails(self):
        code, built, err = self.run_main(codes=(0, 1))
        self.assertEqual((code, built), (1, False))
        self.assertIn("not built, failed: check 1", err)
        self.assertIn("--skip-checks", err)

    def test_builds_when_the_checks_pass(self):
        self.assertEqual(self.run_main(codes=(0, 0))[:2], (0, True))

    def test_skip_checks_builds_and_says_so(self):
        code, built, err = self.run_main("--skip-checks", codes=(1,))
        self.assertEqual((code, built), (0, True))
        self.assertIn("checks skipped", err)


class FakeTreeTest(unittest.TestCase):
    """build_zip against a fake plugin folder, so it runs without pnpm build."""

    def setUp(self):
        self.bz = load_builder()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.plugin = base / "repo"
        files = {
            "plugin.json": json.dumps({"name": "OXP3Deck", "flags": ["root"], "api_version": 1}),
            "package.json": json.dumps({"name": "oxp3deck", "version": "1.2.3", "type": "module"}),
            "main.py": "# main\n",
            "dist/index.js": 'const manifest = {"name":"OXP3Deck"};\n',
            "py_modules/oxp3deck/__init__.py": "",
            "py_modules/oxp3deck/env.py": "X = 1\n",
            "py_modules/oxp3deck/notes.txt": "not packed\n",
            "py_modules/oxp3deck/__pycache__/env.cpython-313.pyc": "junk",
            "LICENSE": "MIT\n", "README.md": "# r\n", "CREDITS.md": "# c\n", "THIRD_PARTY_NOTICES.md": "# n\n",
        }
        for rel, text in files.items():
            p = self.plugin / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text)
        self.tool = b"#!/usr/bin/python3 -I\nfake"
        (self.plugin / "vendor").mkdir()
        (self.plugin / "vendor" / "oxp3-tool").write_bytes(self.tool)
        self.write_sums(hashlib.sha256(self.tool).hexdigest())
        self.out = base / "out" / "OXP3Deck.zip"

    def write_sums(self, digest):
        (self.plugin / "vendor" / "oxp3-tool.sha256").write_text(f"{digest}  oxp3-tool\n")

    def build(self, out=None):
        return self.bz.build(out or self.out, plugin=self.plugin)

    def test_contents(self):
        out, digest, plan = self.build()
        self.assertEqual(hashlib.sha256(out.read_bytes()).hexdigest(), digest)
        self.assertEqual(plan.version, "1.2.3")
        with zipfile.ZipFile(out) as zf:
            files = [i.filename for i in zf.infolist() if not i.is_dir()]
            self.assertEqual(zf.read("OXP3Deck/bin/oxp3-tool"), self.tool)
        self.assertEqual(sorted(files), sorted(f"OXP3Deck/{n}" for n in [
            "CREDITS.md", "LICENSE", "README.md", "THIRD_PARTY_NOTICES.md", "bin/oxp3-tool", "bin/oxp3-tool.sha256",
            "dist/index.js", "main.py", "package.json", "plugin.json", "py_modules/oxp3deck/__init__.py",
            "py_modules/oxp3deck/env.py"]))

    def test_needs_the_frontend_build(self):
        (self.plugin / "dist" / "index.js").unlink()
        with self.assertRaisesRegex(self.bz.BuildError, "dist/index.js is missing: run pnpm build first"):
            self.build()
        self.assertFalse(self.out.exists())

    def test_checksum_mismatch(self):
        self.write_sums("0" * 64)
        with self.assertRaisesRegex(self.bz.BuildError, "does not match"):
            self.build()

    def test_needs_the_vendored_tool(self):
        (self.plugin / "vendor" / "oxp3-tool").unlink()
        with self.assertRaisesRegex(self.bz.BuildError, "vendor/oxp3-tool is missing: run python3 tools/vendor_oxp3"):
            self.build()

    def test_missing_backend_or_docs(self):
        for rel in ("main.py", "CREDITS.md", "THIRD_PARTY_NOTICES.md"):
            (self.plugin / rel).rename(self.plugin / (rel + ".x"))
            with self.assertRaisesRegex(self.bz.BuildError, f"{re.escape(rel)} is missing"):
                self.build()
            (self.plugin / (rel + ".x")).rename(self.plugin / rel)

    def test_refuses_a_symlink(self):
        target = Path(self.tmp.name) / "elsewhere.py"
        target.write_text("SECRET = 1\n")
        os.symlink(target, self.plugin / "py_modules" / "oxp3deck" / "link.py")
        with self.assertRaisesRegex(self.bz.BuildError, "symbolic link"):
            self.build()

    def test_not_root(self):
        (self.plugin / "plugin.json").write_text(json.dumps({"name": "OXP3Deck", "flags": ["_root"]}))
        with self.assertRaisesRegex(self.bz.BuildError, "root"):
            self.build()

    def test_warnings(self):
        _out, _digest, plan = self.build(Path(self.tmp.name) / "other.zip")
        self.assertTrue(any("OXP3Deck.zip" in w for w in plan.warnings), plan.warnings)
        (self.plugin / "dist" / "index.js").write_text("// built for another name\n")
        os.utime(self.plugin / "dist" / "index.js", (1, 1))   # older than src/
        (self.plugin / "src").mkdir()
        (self.plugin / "src" / "index.tsx").write_text("")
        _out, _digest, plan = self.build()
        self.assertTrue(any("not built for plugin" in w for w in plan.warnings), plan.warnings)
        self.assertTrue(any("older than src/index.tsx" in w for w in plan.warnings), plan.warnings)


@unittest.skipUnless((PLUGIN / "dist" / "index.js").is_file(), "dist/index.js is missing: run pnpm build")
class RealBuildTest(unittest.TestCase):
    """The zip from this tree, built twice with the real command."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        base = Path(cls.tmp.name)
        cls.zips, cls.stdout = [], []
        for i in (1, 2):
            out = base / str(i) / "OXP3Deck.zip"
            res = subprocess.run([sys.executable, "-I", str(BUILDER), "--skip-checks", "--out", str(out)],
                                 capture_output=True, text=True, cwd=str(PLUGIN), stdin=subprocess.DEVNULL)
            if res.returncode != 0:
                cls.tmp.cleanup()
                raise AssertionError(f"build_zip failed: {res.stderr.strip()}")
            cls.zips.append(out)
            cls.stdout.append(res.stdout)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.zf = zipfile.ZipFile(self.zips[0])
        self.addCleanup(self.zf.close)
        self.infos = self.zf.infolist()

    def test_reproducible(self):
        self.assertEqual(self.zips[0].read_bytes(), self.zips[1].read_bytes())

    def test_prints_path_and_sha256(self):
        digest = hashlib.sha256(self.zips[0].read_bytes()).hexdigest()
        lines = self.stdout[0].splitlines()
        self.assertIn(str(self.zips[0]), lines)
        self.assertIn(f"sha256 {digest}", lines)

    def test_one_top_folder(self):
        self.assertEqual({i.filename.split("/", 1)[0] for i in self.infos}, {"OXP3Deck"})
        # Decky accepts a zip only with exactly one <folder>/plugin.json
        self.assertEqual([n for n in self.zf.namelist() if n.endswith("/plugin.json") and n.count("/") == 1],
                         ["OXP3Deck/plugin.json"])

    def test_file_list(self):
        files = {i.filename[len("OXP3Deck/"):] for i in self.infos if not i.is_dir()}
        dist = {p.relative_to(PLUGIN).as_posix() for p in (PLUGIN / "dist").rglob("*") if p.is_file()}
        backend = {f"py_modules/oxp3deck/{p.name}" for p in (PLUGIN / "py_modules" / "oxp3deck").glob("*.py")}
        expected = {"plugin.json", "package.json", "main.py", "bin/oxp3-tool", "bin/oxp3-tool.sha256",
                    "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md", "CREDITS.md"} | dist | backend
        self.assertEqual(files, expected)
        self.assertIn("dist/index.js", files)
        self.assertIn("py_modules/oxp3deck/__init__.py", files)
        self.assertIn("py_modules/oxp3deck/power.py", files)
        self.assertIn("py_modules/oxp3deck/powerhw.py", files)
        self.assertIn("py_modules/oxp3deck/extras.py", files)
        self.assertIn("py_modules/oxp3deck/readouts.py", files)
        self.assertIn("py_modules/oxp3deck/optiscaler.py", files)
        self.assertIn("py_modules/oxp3deck/autosetup.py", files)
        for i in self.infos:
            if not i.is_dir():
                self.assertEqual(self.zf.read(i), (self.source(i.filename)).read_bytes(), i.filename)

    def source(self, name):
        rel = name[len("OXP3Deck/"):]
        return PLUGIN / "vendor" / rel[len("bin/"):] if rel.startswith("bin/") else PLUGIN / rel

    def test_no_optiscaler_inside(self):
        """OptiScaler (GPL-3.0) is downloaded at run time, never shipped: no archive, DLL or OptiScaler file."""
        for name in self.zf.namelist():
            base = name.rsplit("/", 1)[-1].lower()
            self.assertFalse(base.endswith((".7z", ".dll", ".asi")), name)
            self.assertFalse(base.startswith("optiscaler") and base != "optiscaler.py", name)

    def test_no_bytecode(self):
        for name in self.zf.namelist():
            self.assertNotIn("__pycache__", name)
            self.assertFalse(name.endswith((".pyc", ".pyo")), name)

    def test_fixed_metadata(self):
        names = [i.filename for i in self.infos]
        self.assertEqual(names, sorted(names))
        for i in self.infos:
            self.assertEqual(i.date_time, (1980, 1, 1, 0, 0, 0), i.filename)
            mode = mode_of(i)
            if i.is_dir():
                self.assertTrue(stat.S_ISDIR(mode), i.filename)
                self.assertEqual(stat.S_IMODE(mode), 0o755, i.filename)
            else:
                self.assertTrue(stat.S_ISREG(mode), i.filename)
                self.assertEqual(i.compress_type, zipfile.ZIP_DEFLATED, i.filename)
                want = 0o755 if i.filename == "OXP3Deck/bin/oxp3-tool" else 0o644
                self.assertEqual(stat.S_IMODE(mode), want, i.filename)

    def test_bundled_tool_matches_its_checksum(self):
        tool = self.zf.read("OXP3Deck/bin/oxp3-tool")
        self.assertEqual(self.zf.read("OXP3Deck/bin/oxp3-tool.sha256").decode().split(),
                         [hashlib.sha256(tool).hexdigest(), "oxp3-tool"])

    def test_bundled_tool_is_new_enough(self):
        """OXP-1: the plugin offers its own copy when the installed one is older than MIN_VERSION; a copy below it
        would be offered and then refused by the install's own version gate."""
        from oxp3deck import oxp3tool
        version = load_builder()._tool_version(self.zf.read("OXP3Deck/bin/oxp3-tool"))
        self.assertGreaterEqual(oxp3tool.parse_version(version), oxp3tool.MIN_VERSION, version)
        self.assertIn(f"with oxp3-tool {version}", self.stdout[0])


if __name__ == "__main__":
    unittest.main()
