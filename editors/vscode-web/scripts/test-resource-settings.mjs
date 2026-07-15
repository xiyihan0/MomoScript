import assert from "node:assert/strict";
import {
  DEFAULT_MAX_PROJECT_MIB,
  DEFAULT_MAX_PROJECT_RESOURCES,
  DEFAULT_MAX_RESOURCE_FILE_MIB,
  HARD_MAX_PROJECT_MIB,
  HARD_MAX_PROJECT_RESOURCES,
  HARD_MAX_RESOURCE_FILE_MIB,
  MEBIBYTE,
  normalizeResourceLimits
} from "../src/resourceSettings.ts";

assert.deepEqual(normalizeResourceLimits({}), {
  maxFileBytes: DEFAULT_MAX_RESOURCE_FILE_MIB * MEBIBYTE,
  maxResources: DEFAULT_MAX_PROJECT_RESOURCES,
  maxProjectBytes: DEFAULT_MAX_PROJECT_MIB * MEBIBYTE
});

assert.deepEqual(normalizeResourceLimits({
  maxFileSizeMb: Number.NaN,
  maxProjectResources: "many",
  maxProjectSizeMb: Number.POSITIVE_INFINITY
}), {
  maxFileBytes: DEFAULT_MAX_RESOURCE_FILE_MIB * MEBIBYTE,
  maxResources: DEFAULT_MAX_PROJECT_RESOURCES,
  maxProjectBytes: DEFAULT_MAX_PROJECT_MIB * MEBIBYTE
});

assert.deepEqual(normalizeResourceLimits({
  maxFileSizeMb: 999,
  maxProjectResources: 9999,
  maxProjectSizeMb: 9999
}), {
  maxFileBytes: HARD_MAX_RESOURCE_FILE_MIB * MEBIBYTE,
  maxResources: HARD_MAX_PROJECT_RESOURCES,
  maxProjectBytes: HARD_MAX_PROJECT_MIB * MEBIBYTE
});

const projectSmallerThanFile = normalizeResourceLimits({ maxFileSizeMb: 32, maxProjectSizeMb: 8 });
assert.equal(projectSmallerThanFile.maxFileBytes, 8 * MEBIBYTE);
assert.equal(projectSmallerThanFile.maxProjectBytes, 8 * MEBIBYTE);

const fractional = normalizeResourceLimits({ maxFileSizeMb: 1.5, maxProjectResources: 4.9, maxProjectSizeMb: 2.5 });
assert.equal(fractional.maxFileBytes, 1.5 * MEBIBYTE);
assert.equal(fractional.maxResources, 4);
assert.equal(fractional.maxProjectBytes, 2.5 * MEBIBYTE);

console.log("resource settings: defaults, invalid values, hard clamps, and file/project ordering passed");
