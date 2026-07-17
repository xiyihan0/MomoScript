export type LogicalSourceId = string & { readonly __logicalSourceId: unique symbol };
export type SourceContentKey = string & { readonly __sourceContentKey: unique symbol };
export type SourceStaleToken = Readonly<{
  hostUri: string;
  documentIncarnation: string;
  documentVersion: number;
}>;
export type TypstProjectSnapshotKey = string & { readonly __typstProjectSnapshotKey: unique symbol };
export type ProjectionKey = string & { readonly __projectionKey: unique symbol };
export type MaterializationKey = string & { readonly __materializationKey: unique symbol };
export type RuntimeArtifactKey = string & { readonly __runtimeArtifactKey: unique symbol };
export type RenderKey = string & { readonly __renderKey: unique symbol };

export type LogicalProjectFileId =
  | {
      readonly kind: "workspace";
      readonly logicalWorkspaceId: string;
      readonly canonicalWorkspaceRelativePath: string;
    }
  | {
      readonly kind: "package";
      readonly namespace: string;
      readonly name: string;
      readonly version: string;
      readonly packageGenerationDigest: string;
      readonly canonicalPackageRelativePath: string;
    }
  | {
      readonly kind: "generated";
      readonly dependencyOrigin: string;
      readonly producerDigest: string;
      readonly canonicalOriginRelativePath: string;
    };

export interface ProjectDigestInput {
  readonly logicalSource: LogicalSourceId;
  readonly sourceContent: SourceContentKey;
  readonly entryFile: LogicalProjectFileId;
  readonly files: ReadonlyMap<LogicalProjectFileId, string>;
  readonly packageGenerations: ReadonlyMap<string, string>;
  readonly generatedDependencies: ReadonlyMap<string, string>;
  readonly projectOptions: ReadonlyMap<string, string>;
  readonly sourceMapDigest: string;
}

const encoder = new TextEncoder();

export async function logicalSourceId(workspaceId: string, relativePath: string): Promise<LogicalSourceId> {
  checkedComponent(workspaceId);
  const writer = new CanonicalWriter("mmt-logical-source-v1");
  writer.strings([workspaceId, canonicalRelativePath(relativePath)]);
  return await writer.digest() as LogicalSourceId;
}

export function canonicalRelativePath(path: string): string {
  if (path.startsWith("/") || path.includes("\\") || isUriLike(path)) {
    throw new Error(`Non-canonical logical path: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Non-canonical logical path: ${path}`);
  }
  return segments.join("/");
}

export async function sourceContentKey(
  logicalSource: LogicalSourceId,
  bytes: Uint8Array
): Promise<SourceContentKey> {
  return await canonicalDigest("mmt-source-content-v1", [encoder.encode(logicalSource), bytes]) as SourceContentKey;
}

export async function projectSnapshotKey(input: ProjectDigestInput): Promise<TypstProjectSnapshotKey> {
  const writer = new CanonicalWriter("mmt-typst-project-v1");
  writer.string(input.logicalSource);
  writer.string(input.sourceContent);
  writeLogicalFile(writer, input.entryFile);
  writer.map(input.files, logicalFileSortKey, (file, digest) => {
    writeLogicalFile(writer, file);
    writer.string(digest);
  });
  writer.stringMap(input.packageGenerations);
  writer.stringMap(input.generatedDependencies);
  writer.stringMap(input.projectOptions);
  writer.string(input.sourceMapDigest);
  return await writer.digest() as TypstProjectSnapshotKey;
}

export async function projectionKey(
  source: SourceContentKey,
  session: string,
  revision: number,
  logicalEntryId: LogicalProjectFileId,
  projectDigest: TypstProjectSnapshotKey,
  mappingDigest: string
): Promise<ProjectionKey> {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid projection revision");
  const writer = new CanonicalWriter("mmt-projection-key-v1");
  writer.strings([source, session, String(revision)]);
  writeLogicalFile(writer, logicalEntryId);
  writer.strings([projectDigest, mappingDigest]);
  return await writer.digest() as ProjectionKey;
}

export async function materializationKey(
  projection: ProjectionKey,
  packRegistryDigest: string,
  resourcePlanDigest: string,
  resourceBytesDigest: string
): Promise<MaterializationKey> {
  return await derivedKey("mmt-materialization-key-v1", [
    projection,
    packRegistryDigest,
    resourcePlanDigest,
    resourceBytesDigest
  ]) as MaterializationKey;
}

