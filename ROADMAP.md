# OXP3 Deck and oxp3-tool roadmap

This is the ranked improvement plan from a full review of both projects (November 2026): six reviews (real-world
performance, interface, future-proofing, ease of use, reliability, other tools), checked against the code, then
challenged by a completeness review whose corrections are at the end and take precedence. No fps, watt or battery
figure here is measured on a device yet; the device self-test (Tier 1) is there to replace those estimates.

## Build order (amended Tier 1)

Performance items first, then the rest:

- [x] VRR guidance for kernels with the fix (N-1) (0.5.0)
- [x] Device self-test and 60 s measurement (N-2) (0.5.0)
- [x] One-tap presets: Battery / Balanced / Performance / Max / Custom (T1-2) (0.5.0)
- [x] Low-battery profile slot (N-4) (0.5.0)
- [x] Background sampler and per-game TDP advisor, read-only until tapped (T1-11) (0.5.0)
- [ ] Tests gate every release, incl. the TypeScript check (T1-6, C-4)
- [ ] Error boundaries, Retry/Copy on problem rows (N-3)
- [ ] Protect settings files (T1-5)
- [ ] Per-game profile switch: queued, failures shown (T1-4)
- [ ] Slimmer "This game" in Quick Access (T1-3)
- [ ] "Fix all" conflicts (T1-8)
- [ ] Daily update checks, one-tap install of the bundled tool (T1-9, C-5)
- [ ] Boost follows sustained power, opt-in, after reading the RAPL time window (T1-1, C-3, N-5)
- [ ] XeSS logging switches itself off after one run (T1-12)

## Full plan


Scope: oxp3-tool 0.4.3 and OXP3 Deck 0.4.6.

Evidence note: the owner fact files (scratchpad/tdp/device-facts.md, field/owner-diag-1.md, knobs-final.md) and the older research scratchpad are not on disk. The scratchpad holds only audio/, review/ and tc_*.txt. So no owner measurement backs any fps, W or battery figure here. Every number marked "est." is an estimate to check with the Live readout or MangoHud. Code claims were re-checked with grep or sed where they mattered (marked [verified]).

