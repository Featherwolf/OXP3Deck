<!--
SPDX-FileCopyrightText: 2026 Featherwolf
SPDX-License-Identifier: MIT
-->

# Changelog

## 0.7.0

First Bathysphere version, ported from the Decky plugin OXP3 Deck 0.6:

- Hardware through Bathysphere's hardware API: Steam's own sustained power, GPU power saving, CPU
  boost and charge limit through steamos-manager; boost power, energy preference, CPU limits, the
  CPU vs GPU balance, the GPU speed range, the fan and "Run from charger" through the ONEXPLAYER 3
  hardware helper (oxp3-hw), per profile as rules Bathysphere applies itself.
- Everything that needs root (oxp3-tool, xess-xmx-linux installs, turning other power programs off,
  installing the hardware helper) is a "Run this yourself" card with the exact command lines.
- Per-game XeSS launch options through Steam's launch options, written after the game quits when
  it runs.
