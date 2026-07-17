import type { PackManifestSource } from "../../vscode/src/packSync";
import type { TypstRenderProjectUpdate, TypstResourceRequest } from "../../vscode/src/tinymistClient";
import type { BoundedStringCache } from "./boundedStringCache";
import { fetchSequenceOnce, sequenceFetchKey } from "./resourceFetchCache.ts";

export interface MaterializationPackSource extends PackManifestSource {
  cacheIdentity: string;
}

type ImageSequenceResource = Extract<TypstResourceRequest, { kind: "image-sequence" }>;
export const MAX_PROJECT_RESOURCE_COUNT = 128;
export const MAX_PROJECT_RESOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_PROJECT_RESOURCE_CONCURRENCY = 1;

export interface ResourceMaterializationLimits {
  maxResources: number;
  maxBytes: number;
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
}
export interface ResourceMaterializationDiagnostic {
  phase: "fetch" | "decode";
  message: string;
}

export async function materializeProjectResources(
  project: TypstRenderProjectUpdate,
  sources: Map<string, MaterializationPackSource>,
  cache: Pick<BoundedStringCache, "get" | "set">,
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
        : `image-sequence:webcodecs-v1:${resource.sha256}:${resource.frame}:${JSON.stringify(resource.profile)}:${resource.size.join("x")}`;
      let dataBase64 = cache.get(cacheKey);
      if (dataBase64 === undefined) {
        const bytes = resource.kind === "image-dir"
          ? await dependencies.fetch(url, signal)
          : await fetchSequenceOnce(
            sequenceFetches,
            sequenceFetchKey(url, resource.sha256),
            async () => {
              const sequence = await dependencies.fetch(url, signal);
              assertResourceBudget(retainedSequenceBytes + retainedBase64Bytes + sequence.byteLength, limits);
              retainedSequenceBytes += sequence.byteLength;
              return sequence;
            }
          );
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
        assertResourceBudget(
          retainedSequenceBytes + retainedBase64Bytes + transientBytes + base64Bytes,
          limits
        );
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
  return { project: { ...project, files }, diagnostics };
}

function assertResourceBudget(bytes: number, limits: ResourceMaterializationLimits): void {
  if (!Number.isSafeInteger(bytes) || bytes > limits.maxBytes) {
    throw new ResourceBudgetError(`Project resource memory budget exceeds ${limits.maxBytes} bytes`);
  }
}
