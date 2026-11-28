// SPDX-FileCopyrightText: 2026 Featherwolf
// SPDX-License-Identifier: MIT
// The pure modules the unit tests import directly (bundled into .test-out/pure.mjs by the build).
export { firstSentence, fitsOneLine, fit, clipBytes, details, tailBytes, logTail, copySafe, dialogTitle } from "../src/core/text";
export { normPower, normValues, mergeLow, presetNumbers, presetOf, followOffset, BATTERY_LOW, EMPTY, OPTION_DEFAULTS } from "../src/power/profiles";
export { buildRules, ruleSet, sameRules, ruleTarget, MAX_RULES } from "../src/power/rules";
export { offCard, onCard, offAllSteps, recordTurnedOff, conflictText, blocking, ignorable } from "../src/power/conflicts";
export { advise, count, newBucket, stats, adviceLine } from "../src/power/advisor";
export { reasonText, liveLine } from "../src/power/live";
export { envValues, packagesFromEnv, packageFromUnit, parseStatus, icdPackage } from "../src/xess/detect";
export { tagKey, tagNewer, packageVersion, fsrSupported, releaseRows, driverPrefix } from "../src/xess/releases";
export { installLines, updateLines, repairLine, uninstallLine, switchDriverLine, removeFolderLine, quotePath } from "../src/xess/commands";
export { advice, suggest, checks, xefgCheck, versionOf, isSystemProton, lastRunRow } from "../src/games/advice";
export { antiCheatOf, knownIssues } from "../src/games/known";
export { copyLine } from "../src/games/launch";
export { exitStep } from "../src/games/xesslog";
export { classify, plan, handSet, touched } from "../src/games/autosetup";
export { parseState, rebootPending, staleFixes, versionNewer, markerCommand } from "../src/oxp3tool/state";
export { applyLine, revertLine, buttonsLine, savedButtons } from "../src/oxp3tool/commands";
export { parseToolVersion, tagFromLocation } from "../src/updates/check";
