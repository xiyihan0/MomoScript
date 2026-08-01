import type { RenderKey } from "./runtimeIdentity.ts";
import {
  canonicalCompilerMountPath,
  previewCompilerSnapshotDigest,
  type PreviewCompilerSnapshotMount
} from "./runtimeIdentity.ts";
import type { TypstProjectUpdate, TypstVirtualFile } from "./tinymistClient";

export const PREVIEW_RENDERER_METHOD = "mmt/previewRenderer.v1";
export const PREVIEW_RENDERER_PROTOCOL_VERSION = "mmt-preview-renderer-v1";
export const PREVIEW_RENDERER_NEW_PREFIX = "new,";
export const PREVIEW_RENDERER_DIFF_V1_PREFIX = "diff-v1,";
const PREVIEW_MOUNT_ROOT = "/__mmt_preview";
const TEXT_ENCODER = new TextEncoder();

export type PreviewRendererRequest =
  | {
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly action: "register";
      readonly sessionId: string;
      readonly entryUri: string;
      readonly renderEntryUri: string;
      readonly sourceDigest: string;
      readonly mounts: readonly PreviewCompilerSnapshotMount[];
      readonly fontDigests: readonly string[];
      readonly files: readonly PreviewRendererFileRecord[];
    }
  | {
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly action: "render";
      readonly sessionId: string;
      readonly snapshotToken: RenderKey;
      readonly sourceDigest: string;
      readonly baseGeneration?: number;
      readonly forceFull?: boolean;
    }
  | {
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly action: "commit" | "discard";
      readonly sessionId: string;
      readonly snapshotToken: RenderKey;
      readonly generation: number;
    }
  | {
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly action: "locatePoint";
      readonly sessionId: string;
      readonly generation: number;
      readonly position: PreviewRendererPoint;
    }
  | {
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly action: "locateSource";
      readonly sessionId: string;
      readonly generation: number;
      readonly uri: string;
      readonly position: PreviewRendererPosition;
    }
  | {
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly action: "close";
      readonly sessionId: string;
    };

export interface PreviewRendererRenderOptions {
  readonly sessionId: string;
  readonly snapshotToken: RenderKey;
  readonly baseGeneration?: number;
  readonly forceFull?: boolean;
}

export interface PreviewRendererTransition {
  readonly action: "commit" | "discard";
  readonly sessionId: string;
  readonly snapshotToken: RenderKey;
  readonly generation: number;
}

export interface PreviewRendererRenderResult {
  readonly synchronized: SynchronizedPreviewProject;
  readonly response: PreviewRendererResponse;
}

export interface PreviewRendererPosition {
  readonly line: number;
  readonly character: number;
}

export interface PreviewRendererRange {
  readonly start: PreviewRendererPosition;
  readonly end: PreviewRendererPosition;
}

export interface PreviewRendererPoint {
  readonly pageIndex: number;
  readonly x: number;
  readonly y: number;
}

export interface PreviewRendererSourceLocation {
  readonly uri: string;
  readonly range: PreviewRendererRange;
}

export type PreviewRendererResponse =
  | PreviewRendererReady
  | {
      readonly status: "registered";
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly sessionId: string;
      readonly sourceDigest: string;
    }
  | {
      readonly status: "missingFiles";
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly sessionId: string;
      readonly sourceDigest: string;
      readonly contentDigests: readonly string[];
    }
  | {
      readonly status: "resync";
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly sessionId: string;
      readonly snapshotToken: RenderKey;
      readonly expectedBaseGeneration?: number;
    }
  | {
      readonly status: "committed" | "discarded";
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly sessionId: string;
      readonly snapshotToken: RenderKey;
      readonly generation: number;
    }
  | {
      readonly status: "locatedPoint";
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly sessionId: string;
      readonly generation: number;
      readonly location: PreviewRendererSourceLocation | null;
    }
  | {
      readonly status: "locatedSource";
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly sessionId: string;
      readonly generation: number;
      readonly locations: readonly PreviewRendererPoint[];
    }
  | {
      readonly status: "unavailable";
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly sessionId: string;
      readonly generation: number;
    }
  | {
      readonly status: "closed";
      readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
      readonly sessionId: string;
    };

export interface PreviewRendererReady {
  readonly status: "ready";
  readonly protocolVersion: typeof PREVIEW_RENDERER_PROTOCOL_VERSION;
  readonly sessionId: string;
  readonly snapshotToken: RenderKey;
  readonly sourceDigest: string;
  readonly artifactDigest: string;
  readonly compilerRevision: number;
  readonly generation: number;
  readonly baseGeneration: number;
  readonly frameKind: "new" | "diff-v1";
  readonly dataBase64: string;
  readonly byteLength: number;
  readonly pageCount: number;
}

export interface PreviewRendererFileRecord {
  readonly contentDigest: string;
  readonly dataBase64: string;
}

export interface PreviewRendererCompilerMount extends PreviewCompilerSnapshotMount, PreviewRendererFileRecord {}

export interface PreviewProjectMount {
  readonly logicalSourceId: string;
  readonly fonts?: readonly PreviewRendererFileRecord[];
}

export interface SynchronizedPreviewProject {
  readonly project: TypstProjectUpdate;
  readonly compilerEntryUri: string;
  readonly entryPath: string;
  readonly sourceDigest: string;
  readonly mounts: readonly PreviewRendererCompilerMount[];
  readonly fonts: readonly PreviewRendererFileRecord[];
}

