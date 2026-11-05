"""tools/vendor_oxp3_tool.py: only a matching, new enough oxp3-tool replaces vendor/."""
import hashlib
import importlib.util
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN = Path(__file__).resolve().parent.parent
SCRIPT = PLUGIN / "tools" / "vendor_oxp3_tool.py"


def load():
    name = "oxp3deck_vendor_script"
    if name not in sys.modules:
        spec = importlib.util.spec_from_file_location(name, SCRIPT)
        mod = importlib.util.module_from_spec(spec)
        sys.modules[name] = mod
        spec.loader.exec_module(mod)
    return sys.modules[name]


def fake_tool(version):
    return f"#!/usr/bin/python3 -I\nprint('oxp3-tool {version}')\n".encode()


def sums_of(data):
    return f"{hashlib.sha256(data).hexdigest()}  oxp3-tool\n"


class VendorTest(unittest.TestCase):
    def setUp(self):
        self.v = load()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.vendor = Path(self.tmp.name, "vendor")

    def test_min_version_is_the_plugins(self):
        sys.path.insert(0, str(PLUGIN / "py_modules"))
        try:
            from oxp3deck import oxp3tool
        finally:
            sys.path.pop(0)
        self.assertEqual(self.v.min_version(), tuple(oxp3tool.MIN_VERSION))

    def test_good_tool_is_installed(self):
        tool = fake_tool("0.4.1")
        self.assertEqual(self.v.check(tool, sums_of(tool), (0, 4, 1)), "0.4.1")
        self.v.install(tool, sums_of(tool), self.vendor)
        self.assertEqual((self.vendor / "oxp3-tool").read_bytes(), tool)
        self.assertEqual((self.vendor / "oxp3-tool.sha256").read_text(), sums_of(tool))
        self.assertEqual(stat.S_IMODE(os.stat(self.vendor / "oxp3-tool").st_mode), 0o755)
        self.assertEqual(sorted(os.listdir(self.vendor)), ["oxp3-tool", "oxp3-tool.sha256"])   # no temp files

    def test_refusals(self):
        tool = fake_tool("0.4.1")
        for data, sums, why in (
            (tool, "0" * 64 + "  oxp3-tool\n", "does not match"),
            (tool, "nonsense\n", "is not '<sha256>  oxp3-tool'"),
            (fake_tool("0.4.0"), sums_of(fake_tool("0.4.0")), "needs 0.4.1 or newer"),
            (b"#!/usr/bin/python3 -I\nprint('something else')\n",
             sums_of(b"#!/usr/bin/python3 -I\nprint('something else')\n"), "--version said"),
        ):
            with self.assertRaisesRegex(self.v.VendorError, why):
                self.v.check(data, sums, (0, 4, 1))

    def test_local_checkout_needs_dist(self):
        with self.assertRaisesRegex(self.v.VendorError, "is missing"):
            self.v.read_local(Path(self.tmp.name))

    def test_vendored_copy_is_valid(self):
        """The committed vendor/ is what build_zip packs: it must pass the same checks."""
        tool = (PLUGIN / "vendor" / "oxp3-tool").read_bytes()
        sums = (PLUGIN / "vendor" / "oxp3-tool.sha256").read_text()
        self.v.check(tool, sums, self.v.min_version())


if __name__ == "__main__":
    unittest.main()
