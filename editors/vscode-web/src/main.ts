import "@codingame/monaco-vscode-language-pack-zh-hans";
import "@codingame/monaco-vscode-media-preview-default-extension";
import * as vscode from "vscode";
import { IEditorGroupsService, ILayoutService, IStorageService, LogLevel } from "@codingame/monaco-vscode-api";
import { getService, ICodeEditorService, IModelService } from "@codingame/monaco-vscode-api";
import { ConfigurationTarget, IConfigurationService, IEditorService, ITextModelService, IWebviewService, type EditorInput } from "@codingame/monaco-vscode-api/services";
import { SIDE_GROUP } from "@codingame/monaco-vscode-api/vscode/vs/workbench/services/editor/common/editorService";
import { registerAssets } from "@codingame/monaco-vscode-api/assets";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { Orientation, Sizing, SplitView, type IView } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/splitview/splitview";
import { MenuId, MenuRegistry } from "@codingame/monaco-vscode-api/vscode/vs/platform/actions/common/actions";
import { ContextKeyExpr } from "@codingame/monaco-vscode-api/vscode/vs/platform/contextkey/common/contextkey";
import type { ICodeEditor } from "@codingame/monaco-vscode-api/vscode/vs/editor/browser/editorBrowser";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import type { LayoutService } from "@codingame/monaco-vscode-layout-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getNotificationsServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getPreferencesServiceOverride from "@codingame/monaco-vscode-preferences-service-override";
import getOutputServiceOverride from "@codingame/monaco-vscode-output-service-override";
import getLocalizationServiceOverride from "@codingame/monaco-vscode-localization-service-override";
import getTextMateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getStatusBarServiceOverride from "@codingame/monaco-vscode-view-status-bar-service-override";
import getStorageServiceOverride from "@codingame/monaco-vscode-storage-service-override";
import getViewsServiceOverride, { attachPart, IReference, IResolvedTextEditorModel, isPartVisibile, onPartVisibilityChange, Parts, registerCustomView, renderStatusBarPart, setPartVisibility, ViewContainerLocation } from "@codingame/monaco-vscode-views-service-override";
import { registerCustomProvider } from "@codingame/monaco-vscode-files-service-override";
import { useWorkerFactory } from "monaco-languageclient/workerFactory";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import type { BaseLanguageClient } from "vscode-languageclient";
import { MmtIndexedDbFileSystemProvider, MmtWorkbenchFileSystemProvider } from "./filesystem";
import { IndexedDbPackCache } from "./packCache";
import { BoundedStringCache, MATERIALIZED_RESOURCE_CACHE_MAX_BYTES } from "./boundedStringCache";
import { advanceLanguageProjection, RevisionPinnedPreviewClock, waitForSynchronizedLanguageProjection } from "./languageProjection";
import type { LanguageProjectionToken } from "./languageProjection";
import { materializeProjectResources } from "../../vscode/src/resourceMaterializer";
import type { MaterializationPackSource, ResourceMaterializationDependencies } from "../../vscode/src/resourceMaterializer";
import { mmtExtension } from "./mmtExtension";
import { registerLocalHistoryCommands, renderLocalHistoryView } from "./localHistoryUi";
import { normalizeResourceLimits } from "./resourceSettings";
import { normalizeHistoryLimits, UNLIMITED_HISTORY_LIMITS } from "./historySettings";
import { startMmtLanguageClient } from "./mmtLanguageClient";
import { installMmtSemanticMiddleware } from "../../vscode/src/mmtSemanticMiddleware";
import type { MmtLanguageClientHandle } from "./mmtLanguageClient";
import { startTinymistLanguageClient } from "./tinymistLanguageClient";
import type { TinymistHandle } from "./tinymistLanguageClient";
import {
  IndexedDbTypstPackageCache,
  WebTypstPackageFileSystemProvider
} from "./typstPackageCache";
import {
  InMemoryTypstPackageDependencyGraph,
  TypstPackageService,
  type TypstPackageGeneration
} from "../../vscode/src/typstPackageService";
import { synchronizePackSources } from "../../vscode/src/packSync";
import type { PackManifestSource } from "../../vscode/src/packSync";
import { decodeAvifSequence } from "./avifSequence";
import { buildAvatarCatalog, buildGalleryPersonGroups, galleryAvatarUrl, GalleryImageCache, packResourceUrl, projectGalleryPack, type GalleryPack } from "./galleryPack";
import { registerCharacterGalleryCommands, renderCharacterGalleryView } from "./characterGalleryUi";
import { loadGalleryEntityCatalog } from "./galleryEntityCatalog";
import { PREVIEW_RENDERER_METHOD, projectionSessionKey } from "../../vscode/src/tinymistClient";
import {
  createRenderArtifactLocationResolver,
  refineRenderTextLocation,
  evictPreviewPackageGeneration,
  installPreviewPackageGenerations,
  renderArtifactLocationProviderKey,
  previewRendererFontFiles,
  sanitizeSvg,
  TypstPreviewController,
  type ImmutableTypstExportSnapshot,
  type TypstPreviewBinding,
  type PreviewPublicationTiming,
} from "./preview";
import { WorkspaceAssetMirror } from "./workspaceAssetMirror.ts";
import { createCurrentPreviewExportClient } from "./currentPreviewExport.ts";
import {
  PreviewBuildState,
  type PreviewBuildDiagnostic,
  type PreviewBuildIdentity,
  type PreviewRevision
} from "./previewDiagnostics";
import { ownEventListener } from "./runtimeOwner";
import { EditorRuntimeController } from "./runtimeController";
import { createStartupProgress } from "./startupProgress";
import type { PreviewTraceSession } from "./previewPerformance.ts";
import { PwaSafeRestartQuiesceAdapter } from "./pwaSafeRestart";
import { registerPwaUpdateLifecycle, type PwaUpdateLifecycle } from "./pwaUpdate";
import { showMomoScriptMessage } from "./notifications";
import { MMT_BUILD_VERSION } from "./buildInfo";
import {
  COMPOSER_EDITOR_ID,
  ComposerEditorSurfaceRegistry,
  deserializeComposerEditorResource,
  isComposerResource,
  registerComposerEditor,
  type ComposerEditorMount,
  type ComposerEditorMountContext,
} from "./composerEditor.ts";
import {
  PREVIEW_HOST_EDITOR_ID,
  PreviewHostInput,
  PreviewHostSurfaceRegistry,
  registerPreviewHostPane,
} from "./previewHostPane.ts";
import { ComposerRuntime, type ComposerRuntimeDocument } from "./composerRuntime.ts";
import { ComposerTextGeometry, type ComposerTextGeometryBinding } from "./composerTextGeometry.ts";
import type { ComposerTextRecoveryTarget } from "./composerTextSession.ts";
import { importComposerLocalImage } from "./composerImageImport.ts";
import {
  applyComposerTextEdit,
  getComposerNativeHistory,
  parsePreviewComposerTargetResult,
} from "./composerEdit.ts";
import {
  ComposerEditorUi,
  type ComposerSpeakerOption,
  type ComposerEditorDraft,
  type ComposerTextRecoveryConfirmation,
} from "./composerEditorUi.ts";
import {
  PACK_MANIFEST_URL,
  TINYMIST_VERSION,
  TINYMIST_WASM_SHA256,
  TYPST_COMPILER_VERSION,
  TYPST_COMPILER_WASM_SHA256,
} from "./runtimeArtifacts";
import { EditorRuntimeStatus, type RuntimeRecoveryState } from "./runtimeStatus";
import {
  createPreviewArtifact,
  parsePreviewSourceTargets,
  type LocationProviderKey,
  type PreviewArtifact,
  type PreviewSourceTarget,
} from "./previewArtifact.ts";
import {
  base64ToBytes,
  bytesToBase64,
  escapeHtml,
  type PreviewNavigationPoint,
  type ComposerState,
  type PreviewSurfacePresentation,
  type PreviewContextMenuAnchor,
} from "./previewWebviewProtocol.ts";
import {
  BrowserPreviewViewportPersistence,
  fallbackPreviewSourceTarget,
  PreviewInteractionController,
  type PreviewBackendLocation,
  type PreviewEditorSelection,
  type PreviewLocationResolver,
  type PreviewSourceIdentity,
  type ProjectedPreviewSelection,
} from "./previewInteraction.ts";
import { ExactExportUiController, LatestExactArtifactWaiter } from "./exactExportUi.ts";
import type { ExactExportFormat, ExactExportPorts, ExactExportRequest, ExactExportResult, RenderAdvanceCause, RenderAdvanceToken } from "./exactExport.ts";
import {
  RenderProjectSnapshotStore,
  isRenderPreset,
  type RenderPreset,
  type GetTypstRenderProjectParams,
  type TypstProjectUpdate,
  type TypstRenderProjectUpdate,
  type TypstVirtualFile,
} from "../../vscode/src/tinymistClient";
import {
  canonicalBytesDigest,
  logicalSourceId,
  materializationKey,
  projectionKey as buildProjectionKey,
  projectSnapshotKey,
  renderKey,
  runtimeArtifactKey,
  sourceContentKey,
  type SourceContentKey,
  type LogicalProjectFileId,
  type RenderKey,
  type SourceStaleToken,
} from "../../vscode/src/runtimeIdentity";
import { PreviewWebviewHost, type PreviewExactExportRequest } from "./previewWebviewHost.ts";
import {
  createPreviewComposerApplyPort,
  isTextContentChangeEvent,
  PreviewComposerController,
  type PreviewComposerControllerPorts,
} from "./previewComposer.ts";
import {
  createWorkbenchPreviewContextInput,
  createWorkbenchPreviewAvatarPicker,
  createWorkbenchPreviewContextMenu,
  createWorkbenchPreviewMessageEditor,
} from "./previewContextMenu.ts";
import {
  PreviewRendererCompilationError,
  PreviewRendererSessionOwner,
  type PreviewRendererCandidate,
} from "./previewRendererSession.ts";
import {
  mapPreviewRendererDiagnostics,
  type PreviewRendererDiagnosticIdentity,
  type RoutedPreviewRendererDiagnostic,
} from "../../vscode/src/previewRendererDiagnostics.ts";
import {
  createMmtE2ELanguageApi,
  createMmtE2EComposerInstrumentation,
  createMmtE2EWorkspaceApi,
  installMmtE2EBridge,
  type ExactExportFixtureRequest,
  type MmtE2EApi,
  type PreviewInteractionFixtureRequest,
} from "./e2eRuntimeBridge.ts";

const webviewIndexUrl = new URL("../node_modules/@codingame/monaco-vscode-view-common-service-override/service-override/vs/workbench/contrib/webview/browser/pre/index.html", import.meta.url).href;
const webviewFakeUrl = new URL("../node_modules/@codingame/monaco-vscode-view-common-service-override/service-override/vs/workbench/contrib/webview/browser/pre/fake.html", import.meta.url).href;

function deploymentHtmlUrl(url: string): string {
  if (!location.hostname.endsWith(".pages.dev")) return url;
  const parsed = new URL(url);
  parsed.pathname = parsed.pathname.replace(/\.html$/, "");
  return parsed.href;
}

registerAssets({
  "vs/workbench/contrib/webview/browser/pre/index.html": () => deploymentHtmlUrl(webviewIndexUrl),
  "vs/workbench/contrib/webview/browser/pre/fake.html": () => deploymentHtmlUrl(webviewFakeUrl),
});


type E2ELifecycleKind = "runtime-ready" | "dispose-invoked" | "dispose-complete" | "retained-artifacts-cleared" | "unload" | "hmr" | "hmr-fallback";


interface E2EExactExportHost {
  readonly latest: LatestExactArtifactWaiter;
  readonly ports: ExactExportPorts;
}

function beginE2ELifecycle(): number | undefined {
  if (import.meta.env.VITE_MMT_E2E !== "1") return undefined;
  const begin = Reflect.get(globalThis, "__mmtBeginLifecycleGeneration");
  return typeof begin === "function" ? begin() as number : undefined;
}

function recordE2ELifecycle(kind: E2ELifecycleKind, generation: number | undefined): void {
  if (import.meta.env.VITE_MMT_E2E !== "1" || generation === undefined) return;
  const record = Reflect.get(globalThis, "__mmtRecordLifecycle");
  if (typeof record === "function") record(kind, generation);
}



const WORKSPACE = URI.parse("mmtfs://workspace/");
const STORY = URI.parse("mmtfs://workspace/story.mmt");
const INTRO = URI.parse("mmtfs://workspace/intro.typ");
const ACTIVE_WORKSPACE_DOCUMENT_KEY = "momoscript.active-workspace-document.v1";
const ABOUT_COMMAND_ID = "mmt.about";
const CHECK_FOR_UPDATES_COMMAND_ID = "mmt.checkForUpdates";

function rememberActiveWorkspaceDocument(document: vscode.TextDocument): void {
  const uri = document.uri;
  if (uri.scheme !== WORKSPACE.scheme || uri.authority !== WORKSPACE.authority) return;
  if (!/\.(?:mmt(?:\.txt)?|typ)$/i.test(uri.path)) return;
  try {
    localStorage.setItem(ACTIVE_WORKSPACE_DOCUMENT_KEY, uri.path);
  } catch {
    // Browser storage can be unavailable in restricted contexts; the open document still remains usable.
  }
}

async function restoreActiveWorkspaceDocument(): Promise<boolean> {
  let path: string | null;
  try {
    path = localStorage.getItem(ACTIVE_WORKSPACE_DOCUMENT_KEY);
  } catch {
    return false;
  }
  if (!path || !/\.(?:mmt(?:\.txt)?|typ)$/i.test(path)) return false;
  const segments = path.split("/").slice(1);
  if (`/${segments.join("/")}` !== path || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
    localStorage.removeItem(ACTIVE_WORKSPACE_DOCUMENT_KEY);
    return false;
  }
  const uri = vscode.Uri.joinPath(WORKSPACE, ...segments);
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if ((stat.type & vscode.FileType.File) === 0) throw new Error("remembered workspace document is not a file");
    const opened = await vscode.workspace.openTextDocument(uri);
    const expectedLanguage = path.endsWith(".typ") ? "typst" : "mmt";
    const document = opened.languageId === expectedLanguage
      ? opened
      : await vscode.languages.setTextDocumentLanguage(opened, expectedLanguage);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    return true;
  } catch {
    localStorage.removeItem(ACTIVE_WORKSPACE_DOCUMENT_KEY);
    return false;
  }
}

const DEFAULT_STORY = "> 佳代子: 你好，老师！\n> _0: 我也可以继续说。\n< 老师好！\n> 佳代子: 看看这个：[:#1:](width: 2em)\n";
const encoder = new TextEncoder();
const PREVIEW_RUNTIME_KEY = runtimeArtifactKey(
  TYPST_COMPILER_VERSION,
  TYPST_COMPILER_WASM_SHA256,
  TINYMIST_VERSION,
  TINYMIST_WASM_SHA256,
  "mmt-template-bundle-v1",
  "c02a98146312b8756f9f23654b194885358f603eed736f037f172d617330c05c",
);
const OUTPUT_RENDER_PRESET: RenderPreset = Object.freeze({ kind: "output" });
type AuthoringMode = "chat" | "layout" | "source";

function renderPresetKey(preset: RenderPreset): string {
  return preset.kind === "chat" ? `chat:${preset.widthPt}` : "output";
}

function projectRenderPreset(project: TypstProjectUpdate): RenderPreset {
  return (project as Partial<TypstRenderProjectUpdate>).renderPreset ?? OUTPUT_RENDER_PRESET;
}

function workTitle(resource: vscode.Uri): string {
  return resource.path.split("/").at(-1)?.replace(/\.(?:mmt(?:\.txt)?|typ)$/i, "") || "未命名作品";
}

function createE2EExactExportHost(): E2EExactExportHost | undefined {
  if (
    import.meta.env.VITE_MMT_E2E !== "1"
    || new URL(location.href).searchParams.get("mmtExportMode") === "current-preview"
  ) return undefined;
  const latest = new LatestExactArtifactWaiter();
  return {
    latest,
    ports: {
      latest,
      raster: {
        async encode(page, format, signal) {
          signal.throwIfAborted();
          return encoder.encode(`${format}:${page.sanitizedSvg}`);
        },
      },
      pdf: {
        async compile(render, runtime, signal) {
          signal.throwIfAborted();
          return encoder.encode(`pdf:${render.renderKey}:${runtime.runtimeArtifactKey}`);
        },
      },
    },
  };
}
function configuredResourceLimits() {
  const configuration = vscode.workspace.getConfiguration("mmt.resources");
  return normalizeResourceLimits({
    maxFileSizeMb: configuration.get("maxFileSizeMb"),
    maxProjectResources: configuration.get("maxProjectResources"),
    maxProjectSizeMb: configuration.get("maxProjectSizeMb")
  });
}
function configuredHistoryLimits() {
  const configuration = vscode.workspace.getConfiguration("mmt.history");
  return normalizeHistoryLimits({
    maxSnapshots: configuration.get("maxSnapshots"),
    maxSizeMb: configuration.get("maxSizeMb"),
  });
}
const MATERIALIZATION_DEPENDENCIES: ResourceMaterializationDependencies = {
  resourceUrl: (source, resource) => {
    if (resource.kind === "workspace-file") throw new Error("Workspace resources do not have pack URLs");
    const relativePath = resource.kind === "image-dir"
      ? `${resource.base}/${resource.fileName}`
      : resource.path;
    return packResourceUrl(source.baseUrl, relativePath, resource.kind);
  },
  fetch: fetchResource,
  decodeSequence: decodeAvifSequence,
  encodeBase64: bytesToBase64,
  decodeBase64: base64ToBytes
};

function configureWorkbenchWorkerFactory(): void {
  useWorkerFactory({
    workerLoaders: {
      TextEditorWorker: () => new Worker(
        new URL("@codingame/monaco-vscode-editor-api/esm/vs/editor/editor.worker.js", import.meta.url),
        { type: "module" }
      ),
      TextMateWorker: () => new Worker(
        new URL("@codingame/monaco-vscode-textmate-service-override/worker", import.meta.url),
        { type: "module" }
      ),
      OutputLinkDetectionWorker: () => new Worker(
        new URL("@codingame/monaco-vscode-output-service-override/worker", import.meta.url),
        { type: "module" }
      )
    }
  });
}


let provider: MmtIndexedDbFileSystemProvider | undefined;
let packCache: IndexedDbPackCache | undefined;
let mmt: MmtLanguageClientHandle | undefined;
let tinymist: TinymistHandle | undefined;
let galleryPacks: readonly GalleryPack[] = [];
const galleryPacksChanged = new vscode.EventEmitter<void>();
const startupProgress = createStartupProgress(document);

let runtimeController: EditorRuntimeController | undefined;
const hmrDisposal = Reflect.get(globalThis, "__mmtHmrDisposal");
if (import.meta.hot && hmrDisposal instanceof Promise) {
  void hmrDisposal.then(
    () => window.location.reload(),
    () => window.location.reload()
  );
} else {
  void start().catch((error: unknown) => {
    startupProgress.fatal(error);
    document.documentElement.dataset.mmtStage = "failed";
    console.error("MomoScript editor failed to start", error);
    if (import.meta.env.VITE_MMT_E2E === "1") {
      Reflect.set(globalThis, "__mmtStartupError", error instanceof Error ? error.stack ?? error.message : String(error));
    }
    const root = document.querySelector<HTMLElement>("#workbench");
    if (root) root.textContent = error instanceof Error ? error.message : String(error);
  });
}

async function start(): Promise<void> {
  const lifecycleGeneration = beginE2ELifecycle();
  const exactExportHost = createE2EExactExportHost();
  const controller = new EditorRuntimeController({
    captureAcceptedPreviewProjects: import.meta.env.VITE_MMT_E2E === "1",
    exactExport: exactExportHost?.ports,
    previewPerformanceEnabled: import.meta.env.VITE_MMT_E2E === "1",
  });
  runtimeController = controller;
  await controller.start(() => initializeRuntime(controller, lifecycleGeneration, exactExportHost));
  recordE2ELifecycle("runtime-ready", lifecycleGeneration);
}

