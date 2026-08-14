import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_HISTORY_LIMITS,
  HARD_MAX_HISTORY_SIZE_MIB,
  HARD_MAX_HISTORY_SNAPSHOTS,
  HISTORY_MEBIBYTE,
  normalizeHistoryLimits,
} from "../src/historySettings.ts";

const manifest = JSON.parse(await readFile(new URL("../../vscode/package.json", import.meta.url), "utf8"));
const properties = manifest.contributes.configuration.properties;

assert.deepEqual(properties["mmt.export.defaultFormat"].enum, ["pdf", "png"]);
assert.equal(properties["mmt.export.defaultFormat"].default, "pdf");
assert.deepEqual(properties["mmt.preview.defaultFitMode"].enum, ["width", "page"]);
assert.equal(properties["mmt.preview.defaultFitMode"].default, "width");
assert.equal(properties["mmt.preview.openOnDocument"].default, false);
assert.equal(properties["mmt.history.maxSnapshots"].default, 0);
assert.equal(properties["mmt.history.maxSizeMb"].default, 50);

assert.deepEqual(normalizeHistoryLimits({}), DEFAULT_HISTORY_LIMITS);
assert.deepEqual(normalizeHistoryLimits({ maxSnapshots: 0, maxSizeMb: 0 }), {
  maxSnapshots: null,
  maxBytes: null,
});
assert.deepEqual(normalizeHistoryLimits({ maxSnapshots: 12.9, maxSizeMb: 128.5 }), {
  maxSnapshots: 12,
  maxBytes: 128.5 * HISTORY_MEBIBYTE,
});
assert.deepEqual(normalizeHistoryLimits({ maxSnapshots: Number.NaN, maxSizeMb: -1 }), DEFAULT_HISTORY_LIMITS);
assert.deepEqual(normalizeHistoryLimits({ maxSnapshots: 999_999, maxSizeMb: 999_999 }), {
  maxSnapshots: HARD_MAX_HISTORY_SNAPSHOTS,
  maxBytes: HARD_MAX_HISTORY_SIZE_MIB * HISTORY_MEBIBYTE,
});

console.log("editor settings: manifest contracts and bounded/unlimited history normalization passed");
