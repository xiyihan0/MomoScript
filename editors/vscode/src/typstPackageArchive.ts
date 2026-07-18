import { canonicalRelativePath } from "./runtimeIdentity";
import { checkedPackageSpec, packageSpecKey, type PackageSpec } from "./typstPackageProtocol";

const TAR_BLOCK_BYTES = 512;
const DEFAULT_CONTENT_TYPES = Object.freeze([
  "application/gzip",
  "application/x-gzip",
  "application/octet-stream",
  "application/x-tar"
]);

export interface TypstPackageLimits {
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly perFileBytes: number;
  readonly fileCount: number;
  readonly redirects: number;
}

export const DEFAULT_TYPST_PACKAGE_LIMITS: TypstPackageLimits = Object.freeze({
  compressedBytes: 16 * 1024 * 1024,
  expandedBytes: 64 * 1024 * 1024,
  perFileBytes: 8 * 1024 * 1024,
  fileCount: 2048,
  redirects: 4
});

export interface PackageDistribution {
  readonly registryId: string;
  readonly url: string;
  readonly allowedHosts: ReadonlySet<string>;
  readonly expectedSize?: number;
  readonly expectedSha256?: string;
  readonly contentTypes?: readonly string[];
  readonly allowLoopbackHttp?: boolean;
}

export interface PackageRegistryAdapter {
  readonly identity: string;
  resolve(spec: PackageSpec, signal: AbortSignal): Promise<PackageDistribution | undefined>;
}

export interface PackageFetchInit {
  readonly method: "GET";
  readonly redirect: "manual";
  readonly signal: AbortSignal;
  readonly headers: Readonly<Record<string, string>>;
}

export type PackageFetch = (url: string, init: PackageFetchInit) => Promise<Response>;

export interface ValidatedPackageFile {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ValidatedPackageArchive {
  readonly spec: PackageSpec;
  readonly registryId: string;
  readonly archiveDigest: string;
  readonly filesDigest: string;
  readonly packageGeneration: string;
  readonly entrypoint: string;
  readonly files: readonly ValidatedPackageFile[];
  readonly expandedBytes: number;
}

export class TypstPackageAcquisitionError extends Error {
  constructor(
    readonly code:
      | "Unavailable"
      | "UnsafeRegistry"
      | "UnexpectedStatus"
      | "UnexpectedContentType"
      | "CompressedLimit"
      | "IntegrityMismatch"
      | "UnsafeArchive"
      | "ExpandedLimit"
      | "InvalidManifest",
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "TypstPackageAcquisitionError";
  }
}

export class OfficialPreviewRegistry implements PackageRegistryAdapter {
  readonly identity: string;
  readonly #baseUrl: URL;
  readonly #allowedHosts: ReadonlySet<string>;

