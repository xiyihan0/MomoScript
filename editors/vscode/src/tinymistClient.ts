import type { TinymistCapabilityView } from "./tinymistCapabilities";
export { serverRequestResponse } from "./tinymistCapabilities";
import type { ProjectionKey, SourceContentKey, TypstProjectSnapshotKey } from "./runtimeIdentity";
import { GENERATED_TINYMIST_PROVIDER_ARTIFACTS } from "./tinymistProviderQualification.generated";
import type { TinymistProviderArtifactIdentity } from "./typstProviderDescriptors";
import type {
  PreviewProjectMount,
  PreviewRendererRenderOptions,
  PreviewRendererRenderResult,
  PreviewRendererResponse,
  PreviewRendererTransition,
  SynchronizedPreviewProject
} from "./previewRendererProtocol";
import {
  JsonRpcTinymistTransport,
  TinymistWorkerConnection,
  type TinymistWorkerFactory
} from "./tinymistTransport";
import { TinymistHostSession } from "./tinymistHostSession";
import type { TypstPackageService } from "./typstPackageService";
import { DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS } from "./typstProjectState";
export {
  applyRenderProjectUpdate,
  canonicalTypstUri,
  mergeProjectFiles,
  projectionSessionKey,
  RenderProjectDeltaError,
  RenderProjectSnapshotStore,
  ProjectFileCloseRegistry,
  projectFileIsOwned,
  releasePendingProjectFile,
  releasePendingProjectFileAfterGrace,
  rotateProjectFileGenerations,
  type ProjectFileRotation,
  type RenderProjectAcceptance,
} from "./typstProjectState";
export {
  PREVIEW_RENDERER_DIFF_V1_PREFIX,
  PREVIEW_RENDERER_METHOD,
  PREVIEW_RENDERER_NEW_PREFIX,
  PREVIEW_RENDERER_PROTOCOL_VERSION,
  preparePreviewProject,
  validatePreviewRendererReady,
  type PreviewProjectMount,
  type PreviewRendererPoint,
  type PreviewRendererPosition,
  type PreviewRendererReady,
  type PreviewRendererRequest,
  type PreviewRendererRenderOptions,
  type PreviewRendererRenderResult,
  type PreviewRendererResponse,
  type PreviewRendererSourceLocation,
  type PreviewRendererTransition,
  type SynchronizedPreviewProject,
} from "./previewRendererProtocol";


export type TypstVirtualFile =
  | { uri: string; digest?: string; text: string; dataBase64?: never }
  | { uri: string; digest?: string; text?: never; dataBase64: string };

export interface TypstResourceRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export type TypstResourceRequest =
  | {
      kind: "image-dir";
      id: number;
      uri: string;
      packNamespace: string;
      base: string;
      fileName: string;
      range: TypstResourceRange;
    }
  | {
      kind: "workspace-file";
      id: number;
      uri: string;
      fileName: string;
      range: TypstResourceRange;
    }
  | {
      kind: "image-sequence";
      id: number;
      uri: string;
      packNamespace: string;
      path: string;
      frame: number;
      sha256: string;
      size: [number, number];
      frameCount: number;
      container: string;
      codec: string;
      alpha: boolean;
      profile: unknown;
      range: TypstResourceRange;
    };

export interface TypstProjectUpdate {
  sourceUri: string;
  /** LSP version of the authored MMT document. */
  sourceVersion: number;
  /** Monotonic virtual Typst projection version. */
  revision: number;
  entryUri: string;
  files: TypstVirtualFile[];
  full: boolean;
  sourceContent: SourceContentKey;
  projectDigest: TypstProjectSnapshotKey;
  projectionKey: ProjectionKey;
  mappingDigest: string;
}

export interface TypstRenderDiagnosticLabel {
  range: TypstResourceRange;
  message?: string;
}

export interface TypstRenderDiagnostic {
  severity: "info" | "warning" | "error";
  phase: "syntax" | "semantic" | "resolve" | "materialize" | "typst";
  message: string;
  range?: TypstResourceRange;
  labels: TypstRenderDiagnosticLabel[];
}

