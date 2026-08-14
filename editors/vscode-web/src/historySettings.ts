export const HISTORY_MEBIBYTE = 1024 * 1024;
export const DEFAULT_HISTORY_MAX_SNAPSHOTS = 0;
export const DEFAULT_HISTORY_MAX_SIZE_MIB = 50;
export const HARD_MAX_HISTORY_SNAPSHOTS = 100_000;
export const HARD_MAX_HISTORY_SIZE_MIB = 4096;

export interface HistoryRetentionLimits {
  readonly maxSnapshots: number | null;
  readonly maxBytes: number | null;
}

export const UNLIMITED_HISTORY_LIMITS: HistoryRetentionLimits = Object.freeze({
  maxSnapshots: null,
  maxBytes: null,
});

export const DEFAULT_HISTORY_LIMITS: HistoryRetentionLimits = Object.freeze({
  maxSnapshots: null,
  maxBytes: DEFAULT_HISTORY_MAX_SIZE_MIB * HISTORY_MEBIBYTE,
});

export function normalizeHistoryLimits(values: {
  readonly maxSnapshots?: unknown;
  readonly maxSizeMb?: unknown;
}): HistoryRetentionLimits {
  const snapshots = normalizedNumber(
    values.maxSnapshots,
    DEFAULT_HISTORY_MAX_SNAPSHOTS,
    HARD_MAX_HISTORY_SNAPSHOTS,
    true,
  );
  const sizeMiB = normalizedNumber(
    values.maxSizeMb,
    DEFAULT_HISTORY_MAX_SIZE_MIB,
    HARD_MAX_HISTORY_SIZE_MIB,
    false,
  );
  return Object.freeze({
    maxSnapshots: snapshots === 0 ? null : snapshots,
    maxBytes: sizeMiB === 0 ? null : sizeMiB * HISTORY_MEBIBYTE,
  });
}

function normalizedNumber(value: unknown, fallback: number, maximum: number, integer: boolean): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  const normalized = integer ? Math.floor(value) : value;
  return Math.min(normalized, maximum);
}
