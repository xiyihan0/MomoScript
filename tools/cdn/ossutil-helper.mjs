import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function runOss(args, allowMissing = false) {
  try {
    return { ...(await exec("ossutil", args, { maxBuffer: 16 * 1024 * 1024 })), missing: false };
  } catch (error) {
    const stdout = outputText(error?.stdout);
    const stderr = outputText(error?.stderr);
    const details = [stdout, stderr, error?.message].filter(Boolean).join("\n");
    if (allowMissing && details.includes("StatusCode=404") && details.includes("ErrorCode=NoSuchKey")) {
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

export function assertMetadata(stat, expected, target) {
  for (const [name, value] of Object.entries(expected)) {
    const pattern = new RegExp(`^${escapeRegExp(name)}\\s*:\\s*${escapeRegExp(value)}$`, "mi");
    if (!pattern.test(stat)) throw new Error(`${target} metadata ${name} != ${value}`);
  }
}

export function metadataArgument(metadata) {
  return Object.entries(metadata).map(([name, value]) => `${name}:${value}`).join("#");
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