async function initializeRuntime(
  controller: EditorRuntimeController,
  lifecycleGeneration: number | undefined,
  exactExportHost: E2EExactExportHost | undefined,
): Promise<void> {
  const own = <T extends { dispose(): void | Promise<void> }>(resource: T): T => controller.own(resource);
  const subscribe = <T extends { dispose(): void | Promise<void> }>(subscription: T): T => controller.subscribe(subscription);
  if (exactExportHost) own(exactExportHost.latest);
  const root = document.querySelector<HTMLElement>("#workbench");
  if (!root) throw new Error("Missing #workbench container");
  startupProgress.stage("filesystem", "active", "正在打开浏览器存储");
  const packageCacheStorage = await controller.initializeOriginStorage();
  const packageDependencies = new InMemoryTypstPackageDependencyGraph();
  const typstPackageCache = own(await IndexedDbTypstPackageCache.open(
    packageCacheStorage,
    (generation) => {
      packageDependencies.invalidateGeneration(generation);
      evictPreviewPackageGeneration(generation);
    }
  ));
  const typstPackageService = new TypstPackageService({
    cache: typstPackageCache,
    dependencies: packageDependencies
  });
  let output: vscode.OutputChannel | undefined;
  let pwaUpdateLifecycle: PwaUpdateLifecycle | undefined;
  const log = (scope: string, message: string) => {
    const line = `[${new Date().toISOString()}] [${scope}] ${message}`;
    if (output) output.appendLine(line);
    else console.info(line);
  };
  log("host", "Starting Web Workbench");
  startupProgress.stage("workbench", "active", "正在启动界面 API");
  document.documentElement.dataset.mmtStage = "api-starting";
  const layout = own(createLayout(root));
  const mmsViewRegistration = own(registerCustomView({
    id: "momoscript.project",
    name: "MomoScript",
    location: ViewContainerLocation.Sidebar,
    icon: mmsViewIcon(),
    canMoveView: false,
    renderBody: (container) => renderMmsProjectView(container)
  }));
  const historyViewRegistration = own(registerCustomView({
    id: "momoscript.localHistory",
    name: "本地历史",
    location: ViewContainerLocation.Sidebar,
    icon: historyViewIcon(),
    canMoveView: false,
    renderBody: (container) => provider
      ? renderLocalHistoryView(container, provider)
      : { dispose() {} }
  }));
  const galleryViewRegistration = own(registerCustomView({
    id: "momoscript.characterGallery",
    name: "角色图鉴",
    location: ViewContainerLocation.Sidebar,
    icon: galleryViewIcon(),
    canMoveView: false,
    renderBody: (container) => renderCharacterGalleryView(container, {
      getPacks: () => galleryPacks,
      onDidChangePacks: (listener) => galleryPacksChanged.event(listener)
    })
  }));
  let previewWebviewHost: PreviewWebviewHost | undefined;
  let activeClient: BaseLanguageClient | undefined;
  let displayedPreviewSourceUri: string | undefined;
  let previewFixtureActiveSourceUri: string | undefined;
  let previewComposer: PreviewComposerController | undefined;
  const composerE2E = import.meta.env.VITE_MMT_E2E === "1"
    ? createMmtE2EComposerInstrumentation()
    : undefined;
  const previewBuildState = new PreviewBuildState();
  const {
    previewProjects,
    previewRenderQueue,
    packSourcesByNamespace,
    latestProjectBySource,
    retiredProjectSessions,
    materializationControllers,
    pendingMaterializations,
    latestLanguageProjectionBySource,
    typstRevisions,
    typstProjects,
    acceptedPreviewLanguageProjects,
    retiredLanguageProjectionSessions,
    renderRequestIdBySource,
    persistenceByUri,
  } = controller.stores;
  const previewTraces = new Map<string, PreviewTraceSession>();
  const renderProjectSnapshots = new RenderProjectSnapshotStore();
  own({ dispose: () => renderProjectSnapshots.clear() });
  interface AuthoringDocumentState {
    mode: AuthoringMode;
    canvasMode: "chat" | "layout";
    widthPt: number;
    transition?: Promise<void>;
    saving?: Promise<void>;
    saveError?: string;
    persisting?: boolean;
  }
  const authoringDocuments = new Map<string, AuthoringDocumentState>();
  const authoringState = (sourceUri: string, initialMode: AuthoringMode = "source"): AuthoringDocumentState => {
    let state = authoringDocuments.get(sourceUri);
    if (!state) {
      state = { mode: initialMode, canvasMode: initialMode === "chat" ? "chat" : "layout", widthPt: 480 };
      authoringDocuments.set(sourceUri, state);
    }
    return state;
  };
  const renderPresetFor = (sourceUri: string): RenderPreset => {
    const state = authoringDocuments.get(sourceUri);
    return state?.canvasMode === "chat" ? { kind: "chat", widthPt: state.widthPt } : OUTPUT_RENDER_PRESET;
  };
  const projectPresentationIsCurrent = (project: TypstProjectUpdate): boolean => (
    renderPresetKey(projectRenderPreset(project)) === renderPresetKey(renderPresetFor(project.sourceUri))
  );
  const requestedRenderPresets = new WeakMap<LanguageProjectionToken, Set<string>>();
  const renderOptionsDigests = new Map<string, Promise<string>>();
  const languageSourceContent = new WeakMap<LanguageProjectionToken, SourceContentKey>();
  const renderOptionsDigest = (preset: RenderPreset) => {
    const key = renderPresetKey(preset);
    let digest = renderOptionsDigests.get(key);
    if (!digest) {
      digest = canonicalBytesDigest("mmt-preview-render-options-v2", [
        encoder.encode(`svg:default:chat-presentation-v1:${key}`),
      ]);
      renderOptionsDigests.set(key, digest);
    }
    return digest;
  };
  const previewFeatureMaster = import.meta.env.VITE_MMT_PREVIEW_INCREMENTAL;
  const previewFeaturesEnabled = previewFeatureMaster !== "0";
  const previewCompilerSetting = import.meta.env.VITE_MMT_PREVIEW_COMPILER_REUSE;
  const previewCompilerReuseEnabled = previewFeaturesEnabled
    && (previewCompilerSetting === "1" || (previewCompilerSetting === undefined && previewFeatureMaster === "1"));
  const previewResourceReuseEnabled = import.meta.env.VITE_MMT_PREVIEW_RESOURCE_REUSE !== "0"
    && previewFeaturesEnabled;
  const previewSchedulerEnabled = import.meta.env.VITE_MMT_PREVIEW_SCHEDULER !== "0"
    && previewFeaturesEnabled;
  const previewRendererSetting = import.meta.env.VITE_MMT_PREVIEW_DIFF_V1;
  let previewRendererEnabled = false;
  let previewRendererSessions: PreviewRendererSessionOwner | undefined;
  let displayedRendererCandidate: PreviewRendererCandidate | undefined;
  let activeGuiRuntime: ComposerRuntime | undefined;
  let mountedPreview: { readonly sourceUri: string; readonly presentation: PreviewSurfacePresentation; readonly claimant: object } | undefined;
  let surfacePublicationAbort = new AbortController();
  const acceptsMountedPreview = (sourceUri: string, preset: RenderPreset): boolean => (
    mountedPreview?.sourceUri === sourceUri
    && previewWebviewHost?.isOpen === true
    && renderPresetKey(renderPresetFor(sourceUri)) === renderPresetKey(preset)
    && (mountedPreview.presentation === "chat" ? preset.kind === "chat" : preset.kind === "output")
  );
  let preview!: TypstPreviewController;
  let guiTextDelays = { snapshotMs: 0, compileMs: 0 };
  const waitForTextFixture = (milliseconds: number, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    return promise;
  };
  const exactExportAdvanceBySource = new Map<string, RenderAdvanceToken>();
  const immutablePreviewExports = new Map<RenderKey, {
    readonly sourceUri: string;
    readonly snapshot: ImmutableTypstExportSnapshot;
    pins: number;
  }>();
  const rendererPresetBySource = new Map<string, string>();
  let loadedPreviewFontNames: readonly string[] = [];
  const evictImmutablePreviewExports = (protectedRenderKey?: RenderKey): void => {
    while (immutablePreviewExports.size > 32) {
      let evictable: RenderKey | undefined;
      for (const [renderKey, retained] of immutablePreviewExports) {
        if (renderKey !== protectedRenderKey && retained.pins === 0) {
          evictable = renderKey;
          break;
        }
      }
      if (!evictable) return;
      immutablePreviewExports.delete(evictable);
    }
  };
  own({ dispose: () => immutablePreviewExports.clear() });
  const latestArtifactWaiter = exactExportHost?.latest ?? own(new LatestExactArtifactWaiter());
  const currentPreviewExport = createCurrentPreviewExportClient({
    artifacts: controller.stores.previewArtifacts,
    latest: latestArtifactWaiter,
    preview: () => preview,
    immutable: {
      has: (renderKey) => {
        const retained = immutablePreviewExports.get(renderKey);
        return !!retained && projectRenderPreset(retained.snapshot.project).kind === "output";
      },
      export: async (renderKey, format, pageIndex, signal) => {
        const retained = immutablePreviewExports.get(renderKey);
        if (!retained) throw new Error(`Immutable renderer export input is unavailable for ${renderKey}`);
        if (projectRenderPreset(retained.snapshot.project).kind !== "output") throw new Error("聊天创作快照不能用于成品导出");
        retained.pins += 1;
        try {
          return await preview.createImmutableExport(
            retained.snapshot,
            renderKey,
            format,
            pageIndex,
            controller.stores.previewArtifacts.get(renderKey)?.pages[pageIndex]?.geometry,
            signal,
          );
        } finally {
          retained.pins -= 1;
          evictImmutablePreviewExports();
        }
      },
    },
  });
  const exportMode = controller.stores.exactExport ? "exact" : "current-preview";
  const exactExportUi = own(new ExactExportUiController(controller.stores.exactExport ?? currentPreviewExport, {
    stateChanged(state) {
      previewWebviewHost?.postExactExportState(state);
      if (activeGuiRuntime) {
        for (const surface of previewSurfaceMounts) {
          if (surface.runtime === activeGuiRuntime) surface.ui?.refresh();
        }
      }
    },
    deliver(result) {
      downloadBlob(result.blob, result.metadata.fileName);
      log("export", `Downloaded ${result.metadata.fileName} from ${result.metadata.renderKey}`);
    },
    failed(error) {
      log("export:error", error instanceof Error ? error.message : String(error));
    },
  }, exportMode));
  const advanceExactExport = (sourceUri: string, cause: RenderAdvanceCause): void => {
    const token = controller.stores.exactExport?.advance(sourceUri, cause);
    if (token) exactExportAdvanceBySource.set(sourceUri, token);
    if (displayedPreviewSourceUri === sourceUri) exactExportUi.bind(sourceUri);
  };
  const previewDocumentIncarnations = new WeakMap<vscode.TextDocument, string>();
  const previewIdentityFor = (project: TypstProjectUpdate, document: vscode.TextDocument): PreviewSourceIdentity => {
    let documentIncarnation = previewDocumentIncarnations.get(document);
    if (!documentIncarnation) {
      documentIncarnation = crypto.randomUUID();
      previewDocumentIncarnations.set(document, documentIncarnation);
    }
    const sourceStaleToken: SourceStaleToken = Object.freeze({
      hostUri: document.uri.toString(),
      documentIncarnation,
      documentVersion: document.version,
    });
    return Object.freeze({
      workspaceId: provider?.workspaceStatus().workspaceId ?? (document.uri.authority || "workspace"),
      sourceUri: project.sourceUri,
      sourceContent: project.sourceContent,
      sourceStaleToken,
      projectDigest: project.projectDigest,
      projectionKey: project.projectionKey,
      revision: project.revision,
      entryUri: project.entryUri,
      languageId: document.languageId === "mmt" ? "mmt" : "typst",
      backendEncoding: "utf-16",
    });
  };
  const currentPreviewIdentity = (sourceUri: string): PreviewSourceIdentity | undefined => {
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === sourceUri);
    const project = previewProjects.get(sourceUri) ?? typstProjects.get(sourceUri);
    return document && project ? previewIdentityFor(project, document) : undefined;
  };
  const previewBuildIdentityFor = (
    project: TypstProjectUpdate,
    document: vscode.TextDocument
  ): PreviewBuildIdentity => {
    const identity = previewIdentityFor(project, document);
    return Object.freeze({
      sourceUri: identity.sourceUri,
      sourceVersion: identity.sourceStaleToken.documentVersion,
      revision: identity.revision,
      sourceContent: identity.sourceContent,
      sourceStaleToken: identity.sourceStaleToken,
    });
  };
  const currentPreviewBuildIdentity = (
    revision: PreviewRevision
  ): PreviewBuildIdentity | undefined => {
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === revision.sourceUri
    );
    const project = previewProjects.get(revision.sourceUri) ?? typstProjects.get(revision.sourceUri);
    if (!document || !project
      || document.version !== revision.sourceVersion
      || project.sourceVersion !== revision.sourceVersion
      || project.revision !== revision.revision) return undefined;
    return previewBuildIdentityFor(project, document);
  };
  const rendererDiagnosticIdentityIsCurrent = (
    identity: PreviewRendererDiagnosticIdentity
  ): boolean => {
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === identity.sourceUri
    );
    const project = previewProjects.get(identity.sourceUri) ?? typstProjects.get(identity.sourceUri);
    const buildIdentity = currentPreviewBuildIdentity(identity);
    return document !== undefined
      && project !== undefined
      && buildIdentity !== undefined
      && previewBuildState.isCurrent(buildIdentity)
      && document.version === identity.sourceVersion
      && project.sourceVersion === identity.sourceVersion
      && project.revision === identity.revision
      && project.sourceContent === identity.sourceContent
      && project.projectDigest === identity.projectDigest
      && project.projectionKey === identity.projectionKey
      && project.entryUri === identity.entryUri
      && controller.stores.previewArtifacts.document(identity.sourceUri).requestedRenderKey === identity.snapshotToken
      && tinymist?.backend.backendGeneration() === identity.backendGeneration;
  };
  const publishRendererDiagnostics = async (
    project: TypstProjectUpdate,
    snapshotToken: RenderKey,
    backendGeneration: number,
    synchronized: PreviewRendererCandidate["synchronized"],
    records: PreviewRendererCandidate["ready"]["diagnostics"],
  ): Promise<readonly RoutedPreviewRendererDiagnostic[] | undefined> => {
    const document = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === project.sourceUri
    );
    const client = activeClient;
    if (!document
      || synchronized.compilerEntryUri !== project.entryUri
      || synchronized.project.sourceVersion !== project.sourceVersion
      || synchronized.project.revision !== project.revision
      || synchronized.project.sourceContent !== project.sourceContent
      || synchronized.project.projectDigest !== project.projectDigest
      || synchronized.project.projectionKey !== project.projectionKey) {
      return undefined;
    }
    const identity: PreviewRendererDiagnosticIdentity = Object.freeze({
      sourceUri: project.sourceUri,
      sourceVersion: project.sourceVersion,
      revision: project.revision,
      sourceContent: project.sourceContent,
      projectDigest: project.projectDigest,
      projectionKey: project.projectionKey,
      entryUri: project.entryUri,
      snapshotToken,
      backendGeneration,
      backendEncoding: "utf-16",
    });
    const routed = await mapPreviewRendererDiagnostics(
      client,
      identity,
      document.getText(),
      records,
      rendererDiagnosticIdentityIsCurrent,
    );
    if (!routed) return undefined;
    const buildIdentity = currentPreviewBuildIdentity(identity);
    if (!buildIdentity || !rendererDiagnosticIdentityIsCurrent(identity)) return undefined;
    previewBuildState.replace(
      buildIdentity,
      routed.map(({ uri, diagnostic }): PreviewBuildDiagnostic => Object.freeze({
        ...buildIdentity,
        phase: "layout",
        targetUri: uri,
        range: diagnostic.range,
        message: diagnostic.message,
        severity: diagnostic.severity === 1
          ? "error"
          : diagnostic.severity === 2
            ? "warning"
            : "info",
        ...(diagnostic.code === undefined ? {} : { code: diagnostic.code }),
        ...(diagnostic.codeDescription === undefined
          ? {}
          : { codeDescription: diagnostic.codeDescription }),
        ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
        ...(diagnostic.tags === undefined ? {} : { tags: diagnostic.tags }),
        ...(diagnostic.relatedInformation === undefined
          ? {}
          : { relatedInformation: diagnostic.relatedInformation }),
        ...(diagnostic.data === undefined ? {} : { data: diagnostic.data }),
      })),
    );
    return routed;
  };
  const previewProblemDiagnostic = (
    diagnostic: PreviewBuildDiagnostic
  ): vscode.Diagnostic | undefined => {
    if (!diagnostic.range) return undefined;
    const range = new vscode.Range(
      diagnostic.range.start.line,
      diagnostic.range.start.character,
      diagnostic.range.end.line,
      diagnostic.range.end.character
    );
    const problem = new vscode.Diagnostic(
      range,
      `[${diagnostic.phase}] ${diagnostic.message}`,
      diagnostic.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : diagnostic.severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information
    );
    problem.source = diagnostic.source ?? "MomoScript preview/build";
    problem.code = diagnostic.codeDescription
      ? {
          value: diagnostic.code ?? `preview/${diagnostic.phase}`,
          target: vscode.Uri.parse(diagnostic.codeDescription.href),
        }
      : diagnostic.code ?? `preview/${diagnostic.phase}`;
    if (diagnostic.tags) {
      problem.tags = diagnostic.tags.map((tag) =>
        tag === 1 ? vscode.DiagnosticTag.Unnecessary : vscode.DiagnosticTag.Deprecated
      );
    }
    if (diagnostic.relatedInformation) {
      problem.relatedInformation = diagnostic.relatedInformation.map((related) =>
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(
            vscode.Uri.parse(related.location.uri),
            new vscode.Range(
              related.location.range.start.line,
              related.location.range.start.character,
              related.location.range.end.line,
              related.location.range.end.character,
            ),
          ),
          related.message,
        )
      );
    } else if (diagnostic.dependency) {
      const pack = diagnostic.dependency.packNamespace
        ? ` from pack '${diagnostic.dependency.packNamespace}'`
        : "";
      problem.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(vscode.Uri.parse(diagnostic.sourceUri), range),
          `Resource ${diagnostic.dependency.kind} #${diagnostic.dependency.id}${pack}`
        )
      ];
    }
    return problem;
  };
  const previewPhaseForProjectDiagnostic = (
    phase: TypstRenderProjectUpdate["diagnostics"][number]["phase"]
  ): "package" | "compiler" => phase === "materialize" ? "package" : "compiler";

  const previewBindingFor = async (
    project: TypstProjectUpdate,
    document: vscode.TextDocument,
    packageGenerations: readonly TypstPackageGeneration[],
    requestId?: number,
    traceId?: string,
  ): Promise<TypstPreviewBinding> => {
    const renderProject = project as Partial<TypstRenderProjectUpdate>;
    const resourceBytesDigest = renderProject.resourceBytesDigest ?? project.projectDigest;
    const packageBytesDigest = packageGenerations.length === 0
      ? resourceBytesDigest
      : await canonicalBytesDigest("mmt-preview-resource-package-generations-v1", [
          encoder.encode(resourceBytesDigest),
          ...[...packageGenerations]
            .sort((left, right) => left.packageGeneration.localeCompare(right.packageGeneration))
            .map((generation) => encoder.encode(`${generation.packageGeneration}\0${generation.filesDigest}`))
        ]);
    const materialization = await materializationKey(
      project.projectionKey,
      renderProject.packRegistryDigest ?? project.projectDigest,
      renderProject.resourcePlanDigest ?? project.projectDigest,
      packageBytesDigest,
    );
    const renderPreset = projectRenderPreset(project);
    const key = await renderKey(materialization, await PREVIEW_RUNTIME_KEY, await renderOptionsDigest(renderPreset));
    return Object.freeze({
      ...(requestId === undefined ? {} : { requestId }),
      ...(traceId === undefined ? {} : { traceId }),
      renderKey: key,
      renderPreset,
      locationProviderKey: renderArtifactLocationProviderKey(key, project.revision),
      identity: previewIdentityFor(project, document),
    });
  };
  const mapProjectedPreviewSelection = async (
    selection: PreviewEditorSelection,
    signal: AbortSignal,
  ): Promise<ProjectedPreviewSelection | undefined> => {
    if (!activeClient || signal.aborted) return undefined;
    const mapped = await activeClient.sendRequest<ProjectedPreviewSelection | null>("mmt/typstRange", {
      textDocument: { uri: selection.identity.sourceUri },
      range: selection.range,
      backendEncoding: selection.identity.backendEncoding,
      entryUri: selection.identity.entryUri,
      revision: selection.identity.revision,
      sourceContent: selection.identity.sourceContent,
      projectDigest: selection.identity.projectDigest,
      projectionKey: selection.identity.projectionKey,
    });
    return signal.aborted ? undefined : mapped ?? undefined;
  };
  const mapPreviewSource = async (
    identity: PreviewSourceIdentity,
    location: PreviewBackendLocation,
    signal: AbortSignal,
  ): Promise<PreviewSourceTarget | undefined> => {
    if (!activeClient || signal.aborted || !identity.projectionKey) return undefined;
    const response = await activeClient.sendRequest<unknown>("mmt/mapTypstReadLocations", {
      sourceUri: identity.sourceUri,
      revision: identity.revision,
      entryUri: identity.entryUri,
      backendEncoding: identity.backendEncoding,
      sourceContent: identity.sourceContent,
      projectDigest: identity.projectDigest,
      projectionKey: identity.projectionKey,
      locations: [location],
    });
    if (signal.aborted) return undefined;
    const targets = parsePreviewSourceTargets(response);
    const preferTypst = vscode.workspace.getConfiguration("mmt.preview").get("preferMappedTypst", false);
    const target = preferTypst
      ? targets.find((candidate) => candidate.kind === "workspaceTypst")
        ?? targets.find((candidate) => candidate.kind === "generatedProjection")
        ?? targets[0]
      : targets.find((candidate) => candidate.kind === "authoredIdentity")
        ?? targets.find((candidate) => candidate.kind === "workspaceTypst")
        ?? targets.find((candidate) => candidate.kind === "packageFile")
        ?? targets.find((candidate) => candidate.kind === "staleUnknown");
    if (!target) {
      const fallback = fallbackPreviewSourceTarget(location);
      log(
        fallback ? "preview:navigation:fallback" : "preview:navigation:rejected",
        fallback
          ? `No source mapping for ${identity.sourceUri}; using the backend location`
          : `Renderer location has no editable workspace URI (${location.uri}); refusing to fall back`,
      );
      return fallback;
    }
    switch (target.kind) {
      case "authoredIdentity":
      case "workspaceTypst":
        return Object.freeze({ ...target, readOnly: false, retained: true });
      case "packageFile":
      case "generatedProjection":
        return Object.freeze({ ...target, readOnly: true, retained: true });
      case "staleUnknown": {
        const fallback = fallbackPreviewSourceTarget(location);
        log(
          fallback ? "preview:navigation:fallback" : "preview:navigation:rejected",
          fallback
            ? `Projection mapping is stale for ${identity.sourceUri}; using the backend location`
            : `Stale projection mapping has no editable workspace URI (${location.uri}); refusing to fall back`,
        );
        return fallback;
      }
    }
  };
  const openPreviewSource = async (target: PreviewSourceTarget): Promise<void> => {
    if (!target.uri || !target.range) throw new Error("Preview target has no source location");
    const scheme = vscode.Uri.parse(target.uri).scheme;
    if (!/^(mmtfs|mmt-package|mmt-projection|untitled)$/.test(scheme)) {
      throw new Error(`Refusing to open non-workspace preview target: ${target.uri}`);
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
    const selection = new vscode.Selection(
      target.range.start.line,
      target.range.start.character,
      target.range.end.line,
      target.range.end.character,
    );
    const visible = vscode.window.visibleTextEditors.find((editor) => (
      editor.document.uri.toString() === document.uri.toString()
    ));
    if (visible) {
      visible.selection = selection;
      visible.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      codeEditorService.listCodeEditors()
        .find((candidate) => candidate.getModel()?.uri.toString() === target.uri)
        ?.focus();
      return;
    }
    const editor = await vscode.window.showTextDocument(document, { preview: target.readOnly === true });
    editor.selection = selection;
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };
  let previewInteractionStatus: string | null = null;
  let previewInteractionStatusText = "";
  let previewDefaultFitMode: "width" | "page" = "width";
  const previewInteraction = own(new PreviewInteractionController({
    defaultFitMode: () => previewDefaultFitMode,
    currentIdentity: currentPreviewIdentity,
    mapProjectedSelection: mapProjectedPreviewSelection,
    mapPreviewSource,
    openSource: openPreviewSource,
    persistence: typeof localStorage === "undefined"
      ? undefined
      : new BrowserPreviewViewportPersistence(localStorage),
    events: {
      statusChanged(status, message) {
        previewInteractionStatus = status;
        previewInteractionStatusText = message;
        log(`preview:navigation:${status}`, message);
      },
      indicatorChanged(indicator) {
        void previewWebviewHost?.postIndicator(indicator?.point);
      },
      cursorChanged(cursor) {
        previewWebviewHost?.postCursor(cursor?.point);
      },
      viewportChanged(viewport, presentation) {
        previewWebviewHost?.restoreViewport(viewport, presentation);
      },
      fullRefreshRequested(reason) {
        log("preview:refresh", `Full refresh required: ${reason}`);
      },
    },
  }));
  const displayPreviewArtifact = (
    artifact: PreviewArtifact,
    identity: PreviewSourceIdentity,
    resolver?: PreviewLocationResolver,
    retainCompilerEntry = false,
    rendererCandidate?: PreviewRendererCandidate,
  ): void => {
    previewComposer?.invalidate();
    displayedRendererCandidate = rendererCandidate;
    preview.setDisplayedArtifact(artifact, retainCompilerEntry);
    previewInteraction.bindArtifact(artifact, identity, resolver, previewInteraction.presentation);
    void activeGuiRuntime?.textSession?.refreshGeometry();
  };
  preview = own(new TypstPreviewController({
    status(message, error, revision) {
      const trace = revision?.traceId ? previewTraces.get(revision.traceId) : undefined;
      if (revision && revision.sourceUri === previewFixtureActiveSourceUri) {
        trace?.finish("coalesced");
        if (revision.traceId) previewTraces.delete(revision.traceId);
        return;
      }
      const identity = revision ? currentPreviewBuildIdentity(revision) : undefined;
      if (revision && (!identity || !previewBuildState.isCurrent(identity))) {
        trace?.increment("staleDiscards");
        trace?.finish("stale-discarded");
        if (revision.traceId) previewTraces.delete(revision.traceId);
        return;
      }
      if (error && revision?.traceId) {
        trace?.finish("failed");
        previewTraces.delete(revision.traceId);
      }
      if (error && identity) {
        previewBuildState.fail(identity, "renderer", message);
        const requested = controller.stores.previewArtifacts.document(identity.sourceUri).requestedRenderKey;
        controller.stores.previewArtifacts.fail(identity.sourceUri, requested);
        latestArtifactWaiter.failSource(identity.sourceUri, new Error(message));
        if (displayedPreviewSourceUri === identity.sourceUri) exactExportUi.bind(identity.sourceUri);
      }
      log(message.includes("WASM") ? "wasm" : (error ? "preview:error" : "preview"), message);
      previewWebviewHost?.postStatus(message, error);
    },
    timing(timing, revision) {
      if (revision.traceId !== timing.traceId) return;
      const trace = previewTraces.get(timing.traceId);
      if (!trace) return;
      trace.stage("shadowUpdate", timing.shadowUpdateMs);
      trace.stage("typstCompile", timing.typstCompileMs);
      trace.stage("svgParseSanitize", timing.svgParseSanitizeMs);
      trace.stage("domUpdate", timing.domUpdateMs);
      trace.stage("locationMeasure", timing.locationMeasureMs);
      trace.increment("shadowMapped", timing.shadowMapped);
      trace.increment("shadowUnmapped", timing.shadowUnmapped);
      trace.increment("shadowSkipped", timing.shadowSkipped);
    },
    async rendered(publication, revision, shadowCount): Promise<PreviewPublicationTiming | void> {
      const trace = revision.traceId ? previewTraces.get(revision.traceId) : undefined;
      if (revision.sourceUri === previewFixtureActiveSourceUri) return;
      const identity = currentPreviewBuildIdentity(revision);
      const current = currentPreviewIdentity(revision.sourceUri);
      if (!identity || !previewBuildState.isCurrent(identity)
        || renderPresetKey(publication.artifact.renderPreset) !== renderPresetKey(renderPresetFor(revision.sourceUri))
        || current?.projectionKey !== publication.identity.projectionKey
        || !acceptsMountedPreview(revision.sourceUri, publication.artifact.renderPreset)
        || publication.signal?.aborted
        || current?.projectDigest !== publication.identity.projectDigest) {
        trace?.increment("staleDiscards");
        trace?.finish("stale-discarded");
        if (revision.traceId) previewTraces.delete(revision.traceId);
        return;
      }
      if (!previewWebviewHost) throw new Error("Preview Webview host is unavailable");
      const ready = await previewWebviewHost.publishFullSvg(publication);
      publication.signal?.throwIfAborted();
      if (ready.renderKey !== publication.artifact.renderKey) {
        throw new Error("Preview Webview acknowledged a different render key");
      }
      const resolver = publication.artifact.locationProviderKey.kind === "provider"
        ? createRenderArtifactLocationResolver(
            publication.artifact.locationProviderKey,
            publication.entryUri,
            publication.entryText,
            publication.identity.backendEncoding,
            ready.locations,
          )
        : undefined;
      displayPreviewArtifact(publication.artifact, publication.identity, resolver, true);
      trace?.renderKey(publication.artifact.renderKey);
      previewBuildState.complete(identity);
      log("preview:identity", JSON.stringify({
        event: "rendered",
        requestId: ready.requestSequence,
        revision: identity.revision,
        projectionKey: previewProjects.get(identity.sourceUri)?.projectionKey
          ?? typstProjects.get(identity.sourceUri)?.projectionKey,
        renderKey: publication.artifact.renderKey,
        shadowCount,
      }));
      return { domUpdateMs: ready.domUpdateMs, locationMeasureMs: ready.locationMeasureMs };
    },
  }, {
    reuseCompilerState: previewCompilerReuseEnabled,
  }));
  const renderWithPersistentRenderer = async (
    project: TypstProjectUpdate,
    binding: TypstPreviewBinding,
    trace?: PreviewTraceSession,
  ): Promise<PreviewArtifact | undefined> => {
    const sessions = previewRendererSessions;
    if (!sessions) throw new Error("Preview renderer session owner is unavailable");
    const logicalSource = await canonicalBytesDigest(
      "mmt-preview-renderer-logical-source-v1",
      [encoder.encode(project.sourceUri)],
    );
    const fonts = await previewRendererFontFiles();
    if (loadedPreviewFontNames.length === 0) {
      loadedPreviewFontNames = Object.freeze([
        "MainFont.otf", "MainFont_Bold.otf", "NewCMMath-Regular.otf",
        "DejaVuSansMono.ttf", "JetBrainsMono-Regular.ttf",
      ]);
    }
    let candidate: PreviewRendererCandidate | undefined;
    let committed = false;
    try {
      const rendererStarted = performance.now();
      if (import.meta.env.VITE_MMT_E2E === "1" && guiTextDelays.compileMs > 0) {
        await waitForTextFixture(guiTextDelays.compileMs, binding.signal);
      }
      const presetKey = renderPresetKey(binding.renderPreset);
      if (rendererPresetBySource.get(project.sourceUri) !== presetKey) {
        await sessions.closeSource(project.sourceUri);
        rendererPresetBySource.set(project.sourceUri, presetKey);
      }
      candidate = await sessions.render(
        project,
        { logicalSourceId: logicalSource, fonts },
        binding.renderKey,
        binding.signal,
      );
      if (binding.signal?.aborted || !acceptsMountedPreview(project.sourceUri, binding.renderPreset)) {
        await sessions.discard(candidate);
        candidate = undefined;
        trace?.increment("staleDiscards");
        return undefined;
      }
      if (!previewWebviewHost?.acceptsRendererCandidate(candidate, binding.renderPreset)) {
        trace?.increment("rendererConsumerResyncs");
        await sessions.discard(candidate);
        await sessions.closeSource(project.sourceUri);
        candidate = await sessions.render(
          project,
          { logicalSourceId: logicalSource, fonts },
          binding.renderKey,
          binding.signal,
        );
        if (candidate.ready.frameKind !== "new") {
          throw new Error("Preview renderer consumer resynchronization did not return a full frame");
        }
      }
      trace?.increment("rendererResponseBytes", candidate.ready.byteLength);
      trace?.increment(candidate.ready.frameKind === "new" ? "rendererFrameNew" : "rendererFrameDiffV1");
      trace?.setCounter("rendererGeneration", candidate.ready.generation);
      trace?.setCounter("rendererBaseGeneration", candidate.ready.baseGeneration);
      const revision: PreviewRevision = {
        sourceUri: project.sourceUri,
        sourceVersion: project.sourceVersion,
        revision: project.revision,
        requestId: binding.requestId,
        traceId: binding.traceId,
      };
      const identity = currentPreviewBuildIdentity(revision);
      if (binding.signal?.aborted || !identity || !previewBuildState.isCurrent(identity)
        || !projectPresentationIsCurrent(project)
        || currentPreviewIdentity(project.sourceUri)?.projectionKey !== project.projectionKey
        || (binding.requestId !== undefined && renderRequestIdBySource.get(project.sourceUri) !== binding.requestId)) {
        await sessions.discard(candidate);
        candidate = undefined;
        trace?.increment("staleDiscards");
        return undefined;
      }
      const routedDiagnostics = await publishRendererDiagnostics(
        project,
        binding.renderKey,
        candidate.backendGeneration,
        candidate.synchronized,
        candidate.ready.diagnostics,
      );
      if (!routedDiagnostics || binding.signal?.aborted || !acceptsMountedPreview(project.sourceUri, binding.renderPreset)) {
        await sessions.discard(candidate);
        candidate = undefined;
        trace?.increment("staleDiscards");
        return undefined;
      }
      if (!previewWebviewHost) throw new Error("Preview Webview host is unavailable");
      const ready = await previewWebviewHost.publishRendererFrame(candidate, binding);
      binding.signal?.throwIfAborted();
      trace?.stage("viewportRender", ready.viewportRenderMs ?? 0);
      trace?.stage("iframeTransfer", ready.iframeTransferMs ?? 0);
      trace?.stage("rendererDecode", ready.renderer?.frameDecodeMs ?? 0);
      trace?.stage("rendererApply", ready.renderer?.rendererApplyMs ?? 0);
      trace?.stage("domUpdate", ready.domUpdateMs);
      if (!ready.renderer) throw new Error("Preview Webview omitted renderer metadata");
      trace?.increment("patchedNodes", ready.renderer.patchedNodes);
      trace?.increment("reusedNodes", ready.renderer.reusedNodes);
      trace?.increment("removedNodes", ready.renderer.removedNodes);
      trace?.increment("pageBuffers", ready.renderer.pageBuffers);
      await sessions.commit(candidate);
      committed = true;
      previewWebviewHost?.commitRendererCandidate(candidate, binding.renderPreset);

      const locationProviderKey: LocationProviderKey = Object.freeze({
        kind: "renderer-provider",
        sessionId: candidate.sessionId,
        snapshotToken: binding.renderKey,
        artifactDigest: candidate.ready.artifactDigest,
        backendGeneration: candidate.backendGeneration,
        rendererGeneration: candidate.ready.generation,
        method: PREVIEW_RENDERER_METHOD,
        coordinateVersion: "typst-page-points-v1",
      });
      const artifact = createPreviewArtifact({
        renderKey: binding.renderKey,
        sourceUri: project.sourceUri,
        renderPreset: binding.renderPreset,
        locationProviderKey,
        visualSnapshot: {
          kind: "renderer",
          artifactDigest: candidate.ready.artifactDigest,
          sourceDigest: candidate.ready.sourceDigest,
          backendGeneration: candidate.backendGeneration,
          rendererGeneration: candidate.ready.generation,
          frameKind: candidate.ready.frameKind,
          sessionId: candidate.sessionId,
          snapshotToken: binding.renderKey,
          byteLength: candidate.ready.byteLength,
          pages: ready.renderer.pageGeometries.map((geometry) => ({
            pageIndex: geometry.pageIndex,
            geometry: {
              viewBox: [0, 0, geometry.width, geometry.height] as const,
              cssWidth: geometry.width,
              cssHeight: geometry.height,
            },
          })),
        },
      });
      const resolver: PreviewLocationResolver = {
        key: locationProviderKey,
        locateSelection: async (request, signal) => {
          const { start, end } = request.range;
          const primary = start.line === end.line && end.character > start.character
            ? { line: start.line, character: start.character + Math.floor((end.character - start.character) / 2) }
            : start;
          const locations = await sessions.locateSource(candidate!, request.sourceUri, primary, signal);
          if (locations.length > 0 || signal.aborted) return locations;
          const fallback = primary.line === start.line && primary.character === start.character ? end : start;
          if (fallback.line === primary.line && fallback.character === primary.character) return locations;
          return sessions.locateSource(candidate!, request.sourceUri, fallback, signal);
        },
        locatePoint: async (request, signal) => {
          const location = await sessions.locatePoint(candidate!, {
            pageIndex: request.pageIndex,
            x: request.x,
            y: request.y,
          }, signal);
          const entryText = project.files.find((file) => file.uri === project.entryUri)?.text;
          if (!location || location.uri !== project.entryUri || entryText === undefined) return location;
          return refineRenderTextLocation(entryText, location, binding.identity.backendEncoding, request);
        },
      };
      Object.freeze(resolver);
      displayPreviewArtifact(artifact, binding.identity, resolver, false, candidate);
      trace?.renderKey(artifact.renderKey);
      previewBuildState.complete(identity);
      log("preview:identity", JSON.stringify({
        event: "renderer-committed",
        requestId: binding.requestId,
        revision: identity.revision,
        projectionKey: project.projectionKey,
        renderKey: artifact.renderKey,
        backendGeneration: candidate.backendGeneration,
        rendererGeneration: candidate.ready.generation,
        frameKind: candidate.ready.frameKind,
        rendererMs: performance.now() - rendererStarted,
      }));
      return artifact;
    } catch (error) {
      if (candidate && !committed) {
        await sessions.closeSource(project.sourceUri, candidate);
        previewWebviewHost?.resetRenderer(candidate);
      }
      throw error;
    }
  };
  const renderPreview = async (
    project: TypstProjectUpdate,
    requestId?: number,
    trace?: PreviewTraceSession,
    signal?: AbortSignal,
  ): Promise<void> => {
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === project.sourceUri);
    if (!document || !projectPresentationIsCurrent(project) || !acceptsMountedPreview(project.sourceUri, projectRenderPreset(project))
      || (requestId !== undefined && renderRequestIdBySource.get(project.sourceUri) !== requestId)) {
      trace?.increment("staleDiscards");
      trace?.finish("stale-discarded");
      if (trace) previewTraces.delete(trace.traceId);
      return;
    }
    if (previewFixtureActiveSourceUri === project.sourceUri) {
      trace?.finish("coalesced");
      if (trace) previewTraces.delete(trace.traceId);
      return;
    }
    const operationSignal = signal
      ? AbortSignal.any([signal, surfacePublicationAbort.signal])
      : surfacePublicationAbort.signal;
    operationSignal.throwIfAborted();
    const packageGenerations = await typstPackageService.prepareProject(project.projectDigest, operationSignal);
    installPreviewPackageGenerations(packageGenerations);
    const binding = {
      ...await previewBindingFor(project, document, packageGenerations, requestId, trace?.traceId),
      signal: operationSignal,
    };
    trace?.renderKey(binding.renderKey);
    if (previewFixtureActiveSourceUri === project.sourceUri || !projectPresentationIsCurrent(project)
      || (requestId !== undefined && renderRequestIdBySource.get(project.sourceUri) !== requestId)) {
      trace?.finish("coalesced");
      if (trace) previewTraces.delete(trace.traceId);
      return;
    }
    const before = controller.stores.previewArtifacts.document(project.sourceUri);
    if (before.displayedArtifact && before.displayedArtifact.renderKey !== binding.renderKey) {
      advanceExactExport(project.sourceUri, "render");
    }
    controller.stores.previewArtifacts.request(project.sourceUri, binding.renderKey);
    if (displayedPreviewSourceUri === project.sourceUri) exactExportUi.bind(project.sourceUri);
    try {
      operationSignal.throwIfAborted();
      let artifact: PreviewArtifact | undefined;
      const retainedArtifact = controller.stores.previewArtifacts.get(binding.renderKey);
      if (retainedArtifact
        && retainedArtifact === preview.displayedArtifact
        && retainedArtifact.sourceUri === project.sourceUri
        && !retainedArtifact.stale
        && (!activeGuiRuntime || displayedRendererCandidate?.ready.snapshotToken === retainedArtifact.renderKey)) {
        artifact = retainedArtifact;
        const retainedIdentity = currentPreviewBuildIdentity({
          sourceUri: project.sourceUri,
          sourceVersion: project.sourceVersion,
          revision: project.revision,
          requestId: binding.requestId,
          traceId: binding.traceId,
        });
        if (retainedIdentity) previewBuildState.complete(retainedIdentity);
      } else if (previewRendererEnabled || activeGuiRuntime) {
        if (!previewRendererSessions || tinymist?.backend.capabilities().has(PREVIEW_RENDERER_METHOD) !== true) {
          throw new Error("Qualified incremental preview renderer is unavailable");
        }
        artifact = await renderWithPersistentRenderer(project, binding, trace);
      } else {
        await preview.update(project, binding);
        artifact = preview.displayedArtifact;
      }
      if (previewFixtureActiveSourceUri === project.sourceUri) {
        trace?.finish("coalesced");
        if (trace) previewTraces.delete(trace.traceId);
        return;
      }
      if (!artifact || artifact.renderKey !== binding.renderKey) {
        trace?.increment("staleDiscards");
        trace?.finish("stale-discarded");
        if (trace) previewTraces.delete(trace.traceId);
        return;
      }
      if (artifact.renderPreset.kind === "output" && !immutablePreviewExports.has(binding.renderKey)) {
        immutablePreviewExports.set(binding.renderKey, {
          sourceUri: project.sourceUri,
          snapshot: cloneImmutableTypstExportSnapshot(project, packageGenerations),
          pins: 0,
        });
      }
      evictImmutablePreviewExports(binding.renderKey);
      if (artifact.visualSnapshot.kind === "renderer") {
        controller.stores.previewArtifacts.replaceRendererArtifact(artifact);
      } else {
        controller.stores.previewArtifacts.put(artifact);
      }
      controller.stores.previewArtifacts.display(project.sourceUri, binding.renderKey);
    } catch (error) {
      if (operationSignal.aborted || !acceptsMountedPreview(project.sourceUri, binding.renderPreset)) {
        trace?.finish("aborted");
        if (trace) previewTraces.delete(trace.traceId);
        return;
      }
      let failure: unknown = error;
      let compilationHandled = false;
      if (error instanceof PreviewRendererCompilationError) {
        try {
          const routed = await publishRendererDiagnostics(
            project,
            binding.renderKey,
            error.backendGeneration,
            error.synchronized,
            error.diagnostics,
          );
          if (!routed) {
            trace?.increment("staleDiscards");
            trace?.finish("stale-discarded");
            if (trace) previewTraces.delete(trace.traceId);
            return;
          }
          const failedIdentity = currentPreviewBuildIdentity({
            sourceUri: project.sourceUri,
            sourceVersion: project.sourceVersion,
            revision: project.revision,
            requestId: binding.requestId,
            traceId: binding.traceId,
          });
          if (failedIdentity && !routed.some(({ diagnostic }) => diagnostic.severity === 1)) {
            previewBuildState.fail(failedIdentity, "layout", error.message);
          }
          compilationHandled = true;
        } catch (mappingError) {
          failure = mappingError;
        }
      }
      if (!compilationHandled) {
        const failedIdentity = currentPreviewBuildIdentity({
          sourceUri: project.sourceUri,
          sourceVersion: project.sourceVersion,
          revision: project.revision,
          requestId: binding.requestId,
          traceId: binding.traceId,
        });
        if (failedIdentity) {
          previewBuildState.fail(
            failedIdentity,
            "renderer",
            failure instanceof Error ? failure.message : String(failure),
          );
        }
      }
      trace?.finish("failed");
      if (trace) previewTraces.delete(trace.traceId);
      controller.stores.previewArtifacts.fail(project.sourceUri, binding.renderKey);
      latestArtifactWaiter.failSource(project.sourceUri, failure);
      if (displayedPreviewSourceUri === project.sourceUri) exactExportUi.bind(project.sourceUri);
      throw failure;
    }
    if (binding.renderPreset.kind === "output") {
      const advance = exactExportAdvanceBySource.get(project.sourceUri);
      if (!advance) {
        latestArtifactWaiter.publish(project.sourceUri, binding.renderKey);
      } else if (controller.stores.exactExport?.publishLatest(advance, binding.renderKey)) {
        exactExportAdvanceBySource.delete(project.sourceUri);
        latestArtifactWaiter.publish(project.sourceUri, binding.renderKey);
      }
    }
    if (displayedPreviewSourceUri === project.sourceUri) exactExportUi.bind(project.sourceUri);
    trace?.stage("visualReady", trace.elapsedMs);
    trace?.finish("published");
    if (trace) previewTraces.delete(trace.traceId);
  };
  let fixtureProviderKey: LocationProviderKey | undefined;
  let fixtureSelection: PreviewEditorSelection | undefined;
  const setPreviewRendererEnabled = (enabled: boolean): boolean => {
    if (enabled && !previewRendererSessions) {
      throw new Error("Qualified incremental preview renderer is unavailable");
    }
    if (previewRendererEnabled !== enabled) previewComposer?.invalidate();
    previewRendererEnabled = enabled;
    return previewRendererEnabled;
  };
  const previewInteractionFixture = async (request: PreviewInteractionFixtureRequest) => {
      if (request.action === "state") {
        const displayed = previewInteraction.artifact;
        const visual = displayed?.visualSnapshot;
        return {
          renderKey: preview.displayedRenderKey ?? null,
          viewport: previewInteraction.viewport,
          status: previewInteractionStatus,
          statusText: previewInteractionStatusText,
          indicatorCount: previewInteraction.indicator ? 1 : 0,
          cursorCount: previewInteraction.cursor ? 1 : 0,
          backendGeneration: visual?.kind === "renderer" ? visual.backendGeneration : null,
          rendererSessionId: visual?.kind === "renderer" ? visual.sessionId : null,
          rendererArtifactDigest: visual?.kind === "renderer" ? visual.artifactDigest : null,
          rendererSourceDigest: visual?.kind === "renderer" ? visual.sourceDigest : null,
          rendererByteLength: visual?.kind === "renderer" ? visual.byteLength : null,
          pageGeometries: displayed?.pages.map((page) => page.geometry) ?? [],
          pageCount: displayed?.pages.length ?? 0,
          visualKind: visual?.kind ?? null,
          rendererGeneration: visual?.kind === "renderer" ? visual.rendererGeneration : null,
          rendererFrameKind: visual?.kind === "renderer" ? visual.frameKind : null,
          cursor: previewInteraction.cursor?.point ?? null,
        };
      }
      if (request.action === "reveal") {
        return revealPreviewSurface();
      }
      if (request.action === "overlay") {
        return request.point ? Boolean(await previewWebviewHost?.postIndicator(request.point)) : false;
      }
      if (request.action === "resync-renderer") {
        previewWebviewHost?.clearRendererGeneration();
        return true;
      }
      if (request.action === "restart-provider") {
        const restarted: LocationProviderKey = fixtureProviderKey?.kind === "provider"
          ? { ...fixtureProviderKey, backendGeneration: fixtureProviderKey.backendGeneration + 1 }
          : {
              kind: "provider",
              backendOrTraceArtifactDigest: "fixture:restarted-provider",
              backendGeneration: 999,
              method: "mmt/previewLocation.fixture.v2",
              coordinateVersion: "typst-page-points-v2",
            };
        previewComposer?.invalidate();
        previewInteraction.providerRestarted(restarted);
        return true;
      }
      if (request.action === "active-editor-selection") {
        const editor = vscode.window.activeTextEditor;
        const selection = editor?.selection;
        return !editor || !selection ? null : {
          uri: editor.document.uri.toString(),
          range: {
            start: { line: selection.start.line, character: selection.start.character },
            end: { line: selection.end.line, character: selection.end.character },
          },
        };
      }
      if (request.action === "editor-selection") {
        const editor = vscode.window.activeTextEditor?.document.uri.toString() === displayedPreviewSourceUri
          ? vscode.window.activeTextEditor
          : vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.toString() === displayedPreviewSourceUri);
        const selection = editor?.selection;
        return !editor || !selection ? null : {
          uri: editor.document.uri.toString(),
          range: {
            start: { line: selection.start.line, character: selection.start.character },
            end: { line: selection.end.line, character: selection.end.character },
          },
        };
      }
      if (request.action === "position-live") {
        const editor = vscode.window.activeTextEditor;
        const sourceUri = displayedPreviewSourceUri ?? editor?.document.uri.toString();
        if (!sourceUri) return false;
        const identity = currentPreviewIdentity(sourceUri);
        if (!identity) return false;
        const selection = request.range ?? (
          editor?.document.uri.toString() === sourceUri
            ? {
                start: { line: editor.selection.start.line, character: editor.selection.start.character },
                end: { line: editor.selection.end.line, character: editor.selection.end.character },
              }
            : undefined
        );
        if (!selection) return false;
        return Boolean(await previewInteraction.navigateEditorSelection({ identity, range: selection }));
      }

      if (request.action === "position") {
        if (!fixtureSelection) return false;
        previewInteraction.scheduleEditorSelection(fixtureSelection);
        return true;
      }
      if (request.action === "navigate") {
        return request.point ? Boolean(await previewInteraction.navigatePreviewPoint(request.point)) : false;
      }
      if (request.action === "advance-source") {
        const current = fixtureSelection?.identity;
        if (!current) return false;
        previewInteraction.sourceIdentityAdvanced({
          ...current,
          sourceStaleToken: {
            ...current.sourceStaleToken,
            documentVersion: current.sourceStaleToken.documentVersion + 1,
          },
        });
        return true;
      }

      const document = vscode.window.activeTextEditor?.document
        ?? (displayedPreviewSourceUri
          ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === displayedPreviewSourceUri)
          : undefined);
      if (!document) throw new Error("No active editor for preview interaction fixture");
      const sourceUri = document.uri.toString();
      await vscode.commands.executeCommand("mmt.preview.open", document.uri);
      previewFixtureActiveSourceUri = sourceUri;
      materializationControllers.get(sourceUri)?.abort();
      preview.invalidate();
      let project = previewProjects.get(sourceUri) ?? typstProjects.get(sourceUri);
      if (!project && document.languageId === "typst") {
        project = await buildTypstProject(document, typstRevisions);
        typstProjects.set(sourceUri, project);
      }
      if (!project) throw new Error("No retained project for preview interaction fixture");
      const identity = previewIdentityFor(project, document);
      const selectedRange = request.range ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      };
      fixtureSelection = { identity, range: selectedRange };
      const fixtureMaterialization = await materializationKey(
        project.projectionKey,
        "preview-interaction-fixture-pack",
        "preview-interaction-fixture-plan",
        "preview-interaction-fixture-bytes",
      );
      const fixtureOptions = await canonicalBytesDigest(
        "mmt-preview-interaction-fixture-v1",
        [encoder.encode(request.action), encoder.encode(project.sourceContent)],
      );
      const fixtureRenderKey = await renderKey(fixtureMaterialization, await PREVIEW_RUNTIME_KEY, fixtureOptions);
      const pages = [0, 1].map((pageIndex) => ({
        pageIndex,
        geometry: { viewBox: [0, 0, 320, 480] as const, cssWidth: 320, cssHeight: 480 },
        sanitizedSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 480"><rect width="320" height="480" fill="white"/><circle cx="${pageIndex === 0 ? 64 : 288}" cy="${pageIndex === 0 ? 72 : 456}" r="18" fill="#007acc"/><text x="24" y="36" fill="black">Interaction page ${pageIndex + 1}</text></svg>`,
      }));
      if (request.action === "install-provider") {
        fixtureProviderKey = {
          kind: "provider",
          backendOrTraceArtifactDigest: "fixture:preview-location",
          backendGeneration: 77,
          method: "mmt/previewLocation.fixture.v1",
          coordinateVersion: "typst-page-points-v1",
        };
        const artifact = createPreviewArtifact({
          renderKey: fixtureRenderKey,
          sourceUri,
          renderPreset: projectRenderPreset(project),
          locationProviderKey: fixtureProviderKey,
          visualSnapshot: { kind: "svg", pages, imageAssets: [] },
        });
        displayPreviewArtifact(artifact, identity, {
          key: fixtureProviderKey,
          async locateSelection() { return [{ pageIndex: 0, x: 0.2, y: 0.15 }, { pageIndex: 1, x: 0.9, y: 0.95 }]; },
          async locatePoint() { return { uri: identity.entryUri, range: selectedRange }; },
        });
        if (!await revealPreviewSurface() || !previewWebviewHost) throw new Error("Preview fixture surface is unavailable");
        await previewWebviewHost.publishFixtureArtifact(artifact);
      } else {
        fixtureProviderKey = undefined;
        const mapDigest = await canonicalBytesDigest("mmt-preview-interaction-map-v1", [encoder.encode(fixtureRenderKey)]);
        const target: PreviewSourceTarget = identity.languageId === "mmt"
          ? { kind: "authoredIdentity", uri: sourceUri, range: selectedRange, readOnly: false, retained: true }
          : { kind: "workspaceTypst", uri: sourceUri, range: selectedRange, readOnly: false, retained: true };
        const artifact = createPreviewArtifact({
          renderKey: fixtureRenderKey,
          sourceUri,
          renderPreset: projectRenderPreset(project),
          locationProviderKey: { kind: "immutable-map", digest: mapDigest, coordinateVersion: "typst-page-points-v1" },
          locationMap: {
            digest: mapDigest,
            sourceToPreview: [{
              sourceUri,
              sourceContent: identity.sourceContent,
              projectionKey: identity.projectionKey,
              range: selectedRange,
              candidates: [{ pageIndex: 0, x: 0.2, y: 0.15 }, { pageIndex: 1, x: 0.9, y: 0.95 }],
            }],
            previewToSource: [
              { pageIndex: 0, x: 0.2, y: 0.15, radius: 0.08, target },
              { pageIndex: 1, x: 0.9, y: 0.95, radius: 0.08, target },
            ],
          },
          visualSnapshot: { kind: "svg", pages, imageAssets: [] },
        });
        displayPreviewArtifact(artifact, identity);
        if (!await revealPreviewSurface() || !previewWebviewHost) throw new Error("Preview fixture surface is unavailable");
        await previewWebviewHost.publishFixtureArtifact(artifact);
      }
      return true;
  };
  let exactExportFixtureNext: PreviewArtifact | undefined;
  let exactExportFixtureAdvance: RenderAdvanceToken | undefined;
  const exactExportFixture = async (request: ExactExportFixtureRequest) => {
      if (request.action === "state") return exactExportUi.state;
      if (request.action === "has-artifact") {
        if (!request.renderKey) throw new Error("Exact export artifact lookup requires renderKey");
        return controller.stores.previewArtifacts.get(request.renderKey as RenderKey) !== undefined;
      }
      if (!controller.stores.exactExport || !exactExportHost) throw new Error("Exact export fixture runtime is unavailable");
      const document = vscode.window.activeTextEditor?.document
        ?? (displayedPreviewSourceUri
          ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === displayedPreviewSourceUri)
          : undefined);
      if (!document) throw new Error("No active preview document for exact export fixture");
      const sourceUri = document.uri.toString();
      if (request.action === "install") {
        await vscode.commands.executeCommand("mmt.preview.open", document.uri);
      }
      let project = previewProjects.get(sourceUri) ?? typstProjects.get(sourceUri);
      if (!project && document.languageId === "typst") {
        project = await buildTypstProject(document, typstRevisions);
        typstProjects.set(sourceUri, project);
      }
      if (!project) throw new Error("No retained project for exact export fixture");
      const identity = previewIdentityFor(project, document);
      const marker = request.marker ?? request.action;
      const fixtureMaterialization = await materializationKey(
        project.projectionKey,
        `exact-export-${marker}-pack`,
        `exact-export-${marker}-plan`,
        `exact-export-${marker}-bytes`,
      );
      const fixtureOptions = await canonicalBytesDigest(
        "mmt-exact-export-ui-fixture-v1",
        [encoder.encode(marker), encoder.encode(project.sourceContent)],
      );
      const fixtureRenderKey = await renderKey(fixtureMaterialization, await PREVIEW_RUNTIME_KEY, fixtureOptions);
      const mapDigest = await canonicalBytesDigest("mmt-exact-export-ui-map-v1", [encoder.encode(fixtureRenderKey)]);
      const artifact = createPreviewArtifact({
        renderKey: fixtureRenderKey,
        sourceUri,
        locationProviderKey: { kind: "immutable-map", digest: mapDigest, coordinateVersion: "typst-page-points-v1" },
        locationMap: { digest: mapDigest, sourceToPreview: [], previewToSource: [] },
        visualSnapshot: {
          kind: "svg",
          imageAssets: [],
          pages: [{
            pageIndex: 0,
            geometry: { viewBox: [0, 0, 320, 480], cssWidth: 320, cssHeight: 480 },
            sanitizedSvg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 480"><rect width="320" height="480" fill="white"/><text x="24" y="48" fill="black">Exact export ${escapeHtml(marker)}</text></svg>`,
          }],
        },
      });
      const renderFixturePanel = async (displayed: PreviewArtifact): Promise<void> => {
        displayPreviewArtifact(displayed, identity);
        if (!await revealPreviewSurface() || !previewWebviewHost) throw new Error("Preview fixture surface is unavailable");
        await previewWebviewHost.publishFixtureArtifact(displayed);
      };
      if (request.action === "install") {
        previewFixtureActiveSourceUri = sourceUri;
        materializationControllers.get(sourceUri)?.abort();
        preview.invalidate();
        if (controller.stores.exactExport) {
          const runtimeKey = await PREVIEW_RUNTIME_KEY;
          const entryBytes = encoder.encode(project.sourceContent);
          controller.stores.exactExport.retainInputs({
            renderKey: artifact.renderKey,
            materializationKey: fixtureMaterialization,
            runtimeArtifactKey: runtimeKey,
            renderOptionsDigest: fixtureOptions,
            entryPath: "/main.typ",
            files: [{
              path: "/main.typ",
              kind: "source",
              contentDigest: await canonicalBytesDigest("mmt-exact-export-ui-source-v1", [entryBytes]),
              bytes: entryBytes,
            }],
            packageRoots: [],
          }, {
            runtimeArtifactKey: runtimeKey,
            compilerVersion: TYPST_COMPILER_VERSION,
            compilerWasmDigest: TYPST_COMPILER_WASM_SHA256,
            compilerWasmBytes: new Uint8Array([0]),
            rendererVersion: TINYMIST_VERSION,
            rendererWasmDigest: TINYMIST_WASM_SHA256,
            templateBundleDigest: "mmt-template-bundle-v1",
            fontSetDigest: "mmt-exact-export-ui-fonts-v1",
            fonts: [],
          });
        }
        controller.stores.previewArtifacts.put(artifact);
        controller.stores.previewArtifacts.display(sourceUri, artifact.renderKey);
        exactExportHost.latest.publish(sourceUri, artifact.renderKey);
        exactExportUi.bind(sourceUri);
        await renderFixturePanel(artifact);
        return exactExportUi.state;
      }
      if (request.action === "advance") {
        controller.stores.previewArtifacts.put(artifact);
        exactExportFixtureNext = artifact;
        exactExportFixtureAdvance = controller.stores.exactExport.advance(sourceUri, "source");
        exactExportAdvanceBySource.set(sourceUri, exactExportFixtureAdvance);
        controller.stores.previewArtifacts.request(sourceUri, artifact.renderKey);
        exactExportUi.bind(sourceUri);
        return exactExportUi.state;
      }
      if (request.action === "publish-latest") {
        const latest = exactExportFixtureNext;
        const advance = exactExportFixtureAdvance;
        if (!latest || !advance) throw new Error("No pending exact export fixture artifact");
        controller.stores.previewArtifacts.display(sourceUri, latest.renderKey);
        if (!controller.stores.exactExport.publishLatest(advance, latest.renderKey)) {
          throw new Error("Exact export fixture latest publication was rejected");
        }
        exactExportAdvanceBySource.delete(sourceUri);
        exactExportFixtureAdvance = undefined;
        await renderFixturePanel(latest);
        exactExportHost.latest.publish(sourceUri, latest.renderKey);
        return latest.renderKey;
      }
      controller.stores.previewArtifacts.closeSource(sourceUri);
      if (request.action === "partial") {
        controller.stores.previewArtifacts.request(sourceUri, artifact.renderKey);
      } else if (request.action === "failed") {
        controller.stores.previewArtifacts.request(sourceUri, artifact.renderKey);
        controller.stores.previewArtifacts.fail(sourceUri, artifact.renderKey);
      }
      exactExportUi.bind(sourceUri);
      return exactExportUi.state;
  };
  let workspaceAssetMirror!: WorkspaceAssetMirror;
  const materializedResourceCache = new BoundedStringCache(MATERIALIZED_RESOURCE_CACHE_MAX_BYTES);
  const previewClock = new RevisionPinnedPreviewClock();
  const latestProjectionRevision = () => {
    const sourceUri = vscode.window.activeTextEditor?.document.uri.toString();
    return sourceUri ? latestLanguageProjectionBySource.get(sourceUri)?.revision : undefined;
  };
  const languageProjectionEntry = (name: string) => {
    const uri = vscode.Uri.joinPath(WORKSPACE, name).toString();
    const project = acceptedPreviewLanguageProjects!.get(uri);
    if (!project) return null;
    const entry = project.files.find((file) => file.uri === project.entryUri);
    return { sourceVersion: project.sourceVersion, text: entry?.text };
  };
  const closePreviewProject = (sourceUri: string) => {
    controller.stores.closeSource(sourceUri);
    void previewRendererSessions?.closeSource(sourceUri);
    renderProjectSnapshots.close(sourceUri);
    rendererPresetBySource.delete(sourceUri);
    const composerOwner = composerOwners.get(sourceUri);
    composerOwner?.textStateSubscription.dispose();
    composerOwner?.runtime.dispose();
    composerOwners.delete(sourceUri);
    composerMounting.delete(sourceUri);
    for (const [renderKey, retained] of immutablePreviewExports) {
      if (retained.sourceUri === sourceUri) immutablePreviewExports.delete(renderKey);
    }
    exactExportAdvanceBySource.delete(sourceUri);
    latestArtifactWaiter.closeSource(sourceUri);
    previewBuildState.clear(sourceUri);
    if (displayedPreviewSourceUri === sourceUri) {
      surfacePublicationAbort.abort();
      mountedPreview = undefined;
      activeGuiRuntime?.textSession?.setActive(false);
      displayedRendererCandidate = undefined;
      if (activePreviewSurface) previewWebviewHost?.releaseSurface(activePreviewSurface.claimant);
      activePreviewSurface = undefined;
      activeGuiRuntime = undefined;
      previewComposer?.invalidate();
      exactExportUi.bind(undefined);
      displayedPreviewSourceUri = undefined;
      refreshBuildStatus();
      for (const trace of previewTraces.values()) trace.finish("aborted");
      previewTraces.clear();
      void preview.close();
    }
  };
  try {
    provider = own(await MmtIndexedDbFileSystemProvider.open(UNLIMITED_HISTORY_LIMITS));
  } catch (error) {
    throw new Error("Browser storage is unavailable; MomoScript editor cannot persist files.", {
      cause: error
    });
  }
  const workbenchProvider = own(new MmtWorkbenchFileSystemProvider(provider));
  registerCustomProvider("mmtfs", workbenchProvider);
  const api = new MonacoVscodeApiWrapper({
    $type: "extended",
    logLevel: LogLevel.Debug,
    serviceOverrides: {
      ...getKeybindingsServiceOverride(),
      ...getExplorerServiceOverride(),
      ...getLocalizationServiceOverride({
        async setLocale() {},
        async clearLocale() {},
        availableLanguages: [{ locale: "zh-cn", languageName: "中文（简体）" }]
      }),
      ...getMarkersServiceOverride(),
      ...getNotificationsServiceOverride(),
      ...getPreferencesServiceOverride(),
      ...getOutputServiceOverride(),
        ...getTextMateServiceOverride(),
        ...getThemeServiceOverride(),
      ...getStatusBarServiceOverride(),
      ...getStorageServiceOverride(),
      ...getViewsServiceOverride(),
    },
    viewsConfig: {
      $type: "ViewsService",
      htmlContainer: root,
      async viewsInitFunc() {
        own(attachPart(Parts.ACTIVITYBAR_PART, layout.activity));
        own(attachPart(Parts.SIDEBAR_PART, layout.sidebar));
        own(attachPart(Parts.EDITOR_PART, layout.editor));
        own(attachPart(Parts.PANEL_PART, layout.panel));
        const nativeLayoutService = await getService(ILayoutService) as LayoutService;
        const editorPart = nativeLayoutService.getPart(Parts.EDITOR_PART)!;
        // attachPart defers its first layout to ResizeObserver. Give native
        // panes the SplitView's current allocation before any surface can bind.
        layout.setEditorPartLayout(() => editorPart.layout(
          Math.max(editorPart.minimumWidth, Math.min(editorPart.maximumWidth, layout.editor.offsetWidth)),
          Math.max(editorPart.minimumHeight, Math.min(editorPart.maximumHeight, layout.editor.offsetHeight)),
          layout.editor.offsetTop,
          layout.editor.offsetLeft,
        ));
      }
    },
    workspaceConfig: {
      workspaceProvider: {
        trusted: true,
        workspace: { folderUri: WORKSPACE },
        async open() {
          return false;
        }
      }
    },
    userConfiguration: {
      json: JSON.stringify({
        "workbench.colorTheme": "MomoScript Dark",
        "files.autoSave": "afterDelay",
        "files.eol": "\n",
        "editor.wordWrap": "on",
        "editor.wordBasedSuggestions": "off",
        "[mmt]": { "editor.defaultColorDecorators": "never" }
      })
    },
    extensions: [mmtExtension()],
    monacoWorkerFactory: configureWorkbenchWorkerFactory
  });
  const composerEditorSurfaces = own(new ComposerEditorSurfaceRegistry());
  own(registerComposerEditor(composerEditorSurfaces));
  const previewHostSurfaces = own(new PreviewHostSurfaceRegistry());
  own(registerPreviewHostPane(previewHostSurfaces));
  await api.start();
  const nativeEditorService = await getService(IEditorService);
  const nativeEditorGroupsService = await getService(IEditorGroupsService);
  const nativeStorageService = await getService(IStorageService);
  const nativeWebviewService = await getService(IWebviewService);
  const modelService = await getService(IModelService);
  const modelResolverService = await getService(ITextModelService);
  const codeEditorService = await getService(ICodeEditorService);
  startupProgress.stage("workbench", "complete", "界面 API 已就绪");
  const readPreviewDefaultFitMode = (): "width" | "page" => (
    vscode.workspace.getConfiguration("mmt.preview").get<"width" | "page">("defaultFitMode", "width")
  );
  previewDefaultFitMode = readPreviewDefaultFitMode();
  if (provider.workspaceStatus().lease === "writer") {
    await provider.setHistoryLimits(configuredHistoryLimits());
  }
  const configuredPreviewDiff = vscode.workspace.getConfiguration("mmt.preview").get<boolean>("diffV1", true);
  previewRendererEnabled = previewFeaturesEnabled
    && (previewRendererSetting === "1"
      || (previewRendererSetting === undefined && configuredPreviewDiff));
  workspaceAssetMirror = own(new WorkspaceAssetMirror(previewResourceReuseEnabled));
  previewRenderQueue.setDebounceMs(
    vscode.workspace.getConfiguration("mmt.preview").get<number>("debounceMs", 50),
  );
  const previewPerformanceEnabled = () => import.meta.env.VITE_MMT_E2E === "1"
    || vscode.workspace.getConfiguration("mmt.preview.performance").get<boolean>("enabled", false);
  controller.stores.previewPerformance.setEnabled(previewPerformanceEnabled());
  subscribe(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("mmt.preview.defaultFitMode")) {
      previewDefaultFitMode = readPreviewDefaultFitMode();
    }
  }));
  subscribe(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("mmt.preview.performance.enabled")) {
      controller.stores.previewPerformance.setEnabled(previewPerformanceEnabled());
    }
  }));
  subscribe(vscode.workspace.registerFileSystemProvider(
    "mmt-package",
    new WebTypstPackageFileSystemProvider(typstPackageCache),
    { isReadonly: true, isCaseSensitive: true },
  ));
  subscribe(registerLocalHistoryCommands(provider));
  subscribe(registerCharacterGalleryCommands(() => galleryPacks));
  output = own(vscode.window.createOutputChannel("MomoScript"));
  log("host", `MomoScript build ${MMT_BUILD_VERSION}`);
  log("host", "VS Code Workbench ready");
  subscribe(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("mmt.history")) return;
    void provider!.setHistoryLimits(configuredHistoryLimits()).catch((error: unknown) => {
      log("history:error", error instanceof Error ? error.message : String(error));
    });
  }));
  subscribe(vscode.commands.registerCommand(ABOUT_COMMAND_ID, async () => {
    await showMomoScriptMessage(
      "info",
      `MomoScript Web · 构建版本 ${MMT_BUILD_VERSION} · Tinymist ${TINYMIST_VERSION} (${TINYMIST_WASM_SHA256.slice(0, 12)})`,
      [],
      { id: "about" },
    );
  }));
  subscribe(vscode.commands.registerCommand(CHECK_FOR_UPDATES_COMMAND_ID, async () => {
    if (!pwaUpdateLifecycle) {
      await showMomoScriptMessage("warning", "当前环境未启用应用更新检查。", [], { id: "pwa-update-unavailable" });
      return;
    }
    const result = await pwaUpdateLifecycle.checkForUpdate();
    if (result === "upToDate") {
      await showMomoScriptMessage("info", "MomoScript 当前已是最新版本。", [], { id: "pwa-update-current" });
    } else if (result === "unavailable") {
      await showMomoScriptMessage("warning", "当前环境未启用应用更新检查。", [], { id: "pwa-update-unavailable" });
    } else if (result === "failed") {
      await showMomoScriptMessage(
        "warning",
        "暂时无法检查 MomoScript 更新，请稍后重试。当前应用与离线编辑不受影响。",
        [],
        { id: "pwa-update-check-failed" },
      );
    }
  }));
  own(MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
    group: "1_update",
    order: 1,
    command: {
      id: CHECK_FOR_UPDATES_COMMAND_ID,
      title: "检查更新",
    },
  }));
  own(MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
    group: "z_about",
    order: 1,
    command: {
      id: ABOUT_COMMAND_ID,
      title: "关于 MomoScript",
    },
  }));
  const applyPanelVisibility = (visible: boolean) => {
    layout.setPanelVisible(visible);
    root.classList.toggle("panel-collapsed", !visible);
  };
  setPartVisibility(Parts.PANEL_PART, false);
  applyPanelVisibility(false);
  const panelVisibilityRegistration = own(onPartVisibilityChange(Parts.PANEL_PART, applyPanelVisibility));
  const statusBarRegistration = own(renderStatusBarPart(layout.status));
  const outputStatus = own(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99));
  outputStatus.name = "MomoScript 日志";
  outputStatus.text = "$(output) MomoScript";
  outputStatus.tooltip = "显示或隐藏 MomoScript 日志";
  outputStatus.command = "workbench.action.output.toggleOutput";
  outputStatus.show();
  const runtimeStatus = new EditorRuntimeStatus({
    backendVersion: TINYMIST_VERSION,
    artifactDigest: TINYMIST_WASM_SHA256,
    positionEncoding: "utf-16",
  });
  const buildStatus = own(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98));
  buildStatus.name = "MomoScript 构建状态";
  buildStatus.command = "workbench.actions.view.problems";
  const refreshBuildStatus = () => {
    const sourceUri = displayedPreviewSourceUri
      ?? vscode.window.activeTextEditor?.document.uri.toString();
    const document = sourceUri
      ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === sourceUri)
      : undefined;
    const snapshot = sourceUri ? previewBuildState.snapshot(sourceUri) : undefined;
    const stale = Boolean(
      document
      && snapshot?.identity
      && (
        snapshot.identity.sourceVersion !== document.version
        || snapshot.identity.sourceStaleToken.hostUri !== sourceUri
        || snapshot.identity.sourceStaleToken.documentIncarnation
          !== previewDocumentIncarnations.get(document)
      )
    );
    const previewStatus = stale ? "stale" : (snapshot?.status ?? "idle");
    const runtime = runtimeStatus.snapshot();
    const displayStatus = runtime.recoveryState === "ready"
      ? previewStatus
      : runtime.recoveryState;
    buildStatus.backgroundColor = displayStatus === "failed"
      ? new vscode.ThemeColor("statusBarItem.errorBackground")
      : displayStatus === "stale"
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;
    const icon = displayStatus === "failed"
      ? "error"
      : displayStatus === "recovering" || displayStatus === "starting" || displayStatus === "rendering"
        ? "sync~spin"
        : displayStatus === "stale"
          ? "warning"
          : displayStatus === "ready"
            ? "check"
            : "circle-outline";
    buildStatus.text = `$(${icon}) MomoScript: ${displayStatus === "rendering" ? "rendering…" : displayStatus}`;
    buildStatus.tooltip = runtimeStatus.tooltip(
      `Preview ${previewStatus}`,
      snapshot?.identity?.revision,
      snapshot?.diagnosticCount ?? 0,
    );
    buildStatus.show();
  };
  const previewReadiness = (requestedSourceUri?: string) => {
    const sourceUri = requestedSourceUri
      ?? previewFixtureActiveSourceUri
      ?? displayedPreviewSourceUri
      ?? vscode.window.activeTextEditor?.document.uri.toString();
    const runtime = runtimeStatus.snapshot();
    const snapshot = sourceUri ? previewBuildState.snapshot(sourceUri) : undefined;
    const diagnostics = sourceUri ? previewBuildState.diagnostics(sourceUri) : [];
    const containerReady = Boolean(previewInteraction.artifact);
    const displayedArtifact = preview.displayedArtifact;
    const fixtureActive = previewFixtureActiveSourceUri === sourceUri;
    const fixtureReady = fixtureActive && displayedArtifact?.sourceUri === sourceUri;
    const stage = runtime.recoveryState !== "ready"
      ? `runtime-${runtime.recoveryState}`
      : !sourceUri
        ? "source-unavailable"
        : fixtureReady
          ? "ready"
          : displayedPreviewSourceUri !== sourceUri
            ? "source-pending"
            : snapshot?.status === "failed"
              ? "failed"
              : snapshot?.status !== "ready"
                ? (snapshot?.status ?? "project-idle")
                : !containerReady || !displayedArtifact
                  ? "artifact-pending"
                  : "ready";
    return {
      stage,
      sourceUri: sourceUri ?? null,
      displayedSourceUri: displayedPreviewSourceUri ?? null,
      runtimeRecoveryState: runtime.recoveryState,
      runtimeLastFailure: runtime.lastFailure ?? null,
      buildStatus: snapshot?.status ?? "idle",
      buildRevision: snapshot?.identity?.revision ?? null,
      fixtureActive,
      containerReady,
      containerRevision: previewInteraction.identity ? String(previewInteraction.identity.revision) : null,
      containerRenderKey: displayedArtifact?.renderKey ?? null,
      displayedRenderKey: displayedArtifact?.renderKey ?? null,
      panelOpen: previewWebviewHost?.isOpen ?? false,
      diagnostics: diagnostics.map(({ phase, severity, message }) => ({ phase, severity, message })),
    };
  };
  const publishPreviewStage = (sourceUri?: string) => {
    const readiness = previewReadiness(sourceUri);
    document.documentElement.dataset.mmtPreviewStage = readiness.stage;
    if (readiness.sourceUri) {
      document.documentElement.dataset.mmtPreviewSourceUri = readiness.sourceUri;
    } else {
      delete document.documentElement.dataset.mmtPreviewSourceUri;
    }
  };
  own(previewBuildState.subscribe((sourceUri) => {
    if ((displayedPreviewSourceUri ?? vscode.window.activeTextEditor?.document.uri.toString()) === sourceUri) {
      refreshBuildStatus();
      publishPreviewStage(sourceUri);
    }
  }));
  own(runtimeStatus.onDidChange(() => {
    refreshBuildStatus();
    publishPreviewStage();
  }));
  own(vscode.window.onDidChangeActiveTextEditor(() => {
    refreshBuildStatus();
    publishPreviewStage();
  }));
  own(vscode.workspace.onDidChangeTextDocument((event) => {
    const sourceUri = event.document.uri.toString();
    const identity = previewBuildState.snapshot(sourceUri).identity;
    if (identity && (
      identity.sourceVersion !== event.document.version
      || identity.sourceStaleToken.documentIncarnation
        !== previewDocumentIncarnations.get(event.document)
    )) {
      previewBuildState.stale(sourceUri);
    } else if (event.document === vscode.window.activeTextEditor?.document) {
      refreshBuildStatus();
    }
  }));
  refreshBuildStatus();
  publishPreviewStage();
  root.classList.toggle("sidebar-collapsed", !isPartVisibile(Parts.SIDEBAR_PART));
  const sidebarVisibilityRegistration = own(onPartVisibilityChange(Parts.SIDEBAR_PART, (visible) => {
    layout.setSidebarVisible(visible);
    root.classList.toggle("sidebar-collapsed", !visible);
  }));
  const applyProject = async (
    project: TypstRenderProjectUpdate,
    replaceSameRevision = false,
    requestId?: number,
    trace?: PreviewTraceSession,
    queueSignal?: AbortSignal,
  ) => {
    const finishTrace = (outcome: "coalesced" | "aborted" | "stale-discarded" | "failed") => {
      if (outcome === "stale-discarded") trace?.increment("staleDiscards");
      trace?.finish(outcome);
      if (trace) {
        previewTraces.delete(trace.traceId);
      }
    };
    const session = projectionSessionKey(project.entryUri);
    const latest = latestProjectBySource.get(project.sourceUri);
    const retiredSessions = retiredProjectSessions.get(project.sourceUri);
    if (!projectPresentationIsCurrent(project)
      || (requestId !== undefined && renderRequestIdBySource.get(project.sourceUri) !== requestId)) return finishTrace("stale-discarded");
    if (retiredSessions?.has(session)) return finishTrace("stale-discarded");
    if ((!latest || latest.session !== session) && !project.full) return finishTrace("stale-discarded");
    if (
      latest?.session === session
      && (project.revision < latest.revision
        || (project.revision === latest.revision && project.sourceVersion !== latest.sourceVersion)
        || (!replaceSameRevision && project.revision === latest.revision))
    ) return finishTrace("stale-discarded");
    const sourceDocument = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === project.sourceUri
    );
    if (!sourceDocument || sourceDocument.version !== project.sourceVersion) return finishTrace("stale-discarded");
    if (latest && latest.session !== session) {
      const nextRetiredSessions = retiredSessions ?? new Set<string>();
      nextRetiredSessions.add(latest.session);
      retiredProjectSessions.set(project.sourceUri, nextRetiredSessions);
    }
    latestProjectBySource.set(project.sourceUri, {
      session,
      sourceVersion: project.sourceVersion,
      revision: project.revision
    });
    const projectRevision = previewBuildIdentityFor(project, sourceDocument);
    previewBuildState.activate(projectRevision);
    for (const diagnostic of project.diagnostics) {
      previewBuildState.fail(
        projectRevision,
        previewPhaseForProjectDiagnostic(diagnostic.phase),
        `[${diagnostic.phase}] ${diagnostic.message}`,
        {
          severity: diagnostic.severity,
          range: diagnostic.range ?? diagnostic.labels[0]?.range,
        }
      );
    }
    const sourceStillCurrent = () =>
      sourceDocument.version === project.sourceVersion
      && previewDocumentIncarnations.get(sourceDocument)
        === projectRevision.sourceStaleToken.documentIncarnation
      && projectPresentationIsCurrent(project)
      && (requestId === undefined || renderRequestIdBySource.get(project.sourceUri) === requestId)
      && previewBuildState.isCurrent(projectRevision);
    if (displayedPreviewSourceUri === project.sourceUri) preview.invalidate();
    materializationControllers.get(project.sourceUri)?.abort();
    const controller = new AbortController();
    materializationControllers.set(project.sourceUri, controller);
    const signal = queueSignal ? AbortSignal.any([controller.signal, queueSignal]) : controller.signal;
    let prepared;
    try {
      const workspaceMirrorStarted = performance.now();
      const workspaceFiles = await workspaceAssetMirror.snapshot(project, signal);
      const mirroredProject = workspaceFiles.length === 0
        ? project
        : { ...project, files: [...project.files, ...workspaceFiles] };
      trace?.stage("workspaceMirror", performance.now() - workspaceMirrorStarted);
      const limits = configuredResourceLimits();
      log("resources:identity", JSON.stringify({
        event: "materialize",
        revision: project.revision,
        projectionKey: project.projectionKey,
        resourceCount: project.resources.length,
        maxFileBytes: limits.maxFileBytes,
        maxProjectBytes: limits.maxProjectBytes,
      }));
      if (!previewResourceReuseEnabled) materializedResourceCache.clear();
      const materializationStarted = performance.now();
      prepared = await materializeProjectResources(
        mirroredProject,
        packSourcesByNamespace,
        materializedResourceCache,
        signal,
        MATERIALIZATION_DEPENDENCIES,
        {
          maxResources: limits.maxResources,
          maxBytes: limits.maxProjectBytes
        }
      );
      trace?.stage("materialization", performance.now() - materializationStarted);
      trace?.increment("resourcesReused", prepared.reusedResources);
      trace?.increment("resourcesRebuilt", prepared.rebuiltResources);
    } catch (error) {
      if (signal.aborted) return finishTrace("aborted");
      if (!sourceStillCurrent()) return finishTrace("stale-discarded");
      const failedCurrent = latestProjectBySource.get(project.sourceUri);
      if (
        failedCurrent?.session !== session
        || failedCurrent.sourceVersion !== project.sourceVersion
        || failedCurrent.revision !== project.revision
      ) return finishTrace("stale-discarded");
      const message = `Failed to fetch preview workspace resources: ${error instanceof Error ? error.message : String(error)}`;
      previewBuildState.fail(projectRevision, "fetch", message);
      log("resources:fetch:error", message);
      void showMomoScriptMessage("warning", `Preview fetch failed: ${message}`);
      if (displayedPreviewSourceUri === project.sourceUri) {
        previewWebviewHost?.postStatus(message, true);
      }
      finishTrace("failed");
      return;
    }
    if (signal.aborted) return finishTrace("aborted");
    if (!sourceStillCurrent()) return finishTrace("stale-discarded");
    const current = latestProjectBySource.get(project.sourceUri);
    if (
      current?.session !== session
      || current.sourceVersion !== project.sourceVersion
      || current.revision !== project.revision
    ) return finishTrace("stale-discarded");
    if (prepared.diagnostics.length > 0) {
      for (const diagnostic of prepared.diagnostics) {
        previewBuildState.fail(projectRevision, diagnostic.phase, diagnostic.message, {
          range: diagnostic.range,
          dependency: diagnostic.dependency,
        });
        log(`resources:${diagnostic.phase}:error`, diagnostic.message);
      }
      const first = prepared.diagnostics[0];
      void showMomoScriptMessage("warning", `Preview ${first.phase} failed: ${first.message}`);
    }
    previewProjects.set(project.sourceUri, prepared.project);
    if (displayedPreviewSourceUri === project.sourceUri && previewWebviewHost?.isOpen) {
      await renderPreview(prepared.project, requestId, trace, signal);
    }
    else finishTrace("coalesced");
  };
  const previewOnChange = () => vscode.workspace.getConfiguration("mmt.preview").get<boolean>("onChange", true);
  const trackLanguageProjection = (project: TypstProjectUpdate) => {
    const tracked = advanceLanguageProjection(
      project,
      projectionSessionKey(project.entryUri),
      latestLanguageProjectionBySource,
      retiredLanguageProjectionSessions,
    );
    if (tracked) languageSourceContent.set(tracked.token, project.sourceContent);
    if (tracked) acceptedPreviewLanguageProjects?.set(project.sourceUri, project);
    return tracked;
  };
  const admitRenderUpdate = async (
    update: TypstRenderProjectUpdate,
    token: LanguageProjectionToken,
    sourceUri: string,
  ) => {
    if (
      update.sourceUri !== sourceUri
      || !isRenderPreset(update.renderPreset)
      || update.entryUri !== (update.renderPreset.kind === "chat"
        ? new URL(`main-${token.revision}-chat-${update.renderPreset.widthPt}-v1.typ`, token.entryUri).href
        : token.entryUri)
      || update.revision !== token.revision
      || update.sourceVersion !== token.sourceVersion
      || update.sourceContent !== languageSourceContent.get(token)
      || !projectPresentationIsCurrent(update)
      || latestLanguageProjectionBySource.get(sourceUri) !== token
    ) {
      throw new Error("Render project update does not match the accepted language projection");
    }
    return renderProjectSnapshots.accept(update);
  };

  const requestRenderProject = async (
    client: BaseLanguageClient,
    sourceUri: string,
    token: LanguageProjectionToken,
    force = false,
    cancellationToken?: vscode.CancellationToken,
    queueSignal?: AbortSignal,
    admissionQueueDepth = 0,
    queuedTraceId?: string,
  ): Promise<void> => {
    const renderPreset = renderPresetFor(sourceUri);
    const presetKey = renderPresetKey(renderPreset);
    const expectedEntryUri = renderPreset.kind === "chat"
      ? new URL(`main-${token.revision}-chat-${renderPreset.widthPt}-v1.typ`, token.entryUri).href
      : token.entryUri;
    let requested = requestedRenderPresets.get(token);
    if (!requested) {
      requested = new Set();
      requestedRenderPresets.set(token, requested);
    }
    if (!force && requested.has(presetKey)) return;
    requested.add(presetKey);
    const timestamp = previewClock.timestamp(token, force);
    const requestId = (renderRequestIdBySource.get(sourceUri) ?? 0) + 1;
    renderRequestIdBySource.set(sourceUri, requestId);
    const traceId = controller.stores.previewPerformance.enabled ? queuedTraceId ?? crypto.randomUUID() : undefined;
    const trace = traceId
      ? controller.stores.previewPerformance.begin({
          traceId,
          sourceUri,
          sourceVersion: token.sourceVersion,
          revision: token.revision,
          requestSequence: requestId,
        })
      : undefined;
    trace?.increment("queueDepth", admissionQueueDepth);
    if (trace) previewTraces.set(trace.traceId, trace);
    const finishTrace = (outcome: "coalesced" | "stale-discarded" | "failed") => {
      if (outcome === "stale-discarded") trace?.increment("staleDiscards");
      trace?.finish(outcome);
      if (trace) previewTraces.delete(trace.traceId);
    };
    log("preview:identity", JSON.stringify({
      event: "request",
      requestId,
      sourceUri,
      revision: token.revision,
      session: token.session,
    }));
    try {
      const base = previewCompilerReuseEnabled && !force
        && projectionSessionKey(renderProjectSnapshots.get(sourceUri, renderPreset)?.entryUri ?? "") === token.session
        ? renderProjectSnapshots.get(sourceUri, renderPreset)
        : undefined;
      const sendRenderRequest = async (forceFull: boolean) => {
        const requestParams: GetTypstRenderProjectParams = {
          uri: sourceUri,
          timestamp,
          renderPreset,
          ...(traceId ? { traceId } : {}),
          ...(!forceFull && base ? {
            baseRevision: base.revision,
            baseProjectDigest: base.projectDigest,
          } : {}),
          ...(forceFull ? { forceFull: true } : {}),
        };
        const deliveryStarted = performance.now();
        const response = await client.sendRequest<TypstRenderProjectUpdate | null>(
          "mmt/getTypstRenderProject",
          requestParams,
          cancellationToken,
        );
        trace?.stage("projectDelivery", performance.now() - deliveryStarted);
        if (response) {
          trace?.increment("projectBytes", encoder.encode(JSON.stringify(response)).byteLength);
          trace?.increment("fileUpserts", response.files.length);
          trace?.increment("fileDeletes", response.deletedUris?.length ?? 0);
        }
        return response;
      };
      let renderUpdate = await sendRenderRequest(force || !previewCompilerReuseEnabled);
      if (renderUpdate === null) {
        log("preview:error", `Render project unavailable for ${sourceUri}`);
        if (renderPreset.kind === "output" && latestLanguageProjectionBySource.get(sourceUri) === token
          && renderRequestIdBySource.get(sourceUri) === requestId && !cancellationToken?.isCancellationRequested) {
          latestArtifactWaiter.failSource(sourceUri, new Error("当前作品的成品投影不可用，请查看排版预览中的诊断。"));
        }
      }
      const responseMatchesToken = (candidate: TypstRenderProjectUpdate | null) => Boolean(
        candidate
        && candidate.entryUri === expectedEntryUri
        && candidate.revision === token.revision
        && candidate.sourceVersion === token.sourceVersion
        && candidate.traceId === traceId
        && candidate.sourceUri === sourceUri
        && candidate.sourceContent === languageSourceContent.get(token)
        && isRenderPreset(candidate.renderPreset)
        && renderPresetKey(candidate.renderPreset) === presetKey
        && renderPresetKey(renderPresetFor(sourceUri)) === presetKey
        && renderRequestIdBySource.get(sourceUri) === requestId
        && latestLanguageProjectionBySource.get(sourceUri) === token
      );
      if (
        cancellationToken?.isCancellationRequested
        || latestLanguageProjectionBySource.get(sourceUri) !== token
        || renderRequestIdBySource.get(sourceUri) !== requestId
      ) {
        finishTrace("stale-discarded");
        return;
      }
      if (!force && !previewOnChange()) {
        requested.delete(presetKey);
        finishTrace("coalesced");
        return;
      }
      if (!responseMatchesToken(renderUpdate)) {
        finishTrace("stale-discarded");
        return;
      }
      let renderProject: TypstRenderProjectUpdate;
      try {
        const accepted = await admitRenderUpdate(renderUpdate!, token, sourceUri);
        renderProject = accepted.project;
      } catch (error) {
        log("preview:delta:fallback", error instanceof Error ? error.message : String(error));
        renderUpdate = await sendRenderRequest(true);
        if (!responseMatchesToken(renderUpdate)) {
          finishTrace("stale-discarded");
          return;
        }
        const accepted = await admitRenderUpdate(renderUpdate!, token, sourceUri);
        renderProject = accepted.project;
      }
      const rustTimings = renderProject.timings;
      if (rustTimings?.rustParseMs !== undefined) trace?.stage("rustParse", rustTimings.rustParseMs);
      if (rustTimings?.rustSemanticMs !== undefined) trace?.stage("rustSemantic", rustTimings.rustSemanticMs);
      if (rustTimings?.rustResolveMs !== undefined) trace?.stage("rustResolve", rustTimings.rustResolveMs);
      if (rustTimings?.rustEmitMs !== undefined) trace?.stage("rustEmit", rustTimings.rustEmitMs);
      if (rustTimings?.rustTypstCheckMs !== undefined) trace?.stage("rustTypstCheck", rustTimings.rustTypstCheckMs);
      if (rustTimings?.rustIndexDigestMs !== undefined) trace?.stage("rustIndexDigest", rustTimings.rustIndexDigestMs);
      const application = applyProject(renderProject, force, requestId, trace, queueSignal);
      pendingMaterializations.add(application);
      try {
        await application;
      } finally {
        pendingMaterializations.delete(application);
      }
    } catch (error) {
      requested.delete(presetKey);
      if (cancellationToken?.isCancellationRequested) {
        finishTrace("coalesced");
        return;
      }
      if (renderPreset.kind === "output" && latestLanguageProjectionBySource.get(sourceUri) === token
        && renderRequestIdBySource.get(sourceUri) === requestId) {
        latestArtifactWaiter.failSource(sourceUri, error);
      }
      finishTrace("failed");
      throw error;
    }
  };
  const dispatchRenderProject = async (
    client: BaseLanguageClient,
    sourceUri: string,
    token: LanguageProjectionToken,
    force = false,
  ): Promise<void> => {
    if (!previewSchedulerEnabled) {
      await requestRenderProject(client, sourceUri, token, force);
      return;
    }
    const traceId = controller.stores.previewPerformance.enabled ? crypto.randomUUID() : "";
    const sequence = previewRenderQueue.enqueuePreview({
      sourceUri,
      token,
      kind: force ? "manual-render" : "typing",
      traceId,
    }, async (accepted, signal) => {
      const cancellation = new vscode.CancellationTokenSource();
      const cancel = () => cancellation.cancel();
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await requestRenderProject(
          client,
          sourceUri,
          token,
          force,
          cancellation.token,
          signal,
          previewRenderQueue.pending().length,
          accepted.traceId,
        );
      } finally {
        signal.removeEventListener("abort", cancel);
        cancellation.dispose();
      }
    });
    await previewRenderQueue.waitForPreview(sourceUri, sequence);
  };
  const dispatchTypstPreview = async (
    project: TypstProjectUpdate,
    document: vscode.TextDocument,
    force: boolean,
  ): Promise<void> => {
    const run = async (signal?: AbortSignal) => {
      if (displayedPreviewSourceUri !== project.sourceUri) return;
      previewBuildState.activate(previewBuildIdentityFor(project, document));
      await renderPreview(project, undefined, undefined, signal);
    };
    if (!previewSchedulerEnabled) {
      await run();
      return;
    }
    const token: LanguageProjectionToken = Object.freeze({
      entryUri: project.entryUri,
      session: projectionSessionKey(project.entryUri),
      sourceVersion: project.sourceVersion,
      revision: project.revision,
    });
    const sequence = previewRenderQueue.enqueuePreview({
      sourceUri: project.sourceUri,
      token,
      kind: force ? "manual-render" : "typing",
      traceId: controller.stores.previewPerformance.enabled ? crypto.randomUUID() : "",
    }, async (_accepted, signal) => run(signal));
    await previewRenderQueue.waitForPreview(project.sourceUri, sequence);
  };
  const schedulePreviewIfEnabled = async (
    client: BaseLanguageClient,
    sourceUri: string,
    token: LanguageProjectionToken,
  ) => {
    if (!previewOnChange()) return;
    await dispatchRenderProject(client, sourceUri, token);
  };
  document.documentElement.dataset.mmtStage = "api-ready";
  await ensureDefaultWorkspace();
  startupProgress.stage("filesystem", "complete", "工作区已就绪");
  document.documentElement.dataset.mmtStage = "filesystem-ready";


  const publishRuntimeStatus = (
    event: string,
    recoveryState: RuntimeRecoveryState,
    lastFailure?: string,
  ) => {
    const backend = tinymist?.backend;
    const snapshot = runtimeStatus.update({
      recoveryState,
      generation: backend?.backendGeneration() ?? 0,
      queuedProjectCount: backend?.queuedProjectCount() ?? 0,
      ...(lastFailure === undefined ? {} : { lastFailure }),
    });
    log("runtime:status", JSON.stringify({ event, ...snapshot }));
  };
  const publishRuntimeQueue = (event: string): void => {
    const backend = tinymist?.backend;
    const snapshot = runtimeStatus.update({
      generation: backend?.backendGeneration() ?? 0,
      queuedProjectCount: backend?.queuedProjectCount() ?? 0,
    });
    log("runtime:status", JSON.stringify({ event, ...snapshot }));
  };
  const syncTinymistProject = (project: TypstProjectUpdate, incremental = false): void => {
    const backend = tinymist?.backend;
    if (backend) {
      const previous = backend.projectForEntry(project.entryUri);
      const update = incremental && previous?.sourceUri === project.sourceUri
        ? { ...project, full: false, files: project.files.filter((file) => file.text !== undefined) }
        : project;
      backend.syncProject(update);
      publishRuntimeQueue("project-queued");
    }
  };

  document.documentElement.dataset.mmtStage = "tinymist-starting";
  startupProgress.stage("tinymist", "active", "正在请求固定资源");
  try {
    tinymist = await startTinymistLanguageClient(
      (message) => log("wasm", message),
      typstPackageService,
      (progress) => startupProgress.tinymistArtifact(progress),
    );
    const handle = tinymist;
    own({ dispose: () => handle.dispose() });
    previewRendererSessions = own(new PreviewRendererSessionOwner({ backend: handle.backend }));
    controller.registerTermination(() => handle.terminate());
    const refreshRuntimeQueue = () => publishRuntimeQueue("project-queue-changed");
    own(handle.backend.on("tinymist/projectPrimeStarted", refreshRuntimeQueue));
    own(handle.backend.on("tinymist/projectPrimed", refreshRuntimeQueue));
    own(handle.backend.on("tinymist/projectPrimeFailed", refreshRuntimeQueue));
    own(handle.backend.on("tinymist/clientRestarting", () => {
      previewComposer?.invalidate();
      previewInteraction.providerRestarted(undefined);
      publishRuntimeStatus("backend-restarting", "recovering");
    }));
    own(handle.backend.on("tinymist/clientRestarted", () => {
      previewComposer?.invalidate();
      publishRuntimeStatus("backend-restarted", "ready");
    }));
    own(handle.backend.on("tinymist/clientFailed", (params) => {
      previewComposer?.invalidate();
      const message = params && typeof params === "object" && "message" in params
        ? String(params.message)
        : "Tinymist backend failed";
      publishRuntimeStatus("backend-failed", "failed", message);
    }));
    publishRuntimeStatus("backend-ready", "ready");
    log("tinymist", "Tinymist Worker ready");
    startupProgress.stage("tinymist", "complete", "已校验并解压");
  } catch (error) {
    startupProgress.stage(
      "tinymist",
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    log("tinymist:error", error instanceof Error ? error.message : String(error));
    void showMomoScriptMessage(
      "warning",
      `内置 Typst 语言服务不可用：${error instanceof Error ? error.message : String(error)}`,
    );
    publishRuntimeStatus(
      "backend-start-failed",
      "failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  document.documentElement.dataset.mmtStage = tinymist ? "tinymist-ready" : "tinymist-unavailable";
  const syncTypstLanguageDocument = async (
    document: vscode.TextDocument,
    incremental = false,
  ): Promise<TypstProjectUpdate | undefined> => {
    if (document.languageId !== "typst" || document.uri.scheme !== "mmtfs" || document.uri.authority !== "workspace") return undefined;
    const sourceUri = document.uri.toString();
    const previous = incremental ? typstProjects.get(sourceUri) : undefined;
    const project = await buildTypstProject(document, typstRevisions, previous);
    if (typstRevisions.get(sourceUri) !== project.revision) return undefined;
    syncTinymistProject(project, previous !== undefined);
    return project;
  };
  const recognizeAndSyncTypst = async (
    document: vscode.TextDocument,
    incremental = false,
  ): Promise<TypstProjectUpdate | undefined> => {
    if (!document.uri.path.toLowerCase().endsWith(".typ")) return undefined;
    const recognized = document.languageId === "typst" ? document : await vscode.languages.setTextDocumentLanguage(document, "typst");
    return syncTypstLanguageDocument(recognized, incremental);
  };
  const syncWorkspaceTypst = async (name: string) => {
    const uri = vscode.Uri.joinPath(WORKSPACE, name).toString();
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri);
    if (!document) throw new Error(`workspace document is not open: ${name}`);
    const project = await recognizeAndSyncTypst(document);
    const accepted = project ? tinymist?.backend.projectForEntry(project.entryUri) : undefined;
    return project ? { entryUri: project.entryUri, revision: project.revision, acceptedRevision: accepted?.revision ?? null } : null;
  };
  const typstDocumentOpenRegistration = subscribe(vscode.workspace.onDidOpenTextDocument((document) => {
    void recognizeAndSyncTypst(document).catch((error: unknown) => log("tinymist:error", error instanceof Error ? error.message : String(error)));
  }));
  const typstEditorActivationRegistration = subscribe(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    rememberActiveWorkspaceDocument(editor.document);
    void recognizeAndSyncTypst(editor.document).catch((error: unknown) => log("tinymist:error", error instanceof Error ? error.message : String(error)));
  }));
  const previewSelectionRegistration = subscribe(vscode.window.onDidChangeTextEditorSelection((event) => {
    if (!vscode.workspace.getConfiguration("mmt.preview").get("selectionHighlight", true)) return;
    const sourceUri = event.textEditor.document.uri.toString();
    if (displayedPreviewSourceUri !== sourceUri) return;
    const identity = currentPreviewIdentity(sourceUri);
    if (!identity) return;
    const selection = event.selections[0];
    if (!selection) return;
    previewInteraction.scheduleEditorSelection({
      identity,
      range: {
        start: { line: selection.start.line, character: selection.start.character },
        end: { line: selection.end.line, character: selection.end.character },
      },
    });
  }));
  const previewSourceAdvanceRegistration = subscribe(vscode.workspace.onDidChangeTextDocument((event) => {
    if (!isTextContentChangeEvent(event)) return;
    const sourceUri = event.document.uri.toString();
    if (displayedPreviewSourceUri !== sourceUri) return;
    previewComposer?.sourceDocumentChanged({
      uri: sourceUri,
      version: event.document.version,
    });
    advanceExactExport(sourceUri, "source");
    controller.stores.previewArtifacts.markStale(sourceUri);
    exactExportUi.bind(sourceUri);
    const project = previewProjects.get(sourceUri) ?? typstProjects.get(sourceUri);
    if (project) previewInteraction.sourceIdentityAdvanced(previewIdentityFor(project, event.document));
  }));
  await Promise.allSettled(vscode.workspace.textDocuments.map((document) => recognizeAndSyncTypst(document)));
  if (vscode.window.activeTextEditor) await recognizeAndSyncTypst(vscode.window.activeTextEditor.document);

  document.documentElement.dataset.mmtStage = "mmt-starting";
  startupProgress.stage("mmt", "active", "正在启动浏览器语言服务");
  try {
    mmt = await startMmtLanguageClient(Boolean(tinymist), (options) => {
      const getClient = (): BaseLanguageClient => {
        const client = mmt?.client.getLanguageClient();
        if (!client) throw new Error("MMT language client did not start");
        return client;
      };
      installMmtSemanticMiddleware(options, getClient, tinymist?.backend);
      tinymist?.installMiddleware(options, getClient);
    });
    activeClient = mmt.client.getLanguageClient();
    const handle = mmt;
    own({ dispose: () => handle.dispose() });
    controller.registerTermination(() => handle.terminate());
    if (!activeClient) throw new Error("MMT language client did not start");
    subscribe(activeClient.onNotification("mmt/typstProjectUpdated", (project: TypstProjectUpdate) => {
      const tracked = trackLanguageProjection(project);
      if (!tracked) return;
      if (tracked.advanced) {
        if (displayedPreviewSourceUri === project.sourceUri) advanceExactExport(project.sourceUri, "dependency");
        syncTinymistProject(project);
      }
      void schedulePreviewIfEnabled(activeClient!, project.sourceUri, tracked.token).catch((error: unknown) => {
        log("preview:error", error instanceof Error ? error.message : String(error));
      });
    }));
    subscribe(activeClient.onNotification(
      "mmt/typstRenderProjectUpdated",
      (update: TypstRenderProjectUpdate) => {
        const token = latestLanguageProjectionBySource.get(update.sourceUri);
        if (!token) return;
        void admitRenderUpdate(update, token, update.sourceUri).catch((error: unknown) => {
          log("preview:render-notification:rejected", error instanceof Error ? error.message : String(error));
        });
      },
    ));
    subscribe(activeClient.onNotification(
      "mmt/typstProjectClosed",
      (params: { sourceUri: string; entryUri: string }) => {
        if (latestLanguageProjectionBySource.get(params.sourceUri)?.entryUri !== params.entryUri) return;
        closePreviewProject(params.sourceUri);
      }
    ));
    const problems = tinymist?.connect(activeClient);
    if (problems) {
      previewBuildState.bindPublisher({
        replace(identity, diagnostics) {
          const grouped = new Map<string, vscode.Diagnostic[]>();
          for (const diagnostic of diagnostics) {
            const problem = previewProblemDiagnostic(diagnostic);
            if (!problem) continue;
            const target = diagnostic.targetUri ?? identity.sourceUri;
            const group = grouped.get(target) ?? [];
            group.push(problem);
            grouped.set(target, group);
          }
          problems.replacePreview(
            vscode.Uri.parse(identity.sourceUri),
            [...grouped].map(([uri, groupedDiagnostics]) => ({
              uri: vscode.Uri.parse(uri),
              diagnostics: groupedDiagnostics,
            })),
          );
        },
        clear(sourceUri) {
          problems.clearPreview(vscode.Uri.parse(sourceUri));
        },
      });
    }
    log("mmt", "MMT language server ready");
    startupProgress.stage("mmt", "complete", "浏览器语言服务已就绪");
  } catch (error) {
    startupProgress.stage(
      "mmt",
      "failed",
      error instanceof Error ? error.message : String(error),
    );
    log("mmt:error", error instanceof Error ? error.message : String(error));
    void showMomoScriptMessage(
      "error",
      `MomoScript 浏览器语言服务器启动失败：${error instanceof Error ? error.message : String(error)}`,
    );
    publishRuntimeStatus(
      "mmt-start-failed",
      "failed",
      error instanceof Error ? error.message : String(error),
    );
  }
  const sendActiveComposerRequest: PreviewComposerControllerPorts["request"] = (
    method,
    params,
    token,
  ) => {
    const client = activeClient;
    if (!client) return Promise.reject(new Error("MMT language client is unavailable"));
    return client.sendRequest<unknown>(method, params, token);
  };
  const sendComposerRequest: PreviewComposerControllerPorts["request"] = composerE2E
    ? (method, params, token) => {
        composerE2E.recordRequest(method);
        const override = composerE2E.requestOverride(method, params);
        return override === undefined
          ? sendActiveComposerRequest(method, params, token)
          : Promise.resolve(override);
      }
    : sendActiveComposerRequest;
  const composerWorkspace = composerE2E
    ? {
        get textDocuments() {
          return vscode.workspace.textDocuments;
        },
        async applyEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
          if (!composerE2E.beginApply()) return false;
          const applied = await vscode.workspace.applyEdit(edit);
          composerE2E.recordApplyResult(applied);
          return applied;
        },
      }
    : vscode.workspace;
  const composerApply = createPreviewComposerApplyPort({
    client: {
      get protocol2CodeConverter() {
        if (!activeClient) throw new Error("MMT language client is unavailable");
        return activeClient.protocol2CodeConverter;
      },
    },
    workspace: composerWorkspace,
  });
  interface PreviewSurfaceMount {
    readonly input: EditorInput;
    readonly document: vscode.TextDocument;
    readonly claimant: object;
    readonly container: HTMLElement;
    readonly clippingContainer: HTMLElement;
    readonly runtime?: ComposerRuntime;
    readonly ui?: ComposerEditorUi;
    readonly setActive?: (active: boolean) => void;
    presentation: PreviewSurfacePresentation;
    visible: boolean;
  }
  const previewSurfaceMounts = new Set<PreviewSurfaceMount>();
  const composerDrafts = new Map<string, ComposerEditorDraft>();
  type ComposerModelReference = IReference<IResolvedTextEditorModel>;
  interface ComposerDocumentOwner {
    readonly document: vscode.TextDocument;
    readonly modelReference: ComposerModelReference;
    readonly runtimeDocument: ComposerRuntimeDocument;
    readonly runtime: ComposerRuntime;
    readonly textSession: NonNullable<ComposerRuntime["textSession"]>;
    readonly draft: ComposerEditorDraft;
    readonly textStateSubscription: { dispose(): void };
    ui?: ComposerEditorUi;
  }
  const composerOwners = new Map<string, ComposerDocumentOwner>();
  const composerMounting = new Map<string, Promise<ComposerEditorMount>>();
  const modeSwitchAbort = new AbortController();
  const nativeCompositions = new Map<ICodeEditor, {
    readonly sourceUri: string;
    readonly promise: Promise<void>;
    readonly resolve: () => void;
  }>();
  const nativeCompositionSubscriptions = new Map<ICodeEditor, readonly { dispose(): void }[]>();
  const trackNativeComposition = (editor: ICodeEditor): void => {
    if (nativeCompositionSubscriptions.has(editor)) return;
    const finish = (): void => {
      nativeCompositions.get(editor)?.resolve();
      nativeCompositions.delete(editor);
    };
    const detach = (): void => {
      finish();
      for (const subscription of nativeCompositionSubscriptions.get(editor) ?? []) subscription.dispose();
      nativeCompositionSubscriptions.delete(editor);
    };
    nativeCompositionSubscriptions.set(editor, [
      editor.onDidCompositionStart(() => {
        finish();
        const resource = editor.getModel()?.uri;
        if (!resource || !isComposerResource(resource)) return;
        const { promise, resolve } = Promise.withResolvers<void>();
        nativeCompositions.set(editor, { sourceUri: resource.toString(), promise, resolve });
      }),
      editor.onDidCompositionEnd(finish),
      editor.onDidChangeModel(finish),
      editor.onDidDispose(detach),
    ]);
  };
  for (const editor of codeEditorService.listCodeEditors()) trackNativeComposition(editor);
  subscribe(codeEditorService.onCodeEditorAdd(trackNativeComposition));
  const waitForNativeComposition = async (sourceUri: string): Promise<void> => {
    modeSwitchAbort.signal.throwIfAborted();
    const pending = [...nativeCompositions.values()]
      .filter((composition) => composition.sourceUri === sourceUri)
      .map((composition) => composition.promise);
    if (pending.length === 0) return;
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const abort = () => { reject(modeSwitchAbort.signal.reason); };
    modeSwitchAbort.signal.addEventListener("abort", abort, { once: true });
    void Promise.all(pending).then(() => { resolve(); }, reject);
    try { await promise; }
    finally { modeSwitchAbort.signal.removeEventListener("abort", abort); }
  };
  own({ dispose() {
    for (const subscriptions of nativeCompositionSubscriptions.values()) {
      for (const subscription of subscriptions) subscription.dispose();
    }
    nativeCompositionSubscriptions.clear();
    for (const composition of nativeCompositions.values()) composition.resolve();
    nativeCompositions.clear();
  } });
  const managedAuthoringParts = [
    Parts.ACTIVITYBAR_PART, Parts.SIDEBAR_PART, Parts.PANEL_PART,
    Parts.AUXILIARYBAR_PART, Parts.STATUSBAR_PART,
  ] as const;
  const nativeLayoutService = await getService(ILayoutService) as LayoutService;
  const nativeConfigurationService = await getService(IConfigurationService);
  let sourcePartsVisibility: Map<Parts, boolean> | undefined;
  let productEditorOptions: { dispose(): void } | undefined;
  let sourceBreadcrumbsMemory: boolean | undefined;
  const setProductWorkbench = (product: boolean): void => {
    if (product === !!sourcePartsVisibility) return;
    if (product) {
      sourcePartsVisibility = new Map(managedAuthoringParts.map((part) => [part, nativeLayoutService.isVisible(part)]));
      sourceBreadcrumbsMemory = nativeConfigurationService.inspect<boolean>("breadcrumbs.enabled").memory?.value;
      void nativeConfigurationService.updateValue("breadcrumbs.enabled", false, ConfigurationTarget.MEMORY).catch((error: unknown) => {
        void showMomoScriptMessage("error", error instanceof Error ? error.message : String(error));
      });
      productEditorOptions = nativeEditorGroupsService.mainPart.enforcePartOptions({ showTabs: "none" });
      for (const part of managedAuthoringParts) nativeLayoutService.setPartHidden(true, part);
    } else {
      const previous = sourcePartsVisibility;
      sourcePartsVisibility = undefined;
      productEditorOptions?.dispose();
      productEditorOptions = undefined;
      void nativeConfigurationService.updateValue("breadcrumbs.enabled", sourceBreadcrumbsMemory, ConfigurationTarget.MEMORY).catch((error: unknown) => {
        void showMomoScriptMessage("error", error instanceof Error ? error.message : String(error));
      });
      sourceBreadcrumbsMemory = undefined;
      for (const [part, visible] of previous ?? []) nativeLayoutService.setPartHidden(!visible, part);
    }
    nativeLayoutService.layout();
  };
  subscribe(onPartVisibilityChange(Parts.ACTIVITYBAR_PART, (visible) => layout.setActivityVisible(visible)));
  subscribe(nativeLayoutService.onDidChangePartVisibility(() => {
    layout.setStatusVisible(nativeLayoutService.isVisible(Parts.STATUSBAR_PART));
  }));
  own({ dispose() { modeSwitchAbort.abort(); setProductWorkbench(false); } });
  const textSessionRoutes = new Map<string, NonNullable<ComposerRuntime["textSession"]>>();
  let textBridgeReady = false;
  const publishComposerSessionState = (runtime: ComposerRuntime, state: ComposerState | undefined = runtime.textSession?.state): void => {
    const session = runtime.textSession;
    if (!state || !session) return;
    if (state.status === "blocked") {
      // A never-issued session cannot contain iframe input or require a drain acknowledgement.
      if (textSessionRoutes.get(state.sessionId) !== session) return;
    } else if (!textBridgeReady || activeGuiRuntime !== runtime
      || mountedPreview?.claimant !== activePreviewSurface?.claimant || !mountedPreview) return;
    textSessionRoutes.set(state.sessionId, session);
    previewWebviewHost?.postComposerState(state);
  };
  const textDrainWaiters = new Set<() => void>();
  const waitForTextChannelDrain = (signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    if (textSessionRoutes.size === 0) return Promise.resolve();
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const cleanup = () => {
      textDrainWaiters.delete(check);
      signal.removeEventListener("abort", abort);
    };
    const check = () => {
      if (textSessionRoutes.size !== 0) return;
      cleanup();
      resolve();
    };
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    textDrainWaiters.add(check);
    signal.addEventListener("abort", abort, { once: true });
    return promise;
  };
  let activePreviewSurface: PreviewSurfaceMount | undefined;
  let previewSourceBinding: Promise<void> = Promise.resolve();
  // Restored native inputs can mount before the language server has a Pack registry.
  let previewSourcesReady = false;
  const mobileComposerMedia = matchMedia("(max-width: 550px)");
  const collapseCompactGuiNavigation = (): void => {
    if (activePreviewSurface?.input.typeId === COMPOSER_EDITOR_ID) setProductWorkbench(true);
  };
  const surfaceIsVisible = (surface: PreviewSurfaceMount): boolean => (
    surface.visible
    && isPartVisibile(Parts.EDITOR_PART)
    && surface.clippingContainer.isConnected
    && surface.clippingContainer.clientWidth > 0
    && surface.clippingContainer.clientHeight > 0
    && nativeEditorGroupsService.mainPart.groups.some((group) => group.activeEditor?.matches(surface.input))
  );
  const syncPreviewSurface = (): void => {
    if (!controller.acceptingWork || !previewWebviewHost || !previewSourcesReady) return;
    // Standalone Monaco widgets get synthetic active groups. Canvas ownership
    // follows the real Workbench editor part, not a focused fragment editor.
    const active = nativeEditorGroupsService.mainPart.activeGroup.activeEditor;
    const visible = [...previewSurfaceMounts].filter(surfaceIsVisible);
    if (active?.resource && active.typeId !== COMPOSER_EDITOR_ID && active.typeId !== PREVIEW_HOST_EDITOR_ID
      && isComposerResource(active.resource)) authoringState(active.resource.toString()).mode = "source";
    const next = visible.find((surface) => active?.matches(surface.input))
      ?? visible.find((surface) => surface.input.typeId === PREVIEW_HOST_EDITOR_ID && surface.document.uri.toString() === active?.resource?.toString())
      ?? visible.find((surface) => surface.input.typeId === PREVIEW_HOST_EDITOR_ID && surface === activePreviewSurface);
    const changedSurface = activePreviewSurface !== next;
    if (changedSurface || mountedPreview?.presentation !== next?.presentation) {
      exactExportUi.cancel();
      surfacePublicationAbort.abort();
      surfacePublicationAbort = new AbortController();
      mountedPreview = undefined;
    }
    if (changedSurface && activeGuiRuntime !== next?.runtime) activeGuiRuntime?.textSession?.setActive(false);
    if (changedSurface) {
      if (activePreviewSurface) previewWebviewHost.releaseSurface(activePreviewSurface.claimant);
      activePreviewSurface = next;
    }
    activeGuiRuntime = next?.runtime;
    for (const surface of previewSurfaceMounts) surface.setActive?.(surface === next);
    activeGuiRuntime?.textSession?.setActive(true);
    // Native Part changes synchronously re-enter surface sync while the old GUI
    // input is still active. The accepted mode, not that retiring input, owns chrome.
    setProductWorkbench(next?.input.typeId === COMPOSER_EDITOR_ID && active?.matches(next.input) === true
      && authoringState(next.document.uri.toString()).mode !== "source");
    if (!next) return;
    const sourceUri = next.document.uri.toString();
    const state = authoringState(sourceUri);
    const previousPreset = renderPresetKey(renderPresetFor(sourceUri));
    if (next.runtime) {
      currentComposerUri = next.document.uri;
      state.canvasMode = next.presentation === "chat" ? "chat" : "layout";
      if (next.input.typeId === COMPOSER_EDITOR_ID && !state.transition) state.mode = state.canvasMode;
    }
    const changedPreset = previousPreset !== renderPresetKey(renderPresetFor(sourceUri));
    previewInteraction.setPresentation(next.presentation);
    previewWebviewHost.attachSurface(next.claimant, next.container, next.clippingContainer, next.presentation);
    mountedPreview = { sourceUri, presentation: next.presentation, claimant: next.claimant };
    if (next.runtime) publishComposerSessionState(next.runtime);
    previewWebviewHost.layoutSurface(next.claimant);
    if (displayedPreviewSourceUri !== sourceUri || changedPreset
      || (changedSurface && (previewInteraction.identity?.sourceStaleToken.documentVersion !== next.document.version
        || (next.runtime && !displayedRendererCandidate)))) {
      previewSourceBinding = bindPreviewSource(next.document).catch((error: unknown) => {
        void showMomoScriptMessage("error", error instanceof Error ? error.message : String(error));
      });
    }
  };
  const revealPreviewSurface = async (
    sourceUri: string | undefined = displayedPreviewSourceUri,
  ): Promise<boolean> => {
    if (!sourceUri) return false;
    await authoringDocuments.get(sourceUri)?.transition;
    if (activePreviewSurface?.runtime && activePreviewSurface.document.uri.toString() === sourceUri
      && authoringState(sourceUri).mode !== "source"
      && surfaceIsVisible(activePreviewSurface)
      && nativeEditorGroupsService.mainPart.activeGroup.activeEditor?.matches(activePreviewSurface.input)) {
      previewWebviewHost?.focusSurface(activePreviewSurface.claimant);
      return true;
    }
    const resource = URI.parse(sourceUri);
    const openedPreview = nativeEditorService.findEditors({
      resource,
      typeId: PREVIEW_HOST_EDITOR_ID,
      editorId: PREVIEW_HOST_EDITOR_ID,
    }).find(({ editor }) => editor instanceof PreviewHostInput);
    const input = openedPreview?.editor instanceof PreviewHostInput
      ? openedPreview.editor
      : new PreviewHostInput(resource);
    // An explicit SIDE_GROUP skips the workbench's Singleton lookup. Activate the
    // owned input in its current group before creating a new side group.
    await nativeEditorService.openEditor(
      input,
      { pinned: true },
      openedPreview?.groupId ?? (matchMedia("(max-width: 550px)").matches ? undefined : SIDE_GROUP),
    );
    await previewHostSurfaces.waitUntilMounted(input);
    syncPreviewSurface();
    return previewWebviewHost?.isOpen ?? false;
  };
  subscribe(nativeEditorService.onDidActiveEditorChange(syncPreviewSurface));
  subscribe(nativeEditorService.onDidVisibleEditorsChange(syncPreviewSurface));
  subscribe(nativeEditorGroupsService.mainPart.onDidChangeActiveGroup(syncPreviewSurface));
  subscribe(nativeEditorGroupsService.mainPart.onDidLayout(syncPreviewSurface));
  subscribe(onPartVisibilityChange(Parts.EDITOR_PART, syncPreviewSurface));
  own(ownEventListener(window, "resize", syncPreviewSurface));
  own(ownEventListener(mobileComposerMedia, "change", () => {
    if (activeGuiRuntime) collapseCompactGuiNavigation();
  }));
  let guiDocumentRequests = 0;
  let guiEditRequests = 0;
  let guiApplyAttempts = 0;
  let lastGuiNotification: string | null = null;
  interface PendingTextRecovery {
    readonly id: string;
    readonly uri: string;
    readonly owner: object;
    text: string;
    reason: string;
    readonly resolve: (expectedText: string) => boolean;
  }
  const pendingTextRecoveries: PendingTextRecovery[] = [];
  const preparedTextRecoveries = new Map<string, {
    readonly prepared: {
      readonly record: PendingTextRecovery;
      readonly text: string;
      readonly session: NonNullable<ComposerRuntime["textSession"]>;
      readonly target: ComposerTextRecoveryTarget;
    };
    readonly confirmation: ComposerTextRecoveryConfirmation;
  }>();
  const recoveryStatus = own(vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40));
  recoveryStatus.command = "mmt.composer.recoverInput";
  recoveryStatus.tooltip = "复制或丢弃未提交文字；不会自动覆盖源码";
  const refreshRecoveryStatus = () => {
    recoveryStatus.text = `$(warning) 未提交输入 (${pendingTextRecoveries.length})`;
    if (pendingTextRecoveries.length > 0) recoveryStatus.show();
    else recoveryStatus.hide();
    for (const surface of previewSurfaceMounts) surface.ui?.refresh();
  };
  const resolveTextRecovery = (record: PendingTextRecovery, text: string): boolean => {
    const index = pendingTextRecoveries.indexOf(record);
    if (index < 0 || record.text !== text || !record.resolve(text)) return false;
    pendingTextRecoveries.splice(index, 1);
    preparedTextRecoveries.delete(record.id);
    refreshRecoveryStatus();
    return true;
  };
  const recoveryForUri = (uri: string, id: string): PendingTextRecovery => {
    const record = pendingTextRecoveries.find((candidate) => candidate.uri === uri && candidate.id === id);
    if (!record) throw new Error("未提交文字已改变，请重新选择恢复记录。");
    return record;
  };
  const prepareTextRecovery = (uri: string, id: string): ComposerTextRecoveryConfirmation | undefined => {
    preparedTextRecoveries.delete(id);
    const record = recoveryForUri(uri, id);
    if (pendingTextRecoveries.find((candidate) => candidate.owner === record.owner) !== record) {
      void showMomoScriptMessage("warning", "请先处理同一正文会话中较早的未提交文字。");
      return undefined;
    }
    const surface = activePreviewSurface;
    const session = surface?.runtime?.textSession;
    const target = session?.captureRecoveryTarget();
    const snapshot = surface?.runtime?.state.snapshot;
    if (!controller.acceptingWork || provider?.coordinator.state.lease !== "writer"
      || !surface || surface.document.uri.toString() !== uri || !session || !target || !snapshot) {
      void showMomoScriptMessage("warning", "请先在当前作品的 SVG 正文中重新选择要恢复到的位置。");
      return undefined;
    }
    const endpoints = [target.selection.anchor, target.selection.focus];
    const selected = endpoints.map((endpoint) => snapshot.nodes.find((node) => node.nodeKey === endpoint.node.nodeKey));
    if (selected.some((node) => !node || node.kind === "opaque" || !node.textEditing)) return undefined;
    const summary = (node: NonNullable<typeof selected[number]>): string => {
      const position = snapshot.nodes.filter((candidate) => candidate.kind !== "opaque").findIndex((candidate) => candidate.nodeKey === node.nodeKey) + 1;
      const text = node.kind === "opaque" ? "" : node.textEditing?.text ?? "";
      const excerpt = text.replace(/\s+/gu, " ").slice(0, 48);
      return `第 ${position} 条${excerpt ? `：${excerpt}` : "（空正文）"}`;
    };
    const [first, last] = selected as [NonNullable<typeof selected[number]>, NonNullable<typeof selected[number]>];
    const targetSummary = first.nodeKey === last.nodeKey ? summary(first) : `${summary(first)} → ${summary(last)}`;
    const confirmation = { targetSummary };
    preparedTextRecoveries.set(id, { prepared: { record, text: record.text, session, target }, confirmation });
    return confirmation;
  };
  const retryTextRecovery = async (uri: string, id: string, confirmation: ComposerTextRecoveryConfirmation): Promise<boolean> => {
    const entry = preparedTextRecoveries.get(id);
    if (!entry || entry.confirmation !== confirmation) {
      await showMomoScriptMessage("warning", "恢复目标或文字已改变，请重新选择正文并确认。");
      return false;
    }
    const { prepared } = entry;
    preparedTextRecoveries.delete(id);
    const record = recoveryForUri(uri, id);
    if (prepared.record !== record || prepared.text !== record.text
      || pendingTextRecoveries.find((candidate) => candidate.owner === record.owner) !== record
      || activePreviewSurface?.document.uri.toString() !== uri
      || activeGuiRuntime?.textSession !== prepared.session || provider?.coordinator.state.lease !== "writer") {
      await showMomoScriptMessage("warning", "恢复目标或文字已改变，请重新选择正文并确认。");
      return false;
    }
    if (!await prepared.session.retryRecoveredText(prepared.text, prepared.target)) return false;
    resolveTextRecovery(record, prepared.text);
    return true;
  };
  let recoveryPrompt: Promise<void> | undefined;
  const showInputRecovery = (): Promise<void> => {
    if (recoveryPrompt) return recoveryPrompt;
    const record = pendingTextRecoveries[0];
    if (!record) return Promise.resolve();
    const offeredText = record.text;
    recoveryPrompt = (async () => {
      const choice = await vscode.window.showQuickPick([
        { label: "复制未提交文字", detail: offeredText, action: "copy" },
        { label: "丢弃未提交文字", description: "不修改当前源码", action: "discard" },
      ], { title: record.reason, ignoreFocusOut: true });
      if (!choice) return;
      if (record.text !== offeredText) throw new Error("未提交文字已更新，请重新确认恢复内容");
      if (choice.action === "copy") await navigator.clipboard.writeText(offeredText);
      if (!resolveTextRecovery(record, offeredText)) throw new Error("未提交文字的恢复顺序或内容已改变，请重试");
    })().finally(() => { recoveryPrompt = undefined; });
    return recoveryPrompt;
  };
  subscribe(vscode.commands.registerCommand("mmt.composer.recoverInput", showInputRecovery));
  own(ownEventListener(window, "beforeunload", (event) => {
    if (pendingTextRecoveries.length === 0
      && ![...composerDrafts.values()].some((draft) => draft.body.length > 0)
      && ![...previewSurfaceMounts].some((surface) => surface.ui?.hasUnsubmittedInput || surface.runtime?.textSession?.hasUnsubmittedInput)) return;
    event.preventDefault();
    event.returnValue = true;
  }));
  own({
    quiesce() {
      modeSwitchAbort.abort();
      surfacePublicationAbort.abort();
      for (const owner of composerOwners.values()) owner.runtime.quiesce();
    },
    dispose() {
      for (const owner of composerOwners.values()) {
        owner.textStateSubscription.dispose();
        owner.runtime.dispose();
        owner.modelReference.dispose();
      }
      composerOwners.clear();
      composerMounting.clear();
      textSessionRoutes.clear();
      for (const check of textDrainWaiters) check();
    },
  });
  const defaultExportFormat = (): "pdf" | "png" => {
    const format = vscode.workspace.getConfiguration("mmt.export").get<unknown>("defaultFormat", "pdf");
    return format === "png" ? "png" : "pdf";
  };
  const outputArtifactFor = (document: vscode.TextDocument, requireCurrent = false): PreviewArtifact => {
    const sourceUri = document.uri.toString();
    const displayed = preview.displayedArtifact;
    const retained = displayed && controller.stores.previewArtifacts.get(displayed.renderKey);
    const identity = previewInteraction.identity;
    if (!controller.acceptingWork || !vscode.workspace.textDocuments.includes(document)
      || displayedPreviewSourceUri !== sourceUri || mountedPreview?.sourceUri !== sourceUri
      || mountedPreview.presentation === "chat" || renderPresetFor(sourceUri).kind !== "output"
      || !displayed || displayed.sourceUri !== sourceUri || displayed.renderPreset.kind !== "output"
      || preview.displayedRenderKey !== displayed.renderKey
      || !retained || retained.sourceUri !== sourceUri || retained.renderPreset.kind !== "output"
      || identity?.sourceUri !== sourceUri
      || identity.sourceStaleToken.documentIncarnation !== previewDocumentIncarnations.get(document)) {
      throw new Error("当前没有此作品已接受的成品排版快照，请打开排版预览。");
    }
    const snapshot = controller.stores.previewArtifacts.document(sourceUri);
    if (requireCurrent && (retained.stale || snapshot.status !== "ready"
      || snapshot.displayedArtifact?.renderKey !== displayed.renderKey
      || (snapshot.requestedRenderKey !== undefined && snapshot.requestedRenderKey !== displayed.renderKey)
      || identity.sourceStaleToken.documentVersion !== document.version)) {
      throw new Error("尚未取得此作品当前版本的成品排版，请查看排版预览中的实际错误。");
    }
    return retained;
  };
  const openProductExportPanel = async (sourceUri: string): Promise<void> => {
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === sourceUri);
    if (!document || !isComposerResource(document.uri)) throw new Error("作品文档已关闭，无法导出。");
    await switchAuthoringMode(sourceUri, "layout");
    outputArtifactFor(document, true);
    const surface = activePreviewSurface;
    if (surface?.document !== document || surface.presentation !== "layout" || !surface.ui) {
      throw new Error("此作品的排版预览已关闭，未打开导出面板。");
    }
    exactExportUi.bind(sourceUri);
    surface.ui.openExportPanel();
  };
  const downloadComposerSource = async (sourceUri: string): Promise<void> => {
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === sourceUri);
    if (!document || !isComposerResource(document.uri)) throw new Error("作品文档已关闭，无法下载源文件。");
    const owner = composerOwners.get(sourceUri);
    await waitForNativeComposition(sourceUri);
    await owner?.ui?.prepareModeSwitch();
    await owner?.textSession.waitForCompositionEnd();
    await owner?.textSession.drainAccepted();
    if (!controller.acceptingWork || !vscode.workspace.textDocuments.includes(document)) {
      throw new Error("作品文档已关闭，未下载源文件。");
    }
    downloadBlob(
      new Blob([document.getText()], { type: "text/plain;charset=utf-8" }),
      document.uri.path.split("/").at(-1) || `${workTitle(document.uri)}.mmt`,
    );
  };
  const exportExactSnapshot = async (
    sourceUri: string,
    format: ExactExportFormat,
    options: Pick<ExactExportRequest, "staleChoice" | "pageIndex"> = {},
    inputPolicy: "drain-accepted" | "snapshot-only" = "drain-accepted",
  ): Promise<ExactExportResult | undefined> => {
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === sourceUri);
    if (!document) throw new Error("文档已关闭，无法导出成品。");
    if (inputPolicy === "drain-accepted" && isComposerResource(document.uri)) {
      const owner = composerOwners.get(sourceUri);
      await waitForNativeComposition(sourceUri);
      await owner?.ui?.prepareModeSwitch();
      await owner?.textSession.waitForCompositionEnd();
      await owner?.textSession.drainAccepted();
      if (authoringState(sourceUri).canvasMode !== "layout" || mountedPreview?.sourceUri !== sourceUri) {
        await switchAuthoringMode(sourceUri, "layout");
      }
    }
    const artifact = outputArtifactFor(document);
    const exportRenderKey = artifact.renderKey;
    const releaseArtifact = controller.stores.previewArtifacts.pin(exportRenderKey);
    const immutable = immutablePreviewExports.get(exportRenderKey);
    if (immutable) immutable.pins += 1;
    let exported: ExactExportResult | undefined;
    const run = async (signal?: AbortSignal): Promise<void> => {
      signal?.throwIfAborted();
      if (outputArtifactFor(document).renderKey !== exportRenderKey || exactExportUi.state.sourceUri !== sourceUri) {
        throw new Error("排版快照已改变，请在当前作品中重新选择导出范围。");
      }
      const cancel = () => exactExportUi.cancel();
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        const operation = exactExportUi.export(format, options);
        if (options.staleChoice === "wait-for-latest" && exactExportUi.state.phase === "waiting"
          && !previewOnChange() && previewFixtureActiveSourceUri !== sourceUri) {
          previewSourceBinding = bindPreviewSource(document);
          void previewSourceBinding.catch((error: unknown) => latestArtifactWaiter.failSource(sourceUri, error));
        }
        exported = await operation;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    };
    try {
      exactExportUi.bind(sourceUri);
      if (previewSchedulerEnabled) {
        const sequence = previewRenderQueue.enqueueExport({
          sourceUri,
          renderKey: exportRenderKey,
          traceId: controller.stores.previewPerformance.enabled ? crypto.randomUUID() : "",
        }, async (accepted, signal) => {
          if (!previewRenderQueue.isCurrentExport(sourceUri, accepted.sequence, exportRenderKey)
            || accepted.sourceUri !== sourceUri || accepted.renderKey !== exportRenderKey) return;
          await run(signal);
        });
        await previewRenderQueue.waitForExport(sourceUri, sequence);
      } else {
        await run();
      }
      return exported;
    } finally {
      releaseArtifact();
      if (immutable) {
        immutable.pins -= 1;
        evictImmutablePreviewExports();
      }
    }
  };
  let currentComposerUri: vscode.Uri | undefined;
  const isMmtDocument = (document: vscode.TextDocument): boolean => isComposerResource(document.uri);
  const openComposerDocument = async (resource: vscode.Uri): Promise<void> => {
    if (!isComposerResource(resource)) throw new Error("GUI 创作只支持工作区 MMT 文档");
    const opened = await vscode.workspace.openTextDocument(resource);
    const textDocument = opened.languageId === "mmt"
      ? opened
      : await vscode.languages.setTextDocumentLanguage(opened, "mmt");
    if (!isMmtDocument(textDocument)) throw new Error("GUI 创作只支持工作区 MMT 文档");
    await switchAuthoringMode(textDocument.uri.toString(), "chat");
    await nativeStorageService.flush();
  };
  const createComposerDocument = async (): Promise<void> => {
    const name = await vscode.window.showInputBox({
      title: "新建作品",
      prompt: "输入作品名",
      placeHolder: "例如：放学后的对话",
      validateInput(value) {
        const title = value.trim().replace(/[/\\\u0000-\u001f\u007f-\u009f]/gu, "_").replace(/(?:\.mmt)+$/i, "").trim();
        if (!title || title === "." || title === "..") return "作品名不能为空或使用 . / ..";
        return undefined;
      },
    });
    if (name === undefined) return;
    const title = name.trim().replace(/[/\\\u0000-\u001f\u007f-\u009f]/gu, "_").replace(/(?:\.mmt)+$/i, "").trim();
    if (!title || title === "." || title === "..") return;
    for (let ordinal = 1; ; ordinal += 1) {
      const filename = `${title}${ordinal === 1 ? "" : ` (${ordinal})`}.mmt`;
      const resource = vscode.Uri.joinPath(WORKSPACE, filename);
      try {
        await vscode.workspace.fs.stat(resource);
      } catch (error) {
        if (!(error instanceof vscode.FileSystemError) || error.code !== "FileNotFound") throw error;
        await vscode.workspace.fs.writeFile(resource, new Uint8Array());
        await openComposerDocument(resource);
        return;
      }
    }
  };
  const chooseComposerDocument = async (): Promise<void> => {
    const files = await Promise.all([
      vscode.workspace.findFiles("**/*.mmt"),
      vscode.workspace.findFiles("**/*.mmt.txt"),
    ]);
    const byUri = new Map(files.flat().map((uri) => [uri.toString(), uri]));
    const picked = await vscode.window.showQuickPick(
      [...byUri.values()].map((uri) => ({ label: workTitle(uri), description: uri.path, uri })),
      { title: "打开作品", placeHolder: "选择已有作品" },
    );
    if (picked) await openComposerDocument(picked.uri);
  };
  subscribe(vscode.commands.registerCommand("mmt.composer.open", async (resource?: vscode.Uri) => {
    const selected = resource
      ?? vscode.window.activeTextEditor?.document.uri
      ?? currentComposerUri;
    if (!selected) {
      void showMomoScriptMessage("warning", "请先选择一个 MomoScript 文档。");
      return;
    }
    await openComposerDocument(selected);
  }));
  subscribe(vscode.commands.registerCommand("mmt.composer.new", createComposerDocument));
  subscribe(vscode.commands.registerCommand("mmt.composer.choose", chooseComposerDocument));
  const sourceAuthoringContext = ContextKeyExpr.and(
    ContextKeyExpr.equals("resourceScheme", WORKSPACE.scheme),
    ContextKeyExpr.equals("editorLangId", "mmt"),
  );
  const productExportCommand = { id: "mmt.export.work", title: "导出作品" };
  const sourceDownloadCommand = { id: "mmt.composer.downloadSource", title: "下载源文件" };
  subscribe(vscode.commands.registerCommand(productExportCommand.id, async (resource?: vscode.Uri) => {
    const sourceUri = (resource ?? nativeEditorService.activeEditor?.resource ?? currentComposerUri)?.toString();
    if (!sourceUri) throw new Error("请先打开一个 MomoScript 作品。");
    await openProductExportPanel(sourceUri);
  }));
  subscribe(vscode.commands.registerCommand(sourceDownloadCommand.id, async (resource?: vscode.Uri) => {
    const sourceUri = (resource ?? nativeEditorService.activeEditor?.resource ?? currentComposerUri)?.toString();
    if (!sourceUri) throw new Error("请先打开一个 MomoScript 作品。");
    await downloadComposerSource(sourceUri);
  }));
  own(MenuRegistry.addCommand(productExportCommand));
  own(MenuRegistry.addCommand(sourceDownloadCommand));
  own(MenuRegistry.appendMenuItem(MenuId.EditorTitle, {
    command: productExportCommand, when: sourceAuthoringContext, group: "navigation", order: 2,
  }));
  own(MenuRegistry.appendMenuItem(MenuId.EditorTitleContext, {
    command: sourceDownloadCommand, when: sourceAuthoringContext, group: "navigation", order: 3,
  }));
  for (const command of [productExportCommand, sourceDownloadCommand]) {
    own(MenuRegistry.appendMenuItem(MenuId.CommandPalette, { command, when: sourceAuthoringContext }));
  }
  const sendRuntimeRequest = (method: "mmt/composerDocument" | "mmt/composerEdit" | "mmt/previewComposerTarget" | "mmt/composerTextSelection" | "mmt/composerTextProjection" | "mmt/mapTypstReadLocations", params: unknown, signal: AbortSignal) => {
    const client = activeClient;
    if (!client) return Promise.reject(new Error("MMT language client is unavailable"));
    const cancellation = new vscode.CancellationTokenSource();
    const abort = () => cancellation.cancel();
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    return client.sendRequest<unknown>(method, params, cancellation.token).finally(() => {
      signal.removeEventListener("abort", abort);
      cancellation.dispose();
    });
  };
  const currentTextGeometryBinding = (): ComposerTextGeometryBinding | undefined => {
    const snapshot = activeGuiRuntime?.state.snapshot;
    const candidate = displayedRendererCandidate;
    const identity = previewInteraction.identity;
    const artifact = preview.displayedArtifact;
    if (!snapshot || !candidate || !identity?.projectionKey || !artifact || artifact.stale
      || (identity.backendEncoding !== "utf-8" && identity.backendEncoding !== "utf-16")
      || snapshot.textDocument.uri !== identity.sourceUri
      || snapshot.textDocument.version !== identity.sourceStaleToken.documentVersion
      || candidate.sourceUri !== identity.sourceUri
      || candidate.ready.snapshotToken !== artifact.renderKey) return undefined;
    const current = currentPreviewIdentity(identity.sourceUri);
    if (!current || current.sourceStaleToken.documentVersion !== snapshot.textDocument.version
      || current.sourceStaleToken.documentIncarnation !== identity.sourceStaleToken.documentIncarnation
      || current.projectionKey !== identity.projectionKey || current.revision !== identity.revision
      || current.projectDigest !== identity.projectDigest || current.sourceContent !== identity.sourceContent) return undefined;
    return {
      snapshot,
      candidate,
      rendererEncoding: identity.backendEncoding,
      identity: {
        sourceUri: identity.sourceUri,
        revision: identity.revision,
        entryUri: identity.entryUri,
        backendEncoding: identity.backendEncoding,
        sourceContent: identity.sourceContent,
        projectDigest: identity.projectDigest,
        projectionKey: identity.projectionKey,
        version: snapshot.textDocument.version,
        sourceDigest: snapshot.sourceDigest,
        renderKey: artifact.renderKey,
        sessionId: candidate.sessionId,
        generation: candidate.ready.generation,
      },
    };
  };
  const textRenderer = (): PreviewRendererSessionOwner => {
    if (!previewRendererSessions) throw new Error("排版文字定位服务尚未就绪");
    return previewRendererSessions;
  };
  const textGeometry = new ComposerTextGeometry({
    current: currentTextGeometryBinding,
    renderer: {
      hitTestText: (...args) => textRenderer().hitTestText(...args),
      locateCaret: (...args) => textRenderer().locateCaret(...args),
      locateRange: (...args) => textRenderer().locateRange(...args),
    },
    readSelection: (params, signal) => sendRuntimeRequest("mmt/composerTextSelection", params, signal),
    projectSelection: (params, signal) => sendRuntimeRequest("mmt/composerTextProjection", params, signal),
    mapToAuthored: async (location, identity, signal) => parsePreviewSourceTargets(
      await sendRuntimeRequest("mmt/mapTypstReadLocations", {
        sourceUri: identity.sourceUri,
        revision: identity.revision,
        entryUri: identity.entryUri,
        backendEncoding: identity.backendEncoding,
        sourceContent: identity.sourceContent,
        projectDigest: identity.projectDigest,
        projectionKey: identity.projectionKey,
        locations: [location],
      }, signal),
    ),
  });
  const chatContextAppearance = () => activeGuiRuntime !== undefined;
  const [
    composerContextMenu,
    composerContextInput,
    composerMessageEditor,
    composerAvatarPicker,
  ] = await Promise.all([
    createWorkbenchPreviewContextMenu(chatContextAppearance),
    createWorkbenchPreviewContextInput(chatContextAppearance),
    createWorkbenchPreviewMessageEditor(chatContextAppearance),
    createWorkbenchPreviewAvatarPicker(chatContextAppearance),
  ]);
  async function saveComposerDocument(sourceUri: string): Promise<void> {
    const state = authoringState(sourceUri);
    if (state.saving) return state.saving;
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === sourceUri);
    if (!document) throw new Error("作品文档已关闭，无法保存");
    state.saveError = undefined;
    const operation = (async () => {
      if (!await document.save()) throw new Error("保存作品失败，请重试");
      await persistenceByUri.get(sourceUri);
      if (state.saveError) throw new Error(state.saveError);
    })();
    state.saving = operation;
    for (const surface of previewSurfaceMounts) if (surface.document === document) surface.ui?.refresh();
    try {
      await operation;
    } catch (error) {
      state.saveError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      state.saving = undefined;
      for (const surface of previewSurfaceMounts) if (surface.document === document) surface.ui?.refresh();
    }
  }
  async function switchAuthoringMode(sourceUri: string, mode: AuthoringMode): Promise<void> {
    const state = authoringState(sourceUri);
    if (state.transition) {
      await state.transition;
      return switchAuthoringMode(sourceUri, mode);
    }
    const operation = (async () => {
      modeSwitchAbort.signal.throwIfAborted();
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(sourceUri, true));
      if (!isComposerResource(document.uri)) throw new Error("创作模式只支持工作区 MomoScript 作品");
      await waitForNativeComposition(sourceUri);
      const surface = activePreviewSurface;
      const owner = composerOwners.get(sourceUri);
      await surface?.ui?.prepareModeSwitch();
      await surface?.runtime?.textSession?.waitForCompositionEnd();
      await surface?.runtime?.textSession?.prepareToLeave(modeSwitchAbort.signal);
      if (owner && owner.runtime !== surface?.runtime) {
        await owner.textSession.waitForCompositionEnd();
        await owner.textSession.prepareToLeave(modeSwitchAbort.signal);
      }
      await waitForTextChannelDrain(modeSwitchAbort.signal);
      modeSwitchAbort.signal.throwIfAborted();
      if (!vscode.workspace.textDocuments.includes(document)) throw new Error("作品文档已关闭，未切换模式。");
      const previousMode = state.mode;
      const previousCanvas = state.canvasMode;
      state.mode = mode;
      if (mode !== "source") state.canvasMode = mode;
      try {
        if (mode === "source") {
          setProductWorkbench(false);
          await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
          if (mobileComposerMedia.matches && nativeEditorGroupsService.mainPart.groups.length > 1) {
            await vscode.commands.executeCommand("workbench.action.joinAllGroups");
          }
        } else {
          const productSurface = [...previewSurfaceMounts].find((candidate) => (
            candidate.input.typeId === COMPOSER_EDITOR_ID && candidate.document === document
          ));
          if (productSurface) {
            productSurface.presentation = mode;
            await nativeEditorService.openEditor(productSurface.input, { pinned: true });
            productSurface.ui?.refresh();
          } else {
            await vscode.commands.executeCommand("vscode.openWith", document.uri, COMPOSER_EDITOR_ID);
          }
          await composerMounting.get(sourceUri);
          if (mobileComposerMedia.matches && nativeEditorGroupsService.mainPart.groups.length > 1) {
            await vscode.commands.executeCommand("workbench.action.joinAllGroups");
          }
          await vscode.commands.executeCommand("workbench.action.keepEditor");
          syncPreviewSurface();
          const current = [...previewSurfaceMounts].find((candidate) => (
            candidate.input.typeId === COMPOSER_EDITOR_ID && candidate.document === document
          ));
          if (current) {
            current.presentation = mode;
            current.ui?.refresh();
          }
          const retainedProject = previewProjects.get(sourceUri);
          if (previousCanvas !== mode || displayedPreviewSourceUri !== sourceUri
            || !retainedProject || !projectPresentationIsCurrent(retainedProject)
            || retainedProject.sourceVersion !== document.version
            || previewInteraction.identity?.sourceStaleToken.documentVersion !== document.version
            || preview.displayedArtifact?.renderPreset.kind !== (mode === "chat" ? "chat" : "output")) {
            materializationControllers.get(sourceUri)?.abort();
            renderRequestIdBySource.set(sourceUri, (renderRequestIdBySource.get(sourceUri) ?? 0) + 1);
            preview.invalidate();
            displayedRendererCandidate = undefined;
            previewSourceBinding = bindPreviewSource(document);
          }
          syncPreviewSurface();
          const requestedBinding = previewSourceBinding;
          const publicationSignal = surfacePublicationAbort.signal;
          try {
            await requestedBinding;
          } catch (error) {
            if (!(error instanceof PreviewRendererCompilationError)) throw error;
            const artifact = controller.stores.previewArtifacts.document(sourceUri);
            const failedProject = error.synchronized.project;
            // The native pane has opened. A diagnosed compile failure belongs
            // to its current preview, not to mode activation or runtime startup.
            if (modeSwitchAbort.signal.aborted || publicationSignal.aborted || !controller.acceptingWork
              || previewSourceBinding !== requestedBinding || !current || activePreviewSurface !== current
              || current.presentation !== mode || !acceptsMountedPreview(sourceUri, renderPresetFor(sourceUri))
              || error.sourceUri !== sourceUri || artifact.status !== "failed" || !artifact.requestedRenderKey
              || previewBuildState.snapshot(sourceUri).status !== "failed"
              || !rendererDiagnosticIdentityIsCurrent({
                sourceUri,
                sourceVersion: failedProject.sourceVersion,
                revision: failedProject.revision,
                sourceContent: failedProject.sourceContent,
                projectDigest: failedProject.projectDigest,
                projectionKey: failedProject.projectionKey,
                entryUri: error.synchronized.compilerEntryUri,
                snapshotToken: artifact.requestedRenderKey,
                backendGeneration: error.backendGeneration,
                backendEncoding: "utf-16",
              })) throw error;
            void showMomoScriptMessage("error", error.message);
          }
          owner?.textSession.setActive(activeGuiRuntime === owner.runtime);
        }
      } catch (error) {
        state.mode = previousMode;
        state.canvasMode = previousCanvas;
        syncPreviewSurface();
        throw error;
      }
    })();
    state.transition = operation;
    try { await operation; }
    finally { if (state.transition === operation) state.transition = undefined; }
  }
  const resizeChatCanvas = (sourceUri: string, measuredWidth: number): void => {
    if (!Number.isFinite(measuredWidth)) return;
    const widthPt = Math.max(240, Math.min(720, Math.round(measuredWidth)));
    const state = authoringState(sourceUri);
    if (state.widthPt === widthPt) return;
    state.widthPt = widthPt;
    if (state.canvasMode !== "chat" || activePreviewSurface?.document.uri.toString() !== sourceUri) return;
    materializationControllers.get(sourceUri)?.abort();
    renderRequestIdBySource.set(sourceUri, (renderRequestIdBySource.get(sourceUri) ?? 0) + 1);
    preview.invalidate();
    displayedRendererCandidate = undefined;
    const client = activeClient;
    const token = latestLanguageProjectionBySource.get(sourceUri);
    if (client && token) {
      previewSourceBinding = dispatchRenderProject(client, sourceUri, token, true).catch((error: unknown) => {
        void showMomoScriptMessage("error", error instanceof Error ? error.message : String(error));
      });
    }
  };
  const composerGalleryImages = own(new GalleryImageCache());
  const packSpeakerOptions = (): readonly ComposerSpeakerOption[] => galleryPacks.flatMap((pack) =>
    pack.entities.map((entity) => ({
      reference: `${pack.namespace}::${entity.key}`,
      label: entity.catalogDisplayName ?? entity.displayName,
      source: "packEntity" as const,
    }))
  );
  const getComposerOwner = (
    textDocument: vscode.TextDocument,
    modelReference: ComposerModelReference,
  ): ComposerDocumentOwner => {
    const sourceUri = textDocument.uri.toString();
    const existing = composerOwners.get(sourceUri);
    if (existing?.document === textDocument) {
      modelReference.dispose();
      return existing;
    }
    existing?.textStateSubscription.dispose();
    existing?.runtime.dispose();
    existing?.modelReference.dispose();
    const runtimeDocument: ComposerRuntimeDocument = {
      uri: textDocument.uri,
      get version() { return textDocument.version; },
      languageId: textDocument.languageId,
      getText: () => textDocument.getText(),
      offsetAt: (position) => textDocument.offsetAt(new vscode.Position(position.line, position.character)),
      positionAt: (offset) => {
        const position = textDocument.positionAt(offset);
        return { line: position.line, character: position.character };
      },
    };
    currentComposerUri = textDocument.uri;
    const draftUri = textDocument.uri.toString();
    const draft = composerDrafts.get(draftUri) ?? {
      body: "", speaker: { kind: "builtin" as const }, side: "right" as const, avatarChoice: null,
      mode: "textRaw" as const, recentSpeakers: [], insertTarget: { kind: "append" as const },
      statementKind: "message" as const, continued: "auto" as const,
    };
    composerDrafts.set(draftUri, draft);
    const recoveredDraft = pendingTextRecoveries.findIndex((record) => record.owner === draft && record.id === `draft:${draftUri}`);
    if (recoveredDraft >= 0) {
      pendingTextRecoveries.splice(recoveredDraft, 1);
      refreshRecoveryStatus();
    }
    const runtime = new ComposerRuntime({
      requestDocument: async (params, signal) => {
        guiDocumentRequests += 1;
        const response = await sendRuntimeRequest("mmt/composerDocument", params, signal);
        if (import.meta.env.VITE_MMT_E2E === "1" && guiTextDelays.snapshotMs > 0) {
          await waitForTextFixture(guiTextDelays.snapshotMs, signal);
        }
        return response;
      },
      requestEdit: (params, signal) => {
        guiEditRequests += 1;
        return sendRuntimeRequest("mmt/composerEdit", params, signal);
      },
      applyEdit: (options) => {
        guiApplyAttempts += 1;
        return composerApply.apply(options);
      },
      currentDocument: (uri) => (
        textDocument.uri.toString() === uri
        && vscode.workspace.textDocuments.includes(textDocument)
          ? runtimeDocument
          : undefined
      ),
      isWorkspaceDocument: (candidate) => (
        candidate === runtimeDocument
        && textDocument.uri.scheme === WORKSPACE.scheme
        && textDocument.uri.authority === WORKSPACE.authority
      ),
      onDidChangeDocument: (listener) => vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === textDocument) listener({
          document: runtimeDocument,
          contentChanges: event.contentChanges,
          reason: event.reason,
        });
      }),
      getPackSpeakerReferences: () => packSpeakerOptions().map((option) => option.reference),
      onDidChangeCatalog: (listener) => galleryPacksChanged.event(listener),
      navigateSource: async (uri, range) => {
        const candidate = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri, true));
        await switchAuthoringMode(uri, "source");
        const editor = await vscode.window.showTextDocument(candidate, { preserveFocus: false });
        editor.selection = new vscode.Selection(range.start.line, range.start.character, range.end.line, range.end.character);
        editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      },
      openPreview: (uri) => openPreview(uri),
      showHistory: (uri) => vscode.commands.executeCommand("mmt.history.showFileHistory", vscode.Uri.parse(uri, true)),
      save: saveComposerDocument,
      exportExact: openProductExportPanel,
      notify: (kind, message) => {
        lastGuiNotification = `${kind}:${message}`;
        return showMomoScriptMessage(kind, message);
      },
    });
    const textSession = runtime.attachTextSession({
      geometry: textGeometry,
      currentGeometryIdentity: () => activeGuiRuntime === runtime ? currentTextGeometryBinding()?.identity : undefined,
      requestTextEdit: (params, signal) => {
        guiEditRequests += 1;
        return sendRuntimeRequest("mmt/composerEdit", params, signal);
      },
      applyTextEdit: (options) => {
        guiApplyAttempts += 1;
        return applyComposerTextEdit({
          ...options,
          modelService,
          canApply: (candidate) => provider?.coordinator.state.lease === "writer" && options.canApply(candidate),
        });
      },
      nativeHistory: (uri) => provider?.coordinator.state.lease === "writer"
        ? getComposerNativeHistory(modelService, uri)
        : undefined,
      // Native ClipboardService swallows permission failures; a cut needs a real rejection.
      writeClipboard: (text) => navigator.clipboard.writeText(text),
      readClipboard: () => vscode.env.clipboard.readText(),
      showContextMenu: async (request, signal) => {
        const labels = { cut: "剪切", copy: "复制", paste: "粘贴", delete: "删除所选文字", selectAll: "全选", undo: "撤销", redo: "重做" };
        const session = composerContextMenu.open(request.anchor, request.actions.map((action) => ({
          label: labels[action.id], enabled: action.enabled, selection: { kind: "text", action: action.id },
        })));
        const close = () => session.close();
        if (signal.aborted) close();
        else signal.addEventListener("abort", close, { once: true });
        try {
          const selected = await session.result;
          return !signal.aborted && selected?.kind === "text" ? selected.action : undefined;
        } finally {
          signal.removeEventListener("abort", close);
        }
      },
      navigateFocus: (backward) => composerOwners.get(sourceUri)?.ui?.focusFromCanvas(backward),
      sourceSelection: async (selection, snapshot, signal) => {
        const binding = currentTextGeometryBinding();
        if (!binding || binding.snapshot !== snapshot || activeGuiRuntime !== runtime) return undefined;
        const [anchor, focus] = await Promise.all([
          textGeometry.caret(selection.anchor, binding.identity, signal),
          textGeometry.caret(selection.focus, binding.identity, signal),
        ]);
        if (anchor.status !== "mapped" || focus.status !== "mapped") return undefined;
        return { anchor: anchor.authored.range.start, focus: focus.authored.range.start };
      },
      recover: (text, reason, recoveryId) => {
        const existing = pendingTextRecoveries.find((record) => record.owner === textSession && record.id === recoveryId);
        if (existing) {
          existing.text = text;
          existing.reason = reason;
          preparedTextRecoveries.delete(recoveryId);
          refreshRecoveryStatus();
          return;
        }
        pendingTextRecoveries.push({
          id: recoveryId,
          uri: sourceUri,
          owner: textSession,
          text,
          reason,
          resolve: (expectedText) => textSession.resolveRecovery(recoveryId, expectedText),
        });
        refreshRecoveryStatus();
        void showMomoScriptMessage("warning", reason, ["恢复未提交文字"], { id: "composer-input-recovery" })
          .then((choice) => choice === "恢复未提交文字" ? showInputRecovery() : undefined)
          .catch((error: unknown) => showMomoScriptMessage("error", error instanceof Error ? error.message : String(error)));
      },
      notify: (kind, message) => {
        lastGuiNotification = `${kind}:${message}`;
        return showMomoScriptMessage(kind, message);
      },
    });
    const textStateSubscription = textSession.onDidChangeState((state) => {
      publishComposerSessionState(runtime, state);
      for (const surface of previewSurfaceMounts) if (surface.runtime === runtime) surface.ui?.refresh();
    });
    const owner: ComposerDocumentOwner = { document: textDocument, modelReference, runtimeDocument, runtime, textSession, draft, textStateSubscription };
    composerOwners.set(sourceUri, owner);
    return owner;
  };
  const mountComposerSurface = async (
    { input, container, group }: Pick<ComposerEditorMountContext, "input" | "container" | "group">,
    presentation: "chat" | "layout",
  ): Promise<ComposerEditorMount> => {
    // A GUI pane has no native text-editor input to keep its canonical model alive.
    const modelReference = await modelResolverService.createModelReference(input.resource!);
    let owner: ComposerDocumentOwner;
    try {
      modeSwitchAbort.signal.throwIfAborted();
      const opened = await vscode.workspace.openTextDocument(vscode.Uri.parse(input.resource!.toString(), true));
      const textDocument = opened.languageId === "mmt" ? opened : await vscode.languages.setTextDocumentLanguage(opened, "mmt");
      modeSwitchAbort.signal.throwIfAborted();
      owner = getComposerOwner(textDocument, modelReference);
    } catch (error) {
      modelReference.dispose();
      throw error;
    }
    const textDocument = owner.document;
    const { runtimeDocument, runtime, textSession, draft } = owner;
    const draftUri = textDocument.uri.toString();
    authoringState(draftUri, input.typeId === COMPOSER_EDITOR_ID ? presentation : "source");
    let surface: PreviewSurfaceMount;
    const ui = new ComposerEditorUi(container, {
      runtime,
      draft,
      contextMenu: composerContextMenu,
      messageEditor: composerMessageEditor,
      newDocument: createComposerDocument,
      openDocument: chooseComposerDocument,
      mode: () => surface?.presentation === "chat" ? "chat" : surface?.presentation === "layout" ? "layout" : presentation,
      switchMode: (mode) => switchAuthoringMode(draftUri, mode),
      canvasResize: (width) => resizeChatCanvas(draftUri, width),
      downloadSource: () => downloadComposerSource(draftUri),
      defaultExportFormat,
      exportDetails: () => {
        const artifact = controller.stores.previewArtifacts.document(draftUri).displayedArtifact;
        return {
          state: exactExportUi.state,
          pages: artifact?.renderPreset.kind === "output" ? artifact.pages.map((page) => ({
            index: page.pageIndex, width: page.geometry.viewBox[2], height: page.geometry.viewBox[3],
          })) : [],
          fontNames: loadedPreviewFontNames,
          draftPending: draft.body.length > 0,
        };
      },
      exportDocument: async (format, options) => {
        await exportExactSnapshot(draftUri, format, options);
      },
      cancelExport: () => { exactExportUi.cancel(); },
      openDocumentSettings: async () => { await vscode.commands.executeCommand("mmt.document.configure", textDocument.uri); },
      saveState: () => {
        const state = authoringState(draftUri);
        if (state.saving || state.persisting) return { kind: "saving" as const };
        if (state.saveError) return { kind: "error" as const, message: state.saveError };
        return { kind: textDocument.isDirty ? "unsaved" as const : "saved" as const };
      },
      packSpeakers: packSpeakerOptions,
      avatarCatalog: () => buildAvatarCatalog(galleryPacks),
      avatarThumbnail: (item, signal) => composerGalleryImages.avatarThumbnail(item, signal),
      personThumbnail: async (form, signal) => {
        signal.throwIfAborted();
        const avatar = galleryAvatarUrl(form.pack, form.entity);
        if (avatar) return avatar.href;
        const preferred = form.stickerSets.find((set) => set.key === form.entity.stickerDefault
          && set.contributionNamespace === form.pack.namespace && set.variants.length > 0);
        const set = preferred ?? form.stickerSets.find((candidate) => candidate.variants.length > 0);
        const variant = set?.variants[0];
        return set && variant ? composerGalleryImages.thumbnail(form.pack, form.entity, set, variant, signal) : undefined;
      },
      stickerPeople: () => buildGalleryPersonGroups(galleryPacks),
      stickerThumbnail: (form, set, variant, signal) => composerGalleryImages.thumbnail(form.pack, form.entity, set, variant, signal),
      importLocalImage: () => {
        const storage = provider;
        if (!storage) return Promise.reject(new Error("工作区不可用，未导入图片。"));
        const documents = new Map(vscode.workspace.textDocuments
          .filter((candidate) => candidate.uri.scheme === WORKSPACE.scheme && candidate.uri.authority === WORKSPACE.authority)
          .map((candidate) => [candidate, candidate.version] as const));
        return importComposerLocalImage(textDocument.uri, WORKSPACE, storage, () => (
          controller.acceptingWork && storage.coordinator.state.lease === "writer"
          && activePreviewSurface?.runtime === runtime && activePreviewSurface.document === textDocument
        ), () => {
          if (!controller.acceptingWork || provider !== storage || storage.coordinator.state.lease !== "writer") return false;
          const current = vscode.workspace.textDocuments.filter((candidate) => (
            candidate.uri.scheme === WORKSPACE.scheme && candidate.uri.authority === WORKSPACE.authority
          ));
          return current.length === documents.size && current.every((candidate) => documents.get(candidate) === candidate.version);
        }, modeSwitchAbort.signal);
      },
      textRecoveries: () => pendingTextRecoveries.filter((record) => record.uri === draftUri).map((record) => ({
        id: record.id, text: record.text, reason: record.reason, requiresTargetConfirmation: true as const,
      })),
      copyTextRecovery: async (id) => { await navigator.clipboard.writeText(recoveryForUri(draftUri, id).text); },
      prepareTextRecovery: (id) => prepareTextRecovery(draftUri, id),
      retryTextRecovery: (id, confirmation) => retryTextRecovery(draftUri, id, confirmation),
      discardTextRecovery: (id) => {
        const record = recoveryForUri(draftUri, id);
        if (!resolveTextRecovery(record, record.text)) throw new Error("请先处理同一正文会话中较早的未提交文字。");
      },
      diagnosticsCount: () => vscode.languages.getDiagnostics(textDocument.uri).length,
      openProblems: () => vscode.commands.executeCommand("workbench.actions.view.problems"),
      documentLabel: () => workTitle(textDocument.uri),
      isDirty: () => textDocument.isDirty,
      recover: (text, reason) => {
        textSession.requireRecoveryTargetSelection();
        const record = {
          id: crypto.randomUUID(), uri: draftUri, owner: draft, text, reason,
          resolve: (expectedText: string) => expectedText === text,
        };
        pendingTextRecoveries.push(record);
        refreshRecoveryStatus();
        void showMomoScriptMessage("warning", reason, ["恢复未提交文字"], { id: "composer-input-recovery" })
          .then((choice) => choice === "恢复未提交文字" ? showInputRecovery() : undefined);
      },
      focus: () => { void nativeEditorService.openEditor(input, { pinned: true }, group.id); },
      editText: async (node, offsetUtf16) => {
        if (await textSession.enter(node, offsetUtf16)) previewWebviewHost?.focusSurface(ui);
      },
    });
    container.querySelector<HTMLElement>(".mmt-composer-surface")!.dataset.resource = textDocument.uri.toString();
    const saveSubscription = vscode.workspace.onDidSaveTextDocument((saved) => {
      if (saved !== textDocument) return;
      authoringState(draftUri).saveError = undefined;
      ui.refresh();
    });
    surface = {
      input,
      document: textDocument,
      claimant: ui,
      container: ui.typesetContainer,
      clippingContainer: ui.clippingContainer,
      runtime,
      ui,
      presentation,
      visible: false,
      setActive: (active) => {
        if (active && previewSourcesReady && !runtime.state.bound) runtime.bindDocument(runtimeDocument);
        ui.setActive(active);
        if (active) owner.ui = ui;
      },
    };
    previewSurfaceMounts.add(surface);
    syncPreviewSurface();
    return {
      layout: () => { syncPreviewSurface(); previewWebviewHost?.layoutSurface(surface.claimant); },
      setVisible: (visible) => { surface.visible = visible; syncPreviewSurface(); },
      dispose() {
        if (activePreviewSurface === surface) textSession.setActive(false);
        saveSubscription.dispose();
        previewSurfaceMounts.delete(surface);
        previewWebviewHost?.releaseSurface(surface.claimant);
        ui.dispose();
        if (owner.ui === ui) owner.ui = undefined;
        syncPreviewSurface();
      },
    };
  };
  own(composerEditorSurfaces.setMountHandler((context) => {
    const sourceUri = context.input.resource!.toString();
    const state = authoringState(sourceUri, "chat");
    const pending = mountComposerSurface(context, state.mode === "layout" ? "layout" : "chat");
    composerMounting.set(sourceUri, pending);
    return pending;
  }));
  let canvasContextAbort: AbortController | undefined;
  own({ dispose() { canvasContextAbort?.abort(); } });
  const handleCanvasContext = async (
    point: PreviewNavigationPoint,
    anchor: PreviewContextMenuAnchor,
    trigger: "select" | "menu",
  ): Promise<void> => {
    canvasContextAbort?.abort();
    const surface = activePreviewSurface;
    const runtime = surface?.runtime;
    const ui = surface?.ui;
    if (!runtime || !ui) {
      if (trigger === "menu") await previewComposer?.handleContextPoint(point, anchor);
      return;
    }
    previewComposer?.invalidate();
    runtime.selectNode(null);
    const requestedBinding = currentTextGeometryBinding();
    const operation = new AbortController();
    canvasContextAbort = operation;
    const surfaceCurrent = () => !operation.signal.aborted && controller.acceptingWork
      && activePreviewSurface === surface && activeGuiRuntime === runtime;
    let current = surfaceCurrent;
    let pause: { dispose(): void } | undefined;
    try {
      const session = runtime.textSession;
      await session?.waitForCompositionEnd();
      if (!surfaceCurrent()) return;
      pause = session?.pauseInput();
      await session?.drainAccepted();
      if (!surfaceCurrent()) return;
      session?.invalidate("已切换到内容块选择，请重新点击正文以继续文字编辑。");
      const binding = currentTextGeometryBinding();
      const identity = runtime.captureIdentity();
      const snapshot = runtime.state.snapshot;
      if (!requestedBinding || !binding || !identity || !snapshot || binding.snapshot !== snapshot
        || binding.snapshot !== requestedBinding.snapshot
        || binding.identity.renderKey !== requestedBinding.identity.renderKey
        || binding.identity.sessionId !== requestedBinding.identity.sessionId
        || binding.identity.generation !== requestedBinding.identity.generation) return;
      current = () => {
        const latest = currentTextGeometryBinding();
        const source = runtime.captureIdentity();
        return surfaceCurrent()
          && latest?.snapshot === snapshot && latest.identity.renderKey === binding.identity.renderKey
          && latest.identity.sessionId === binding.identity.sessionId && latest.identity.generation === binding.identity.generation
          && source?.generation === identity.generation && source.version === identity.version
          && source.sourceDigest === identity.sourceDigest && source.catalogEpoch === identity.catalogEpoch;
      };
      const located = await previewInteraction.locatePreviewPoint(point, operation.signal);
      if (!located || !current() || located.identity.sourceUri !== identity.uri
        || located.identity.sourceStaleToken.documentVersion !== identity.version) return;
      const target = parsePreviewComposerTargetResult(await sendRuntimeRequest("mmt/previewComposerTarget", {
        sourceUri: located.identity.sourceUri, revision: located.identity.revision,
        sourceContent: located.identity.sourceContent, projectDigest: located.identity.projectDigest,
        projectionKey: located.identity.projectionKey, entryUri: located.identity.entryUri,
        backendEncoding: located.identity.backendEncoding, location: located.location,
      }, operation.signal));
      if (!current()) return;
      let node = target.kind === "Editable" && target.textDocument.uri === identity.uri && target.textDocument.version === identity.version
        ? snapshot.nodes.find((candidate) => candidate.kind !== "opaque"
          && candidate.statementRange.start.line === target.target.range.start.line
          && candidate.statementRange.start.character === target.target.range.start.character
          && candidate.statementRange.end.line === target.target.range.end.line
          && candidate.statementRange.end.character === target.target.range.end.character)
        : undefined;
      if (!node && target.kind === "Unavailable" && target.reason === "unsupportedNode") {
        const mapped = parsePreviewSourceTargets(await sendRuntimeRequest("mmt/mapTypstReadLocations", {
          sourceUri: located.identity.sourceUri, revision: located.identity.revision,
          sourceContent: located.identity.sourceContent, projectDigest: located.identity.projectDigest,
          projectionKey: located.identity.projectionKey, entryUri: located.identity.entryUri,
          backendEncoding: located.identity.backendEncoding, locations: [located.location],
        }, operation.signal));
        if (!current()) return;
        const authored = mapped.filter((candidate) => candidate.kind === "authoredIdentity" && candidate.uri === identity.uri && candidate.range);
        if (authored.length !== 1) return;
        const source = identity.documentIncarnation;
        const start = source.offsetAt(authored[0]!.range!.start);
        const end = source.offsetAt(authored[0]!.range!.end);
        const candidates = snapshot.nodes.filter((candidate) => source.offsetAt(candidate.range.start) <= start
          && start < source.offsetAt(candidate.range.end) && end <= source.offsetAt(candidate.range.end));
        if (candidates.length === 1) node = candidates[0];
      }
      if (!node || !current()) return;
      runtime.selectNode(node.nodeKey);
      if (trigger === "menu") await ui.openNodeContext(node, anchor);
    } catch (error) {
      if (current()) void showMomoScriptMessage("warning", error instanceof Error ? error.message : "无法选择此排版内容。");
    } finally {
      pause?.dispose();
    }
  };
  previewComposer = own(new PreviewComposerController({
    locatePreviewPoint: (point, signal) => previewInteraction.locatePreviewPoint(point, signal),
    request: sendComposerRequest,
    createCancellationTokenSource: () => new vscode.CancellationTokenSource(),
    contextMenu: composerContextMenu,
    contextInput: composerContextInput,
    messageEditor: composerMessageEditor,
    avatarPicker: composerAvatarPicker,
    getAvatarCatalog: () => buildAvatarCatalog(galleryPacks),
    onDidChangeAvatarCatalog: (listener) => galleryPacksChanged.event(listener),
    apply: composerApply,
    acceptingWork: () => controller.acceptingWork && activeClient !== undefined,
    currentIdentity: () => {
      const identity = previewInteraction.identity;
      return identity?.sourceUri === displayedPreviewSourceUri ? identity : undefined;
    },
    currentDocument: (uri) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === uri,
      );
      return document
        ? { uri: document.uri.toString(), version: document.version }
        : undefined;
    },
    bidirectionalNavigation: () => (
      vscode.workspace.getConfiguration("mmt.preview").get("bidirectionalNavigation", true)
    ),
    navigatePreviewPoint: (point, signal) => previewInteraction.navigatePreviewPoint(point, signal),
    showWarningMessage: (message) => showMomoScriptMessage("warning", message),
    showErrorMessage: (message) => showMomoScriptMessage("error", message),
  }));
  const documentConfigCommandRegistration = subscribe(vscode.commands.registerCommand("mmt.document.configure", async (resource?: vscode.Uri) => {
    const document = resource
      ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === resource.toString())
      : vscode.window.activeTextEditor?.document ?? activePreviewSurface?.document;
    if (!document || document.languageId !== "mmt") {
      void showMomoScriptMessage("warning", "请先打开一个 MomoScript 文档。");
      return;
    }
    try {
      const sourceUri = document.uri.toString();
      const owner = composerOwners.get(sourceUri);
      await waitForNativeComposition(sourceUri);
      await owner?.ui?.prepareModeSwitch();
      await owner?.textSession.waitForCompositionEnd();
      await owner?.textSession.drainAccepted();
      if (!controller.acceptingWork || !vscode.workspace.textDocuments.includes(document)) {
        throw new Error("作品文档已关闭，未修改文档设置。");
      }
      if (!activeClient) throw new Error("MMT 语言服务器不可用");
      await configureDocumentSettings(document, activeClient);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log("document:error", detail);
      void showMomoScriptMessage("error", `文档设置失败：${detail}`);
    }
  }));
  previewWebviewHost = own(new PreviewWebviewHost({
    ready() {
      textBridgeReady = true;
      if (activeGuiRuntime) publishComposerSessionState(activeGuiRuntime);
      previewWebviewHost?.postExactExportState(exactExportUi.state);
    },
    viewportChanged(viewport, renderKey, presentation) {
      if (previewInteraction.artifact?.renderKey !== renderKey || previewInteraction.presentation !== presentation) return;
      previewInteraction.updateViewport(viewport, presentation);
    },
    async navigationRequested(point) {
      if (!vscode.workspace.getConfiguration("mmt.preview").get("bidirectionalNavigation", true)) return;
      await previewInteraction.navigatePreviewPoint(point);
    },
    contextMenuRequested(point, anchor, trigger) {
      composerE2E?.recordContextAnchor(anchor);
      return handleCanvasContext(point, anchor, trigger);
    },
    composerIntent(message, admitted) {
      const session = textSessionRoutes.get(message.sessionId);
      if (!session) return;
      if (controller.acceptingWork && session === activeGuiRuntime?.textSession
        && session.isActive && session.state.sessionId === message.sessionId) {
        session.handleIntent(message, admitted);
      } else {
        session.recoverRetiredIntent(message);
      }
    },
    composerDrained(sessionId) {
      const session = textSessionRoutes.get(sessionId);
      session?.acknowledgeDrained(sessionId);
      textSessionRoutes.delete(sessionId);
      for (const check of textDrainWaiters) check();
    },
    async exactExportRequested(message: PreviewExactExportRequest) {
      if (!displayedPreviewSourceUri) return;
      await exportExactSnapshot(displayedPreviewSourceUri, message.format, {
        staleChoice: message.staleChoice, pageIndex: message.pageIndex,
      }, "snapshot-only");
    },
    exactExportCancelled() {
      exactExportUi.cancel();
    },
  }, {
    webviewService: nativeWebviewService,
    defaultExportFormat,
  }));
  own(previewHostSurfaces.setMountHandler(async (context) => {
    const { input, container, clippingContainer } = context;
    const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.parse(input.resource!.toString(), true));
    if (isComposerResource(sourceDocument.uri)) return mountComposerSurface(context, "layout");
    const surface: PreviewSurfaceMount = {
      input,
      document: sourceDocument,
      claimant: {},
      container,
      clippingContainer,
      presentation: "preview",
      visible: false,
    };
    previewSurfaceMounts.add(surface);
    syncPreviewSurface();
    return {
      layout: () => { syncPreviewSurface(); previewWebviewHost?.layoutSurface(surface.claimant); },
      setVisible: (visible) => { surface.visible = visible; syncPreviewSurface(); },
      dispose() {
        previewSurfaceMounts.delete(surface);
        previewWebviewHost?.releaseSurface(surface.claimant);
        syncPreviewSurface();
      },
    };
  }));
  syncPreviewSurface();
  async function bindPreviewSource(document: vscode.TextDocument): Promise<void> {
    const sourceUri = document.uri.toString();
    previewComposer?.invalidate();
    previewFixtureActiveSourceUri = undefined;
    displayedPreviewSourceUri = sourceUri;
    refreshBuildStatus();
    exactExportUi.bind(sourceUri);
    if (!previewWebviewHost) throw new Error("Preview Webview host is unavailable");
    log("preview", `Opening ${sourceUri}`);
    if (document.languageId === "typst") {
      previewWebviewHost.postStatus("正在准备 Typst 预览…", false);
      const project = await buildTypstProject(document, typstRevisions);
      if (previewFixtureActiveSourceUri === sourceUri || displayedPreviewSourceUri !== sourceUri) return;
      typstProjects.set(sourceUri, project);
      syncTinymistProject(project);
      await dispatchTypstPreview(project, document, true);
      return;
    }
    if (!activeClient) {
      const message = "MomoScript 语言服务器不可用；Typst 编辑与语言服务仍可继续使用。";
      previewWebviewHost.postStatus(message, true);
      const error = new Error(message);
      latestArtifactWaiter.failSource(sourceUri, error);
      throw error;
    }
    previewWebviewHost.postStatus("正在加载画面…", false);
    let project: TypstProjectUpdate | null;
    try {
      project = await waitForSynchronizedLanguageProjection(
        () => activeClient.sendRequest<TypstProjectUpdate | null>("mmt/getTypstProject", { uri: sourceUri }),
        document.version
      );
    } catch (error) {
      if (displayedPreviewSourceUri !== sourceUri) return;
      const detail = error instanceof Error ? error.message : String(error);
      const message = `无法为 ${document.fileName} 构建 Typst 投影：${detail}`;
      previewWebviewHost.postStatus(message, true);
      log("preview:error", message);
      const failure = new Error(message, { cause: error });
      latestArtifactWaiter.failSource(sourceUri, failure);
      throw failure;
    }
    if (displayedPreviewSourceUri !== sourceUri) return;
    if (!project) {
      const message = `语言服务器未能及时同步 ${document.fileName} 的文档版本 ${document.version}。`;
      previewWebviewHost.postStatus(message, true);
      log("preview:error", message);
      const error = new Error(message);
      latestArtifactWaiter.failSource(sourceUri, error);
      throw error;
    }
    const tracked = trackLanguageProjection(project);
    if (!tracked) return;
    if (tracked.advanced) syncTinymistProject(project);
    await dispatchRenderProject(activeClient, project.sourceUri, tracked.token, true);
  }
  const previewCommandRegistration = subscribe(vscode.commands.registerCommand("mmt.preview.open", async (resource?: vscode.Uri) => {
    const sourceDocument = resource
      ? await vscode.workspace.openTextDocument(resource)
      : activePreviewSurface?.document ?? vscode.window.activeTextEditor?.document;
    if (!sourceDocument || !["mmt", "typst"].includes(sourceDocument.languageId)) {
      void showMomoScriptMessage("warning", "请先打开一个 MomoScript 或 Typst 文档，再启动预览。");
      return;
    }
    if (mobileComposerMedia.matches && isComposerResource(sourceDocument.uri)) {
      await switchAuthoringMode(sourceDocument.uri.toString(), "layout");
      return;
    }
    await revealPreviewSurface(sourceDocument.uri.toString());
    if (activePreviewSurface?.document === sourceDocument
      && previewInteraction.identity?.sourceStaleToken.documentVersion !== sourceDocument.version) {
      previewSourceBinding = bindPreviewSource(sourceDocument);
    }
    await previewSourceBinding;
  }));
  let autoOpeningPreviewUri: string | undefined;
  const maybeAutoOpenPreview = (editor: vscode.TextEditor | undefined): void => {
    if (!vscode.workspace.getConfiguration("mmt.preview").get<boolean>("openOnDocument", false)) return;
    if (!editor || editor.document.languageId !== "mmt") return;
    // Compact Source and canvas are full-screen alternatives. Automatic
    // preview must not replace an explicit or restored Source editor.
    if (mobileComposerMedia.matches) return;
    const sourceUri = editor.document.uri.toString();
    if (
      autoOpeningPreviewUri === sourceUri
      || (previewWebviewHost?.isOpen && displayedPreviewSourceUri === sourceUri)
    ) return;
    autoOpeningPreviewUri = sourceUri;
    void vscode.commands.executeCommand("mmt.preview.open", editor.document.uri).then(
      () => {
        if (autoOpeningPreviewUri === sourceUri) autoOpeningPreviewUri = undefined;
      },
      (error: unknown) => {
        if (autoOpeningPreviewUri === sourceUri) autoOpeningPreviewUri = undefined;
        log("preview:error", error instanceof Error ? error.message : String(error));
      },
    );
  };
  subscribe(vscode.window.onDidChangeActiveTextEditor(maybeAutoOpenPreview));
  maybeAutoOpenPreview(vscode.window.activeTextEditor);
  const openPreview = (sourceUri: string): PromiseLike<unknown> => (
    vscode.commands.executeCommand("mmt.preview.open", vscode.Uri.parse(sourceUri, true))
  );

  packCache = own(await IndexedDbPackCache.open());
  const syncConfiguredPackSources = async () => {
    if (!activeClient) {
      log("resources", "Skipped resource pack synchronization because the MomoScript language server is unavailable");
      return;
    }
    const configured = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_MANIFEST_URL]);
    const revision = Date.now();
    let packSources: PackManifestSource[];
    try {
      packSources = await synchronizePackSources(
        configured,
        revision,
        packCache!,
        (params) => activeClient.sendRequest("mmt/updatePackManifests", params),
        fetchManifest
      );
    } catch (error) {
      const fallbackRevision = revision + 1;
      try {
        const result = await activeClient.sendRequest<{ revision: number; updated: boolean }>(
          "mmt/updatePackManifests",
          { revision: fallbackRevision, sources: [] }
        );
        if (result.revision !== fallbackRevision || !result.updated) {
          throw new Error(`Empty pack registry update ${fallbackRevision} was not accepted`);
        }
        packSourcesByNamespace.clear();
        galleryPacks = [];
        galleryPacksChanged.fire();
      } catch (fallbackError) {
        throw new AggregateError(
          [error, fallbackError],
          `Resource pack synchronization and empty-registry fallback both failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      throw error;
    }
    const catalogResults = await Promise.all(packSources.map((source) => (
      loadGalleryEntityCatalog(source, revision, packCache!, fetchEntityCatalog)
    )));
    packSourcesByNamespace.clear();
    const projected: GalleryPack[] = [];
    for (const [index, source] of packSources.entries()) {
      const catalogResult = catalogResults[index];
      if (catalogResult?.warning) {
        log(
          "gallery:catalog",
          `${catalogResult.catalog ? "Using validated cached metadata" : "Using manifest fallback"} for ${source.manifestUrl}: ${catalogResult.warning}`
        );
      }
      try {
        projected.push(projectGalleryPack(source, catalogResult?.catalog));
      } catch (error) {
        log("gallery", `Skipped invalid gallery pack ${source.manifestUrl}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const manifest = JSON.parse(source.json) as { pack?: { namespace?: unknown } };
      const namespace = manifest.pack?.namespace;
      if (typeof namespace === "string" && namespace.length > 0) {
        packSourcesByNamespace.set(namespace, { ...source, cacheIdentity: await manifestCacheIdentity(source) });
      }
    }
    galleryPacks = projected;
    galleryPacksChanged.fire();
    log("resources", `Accepted ${packSources.length} resource pack manifests`);
  };
  try {
    await syncConfiguredPackSources();
  } catch (error) {
    void showMomoScriptMessage("warning", `MomoScript resource packs are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  previewSourcesReady = true;
  syncPreviewSurface();
  const packConfigRegistration = subscribe(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("mmt.resourcePacks.manifestUrls")) return;
    const values = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_MANIFEST_URL]);
    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Resource pack manifest URLs"]');
    if (input) input.value = values.join("\n");
    void syncConfiguredPackSources().catch((error: unknown) => {
      void showMomoScriptMessage("warning", `MomoScript resource packs are unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  }));
  const previewConfigRegistration = subscribe(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("mmt.preview.debounceMs")) {
      previewRenderQueue.setDebounceMs(
        vscode.workspace.getConfiguration("mmt.preview").get<number>("debounceMs", 50),
      );
    }
    if (event.affectsConfiguration("mmt.preview.openOnDocument")) {
      maybeAutoOpenPreview(vscode.window.activeTextEditor);
    }
    if (!event.affectsConfiguration("mmt.preview.onChange") || !previewOnChange()) return;
    const sourceUri = vscode.window.activeTextEditor?.document.uri.toString();
    const token = sourceUri ? latestLanguageProjectionBySource.get(sourceUri) : undefined;
    if (!sourceUri || !token) return;
    if (activeClient) void schedulePreviewIfEnabled(activeClient, sourceUri, token).catch((error: unknown) => {
      log("preview:error", error instanceof Error ? error.message : String(error));
    });
  }));
  const packUrls = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_MANIFEST_URL]);
  const packUrlsInput = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Resource pack manifest URLs"]');
  if (packUrlsInput) packUrlsInput.value = packUrls.join("\n");

  await nativeEditorGroupsService.whenRestored;
  const workbenchRestoredEditor = nativeEditorService.activeEditor !== undefined;
  const restoredActiveDocument = workbenchRestoredEditor || await restoreActiveWorkspaceDocument();
  if (!restoredActiveDocument && !nativeEditorService.activeEditor) {
    await openComposerDocument(STORY);
  }
  const markerModelRegistrations: vscode.Disposable[] = [];
  const bindMarkerEditing = (model: ReturnType<IModelService["getModels"]>[number]) => {
    if (model.uri.scheme !== "mmtfs" || !model.uri.path.endsWith(".mmt") && !model.uri.path.endsWith(".mmt.txt")) return;
    markerModelRegistrations.push(model.onDidChangeContent((event) => {
      const ranges = event.changes.flatMap((change) => {
        const range = change.range;
        if (change.text !== ":") return [];
        const line = model.getLineContent(range.startLineNumber);
        return range.startColumn >= 2 && line.slice(range.startColumn - 2, range.startColumn + 1) === "[:]" ? [range] : [];
      });
      if (ranges.length === 0) return;
      const focused = codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor();
      const editor = focused?.getModel() === model
        ? focused
        : codeEditorService.listCodeEditors().find((candidate) => candidate.getModel() === model);
      if (!editor) return;
      editor.executeEdits("mmt-resource-marker", ranges.map((range) => ({
        range: {
          startLineNumber: range.startLineNumber,
          startColumn: range.startColumn + 1,
          endLineNumber: range.startLineNumber,
          endColumn: range.startColumn + 2
        },
        text: ":]"
      })));
      editor.setSelections(ranges.map((range) => ({
        selectionStartLineNumber: range.startLineNumber,
        selectionStartColumn: range.startColumn + 1,
        positionLineNumber: range.startLineNumber,
        positionColumn: range.startColumn + 1
      })));
    }));
  };
  modelService.getModels().forEach(bindMarkerEditing);
  const markerModelRegistration = subscribe(modelService.onModelAdded(bindMarkerEditing));
  const markerEditingRegistration = subscribe<vscode.Disposable>({
    dispose() {
      markerModelRegistration.dispose();
      markerModelRegistrations.splice(0).forEach((registration) => registration.dispose());
    }
  });
  const pendingPersistenceByUri = new Map<string, {
    readonly documentUri: vscode.Uri;
    readonly documentPath: string;
    readonly languageId: string;
    readonly text: string;
    readonly documentVersion: number;
  }>();
  const persistenceDebounce = () => new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  const schedulePersistence = (uri: string): void => {
    if (persistenceByUri.has(uri)) return;
    const next = (async () => {
      await persistenceDebounce();
      while (true) {
        const snapshot = pendingPersistenceByUri.get(uri);
        if (!snapshot) return;
        pendingPersistenceByUri.delete(uri);
        const state = authoringState(uri);
        state.persisting = true;
        state.saveError = undefined;
        for (const surface of previewSurfaceMounts) if (surface.document.uri.toString() === uri) surface.ui?.refresh();
        try {
          await vscode.workspace.fs.writeFile(snapshot.documentUri, encoder.encode(snapshot.text));
        } catch (error) {
          state.saveError = error instanceof Error ? error.message : String(error);
          throw error;
        } finally {
          state.persisting = false;
          for (const surface of previewSurfaceMounts) if (surface.document.uri.toString() === uri) surface.ui?.refresh();
        }
        log("document", `Saved ${snapshot.documentPath}`);
        if (snapshot.languageId === "mmt") {
          await persistenceDebounce();
          if (pendingPersistenceByUri.has(uri)) continue;
          const client = activeClient;
          if (client) {
            const current = await waitForSynchronizedLanguageProjection(
              () => client.sendRequest<TypstProjectUpdate | null>("mmt/getTypstProject", { uri }),
              snapshot.documentVersion
            );
            if (current) {
              const tracked = trackLanguageProjection(current);
              if (tracked) {
                if (tracked.advanced) syncTinymistProject(current);
                await schedulePreviewIfEnabled(client, current.sourceUri, tracked.token);
              }
            }
          }
        }
        if (!pendingPersistenceByUri.has(uri)) return;
        await persistenceDebounce();
      }
    })().catch((error: unknown) => {
      const snapshot = pendingPersistenceByUri.get(uri);
      log("document:error", `${snapshot?.documentPath ?? uri}: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (persistenceByUri.get(uri) === next) persistenceByUri.delete(uri);
      if (pendingPersistenceByUri.has(uri)) schedulePersistence(uri);
    });
    persistenceByUri.set(uri, next);
  };
  const documentPersistenceRegistration = subscribe(vscode.workspace.onDidChangeTextDocument((event) => {
    if (!controller.acceptingWork) return;
    const document = event.document;
    if ((document.languageId !== "mmt" && document.languageId !== "typst")
      || document.uri.scheme !== "mmtfs" || document.uri.authority !== "workspace") return;
    const uri = document.uri.toString();
    pendingPersistenceByUri.set(uri, {
      documentUri: document.uri,
      documentPath: document.uri.path,
      languageId: document.languageId,
      documentVersion: document.version,
      text: document.getText(),
    });
    schedulePersistence(uri);
  }));
  document.documentElement.dataset.mmtStage = "mmt-ready";
  startupProgress.ready();
  document.documentElement.dataset.mmtLanguageId = vscode.window.activeTextEditor?.document.languageId ?? "";
  document.documentElement.dataset.mmtWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "";
  const typstDocumentChangeRegistration = subscribe(vscode.workspace.onDidChangeTextDocument((event) => {
    if (!controller.acceptingWork) return;
    void recognizeAndSyncTypst(event.document, true).then(async (project) => {
      if (!project) return;
      const sourceUri = event.document.uri.toString();
      typstProjects.set(sourceUri, project);
      if (displayedPreviewSourceUri === sourceUri) {
        await dispatchTypstPreview(project, event.document, false);
      }
    }).catch((error: unknown) => log("preview:error", `Typst: ${error instanceof Error ? error.message : String(error)}`));
  }));
  const safeRestart = new PwaSafeRestartQuiesceAdapter({
    pauseNewWork() {
      const pausedInputs = [...previewSurfaceMounts].flatMap((surface) => {
        const paused = surface.runtime?.textSession?.pauseInput();
        return paused ? [paused] : [];
      });
      const resume = controller.pauseNewWork();
      return () => {
        resume();
        for (const paused of pausedInputs) paused.dispose();
      };
    },
    requireWriter() {
      if (provider?.coordinator.state.lease !== "writer") throw new Error("Safe restart requires the workspace writer lease");
    },
    async assertWorkspaceSafe(signal) {
      await Promise.all([...previewSurfaceMounts].map((surface) => surface.runtime?.textSession?.prepareToLeave(signal)));
      await waitForTextChannelDrain(signal);
      for (const surface of previewSurfaceMounts) surface.ui?.prepareToLeave();
      for (const [uri, draft] of composerDrafts) {
        if (draft.body.length === 0 || pendingTextRecoveries.some((record) => record.id === `draft:${uri}`)) continue;
        composerOwners.get(uri)?.textSession.requireRecoveryTargetSelection();
        pendingTextRecoveries.push({
          id: `draft:${uri}`, uri, owner: draft, get text() { return draft.body; },
          reason: "重启前请先处理尚未发送的新消息草稿。",
          resolve: (expectedText) => {
            if (draft.body !== expectedText) return false;
            draft.body = "";
            for (const surface of previewSurfaceMounts) surface.ui?.refresh();
            return true;
          },
        });
      }
      refreshRecoveryStatus();
      if (pendingTextRecoveries.length > 0) throw new Error("请先复制或丢弃未提交文字，再安全重启");
      const state = provider?.coordinator.state;
      if (!state) throw new Error("Workspace is unavailable");
      if (state.blocked || state.pendingJournalIds.length > 0 || state.metadata.storage.pendingJournal) {
        throw new Error("Safe restart is blocked by a pending workspace journal");
      }
      if (state.metadata.storage.quotaBlocked) throw new Error("Safe restart is blocked by workspace quota/history state");
      if (state.metadata.storage.historyDegraded && state.metadata.storage.unreconciled) {
        throw new Error("Safe restart is blocked until workspace history is reconciled");
      }
      if (state.metadata.migration.state !== "complete") throw new Error("Safe restart is blocked by incomplete workspace migration");
    },
    async flushDurableState() {
      for (const document of new Set([...previewSurfaceMounts].map((surface) => surface.document))) {
        if (document.isDirty && !await document.save()) throw new Error("无法保存 GUI 文档，已取消安全重启");
      }
      await Promise.all([...persistenceByUri.values()]);
      await nativeStorageService.flush();
      await provider!.coordinator.flush();
    },
    async abortAndDrainRuntimeWork() {
      await controller.prepareForQuiesce();
    },
    async persistRecoveryMetadata() {
      sessionStorage.setItem("momoscript.safe-restart.v1", JSON.stringify({
        sourceUri: vscode.window.activeTextEditor?.document.uri.toString() ?? null,
        workspaceUri: vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? null,
      }));
    },
    runtime: controller,
  });
  if (import.meta.env.VITE_MMT_E2E === "1") {
    if (!composerE2E) throw new Error("Composer E2E instrumentation is unavailable");
    const composerEditorState = (name: string) => {
      if (!/^[^./\\][^/\\]*\.mmt(?:\.txt)?$/u.test(name)) throw new Error("invalid MMT workspace basename");
      const resource = vscode.Uri.joinPath(WORKSPACE, name);
      const uri = resource.toString();
      const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
      return {
        uri,
        guiVisible: [...document.querySelectorAll<HTMLElement>(".mmt-composer-editor [data-resource]")]
          .some((surface) => surface.dataset.resource === uri && surface.offsetParent !== null),
        sourceVisible: vscode.window.activeTextEditor?.document.uri.toString() === uri,
        textDocumentCount: vscode.workspace.textDocuments.filter((candidate) => candidate.uri.toString() === uri).length,
        modelCount: modelService.getModels().filter((model) => model.uri.toString() === uri).length,
        isPreview: activeTab?.isPreview ?? false,
        isPinned: activeTab?.isPinned ?? false,
      };
    };
    const openComposerGui = async (name: string) => {
      const resource = vscode.Uri.joinPath(WORKSPACE, name);
      await vscode.commands.executeCommand("mmt.composer.open", resource);
      return composerEditorState(name);
    };
    const openComposerSource = async (name: string) => {
      const resource = vscode.Uri.joinPath(WORKSPACE, name);
      const textDocument = await vscode.workspace.openTextDocument(resource);
      await vscode.window.showTextDocument(textDocument);
      return composerEditorState(name);
    };
    const keepComposerEditor = async (name: string) => {
      await vscode.commands.executeCommand("workbench.action.keepEditor");
      await vscode.commands.executeCommand("workbench.action.pinEditor");
      return composerEditorState(name);
    };
    const e2eApi: MmtE2EApi = {
      workspace: createMmtE2EWorkspaceApi({
        workspaceUri: WORKSPACE,
        storyUri: STORY,
        encoder,
        async deleteFile(name: string) {
          if (!/^[^./\\][^/\\]*$/.test(name) || name === "..") throw new Error("invalid workspace basename");
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(WORKSPACE, name));
        },
      }),
      language: createMmtE2ELanguageApi({
        workspaceUri: WORKSPACE,
        storyUri: STORY,
        backend: () => tinymist?.backend,
        projectionEntry: languageProjectionEntry,
        latestProjectionRevision,
        syncWorkspaceTypst,
      }),
      preview: {
        displayedSourceUri: () => displayedPreviewSourceUri,
        open: openPreview,
        buildDiagnostics: (sourceUri: string) => previewBuildState.diagnostics(sourceUri),
        interactionFixture: previewInteractionFixture,
        readiness: previewReadiness,
        retainedState: () => ({
          timingSamples: controller.stores.previewPerformance.size,
          previewProjects: previewProjects.size,
          latestProjects: latestProjectBySource.size,
          artifacts: controller.stores.previewArtifacts.size,
          artifactBytes: controller.stores.previewArtifacts.byteSize,
          mappedShadows: preview.mappedShadowCount,
          pendingMaterializations: pendingMaterializations.size,
          activeMaterializations: materializationControllers.size,
        }),
        timings: () => controller.stores.previewPerformance.snapshot(),
        resetTimings: () => controller.stores.previewPerformance.reset(),
        setRendererEnabled: setPreviewRendererEnabled,
      },
      composer: {
        ...composerE2E.api,
        openGui: openComposerGui,
        openSource: openComposerSource,
        keepEditor: keepComposerEditor,
        editorState: composerEditorState,
        deserializeEditor: (serializedEditor: string) => deserializeComposerEditorResource(serializedEditor)?.toString() ?? null,
        openResource: async (uri: string) => {
          try {
            await vscode.commands.executeCommand("mmt.composer.open", vscode.Uri.parse(uri, true));
            return null;
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
      },
      gui: {
        state: () => {
          const state = activeGuiRuntime?.state;
          return {
            uri: state?.bound?.uri ?? null,
            version: state?.bound?.version ?? null,
            sourceDigest: state?.snapshot?.sourceDigest ?? null,
            nodeKinds: state?.snapshot?.nodes.map((node) => node.kind) ?? [],
            pending: state?.pending ?? false,
            documentRequests: guiDocumentRequests,
            editRequests: guiEditRequests,
            applyAttempts: guiApplyAttempts,
            lastNotification: lastGuiNotification,
          };
        },
        textState: () => {
          const runtimeState = activeGuiRuntime?.state;
          const session = activeGuiRuntime?.textSession;
          const bodies = runtimeState?.snapshot?.nodes.filter((node) => node.kind !== "opaque") ?? [];
          const selection = session?.selection;
          const anchorIndex = selection ? bodies.findIndex((node) => node.nodeKey === selection.anchor.node.nodeKey) : -1;
          const focusIndex = selection ? bodies.findIndex((node) => node.nodeKey === selection.focus.node.nodeKey) : -1;
          const candidate = displayedRendererCandidate?.sourceUri === runtimeState?.bound?.uri ? displayedRendererCandidate : undefined;
          return {
            bodies: bodies.map((node) => ({
              kind: node.kind,
              nodeKey: node.nodeKey,
              text: node.textEditing?.text ?? null,
              statementRange: node.statementRange,
              resolvedMode: node.body.resolvedMode,
            })),
            selection: selection && anchorIndex >= 0 && focusIndex >= 0 ? {
              anchor: { bodyIndex: anchorIndex, offsetUtf16: selection.anchor.offsetUtf16 },
              focus: { bodyIndex: focusIndex, offsetUtf16: selection.focus.offsetUtf16 },
            } : null,
            sessionId: session?.state.sessionId ?? null,
            status: session?.state.status ?? "blocked",
            recoveryText: session?.recoveryText ?? "",
            pendingIntentCount: session?.pendingIntentCount ?? 0,
            alternativeVersionId: runtimeState?.bound
              ? getComposerNativeHistory(modelService, runtimeState.bound.uri)?.getAlternativeVersionId() ?? null
              : null,
            rendererSessionId: candidate?.sessionId ?? null,
            rendererGeneration: candidate?.ready.generation ?? null,
            renderKey: session?.state.renderKey || null,
            carets: session?.state.carets ?? [],
            boxes: session?.state.boxes ?? [],
          };
        },
        setTextDelays: (delays) => {
          if (!delays || typeof delays !== "object" || Array.isArray(delays)
            || Object.keys(delays).sort().join(",") !== "compileMs,snapshotMs"
            || ![delays.snapshotMs, delays.compileMs].every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 10_000)) {
            throw new RangeError("Invalid Composer response delay fixture");
          }
          guiTextDelays = { snapshotMs: delays.snapshotMs, compileMs: delays.compileMs };
        },
      },
      notifications: {
        showUpdatePrompt() {
          void showMomoScriptMessage(
            "info",
            `MomoScript 新构建 e2e-build 已准备好离线更新。当前构建 ${MMT_BUILD_VERSION}；保存并安全重启以启用新版本。`,
            ["安全更新并重启"],
            { id: "pwa-update-ready-e2e" },
          );
        },
      },
      runtime: {
        status: () => runtimeStatus.snapshot(),
        statusFixture: (recoveryState: RuntimeRecoveryState, lastFailure?: string) => {
          publishRuntimeStatus("e2e-fixture", recoveryState, lastFailure);
        },
        pwaSafeRestart: safeRestart,
      },
      history: {
        createCheckpoint: (name: string) => provider!.createCheckpoint(name),
        usage: () => provider!.historyUsage(),
        setLimits: (maxSnapshots: number, maxSizeMb: number) => (
          provider!.setHistoryLimits(normalizeHistoryLimits({ maxSnapshots, maxSizeMb }))
        ),
      },
      exactExport: {
        fixture: exactExportFixture,
      },
      security: {
        sanitizeSvg(svg: string) {
          const root = new DOMParser().parseFromString(svg, "text/html").querySelector("svg");
          if (!(root instanceof SVGSVGElement)) throw new Error("E2E SVG sanitizer input has no SVG root");
          sanitizeSvg(root);
          return root.outerHTML;
        },
      },
    };
    subscribe(installMmtE2EBridge(e2eApi));
  }
  if (import.meta.env.PROD && (import.meta.env.VITE_MMT_E2E !== "1" || import.meta.env.VITE_MMT_PWA_E2E === "1")) {
    pwaUpdateLifecycle = own(registerPwaUpdateLifecycle({
      prepareForReload: () => safeRestart.prepareForReload(10_000),
      async promptForReload(latestBuildVersion) {
        const update = "安全更新并重启";
        const nextVersion = latestBuildVersion ?? "版本信息暂不可用";
        return await showMomoScriptMessage(
          "info",
          `MomoScript 新构建 ${nextVersion} 已准备好离线更新。当前构建 ${MMT_BUILD_VERSION}；保存并安全重启以启用新版本。`,
          [update],
          { id: "pwa-update-ready" },
        ) === update;
      },
      report(message, error, reportOptions) {
        const detail = error instanceof Error ? error.message : String(error ?? "");
        log("pwa:update", `${message}${detail ? `: ${detail}` : ""}`);
        if (error && reportOptions?.userVisible !== false) {
          void showMomoScriptMessage("error", `${message}: ${detail}`);
        }
      },
    }));
  }
  let controllerDisposal: Promise<void> | undefined;
  const controllerDispose = (): Promise<void> => {
    if (controllerDisposal) return controllerDisposal;
    const disposal = (async () => {
      recordE2ELifecycle("dispose-invoked", lifecycleGeneration);
      await controller.dispose(750, () => recordE2ELifecycle("hmr-fallback", lifecycleGeneration));
      if (controller.stores.previewArtifacts.size === 0) {
        recordE2ELifecycle("retained-artifacts-cleared", lifecycleGeneration);
      }
      recordE2ELifecycle("dispose-complete", lifecycleGeneration);
    })();
    controllerDisposal = disposal;
    return disposal;
  };
  const hotDispose = () => {
    recordE2ELifecycle("hmr", lifecycleGeneration);
    const disposal = controllerDispose();
    Reflect.set(globalThis, "__mmtHmrDisposal", disposal);
    void disposal;
  };
  const hot = import.meta.hot;
  hot?.dispose(hotDispose);
  if (import.meta.hot) import.meta.hot.accept();
  let terminatedForUnload = false;
  const terminateForUnload = () => {
    if (terminatedForUnload) return;
    terminatedForUnload = true;
    recordE2ELifecycle("unload", lifecycleGeneration);
    controller.terminateAndDispose();
  };
  subscribe(ownEventListener(window, "beforeunload", (event) => {
    if (!event.defaultPrevented) terminateForUnload();
  }));
  // A cancelled beforeunload keeps the current editor alive. Accepted prompts
  // reach pagehide, which is the final synchronous teardown boundary.
  subscribe(ownEventListener(window, "pagehide", terminateForUnload, { once: true }));
}

async function fetchResource(url: URL, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal, mode: "cors", credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.href}`);
  if (response.url !== url.href) throw new Error("Pack resource redirected outside its declared URL");
  const declaredLength = Number(response.headers.get("content-length"));
  const limit = configuredResourceLimits().maxFileBytes;
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new Error(`Pack resource exceeds ${limit} bytes`);
  }
  return readResponseBytes(response, limit, signal);
}

function cloneImmutableTypstExportSnapshot(
  project: TypstProjectUpdate,
  packageGenerations: readonly TypstPackageGeneration[],
): ImmutableTypstExportSnapshot {
  const clonedProject: TypstProjectUpdate = Object.freeze({
    ...project,
    files: project.files.map((file) => Object.freeze({ ...file })),
  });
  const clonedPackages = Object.freeze(packageGenerations.map((generation) => Object.freeze({
    ...generation,
    spec: Object.freeze({ ...generation.spec }),
    files: Object.freeze(generation.files.map((file) => Object.freeze({
      ...file,
      bytes: Uint8Array.from(file.bytes),
    }))),
    internalFiles: Object.freeze(generation.internalFiles.map((file) => Object.freeze({
      ...file,
      bytes: Uint8Array.from(file.bytes),
    }))),
  })));
  return Object.freeze({ project: clonedProject, packageGenerations: clonedPackages });
}



async function readResponseBytes(response: Response, limit: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) throw new Error("Pack resource response has no readable body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel("resource size limit exceeded");
        throw new Error(`Pack resource exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}


async function loadDefaultIntro(): Promise<Uint8Array> {
  const url = new URL("intro.typ", document.baseURI);
  let response: Response;
  try {
    response = await fetch(url, { credentials: "same-origin" });
  } catch (error) {
    throw new Error(`Failed to load bundled intro template from ${url.href}`, { cause: error });
  }
  if (!response.ok) {
    throw new Error(`Failed to load bundled intro template from ${url.href}: HTTP ${response.status}`);
  }
  const source = await response.text();
  if (!source.trim()) throw new Error(`Bundled intro template is empty: ${url.href}`);
  return encoder.encode(source);
}

const INTRO_ASSETS = [
  "basic", "actor", "continuation", "rotation", "reply-inline", "reply-block",
  "bond", "typst", "mode", "full", "sticker",
] as const;

async function loadIntroAssets(): Promise<void> {
  const directory = vscode.Uri.joinPath(WORKSPACE, "intro-assets");
  await vscode.workspace.fs.createDirectory(directory);
  await Promise.all(INTRO_ASSETS.map(async (name) => {
    const url = new URL(`intro-assets/${name}.png`, document.baseURI);
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Failed to load bundled intro asset ${url.href}: HTTP ${response.status}`);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(directory, `${name}.png`),
      new Uint8Array(await response.arrayBuffer()),
    );
  }));
}

