export const MEBIBYTE = 1024 * 1024;
export const DEFAULT_MAX_RESOURCE_FILE_MIB = 20;
export const DEFAULT_MAX_PROJECT_RESOURCES = 128;
export const DEFAULT_MAX_PROJECT_MIB = 64;
export const HARD_MAX_RESOURCE_FILE_MIB = 64;
export const HARD_MAX_PROJECT_RESOURCES = 512;
export const HARD_MAX_PROJECT_MIB = 256;

export interface ResourceSettingValues {
  maxFileSizeMb?: unknown;
  maxProjectResources?: unknown;
  maxProjectSizeMb?: unknown;
}

export interface NormalizedResourceLimits {
  maxFileBytes: number;
  maxResources: number;
  maxProjectBytes: number;
}

export function normalizeResourceLimits(values: ResourceSettingValues): NormalizedResourceLimits {
  const maxProjectMiB = finiteRange(
    values.maxProjectSizeMb,
    DEFAULT_MAX_PROJECT_MIB,
    1,
    HARD_MAX_PROJECT_MIB
  );
  const maxFileMiB = Math.min(
    finiteRange(values.maxFileSizeMb, DEFAULT_MAX_RESOURCE_FILE_MIB, 1, HARD_MAX_RESOURCE_FILE_MIB),
    maxProjectMiB
  );
  const maxResources = Math.trunc(finiteRange(
    values.maxProjectResources,
    DEFAULT_MAX_PROJECT_RESOURCES,
    1,
    HARD_MAX_PROJECT_RESOURCES
  ));
  return {
    maxFileBytes: Math.floor(maxFileMiB * MEBIBYTE),
    maxResources,
    maxProjectBytes: Math.floor(maxProjectMiB * MEBIBYTE)
  };
}

function finiteRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}