  constructor(
    baseUrl = "https://packages.typst.org/preview/",
    allowedHosts: ReadonlySet<string> = new Set(["packages.typst.org"])
  ) {
    this.#baseUrl = new URL(baseUrl);
    if (this.#baseUrl.protocol !== "https:") throw new Error("Typst preview registry must use HTTPS");
    if (!allowedHosts.has(this.#baseUrl.hostname.toLowerCase())) {
      throw new Error("Typst preview registry base host is not allowlisted");
    }
    this.#allowedHosts = new Set([...allowedHosts].map((host) => host.toLowerCase()));
    this.identity = `preview:${this.#baseUrl.href}`;
  }

  async resolve(spec: PackageSpec, signal: AbortSignal): Promise<PackageDistribution | undefined> {
    if (signal.aborted) throw abortReason(signal);
    if (spec.namespace !== "preview") return undefined;
    const checked = checkedPackageSpec(spec);
    return {
      registryId: this.identity,
      url: new URL(`${checked.name}-${checked.version}.tar.gz`, this.#baseUrl).href,
      allowedHosts: this.#allowedHosts,
      contentTypes: DEFAULT_CONTENT_TYPES
    };
  }
}

export async function acquireTypstPackage(
  spec: PackageSpec,
  distribution: PackageDistribution,
  fetchPackage: PackageFetch,
  signal: AbortSignal,
  limits: TypstPackageLimits = DEFAULT_TYPST_PACKAGE_LIMITS
): Promise<ValidatedPackageArchive> {
  checkedPackageSpec(spec);
  validateLimits(limits);
  const response = await fetchRedirectSafe(distribution, fetchPackage, signal, limits.redirects);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const acceptedTypes = distribution.contentTypes ?? DEFAULT_CONTENT_TYPES;
  if (!contentType || !acceptedTypes.includes(contentType)) {
    await response.body?.cancel();
    throw new TypstPackageAcquisitionError(
      "UnexpectedContentType",
      `Unexpected Typst package content type: ${contentType ?? "missing"}`
    );
  }
  const declaredLength = checkedOptionalByteCount(response.headers.get("content-length"), "Content-Length");
  if (declaredLength !== undefined && declaredLength > limits.compressedBytes) {
    await response.body?.cancel();
    throw new TypstPackageAcquisitionError("CompressedLimit", "Typst package exceeds the compressed byte limit");
  }
  if (distribution.expectedSize !== undefined) {
    checkedByteCount(distribution.expectedSize, "Expected archive size");
    if (declaredLength !== undefined && declaredLength !== distribution.expectedSize) {
      await response.body?.cancel();
      throw new TypstPackageAcquisitionError("IntegrityMismatch", "Typst package declared size differs from response size");
    }
  }

  let compressed: Uint8Array;
  try {
    compressed = await readBoundedBody(response, limits.compressedBytes, signal);
  } catch (error) {
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  if (distribution.expectedSize !== undefined && compressed.byteLength !== distribution.expectedSize) {
    throw new TypstPackageAcquisitionError("IntegrityMismatch", "Typst package archive size mismatch");
  }
  const archiveDigest = await sha256Hex(compressed);
  if (distribution.expectedSha256 !== undefined
    && archiveDigest !== checkedSha256(distribution.expectedSha256)) {
    throw new TypstPackageAcquisitionError("IntegrityMismatch", "Typst package archive digest mismatch");
  }

  const archiveBytes = await decompressArchive(compressed, contentType, limits.expandedBytes, signal);
  const files = parseTarArchive(archiveBytes, limits);
  const entrypoint = validateTypstManifest(spec, files);
  const filesDigest = await digestPackageFiles(files);
  const packageGeneration = await packageGenerationDigest(
    distribution.registryId,
    spec,
    archiveDigest,
    filesDigest
  );
  return Object.freeze({
    spec,
    registryId: distribution.registryId,
    archiveDigest,
    filesDigest,
    packageGeneration,
    entrypoint,
    files: Object.freeze(files),
    expandedBytes: files.reduce((total, file) => total + file.bytes.byteLength, 0)
  });
}

export function parseTarArchive(
  bytes: Uint8Array,
  limits: TypstPackageLimits = DEFAULT_TYPST_PACKAGE_LIMITS
): ValidatedPackageFile[] {
  validateLimits(limits);
  const files: ValidatedPackageFile[] = [];
  const canonical = new Set<string>();
  const folded = new Map<string, string>();
  let expandedBytes = 0;
  let offset = 0;
  let terminated = false;
  while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    offset += TAR_BLOCK_BYTES;
    if (header.every((value) => value === 0)) {
      terminated = true;
      break;
    }
    validateTarChecksum(header);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const path = canonicalArchivePath(prefix ? `${prefix}/${name}` : name);
    const size = tarOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    if (canonical.has(path)) {
      throw new TypstPackageAcquisitionError("UnsafeArchive", `Duplicate archive path: ${path}`);
    }
    const caseFolded = path.toLocaleLowerCase("en-US");
    const collision = folded.get(caseFolded);
    if (collision !== undefined && collision !== path) {
      throw new TypstPackageAcquisitionError("UnsafeArchive", `Case-fold archive collision: ${collision} and ${path}`);
    }
    canonical.add(path);
    folded.set(caseFolded, path);

    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (offset + paddedSize > bytes.byteLength) {
      throw new TypstPackageAcquisitionError("UnsafeArchive", `Truncated archive entry: ${path}`);
    }
    if (type === "5") {
      if (size !== 0) throw new TypstPackageAcquisitionError("UnsafeArchive", `Directory entry contains bytes: ${path}`);
    } else if (type === "\0" || type === "0") {
      if (files.length >= limits.fileCount) {
        throw new TypstPackageAcquisitionError("ExpandedLimit", "Typst package exceeds the file-count limit");
      }
      if (size > limits.perFileBytes) {
        throw new TypstPackageAcquisitionError("ExpandedLimit", `Typst package file exceeds the per-file limit: ${path}`);
      }
      expandedBytes += size;
      if (expandedBytes > limits.expandedBytes) {
        throw new TypstPackageAcquisitionError("ExpandedLimit", "Typst package exceeds the expanded byte limit");
      }
      files.push(Object.freeze({ path, bytes: bytes.slice(offset, offset + size) }));
    } else {
      const label = ({ "1": "hard link", "2": "symbolic link", "3": "character device", "4": "block device", "6": "FIFO" } as Record<string, string>)[type]
        ?? `unknown entry type ${JSON.stringify(type)}`;
      throw new TypstPackageAcquisitionError("UnsafeArchive", `Rejected archive ${label}: ${path}`);
    }
    offset += paddedSize;
  }
  if (!terminated) throw new TypstPackageAcquisitionError("UnsafeArchive", "Typst package tar archive has no terminator");
  return files.sort((left, right) => left.path.localeCompare(right.path, "en-US"));
}

export function validateTypstManifest(spec: PackageSpec, files: readonly ValidatedPackageFile[]): string {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const manifest = byPath.get("typst.toml");
  if (!manifest) throw new TypstPackageAcquisitionError("InvalidManifest", "Typst package is missing typst.toml");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes);
  } catch {
    throw new TypstPackageAcquisitionError("InvalidManifest", "Typst package manifest is not valid UTF-8");
  }
  const parsed = parseTomlStrings(text);
  const namespace = parsed.get("package.namespace")?.[0];
  const name = parsed.get("package.name")?.[0];
  const version = parsed.get("package.version")?.[0];
  if (namespace !== spec.namespace || name !== spec.name || version !== spec.version) {
    throw new TypstPackageAcquisitionError(
      "InvalidManifest",
      `Typst package manifest identity does not match ${packageSpecKey(spec)}`
    );
  }
  const entrypoint = parsed.get("package.entrypoint")?.[0];
  if (!entrypoint) throw new TypstPackageAcquisitionError("InvalidManifest", "Typst package manifest has no entrypoint");
  for (const [key, values] of parsed) {
    const field = key.slice(key.lastIndexOf(".") + 1).toLowerCase();
    if (!/(?:entrypoint|path|paths|file|files)$/.test(field)) continue;
    for (const value of values) {
      let path: string;
      try {
        path = canonicalArchivePath(value);
      } catch (error) {
        throw new TypstPackageAcquisitionError(
          "InvalidManifest",
          `Unsafe Typst package manifest path ${key}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (!byPath.has(path)) {
        throw new TypstPackageAcquisitionError("InvalidManifest", `Typst package manifest path is missing or not a regular file: ${path}`);
      }
    }
  }
  return canonicalArchivePath(entrypoint);
}

export function canonicalArchivePath(value: string): string {
  if (value.length === 0 || value.includes("\0") || value.includes("\\")
    || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new TypstPackageAcquisitionError("UnsafeArchive", `Unsafe archive path: ${JSON.stringify(value)}`);
  }
  try {
    return canonicalRelativePath(value);
  } catch {
    throw new TypstPackageAcquisitionError("UnsafeArchive", `Unsafe archive path: ${JSON.stringify(value)}`);
  }
}

async function fetchRedirectSafe(
  distribution: PackageDistribution,
  fetchPackage: PackageFetch,
  signal: AbortSignal,
  maxRedirects: number
): Promise<Response> {
  let current = checkedRegistryUrl(distribution.url, distribution);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (signal.aborted) throw abortReason(signal);
    let response: Response;
    try {
      response = await fetchPackage(current.href, {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { Accept: "application/gzip, application/x-gzip, application/x-tar, application/octet-stream" }
      });
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      throw new TypstPackageAcquisitionError(
        "Unavailable",
        `Typst package registry is unavailable: ${error instanceof Error ? error.message : String(error)}`,
        true
      );
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new TypstPackageAcquisitionError("UnsafeRegistry", "Typst package redirect has no Location header");
      if (redirect === maxRedirects) throw new TypstPackageAcquisitionError("UnsafeRegistry", "Typst package redirect limit exceeded");
      current = checkedRegistryUrl(new URL(location, current).href, distribution);
      continue;
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new TypstPackageAcquisitionError("Unavailable", "Typst package was not found", false);
    }
    if (response.status !== 200 || response.type === "opaque" || response.type === "opaqueredirect") {
      await response.body?.cancel();
      throw new TypstPackageAcquisitionError("UnexpectedStatus", `Unexpected Typst package response status ${response.status}`);
    }
    if (response.url) checkedRegistryUrl(response.url, distribution);
    return response;
  }
  throw new TypstPackageAcquisitionError("UnsafeRegistry", "Typst package redirect limit exceeded");
}

function checkedRegistryUrl(value: string, distribution: PackageDistribution): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (url.protocol !== "https:" && !(distribution.allowLoopbackHttp === true && loopback && url.protocol === "http:")) {
    throw new TypstPackageAcquisitionError("UnsafeRegistry", `Typst package registry URL must use HTTPS: ${url.href}`);
  }
  if (!distribution.allowedHosts.has(host)) {
    throw new TypstPackageAcquisitionError("UnsafeRegistry", `Typst package registry host is not allowlisted: ${host}`);
  }
  if (url.username || url.password) throw new TypstPackageAcquisitionError("UnsafeRegistry", "Typst package registry URL must not contain credentials");
  return url;
}

async function readBoundedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new TypstPackageAcquisitionError("CompressedLimit", "Typst package exceeds the compressed byte limit");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      if (signal.aborted) throw abortReason(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > limit) throw new TypstPackageAcquisitionError("CompressedLimit", "Typst package exceeds the compressed byte limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function decompressArchive(
  compressed: Uint8Array,
  contentType: string,
  expandedLimit: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const gzip = contentType !== "application/x-tar"
    && compressed.byteLength >= 2
    && compressed[0] === 0x1f
    && compressed[1] === 0x8b;
  if (!gzip) {
    if (compressed.byteLength > expandedLimit) throw new TypstPackageAcquisitionError("ExpandedLimit", "Typst package exceeds the expanded byte limit");
    return compressed;
  }
  let stream: ReadableStream<Uint8Array>;
  try {
    stream = new Blob([compressed.slice().buffer as ArrayBuffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  } catch (error) {
    throw new TypstPackageAcquisitionError("UnsafeArchive", `Cannot decompress Typst package: ${String(error)}`);
  }
  const response = new Response(stream);
  try {
    return await readExpandedBody(response, expandedLimit, signal);
  } catch (error) {
    if (error instanceof TypstPackageAcquisitionError) throw error;
    throw new TypstPackageAcquisitionError("UnsafeArchive", `Cannot decompress Typst package: ${String(error)}`);
  }
}

async function readExpandedBody(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  try {
    return await readBoundedBody(response, limit, signal);
  } catch (error) {
    if (error instanceof TypstPackageAcquisitionError && error.code === "CompressedLimit") {
      throw new TypstPackageAcquisitionError("ExpandedLimit", "Typst package exceeds the expanded byte limit");
    }
    throw error;
  }
}

function parseTomlStrings(text: string): Map<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  let section = "";
  for (const original of text.split(/\r?\n/)) {
    const line = stripTomlComment(original).trim();
    if (!line) continue;
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      if (!/^[A-Za-z0-9_.-]+$/.test(section)) {
        throw new TypstPackageAcquisitionError("InvalidManifest", `Unsupported TOML section: ${section}`);
      }
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment) throw new TypstPackageAcquisitionError("InvalidManifest", `Unsupported TOML syntax: ${line}`);
    const key = section ? `${section}.${assignment[1]}` : assignment[1]!;
    const raw = assignment[2]!.trim();
    const values = raw.startsWith("[") ? parseTomlStringArray(raw) : [parseTomlString(raw)];
    if (result.has(key)) throw new TypstPackageAcquisitionError("InvalidManifest", `Duplicate TOML key: ${key}`);
    result.set(key, Object.freeze(values));
  }
  return result;
}

function stripTomlComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "#" && !quoted) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseTomlStringArray(raw: string): string[] {
  if (!raw.endsWith("]")) throw new TypstPackageAcquisitionError("InvalidManifest", "Unterminated TOML array");
  const inner = raw.slice(1, -1).trim();
  if (!inner) return [];
  const values: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index <= inner.length; index += 1) {
    const character = inner[index];
    if (index === inner.length || (character === "," && !quoted)) {
      values.push(parseTomlString(inner.slice(start, index).trim()));
      start = index + 1;
    } else if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    }
  }
  if (quoted) throw new TypstPackageAcquisitionError("InvalidManifest", "Unterminated TOML string array");
  return values;
}

function parseTomlString(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) {
    throw new TypstPackageAcquisitionError("InvalidManifest", "Package identity and path fields must be TOML strings");
  }
  try {
    return JSON.parse(raw) as string;
  } catch {
    throw new TypstPackageAcquisitionError("InvalidManifest", "Invalid TOML basic string");
  }
}

function tarString(header: Uint8Array, offset: number, length: number): string {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  const bytes = end < 0 ? field : field.subarray(0, end);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypstPackageAcquisitionError("UnsafeArchive", "Archive path is not valid UTF-8");
  }
}

function tarOctal(header: Uint8Array, offset: number, length: number): number {
  const raw = new TextDecoder().decode(header.subarray(offset, offset + length)).replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(raw)) throw new TypstPackageAcquisitionError("UnsafeArchive", `Invalid tar size: ${JSON.stringify(raw)}`);
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new TypstPackageAcquisitionError("UnsafeArchive", "Tar entry size is out of range");
  return value;
}

function validateTarChecksum(header: Uint8Array): void {
  const expected = tarOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  if (actual !== expected) throw new TypstPackageAcquisitionError("UnsafeArchive", "Tar header checksum mismatch");
}

export async function digestPackageFiles(files: readonly ValidatedPackageFile[]): Promise<string> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [encoder.encode("mmt-typst-package-files-v1")];
  for (const file of files) {
    const path = encoder.encode(file.path);
    const lengths = new Uint8Array(16);
    const view = new DataView(lengths.buffer);
    view.setBigUint64(0, BigInt(path.byteLength));
    view.setBigUint64(8, BigInt(file.bytes.byteLength));
    chunks.push(lengths, path, file.bytes);
  }
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return sha256Hex(bytes);
}
export async function packageGenerationDigest(
  registryId: string,
  spec: PackageSpec,
  archiveDigest: string,
  filesDigest: string
): Promise<string> {
  const generationBytes = new TextEncoder().encode([
    "mmt-typst-package-generation-v1",
    registryId,
    packageSpecKey(spec),
    archiveDigest,
    filesDigest
  ].join("\0"));
  return sha256Hex(generationBytes);
}


async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function checkedSha256(value: string): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw new Error("Invalid expected SHA-256 digest");
  return normalized;
}

function checkedOptionalByteCount(value: string | null, label: string): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) throw new TypstPackageAcquisitionError("IntegrityMismatch", `${label} is invalid`);
  const parsed = Number(value);
  checkedByteCount(parsed, label);
  return parsed;
}

function checkedByteCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is out of range`);
}

function validateLimits(limits: TypstPackageLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid Typst package ${name} limit`);
  }
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Typst package request cancelled", "AbortError");
}
