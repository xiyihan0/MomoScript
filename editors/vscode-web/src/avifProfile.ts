export interface SupportedAvifProfile {
  encoder: "avifenc";
  codec: "aom";
  qcolor: number;
  qalpha: number;
  yuv: "420" | "422" | "444";
  keyframe_interval: number;
  fps?: number;
  speed?: number;
  jobs?: number | string;
}

export function validateAvifProfile(value: unknown): asserts value is SupportedAvifProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AVIFS profile must be an object");
  }
  if (Reflect.get(value, "encoder") !== "avifenc" || Reflect.get(value, "codec") !== "aom") {
    throw new Error("AVIFS profile requires the supported avifenc/aom encoder");
  }
  const yuv = Reflect.get(value, "yuv");
  if (yuv !== "420" && yuv !== "422" && yuv !== "444") {
    throw new Error("AVIFS profile yuv must be 420, 422, or 444");
  }
  assertIntegerRange(value, "qcolor", 0, 100);
  assertIntegerRange(value, "qalpha", 0, 100);
  assertIntegerRange(value, "keyframe_interval", 1, Number.MAX_SAFE_INTEGER);
  assertOptionalNumber(value, "fps", 0, Number.POSITIVE_INFINITY, false);
  assertOptionalNumber(value, "speed", -1, 10, true);
  const jobs = Reflect.get(value, "jobs");
  if (jobs !== undefined) {
    const parsed = typeof jobs === "string" && /^\d+$/.test(jobs) ? Number(jobs) : jobs;
    if (parsed !== "all" && (!Number.isSafeInteger(parsed) || Number(parsed) < 1)) {
      throw new Error("AVIFS profile jobs must be a positive integer or 'all'");
    }
  }
}

function assertIntegerRange(value: object, field: string, minimum: number, maximum: number): void {
  const fieldValue = Reflect.get(value, field);
  if (!Number.isSafeInteger(fieldValue) || Number(fieldValue) < minimum || Number(fieldValue) > maximum) {
    throw new Error(`AVIFS profile ${field} is outside the supported range`);
  }
}

function assertOptionalNumber(
  value: object,
  field: string,
  minimumExclusive: number,
  maximum: number,
  integer: boolean
): void {
  const fieldValue = Reflect.get(value, field);
  if (fieldValue === undefined) return;
  if (
    typeof fieldValue !== "number"
    || !Number.isFinite(fieldValue)
    || fieldValue <= minimumExclusive
    || fieldValue > maximum
    || (integer && !Number.isInteger(fieldValue))
  ) {
    throw new Error(`AVIFS profile ${field} is outside the supported range`);
  }
}