export async function preparePreviewProject(
  update: TypstProjectUpdate,
  mount: PreviewProjectMount
): Promise<SynchronizedPreviewProject> {
  if (!/^[0-9a-f]{64}$/.test(mount.logicalSourceId)) {
    throw new Error("Preview project logicalSourceId must be a lowercase SHA-256 digest");
  }
  const fonts = Object.freeze([...(mount.fonts ?? [])]);
  const seenFontDigests = new Set<string>();
  for (const font of fonts) {
    if (!/^[0-9a-f]{64}$/.test(font.contentDigest)) {
      throw new Error("Preview renderer font contentDigest must be a lowercase SHA-256 digest");
    }
    if (!font.dataBase64 || seenFontDigests.has(font.contentDigest)) {
      throw new Error("Preview renderer fonts must have unique digests and non-empty bytes");
    }
    seenFontDigests.add(font.contentDigest);
  }
  if (!update.full) throw new Error("Preview compiler synchronization requires a complete project snapshot");
  const files = update.files.map((file) => syntheticPreviewFile(file, mount.logicalSourceId));
  const entryUri = syntheticPreviewUri(update.entryUri, mount.logicalSourceId);
  if (!files.some((file) => file.uri === entryUri)) {
    throw new Error("Preview compiler snapshot does not contain its synthetic entry file");
  }
  const mounts = files.map((file): PreviewRendererCompilerMount => {
    if (!file.digest || !/^[0-9a-f]{64}$/.test(file.digest)) {
      throw new Error(`Preview compiler file '${file.uri}' has no canonical content digest`);
    }
    return {
      path: previewUriPath(file.uri),
      contentDigest: file.digest,
      dataBase64: typeof file.text === "string" ? encodeBase64(TEXT_ENCODER.encode(file.text)) : file.dataBase64,
    };
  });
  const entryPath = previewUriPath(entryUri);
  const sourceDigest = await previewCompilerSnapshotDigest(entryPath, mounts);
  return Object.freeze({
    project: {
      ...update,
      sourceUri: `mmt-preview:/${mount.logicalSourceId}`,
      entryUri,
      files,
      full: true,
    },
    compilerEntryUri: update.entryUri,
    entryPath,
    sourceDigest,
    mounts: Object.freeze(mounts),
    fonts,
  });
}

export async function validatePreviewRendererReady(
  response: PreviewRendererReady,
  expected: Pick<PreviewRendererRequest & { action: "render" }, "sessionId" | "snapshotToken" | "sourceDigest">
): Promise<Uint8Array> {
  if (response.protocolVersion !== PREVIEW_RENDERER_PROTOCOL_VERSION
    || response.sessionId !== expected.sessionId
    || response.snapshotToken !== expected.snapshotToken
    || response.sourceDigest !== expected.sourceDigest) {
    throw new Error("Preview renderer response identity mismatch");
  }
  if (!Number.isSafeInteger(response.generation) || response.generation <= 0
    || !Number.isSafeInteger(response.baseGeneration) || response.baseGeneration < 0
    || !Number.isSafeInteger(response.compilerRevision) || response.compilerRevision <= 0
    || !Number.isSafeInteger(response.pageCount) || response.pageCount < 0) {
    throw new Error("Preview renderer response generation metadata is invalid");
  }
  const bytes = decodeBase64(response.dataBase64);
  if (bytes.byteLength !== response.byteLength) {
    throw new Error("Preview renderer response byte length mismatch");
  }
  const prefix = new TextDecoder().decode(bytes.subarray(0, response.frameKind === "new"
    ? PREVIEW_RENDERER_NEW_PREFIX.length
    : PREVIEW_RENDERER_DIFF_V1_PREFIX.length));
  const expectedPrefix = response.frameKind === "new" ? PREVIEW_RENDERER_NEW_PREFIX : PREVIEW_RENDERER_DIFF_V1_PREFIX;
  if (prefix !== expectedPrefix) throw new Error("Preview renderer response frame prefix mismatch");
  if (response.frameKind === "new" && response.baseGeneration !== 0) {
    throw new Error("Full preview renderer frame must have base generation zero");
  }
  if (response.frameKind === "diff-v1" && response.baseGeneration <= 0) {
    throw new Error("Incremental preview renderer frame has no committed base generation");
  }
  if (await sha256Hex(bytes) !== response.artifactDigest) {
    throw new Error("Preview renderer response artifact digest mismatch");
  }
  return bytes;
}

function syntheticPreviewFile(file: TypstVirtualFile, logicalSourceId: string): TypstVirtualFile {
  return { ...file, uri: syntheticPreviewUri(file.uri, logicalSourceId) } as TypstVirtualFile;
}

function syntheticPreviewUri(uri: string, logicalSourceId: string): string {
  const sourcePath = decodedUriPath(uri);
  const path = canonicalCompilerMountPath(`${PREVIEW_MOUNT_ROOT}/${logicalSourceId}${sourcePath}`);
  return `mmt-preview:${encodeURI(path).replaceAll("#", "%23").replaceAll("?", "%3F")}`;
}

function previewUriPath(uri: string): string {
  const parsed = new URL(uri);
  if (parsed.protocol !== "mmt-preview:") throw new Error(`Not a synthetic preview URI: ${uri}`);
  return canonicalCompilerMountPath(decodeURIComponent(parsed.pathname));
}

function decodedUriPath(uri: string): string {
  const parsed = new URL(uri);
  const decoded = decodeURIComponent(parsed.pathname);
  return canonicalCompilerMountPath(decoded);
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Preview renderer response is not valid base64");
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
