import type { PackManifestSource } from "./packSync.ts";
import { canonicalBytesDigest } from "./runtimeIdentity.ts";
import type { TypstRenderProjectUpdate, TypstResourceRequest } from "./tinymistClient.ts";

export interface MaterializationPackSource extends PackManifestSource {
  readonly cacheIdentity: string;
}

export interface StringResourceCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

type ImageSequenceResource = Extract<TypstResourceRequest, { kind: "image-sequence" }>;
export const MAX_PROJECT_RESOURCE_COUNT = 128;
export const MAX_PROJECT_RESOURCE_CONCURRENCY = 1;
export const MAX_PROJECT_RESOURCE_BYTES = 64 * 1024 * 1024;

export interface ResourceMaterializationLimits {
  readonly maxResources: number;
  readonly maxBytes: number;
}

const DEFAULT_LIMITS: ResourceMaterializationLimits = {
  maxResources: MAX_PROJECT_RESOURCE_COUNT,
  maxBytes: MAX_PROJECT_RESOURCE_BYTES
};

class ResourceBudgetError extends Error {}

export interface ResourceMaterializationDependencies {
  resourceUrl(source: MaterializationPackSource, resource: TypstResourceRequest): URL;
  fetch(url: URL, signal: AbortSignal): Promise<Uint8Array>;
  decodeSequence(bytes: Uint8Array, resource: ImageSequenceResource, signal: AbortSignal): Promise<Uint8Array>;
  encodeBase64(bytes: Uint8Array): string;
  decodeBase64(value: string): Uint8Array;
}

export interface ResourceMaterializationDiagnostic {
  readonly phase: "fetch" | "decode";
  readonly message: string;
}

/** Host-neutral, bounded materialization shared by browser and native preview. */
export async function materializeProjectResources(
  project: TypstRenderProjectUpdate,
  sources: Map<string, MaterializationPackSource>,
  cache: StringResourceCache,
  signal: AbortSignal,
  dependencies: ResourceMaterializationDependencies,
  limits: ResourceMaterializationLimits = DEFAULT_LIMITS
): Promise<{ project: TypstRenderProjectUpdate; diagnostics: ResourceMaterializationDiagnostic[] }> {
  const files = [...project.files];
  const diagnostics: ResourceMaterializationDiagnostic[] = [];
  if (project.resources.length > limits.maxResources) {
    diagnostics.push({ phase: "fetch", message: `Project requests ${project.resources.length} resources; limit is ${limits.maxResources}` });
    return { project: { ...project, files }, diagnostics };
  }
  let retainedSequenceBytes = 0;
  let retainedBase64Bytes = 0;
  const sequenceFetches = new Map<string, Promise<Uint8Array>>();
  for (const resource of project.resources) {
    if (resource.kind === "workspace-file") {
      if (!files.some((file) => file.uri === resource.uri)) {
        diagnostics.push({ phase: "fetch", message: `Workspace resource '${resource.fileName}' was not mirrored` });
      }
      continue;
    }
    let phase: ResourceMaterializationDiagnostic["phase"] = "fetch";
    try {
      const source = sources.get(resource.packNamespace);
      if (!source) throw new Error(`Pack source '${resource.packNamespace}' is unavailable`);
      const url = dependencies.resourceUrl(source, resource);
      const cacheKey = resource.kind === "image-dir"
        ? `image-dir:${source.cacheIdentity}:${url.href}`
        : `image-sequence:native-or-web-v1:${resource.sha256}:${resource.frame}:${JSON.stringify(resource.profile)}:${resource.size.join("x")}`;
      let dataBase64 = cache.get(cacheKey);
      if (dataBase64 === undefined) {
        const bytes = resource.kind === "image-dir"
          ? await dependencies.fetch(url, signal)
          : await fetchSequenceOnce(sequenceFetches, `${url.href}:${resource.sha256}`, async () => {
            const sequence = await dependencies.fetch(url, signal);
            assertResourceBudget(retainedSequenceBytes + retainedBase64Bytes + sequence.byteLength, limits);
            retainedSequenceBytes += sequence.byteLength;
            return sequence;
          });
        let materialized: Uint8Array;
        if (resource.kind === "image-dir") {
          materialized = bytes;
        } else {
          phase = "decode";
          materialized = await dependencies.decodeSequence(bytes.slice(), resource, signal);
          phase = "fetch";
        }
        const transientBytes = resource.kind === "image-dir" ? bytes.byteLength : materialized.byteLength;
        dataBase64 = dependencies.encodeBase64(materialized);
        const base64Bytes = dataBase64.length * 2;
        assertResourceBudget(retainedSequenceBytes + retainedBase64Bytes + transientBytes + base64Bytes, limits);
        retainedBase64Bytes += base64Bytes;
        cache.set(cacheKey, dataBase64);
      } else {
        const base64Bytes = dataBase64.length * 2;
        assertResourceBudget(retainedSequenceBytes + retainedBase64Bytes + base64Bytes, limits);
        retainedBase64Bytes += base64Bytes;
      }
      files.push({ uri: resource.uri, dataBase64 });
    } catch (error) {
      if (signal.aborted) throw error;
      diagnostics.push({
        phase,
        message: `Failed to materialize character resource: ${error instanceof Error ? error.message : String(error)}`
      });
      if (error instanceof ResourceBudgetError) break;
    }
  }
  const digestFields: Uint8Array[] = [];
  const encoder = new TextEncoder();
  for (const resource of [...project.resources].sort((left, right) => left.id - right.id)) {
    const { uri: _uri, range: _range, ...logicalResource } = resource;
    digestFields.push(encoder.encode(JSON.stringify(logicalResource)));
    const file = files.find((candidate) => candidate.uri === resource.uri);
    if (!file) {
      digestFields.push(encoder.encode("missing"));
    } else if (file.text !== undefined) {
      digestFields.push(encoder.encode(file.text));
    } else {
      digestFields.push(dependencies.decodeBase64(file.dataBase64));
    }
  }
  const resourceBytesDigest = await canonicalBytesDigest("mmt-resource-bytes-v1", digestFields);
  return { project: { ...project, files, resourceBytesDigest }, diagnostics };
}

function assertResourceBudget(bytes: number, limits: ResourceMaterializationLimits): void {
  if (!Number.isSafeInteger(bytes) || bytes > limits.maxBytes) {
    throw new ResourceBudgetError(`Project resource memory budget exceeds ${limits.maxBytes} bytes`);
  }
}

async function fetchSequenceOnce(
  requests: Map<string, Promise<Uint8Array>>,
  key: string,
  fetcher: () => Promise<Uint8Array>
): Promise<Uint8Array> {
  const existing = requests.get(key);
  if (existing !== undefined) return await existing;
  const request = fetcher();
  requests.set(key, request);
  try {
    return await request;
  } catch (error) {
    requests.delete(key);
    throw error;
  }
}