## Corrections made during verification
- FUT-07 [verified]: `downloads.latest_release_tag` (downloads.py:81-106) tries the web redirect `/releases/latest` first and then the API. Both skip pre-releases, and release.yml:56 marks every 0.x version as `--prerelease`. The trap is real, but it only bites a new caller. No current code checks OXP3Deck's own releases.
- reliab-06 [verified, narrowed]: `xefg_check` already reads only a 256 KiB tail (XEFG_TAIL, games.py:27, 218). The 16 MiB scans come from five `_last_match` passes in `last_run` (games.py:260, 270, 275, 278): "unsupported device" over two logs, "fallback", "built-in context" and "not supported in fullscreen".
- perf-02 [verified]: when pl2_w is null, each zone gets its snapshot PL2, capped at pl2_max (power.py:593-598). OXP3_PL2_W=52 (power.py:27). The burst comes from the PL2 headroom over the PL1 time window.
- perf-10: oxp3-tool has no split-lock, max_map_count or THP check [verified]. cachyos-settings very likely already sets split_lock_mitigate=0 (unverified on the owner's install), so on the owner's unit this is probably only a confirmation. It moves to quick wins and out of Tier 1.
- ui-1 [verified]: "This game" is open by default and sits above Power (quickgroups.ts:16-17).
- reliab-04/FUT-11 [verified]: `pnpm test` runs Python only (package.json:10). OXP3Deck has only release.yml. oxp3-tool's ci.yml runs only on workflow_dispatch.
- reliab-15 [verified]: in the zip, index.js.map is 4.73 MB and index.js is 471 KB.
- No presets and no ErrorBoundary exist anywhere in src/py_modules [verified grep]. Every update check uses `skip: true` (Quick.tsx:187, 252; Updates.tsx:49-50; XeSS.tsx:53) [verified]. Neither repo has any fossilize or MESA_SHADER handling [verified].

---

## Tier 1: do next (highest value, safe)

**T1-1. Boost power follows sustained power (perf-02)**
- Change: in power._resolve (power.py:587-598), when pl1_w is set and pl2_w is null, use `min(pl2_max, round(pl1*1.25))` on battery and `pl1*1.5` on AC. Gate this behind the option `pl2_follow`: on for new profiles, off for existing ones. Show "Boost: follows sustained (+25 %)" next to the Boost slider (PowerControls.tsx).
- Why: today a 12 W profile still bursts to 52 W during the PL1 window after every load [verified]. That causes an fps step-down after loads and drains the battery.
- Benefit (est.): steadier frame times after loads, a cooler chassis, and a few % of battery in load-heavy games. Users only need to set one slider.
- Effort S. Risk low.

**T1-2. One-tap power presets: Battery / Balanced / Performance / Max, plus Custom (merges perf-05, ui-2, ease-2, compete-04)**
- Change: add `PRESETS` in src/power.ts as pure functions of `state.range`, written with one set_values call through powerWriter. No new backend is needed.
- Suggested starting points (unmeasured):
  - Battery: PL1 10, PL2 follow, GPU max = range.gpu_efficient, EPP power/balance_power, gpu_power_profile power_saving.
  - Balanced: 18 W, balance_performance.
  - Performance: 25-28 W, clamped on battery.
  - Max: pl1_max (35 W on battery, 40 W on AC), turbo on.
- UI: a chip row at the top of the Quick Power group and on the Power tab. The summary shows the preset name, or "Custom" once any slider moves. A preset can be picked per game when per_game is on. Do not touch per-core caps or the SoC slider.
- Why: a 15 to 25 W change takes 10 D-pad presses on a 1 W step slider (PowerControls.tsx:341), and Battery needs 6-10 inputs across several controls. ONEXPLAYER's own firmware has 5/17/35 W presets (DESIGN.md:744-746).
- Benefit: 1 tap instead of 6-30 presses. Battery preset (est.): 1.5-2x play time in light games.
- Effort M. Risk low. Values are "starting points" until checked on the device.
- Deps: T1-1.

**T1-3. Slim "This game" in Quick Access so Power is reachable (ui-1)**
- Change: in GameControls quick mode, keep only these rows: automatic setup state, XeSS version, Frame generation, red issue and rollback rows, and Last run. Move the expert launch-option rows (driver, compat, DX12, logs, FSR->XeSS, 5x-8x, Proton, tips) behind "More for this game", which calls openPage("games").
- Why: there are about 15-20 focus stops before the Power header (GameControls.tsx:301-400). The moved rows only take effect after a restart anyway.
- Benefit: about 12-15 fewer presses to reach TDP while in a game.
- Effort S. Risk low.

**T1-4. Serialize per-game profile switches (reliab-08)**
- Change: in index.tsx:18-19, chain the power_game calls in a promise queue, or pass a sequence number that the backend ignores when it is stale. Add `.catch` and show the error from notePower as a Problem row.
- Why [verified]: the calls are fire-and-forget with no ordering and no catch. Bursts come from the lifetime event, the 1 s re-check and the 3 s poll (steam.ts:55-93). They can leave the default profile active on a game that has its own profile.
- Benefit: the right TDP every time. A wrong profile can mean 25 W instead of 35-40 W.
- Effort S. Risk low.

**T1-5. Never silently wipe settings: quarantine corrupt files and guard the schema version (reliab-01, reliab-02, reliab-14)**
- Change:
  - Corrupt files: Settings.__init__ (context.py:157-165), autosetup._load and optiscaler._load rename a bad file to `.corrupt-<ts>` (keep 3) and report a Problem row. auto.json and optiscaler.json refuse writes until the user taps "Start fresh".
  - Atomic writes: fsync the folder in write_atomic.
  - Schema version: when a file's version is higher than VERSION, load it read-only. Keep unknown keys in an inert passthrough.
  - autosetup._trim (autosetup.py:280): never drop a game that still has live changes.
- Why [verified]: corruption today leads to an empty in-memory dict, and the next save overwrites the file. Up to 500 profiles, Fix-for-me undo records and OptiScaler bookkeeping are then lost. oxp3-tool already refuses a corrupt state file (state.py:58-66).
- Benefit: prevents total loss of settings after a flat battery or a downgrade.
- Effort S. Risk low.

**T1-6. Tests gate every release (reliab-04, FUT-11)**
- Change: add `check` and `test:js` scripts: Python unittest, `node --test tests/js`, `tsc --noEmit`. Make build_zip.py and release.yml run them. In release.yml, also rebuild the zip and compare it with the committed one.
- oxp3-tool: add the unit suite to release.yml, which today runs only test_dist. If the repos are public, re-enable push CI (Actions minutes are free for public repos).
- Why [verified]: no CI runs these today. Measured: 719 Python + 192 JS tests in about 40 s.
- Benefit: regressions in root-run code do not reach the device.
- Effort S. Risk none.

**T1-7. Detect `game-performance` / performance profile overriding the CPU/GPU balance (perf-07)**
- Change: launchopts.ts recognises `game-performance` among the `others` tokens. "This game" then shows a trade-off row with [Remove] and Undo. power.py adds a drift reason when the platform profile is not balanced while soc_* fields are set.
- Why: conflicts.ts:40, 202 mention it only inside the ppd Fix-for-me text [verified]. CachyOS guides recommend the wrapper. EPP=performance on every core takes package budget from the iGPU at a fixed PL1.
- Benefit (est.): restores 5-15 % in GPU-bound games for affected users, and explains "my settings do nothing".
- Effort S. Risk low.

**T1-8. "Fix all" conflicts when turning power control on (ease-10)**
- Change: one confirm that lists the fixable conflicts, then power_fix for each (optionally as power_fix_all under one lock). Undo stays per item.
- Why: Fix for me runs one conflict at a time (main.py:641). On CachyOS, ppd, lpmd and tuned often hit together.
- Benefit: about 6 taps saved, and the TDP actually holds.
- Effort S. Risk low.

**T1-9. Automatic daily update checks; install the bundled tool silently; notice for a new plugin version (ui-6, ease-5, FUT-07 option a)**
- Change:
  - Backend timer, once per 24 h: run oxp3_update_check and xess_check_update. Skip when offline, when a game runs or when a job is active. Fill the "manual:*" caches so the closed-group summaries show "Update available". Add a dot on the gear and the option "Check automatically" (default on).
  - When the bundled oxp3-tool is newer than the installed one, install it silently (local file, sha-checked). Then show "re-apply N fixes".
  - Plugin version check: add `include_prerelease` (via the /releases API, picking the highest semver). Offer "copy install URL / QR". Do not use Decky internals.
- Why [verified]: every check uses `skip: true`. There is no timer. All releases are pre-releases.
- Benefit: fixes reach the owner within a day, and 2-6 taps are saved per check.
- Effort M. Risk low (a few GitHub calls per day; failures stay silent).

**T1-10. Per-game "Smooth cap": frame cap plus an integer-multiple refresh (perf-03)**
- Change: add `fps_cap` and `refresh_hz` to per-game profiles. The frontend applies them through the frame-limit path that steam_ui_js.py already proves out (legacy set_fps_limit, unified gamescope_app_target_framerate; lines 98-200) [verified]. Pick the largest multiple of the cap within 48-144 Hz: 40->120, 45->135, 48->144, 60->120. One dropdown in "This game". A Steam-side change counts as drift and stops it.
- Why: with VRR off (because of the DC-balance bug, display.py), a 40 fps cap at 144 Hz gives 3.6 refreshes per frame, which judders.
- Benefit: constant 25.0 ms frames instead of alternating 20.8/27.8 ms. Small panel power saving (est. 0.2-0.5 W). One control per game.
- Effort M. Risk medium: the per-app refresh field name (display_refresh_manual_hz) is UNVERIFIED. Ship the cap first and the refresh when verified (`appRefreshSupported` is already probed at steam_ui_js.py:174).

**T1-11. Backend sampler plus a per-game TDP advisor, a safe first step toward auto-TDP (perf-04, base for perf-01, compete-02, ui-3)**
- Change: a cheap 2-5 s sampler while a game runs and TDP control is on. It reads RAPL energy_uj, gtidle busy, throttle reasons, and battery power_now and energy_now, with no cur/act freq reads.
  - Keep a 10-minute ring in memory and a per-appid histogram in /run.
  - After 5 minutes of play, show one row in "This game": "GPU has headroom: 15 W likely keeps your fps (now 25 W) [Use 15 W]", or "Power-limited: plug in / Performance preset". Nothing is stored until tapped. Undo stays.
- Why: readouts sample only while the panel is open (store.ts:276-330). No measurement feeds the profile choice today (DESIGN.md:2620 lists pending manual A/B tests).
- Benefit (est.): 20-40 % more battery in capped or light games, without the risk of automatic writes.
- Effort M. Risk low (read-only until tapped).

**T1-12. Cheaper and correct XeSS log reads; make "Save XeSS logs" one-shot (reliab-06, reliab-07)**
- Change:
  - Log reads: cache last_run results by (path, size, mtime_ns). For start-up messages, read the first 1 MiB plus the last 256 KiB. Use one combined regex per file.
  - XESS_LOG: after a session that produced a fresh log, remove XESS_LOG from the launch options (it is a managed key). Show "Logging on: costs performance" while it is on.
- Why: five 16 MiB passes cost about 0.3-0.5 s of CPU per Games or "This game" open (measured on a synthetic log), often mid-game. Start-up lines fall out of the tail on long sessions, which gives false negatives (plausible, unverified). A forgotten XESS_LOG keeps per-frame log I/O running.
- Benefit: faster panel opens, correct FG diagnosis, and no per-frame logging left on.
- Effort S-M. Risk low.

---

## Tier 2: worth doing

| id | Title | What / why | Benefit | Effort | Risk |
|---|---|---|---|---|---|
| T2-1 | Closed-loop auto-TDP (perf-01, compete-02) | Build on the T1-11 sampler. Lower PL1 by 1 W per 6 s when EWMA busy is under 82 % and no PL1 reason shows. Raise it by 2 W when busy is over 96 % with a PL1 reason. Optional "Tune for N fps" binary search once a frame-time source exists (T3-1). A CPU-throttle guard sets a floor. Writes go through _apply and are marked "ours". | est. 30-60 % battery in capped games | L | med (oscillation) |
| T2-2 | GPU-bound power shifting (compete-03) | When GPU busy is 95 % or more with a PL1/power reason, step cpu_max_pct down by 10 %, with a floor and hysteresis. Automates DESIGN.md:2620 "max_perf_pct 70". Run the A/B test first. | est. +5-15 % fps at fixed W (UNVERIFIED) | M | low-med |
| T2-3 | Low-battery slot (perf-06) | A "low" slot below N % with +5 % hysteresis, battery read every 30 s, one toast. | est. doubles the last 20 % of play time | S | low |
| T2-4 | Live sparkline, "Measure 60 s" A/B and battery-time estimate (ui-3, ui-4, ui-5) | Uses the T1-11 ring. An SVG sparkline with the PL1 line. A 60 s average with Before/After. "≈ 2 h 50 min at this setting" on the slider. | Tuning without SSH | M | low |
| T2-5 | Setup checklist + one "Needs attention" line (ui-7, ease-1, ease-8) | One card at the top of Quick: fixes tool, recommended fixes, XeSS, power on, auto setup, reboot or log out, each with its existing action. Add a "Reboot now" button to XeSS "Log out needed" (quickgroups.ts:195). A chained setup_all job is optional later. | 15-20 presses become about 5; no half-configured state | M | low |
| T2-6 | Plugin state in the diagnose archive + "Copy summary" / issue QR (FUT-09, ease-3, ease-4) | `oxp3-tool diagnose --extra DIR` (runs through the Redactor). The plugin adds its settings, power-run, jobs, xess state and plugin log. Short summary to the clipboard, plus a QR for issues/new. | Reports become triageable from Game Mode | M | low |
| T2-7 | "Finish boot update" button (ease-7) | The "Do not reboot yet" row (Reboot.tsx:20-31) [verified, text only] gets a job that re-runs the oxp3-tool apply/revert or an allowlisted rebuild command. | Removes a terminal dead end | S | low-med |
| T2-8 | Limine GUID discovery + tested range + post-try check (FUT-03) | Glob the LimineLastBootedEntry-* efivars. `keep` refuses on an unknown GUID. Warn when Limine is outside the tested range. | Prevents a silent wrong-kernel boot | S | low |
| T2-9 | vsw kernel retirement detection (FUT-01) | Read-only: does an installed or repo kernel's xe.ko contain the vspeo symbols (detect.py:84-86)? Print "switch to stock" or "-vsw is N releases behind". Add `vswing_fix` to --json. | Owner leaves the EOL 7.2.11 kernel on day one | M | low |
| T2-10 | Kernel-capability probe + 7.4 fixtures (perf-16) and compatibility self-check (FUT-04) | Feature presence instead of version checks. One full-page row: "N checks need attention" (Steam API, Decky, InputPlumber map hash, Limine, xess markers, CDP). | Breaking updates found in one glance | M | low |
| T2-11 | OptiScaler pin resilience (FUT-05 parts 1-2) | Accept a sha256-matching file from ~/Downloads. Fall back to a stable build. Clearer GONE text. Do not prune the last build whose URL is dead. | OptiScaler survives the nightly being deleted | S | low |
| T2-12 | Data-only game rules manifest + known-issue freshness (FUT-06, compete-09, FUT-15) | pins.json as a release asset with a strict schema and sha-pinned downloads. Known issues record the stack they were tested on ({proton, xess, opti}). Ask before applying auto_drop when the stack differs. | Fixes ship without a plugin release; FG is not disabled forever | M | med (supply chain, mitigated) |
| T2-13 | Fan failsafe outside the process (reliab-03) | A systemd-run guard bound to Decky's service that writes pwm1_enable=2 on stop or a stale heartbeat. Only once on 7.4 oxp_ec. | No fixed 40 % fan after a crash | M | med (unit name UNVERIFIED) |
| T2-14 | Background shader replay at low TDP (perf-09) | Detect fossilize_replay using more than 5 % CPU while a game runs. Offer SCHED_IDLE + ioprio idle (no SIGSTOP by default), and revert on exit. | est. 1-4 W back to the GPU after updates | M | low-med |
| T2-15 | Error boundaries + Retry/Copy on Problem rows (ui-10, ui-9) | @decky/ui ErrorBoundary per group and page [none today, verified]. Problem rows get onRetry and Copy through clipboard.ts. | One bad row cannot blank the panel | S | very low |
| T2-16 | Navigation: Y on a group header opens its tab; gear opens the last tab (ui-11) | The gear is hard-coded to "fixes" (index.tsx:32) [verified]. | Saves 2-4 presses | S | low |
| T2-17 | Compact Fixes tab + "Apply recommended" there (ui-13); Kernel tab "Next boot" first (ui-15) | Applied fixes become one row, with their actions in a context menu. | About 60 % fewer focus stops | S | low |
| T2-18 | One poller on the Power tab (reliab-05, reliab-13) | Add the `now` fields to power_live. Read power_state on mount, after writes, and every 10 s. Move drift handling from state() into tick. | Half the GPU-waking reads while open | S | low |
| T2-19 | Settings export/import, daily backups, "Reset OXP3 Deck" (ease-9) | Profiles survive a reflash or a Bazzite to CachyOS move. Recover in one tap. | Recovery in 1 tap instead of 10-50 | M | low-med |
| T2-20 | xess-xmx-linux #46 one-tap (FUT-13) | Rename (not delete) the second DriverStore, with Undo. Hide the fix once a release has the PR #47 marker. | XMX XeSS without Desktop Mode | S | low |
| T2-21 | Don't hold power's lock across systemctl (reliab-10) | Plan under the lock, run unlocked, verify under the lock. | TDP keeps working during Fix for me | M | med |
| T2-22 | Shader cache full detection (perf-08) | Size shadercache/<appid> against the effective cap. Offer MESA_SHADER_CACHE_MAX_SIZE=4G as a managed key. Only show it when the cache is near the cap. | Removes repeat-session stutter where it applies (UNVERIFIED) | S | low |
| T2-23 | scx mode "Follow power" (perf-12) | powersave on battery at PL1 of 15 W or less, gaming on AC. | est. 0.5-2 W | S | low |

## Tier 3: later or needs research
- T3-1 Frame-time source (ui-16). Investigate gamescope stats or MangoHud CSV, read-only. This unlocks the fps target for T2-1 and fps in "Measure". UNVERIFIED that it can be done safely.
- T3-2 Serve Steam's TDP slider via a steamos-manager TdpLimit1 remote (compete-01). The TOML keys and D-Bus signatures are UNVERIFIED, and it needs a single source of truth with per-game profiles. Today any TdpLimit1 remote counts as a conflict (power.py:140, 1008) [verified].
- T3-3 Hardware-key "power mode" action (compete-05), after T1-2. Uses a validated request file.
- T3-4 Fan curve on 7.4 (compete-08). Measure the EC PWM scale first.
- T3-5 Detect lsfg-vk for DX11/Vulkan FG and warn about double FG (compete-06). Detect and link only, because of its CC BY-NC-ND licence. Xe3 support UNVERIFIED.
- T3-6 OptiScaler FSR-FG output fallback and base-fps limiter (compete-10). Ini key names UNVERIFIED for the pinned build.
- T3-7 "Steady GPU clocks" (RPe floor) with a cap (perf-11). An A/B experiment of 1 % lows; xe SLPC behaviour UNVERIFIED.
- T3-8 PCIe ASPM / s2idle drain diagnose (perf-14). Report sleep drain in %/h so the cost of nvme.noacpi is visible.
- T3-9 Karg workaround retest after kernel updates (FUT-10). Panel Replay off costs OLED self-refresh power (magnitude UNVERIFIED).
- T3-10 Parametrize the vsw build script per version (FUT-02). Whether the patches apply to 7.3 is UNVERIFIED.
- T3-11 Derive the InputPlumber override from the stock map, and warn when the stock map changed after apply (FUT-08). Do the warning first (S); the derivation is L.
- T3-12 "Your games" list on the Games tab (ui-12). L.
- T3-13 Device profile table plus a generic Panther Lake mode (FUT-14).
- T3-14 Probes in place of path checks: WirePlumber, bootc, CDP port (FUT-16). Upstream-watch maintainer script (FUT-12).
- T3-15 Real job progress bars, cancel and queue (ui-8, reliab-09). Allow cancel only in download and unpack steps.
- T3-16 Desktop-entry actions plus `oxp3-tool update` (ease-11).
- T3-17 Code health: move-only split of power.py, optiscaler.py and xess.py (reliab-11). DESIGN.md as per-subsystem current-state docs plus a CHANGELOG (reliab-12, ease-12c). Do this after T1-6.
- T3-18 Opt-in MangoHud RAPL group read (compete-07). Reopens the PLATYPUS side channel, so it stays opt-in and group-scoped only.
- T3-19 Broaden XESS=latest suggestions (perf-13). Rely on crash rollback, and never apply them automatically.
- T3-20 Drop the " · Now" tag and the always-on device row (ui-14). This changes a DESIGN rule, so the owner decides.

## Quick wins (S effort)
T1-1, T1-3, T1-4, T1-5, T1-6, T1-7, T1-8, T2-3, T2-7, T2-8, T2-11, T2-15, T2-16, T2-17, T2-18, T2-20, T2-22, T2-23, plus:
- Drop dist/index.js.map from the release zip (reliab-15, verified 4.73 MB of the payload) and keep it as a CI artifact. Remove the unused NOTE_KINDS and ANTICHEAT constants.
- oxp3-tool diagnose: read-only checks of split_lock_mitigate, max_map_count and THP. Offer a sysctl drop-in only when a value is missing (perf-10). On the owner's CachyOS this is probably only a confirmation.
- Diagnose note: does chwd's handheld profile match "ONEXPLAYER 3"? (perf side note, UNVERIFIED)

## Rejected or folded
- mitigations=off and preempt changes: security cost, little gain, and the CachyOS kernel is already low-latency.
- SMT toggle: Panther Lake H has no SMT. Integer scaling: 960x600 is useless. vkBasalt CAS: duplicates gamescope.
- Bundling or copying code from DeckyTDPTuner (GPL-3), ClawDeck AGPL parts, or lsfg-vk (CC BY-NC-ND): use ideas only, or detect and link.
- Mirroring OptiScaler binaries on our own release (FUT-05 part 3): GPL source obligations, and the sha-checked local import covers the need.
- Decky internal install-from-URL for self-update (ease-6b): undocumented. Ship copy URL / QR (T1-9).
- SteamClient.User.StartRestart for XeSS log-out (ease-8): UNVERIFIED that it re-reads the session environment. Use Reboot instead.
- SIGSTOP of fossilize_replay by default: can stall Steam. Use SCHED_IDLE only (T2-14).
- Silently auto-applying device fixes or auto-installing XeSS: only offer them (T1-9, T2-5).
- ProtonDB lookup (compete-09): API terms unverified, and it is not needed.
- Removing the README "untested on a real device" banner (ease-12b): ask the owner first. It is a docs change, not a plan item.
- reliab-13 as its own item: folded into T2-18. Separate ui-2, ease-2 and compete-04 preset items: merged into T1-2. ui-6, ease-5 and FUT-07: merged into T1-9.


## Completeness review (takes precedence)

CRITIC REPORT on (review notes) Both repos were only read. Nothing was edited.

Evidence base: the owner-facts files are still missing. I searched the whole filesystem for device-facts.md, owner-diag-1.md and knobs-final.md and found none. The only measured device facts I could find are in DESIGN.md:731-748:
- MSR PL1 is 25 W and MMIO PL1 is 35 W. Both PL2s are 52 W.
- The hardware enforces the lower of the two interfaces.
- The GPU follows the MSR PL1.
- Firmware rewrites the MMIO limits on every AC change.
- ONEXPLAYER's own presets are 5 / 17 / 35 W.
- Reading xe min/max/cur/act_freq wakes the GPU.
Every W, fps and battery number below is an estimate.

## A. Corrections to Tier 1 (weak or contradicted evidence)

**C-1. T1-10 "Smooth cap" rests on an outdated premise and mostly duplicates Steam. Demote to Tier 3 or reject.**
- **Why:**
  - The plan says VRR is off because of the DC-balance bug. That bug is fixed from kernel 7.2.10 (oxp3-tool display.py:6-14, README:72), and the owner runs 7.2.11-vsw.
  - oxp3-tool's own README:67 says gamescope already switches the refresh rate for frame limits that do not divide 144.
  - In legacy mode, Steam builds its own `fps_limit_options` from the refresh rate (steam_ui_js.py:13, 98, 133).
  - Steam's "Use per-game profile" already stores a frame limit per game.
  - The 0.2-0.5 W panel saving is unmeasured.
- **What remains:** the integer-multiple refresh helps only kernels below 7.2.10 with VRR forced off (Bazzite 7.2.9). Replace it with N-1 below.
- **Risk:** it adds a second per-game owner of the frame limit next to Steam, which causes drift fights.

**C-2. T1-7 (`game-performance` detection) has a narrow trigger. Demote to Tier 2.**
- **Verified upstream script:** https://raw.githubusercontent.com/CachyOS/CachyOS-Settings/master/usr/bin/game-performance runs `powerprofilesctl list | grep -q performance:` and otherwise does `exec "$@"`. When Fix for me has masked ppd, `list` fails, so the wrapper does nothing and the game starts normally.
- **Already handled:** when ppd runs and is "ignored", power.py already gives EPP to it (IgnoredCpuDaemonTest, DESIGN.md:2630-2634). conflicts.ts:39-40 already explains the trade-off.
- **What remains:** only the "ppd ignored + game-performance + SoC slider set" case.
- **Unverified:** the claimed 5-15 % gain.
- **Keep:** a cheap token detection as a hint row in T2-10's self-check.

**C-3. T1-1 (PL2 follows PL1): the battery and frame-time benefit is weak.**
- **Why:** RAPL PL1 is a running average over the time window. At steady load the average is held at PL1 whatever PL2 is. PL2 only shapes bursts after idle or loading (the "budget" built up during menus and cutscenes).
  - The likely real-world effect is less fps see-saw for about tau seconds after a load, plus slightly longer loads and shader compiles.
  - Battery energy over a session barely changes.
- **Gaps:** no tau value for the OXP3 is recorded. powerhw/power never read `constraint_0_time_window_us` (grep shows no hits).
- **Keep it in Tier 1 only as:**
  - ship it opt-in, off by default;
  - word it as "steadier fps right after loads", not as a battery feature;
  - read and show tau first (see N-5).
- **Unverified:** whether the fps step-down is visible on this unit.

**C-4. T1-6 (test gate): the TypeScript check fails today in this checkout.**
- **Evidence:**
  - scratchpad/tc_before.txt and tc_after.txt show 418 tsc errors, 62 of them TS2307 "Cannot find module 'react'".
  - node_modules has no react, because package.json uses pnpm `peerDependencyRules.ignoreMissing: ["react","react-dom"]`.
- **Change:** add react and react-dom 19.1.x as devDependencies, or a `paths` stub, before `tsc --noEmit` can gate a release. Otherwise the gate blocks every release.
- **Effort:** still S. The fix is a dependency entry plus cleaning up whatever errors remain. The TS7053 errors in CpuControls.tsx and JobView.tsx are probably knock-on errors from the missing react types (unverified).

**C-5. T1-9: "install the bundled tool silently" breaks two DESIGN.md rules.**
- **Rules:**
  - DESIGN.md:17-21: the plugin adds no logic, and oxp3-tool update is a job.
  - DESIGN.md:30-33: long work is a job.
  - DESIGN.md rules for power: never act on its own.
- **Practical risk:** README:67 says installed helpers (xbox-key) from an older oxp3-tool need `apply xbox-key` again. A silent tool swap leaves helpers and tool out of step with no notice.
- **Change:** keep the daily check, but make the install a one-tap notice ("oxp3-tool 0.4.4 bundled: Install"). Keep "silent" only for the cache fill.

**C-6. T1-4 (profile race): real but rare.**
- **Why:**
  - steam.ts:64-69 notifies only on an actual app change, so bursts need A to none to B within about one backend call.
  - The verified gap that matters most is the missing `.catch`: index.tsx:18-19 leaves rejections unhandled and notePower is never told.
- **Change:** keep it as S, but describe the benefit as "a failed switch is shown" rather than "the right TDP every time".

**C-7. T1-12: split it.**
- **Log caching stays in Tier 2:**
  - the cost is 0.3-0.5 s on an executor thread when a panel opens, not per-frame;
  - the start-up-line false negative is unverified.
- **XESS_LOG one-shot stays in Tier 1, with a caveat:** if XESS_LOG writes per frame, the cost is continuous. Whether xess-xmx-linux's XESS_LOG logs per frame is unverified, so check it in xess-xmx-linux's source first.

## B. Missing items

**N-1. VRR guidance for fixed kernels.** Area: performance, latency, UI.
- **What to change:**
  - oxp3-tool display.py `advice()` (lines 454-500) only ever says "leave VRR off" or "set Never".
  - Add the positive case: when `dc_balance_param` is present and not 1, and DMC is v2.33 or later, say "variable refresh is safe on this kernel: turn on VRR in Game Mode (Quick Access > Performance)". Add a `vrr_safe` field to `--json`.
  - OXP3Deck has no VRR mention at all (grep shows no hits). Show one row in "This game" or Power: "VRR safe: on gives smooth frames at any fps".
- **Why:**
  - The fix exists from 7.2.10 (display.py:11-12), and the owner is on 7.2.11-vsw.
  - The owner's docs were written while VRR was broken, so the owner probably still has it off (unverified).
  - The VRR range of the OXP3 panel is not recorded anywhere (unverified, read it from the EDID).
- **Benefit:** a judder-free, non-integer cap (for example 40-50 fps) with no refresh switching, and lower input latency than vsync at a fixed 144 Hz. This is the biggest frame-pacing gain available, and it costs one toggle.
- **Effort:** S. **Risk:** low.
  - Unverified: OLED VRR gamma flicker at low fps on this panel. Say "if you see flicker below about 48 fps, cap higher".
- **Dependencies:** none. It replaces most of T1-10.

**N-2. Measure-before-ship protocol and a device self-test.** Area: future-proofing, safety, performance.
- **What to change:**
  - Add `oxp3-tool selftest --json` plus an OXP3 Deck "Self-test" button (a job). For each power field:
    - write a safe value, read it back, then restore the snapshot;
    - this covers both RAPL PL1/PL2, xe min/max, EPP, no_turbo, cpu_max_pct, the per-type caps, the SoC slider and platform_profile;
    - record locked fields (EACCES on MSR, DESIGN.md:742) and the time windows.
  - A fixed 60 s "measure" over a scripted load that records average package W, GPU busy and battery W.
  - Output goes into the diagnose archive (T2-6).
- **Why:**
  - Both READMEs say the projects are untested on a real device (OXP3Deck README:20, oxp3-tool README:7).
  - Every Tier 1 wattage and benefit is an estimate.
  - DESIGN.md:2620 lists A/B tests that are still pending.
  - The owner-facts files are gone.
- **Benefit:**
  - turns about 15 UNVERIFIED tags in the plan into facts;
  - the preset wattages in T1-2 become measured;
  - catches firmware locks before users hit them.
- **Effort:** M. **Risk:** low (writes go through the existing `_apply` and snapshot restore).
- **Dependencies:** T1-6. It should run before T1-2's values are final.

**N-3. Error boundary: promote T2-15 to Tier 1.**
- **Why:**
  - Verified: there is no ErrorBoundary.
  - One render exception in any group blanks the whole Quick Access panel, including the TDP controls, in the middle of a game.
  - DESIGN.md:26-28 already treats lost answers as a reason for defensive design.
- **Effort:** S. **Risk:** very low.
- **Benefit:** the panel stays usable after any single-row bug, which matters more while nothing has been tested on a device.

**N-4. Low-battery slot: promote T2-3 into Tier 1.**
- **Why:**
  - It is S effort.
  - It needs only `powerhw.ac_online` and battery capacity, which the plugin already reads, and the per-AC-slot mechanism (`split_ac`, power.py:59, 467).
  - Its benefit is one of the few that work directly on battery hours.
- **Benefit (est.):** the last 20 % of charge lasts 1.5-2x longer, with no taps.
- **Effort:** S. **Risk:** low.
- **Dependencies:** T1-2, so it can use the Battery preset as the slot.

**N-5. Read and show the RAPL time windows (tau); offer setting them later.** Area: performance.
- **What to change:**
  - powerhw.discover reads `constraint_{0,1}_time_window_us` for intel-rapl:0 and intel-rapl-mmio:0, and the Power tab Details show them.
  - Phase 2, only if N-2 shows they are writable: a "Short boost" option that sets tau to about 8 s.
- **Why:**
  - Verified: no code touches the time window (grep shows no hits).
  - PL2's real effect (C-3) depends on tau.
  - Firmware may rewrite MMIO tau on AC change, as it does for the limits (DESIGN.md:735), which is unverified.
- **Benefit:** it settles whether T1-1 is worth anything, and gives the right knob for post-load fps swings.
- **Effort:** S to read, M to write. **Risk:** low to read. Writing has medium risk, because a locked MSR or a firmware rewrite would cause drift.

**N-6. Keep game threads off LP-E cores (experimental A/B only).** Area: performance.
- **What to change:**
  - Per game, an option to give the game's process tree an AllowedCPUs set of P+E cores only.
  - Mechanism: `systemd-run --scope`, or a cpuset on the Steam app scope.
  - The LP-E CPU list comes from the existing core-type discovery (power.ts CAP_FIELD lpe).
- **Why:**
  - Panther Lake H's LP-E cores sit on the low-power island.
  - Wine/Proton thread placement under scx or EEVDF may land render threads there (unverified on PTL; plausible from Meteor Lake and Lunar Lake reports).
  - Verified: there is no affinity or cpuset code in either repo.
- **Benefit (unverified):** better 1 % lows in CPU-bound games. It must be A/B tested with N-2's measure before it ships.
- **Effort:** M. **Risk:** medium (scope handling with gamescope or the Steam reaper).
- **Placement:** Tier 3.

**N-7. Per-plugin overhead budget while in game.** Area: performance.
- **What to change:** add a test that counts sysfs reads per minute while a game runs and the panel is closed:
  - the backend tick every 2 s (power.py:31);
  - poll_s 2 (power.py:59);
  - the frontend 3 s app poll (steam.ts:85);
  - the library scan (AutoSetup.tsx:218-219).
- Assert that there is no GPU-waking freq read (DESIGN.md:745).
- Make 2 s the floor only while the panel is open, and move to 10 s in game when no drift has been seen (the `due` logic at power.py:1921-1925).
- **Why:** these timers run all session long. Today a drift read happens every 2 s even with the panel closed (`poll_s` default 2).
- **Benefit:** small (est. under 0.1 W), but it guards against regressions such as T1-11's sampler waking the GPU.
- **Effort:** S. **Risk:** low.
- **Dependencies:** T1-11.

**N-8. Docs: a "First 5 minutes" quick-start and splitting the README table cells.** Area: ease of use.
- **Why:** oxp3-tool README:67 is a single table cell of over 2,500 characters (buttons, xbox-key, frame limit). New owners cannot scan it.
- **What to change:** a short CachyOS and Bazzite quick-start at the top:
  - install;
  - apply the recommended fixes;
  - reboot;
  - turn TDP control on;
  - VRR (N-1).
  - Move the long explanations into per-fix sections.
- **Effort:** S. **Risk:** none.

## C. Ranking changes
- **Up:**
  - T2-15 moves to Tier 1 (as N-3).
  - T2-3 moves to Tier 1 (as N-4).
  - T2-9 (vsw retirement) moves to high Tier 2. The owner's only kernel is a self-built EOL 7.2.11, and the vswing series merged for 7.4 (README note on display.py:59-60). Being stuck on one kernel is the main long-term risk.
- **Down:**
  - T1-10 moves to Tier 3 (C-1).
  - T1-7 moves to Tier 2 (C-2).
  - The log-cache half of T1-12 moves to Tier 2 (C-7).
- **Still Tier 1, but with a weak evidence base:**
  - T1-1 (C-3);
  - the T1-2 wattages (no measurement; depends on N-2);
  - T1-11's "20-40 % battery" claim (unmeasured; the advisor itself is sound).

## D. Amended Tier 1 list
1. Tests gate every release, with the react devDependency fix for tsc (T1-6 + C-4). S.
2. Error boundaries plus Retry/Copy on Problem rows (N-3 / T2-15). S.
3. Protect settings files (T1-5). S.
4. Per-game profile switch: queue it, `.catch` it and show failures (T1-4, reworded per C-6). S.
5. VRR-safe guidance for fixed kernels, in oxp3-tool and the plugin (N-1). S.
6. Device self-test and 60 s measure (N-2). M. It confirms the values for items 7-9.
7. One-tap presets, with values marked provisional until item 6 has measured them (T1-2). M.
8. Low-battery slot (N-4 / T2-3). S.
9. Slim "This game" in Quick Access (T1-3). S.
10. "Fix all" conflicts (T1-8). S.
11. Daily update checks, with a one-tap install of the bundled tool and not a silent one (T1-9 + C-5). M.
12. Background sampler plus a per-game TDP advisor, read-only (T1-11), with the in-game read budget from N-7. M.
13. PL2 follows PL1: opt-in, worded as "steadier after loads", with the time window read first (T1-1 + C-3 + N-5 read part). S.
14. XESS_LOG one-shot, after checking in xess-xmx-linux's source whether it logs per frame (half of T1-12). S.

New Tier 2 entries:
- T1-7 (game-performance detection), folded into the T2-10 self-check;
- the log-cache half of T1-12;
- writing the time window (N-5, phase 2);
- the overhead budget (N-7);
- the docs quick-start (N-8).

New Tier 3 entries:
- the LP-E affinity A/B (N-6);
- T1-10, limited to kernels below 7.2.10.

Files referenced:
- oxp3-tool: oxp3_tool/display.py (lines 6-14, 454-500)
- oxp3-tool: oxp3_tool/steam_ui_js.py (lines 13, 98, 133)
- oxp3-tool: README.md (lines 7, 67, 72)
- DESIGN.md (lines 17-33, 731-748, 2620-2634)
- py_modules/oxp3deck/power.py (lines 31, 59, 467, 1866-1935)
- src/index.tsx (lines 18-19)
- src/steam.ts (lines 64-85)
- src/conflicts.ts (lines 36-44, 198-206)
- package.json
- (review notes)
