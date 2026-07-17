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
  | { readonly kind: "workspace"; readonly path: string }
  | {
      readonly kind: "package";
      readonly namespace: string;
      readonly name: string;
      readonly version: string;
      readonly generation: string;
      readonly path: string;
    }
  | {
      readonly kind: "generated";
      readonly producer: string;
      readonly origin: string;
      readonly path: string;
    };

export interface ProjectDigestInput {
  readonly logicalSource: LogicalSourceId;
  readonly sourceContent: SourceContentKey;
  readonly files: ReadonlyMap<LogicalProjectFileId, string>;
  readonly packageGenerations: ReadonlyMap<string, string>;
  readonly generatedDependencies: ReadonlyMap<string, string>;
  readonly projectOptions: ReadonlyMap<string, string>;
  readonly sourceMapDigest: string;
}

const encoder = new TextEncoder();

export function logicalSourceId(workspaceId: string, relativePath: string): LogicalSourceId {
  return `workspace:${workspaceId}/${canonicalRelativePath(relativePath)}` as LogicalSourceId;
}

export function canonicalRelativePath(path: string): string {
  if (path.startsWith("/") || path.includes("\\") || path.includes("://")) {
    throw new Error(`Non-canonical logical path: ${path}`);
  }
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Non-canonical logical path: ${path}`);
  }
  return segments.join("/");
}

export async function sourceContentKey(bytes: Uint8Array): Promise<SourceContentKey> {
  return await canonicalDigest("mmt-source-content-v1", [bytes]) as SourceContentKey;
}

export async function projectSnapshotKey(input: ProjectDigestInput): Promise<TypstProjectSnapshotKey> {
  const writer = new CanonicalWriter("mmt-typst-project-v1");
  writer.string(input.logicalSource);
  writer.string(input.sourceContent);
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

export async function runtimeArtifactKey(
  compiler: string,
  renderer: string,
  templateBundleDigest: string,
  fontSetDigest: string
): Promise<RuntimeArtifactKey> {
  return await canonicalDigest("mmt-runtime-artifact-v1", [
    encoder.encode(compiler),
    encoder.encode(renderer),
    encoder.encode(templateBundleDigest),
    encoder.encode(fontSetDigest)
  ]) as RuntimeArtifactKey;
}

export async function derivedKey(domain: string, fields: readonly string[]): Promise<string> {
  return canonicalDigest(domain, fields.map((field) => encoder.encode(field)));
}

function logicalFileSortKey(file: LogicalProjectFileId): string {
  switch (file.kind) {
    case "workspace": return `0\0${file.path}`;
    case "package": return `1\0${file.namespace}\0${file.name}\0${file.version}\0${file.generation}\0${file.path}`;
    case "generated": return `2\0${file.producer}\0${file.origin}\0${file.path}`;
  }
}

function writeLogicalFile(writer: CanonicalWriter, file: LogicalProjectFileId): void {
  switch (file.kind) {
    case "workspace": writer.strings(["workspace", canonicalRelativePath(file.path)]); break;
    case "package": writer.strings(["package", file.namespace, file.name, file.version, file.generation, canonicalRelativePath(file.path)]); break;
    case "generated": writer.strings(["generated", file.producer, file.origin, canonicalRelativePath(file.path)]); break;
  }
}

class CanonicalWriter {
  readonly #chunks: Uint8Array[] = [];

  constructor(domain: string) { this.string(domain); }

  bytes(value: Uint8Array): void {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(value.byteLength));
    this.#chunks.push(length, value);
  }

  string(value: string): void { this.bytes(encoder.encode(value)); }
  strings(values: readonly string[]): void { for (const value of values) this.string(value); }

  map<K, V>(map: ReadonlyMap<K, V>, key: (key: K) => string, write: (key: K, value: V) => void): void {
    const entries = [...map.entries()].sort(([left], [right]) => key(left).localeCompare(key(right), "en"));
    const count = new Uint8Array(8);
    new DataView(count.buffer).setBigUint64(0, BigInt(entries.length));
    this.bytes(count);
    for (const [entryKey, value] of entries) write(entryKey, value);
  }

  stringMap(map: ReadonlyMap<string, string>): void {
    this.map(map, (key) => key, (key, value) => this.strings([key, value]));
  }

  async digest(): Promise<string> {
    const size = this.#chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.#chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return hex(await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer));
  }
}

async function canonicalDigest(domain: string, fields: readonly Uint8Array[]): Promise<string> {
  const writer = new CanonicalWriter(domain);
  for (const field of fields) writer.bytes(field);
  return writer.digest();
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
