import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);
const MINIMUM_OSSUTIL_VERSION = [2, 3, 0];

export const DEFAULT_BUCKET = "mms-pack";
export const DEFAULT_ORIGIN = "https://mms-pack.esa.xiyihan.cn";
export const DEFAULT_REGION = "cn-shanghai";

export function ossutilGlobalArguments({
  configFile,
  profile,
  region = DEFAULT_REGION,
} = {}) {
  const args = ["--region", region];
  if (configFile) args.push("--config-file", configFile);
  if (profile) args.push("--profile", profile);
  return args;
}

export function objectPropertyArguments(metadata) {
  const args = [];
  if (metadata["Content-Type"] !== undefined) {
    args.push("--content-type", metadata["Content-Type"]);
  }
  if (metadata["Cache-Control"] !== undefined) {
    args.push("--cache-control", metadata["Cache-Control"]);
  }
  if (metadata["Content-Encoding"] !== undefined) {
    args.push("--content-encoding", metadata["Content-Encoding"]);
  }
  return args;
}

export function parseStatJson(stat, target = "ossutil stat output") {
  try {
    const source = typeof stat === "string" ? stat.trim() : String(stat);
    const objectStart = source.indexOf("{");
    const objectEnd = source.lastIndexOf("}");
    const payload = objectStart >= 0 && objectEnd >= objectStart
      ? source.slice(objectStart, objectEnd + 1)
      : source;
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `${target} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function statMetadata(stat, target) {
  const parsed = typeof stat === "string" ? parseStatJson(stat, target) : stat;
  return {
    "Content-Type": findJsonProperty(parsed, "contenttype"),
    "Cache-Control": findJsonProperty(parsed, "cachecontrol"),
    "Content-Encoding": findJsonProperty(parsed, "contentencoding"),
  };
}

export function assertMetadata(stat, expected, target) {
  const actual = statMetadata(stat, target);
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) {
      throw new Error(`${target} metadata ${name} ${JSON.stringify(actual[name])} != ${JSON.stringify(value)}`);
    }
  }
}

export function isMissingObjectError(details) {
  return details.includes("Http Status Code: 404") && details.includes("Error Code: NoSuchKey");
}

export async function assertOssutilV2(runOssCommand = runOss) {
  const { stdout, stderr } = await runOssCommand(["version"]);
  const details = [outputText(stdout), outputText(stderr)].filter(Boolean).join("\n");
  const match = /(?:^|\D)(\d+)\.(\d+)\.(\d+)(?:\D|$)/.exec(details);
  const version = match?.slice(1, 4).map(Number);
  if (!version || compareVersion(version, MINIMUM_OSSUTIL_VERSION) < 0) {
    throw new Error(`ossutil >= 2.3.0 is required${details ? `; found ${details}` : ""}`);
  }
  return version.join(".");
}

export async function runOss(args, allowMissing = false) {
  try {
    return { ...(await exec("ossutil", args, { maxBuffer: 16 * 1024 * 1024 })), missing: false };
  } catch (error) {
    const stdout = outputText(error?.stdout);
    const stderr = outputText(error?.stderr);
    const details = [stdout, stderr, error?.message].filter(Boolean).join("\n");
    if (allowMissing && isMissingObjectError(details)) {
      return { stdout: "", stderr: details, missing: true };
    }
    throw new Error(`ossutil ${args[0]} failed: ${details || String(error)}`);
  }
}

export function outputText(value) {
  if (typeof value === "string") return value.trim();
  if (value instanceof Uint8Array) return new TextDecoder().decode(value).trim();
  return "";
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function findJsonProperty(value, normalizedName) {
  if (!value || typeof value !== "object") return undefined;
  for (const [name, property] of Object.entries(value)) {
    if (name.replaceAll("-", "").replaceAll("_", "").toLowerCase() === normalizedName) {
      return typeof property === "string" ? property : undefined;
    }
  }
  for (const property of Object.values(value)) {
    const found = findJsonProperty(property, normalizedName);
    if (found !== undefined) return found;
  }
  return undefined;
}

function compareVersion(left, right) {
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}