export async function runtimeArtifactKey(
  typstCompilerVersion: string,
  typstWasmDigest: string,
  rendererVersion: string,
  rendererWasmDigest: string,
  templateBundleDigest: string,
  fontSetDigest: string
): Promise<RuntimeArtifactKey> {
  return await derivedKey("mmt-runtime-artifact-v1", [
    typstCompilerVersion,
    typstWasmDigest,
    rendererVersion,
    rendererWasmDigest,
    templateBundleDigest,
    fontSetDigest
  ]) as RuntimeArtifactKey;
}

export async function renderKey(
  materialization: MaterializationKey,
  runtime: RuntimeArtifactKey,
  renderOptionsDigest: string
): Promise<RenderKey> {
  return await derivedKey("mmt-render-key-v1", [materialization, runtime, renderOptionsDigest]) as RenderKey;
}

export async function derivedKey(domain: string, fields: readonly string[]): Promise<string> {
  return canonicalDigest(domain, fields.map((field) => encoder.encode(field)));
}

export async function canonicalBytesDigest(domain: string, fields: readonly Uint8Array[]): Promise<string> {
  return canonicalDigest(domain, fields);
}

function checkedComponent(value: string): void {
  if (!value || isUriLike(value)) throw new Error(`Non-canonical logical component: ${value}`);
}

function isUriLike(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function logicalFileSortKey(file: LogicalProjectFileId): Uint8Array {
  switch (file.kind) {
    case "workspace":
      return encoder.encode(`0\0${file.logicalWorkspaceId}\0${file.canonicalWorkspaceRelativePath}`);
    case "package":
      return encoder.encode(`1\0${file.namespace}\0${file.name}\0${file.version}\0${file.packageGenerationDigest}\0${file.canonicalPackageRelativePath}`);
    case "generated":
      return encoder.encode(`2\0${file.dependencyOrigin}\0${file.producerDigest}\0${file.canonicalOriginRelativePath}`);
  }
}

interface FieldWriter {
  strings(values: readonly string[]): void;
}

function writeLogicalFile(writer: FieldWriter, file: LogicalProjectFileId): void {
  switch (file.kind) {
    case "workspace":
      checkedComponent(file.logicalWorkspaceId);
      writer.strings(["workspace", file.logicalWorkspaceId, canonicalRelativePath(file.canonicalWorkspaceRelativePath)]);
      break;
    case "package":
      [file.namespace, file.name, file.version, file.packageGenerationDigest].forEach(checkedComponent);
      writer.strings([
        "package",
        file.namespace,
        file.name,
        file.version,
        file.packageGenerationDigest,
        canonicalRelativePath(file.canonicalPackageRelativePath)
      ]);
      break;
    case "generated":
      [file.dependencyOrigin, file.producerDigest].forEach(checkedComponent);
      writer.strings([
        "generated",
        file.dependencyOrigin,
        file.producerDigest,
        canonicalRelativePath(file.canonicalOriginRelativePath)
      ]);
      break;
  }
}

class CanonicalBytes implements FieldWriter {
  readonly chunks: Uint8Array[] = [];

  bytes(value: Uint8Array): void {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(value.byteLength));
    this.chunks.push(length, value);
  }

  string(value: string): void { this.bytes(encoder.encode(value)); }
  strings(values: readonly string[]): void { for (const value of values) this.string(value); }

  finish(): Uint8Array {
    const size = this.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}

class CanonicalWriter extends CanonicalBytes {
  constructor(domain: string) {
    super();
    this.string(domain);
  }

  map<K, V>(map: ReadonlyMap<K, V>, key: (key: K) => Uint8Array, write: (key: K, value: V) => void): void {
    const entries = [...map.entries()].sort(([left], [right]) => compareBytes(key(left), key(right)));
    const count = new Uint8Array(8);
    new DataView(count.buffer).setBigUint64(0, BigInt(entries.length));
    this.bytes(count);
    for (const [entryKey, value] of entries) write(entryKey, value);
  }

  stringMap(map: ReadonlyMap<string, string>): void {
    this.map(map, (key) => encoder.encode(key), (key, value) => this.strings([key, value]));
  }

  async digest(): Promise<string> {
    return hex(await crypto.subtle.digest("SHA-256", this.finish().buffer as ArrayBuffer));
  }
}

async function canonicalDigest(domain: string, fields: readonly Uint8Array[]): Promise<string> {
  const writer = new CanonicalWriter(domain);
  for (const field of fields) writer.bytes(field);
  return writer.digest();
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  }
  return left.length - right.length;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