export interface GetTypstRenderProjectParams {
  readonly uri: string;
  readonly timestamp?: { readonly unixMillis: number; readonly localOffsetMinutes: number };
  readonly traceId?: string;
  readonly baseRevision?: number;
  readonly baseProjectDigest?: TypstProjectSnapshotKey;
  readonly forceFull?: boolean;
}

export interface TypstRenderProjectTimings {
  readonly rustParseMs?: number;
  readonly rustSemanticMs?: number;
  readonly rustResolveMs?: number;
  readonly rustEmitMs?: number;
  readonly rustTypstCheckMs?: number;
  readonly rustIndexDigestMs?: number;
}

export interface TypstRenderProjectUpdate {
  sourceUri: string;
  /** LSP version of the authored MMT document. */
  sourceVersion: number;
  /** Monotonic virtual Typst projection version. */
  revision: number;
  entryUri: string;
  files: TypstVirtualFile[];
  full: boolean;
  baseRevision?: number;
  baseProjectDigest?: TypstProjectSnapshotKey;
  deletedUris?: string[];
  resources: TypstResourceRequest[];
  diagnostics: TypstRenderDiagnostic[];
  projectDigest: TypstProjectSnapshotKey;
  mappingDigest: string;
  sourceContent: SourceContentKey;
  projectionKey: ProjectionKey;
  packRegistryDigest: string;
  resourcePlanDigest: string;
  resourceBytesDigest: string;
  traceId?: string;
  timings?: TypstRenderProjectTimings;
}

export function isTypstTextFile(file: TypstVirtualFile): file is Extract<TypstVirtualFile, { text: string }> {
  return typeof file.text === "string";
}



export interface TinymistHostBackend {
  backendGeneration(): number;
  queuedProjectCount(): number;
  capabilities(): TinymistCapabilityView;
  providerArtifactIdentity?(): TinymistProviderArtifactIdentity | undefined;
  on(method: string, handler: (params: unknown) => void): { dispose(): void };
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  syncProject(update: TypstProjectUpdate): void;
  syncPreviewProject(
    update: TypstProjectUpdate,
    mount: PreviewProjectMount,
    signal?: AbortSignal
  ): Promise<SynchronizedPreviewProject>;
  previewRenderer(
    update: TypstProjectUpdate,
    mount: PreviewProjectMount,
    options: PreviewRendererRenderOptions,
    signal?: AbortSignal
  ): Promise<PreviewRendererRenderResult>;
  transitionPreviewRenderer(
    transition: PreviewRendererTransition,
    signal?: AbortSignal
  ): Promise<PreviewRendererResponse>;
  closePreviewRenderer(sessionId: string, signal?: AbortSignal): Promise<PreviewRendererResponse>;
  semanticTokensLegend?(): { tokenTypes: string[]; tokenModifiers: string[] } | undefined;
  closeProject(sourceUri: string, entryUri: string): boolean;
  projectForEntry(entryUri: string): TypstProjectUpdate | undefined;
  stop(): Promise<void>;
  terminate(): void;
}

export function diagnosticVersionMatchesProjection(
  projectionRevision: number,
  diagnosticVersion: number | null | undefined
): boolean {
  if (diagnosticVersion == null) {
    // Compatibility fallback for servers without versioned diagnostics. Such
    // notifications cannot be distinguished from stale results.
    return true;
  }
  return diagnosticVersion === projectionRevision;
}

export function projectionRevisionIsCurrent(
  backend: { projectForEntry(entryUri: string): { revision: number } | undefined },
  entryUri: string,
  expectedRevision: number
): boolean {
  return backend.projectForEntry(entryUri)?.revision === expectedRevision;
}

export interface TinymistInitializeResult {
  capabilities?: {
    [provider: string]: unknown;
    completionProvider?: unknown;
    hoverProvider?: unknown;
    positionEncoding?: unknown;
    signatureHelpProvider?: unknown;
    semanticTokensProvider?: { legend?: { tokenTypes?: string[]; tokenModifiers?: string[] }; full?: unknown };
  };
  serverInfo?: { name?: string; version?: string };
}

