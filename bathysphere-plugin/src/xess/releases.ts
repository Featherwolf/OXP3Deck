// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
/**
 * xess-xmx-linux releases (pure): tag order (xess.py tag_key/newer), what each release brings (its
 * release notes), and the known bugs of an installed release (original src/xessoffer.ts).
 */

export const REPO = "HHHHanasak1/xess-xmx-linux";
export const NAME_PREFIX = "xess-xmx-linux-";
/** A release tag as the project writes them (dates, old v-tags), and nothing a shell would read. */
export const SAFE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

/** YYYYMMDD[-N] as [1, date, N], vX.Y.Z as [0, X, Y, Z] (below every date tag); null for other forms. */
export function tagKey(tag: string | null | undefined): number[] | null {
  if (!tag) return null;
  const d = /^([0-9]{8})(?:-([0-9]+))?$/.exec(tag);
  if (d) return [1, Number(d[1]), Number(d[2] ?? 1)];
  const v = /^v([0-9]+(?:\.[0-9]+)*)$/.exec(tag);
  return v ? [0, ...v[1]!.split(".").map(Number)] : null;
}

/** `a` is newer than `b`; tags of another form only differ. */
export function tagNewer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false;
  const ka = tagKey(a);
  const kb = tagKey(b);
  if (!ka || !kb) return a !== b;
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i]! > kb[i]!;
  return ka.length > kb.length;
}

/** The release tag of a package folder (xess-xmx-linux-<tag>), else null. */
export function packageVersion(path: string | null | undefined): string | null {
  const name = (path ?? "").replace(/\/+$/, "").split("/").pop() ?? "";
  if (!name.startsWith(NAME_PREFIX) || name.length === NAME_PREFIX.length) return null;
  const tag = name.slice(NAME_PREFIX.length);
  return SAFE_TAG.test(tag) ? tag : null;
}

/** The release that brought FSR → XeSS and fixed the known bugs below. */
export const FIXES_RELEASE = "20261104";

/** FSR=xess and FSR_FG arrived with 20261104 (src/launchopts.ts fsrSupported). */
export function fsrSupported(tag: string | null | undefined): boolean {
  const m = /^(\d{8})/.exec(tag ?? "");
  return !!m && Number(m[1]) >= 20261104;
}

/** The patched Mesa drivers a release ships (its lib/mesa-*), where the release notes say. */
export const RELEASE_DRIVERS: Record<string, string[]> = {
  "20261104": ["26.3.0-rc3", "26.1.2"],
};

/** "26.3.0-rc2" → "26.3": what MESA= takes, which stays valid when an update brings a newer build. */
export function driverPrefix(version: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return m ? `${m[1]}.${m[2]}` : version;
}

export interface ReleaseRow {
  id: string;
  label: string;
  line: string;
  detail: string;
}

/** Known bugs of the installed release that a newer release or the project's main branch fixes. */
export function releaseRows(version: string | null, systemProton: boolean): ReleaseRow[] {
  const out: ReleaseRow[] = [];
  if (!version) return out;
  if (tagNewer(FIXES_RELEASE, version)) {
    out.push({
      id: "older",
      label: `Release older than ${FIXES_RELEASE}`,
      line: `${FIXES_RELEASE} fixes known bugs. Update below.`,
      detail: `xess-xmx-linux ${version} is installed. ${FIXES_RELEASE} fixes Proton 11.0 games running without the add-on after a reboot in Game Mode (PR #43), turns frame generation low latency on by default (IGDEXT_XELL_CAP=off turns it off), adds the patched Mesa 26.3.0-rc3 and 26.1.2 drivers and FSR → XeSS. Source: the project's release notes.`,
    });
  }
  if (systemProton && tagKey(version) && !tagNewer(version, FIXES_RELEASE)) {
    out.push({
      id: "driverstore",
      label: "Known bug: proton-cachyos driver store",
      line: "Fixed on the project's main branch, not in a release yet.",
      detail:
        "proton-cachyos makes a capitalised system32\\DriverStore folder in each game's prefix, with a link to its own igdext64.dll, and Wine uses that one; install.sh up to 20261104 writes only the lowercase driverstore, so such a game loads the stock file (no fast mode). The fix is merged on main (PR #47) but in no release yet. A game's own check (Games tab) says when its prefix has the folder; deleting it while the game is closed works around it. Source: github.com/HHHHanasak1/xess-xmx-linux/issues/46.",
    });
  }
  return out;
}
