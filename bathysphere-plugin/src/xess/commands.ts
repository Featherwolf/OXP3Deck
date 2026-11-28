// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * The exact command lines for xess-xmx-linux that the user runs (pure). The reviewed, static steps
 * are the manifest's `xess-install`, `xess-update` and `xess-manage` cards; these lines fill in the
 * release tag and the package folder, which a card cannot (SPEC §3.2: cards are static). Every path
 * is single-quoted and a path with a quote, a control, format or line-separator character, or a
 * line break is refused, so a folder name can never become shell syntax or an invisible character
 * in a line to copy (the row then says the step is left to the user).
 */
import { copySafe } from "../core/text";
import { driverPrefix, NAME_PREFIX, REPO, SAFE_TAG } from "./releases";

/** Where the install card unpacks releases (the original's managed folder). */
export const MANAGED_DIR = "~/.local/share/oxp3deck/xess";

/** `p` as one single-quoted shell word, or null when it cannot be one safely. */
export function quotePath(p: string): string | null {
  if (!p.startsWith("/") || /['\n\t]/.test(p) || !copySafe(p) || p.length > 512) return null;
  return `'${p}'`;
}

export function installLines(tag: string): string | null {
  if (!SAFE_TAG.test(tag)) return null;
  const zip = `${NAME_PREFIX}${tag}.zip`;
  return [
    `mkdir -p ${MANAGED_DIR} && cd ${MANAGED_DIR}`,
    `curl -fLO https://github.com/${REPO}/releases/download/${tag}/${zip}`,
    `unzip ${zip}`,
    `cd ${NAME_PREFIX}${tag} && bash install.sh`,
  ].join("\n");
}

/** Update: unpack next to the old folder, the old uninstall.sh, then the new install.sh. */
export function updateLines(oldPackage: string, tag: string): string | null {
  const old = quotePath(oldPackage);
  const install = installLines(tag);
  if (!old || !install) return null;
  const [mk, curl, unzip, run] = install.split("\n");
  return [mk, curl, unzip, `bash ${old}/uninstall.sh`, run].join("\n");
}

export function repairLine(pkg: string): string | null {
  const q = quotePath(pkg);
  return q && `cd ${q} && bash install.sh`;
}

export function uninstallLine(pkg: string): string | null {
  const q = quotePath(pkg);
  return q && `cd ${q} && bash uninstall.sh`;
}

/** tools/switch-driver.sh with a Mesa version prefix such as 26.3. */
export function switchDriverLine(pkg: string, version: string): string | null {
  const q = quotePath(pkg);
  const prefix = driverPrefix(version);
  return q && /^[0-9]+(\.[0-9A-Za-z-]+)*$/.test(prefix) ? `cd ${q} && bash tools/switch-driver.sh ${prefix}` : null;
}

/** Removing an old release folder: only a folder named like a release. */
export function removeFolderLine(path: string): string | null {
  const q = quotePath(path);
  const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return q && name.startsWith(NAME_PREFIX) ? `rm -rf ${q}` : null;
}
