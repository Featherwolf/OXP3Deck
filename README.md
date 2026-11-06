# OXP3 Deck

A [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) plugin for the **ONEXPLAYER 3** (Intel Panther
Lake, Arc B390) on **CachyOS** (the Handheld Edition) and **Bazzite**. From one Quick Access panel in Game Mode, it
installs, sets up and updates two things, and it sets the power limits:

1. **oxp3-tool**, from [OXP3-Tool-for-Bazzite](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite): the controller,
   sleep and display fixes, the button layout and the kernel switch. The plugin runs `oxp3-tool` as root and shows
   what it says. It has no fixes of its own.
2. **xess-xmx-linux**, by [HHHHanasak1](https://github.com/HHHHanasak1/xess-xmx-linux): XeSS super resolution and
   frame generation on the GPU's XMX cores instead of the slower DP4a path, with patched Mesa drivers. The plugin
   also sets its per-game launch options for you.
3. **Power control**, built in: the sustained (PL1) and boost (PL2) power limits (TDP), the Arc GPU's clock range
   and the CPU's energy preference and boost, with a default profile, per-game profiles and optional separate values
   on AC. It replaces SimpleDeckyTDP on the OXP3 (see [Power](#power-tdp-and-gpu-clocks)).

It is modelled on [ClawDeck](https://github.com/IHulkSmashI/ClawDeck), the same kind of plugin for the MSI Claw (see
[Credits](#credits)).

> **Status: new, and not yet tested on a real device.** If something goes wrong, save a diagnose archive on the
> Updates & logs page and attach it to an issue.

## Install

You need Decky Loader. In Desktop Mode, open Konsole and run Decky's own installer as your user:

```bash
curl -L https://github.com/SteamDeckHomebrew/decky-installer/releases/latest/download/install_release.sh | sh
```

Then, in Game Mode:

1. Open Quick Access (the ONEX key) and go to Decky (the plug icon). Open Decky's settings (the gear).
2. Under **General**, turn on **Developer mode**.
3. Open **Developer**. Under **Install Plugin from URL**, enter this address and tap **Install**:

   ```
   https://raw.githubusercontent.com/Featherwolf/OXP3Deck/HEAD/release/OXP3Deck.zip
   ```

4. Confirm. OXP3 Deck appears in Decky's list.

You can also download [`OXP3Deck.zip`](release/OXP3Deck.zip) and pick it with **Install Plugin from ZIP File** >
**Browse**. Keep the file name `OXP3Deck.zip`: Decky uses it to find the installed copy it replaces.

To update the plugin, install it the same way again. Your settings and logs stay: they live outside the plugin's
folder.

## First steps

**Reading the settings.** Every row shows one short line. A label ending in **ⓘ** has more: move onto it and press
the **☰** (Options) button for its **Details** window (on a status line, **A** opens it too). Details say when a
setting takes effect, what to watch out for, how to fix a problem, and the technical names (PL1, EPP, service names,
paths). Steam Game Mode has no mouse hover, so there are no tooltips.

1. Open **OXP3 Deck** in Quick Access. **Status** shows the device and the system.
2. If the fixes tool (oxp3-tool) is missing or too old (the plugin needs 0.4.1 or later), tap **Install fixes tool**
   or **Update fixes tool**. It puts
   oxp3-tool at `/usr/local/bin/oxp3-tool`, where `get.sh` puts it, so `sudo oxp3-tool` keeps working in Konsole.
3. Tap **Apply recommended** under **Device fixes**. It shows the plan and asks first. If a fix needs a reboot,
   **Reboot to finish** appears.
4. Close any game, then tap **Install XeSS fast mode**. It downloads the newest release (about 16 MB) and runs its
   `install.sh` as your user. That script downloads Intel's shader compiler and XeSS SDK, a few hundred MB more, so
   this takes a while.
   - Already installed by hand, for example in `~/Documents/xess-xmx-linux-20261031`? The plugin finds it and
     shows it as installed. There is no need to install it again.
5. Log out and back in, or reboot. Steam keeps its old Vulkan driver settings until then.
6. Start a game and open Quick Access. **This game** shows its XeSS options.

## The pages

**Quick panel** (Quick Access):

- **Status:** the device and OS. A red **Do not reboot yet** line when oxp3-tool could not finish rebuilding the
  boot entries (its Details say what to run). **Reboot to finish** when a change waits for a reboot. The running
  task and its last log line (the whole log in its Details).
- **Power:** a **Live** line ("18.4 W · 62 °C · GPU 87 % · 3 h 10 min left"), the power limits now ("15 W steady ·
  25 W boost") and the active profile. **Power control (TDP)** on or off, then **Separate profile for <game>**,
  **Sustained power**, **Boost power**, **GPU maximum speed**, the [CPU and GPU controls](#cpu-and-gpu-controls) and
  **CPU boost**; then **Fan**, **CPU scheduler mode**, **Battery charge limit** and **Run from charger** where this
  system has them. Red lines when another power program is in the way, each with **Fix for me** where OXP3 Deck can
  turn it off for you (see [Other power managers](#other-power-managers)).
- **Device fixes:** Install or Update the fixes tool when it is missing or old. The recommended fixes not applied
  yet, with **Apply recommended**.
- **XeSS:** **XeSS fast mode: On / Off / Log out needed**, and Install, Update or Repair.
- **This game** (only while a game runs): the XeSS settings as dropdowns, and tips for that game.
- **All settings:** the full page, with these tabs.

**Power:** the power limits now (each interface in Details), the GPU speed, energy preference, boost and the power
source, then **Live readouts** (one value per row). The options (per-game profiles, different settings when plugged
in, up to 52 W when plugged in, **How often to check**), the editor
for every profile (also GPU minimum speed, energy preference and **Reset to device defaults**), **Other power
programs** (each with **Fix for me**, **Undo**, **I've handled it** or **How to fix**, and **Pause Intel's
low-power daemon in games**), **Battery**, **Turned off by OXP3 Deck**
(with Undo), the device's own values, and **Import from SimpleDeckyTDP**.

**Fixes:** every oxp3-tool fix with its state, notes and when it takes effect. Apply and Revert for each one. Both
show the plan first.

**Buttons:** what each key does (keyboard, Home, ONEX and Xbox keys), the frame-limit value, and **Apply layout**.
That applies the `buttons` fix, and `xbox-key` too when your Xbox key needs its helper.

**XeSS:** the installed version and folder, the driver check, the default Mesa driver for all games, Install,
Update, Repair and Uninstall. Also the system Protons and whether they have the shim, missing tools, downloads
`install.sh` could not fetch, and old package folders you can remove.

**Games:** the running game, or the last one. The same options as the quick panel, plus the full advice: the XeSS
version in the game's folder, which Proton it uses, and what its last run logged (XMX, a fallback to DP4a, a kernel
that did not compile).

**Kernel** (CachyOS with Limine only): the installed kernels and what boots next. **Try** boots another kernel once.
If it hangs, hold the power button: the next boot is the kernel you have now, with no keyboard needed. **Keep**, on
the kernel you want, sets Limine back to booting whatever booted last. See
[Trying another kernel](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite#trying-another-kernel-cachyos).

**Updates & logs:** oxp3-tool and xess-xmx-linux versions with update checks, the diagnose archive, and the last
tasks with their logs.

## Power (TDP and GPU clocks)

Off until you turn **Power control (TDP)** on (Quick Access → OXP3 Deck → Power). Then OXP3 Deck sets, from the active
profile:

- **Sustained power** (PL1, the long-term limit) and **Boost power** (PL2, a few seconds above it), written to
  **both** of the CPU's power-limit interfaces, `intel-rapl` (MSR) and `intel-rapl-mmio`. The CPU obeys the lower of
  the two, and the Arc GPU follows the MSR one: with only MMIO set (what SimpleDeckyTDP does), the GPU stays held at
  about 33 W. The firmware also rewrites the MMIO limits whenever the charger goes in or out, so OXP3 Deck writes
  them again after every AC change and every resume. PL4 and the other zones are never touched; if another tool
  left PL4 (the peak limit) below the boost limit, a red line says so (a reboot restores it).
- **GPU min and max clock** on the xe driver (the render GT only; the media engine keeps its own range).
- **Energy preference (EPP)** and **CPU boost** (turbo), on the full page; CPU boost is in Quick Access too.

**Range.** Sustained 5 to 35 W on battery and up to 40 W on AC (ONEXPLAYER's own figures for the OXP3: 35 W
sustained, "up to 40 W"). **Allow up to 52 W when plugged in** on the Power tab goes up to the firmware's own boost limit
(52 W): use a charger of 65 W or more, a weaker one cannot keep up. Boost is never below sustained and never above
the firmware's boost limit. On another device the limits never go above what its firmware set.

**Profiles.** The default profile starts with every value at "device default" (the value the system booted with), so
turning control on changes nothing until you move a slider. **Separate profile for <game>** gives the running game
its own copy; it is used whenever that game runs (per-game profiles on). With **Different settings when plugged
in**, each profile
has a second set for when the charger is in. Profiles are re-applied after sleep, on a game change and on AC
changes.

**Turning it off or rebooting gives the firmware values back.** Turning TDP control off writes back the values read
when TDP control first changed something this boot (if another tool had changed a limit before that, its value is
what comes back; a reboot gives the firmware's own); a reboot resets them anyway. Updating, reloading or uninstalling OXP3 Deck
leaves the current limits in place until the next reboot (Decky runs the same cleanup for an update as for an
uninstall, and a game's limits should not drop mid-session).

**It does not fight.** If something else changes a limit OXP3 Deck set (outside the few seconds after an AC change
or a resume, when the firmware does that), it stops writing and shows a red line with the likely culprit and
**Take control again**. Nothing is written in a loop.

**How often to check** (Power tab): how often OXP3 Deck checks that your settings are still in place and tries again
what the device did not take (the GPU busy resetting or resuming): Off, or every 2 to 60 s (default 2 s). Off still
re-applies after a game change, the charger and sleep.

### CPU and GPU controls

While power control is on, each profile (default, per game, plugged in) also has:

- **CPU speed cap** (30–100 %): every core at most this share of its top speed. Lower leaves more of the power limit
  to the GPU in GPU-heavy games; 60–70 % is a good start on battery.
- **CPU vs GPU balance** (1–5, 3 = device default): a hint to the chip's firmware, 1 favours the CPU and 5 the GPU.
  Works only while the system's power mode is Balanced (power-profiles-daemon's Balanced uses it too); OXP3 Deck
  never switches the power mode itself. The Power tab adds **Let the chip save more** (0–3).
- **GPU power saving**: the GPU speeds up more slowly. Good with a frame limit.
- **CPU minimum speed (plugged in)**: from the device's own floor to 50 %, used only on the charger.
- **Show advanced CPU options**: a speed cap per core type (performance, efficient, low-power cores), instead of the
  CPU speed cap (switching asks first), and an energy preference per core type.

None of these is measured on the device yet; their Details say what to expect. They reset at reboot and when power
control is turned off. Intel's low-power daemon and TuneD lock the CPU ones while they run (the control says so).

### Fan, battery, scheduler (when available)

- **Fan** (Auto, Quiet about 40 %, Max), per profile. Quiet goes back to Auto at 90 °C (Max stays, it is already
  full speed); both go back when the temperature cannot be read, on any error, before sleep and when OXP3 Deck stops.
- **Battery charge limit** (50–100 %) and **Run from charger** (while awake and plugged in, the battery is left
  alone; it still charges asleep). These follow the battery, not the profile.
- Fan and battery need Linux 7.4 or newer on the ONEXPLAYER 3 (the Power tab says so on an older kernel).
- **CPU scheduler mode** (CachyOS's LAVD scheduler through scx_loader: Auto, Gaming, Power save), per profile; only
  while scx_lavd runs. OXP3 Deck never starts a scheduler and puts the previous mode back.
- **Pause Intel's low-power daemon in games** (Power tab, only while intel_lpmd runs): off while a game runs, back to
  automatic afterwards.

If another program (Handheld Daemon, steamos-manager, CachyOS's power switch) changes one of these, OXP3 Deck stops
and shows **Take control** instead of fighting it.

### When it takes effect

Every setting shows it after its one line, and again in its confirm dialog: **Now**, **Restart the game**, **Log
out of Game Mode or reboot**, **Reboot** or **Only while no game runs**. After a change that waits, a row under the
control says what to do ("Restart Cyberpunk 2077 to apply"). A greyed-out control says why instead of its line.

### Moving from SimpleDeckyTDP

1. On the **Power** tab (Quick Access → OXP3 Deck → More), tap **Import from SimpleDeckyTDP**. It copies its default
   and per-game TDP, GPU clock range and CPU boost values (per-game profiles and AC profiles only if they were on in
   SimpleDeckyTDP); its single TDP value becomes the sustained limit, and boost stays at the firmware's.
   SimpleDeckyTDP's files are left alone.
2. **Uninstall SimpleDeckyTDP first, or at least disable it**: Decky's settings (the gear) → **Plugins** → the menu
   next to SimpleDeckyTDP → **Uninstall** (or **Disable**). Two plugins setting the same limits undo each other;
   OXP3 Deck refuses to turn on while SimpleDeckyTDP (or PowerControl / PowerTools) is enabled.
3. Turn **Power control (TDP)** on.
4. In Steam's own Quick Access → **Performance**, turn off **TDP limit** and **Manual GPU clock**: Steam then
   changes the same limits.

### Other power managers

OXP3 Deck finds the other power managers that would fight it and shows each one with a short line. Those marked
"blocks" keep TDP control from turning on (and pause it if they start later); those marked "EPP" only leave the
energy preference and CPU boost to them. **Details** (the ☰ button) explains each one and how to turn it off
yourself.

**Fix for me.** For the system services in the table, OXP3 Deck can turn the service off for you: tap **Fix for
me**, read the dialog (it names the service and the exact commands), and confirm. OXP3 Deck then stops and disables
that service (`systemctl stop` and `systemctl disable`, as root). power-profiles-daemon, tuned-ppd, tuned, thermald
and intel_lpmd start again whenever another program asks for them over D-Bus (the desktop's power mode switch,
Steam, CachyOS's game-performance), so for these five, and only these, it also **masks** the service
(`systemctl mask`), so nothing can start it until you undo it; the dialog says so and what stops working (for
power-profiles-daemon: KDE's power profiles switch and Steam's or game-performance's profile switching). It will not
mask over an admin's own unit file in `/etc/systemd/system` (it says so and changes nothing), never uninstalls a
package and never changes another Decky plugin, and it never does this on its own: only after you confirm. It
remembers what it changed, so **Undo** puts back exactly what was there (unmasks what it masked, enables what was
enabled, starts what was running), also after a reboot. Bazzite's update can turn PowerStation back on: OXP3 Deck
then shows it as back and offers **Fix again**; it never repeats the fix by itself. **I've handled it** acknowledges the ones where only you can tell
whether they still set the limits.

| Found | Effect | Fix for me | Do it yourself |
|---|---|---|---|
| SimpleDeckyTDP, PowerControl or PowerTools (Decky plugins) | blocks | no | Decky → Settings → Plugins: disable or uninstall it (import from SimpleDeckyTDP first) |
| PowerStation (`powerstation.service`, Bazzite) | blocks | yes | `sudo systemctl disable --now powerstation.service`; Steam's TDP slider uses it, and a Bazzite update may turn it back on |
| thermald | blocks | yes (also masked) | `sudo systemctl disable --now thermald.service`: on this CPU it rewrites the sustained limit within seconds |
| Handheld Daemon (`hhd`) | blocks, can be acknowledged | no (it may run the controller) | turn off TDP control in Handheld Daemon's settings, then **I've handled it** |
| `oxp3-tdp-sync.service` | blocks | yes | `sudo systemctl disable --now oxp3-tdp-sync.service` (it copies MMIO PL1 into MSR; OXP3 Deck writes both) |
| `onex3-tdp.service` | blocks | yes | `sudo systemctl disable --now onex3-tdp.service` |
| a steamos-manager TDP remote (`remotes.d` file with `TdpLimit1`) | blocks, can be acknowledged | no | turn Steam's **TDP limit** off in Quick Access → Performance, then **I've handled it** |
| power-profiles-daemon | EPP | yes (also masked) | `sudo systemctl disable --now power-profiles-daemon.service` |
| tuned / tuned-ppd | EPP | yes (also masked) | `sudo systemctl disable --now tuned-ppd.service tuned.service` |
| intel_lpmd (CachyOS enables it on this CPU) | EPP | yes (also masked) | `sudo systemctl disable --now intel_lpmd.service` (it sets EPP and parks cores, not the power limits) |

**The thermald trade-off.** Disabling thermald does not leave the OXP3 unprotected: the SoC's own thermal limit
(it throttles at its maximum temperature) and the fan curve still apply. What you lose is thermald lowering PL1
early to keep the case cooler; set a lower sustained limit instead if the device gets too warm in your hands.

## How updates work

### oxp3-tool

- The plugin carries its own copy (`bin/oxp3-tool`, checked against its SHA-256). Updates & logs compares the
  installed version with that copy and with the newest one on GitHub.
- **Update** installs either the plugin's copy or the newest `dist/oxp3-tool` from GitHub (the file `get.sh`
  installs), checked against its published SHA-256.
- Fixes you applied keep working. If `status` says a helper is from an older version, apply that fix again.

### xess-xmx-linux

- **Each release gets its own folder** in `~/.local/share/oxp3deck/xess/`, such as `xess-xmx-linux-20261104`.
  Unpacking over the old folder would break the driver that Steam and games have loaded.
- **An update** runs the old folder's `uninstall.sh`, then the new folder's `install.sh`, both as your user. Then
  log out and back in. The compiler and the SDKs are copied from the old folder when the new release downloads the
  same versions (from 20261031 to 20261104 that saves the compiler's 95 MB).
- **The old folder stays** until after that re-login, because Steam still uses its driver until then. The XeSS page
  lists it under old package folders, with a button to remove it; not while it has the only compiler (the new
  folder's download failed). A git checkout, or a folder not named `xess-xmx-linux-<tag>` that the plugin did not
  install, is yours to delete: the page lists it without a Remove button.
- **A hand install** such as `~/Documents/xess-xmx-linux-20261031` is adopted: the plugin shows it, and updates it
  the same way. Its folder is kept like any old folder.
- **Update** is offered only for a release newer than the installed one. **Repair** runs `install.sh` of the
  installed release again in its folder, with nothing uninstalled, when the plugin finds it unfinished (for
  example the compiler download failed); the button says why. Repair also works when GitHub cannot be reached
  or is limiting requests, since it needs no release lookup.
- **Your default Mesa driver is kept** when you chose it on the XeSS page. Each release brings its own default. The
  plugin remembers your choice and sets it again after an update. A driver switched by hand with
  `tools/switch-driver.sh` is not carried over: pick it on the XeSS page once.
- **System Protons** such as CachyOS's `proton-cachyos-native` and `proton-cachyos-slr` live in
  `/usr/share/steam/compatibilitytools.d`, where `install.sh` cannot write. Games on them would stay on DP4a. The
  plugin adds the shim to them as root at the end of Install and Update, and when you tap the button on the XeSS
  page, and keeps the stock file next to it. A pacman update of such a Proton brings the stock file back; the
  plugin then adds the shim again when it next starts (at boot), or when you tap the button.
- **Check for an update** only asks GitHub for the newest release. It changes nothing.

## Per-game launch options

The plugin writes these into the game's Steam launch options, before `%command%`. A change applies at the game's
next start. No re-login is needed.

| Option | What it does | When to use it |
|---|---|---|
| `XESS=latest` | The game uses the XeSS libraries of Intel's XeSS SDK instead of its own older ones. They are swapped in only while the game runs, so Steam still sees the game as shipped. | The game's XeSS is older than 2.0.2.68 (XeSS then looks like DP4a, or offers no frame generation), or simply old. The Games page says so. |
| `XESS=dp4a` | XeSS without Intel's extension: super resolution on DP4a, frame generation on its generic path (2x only). | Comparing, or ruling out the XMX path as the cause of a problem. |
| `XESS_FG=2`, `3`, `4` | XeSS frame generation makes 2x, 3x or 4x frames, whatever the game's menu chooses. Frame generation must still be on in the game. | A game that offers only 2x. |
| `XESS_FG=5` to `8` | **Experimental**: beyond what Intel supports. 7x and 8x add a lot of latency. | A high refresh rate display that 4x does not fill. |
| `MESA=26.1`, `MESA=26.3` | This game uses that patched Mesa driver instead of the default. | A game misbehaves on one of the drivers. |
| `force_vk_vendor=-1` | Hides the Intel GPU from the game, so Mesa's own profile for it applies. XeSS then runs on DP4a. | A game that needs Mesa's workaround. |
| `XESS_LOG=1` | Writes the shim's, XeLL's and XeSS frame generation's logs into the game's prefix (`C:\igdext_trace.log`, `igdext_xell.log`, `igdext_xefg.log`, `igcl_stub.log`). | A bug report. |
| `FSR=xess` | The game's FSR 3.1+ upscaling runs on XeSS super resolution, and its FSR frame generation on XeSS frame generation. Needs xess-xmx-linux 20261104 or later. | A game with FSR 3.1+ and no XeSS. A game that has XeSS should use it. |
| `FSR_FG=xess` | Only the game's FSR frame generation runs on XeSS frame generation. Needs 20261104 or later. | As `FSR=xess`, but keeping the game's own FSR upscaling. |
| `FSR=xess FSR_FG=inject` | Adds XeSS frame generation to a game with FSR 3.1+ upscaling but no FSR frame generation. Needs 20261104 or later. | A game whose frame generation is DLSS only. |

- `XESS`, `XESS_LOG`, `FSR` and `FSR_FG` work through a small hook that `install.sh` puts into each Proton it can
  write to. The Games page says whether the game's Proton has the shim and the hook. Without the shim, XeSS stays on
  DP4a.
- Keep a frame limit on with frame generation, or the generated frames reach the screen unevenly.
- **Start in DirectX 12** (per game): adds the game's DirectX 12 argument (`-dx12`) after `%command%`, as its last
  argument; your own text stays as it is. The Witcher 3 needs it for XeSS frame generation (its menu option stays on
  only in DirectX 12; add `--launcher-skip` yourself to skip its launcher). Other games may not know `-dx12`.
- **Frame generation is refused** (Games tab): with **Save XeSS logs** on, the plugin reads the end of
  `C:\igdext_xefg.log` in the game's prefix. When it says "Latency reduction is not enabled" and
  `xefgSwapChainSetEnabled(1) -> -15`, turn on **Xe Low Latency** in the game's graphics menu; the Details show the
  log's lines and when it was written.
- **Set up games automatically** (Games tab, XeSS tab and Quick Access "This game"; off until you turn it on and
  confirm one dialog that lists what it may change). With it on, OXP3 Deck sets up each game by itself, only while
  the game is not running: a few seconds after you quit it, when you open its settings, or when a library scan
  (20 s after loading, then every 10 minutes while no game runs, at most 8 games each time) first sees it.
  - Games it knows (its OptiScaler tables, its known issues, the DirectX 12 list) get their best known setup:
    OptiScaler where the table says it helps (The Witcher 3: XeSS with XeFG 2x through DLSS frame generation),
    `-dx12`, `XESS=latest` where the game needs it, and launch options known to crash the game taken out (Monster
    Hunter Wilds: `XESS_FG`, `FSR`, `FSR_FG`). Other games only get what can only help (`XESS=latest` for old XeSS);
    OptiScaler and `FSR=xess` are offered ("Also possible: …", **Use it**), never applied by themselves.
  - **Proton**: a game that uses XeSS or OptiScaler and whose Proton lacks the xess-xmx-linux hook (for example the
    system proton-cachyos, or no Proton found) is moved to the newest installed GE-Proton with the hook (else Proton
    Experimental); its row says "Proton changed to GE-Proton11-11 for XeSS" with **Undo**. A Proton you picked for a
    game yourself is never changed (you get an offer instead). Without a suitable Proton the row says how to get one
    (ProtonUp-Qt or a Decky Proton manager for GE-Proton, Steam's Tools for Proton Experimental, then restart Steam).
  - Never for anti-cheat or online games, never over an existing file, never for a game in **Manual**. Each game has
    **Set up this game: Automatic / Manual**; any change you make to it by hand (its XeSS options, OptiScaler, an
    Undo, its launch options edited in Steam, another Proton picked) switches it to Manual, and a game you had set up
    yourself starts as Manual. Picking Automatic again applies the whole plan.
  - Each change has a row with why and **Undo**. If the game closes within a minute after a change (also when you
    quit it that quickly yourself), or three times in a row, the change is undone before its next start and the row
    says so, with **Try again**.
  - It replaces 0.4's "Add needed launch options automatically": an old "Added: XESS=latest" row keeps its Undo, and
    keys you removed then are not added again.
- Everything else in the launch options stays as you wrote it: wrappers such as `gamemoderun`, other variables, and
  the game's own arguments. Options without `%command%` are game arguments, so the plugin writes
  `VARIABLES %command% ARGUMENTS`, with each argument in quotes where the shell would read it otherwise
  (`-name (Player One)` becomes `-name '(Player' 'One)'`; a backslash, as in `C:\Games\cfg.ini`, stays as it is).
  A `%command` without its closing `%` is shown as a warning.
- **Copy launch options** (the game's section in Quick Access and on the Games tab): the whole launch line, your
  own text plus the options above, with a Copy button. It is there when OXP3 Deck cannot set it itself (Steam
  refused or kept other text, a non-Steam game, Steam did not return the options, the game needs an option that waits
  until you quit it, or a game the automatic setup leaves alone) and also when you just want a copy. Paste it into the game's
  Properties → General → Launch options; it applies when you start the game again. When copying does not work in
  Game Mode, the line shows in a text field to copy with Steam's keyboard.

## OptiScaler (any game; tested setup for The Witcher 3)

Every Steam game's section (the Games tab and Quick Access) has an **OptiScaler** part. OptiScaler sits between the
game and its upscaler: when the game asks for DLSS, FSR 2+ or XeSS, OptiScaler runs XeSS or FSR 3.1 instead, and in
DirectX 12 games XeSS frame generation (XeFG) in place of the game's frame generation, driving Xe Low Latency itself.
It only works in games that already offer DLSS 2+, FSR 2+ or XeSS. There are three kinds of setup, and the row says
which one a game gets:

- **The Witcher 3: the tested setup.** Its own XeSS frame generation does not start on this device ("Latency
  reduction is not enabled"); the game is set to DLSS and DLSS frame generation and OptiScaler runs XeSS and XeFG in
  their place. This is the setup from ETA Prime's video on the same chip; **it is not tested on the ONEXPLAYER 3
  with this plugin yet**.
- **About 40 games OptiScaler's wiki documents** (Cyberpunk 2077, Black Myth: Wukong, Hogwarts Legacy, the Spider-Man,
  Horizon and Last of Us ports, …): the exe folder, the file name and what to pick in the game follow the game's wiki
  page. Not tested on this device.
- **Any other game: experimental.** OXP3 Deck finds the game's exe (Unreal's `…/Binaries/Win64/*-Shipping.exe`,
  Unity's `<Name>.exe`, else the largest exe near the top that is not a launcher, crash reporter, installer,
  editor, server or tool), its graphics API
  (from its files and the DLLs the exe loads) and a file name the folder does not have yet (`dxgi.dll` first; never
  over an existing file). The steps in the game are the generic ones: pick DLSS, FSR or XeSS (and its frame
  generation, if you turn that on) in the game's graphics settings.

DirectX 11 and Vulkan games get the upscaler only: OptiScaler's frame generation needs DirectX 12. Not offered, with
the reason in the row: games with anti-cheat files (EasyAntiCheat, BattlEye, EA AntiCheat, ACE, …), online games
(Counter-Strike 2, Dota 2, Path of Exile 2, …; OptiScaler's guide says not to use it with online games), games whose
only documented setup needs another mod (REFramework for the Capcom games, OptiPatcher for DOOM Eternal on Intel, ERSS-FG for ELDEN RING;
Palworld, Ghostrunner, Avowed and Jedi: Survivor, whose only input DLSS needs OptiPatcher or the GPU spoof, …),
native Linux games (OptiScaler needs the Windows version under Proton), DirectX 9 and OpenGL games, and a game whose
API cannot be told from its files.

OptiScaler is not part of OXP3 Deck: it is downloaded from its GitHub release when you tap Install (GPL-3.0, pinned by
its checksum, about 69 MB, once). XeSS fast mode (xess-xmx-linux) is still needed for XeSS on the XMX cores. On every
game OXP3 Deck turns OptiScaler's GPU spoof off (`Spoofing Dxgi=false`): with it, XeSS runs on the slower path on
Intel; the cost is that some games then hide DLSS, so pick FSR or XeSS in them.

1. Quit the game. Tap **Install OptiScaler for this game** and confirm. The files go into the game's exe folder (for
   The Witcher 3 `bin/x64_dx12`) as your user. Install stops if the folder already has another OptiScaler (and, for
   The Witcher 3, a dxgi.dll); the game's own files are not touched.
2. Pick the **Upscaler** (XeSS, or FSR 3.1) and, in DirectX 12 games, **Frame generation** (Off, XeFG 2x, 3x or 4x;
   The Witcher 3 starts at 2x, every other game at Off). On the Games tab, **Game setting it replaces** chooses which
   of the game's settings OptiScaler takes over (for The Witcher 3 DLSS frame generation by default; XeSS frame
   generation if DLSS is greyed out in the game).
3. **In the game, once** (its Details have the steps). The Witcher 3: start the game; Display mode Borderless;
   Upscaling DLSS; Frame Generation DLSS Frame Generation on; quit and start it again once; OptiScaler's menu (Insert
   on a keyboard) should show XeSS and FG Output XeFG. Other games: pick what the row says (or DLSS, FSR or XeSS),
   restart once, check OptiScaler's menu. **Show OptiScaler's FPS counter** (Games tab) helps check it works.

The launch options change with it, never while the game runs (then a few seconds after you quit it): `XESS=`,
`FSR=`, `FSR_FG=` and `force_vk_vendor=` come out while OptiScaler is in the game (`XESS=latest` is not needed),
`XESS_FG=<n>` follows OptiScaler's frame generation, `WINEDLLOVERRIDES` gains `<name>=n,b` for OptiScaler's file
name (`dxgi=n,b` for The Witcher 3), 3x and 4x add `DXVK_CONFIG="dxgi.customVendorId = 8086"`, and `-dx12` is added
after `%command%` for The Witcher 3 (and the few games whose wiki page asks for it); your own entries in these
variables stay. The XeSS options above OptiScaler's are greyed with "Set by OptiScaler for this game." **Copy launch
options** includes OptiScaler's options too.

**Remove OptiScaler** deletes its files (a file changed since is kept and listed), puts the game's files back and
gives the launch options back what OptiScaler replaced (exactly the text from before, when you have not changed it
since). **Update** appears when a new OXP3 Deck pins a newer OptiScaler build and keeps your choices. Uninstalling
OXP3 Deck does not remove OptiScaler from a game: remove it from each game first. Another OptiScaler (Decky Framegen,
a manual copy) is left alone and refused. If an experimental setup does not work (the game does not start, or
OptiScaler's menu never shows), tap Remove: the game may need another file name or setup, and OptiScaler's wiki may
have a page for it.

## What it never does

- **It changes nothing without a tap.** Fixes, installs, updates and reboots ask first.
- **Uninstalling the plugin reverts nothing and removes nothing.** Decky runs the same cleanup on every update of a
  plugin, so the plugin cannot tell a removal from an update. To undo things, use the buttons first: Revert on the
  Fixes page, Uninstall on the XeSS page. To remove oxp3-tool itself, see
  [Uninstall](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite#uninstall).
- It never runs xess-xmx-linux's scripts as root. They run as your user, with a clean environment, so nothing of
  Decky's ends up in your session.
- It never stops a running oxp3-tool or xess-xmx-linux script halfway.
- It installs no system packages. The XeSS page lists tools that are missing, for you to install with pacman.
- It changes no launch option except the ones in the table above, and OptiScaler's (`WINEDLLOVERRIDES`,
  `DXVK_CONFIG` and `-dx12`, only for a game you install OptiScaler into).
- **Uninstalling or disabling leaves the current power limits, GPU clock range and energy preference until the
  next reboot.** Turn TDP control off first to get the firmware's values back at once (SimpleDeckyTDP cannot reset
  the xe GPU clocks if you go back to it).
- It writes no power limit until you turn TDP control on, never PL4 or the GPU's media engine. It stops and
  disables another power manager's service only when you tap **Fix for me** and confirm (it masks only the five
  D-Bus-started ones listed above, never uninstalls anything, and Undo unmasks and turns it back on).

## Troubleshooting

- **The plugin's log** is in `~/homebrew/logs/OXP3Deck/`, one file per start (Decky keeps the newest few).
- **Updates & logs** shows the last tasks and their full logs. **Save a diagnose archive** writes
  `~/oxp3-diagnose-<time>.tar.gz`. Attach it to an issue.
- **Do not reboot** (red): a boot-entry rebuild did not finish. Reboot only after the command the warning names has
  run without errors. See [CachyOS](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite#cachyos).
- **A task shows "interrupted"** after Decky or the plugin restarted or was updated: the plugin stopped following
  it, but what it started (oxp3-tool, install.sh, uninstall.sh) runs to its end. Open the page again when it has
  ended to see the result. The plugin does not reboot while oxp3-tool still runs, and the XeSS buttons wait while
  such an xess-xmx-linux script still runs (the XeSS page says so).
- **Re-login needed:** XeSS was installed or updated, but Steam still runs with the old driver settings. Log out and
  back in, or reboot.
- **XeSS driver check failed:** the XeSS page shows the line from `~/.cache/xess-xmx/driver-status`.
  `journalctl --user -u xess-xmx-check` has the details. When the new driver fails that check at the end of an
  install or update, the plugin runs the check again at once: it switches to the package's other driver, or to the
  system's stock driver (XeSS on DP4a). When an install or update ends with "Reboot (not just log out)", that did not
  work: reboot, because the check runs again at boot, and after only a log-out Game Mode may not start.
- **Steam from Flathub** (Flatpak) is not supported by xess-xmx-linux. The XeSS page says so.
- **The panel shows an error or does not load:** restart Decky with `sudo systemctl restart plugin_loader`, or
  reboot.
- **OptiScaler "Needs 7z or bsdtar":** the archive is 7z. On CachyOS install `7zip` (`sudo pacman -S 7zip`); on
  Bazzite `bsdtar` is usually there, else `rpm-ostree install p7zip` and reboot. Nothing downloaded is ever run.
- The plugin keeps its settings in `~/homebrew/settings/OXP3Deck/settings.json` (OptiScaler's record of what it put
  into each game in `optiscaler.json` next to it) and task logs in `~/homebrew/data/OXP3Deck/jobs/`. The downloaded
  OptiScaler stays in `~/.local/share/oxp3deck/optiscaler/` for the next install.

## Building from source

```bash
pnpm install
pnpm build    # the frontend: dist/index.js
pnpm zip      # release/OXP3Deck.zip (python3 tools/build_zip.py)
```

`tools/build_zip.py` packs the frontend, `main.py`, `py_modules/oxp3deck/*.py`, the docs and
`vendor/oxp3-tool` (checked against `vendor/oxp3-tool.sha256`) into one `OXP3Deck/` folder. The same files always
give the same zip. `--out FILE` writes it elsewhere.

`vendor/oxp3-tool` is a copy of `dist/oxp3-tool` from [OXP3-Tool-for-Bazzite](https://github.com/Featherwolf/OXP3-Tool-for-Bazzite). To bundle a newer one:

```bash
python3 tools/vendor_oxp3_tool.py                  # the newest on GitHub (or --ref v0.4.1)
python3 tools/vendor_oxp3_tool.py --from ../OXP3-Tool-for-Bazzite   # a local checkout
pnpm zip
```

It only replaces `vendor/` when the file matches its SHA-256 and is at least the version the plugin needs
(`MIN_VERSION` in `py_modules/oxp3deck/oxp3tool.py`).

Releases: set the version in `package.json`, run `pnpm build && pnpm zip`, add the notes as
`release-notes/v0.2.0.md`, commit, then run Actions > Release > Run workflow with the version (`0.2.0`). It checks
that the version, `package.json` and the zip agree, creates the tag, and publishes `OXP3Deck.zip` with its SHA-256.
Versions below 1.0.0 are marked pre-release. Pushing an annotated tag works too; its message becomes the notes.

Tests:

```bash
python3 -m unittest discover -s tests -t . -v
ruff check .
node --experimental-strip-types --test tests/js/*.test.mjs   # launch options, xess offers (Node 22.6+, python3, sh)
pnpm typecheck
```

[DESIGN.md](DESIGN.md) describes how the backend and the frontend fit together.

## Credits

OXP3 Deck is modelled on [ClawDeck](https://github.com/IHulkSmashI/ClawDeck) by IHulkSmashI (MIT), and some of its
code is adapted from it. It drives [xess-xmx-linux](https://github.com/HHHHanasak1/xess-xmx-linux) by HHHHanasak1
(MIT), runs in [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader), and its build setup comes from
[decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template). [CREDITS.md](CREDITS.md) lists
the projects it builds on and what each one gives.

## License

OXP3 Deck is under the MIT License ([LICENSE](LICENSE)). The plugin zip also holds third-party code under its own
licences; [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists it with the licence texts.