export function tinymistProviderArtifactIdentity(
  digest: string | undefined,
  result: TinymistInitializeResult
): TinymistProviderArtifactIdentity | undefined {
  const version = result.serverInfo?.version;
  const positionEncoding = result.capabilities?.positionEncoding;
  if (!digest || !/^[0-9a-f]{64}$/.test(digest)
    || typeof version !== "string" || typeof positionEncoding !== "string") {
    return undefined;
  }
  return Object.freeze({ backendVersion: version, digest, positionEncoding });
}

export function validateTinymistInitialize(result: unknown): asserts result is TinymistInitializeResult {
  if (!result || typeof result !== "object") {
    throw new Error("Tinymist initialize result is invalid");
  }
  const serverInfo = "serverInfo" in result ? result.serverInfo : undefined;
  const version = serverInfo && typeof serverInfo === "object" && "version" in serverInfo
    ? serverInfo.version
    : undefined;
  const nativeVersion = GENERATED_TINYMIST_PROVIDER_ARTIFACTS.native.backendVersion;
  const webVersion = GENERATED_TINYMIST_PROVIDER_ARTIFACTS.web.backendVersion;
  if (version !== nativeVersion && version !== webVersion) {
    const required = nativeVersion === webVersion ? nativeVersion : `${nativeVersion} or ${webVersion}`;
    throw new Error(`Tinymist ${required} required, received ${typeof version === "string" ? version : "unknown"}`);
  }
  const capabilities = "capabilities" in result ? result.capabilities : undefined;
  if (!capabilities || typeof capabilities !== "object"
    || !("completionProvider" in capabilities) || !capabilities.completionProvider
    || !("hoverProvider" in capabilities) || !capabilities.hoverProvider
    || !("signatureHelpProvider" in capabilities) || !capabilities.signatureHelpProvider) {
    throw new Error("Tinymist completion, hover, and signature help capabilities are required");
  }
}

export function semanticTokensLegendFromCapabilities(
  capabilities: TinymistCapabilityView
): { tokenTypes: string[]; tokenModifiers: string[] } | undefined {
  const descriptor = capabilities.get("textDocument/semanticTokens/full")
    ?? capabilities.get("textDocument/semanticTokens");
  if (!descriptor) return undefined;
  for (let index = descriptor.dynamicRegistrations.length - 1; index >= 0; index -= 1) {
    const legend = semanticTokensLegendFromProviderOptions(
      descriptor.dynamicRegistrations[index].registerOptions
    );
    if (legend) return legend;
  }
  return semanticTokensLegendFromProviderOptions(descriptor.initializeOptions);
}

function semanticTokensLegendFromProviderOptions(
  options: unknown
): { tokenTypes: string[]; tokenModifiers: string[] } | undefined {
  if (!options || typeof options !== "object" || !("legend" in options)) return undefined;
  const legend = options.legend;
  if (!legend || typeof legend !== "object"
    || !("tokenTypes" in legend) || !Array.isArray(legend.tokenTypes)
    || !legend.tokenTypes.every((value) => typeof value === "string")
    || !("tokenModifiers" in legend) || !Array.isArray(legend.tokenModifiers)
    || !legend.tokenModifiers.every((value) => typeof value === "string")) {
    return undefined;
  }
  return {
    tokenTypes: [...legend.tokenTypes],
    tokenModifiers: [...legend.tokenModifiers]
  };
}

declare const MMT_TINYMIST_WEB_SHA256: string;
const BUILT_TINYMIST_WEB_DIGEST = typeof MMT_TINYMIST_WEB_SHA256 === "string"
  && /^[0-9a-f]{64}$/.test(MMT_TINYMIST_WEB_SHA256)
  ? MMT_TINYMIST_WEB_SHA256
  : undefined;

export class TinymistWorkerClient implements TinymistHostBackend {
  private readonly transport: JsonRpcTinymistTransport;
  private readonly session: TinymistHostSession;
  private providerIdentity: TinymistProviderArtifactIdentity | undefined;

