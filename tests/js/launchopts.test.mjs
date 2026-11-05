// Tests for src/launchopts.ts. Run from decky/: node --experimental-strip-types --test tests/js/*.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import { driverPrefix, fixTypo, fsrSupported, managed, parse, setManaged } from "../../src/launchopts.ts";

test("parse splits variables, wrappers and arguments", () => {
  const p = parse(`PROTON_LOG=1 XESS="latest" gamemoderun %command% -dx11  --skip`);
  assert.deepEqual(p.vars, [["PROTON_LOG", "1"], ["XESS", "latest"]]);
  assert.deepEqual(p.others, ["gamemoderun"]);
  assert.equal(p.after, "-dx11  --skip");
  assert.equal(p.hasCommand, true);
  assert.equal(p.typo, false);
  assert.deepEqual(managed(p), { XESS: "latest" });
});

test("quoted values keep their spaces", () => {
  const p = parse(`FOO='a b' BAR="c \\"d\\"" BAZ=e\\ f %command%`);
  assert.deepEqual(p.vars, [["FOO", "a b"], ["BAR", "c \"d\""], ["BAZ", "e f"]]);
});

test("empty and plain options", () => {
  assert.equal(setManaged("", { XESS: "latest" }), "XESS=latest %command%");
  assert.equal(setManaged("   ", { XESS_FG: "3" }), "XESS_FG=3 %command%");
  assert.equal(setManaged("%command%", { XESS: null }), "%command%");
  assert.equal(setManaged("", { XESS: null }), "");
});

test("text without %command% is game arguments", () => {
  assert.equal(setManaged("-dx11 -novid", { XESS: "dp4a" }), "XESS=dp4a %command% -dx11 -novid");
  assert.equal(setManaged("-dx11", { XESS: null }), "-dx11");
  assert.equal(setManaged("  -width 1280 +exec x.cfg -screen-height=720 ", { XESS_FG: "3" }),
    "XESS_FG=3 %command% -width 1280 +exec x.cfg -screen-height=720");
});

// FE-3: once %command% is in the line Steam runs it through a shell, so the old arguments must stay literal words
test("game arguments moved behind %command% stay literal", () => {
  // [the old text, the new line, the words the game gets]
  const cases = [
    ["-name (Player One)", "XESS_FG=3 %command% -name '(Player' 'One)'", ["-name", "(Player", "One)"]],
    ["-password $ecret", "XESS_FG=3 %command% -password '$ecret'", ["-password", "$ecret"]],
    ["-connect host&port", "XESS_FG=3 %command% -connect 'host&port'", ["-connect", "host&port"]],
    ["-a;reboot", "XESS_FG=3 %command% '-a;reboot'", ["-a;reboot"]],
    ["-mods=* -x <in >out |cat `id` $(id)", "XESS_FG=3 %command% '-mods=*' -x '<in' '>out' '|cat' '`id`' '$(id)'",
      ["-mods=*", "-x", "<in", ">out", "|cat", "`id`", "$(id)"]],
    ["-name \"Player One\" 'two words'", "XESS_FG=3 %command% -name 'Player One' 'two words'", ["-name", "Player One", "two words"]],
    ["-name Jörg -城市 ~ #x !y", "XESS_FG=3 %command% -name 'Jörg' '-城市' '~' '#x' '!y'", ["-name", "Jörg", "-城市", "~", "#x", "!y"]],
    ["-say it's", "XESS_FG=3 %command% -say 'it'\\''s'", ["-say", "it's"]],        // unclosed quote: every word as it is
    ["-x \"a b", "XESS_FG=3 %command% -x '\"a' b", ["-x", "\"a", "b"]],
    ["-empty \"\"", "XESS_FG=3 %command% -empty ''", ["-empty", ""]],
    // RC-3: a backslash is no escape character for the game (Windows paths); a no-break space is no separator
    ["-config C:\\Games\\cfg.ini", "XESS_FG=3 %command% -config 'C:\\Games\\cfg.ini'", ["-config", "C:\\Games\\cfg.ini"]],
    ["-path \"C:\\Program Files\\Game\\\" -x", "XESS_FG=3 %command% -path 'C:\\Program Files\\Game\\' -x",
      ["-path", "C:\\Program Files\\Game\\", "-x"]],
    ["a\\ b", "XESS_FG=3 %command% 'a\\' b", ["a\\", "b"]],
    ["-a\u00a0b -c\u00a0", "XESS_FG=3 %command% '-a\u00a0b' '-c\u00a0'", ["-a\u00a0b", "-c\u00a0"]],
    ["\t-x\t-y ", "XESS_FG=3 %command% -x -y", ["-x", "-y"]],
  ];
  for (const [before, line, words] of cases) {
    assert.equal(setManaged(before, { XESS_FG: "3" }), line, before);
    assert.equal(parse(line).hasCommand, true, line);
    // what a shell makes of the arguments behind %command%: exactly these words, nothing run, nothing expanded
    const args = line.slice(line.indexOf("%command%") + "%command%".length);
    const out = execFileSync("/bin/sh", ["-c", `printf '%s\\0' ${args}`], { encoding: "utf8", cwd: "/" });
    assert.deepEqual(out.split("\0").slice(0, -1), words, line);
  }
});

