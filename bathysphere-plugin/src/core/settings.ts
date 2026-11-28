// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/** The manifest settings' current values (the host's settings form and `setting` nodes change them). */
import { currentPlugin } from "@bathysphere/sdk";

export const settingOn = (key: "checkUpdates" | "powerTips" | "fgExperimental"): boolean => {
  const v = currentPlugin()?.settings[key];
  return typeof v === "boolean" ? v : key !== "fgExperimental";
};