async function ensureDefaultWorkspace(): Promise<boolean> {
  let createdIntro = false;
  try {
    await vscode.workspace.fs.stat(INTRO);
  } catch {
    await vscode.workspace.fs.writeFile(INTRO, await loadDefaultIntro());
    createdIntro = true;
  }
  await loadIntroAssets();
  try {
    await vscode.workspace.fs.stat(STORY);
  } catch {
    await vscode.workspace.fs.writeFile(STORY, encoder.encode(DEFAULT_STORY));
  }
  return createdIntro;
}

async function manifestCacheIdentity(source: PackManifestSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(source.json));
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${source.manifestUrl}:${hash}`;
}

async function fetchManifest(url: string, etag: string | undefined) {
  const headers = new Headers();
  if (etag) headers.set("If-None-Match", etag);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    return {
      status: response.status,
      ok: response.ok,
      etag: response.headers.get("etag") ?? undefined,
      text: () => response.text()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchEntityCatalog(url: string, etag: string | undefined) {
  const headers = new Headers({ Accept: "application/json" });
  if (etag) headers.set("If-None-Match", etag);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "error",
      credentials: "omit"
    });
    return {
      status: response.status,
      ok: response.ok,
      etag: response.headers.get("etag") ?? undefined,
      contentType: response.headers.get("content-type") ?? undefined,
      text: () => response.text()
    };
  } finally {
    clearTimeout(timeout);
  }
}


function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}




function createLayout(root: HTMLElement) {
  root.replaceChildren();
  const body = part("body");
  const activity = part("activity");
  const primary = part("primary");
  const sidebar = part("sidebar");
  const main = part("main");
  const editor = part("editor");
  const panel = part("panel");
  const status = part("status");
  for (const element of [body, activity, status]) {
    element.style.width = "100%";
    element.style.height = "100%";
  }
  const workbenchSplit = new SplitView(root, { orientation: Orientation.VERTICAL, proportionalLayout: false });
  workbenchSplit.addView(splitViewPart(body, 0, Number.POSITIVE_INFINITY), Math.max(0, root.clientHeight - 22));
  workbenchSplit.addView(splitViewPart(status, 22, 22), 22);
  workbenchSplit.layout(root.clientHeight);
  const bodySplit = new SplitView(body, { orientation: Orientation.HORIZONTAL, proportionalLayout: false });
  bodySplit.addView(splitViewPart(activity, 48, 48), 48);
  bodySplit.addView(splitViewPart(primary, 220, Number.POSITIVE_INFINITY), Math.max(220, root.clientWidth - 48));
  bodySplit.layout(root.clientWidth);
  let editorPartLayout: (() => void) | undefined;
  const syncEditorPartLayout = () => editorPartLayout?.();

  const sidebarMainSplit = new SplitView(primary, {
    orientation: Orientation.HORIZONTAL,
    proportionalLayout: false
  });
  sidebarMainSplit.addView(splitViewPart(sidebar, 180, 600), 260);
  sidebarMainSplit.addView(
    // Match the native pane minimum; 320px is the whole mobile viewport,
    // not the editor width remaining after the activity/sidebar parts.
    splitViewPart(main, 220, Number.POSITIVE_INFINITY, syncEditorPartLayout),
    Math.max(220, primary.clientWidth - 260)
  );
  sidebarMainSplit.layout(primary.clientWidth);
  sidebarMainSplit.resizeView(0, 260);

  const editorPanelSplit = new SplitView(main, {
    orientation: Orientation.VERTICAL,
    proportionalLayout: false
  });
  editorPanelSplit.addView(
    splitViewPart(editor, 180, Number.POSITIVE_INFINITY, syncEditorPartLayout),
    Math.max(180, main.clientHeight)
  );
  editorPanelSplit.addView(
    splitViewPart(panel, 120, Number.POSITIVE_INFINITY),
    Sizing.Invisible(234)
  );
  editorPanelSplit.layout(main.clientHeight);

  let layoutFrame = 0;
  const syncSplitLayout = () => {
    cancelAnimationFrame(layoutFrame);
    layoutFrame = requestAnimationFrame(() => {
      workbenchSplit.layout(root.clientHeight);
      bodySplit.layout(body.clientWidth);
      if (primary.clientWidth > 0) sidebarMainSplit.layout(primary.clientWidth);
      if (main.clientHeight > 0) editorPanelSplit.layout(main.clientHeight);
    });
  };
  const resizeObserver = new ResizeObserver(syncSplitLayout);
  resizeObserver.observe(root);
  resizeObserver.observe(body);
  resizeObserver.observe(primary);
  resizeObserver.observe(main);
  window.addEventListener("resize", syncSplitLayout);
  window.visualViewport?.addEventListener("resize", syncSplitLayout);

  const syncActivitySelection = (event: MouseEvent) => {
    const tab = (event.target as Element | null)?.closest<HTMLElement>('[role="tab"]');
    if (!tab || !activity.contains(tab)) return;
    if (tab.getAttribute("aria-selected") !== "true") return;
    event.stopPropagation();
    setPartVisibility(Parts.SIDEBAR_PART, !isPartVisibile(Parts.SIDEBAR_PART));
  };
  activity.addEventListener("click", syncActivitySelection, true);
  return {
    activity,
    sidebar,
    editor,
    panel,
    status,
    setActivityVisible(visible: boolean) {
      if (bodySplit.isViewVisible(0) !== visible) bodySplit.setViewVisible(0, visible);
      syncSplitLayout();
    },
    setStatusVisible(visible: boolean) {
      if (workbenchSplit.isViewVisible(1) !== visible) workbenchSplit.setViewVisible(1, visible);
      syncSplitLayout();
    },
    setEditorPartLayout(nativeLayout: () => void) {
      editorPartLayout = nativeLayout;
      syncEditorPartLayout();
    },
    setPanelVisible(visible: boolean) {
      if (editorPanelSplit.isViewVisible(1) !== visible) editorPanelSplit.setViewVisible(1, visible);
    },
    setSidebarVisible(visible: boolean) {
      if (sidebarMainSplit.isViewVisible(0) !== visible) sidebarMainSplit.setViewVisible(0, visible);
    },
    dispose() {
      editorPartLayout = undefined;
      activity.removeEventListener("click", syncActivitySelection, true);
      window.removeEventListener("resize", syncSplitLayout);
      window.visualViewport?.removeEventListener("resize", syncSplitLayout);
      cancelAnimationFrame(layoutFrame);
      resizeObserver.disconnect();
      editorPanelSplit.dispose();
      sidebarMainSplit.dispose();
      bodySplit.dispose();
      workbenchSplit.dispose();
    }
  };
}

function splitViewPart(
  element: HTMLElement,
  minimumSize: number,
  maximumSize: number,
  onLayout?: () => void,
): IView {
  return {
    element,
    minimumSize,
    maximumSize,
    onDidChange: Event.None,
    layout() { onLayout?.(); }
  };
}

function mmsViewIcon(): string {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M4 5.5h16v10H9l-5 4v-14Zm4 4h8M8 12h5"/></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function historyViewIcon(): string {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9M4.5 4.5V9H9M12 7.5V12l3 2"/></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function galleryViewIcon(): string {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="3.5"/><path d="M5.5 19.5c.8-3.4 3.4-5.2 6.5-5.2s5.7 1.8 6.5 5.2"/></g></svg>';
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

interface DocumentConfigView {
  range: { start: { line: number; character: number }; end: { line: number; character: number } } | null;
  title: string;
  author: string | null;
  showHeader: boolean;
  compiledAt:
    | { mode: "hidden" }
    | { mode: "manual"; text: string }
    | { mode: "auto"; format: string; timezone: string };
}

async function configureDocumentSettings(
  document: vscode.TextDocument,
  client: BaseLanguageClient
): Promise<void> {
  const expectedVersion = document.version;
  const current = await client.sendRequest<DocumentConfigView | null>(
    "mmt/getDocumentConfig",
    { uri: document.uri.toString() }
  );
  if (!current) throw new Error("当前文档尚未进入 MMT language service");

  const title = await vscode.window.showInputBox({
    title: "MomoScript 文档标题",
    prompt: "显示在标题栏中的标题",
    value: current.title,
    validateInput: (value) => value.trim().length === 0 ? "标题不能为空" : undefined
  });
  if (title === undefined) return;
  const author = await vscode.window.showInputBox({
    title: "MomoScript 文档作者",
    prompt: "留空则不显示作者",
    value: current.author ?? ""
  });
  if (author === undefined) return;
  const header = await vscode.window.showQuickPick(
    [
      { label: "显示标题栏", value: true },
      { label: "隐藏标题栏", value: false }
    ],
    {
      title: "标题栏",
      placeHolder: current.showHeader ? "显示标题栏" : "隐藏标题栏"
    }
  );
  if (!header) return;
  const timeMode = await vscode.window.showQuickPick(
    [
      { label: "不显示编译时间", mode: "hidden" as const },
      { label: "自动生成", mode: "auto" as const },
      { label: "手动文本", mode: "manual" as const }
    ],
    {
      title: "编译时间",
      placeHolder: current.compiledAt.mode === "hidden"
        ? "不显示编译时间"
        : current.compiledAt.mode === "auto" ? "自动生成" : "手动文本"
    }
  );
  if (!timeMode) return;

  let compiledAtLines: string[] = [];
  if (timeMode.mode === "manual") {
    const manual = await vscode.window.showInputBox({
      title: "手动编译时间文本",
      value: current.compiledAt.mode === "manual" ? current.compiledAt.text : "",
      validateInput: (value) => value.length === 0 ? "时间文本不能为空" : undefined
    });
    if (manual === undefined) return;
    compiledAtLines = [`  compiled-at: ${JSON.stringify(manual)}`];
  } else if (timeMode.mode === "auto") {
    const format = await vscode.window.showInputBox({
      title: "自动时间格式",
      prompt: "使用 Rust time format-description 语法",
      value: current.compiledAt.mode === "auto"
        ? current.compiledAt.format
        : "[year]-[month]-[day] [hour]:[minute]:[second]",
      validateInput: (value) => value.length === 0 ? "时间格式不能为空" : undefined
    });
    if (format === undefined) return;
    const timezone = await vscode.window.showInputBox({
      title: "自动时间时区",
      prompt: "local、utc、Z 或 +HH:MM / -HH:MM",
      value: current.compiledAt.mode === "auto" ? current.compiledAt.timezone : "local",
      validateInput: (value) => /^(?:local|utc|Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
        ? undefined
        : "请输入 local、utc、Z 或有效的固定时区偏移"
    });
    if (timezone === undefined) return;
    compiledAtLines = [
      "  compiled-at: auto",
      `  compiled-at-format: ${JSON.stringify(format)}`,
      `  timezone: ${timezone}`
    ];
  } else {
    compiledAtLines = ["  compiled-at: none"];
  }

  const lines = [
    "@document",
    `  title: ${JSON.stringify(title)}`,
    ...(author.length > 0 ? [`  author: ${JSON.stringify(author)}`] : []),
    `  show-header: ${header.value}`,
    ...compiledAtLines,
    "@end",
    ""
  ];
  if (!vscode.workspace.textDocuments.includes(document) || document.version !== expectedVersion) {
    throw new Error("配置期间文档已发生变化；请重新打开文档设置");
  }
  const text = lines.join("\n");
  const edit = new vscode.WorkspaceEdit();
  if (current.range) {
    edit.replace(
      document.uri,
      new vscode.Range(
        current.range.start.line,
        current.range.start.character,
        current.range.end.line,
        current.range.end.character
      ),
      text.trimEnd()
    );
  } else {
    edit.insert(document.uri, new vscode.Position(0, 0), text);
  }
  if (!await vscode.workspace.applyEdit(edit)) {
    throw new Error("编辑器拒绝了文档设置修改");
  }
}

function renderMmsProjectView(container: HTMLElement): vscode.Disposable {
  container.classList.add("mms-project-view");
  const documentSettings = document.createElement("section");
  documentSettings.className = "mms-settings-section";
  const documentHeading = document.createElement("h3");
  documentHeading.textContent = "文档";
  const documentDescription = document.createElement("p");
  documentDescription.textContent = "标题、作者、标题栏与编译时间写入当前 MMT 文件。";
  const configureDocument = document.createElement("button");
  configureDocument.type = "button";
  configureDocument.textContent = "配置当前文档";
  const openDocumentSettings = () => void vscode.commands.executeCommand("mmt.document.configure");
  configureDocument.addEventListener("click", openDocumentSettings);
  const works = document.createElement("section");
  works.className = "mms-settings-section";
  const worksHeading = document.createElement("h3");
  worksHeading.textContent = "我的作品";
  const newWork = document.createElement("button");
  newWork.type = "button";
  newWork.textContent = "新建作品";
  const createWork = () => void vscode.commands.executeCommand("mmt.composer.new");
  newWork.addEventListener("click", createWork);
  const openWork = document.createElement("button");
  openWork.type = "button";
  openWork.textContent = "打开作品";
  const chooseWork = () => void vscode.commands.executeCommand("mmt.composer.choose");
  openWork.addEventListener("click", chooseWork);
  works.append(worksHeading, newWork, openWork);
  container.append(works);
  const openComposer = document.createElement("button");
  openComposer.type = "button";
  openComposer.textContent = "打开 GUI 创作";
  const openComposerEditor = () => void vscode.commands.executeCommand("mmt.composer.open");
  openComposer.addEventListener("click", openComposerEditor);
  documentSettings.append(documentHeading, documentDescription, configureDocument, openComposer);
  const previewSettings = document.createElement("section");
  previewSettings.className = "mms-settings-section";
  const previewHeading = document.createElement("h3");
  previewHeading.textContent = "预览";
  const previewLabel = document.createElement("label");
  previewLabel.className = "mms-setting-row";
  const previewLabelText = document.createElement("span");
  previewLabelText.textContent = "文档变化时自动预览";
  const previewToggle = document.createElement("input");
  previewToggle.type = "checkbox";
  previewToggle.checked = vscode.workspace.getConfiguration("mmt.preview").get<boolean>("onChange", true);
  previewLabel.append(previewLabelText, previewToggle);
  const previewStatus = document.createElement("div");
  previewStatus.className = "mms-settings-status";
  const updatePreviewSetting = async () => {
    try {
      await vscode.workspace.getConfiguration("mmt.preview").update("onChange", previewToggle.checked, vscode.ConfigurationTarget.Workspace);
      previewStatus.textContent = previewToggle.checked ? "实时预览已启用" : "实时预览已暂停";
    } catch (error) {
      previewToggle.checked = vscode.workspace.getConfiguration("mmt.preview").get<boolean>("onChange", true);
      previewStatus.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  previewToggle.addEventListener("change", updatePreviewSetting);
  previewSettings.append(previewHeading, previewLabel, previewStatus);
  const resources = document.createElement("section");
  resources.className = "mms-settings-section";
  const resourceHeading = document.createElement("h3");
  resourceHeading.textContent = "资源包";
  const label = document.createElement("label");
  label.textContent = "清单地址";
  const urls = document.createElement("textarea");
  urls.rows = 3;
  urls.value = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_MANIFEST_URL]).join("\n");
  urls.setAttribute("aria-label", "资源包清单地址");
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "保存项目设置";
  const status = document.createElement("div");
  status.className = "mms-settings-status";
  const saveSettings = async () => {
    const values = urls.value.split("\n").map((value) => value.trim()).filter(Boolean);
    try {
      await vscode.workspace.getConfiguration("mmt.resourcePacks").update("manifestUrls", values, vscode.ConfigurationTarget.Workspace);
      status.textContent = "已保存";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  save.addEventListener("click", saveSettings);
  const advanced = document.createElement("button");
  advanced.type = "button";
  advanced.textContent = "打开高级设置";
  const openAdvanced = () => void vscode.commands.executeCommand("workbench.action.openSettings", "@ext:momoscript.momoscript-vscode");
  advanced.addEventListener("click", openAdvanced);
  const configurationRegistration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("mmt.preview.onChange")) {
      previewToggle.checked = vscode.workspace.getConfiguration("mmt.preview").get<boolean>("onChange", true);
    }
    if (event.affectsConfiguration("mmt.resourcePacks.manifestUrls")) {
      urls.value = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_MANIFEST_URL]).join("\n");
    }
  });
  const resourceActions = document.createElement("div");
  resourceActions.className = "mms-settings-actions";
  advanced.className = "mms-secondary-button";
  resourceActions.append(save, advanced);
  resources.append(resourceHeading, label, urls, resourceActions, status);
  container.append(documentSettings, previewSettings, resources);
  return {
    dispose() {
      previewToggle.removeEventListener("change", updatePreviewSetting);
      configurationRegistration.dispose();
      save.removeEventListener("click", saveSettings);
      advanced.removeEventListener("click", openAdvanced);
      configureDocument.removeEventListener("click", openDocumentSettings);
      openComposer.removeEventListener("click", openComposerEditor);
      newWork.removeEventListener("click", createWork);
      openWork.removeEventListener("click", chooseWork);
    }
  };
}



function part(name: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = `workbench-${name}`;
  return element;
}
const typstVirtualFileDigestCache = new WeakMap<object, Promise<string>>();

async function buildTypstProject(
  document: vscode.TextDocument,
  revisions: Map<string, number>,
  previous?: TypstProjectUpdate,
): Promise<TypstProjectUpdate> {
  const sourceUri = document.uri.toString();
  const revision = (revisions.get(sourceUri) ?? 0) + 1;
  revisions.set(sourceUri, revision);
  const root = vscode.Uri.parse(`${document.uri.scheme}://${document.uri.authority}/`);
  const entryUri = document.uri.toString();
  const reusableFiles = previous?.sourceUri === sourceUri && previous.entryUri === entryUri
    ? previous.files.filter((file) => file.uri !== entryUri)
    : undefined;
  const files: TypstVirtualFile[] = [
    { uri: entryUri, text: document.getText() },
    ...(reusableFiles ?? []),
  ];
  const maxFiles = 256;
  const maxFileBytes = 8 * 1024 * 1024;
  const maxTotalBytes = 32 * 1024 * 1024;
  const maxDirectories = 32;
  let visitedDirectories = 0;
  let totalBytes = encoder.encode(document.getText()).byteLength;
  const visit = async (directory: vscode.Uri): Promise<void> => {
    if (files.length >= maxFiles || visitedDirectories++ >= maxDirectories) return;
    for (const [name, type] of await vscode.workspace.fs.readDirectory(directory)) {
      if (files.length >= maxFiles) return;
      if (name === "." || name === ".." || name.includes("\\") || name.includes("/")) continue;
      const uri = vscode.Uri.joinPath(directory, name);
      if (type === vscode.FileType.Directory) { await visit(uri); continue; }
      if (type !== vscode.FileType.File || uri.toString() === entryUri) continue;
      const path = uri.path.toLowerCase();
      if (!/\.(?:typ|bib|png|jpe?g|gif|webp|svg|bmp|avif|ttf|otf|woff2?)$/i.test(path)) continue;
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > maxFileBytes || totalBytes + bytes.byteLength > maxTotalBytes) continue;
      totalBytes += bytes.byteLength;
      files.push(path.endsWith(".typ") || path.endsWith(".bib") ? { uri: uri.toString(), text: new TextDecoder().decode(bytes) } : { uri: uri.toString(), dataBase64: bytesToBase64(bytes) });
    }
  };
  if (!reusableFiles) await visit(root);
  const workspaceId = document.uri.authority || "workspace";
  const mountedPath = (uri: vscode.Uri) => {
    const path = uri.path.replace(/^\/+/, "");
    return path.startsWith(`${workspaceId}/`) ? path.slice(workspaceId.length + 1) : path;
  };
  const logicalSource = await logicalSourceId(workspaceId, mountedPath(document.uri));
  const sourceContent = await sourceContentKey(logicalSource, encoder.encode(document.getText()));
  const entryFile: LogicalProjectFileId = {
    kind: "workspace",
    logicalWorkspaceId: workspaceId,
    canonicalWorkspaceRelativePath: mountedPath(document.uri)
  };
  const digestedFiles = await Promise.all(files.map(async (file) => ({
    ...file,
    digest: file.digest ?? await typstVirtualFileDigest(file),
  })));
  const logicalFiles = new Map<LogicalProjectFileId, string>();
  for (const file of digestedFiles) {
    const fileUri = vscode.Uri.parse(file.uri);
    const id: LogicalProjectFileId = {
      kind: "workspace",
      logicalWorkspaceId: workspaceId,
      canonicalWorkspaceRelativePath: mountedPath(fileUri)
    };
    logicalFiles.set(id, await typstVirtualFileDigest(file));
  }
  const mappingDigest = await canonicalBytesDigest("mmt-source-map-v1", []);
  const projectDigest = await projectSnapshotKey({
    logicalSource,
    sourceContent,
    entryFile,
    files: logicalFiles,
    packageGenerations: new Map(),
    generatedDependencies: new Map(),
    projectOptions: new Map([["profile", "standalone"]]),
    sourceMapDigest: mappingDigest
  });
  const projectionKey = await buildProjectionKey(
    sourceContent,
    `standalone:${logicalSource}`,
    revision,
    entryFile,
    projectDigest,
    mappingDigest
  );
  return {
    sourceUri,
    sourceVersion: document.version,
    revision,
    entryUri,
    files: digestedFiles,
    full: true,
    projectDigest,
    sourceContent,
    projectionKey,
    mappingDigest
  };
}

async function typstVirtualFileDigest(file: TypstVirtualFile): Promise<string> {
  let digest = typstVirtualFileDigestCache.get(file);
  if (!digest) {
    digest = (async () => {
      const bytes = file.text !== undefined
        ? encoder.encode(file.text)
        : Uint8Array.from(atob(file.dataBase64), (character) => character.charCodeAt(0));
      return canonicalBytesDigest("mmt-project-file-v1", [bytes]);
    })();
    typstVirtualFileDigestCache.set(file, digest);
  }
  return digest;
}