test("arguments after an existing %command% are never requoted", () => {
  const s = "%command% -name (Player One) $X \"a b\"";
  assert.equal(setManaged(s, { XESS: "latest" }), "XESS=latest %command% -name (Player One) $X \"a b\"");
  assert.equal(setManaged("XESS=dp4a gamemoderun %command% -a;b", { XESS: "latest" }), "XESS=latest gamemoderun %command% -a;b");
  assert.equal(setManaged("XESS=dp4a %command% it's", { XESS: null }), "%command% it's");
});

test("removing the last managed variable leaves nothing", () => {
  assert.equal(setManaged("XESS=latest %command%", { XESS: null }), "");
  assert.equal(setManaged("XESS=latest XESS_FG=3 %command%", { XESS: null, XESS_FG: null }), "");
  assert.equal(setManaged("XESS=latest %command% -dx11", { XESS: null }), "%command% -dx11");
  assert.equal(setManaged("XESS=latest gamemoderun %command%", { XESS: null }), "gamemoderun %command%");
});

test("other tokens keep their order and quoting", () => {
  const s = `PROTON_LOG=1 FOO="a b" gamemoderun mangohud %command% -arg "x y"`;
  assert.equal(setManaged(s, { XESS: "latest" }),
    `PROTON_LOG=1 FOO="a b" XESS=latest gamemoderun mangohud %command% -arg "x y"`);
  assert.equal(setManaged(s, { MESA: "26.1", force_vk_vendor: "-1" }),
    `PROTON_LOG=1 FOO="a b" MESA=26.1 force_vk_vendor=-1 gamemoderun mangohud %command% -arg "x y"`);
});

test("a changed value stays where it was", () => {
  assert.equal(setManaged("A=1 XESS_FG=2 B=2 %command%", { XESS_FG: "4" }), "A=1 XESS_FG=4 B=2 %command%");
  assert.equal(setManaged("A=1 XESS_FG=2 B=2 %command%", { XESS_FG: null }), "A=1 B=2 %command%");
});

test("duplicates collapse to one", () => {
  assert.equal(setManaged("XESS=dp4a XESS=latest %command%", { XESS: "latest" }), "XESS=latest %command%");
});

test("no change returns the text exactly", () => {
  const s = `  XESS="latest"   %command%   -x `;
  assert.equal(setManaged(s, { XESS: "latest" }), s);
  assert.equal(setManaged(s, { XESS_FG: null }), s);
});

test("FSR keys", () => {
  assert.equal(setManaged("%command%", { FSR: "xess", FSR_FG: "inject" }), "FSR=xess FSR_FG=inject %command%");
  assert.equal(setManaged("FSR=xess FSR_FG=inject %command%", { FSR: null, FSR_FG: "xess" }), "FSR_FG=xess %command%");
  assert.equal(fsrSupported("20261104"), true);
  assert.equal(fsrSupported("20261102-2"), false);
  assert.equal(fsrSupported("20261031"), false);
  assert.equal(fsrSupported("v1.3.2"), false);
  assert.equal(fsrSupported(null), false);
});

test("a %command typo is shown, never changed silently", () => {
  const s = "XESS=latest %command -dx11";
  const p = parse(s);
  assert.equal(p.typo, true);
  assert.equal(p.hasCommand, false);
  assert.equal(setManaged(s, { XESS_FG: "3" }), s);
  assert.equal(fixTypo(s), "XESS=latest %command% -dx11");
  assert.equal(parse("%command%").typo, false);
});

test("odd values are quoted", () => {
  assert.equal(setManaged("%command%", { MESA: "26 1" }), "MESA='26 1' %command%");
});

test("driver prefixes", () => {
  assert.equal(driverPrefix("26.3.0-rc2"), "26.3");
  assert.equal(driverPrefix("26.1.2"), "26.1");
  assert.equal(driverPrefix("odd"), "odd");
});