  private constructor(
    workerUri: string,
    moduleUri: string,
    wasmUri: string,
    workerFactory: TinymistWorkerFactory,
    closeGraceMs: number,
    packageService?: TypstPackageService,
    private readonly artifactDigest?: string
  ) {
    this.transport = new JsonRpcTinymistTransport(
      () => TinymistWorkerConnection.create({ workerUri, moduleUri, wasmUri, workerFactory })
    );
    this.session = new TinymistHostSession({
      label: "Tinymist Worker",
      transport: this.transport,
      closeGraceMs,
      packageService,
      recoverOnSync: true,
      queueNotificationsWhileRecovering: true,
      boot: () => this.bootWorker()
    });
  }

  static async start(
    workerUri: string,
    moduleUri: string,
    wasmUri: string,
    workerFactory: TinymistWorkerFactory = (uri) => new Worker(uri),
    closeGraceMs = DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS,
    packageService?: TypstPackageService,
    artifactDigest: string | undefined = BUILT_TINYMIST_WEB_DIGEST
  ): Promise<TinymistWorkerClient> {
    const client = new TinymistWorkerClient(workerUri, moduleUri, wasmUri, workerFactory, closeGraceMs, packageService, artifactDigest);
    try {
      await client.session.start();
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  backendGeneration(): number {
    return this.session.backendGeneration();
  }
  queuedProjectCount(): number {
    return this.session.queuedProjectCount();
  }


  capabilities(): TinymistCapabilityView {
    return this.session.capabilities();
  }

  providerArtifactIdentity(): TinymistProviderArtifactIdentity | undefined {
    return this.providerIdentity;
  }

  semanticTokensLegend(): { tokenTypes: string[]; tokenModifiers: string[] } | undefined {
    return semanticTokensLegendFromCapabilities(this.session.capabilities());
  }

  on(method: string, handler: (params: unknown) => void): { dispose(): void } {
    return this.session.on(method, handler);
  }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    return this.session.request<T>(method, params, signal);
  }

  notify(method: string, params: unknown): void {
    this.session.notify(method, params);
  }

  syncProject(update: TypstProjectUpdate): void {
    this.session.syncProject(update);
  }

  syncPreviewProject(
    update: TypstProjectUpdate,
    mount: PreviewProjectMount,
    signal?: AbortSignal
  ): Promise<SynchronizedPreviewProject> {
    return this.session.syncPreviewProject(update, mount, signal);
  }

  previewRenderer(
    update: TypstProjectUpdate,
    mount: PreviewProjectMount,
    options: PreviewRendererRenderOptions,
    signal?: AbortSignal
  ): Promise<PreviewRendererRenderResult> {
    return this.session.previewRenderer(update, mount, options, signal);
  }

  transitionPreviewRenderer(
    transition: PreviewRendererTransition,
    signal?: AbortSignal
  ): Promise<PreviewRendererResponse> {
    return this.session.transitionPreviewRenderer(transition, signal);
  }

  closePreviewRenderer(sessionId: string, signal?: AbortSignal): Promise<PreviewRendererResponse> {
    return this.session.closePreviewRenderer(sessionId, signal);
  }

  projectForEntry(entryUri: string): TypstProjectUpdate | undefined {
    return this.session.projectForEntry(entryUri);
  }

  closeProject(sourceUri: string, entryUri: string): boolean {
    return this.session.closeProject(sourceUri, entryUri);
  }

  restart(): Promise<void> {
    return this.session.restart();
  }

  terminate(): void {
    this.session.terminate();
  }

  stop(): Promise<void> {
    return this.session.stop();
  }

  private async bootWorker() {
    this.providerIdentity = undefined;
    const session = await this.transport.start({
      processId: null,
      rootUri: null,
      capabilities: {
        workspace: { configuration: true },
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {},
          publishDiagnostics: { versionSupport: true, relatedInformation: true },
          semanticTokens: {
            requests: { full: true, range: false },
            tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
            tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
            formats: ["relative"]
          }
        }
      },
      clientInfo: { name: "momoscript-vscode", version: "0.1.0" }
    });
    const initialize = session.initializeResult;
    validateTinymistInitialize(initialize);
    this.providerIdentity = tinymistProviderArtifactIdentity(this.artifactDigest, initialize);
    return session;
  }
}