test("Start in DirectX 12: the argument goes after %command%, the user's text stays byte for byte", async () => {
  const { DX12_ARGS, dx12Arg, dx12Known, fgConfigured, hasArg, setArg } = await import("../../src/launchopts.ts");
  assert.deepEqual(DX12_ARGS, { "292030": "-dx12" });
  assert.equal(dx12Arg("292030"), "-dx12");
  assert.equal(dx12Arg("10"), "-dx12");          // the manual toggle's default for any game
  assert.equal(dx12Known("292030"), true);
  assert.equal(dx12Known("10"), false);
  // on: appended as the last argument
  assert.equal(setArg("", "-dx12", true), "%command% -dx12");
  assert.equal(setArg("XESS_FG=3 gamemoderun  %command%  --launcher-skip", "-dx12", true), "XESS_FG=3 gamemoderun  %command%  --launcher-skip -dx12");
  assert.equal(setArg("%command% --launcher-skip  ", "-dx12", true), "%command% --launcher-skip  -dx12");
  // without %command% the text is the game's arguments as they are: appended to it, nothing re-quoted
  assert.equal(setArg("--launcher-skip C:\\a.ini", "-dx12", true), "--launcher-skip C:\\a.ini -dx12");
  assert.equal(setArg("-name \"a", "-dx12", true), "-name \"a");    // unclosed quote: left alone
  // already there (also quoted): unchanged
  assert.equal(setArg("%command% '-dx12'", "-dx12", true), "%command% '-dx12'");
  assert.equal(hasArg("%command% '-dx12'", "-dx12"), true);
  assert.equal(hasArg("-dx12 %command%", "-dx12"), false);          // before %command% it is not a game argument
  assert.equal(hasArg("-x -dx12", "-dx12"), true);
  assert.equal(hasArg("%command% -dx121", "-dx12"), false);
  // an argument that needs quoting behind %command% gets literal quoting
  assert.equal(setArg("%command%", "-mode (dx12)", true), "%command% '-mode (dx12)'");
  assert.equal(hasArg("%command% '-mode (dx12)'", "-mode (dx12)"), true);
  // off: only that word (every copy) and the space in front of it
  assert.equal(setArg("A=1 %command% -dx12 --launcher-skip", "-dx12", false), "A=1 %command% --launcher-skip");
  assert.equal(setArg("A=1 %command%  --launcher-skip -dx12", "-dx12", false), "A=1 %command%  --launcher-skip");
  assert.equal(setArg("%command% -dx12 -x -dx12", "-dx12", false), "%command% -x");
  assert.equal(setArg("%command% -dx12", "-dx12", false), "");
  assert.equal(setArg("-dx12 -x", "-dx12", false), "-x");
  assert.equal(setArg("%command% -x", "-dx12", false), "%command% -x");
  // a %command typo is left alone
  assert.equal(setArg("XESS=latest %command -x", "-dx12", true), "XESS=latest %command -x");
  // a pipe, ";", "&&" or a comment after the game's arguments: the argument goes before it, not to the next command
  assert.equal(setArg("XESS_FG=2 %command% 2>&1 | tee /tmp/log", "-dx12", true), "XESS_FG=2 %command% 2>&1 -dx12 | tee /tmp/log");
  assert.equal(setArg("%command% --launcher-skip; echo done", "-dx12", true), "%command% --launcher-skip -dx12; echo done");
  assert.equal(setArg("%command% -x && true", "-dx12", true), "%command% -x -dx12 && true");
  assert.equal(setArg("%command% -x|tee l", "-dx12", true), "%command% -x -dx12|tee l");
  assert.equal(setArg("%command% -x # note", "-dx12", true), "%command% -x -dx12 # note");
  assert.equal(setArg("%command% >/tmp/l 2>&1", "-dx12", true), "%command% >/tmp/l 2>&1 -dx12");   // redirections are not operators
  assert.equal(setArg("%command% 'a|b'", "-dx12", true), "%command% 'a|b' -dx12");                 // quoted: an argument
  assert.equal(hasArg("%command% -dx12|tee l", "-dx12"), true);                                    // no second copy
  assert.equal(hasArg("%command% | grep -dx12", "-dx12"), false);                                  // grep's, not the game's
  assert.equal(setArg("%command% -dx12|tee l -dx12", "-dx12", false), "%command%|tee l -dx12");
  for (const t of ["A=1 %command% -x | tee l", "%command% ; echo", "%command% -y && b # c"])
    assert.equal(setArg(setArg(t, "-dx12", true), "-dx12", false), t);
  // round trip
  const user = "PROTON_LOG=1 %command%   -novid 'a b'";
  assert.equal(setArg(setArg(user, "-dx12", true), "-dx12", false), user);
  // frame generation set in the launch options
  assert.equal(fgConfigured("XESS_FG=3 %command%"), true);
  assert.equal(fgConfigured("FSR_FG=xess %command%"), true);
  assert.equal(fgConfigured("FSR=xess %command%"), true);
  assert.equal(fgConfigured("XESS=latest %command%"), false);
  assert.equal(fgConfigured("XESS_FG=0 %command%"), false);
});
