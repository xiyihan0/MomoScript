import "@codingame/monaco-vscode-language-pack-zh-hans";
import "@codingame/monaco-vscode-media-preview-default-extension";
import * as vscode from "vscode";
import { LogLevel } from "@codingame/monaco-vscode-api";
import { getService, ICodeEditorService, IModelService } from "@codingame/monaco-vscode-api";
import { registerAssets } from "@codingame/monaco-vscode-api/assets";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { Event } from "@codingame/monaco-vscode-api/vscode/vs/base/common/event";
import { Orientation, Sizing, SplitView, type IView } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/splitview/splitview";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getNotificationsServiceOverride from "@codingame/monaco-vscode-notifications-service-override";
import getPreferencesServiceOverride from "@codingame/monaco-vscode-preferences-service-override";
import getOutputServiceOverride from "@codingame/monaco-vscode-output-service-override";
import getLocalizationServiceOverride from "@codingame/monaco-vscode-localization-service-override";
import getTextMateServiceOverride from "@codingame/monaco-vscode-textmate-service-override";
import getThemeServiceOverride from "@codingame/monaco-vscode-theme-service-override";
import getStatusBarServiceOverride from "@codingame/monaco-vscode-view-status-bar-service-override";
import getViewsServiceOverride, { attachPart, isPartVisibile, onPartVisibilityChange, Parts, registerCustomView, renderStatusBarPart, setPartVisibility, ViewContainerLocation } from "@codingame/monaco-vscode-views-service-override";
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
import { startMmtLanguageClient } from "./mmtLanguageClient";
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
import { packResourceUrl, projectGalleryPack, type GalleryPack } from "./galleryPack";
import { registerCharacterGalleryCommands, renderCharacterGalleryView } from "./characterGalleryUi";
import { PREVIEW_RENDERER_METHOD, projectionSessionKey } from "../../vscode/src/tinymistClient";
import {
  createRenderArtifactLocationResolver,
  evictPreviewPackageGeneration,
  installPreviewPackageGenerations,
  renderArtifactLocationProviderKey,
  previewRendererFontFiles,
  sanitizeSvg,
  TypstPreviewController,
  type RenderArtifactLocation,
  type ImmutableTypstExportSnapshot,
  type TypstPreviewBinding,
  type TypstPreviewPublication,
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
import type { PreviewTraceSession } from "./previewPerformance.ts";
import { PwaSafeRestartQuiesceAdapter } from "./pwaSafeRestart";
import { registerPwaUpdateLifecycle } from "./pwaUpdate";
import { showMomoScriptMessage } from "./notifications";
import {
  TINYMIST_VERSION,
  TINYMIST_WASM_SHA256,
  TYPST_COMPILER_VERSION,
  TYPST_COMPILER_WASM_SHA256,
} from "./runtimeArtifacts";
import { EditorRuntimeStatus, type RuntimeRecoveryState } from "./runtimeStatus";
import { createPreviewArtifact, type LocationProviderKey, type PreviewArtifact, type PreviewPagePoint, type PreviewSourceTarget, type PreviewViewport } from "./previewArtifact.ts";
import {
  BrowserPreviewViewportPersistence,
  PreviewInteractionController,
  type PreviewBackendLocation,
  type PreviewEditorSelection,
  type PreviewLocationResolver,
  type PreviewSourceIdentity,
  type ProjectedPreviewSelection,
} from "./previewInteraction.ts";
import { ExactExportUiController, LatestExactArtifactWaiter, type ExactExportUiState } from "./exactExportUi.ts";
import type { ExactExportFormat, ExactExportPorts, RenderAdvanceCause, RenderAdvanceToken, StaleExportChoice } from "./exactExport.ts";
import {
  RenderProjectSnapshotStore,
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
  type LogicalProjectFileId,
  type RenderKey,
  type SourceStaleToken,
} from "../../vscode/src/runtimeIdentity";
import previewWebviewRuntimeUrl from "./previewWebviewRuntime.ts?worker&url";
import {
  PreviewRendererSessionOwner,
  type PreviewRendererCandidate,
} from "./previewRendererSession.ts";

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

if (import.meta.env.VITE_MMT_E2E === "1") {
  Reflect.set(globalThis, "__mmtSanitizeSvg", sanitizeSvg);
}

type E2ELifecycleKind = "runtime-ready" | "dispose-invoked" | "dispose-complete" | "retained-artifacts-cleared" | "unload" | "hmr" | "hmr-fallback";

interface PreviewInteractionFixtureRequest {
  readonly action: "install-provider" | "install-immutable" | "position" | "position-live" | "editor-selection" | "reveal" | "overlay" | "navigate" | "restart-provider" | "resync-renderer" | "advance-source" | "state";
  readonly range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  readonly point?: PreviewPagePoint;
}

interface ExactExportFixtureRequest {
  readonly action: "install" | "advance" | "publish-latest" | "partial" | "failed" | "evicted" | "state" | "has-artifact";
  readonly marker?: string;
  readonly renderKey?: string;
}

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

if (import.meta.env.VITE_MMT_E2E === "1") {
  Reflect.set(globalThis, "__mmtCompletionLabels", async (
    line: number,
    character: number,
    triggerCharacter?: string,
    name = "story.mmt"
  ) => {
    const uri = vscode.Uri.joinPath(WORKSPACE, name);
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      uri,
      new vscode.Position(line, character),
      triggerCharacter
    );
    return completions?.items.map((item) => (
      typeof item.label === "string" ? item.label : item.label.label
    )) ?? [];
  });
  Reflect.set(globalThis, "__mmtCompletionDocumentation", async (line: number, character: number, label: string) => {
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      STORY,
      new vscode.Position(line, character)
    );
    const item = completions?.items.find((candidate) => candidate.label === label);
    return typeof item?.documentation === "string"
      ? item.documentation
      : item?.documentation?.value ?? null;
  });
  Reflect.set(globalThis, "__mmtHoverText", async (line: number, character: number) => {
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      STORY,
      new vscode.Position(line, character)
    );
    return hovers?.flatMap((hover) => hover.contents.map((content) =>
      typeof content === "string" ? content : content.value
    )) ?? [];
  });
  Reflect.set(globalThis, "__mmtTypstHoverText", async (name: string, line: number, character: number) => {
    const uri = vscode.Uri.joinPath(WORKSPACE, name);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, new vscode.Position(line, character));
    return hovers?.flatMap((hover) => hover.contents.map((content) => typeof content === "string" ? content : content.value)) ?? [];
  });
  Reflect.set(globalThis, "__mmtTypstSemanticTokens", async (name: string) => {
    const uri = vscode.Uri.joinPath(WORKSPACE, name);
    const tokens = await vscode.commands.executeCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", uri);
    return tokens ? Array.from(tokens.data) : [];
  });
  Reflect.set(globalThis, "__mmtTypstRawSemanticTokens", async (name: string) => {
    const uri = vscode.Uri.joinPath(WORKSPACE, name).toString();
    return tinymist?.backend.request<{ data: number[] } | null>("textDocument/semanticTokens/full", { textDocument: { uri } }) ?? null;
  });
  Reflect.set(globalThis, "__mmtTypstBackendProject", (name: string) => {
    const uri = vscode.Uri.joinPath(WORKSPACE, name).toString();
    const project = tinymist?.backend.projectForEntry(uri);
    return project ? { revision: project.revision, text: project.files.find((file) => file.uri === uri && "text" in file)?.text ?? null } : null;
  });
  Reflect.set(globalThis, "__mmtActiveDocument", () => {
    const active = vscode.window.activeTextEditor?.document;
    const workspaceDocument = active?.uri.scheme === "mmtfs"
      ? active
      : vscode.window.visibleTextEditors.find((editor) => editor.document.uri.scheme === "mmtfs")?.document;
    return workspaceDocument
      ? { name: workspaceDocument.uri.path.split("/").pop(), languageId: workspaceDocument.languageId, text: workspaceDocument.getText() }
      : null;
  });
  Reflect.set(globalThis, "__mmtStoryText", () =>
    vscode.workspace.textDocuments.find((document) => document.uri.toString() === STORY.toString())?.getText()
  );
  Reflect.set(globalThis, "__mmtColorDecorators", () =>
    vscode.workspace
      .getConfiguration("editor", vscode.window.activeTextEditor?.document)
      .get<string>("defaultColorDecorators")
  );
  Reflect.set(globalThis, "__mmtDefaultEol", () =>
    vscode.workspace.getConfiguration("files").get<string>("eol")
  );
  Reflect.set(globalThis, "__mmtWriteWorkspaceFile", async (name: string, dataBase64: string) => {
    if (!/^[^./\\][^/\\]*$/.test(name) || name === "..") throw new Error("invalid workspace basename");
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(WORKSPACE, name), Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0)));
  });
  Reflect.set(globalThis, "__mmtOpenWorkspaceDocument", async (name: string, text: string) => {
    if (!/^[^./\\][^/\\]*(?:\.mmt(?:\.txt)?|\.typ)$/.test(name)) throw new Error("invalid workspace document basename");
    const uri = vscode.Uri.joinPath(WORKSPACE, name);
    await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
    const opened = await vscode.workspace.openTextDocument(uri);
    const expectedLanguage = name.endsWith(".typ") ? "typst" : "mmt";
    const document = opened.languageId === expectedLanguage ? opened : await vscode.languages.setTextDocumentLanguage(opened, expectedLanguage);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    return uri.toString();
  });
  Reflect.set(globalThis, "__mmtShowWorkspaceDocument", async (name: string) => {
    if (!/^[^./\\][^/\\]*(?:\.mmt(?:\.txt)?|\.typ)$/.test(name)) throw new Error("invalid workspace document basename");
    const uri = vscode.Uri.joinPath(WORKSPACE, name);
    const opened = await vscode.workspace.openTextDocument(uri);
    const expectedLanguage = name.endsWith(".typ") ? "typst" : "mmt";
    const document = opened.languageId === expectedLanguage ? opened : await vscode.languages.setTextDocumentLanguage(opened, expectedLanguage);
    await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
    return uri.toString();
  });
  Reflect.set(globalThis, "__mmtReadWorkspaceDocument", async (name: string) => {
    if (!/^[^./\\][^/\\]*(?:\.mmt(?:\.txt)?|\.typ)$/.test(name)) throw new Error("invalid workspace document basename");
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(WORKSPACE, name)));
  });
  Reflect.set(globalThis, "__mmtReplaceWorkspaceDocument", async (name: string, text: string) => {
    if (!/^[^./\\][^/\\]*(?:\.mmt(?:\.txt)?|\.typ)$/.test(name)) throw new Error("invalid workspace document basename");
    const uri = vscode.Uri.joinPath(WORKSPACE, name);
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
    if (!document) throw new Error("workspace document is not open");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error("workspace edit was rejected");
    return document.getText();
  });
  Reflect.set(globalThis, "__mmtEditWorkspaceDocument", async (
    name: string,
    offset: number,
    deleteCount: number,
    text: string,
  ) => {
    if (!/^[^./\\][^/\\]*(?:\.mmt(?:\.txt)?|\.typ)$/.test(name)) throw new Error("invalid workspace document basename");
    const uri = vscode.Uri.joinPath(WORKSPACE, name);
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
    if (!document) throw new Error("workspace document is not open");
    if (
      !Number.isSafeInteger(offset)
      || !Number.isSafeInteger(deleteCount)
      || offset < 0
      || deleteCount < 0
      || offset + deleteCount > document.getText().length
    ) throw new RangeError("workspace edit range is invalid");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, new vscode.Range(document.positionAt(offset), document.positionAt(offset + deleteCount)), text);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error("workspace edit was rejected");
    return { text: document.getText(), version: document.version };
  });
}
const DEFAULT_STORY = "> 佳代子: 你好，老师！\n>_: 我也可以继续说。\n< 老师好！\n> 佳代子: 看看这个：[:#1:](width: 2em)\n";
const PACK_URL = "https://mms-pack.xiyihan.cn/ba_kivo/manifest.json";
const encoder = new TextEncoder();
const PREVIEW_RUNTIME_KEY = runtimeArtifactKey(
  TYPST_COMPILER_VERSION,
  TYPST_COMPILER_WASM_SHA256,
  "mmt-template-bundle-v1",
  "c02a98146312b8756f9f23654b194885358f603eed736f037f172d617330c05c",
);
const PREVIEW_RENDER_OPTIONS_DIGEST = canonicalBytesDigest(
  "mmt-preview-render-options-v1",
  [encoder.encode("svg:default")],
);

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

let runtimeController: EditorRuntimeController | undefined;
const hmrDisposal = Reflect.get(globalThis, "__mmtHmrDisposal");
if (import.meta.hot && hmrDisposal instanceof Promise) {
  void hmrDisposal.then(
    () => window.location.reload(),
    () => window.location.reload()
  );
} else {
  void start().catch((error: unknown) => {
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
  const exposeRuntimeGlobal = <T>(key: string, value: T): T => {
    Reflect.set(globalThis, key, value);
    subscribe({
      dispose() {
        if (Reflect.get(globalThis, key) === value) Reflect.deleteProperty(globalThis, key);
      },
    });
    return value;
  };
  if (exactExportHost) own(exactExportHost.latest);
  const root = document.querySelector<HTMLElement>("#workbench");
  if (!root) throw new Error("Missing #workbench container");
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
  const log = (scope: string, message: string) => {
    const line = `[${new Date().toISOString()}] [${scope}] ${message}`;
    if (output) output.appendLine(line);
    else console.info(line);
  };
  log("host", "Starting Web Workbench");
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
  let previewPanel: vscode.WebviewPanel | undefined;
  let previewWebviewReady = false;
  let previewPanelTitle = "MomoScript 预览";
  let previewPanelDisposeRegistration: vscode.Disposable | undefined;
  let previewPanelMessageRegistration: vscode.Disposable | undefined;
  let activeClient: BaseLanguageClient | undefined;
  let displayedPreviewSourceUri: string | undefined;
  let previewFixtureActiveSourceUri: string | undefined;
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
    requestedRenderTokens,
    renderRequestIdBySource,
    persistenceByUri,
  } = controller.stores;
  const previewTraces = new Map<string, PreviewTraceSession>();
  const previewWebviewReadyWaiters = new Set<() => void>();
  const pendingWebviewPublications = new Map<number, {
    readonly renderKey: RenderKey;
    readonly resolve: (message: PreviewVisualReadyMessage) => void;
    readonly reject: (error: Error) => void;
  }>();
  const renderProjectSnapshots = new RenderProjectSnapshotStore();
  own({ dispose: () => renderProjectSnapshots.clear() });
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
  let previewWebviewRendererGeneration: {
    readonly sessionId: string;
    readonly backendGeneration: number;
    readonly generation: number;
  } | undefined;
  let previewWebviewRendererResyncRequested: { readonly sessionId: string; readonly generation: number } | undefined;
  let preview!: TypstPreviewController;
  const exactExportAdvanceBySource = new Map<string, RenderAdvanceToken>();
  const immutableRendererExports = new Map<RenderKey, {
    readonly sourceUri: string;
    readonly snapshot: ImmutableTypstExportSnapshot;
    pins: number;
  }>();
  const evictImmutableRendererExports = (protectedRenderKey?: RenderKey): void => {
    while (immutableRendererExports.size > 32) {
      let evictable: RenderKey | undefined;
      for (const [renderKey, retained] of immutableRendererExports) {
        if (renderKey !== protectedRenderKey && retained.pins === 0) {
          evictable = renderKey;
          break;
        }
      }
      if (!evictable) return;
      immutableRendererExports.delete(evictable);
    }
  };
  own({ dispose: () => immutableRendererExports.clear() });
  const currentPreviewExport = createCurrentPreviewExportClient({
    artifacts: controller.stores.previewArtifacts,
    preview: () => preview,
    immutable: {
      has: (renderKey) => immutableRendererExports.has(renderKey),
      export: async (renderKey, format, pageIndex, signal) => {
        const retained = immutableRendererExports.get(renderKey);
        if (!retained) throw new Error(`Immutable renderer export input is unavailable for ${renderKey}`);
        retained.pins += 1;
        try {
          return await preview.createImmutableExport(retained.snapshot, renderKey, format, pageIndex, signal);
        } finally {
          retained.pins -= 1;
          evictImmutableRendererExports();
        }
      },
    },
  });
  const exportMode = controller.stores.exactExport ? "exact" : "current-preview";
  const exactExportUi = own(new ExactExportUiController(controller.stores.exactExport ?? currentPreviewExport, {
    stateChanged(state) {
      if (previewPanel) void previewPanel.webview.postMessage({ type: "exactExportState", state });
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
      backendEncoding: "utf-8",
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
  const previewProblemDiagnostic = (
    diagnostic: PreviewBuildDiagnostic
  ): vscode.Diagnostic => {
    const range = diagnostic.range
      ? new vscode.Range(
          diagnostic.range.start.line,
          diagnostic.range.start.character,
          diagnostic.range.end.line,
          diagnostic.range.end.character
        )
      : new vscode.Range(0, 0, 0, 0);
    const problem = new vscode.Diagnostic(
      range,
      `[${diagnostic.phase}] ${diagnostic.message}`,
      diagnostic.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : diagnostic.severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information
    );
    problem.source = "MomoScript preview/build";
    problem.code = `preview/${diagnostic.phase}`;
    if (diagnostic.dependency) {
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
    const key = await renderKey(materialization, await PREVIEW_RUNTIME_KEY, await PREVIEW_RENDER_OPTIONS_DIGEST);
    return Object.freeze({
      ...(requestId === undefined ? {} : { requestId }),
      ...(traceId === undefined ? {} : { traceId }),
      renderKey: key,
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
    const mapped = await activeClient.sendRequest<readonly PreviewSourceTarget[] | null>("mmt/mapTypstReadLocations", {
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
    const target = mapped?.[0];
    if (!target || target.kind === "staleUnknown") return target;
    const readOnly = target.kind === "packageFile" || target.kind === "generatedProjection";
    return Object.freeze({ ...target, readOnly, retained: true });
  };
  const openPreviewSource = async (target: PreviewSourceTarget): Promise<void> => {
    if (!target.uri || !target.range) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(target.uri));
    const editor = await vscode.window.showTextDocument(document, { preview: target.readOnly === true });
    editor.selection = new vscode.Selection(
      target.range.start.line,
      target.range.start.character,
      target.range.end.line,
      target.range.end.character,
    );
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  };
  let previewInteractionStatus: string | null = null;
  let previewInteractionStatusText = "";
  const previewInteraction = own(new PreviewInteractionController({
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
        if (previewPanel) void previewPanel.webview.postMessage({ type: "indicator", point: indicator?.point });
      },
      cursorChanged(cursor) {
        if (previewPanel) void previewPanel.webview.postMessage({ type: "cursor", point: cursor?.point });
      },
      viewportChanged(viewport) {
        if (previewPanel) void previewPanel.webview.postMessage({ type: "restoreViewport", viewport });
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
  ): void => {
    preview.setDisplayedArtifact(artifact, retainCompilerEntry);
    previewInteraction.bindArtifact(artifact, identity, resolver);
  };
  let webviewPublicationSequence = 1;
  const publishFixtureArtifact = async (artifact: PreviewArtifact): Promise<void> => {
    const panel = previewPanel;
    const visual = artifact.visualSnapshot;
    const firstPage = visual.kind === "svg" ? visual.pages[0] : undefined;
    if (!panel || !firstPage || visual.kind !== "svg") return;
    await waitForPreviewWebview();
    const imageAssets = await Promise.all(visual.imageAssets.map(async (asset) => ({
      digest: asset.digest,
      mimeType: asset.mimeType,
      dataBase64: bytesToBase64(new Uint8Array(await asset.blob.arrayBuffer())),
    })));
    await panel.webview.postMessage({
      type: "render",
      svg: firstPage.sanitizedSvg,
      imageAssets,
      pageSize: { width: firstPage.geometry.cssWidth, height: firstPage.geometry.cssHeight },
      requestSequence: webviewPublicationSequence++,
      renderKey: artifact.renderKey,
      spans: [],
    });
  };
  const waitForPreviewWebview = async (signal?: AbortSignal): Promise<void> => {
    if (previewWebviewReady) return;
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        previewWebviewReadyWaiters.delete(ready);
        reject(new Error("Preview Webview runtime did not become ready"));
      }, 30_000);
      const aborted = () => {
        window.clearTimeout(timeout);
        previewWebviewReadyWaiters.delete(ready);
        reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
      };
      const ready = () => {
        window.clearTimeout(timeout);
        signal?.removeEventListener("abort", aborted);
        resolve();
      };
      signal?.addEventListener("abort", aborted, { once: true });
      previewWebviewReadyWaiters.add(ready);
    });
  };
  const publishFullSvgToWebview = async (
    publication: TypstPreviewPublication,
    revision: PreviewRevision,
  ): Promise<PreviewVisualReadyMessage> => {
    const panel = previewPanel;
    if (!panel) throw new Error("Preview Webview is closed");
    await waitForPreviewWebview(publication.signal);
    publication.signal?.throwIfAborted();
    const requestSequence = webviewPublicationSequence++;
    const imageAssets = await Promise.all(publication.imageAssets.map(async (asset) => ({
      digest: asset.digest,
      mimeType: asset.mimeType,
      dataBase64: bytesToBase64(new Uint8Array(await asset.blob.arrayBuffer())),
    })));
    const acknowledgement = new Promise<PreviewVisualReadyMessage>((resolve, reject) => {
      pendingWebviewPublications.set(requestSequence, {
        renderKey: publication.artifact.renderKey,
        resolve,
        reject,
      });
    });
    const delivered = await panel.webview.postMessage({
      type: "render",
      svg: publication.compactSvg,
      imageAssets,
      pageSize: publication.pageSize,
      requestSequence,
      traceId: publication.traceId,
      renderKey: publication.artifact.renderKey,
      spans: publication.spans,
    });
    if (!delivered || panel !== previewPanel) {
      pendingWebviewPublications.delete(requestSequence);
      throw new Error("Preview Webview rejected the render publication");
    }
    const abort = () => {
      const pending = pendingWebviewPublications.get(requestSequence);
      if (!pending) return;
      pendingWebviewPublications.delete(requestSequence);
      pending.reject(publication.signal?.reason instanceof Error
        ? publication.signal.reason
        : new DOMException("Aborted", "AbortError"));
    };
    publication.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await acknowledgement;
    } finally {
      publication.signal?.removeEventListener("abort", abort);
    }
  };
  const publishRendererFrameToWebview = async (
    candidate: PreviewRendererCandidate,
    binding: TypstPreviewBinding,
  ): Promise<PreviewVisualReadyMessage> => {
    const panel = previewPanel;
    if (!panel) throw new Error("Preview Webview is closed");
    await waitForPreviewWebview(binding.signal);
    binding.signal?.throwIfAborted();
    const requestSequence = webviewPublicationSequence++;
    const acknowledgement = new Promise<PreviewVisualReadyMessage>((resolve, reject) => {
      pendingWebviewPublications.set(requestSequence, {
        renderKey: binding.renderKey,
        resolve,
        reject,
      });
    });
    const publishedAtEpochMs = Date.now();
    const delivered = await panel.webview.postMessage({
      type: "render-frame",
      sessionId: candidate.sessionId,
      frameKind: candidate.ready.frameKind,
      dataBase64: candidate.ready.dataBase64,
      byteLength: candidate.ready.byteLength,
      artifactDigest: candidate.ready.artifactDigest,
      sourceDigest: candidate.ready.sourceDigest,
      backendGeneration: candidate.backendGeneration,
      rendererGeneration: candidate.ready.generation,
      baseGeneration: candidate.ready.baseGeneration,
      requestSequence,
      traceId: binding.traceId,
      renderKey: binding.renderKey,
      publishedAtEpochMs,
    });
    if (!delivered || panel !== previewPanel) {
      pendingWebviewPublications.delete(requestSequence);
      throw new Error("Preview Webview rejected the renderer frame");
    }
    const abort = () => {
      const pending = pendingWebviewPublications.get(requestSequence);
      if (!pending) return;
      pendingWebviewPublications.delete(requestSequence);
      pending.reject(binding.signal?.reason instanceof Error
        ? binding.signal.reason
        : new DOMException("Aborted", "AbortError"));
    };
    binding.signal?.addEventListener("abort", abort, { once: true });
    try {
      const ready = await acknowledgement;
      const renderer = ready.renderer;
      if (!renderer
        || renderer.sessionId !== candidate.sessionId
        || renderer.artifactDigest !== candidate.ready.artifactDigest
        || renderer.sourceDigest !== candidate.ready.sourceDigest
        || renderer.backendGeneration !== candidate.backendGeneration
        || renderer.generation !== candidate.ready.generation
        || renderer.baseGeneration !== candidate.ready.baseGeneration
        || renderer.frameKind !== candidate.ready.frameKind
        || renderer.byteLength !== candidate.ready.byteLength
        || renderer.pageGeometries.length !== candidate.ready.pageCount) {
        throw new Error("Preview Webview renderer acknowledgement identity mismatch");
      }
      return ready;
    } finally {
      binding.signal?.removeEventListener("abort", abort);
    }
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
        if (displayedPreviewSourceUri === identity.sourceUri) exactExportUi.bind(identity.sourceUri);
      }
      log(message.includes("WASM") ? "wasm" : (error ? "preview:error" : "preview"), message);
      if (previewPanel) void previewPanel.webview.postMessage({ type: "status", message, error });
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
      if (!identity || !previewBuildState.isCurrent(identity)) {
        trace?.increment("staleDiscards");
        trace?.finish("stale-discarded");
        if (revision.traceId) previewTraces.delete(revision.traceId);
        return;
      }
      const ready = await publishFullSvgToWebview(publication, revision);
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
    packageGenerations: readonly TypstPackageGeneration[],
    trace?: PreviewTraceSession,
  ): Promise<PreviewArtifact | undefined> => {
    const sessions = previewRendererSessions;
    if (!sessions) throw new Error("Preview renderer session owner is unavailable");
    const logicalSource = await canonicalBytesDigest(
      "mmt-preview-renderer-logical-source-v1",
      [encoder.encode(project.sourceUri)],
    );
    const fonts = await previewRendererFontFiles();
    let candidate: PreviewRendererCandidate | undefined;
    let committed = false;
    try {
      const rendererStarted = performance.now();
      candidate = await sessions.render(
        project,
        { logicalSourceId: logicalSource, fonts },
        binding.renderKey,
        binding.signal,
      );
      if (candidate.ready.frameKind === "diff-v1" && (
        !previewWebviewRendererGeneration
        || previewWebviewRendererGeneration.sessionId !== candidate.sessionId
        || previewWebviewRendererGeneration.backendGeneration !== candidate.backendGeneration
        || previewWebviewRendererGeneration.generation !== candidate.ready.baseGeneration
      )) {
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
      if (binding.signal?.aborted || !identity || !previewBuildState.isCurrent(identity)) {
        await sessions.discard(candidate);
        candidate = undefined;
        trace?.increment("staleDiscards");
        return undefined;
      }
      const ready = await publishRendererFrameToWebview(candidate, binding);
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
      previewWebviewRendererGeneration = Object.freeze({
        sessionId: candidate.sessionId,
        backendGeneration: candidate.backendGeneration,
        generation: candidate.ready.generation,
      });
      if (previewWebviewRendererResyncRequested) {
        if (previewWebviewRendererResyncRequested.sessionId === candidate.sessionId
          && previewWebviewRendererResyncRequested.generation === candidate.ready.generation) {
          previewWebviewRendererGeneration = undefined;
        }
        previewWebviewRendererResyncRequested = undefined;
      }

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
      if (!immutableRendererExports.has(binding.renderKey)) {
        immutableRendererExports.set(binding.renderKey, {
          sourceUri: project.sourceUri,
          snapshot: cloneImmutableTypstExportSnapshot(project, packageGenerations),
          pins: 0,
        });
      }
      evictImmutableRendererExports(binding.renderKey);
      const artifact = createPreviewArtifact({
        renderKey: binding.renderKey,
        sourceUri: project.sourceUri,
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
        locatePoint: async (request, signal) => sessions.locatePoint(candidate!, {
          pageIndex: request.pageIndex,
          x: request.x,
          y: request.y,
        }, signal),
      };
      Object.freeze(resolver);
      displayPreviewArtifact(artifact, binding.identity, resolver, false);
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
        await sessions.closeSource(project.sourceUri);
        previewWebviewRendererGeneration = undefined;
        previewWebviewRendererResyncRequested = undefined;
        if (previewPanel) void previewPanel.webview.postMessage({ type: "renderer-reset" });
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
    if (!document) {
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
    const operationSignal = signal ?? new AbortController().signal;
    operationSignal.throwIfAborted();
    const packageGenerations = await typstPackageService.prepareProject(project.projectDigest, operationSignal);
    installPreviewPackageGenerations(packageGenerations);
    const binding = {
      ...await previewBindingFor(project, document, packageGenerations, requestId, trace?.traceId),
      signal: operationSignal,
    };
    trace?.renderKey(binding.renderKey);
    if (previewFixtureActiveSourceUri === project.sourceUri) {
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
        && !retainedArtifact.stale) {
        artifact = retainedArtifact;
        const retainedIdentity = currentPreviewBuildIdentity({
          sourceUri: project.sourceUri,
          sourceVersion: project.sourceVersion,
          revision: project.revision,
          requestId: binding.requestId,
          traceId: binding.traceId,
        });
        if (retainedIdentity) previewBuildState.complete(retainedIdentity);
      } else if (previewRendererEnabled) {
        if (!previewRendererSessions || tinymist?.backend.capabilities().has(PREVIEW_RENDERER_METHOD) !== true) {
          throw new Error("Qualified incremental preview renderer is unavailable");
        }
        artifact = await renderWithPersistentRenderer(project, binding, packageGenerations, trace);
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
      controller.stores.previewArtifacts.put(artifact);
      controller.stores.previewArtifacts.display(project.sourceUri, binding.renderKey);
    } catch (error) {
      if (operationSignal.aborted) {
        trace?.finish("aborted");
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
      if (failedIdentity) {
        previewBuildState.fail(
          failedIdentity,
          "renderer",
          error instanceof Error ? error.message : String(error),
        );
      }
      trace?.finish("failed");
      if (trace) previewTraces.delete(trace.traceId);
      controller.stores.previewArtifacts.fail(project.sourceUri, binding.renderKey);
      if (displayedPreviewSourceUri === project.sourceUri) exactExportUi.bind(project.sourceUri);
      throw error;
    }
    const advance = exactExportAdvanceBySource.get(project.sourceUri);
    if (!advance) {
      exactExportHost?.latest.publish(project.sourceUri, binding.renderKey);
    } else if (controller.stores.exactExport?.publishLatest(advance, binding.renderKey)) {
      exactExportAdvanceBySource.delete(project.sourceUri);
      exactExportHost?.latest.publish(project.sourceUri, binding.renderKey);
    }
    if (displayedPreviewSourceUri === project.sourceUri) exactExportUi.bind(project.sourceUri);
    trace?.stage("visualReady", trace.elapsedMs);
    trace?.finish("published");
    if (trace) previewTraces.delete(trace.traceId);
  };
  let fixtureProviderKey: LocationProviderKey | undefined;
  let fixtureSelection: PreviewEditorSelection | undefined;
  if (import.meta.env.VITE_MMT_E2E === "1") {
    exposeRuntimeGlobal("__mmtSetPreviewRendererEnabled", (enabled: boolean) => {
      if (enabled && !previewRendererSessions) {
        throw new Error("Qualified incremental preview renderer is unavailable");
      }
      previewRendererEnabled = enabled;
      return previewRendererEnabled;
    });
    exposeRuntimeGlobal("__mmtPreviewInteractionFixture", async (request: PreviewInteractionFixtureRequest) => {
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
        previewPanel?.reveal(undefined, false);
        return previewPanel !== undefined;
      }
      if (request.action === "overlay") {
        return request.point ? Boolean(await previewPanel?.webview.postMessage({ type: "indicator", point: request.point })) : false;
      }
      if (request.action === "resync-renderer") {
        previewWebviewRendererGeneration = undefined;
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
        previewInteraction.providerRestarted(restarted);
        return true;
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
          locationProviderKey: fixtureProviderKey,
          visualSnapshot: { kind: "svg", pages, imageAssets: [] },
        });
        displayPreviewArtifact(artifact, identity, {
          key: fixtureProviderKey,
          async locateSelection() { return [{ pageIndex: 0, x: 0.2, y: 0.15 }, { pageIndex: 1, x: 0.9, y: 0.95 }]; },
          async locatePoint() { return { uri: identity.entryUri, range: selectedRange }; },
        });
        if (previewPanel) {
          previewPanel.reveal(undefined, false);
          await publishFixtureArtifact(artifact);
        }
      } else {
        fixtureProviderKey = undefined;
        const mapDigest = await canonicalBytesDigest("mmt-preview-interaction-map-v1", [encoder.encode(fixtureRenderKey)]);
        const target: PreviewSourceTarget = identity.languageId === "mmt"
          ? { kind: "authoredIdentity", uri: sourceUri, range: selectedRange, readOnly: false, retained: true }
          : { kind: "workspaceTypst", uri: sourceUri, range: selectedRange, readOnly: false, retained: true };
        const artifact = createPreviewArtifact({
          renderKey: fixtureRenderKey,
          sourceUri,
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
        if (previewPanel) {
          previewPanel.reveal(undefined, false);
          await publishFixtureArtifact(artifact);
        }
      }
      return true;
    });
  }
  let exactExportFixtureNext: PreviewArtifact | undefined;
  let exactExportFixtureAdvance: RenderAdvanceToken | undefined;
  if (import.meta.env.VITE_MMT_E2E === "1") {
    exposeRuntimeGlobal("__mmtExactExportFixture", async (request: ExactExportFixtureRequest) => {
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
        if (previewPanel) {
          previewPanel.reveal(undefined, false);
          await publishFixtureArtifact(displayed);
        }
      };
      if (request.action === "install") {
        previewFixtureActiveSourceUri = sourceUri;
        materializationControllers.get(sourceUri)?.abort();
        preview.invalidate();
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
    });
  }
  let workspaceAssetMirror!: WorkspaceAssetMirror;
  const materializedResourceCache = new BoundedStringCache(MATERIALIZED_RESOURCE_CACHE_MAX_BYTES);
  const previewClock = new RevisionPinnedPreviewClock();
  if (import.meta.env.VITE_MMT_E2E === "1") {
    exposeRuntimeGlobal("__mmtLatestProjectionRevision", () => {
      const sourceUri = vscode.window.activeTextEditor?.document.uri.toString();
      return sourceUri ? latestLanguageProjectionBySource.get(sourceUri)?.revision : undefined;
    });
    exposeRuntimeGlobal("__mmtLanguageProjectionEntry", (name: string) => {
      const uri = vscode.Uri.joinPath(WORKSPACE, name).toString();
      const project = acceptedPreviewLanguageProjects!.get(uri);
      if (!project) return null;
      const entry = project.files.find((file) => file.uri === project.entryUri);
      return { sourceVersion: project.sourceVersion, text: entry?.text };
    });
    exposeRuntimeGlobal("__mmtPreviewBuildDiagnostics", (sourceUri: string) => previewBuildState.diagnostics(sourceUri));
  }
  if (import.meta.env.VITE_MMT_E2E === "1") {
    exposeRuntimeGlobal("__mmtDisplayedPreviewSourceUri", () => displayedPreviewSourceUri);
  }
  const refreshOpenedPreview = () => {
    if (!displayedPreviewSourceUri) return;
    const project = previewProjects.get(displayedPreviewSourceUri);
    if (project) void renderPreview(project);
  };
  const closePreviewProject = (sourceUri: string) => {
    controller.stores.closeSource(sourceUri);
    void previewRendererSessions?.closeSource(sourceUri);
    renderProjectSnapshots.close(sourceUri);
    for (const [renderKey, retained] of immutableRendererExports) {
      if (retained.sourceUri === sourceUri) immutableRendererExports.delete(renderKey);
    }
    exactExportAdvanceBySource.delete(sourceUri);
    exactExportHost?.latest.closeSource(sourceUri);
    previewBuildState.clear(sourceUri);
    if (displayedPreviewSourceUri === sourceUri) previewPanel?.dispose();
  };
  try {
    provider = own(await MmtIndexedDbFileSystemProvider.open());
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
  await api.start();
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
    if (event.affectsConfiguration("mmt.preview.performance.enabled")) {
      controller.stores.previewPerformance.setEnabled(previewPerformanceEnabled());
    }
  }));
  if (import.meta.env.VITE_MMT_E2E === "1") {
    exposeRuntimeGlobal("__mmtPreviewTimings", () => controller.stores.previewPerformance.snapshot());
    exposeRuntimeGlobal("__mmtResetPreviewTimings", () => controller.stores.previewPerformance.reset());
    exposeRuntimeGlobal("__mmtPreviewRetainedState", () => ({
      timingSamples: controller.stores.previewPerformance.size,
      previewProjects: previewProjects.size,
      latestProjects: latestProjectBySource.size,
      artifacts: controller.stores.previewArtifacts.size,
      artifactBytes: controller.stores.previewArtifacts.byteSize,
      mappedShadows: preview.mappedShadowCount,
      pendingMaterializations: pendingMaterializations.size,
      activeMaterializations: materializationControllers.size,
    }));
  }
  subscribe(vscode.workspace.registerFileSystemProvider(
    "mmt-package",
    new WebTypstPackageFileSystemProvider(typstPackageCache),
    { isReadonly: true, isCaseSensitive: true },
  ));
  subscribe(registerLocalHistoryCommands(provider));
  if (import.meta.env.VITE_MMT_E2E === "1") {
    exposeRuntimeGlobal("__mmtCreateCheckpoint", (name: string) => provider!.createCheckpoint(name));
    exposeRuntimeGlobal("__mmtDeleteWorkspaceFile", async (name: string) => {
      if (!/^[^./\\][^/\\]*$/.test(name) || name === "..") throw new Error("invalid workspace basename");
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(WORKSPACE, name));
    });
    exposeRuntimeGlobal("__mmtHistoryUsage", () => provider!.historyUsage());
  }
  subscribe(registerCharacterGalleryCommands(() => galleryPacks));
  output = own(vscode.window.createOutputChannel("MomoScript"));
  log("host", "VS Code Workbench ready");
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
      panelOpen: previewPanel !== undefined,
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
  if (import.meta.env.VITE_MMT_E2E === "1") {
    exposeRuntimeGlobal("__mmtPreviewReadiness", previewReadiness);
  }
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
  if (import.meta.env.VITE_MMT_E2E === "1") {
    exposeRuntimeGlobal("__mmtRuntimeStatus", () => runtimeStatus.snapshot());
  }
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
      if (displayedPreviewSourceUri === project.sourceUri && previewPanel) {
        void previewPanel.webview.postMessage({ type: "status", message, error: true });
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
    if (displayedPreviewSourceUri === project.sourceUri && previewPanel) {
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
      || update.entryUri !== token.entryUri
      || update.revision !== token.revision
      || update.sourceVersion !== token.sourceVersion
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
    if (!force && requestedRenderTokens.has(token)) return;
    requestedRenderTokens.add(token);
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
        && projectionSessionKey(renderProjectSnapshots.get(sourceUri)?.entryUri ?? "") === token.session
        ? renderProjectSnapshots.get(sourceUri)
        : undefined;
      const sendRenderRequest = async (forceFull: boolean) => {
        const requestParams: GetTypstRenderProjectParams = {
          uri: sourceUri,
          timestamp,
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
      const responseMatchesToken = (candidate: TypstRenderProjectUpdate | null) => Boolean(
        candidate
        && candidate.entryUri === token.entryUri
        && candidate.revision === token.revision
        && candidate.sourceVersion === token.sourceVersion
        && candidate.traceId === traceId
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
        requestedRenderTokens.delete(token);
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
      requestedRenderTokens.delete(token);
      if (cancellationToken?.isCancellationRequested) {
        finishTrace("coalesced");
        return;
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
  if (import.meta.env.VITE_MMT_E2E === "1") {
    exposeRuntimeGlobal("__mmtRuntimeStatusFixture", (
      recoveryState: RuntimeRecoveryState,
      lastFailure?: string,
    ) => publishRuntimeStatus("e2e-fixture", recoveryState, lastFailure));
  }
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
  try {
    tinymist = await startTinymistLanguageClient(
      (message) => log("wasm", message),
      typstPackageService
    );
    const handle = tinymist;
    own({ dispose: () => handle.dispose() });
    if (previewRendererEnabled) {
      previewRendererSessions = own(new PreviewRendererSessionOwner({ backend: handle.backend }));
    }
    controller.registerTermination(() => handle.terminate());
    const refreshRuntimeQueue = () => publishRuntimeQueue("project-queue-changed");
    own(handle.backend.on("tinymist/projectPrimeStarted", refreshRuntimeQueue));
    own(handle.backend.on("tinymist/projectPrimed", refreshRuntimeQueue));
    own(handle.backend.on("tinymist/projectPrimeFailed", refreshRuntimeQueue));
    own(handle.backend.on("tinymist/clientRestarting", () => {
      previewInteraction.providerRestarted(undefined);
      publishRuntimeStatus("backend-restarting", "recovering");
    }));
    own(handle.backend.on("tinymist/clientRestarted", () => publishRuntimeStatus("backend-restarted", "ready")));
    own(handle.backend.on("tinymist/clientFailed", (params) => {
      const message = params && typeof params === "object" && "message" in params
        ? String(params.message)
        : "Tinymist backend failed";
      publishRuntimeStatus("backend-failed", "failed", message);
    }));
    publishRuntimeStatus("backend-ready", "ready");
    log("tinymist", "Tinymist Worker ready");
  } catch (error) {
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
  if (import.meta.env.VITE_MMT_E2E === "1") {
    exposeRuntimeGlobal("__mmtSyncWorkspaceTypst", async (name: string) => {
      const uri = vscode.Uri.joinPath(WORKSPACE, name).toString();
      const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri);
      if (!document) throw new Error(`workspace document is not open: ${name}`);
      const project = await recognizeAndSyncTypst(document);
      const accepted = project ? tinymist?.backend.projectForEntry(project.entryUri) : undefined;
      return project ? { entryUri: project.entryUri, revision: project.revision, acceptedRevision: accepted?.revision ?? null } : null;
    });
  }
  const typstDocumentOpenRegistration = subscribe(vscode.workspace.onDidOpenTextDocument((document) => {
    void recognizeAndSyncTypst(document).catch((error: unknown) => log("tinymist:error", error instanceof Error ? error.message : String(error)));
  }));
  const typstEditorActivationRegistration = subscribe(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) return;
    rememberActiveWorkspaceDocument(editor.document);
    void recognizeAndSyncTypst(editor.document).catch((error: unknown) => log("tinymist:error", error instanceof Error ? error.message : String(error)));
  }));
  const previewSelectionRegistration = subscribe(vscode.window.onDidChangeTextEditorSelection((event) => {
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
    const sourceUri = event.document.uri.toString();
    if (displayedPreviewSourceUri !== sourceUri) return;
    advanceExactExport(sourceUri, "source");
    controller.stores.previewArtifacts.markStale(sourceUri);
    exactExportUi.bind(sourceUri);
    const project = previewProjects.get(sourceUri) ?? typstProjects.get(sourceUri);
    if (project) previewInteraction.sourceIdentityAdvanced(previewIdentityFor(project, event.document));
  }));
  await Promise.allSettled(vscode.workspace.textDocuments.map((document) => recognizeAndSyncTypst(document)));
  if (vscode.window.activeTextEditor) await recognizeAndSyncTypst(vscode.window.activeTextEditor.document);

  try {
    mmt = await startMmtLanguageClient(Boolean(tinymist), (options) => {
      tinymist?.installMiddleware(options, () => {
        const client = mmt?.client.getLanguageClient();
        if (!client) throw new Error("MMT language client did not start");
        return client;
      });
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
          problems.replacePreview(
            vscode.Uri.parse(identity.sourceUri),
            diagnostics.map(previewProblemDiagnostic)
          );
        },
        clear(sourceUri) {
          problems.clearPreview(vscode.Uri.parse(sourceUri));
        },
      });
    }
    log("mmt", "MMT language server ready");
  } catch (error) {
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
  const documentConfigCommandRegistration = subscribe(vscode.commands.registerCommand("mmt.document.configure", async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== "mmt") {
      void showMomoScriptMessage("warning", "请先打开一个 MomoScript 文档。");
      return;
    }
    try {
      if (!activeClient) throw new Error("MMT 语言服务器不可用");
      await configureDocumentSettings(document, activeClient);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log("document:error", detail);
      void showMomoScriptMessage("error", `文档设置失败：${detail}`);
    }
  }));
  const previewCommandRegistration = subscribe(vscode.commands.registerCommand("mmt.preview.open", async (resource?: vscode.Uri) => {
    const resourceDocument = resource
      ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === resource.toString())
      : undefined;
    const document = resourceDocument ?? vscode.window.activeTextEditor?.document;
    if (!document || !["mmt", "typst"].includes(document.languageId)) {
      void showMomoScriptMessage("warning", "请先打开一个 MomoScript 或 Typst 文档，再启动预览。");
      return;
    }
    const sourceUri = document.uri.toString();
    previewFixtureActiveSourceUri = undefined;
    displayedPreviewSourceUri = sourceUri;
    refreshBuildStatus();
    exactExportUi.bind(sourceUri);
    previewPanelTitle = `${document.uri.path.split("/").at(-1) ?? "文档"}（预览）`;
    if (!previewPanel) {
      previewPanel = own(vscode.window.createWebviewPanel(
        "mmt.typstPreview",
        previewPanelTitle,
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [previewWebviewRuntimeResourceRoot()],
        }
      ));
      previewPanelDisposeRegistration = subscribe(previewPanel.onDidDispose(() => {
        previewPanel = undefined;
        previewWebviewReady = false;
        previewWebviewRendererGeneration = undefined;
        previewWebviewRendererResyncRequested = undefined;
        for (const pending of pendingWebviewPublications.values()) {
          pending.reject(new Error("Preview Webview closed before visual readiness"));
        }
        pendingWebviewPublications.clear();
        exactExportUi.bind(undefined);
        displayedPreviewSourceUri = undefined;
        refreshBuildStatus();
        previewPanelDisposeRegistration?.dispose();
        previewPanelDisposeRegistration = undefined;
        previewPanelMessageRegistration?.dispose();
        previewPanelMessageRegistration = undefined;
        for (const trace of previewTraces.values()) trace.finish("aborted");
        previewTraces.clear();
        void preview.close();
        log("preview", "Preview editor closed");
      }));
      previewPanelMessageRegistration = subscribe(previewPanel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (isPreviewWebviewReadyMessage(message)) {
          previewWebviewReady = true;
          for (const ready of previewWebviewReadyWaiters) ready();
          previewWebviewReadyWaiters.clear();
          void previewPanel?.webview.postMessage({ type: "exactExportState", state: exactExportUi.state });
          return;
        }
        if (isPreviewVisualReadyMessage(message)) {
          const pending = pendingWebviewPublications.get(message.requestSequence);
          if (!pending) return;
          pendingWebviewPublications.delete(message.requestSequence);
          if (pending.renderKey !== message.renderKey) {
            pending.reject(new Error("Preview Webview visual-ready render key mismatch"));
          } else {
            pending.resolve(message);
          }
          return;
        }
        if (isPreviewRendererResyncNeededMessage(message)) {
          const current = previewWebviewRendererGeneration;
          if (current?.sessionId === message.sessionId && current.generation === message.generation) {
            previewWebviewRendererGeneration = undefined;
          } else if (!current || (current.sessionId === message.sessionId && current.generation < message.generation)) {
            previewWebviewRendererResyncRequested = message;
          }
          return;
        }
        if (isPreviewRenderRejectedMessage(message)) {
          const pending = pendingWebviewPublications.get(message.requestSequence);
          if (!pending) return;
          pendingWebviewPublications.delete(message.requestSequence);
          pending.reject(new Error(message.error));
          return;
        }
        if (isPreviewViewportMessage(message)) {
          previewInteraction.updateViewport(message.viewport);
          return;
        }
        if (isPreviewNavigateMessage(message)) {
          await previewInteraction.navigatePreviewPoint(message.point);
          return;
        }
        if (isExactExportCancelMessage(message)) {
          exactExportUi.cancel();
          return;
        }
        if (!isExportMessage(message)) return;
        const sourceName = displayedPreviewSourceUri ? new URL(displayedPreviewSourceUri).pathname.split("/").at(-1) : "document";
        const baseName = (sourceName ?? "document").replace(/\.(?:mmt(?:\.txt)?|typ)$/i, "") || "document";
        let exported: Awaited<ReturnType<typeof exactExportUi.export>>;
        const exportSourceUri = displayedPreviewSourceUri;
        const exportRenderKey = preview.displayedRenderKey;
        if (previewSchedulerEnabled && exportSourceUri && exportRenderKey) {
          const sequence = previewRenderQueue.enqueueExport({
            sourceUri: exportSourceUri,
            renderKey: exportRenderKey,
            traceId: controller.stores.previewPerformance.enabled ? crypto.randomUUID() : "",
          }, async (_accepted, signal) => {
            const cancel = () => exactExportUi.cancel();
            signal.addEventListener("abort", cancel, { once: true });
            try {
              exported = await exactExportUi.export(message.format, message.staleChoice);
            } finally {
              signal.removeEventListener("abort", cancel);
            }
          });
          await previewRenderQueue.waitForExport(exportSourceUri, sequence);
        } else {
          exported = await exactExportUi.export(message.format, message.staleChoice);
        }
        if (!exported) return;
        downloadBlob(exported.blob, `${baseName}.${exported.extension}`);
        log("export", `Downloaded ${baseName}.${exported.extension} from ${exported.metadata.renderKey}`);
      }));
      previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle);
    } else {
      previewPanel.title = previewPanelTitle;
      previewPanel.reveal(undefined, false);
    }
    await waitForPreviewWebview();
    log("preview", `Opening ${sourceUri}`);
    if (document.languageId === "typst") {
      void previewPanel.webview.postMessage({ type: "status", message: "正在准备 Typst 预览…", error: false });
      const project = await buildTypstProject(document, typstRevisions);
      if (previewFixtureActiveSourceUri === sourceUri) return;
      typstProjects.set(sourceUri, project);
      syncTinymistProject(project);
      previewBuildState.activate(previewBuildIdentityFor(project, document));
      await renderPreview(project);
      return;
    }
    if (!activeClient) {
      const message = "MomoScript 语言服务器不可用；Typst 编辑与语言服务仍可继续使用。";
      void previewPanel.webview.postMessage({ type: "status", message, error: true });
      return;
    }
    void previewPanel.webview.postMessage({ type: "status", message: "正在准备 MomoScript 投影…", error: false });
    let project: TypstProjectUpdate | null;
    try {
      project = await waitForSynchronizedLanguageProjection(
        () => activeClient.sendRequest<TypstProjectUpdate | null>("mmt/getTypstProject", { uri: sourceUri }),
        document.version
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `无法为 ${document.fileName} 构建 Typst 投影：${detail}`;
      void previewPanel.webview.postMessage({ type: "status", message, error: true });
      log("preview:error", message);
      return;
    }
    if (displayedPreviewSourceUri !== sourceUri) return;
    if (!project) {
      const message = `语言服务器未能及时同步 ${document.fileName} 的文档版本 ${document.version}。`;
      void previewPanel.webview.postMessage({ type: "status", message, error: true });
      log("preview:error", message);
      return;
    }
    const tracked = trackLanguageProjection(project);
    if (!tracked) return;
    if (tracked.advanced) syncTinymistProject(project);
    await dispatchRenderProject(activeClient, project.sourceUri, tracked.token, true);
    refreshOpenedPreview();
  }));

  packCache = own(await IndexedDbPackCache.open());
  const syncConfiguredPackSources = async () => {
    if (!activeClient) {
      log("resources", "Skipped resource pack synchronization because the MomoScript language server is unavailable");
      return;
    }
    const configured = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_URL]);
    const packSources = await synchronizePackSources(
      configured,
      Date.now(),
      packCache!,
      (params) => activeClient.sendRequest("mmt/updatePackManifests", params),
      fetchManifest
    );
    packSourcesByNamespace.clear();
    const projected: GalleryPack[] = [];
    for (const source of packSources) {
      try {
        projected.push(projectGalleryPack(source));
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
  const packConfigRegistration = subscribe(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("mmt.resourcePacks.manifestUrls")) return;
    const values = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_URL]);
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
    if (!event.affectsConfiguration("mmt.preview.onChange") || !previewOnChange()) return;
    const sourceUri = vscode.window.activeTextEditor?.document.uri.toString();
    const token = sourceUri ? latestLanguageProjectionBySource.get(sourceUri) : undefined;
    if (!sourceUri || !token) return;
    if (activeClient) void schedulePreviewIfEnabled(activeClient, sourceUri, token).catch((error: unknown) => {
      log("preview:error", error instanceof Error ? error.message : String(error));
    });
  }));
  const packUrls = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_URL]);
  const packUrlsInput = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Resource pack manifest URLs"]');
  if (packUrlsInput) packUrlsInput.value = packUrls.join("\n");

  const restoredActiveDocument = await restoreActiveWorkspaceDocument();
  if (!restoredActiveDocument && !vscode.window.activeTextEditor) {
    const initialDocument = await vscode.workspace.openTextDocument(INTRO);
    const recognizedDocument = initialDocument.languageId === "typst"
      ? initialDocument
      : await vscode.languages.setTextDocumentLanguage(initialDocument, "typst");
    await vscode.window.showTextDocument(recognizedDocument);
  }
  const modelService = await getService(IModelService);
  const codeEditorService = await getService(ICodeEditorService);
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
        await vscode.workspace.fs.writeFile(snapshot.documentUri, encoder.encode(snapshot.text));
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
  document.documentElement.dataset.mmtLanguageId = vscode.window.activeTextEditor?.document.languageId ?? "";
  document.documentElement.dataset.mmtWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "";
  const typstDocumentChangeRegistration = subscribe(vscode.workspace.onDidChangeTextDocument((event) => {
    if (!controller.acceptingWork) return;
    void recognizeAndSyncTypst(event.document, true).then((project) => {
      if (!project) return;
      const sourceUri = event.document.uri.toString();
      typstProjects.set(sourceUri, project);
      if (displayedPreviewSourceUri === sourceUri) {
        previewBuildState.activate(previewBuildIdentityFor(project, event.document));
        return renderPreview(project);
      }
    }).catch((error: unknown) => log("preview:error", `Typst: ${error instanceof Error ? error.message : String(error)}`));
  }));
  const safeRestart = new PwaSafeRestartQuiesceAdapter({
    pauseNewWork() {
      return controller.pauseNewWork();
    },
    requireWriter() {
      if (provider?.coordinator.state.lease !== "writer") throw new Error("Safe restart requires the workspace writer lease");
    },
    assertWorkspaceSafe() {
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
      await Promise.all([...persistenceByUri.values()]);
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
  Reflect.set(globalThis, "__mmtPwaSafeRestart", safeRestart);
  subscribe({
    dispose() {
      if (Reflect.get(globalThis, "__mmtPwaSafeRestart") === safeRestart) Reflect.deleteProperty(globalThis, "__mmtPwaSafeRestart");
    },
  });
  if (import.meta.env.PROD && import.meta.env.VITE_MMT_E2E !== "1") {
    own(registerPwaUpdateLifecycle({
      prepareForReload: () => safeRestart.prepareForReload(10_000),
      async promptForReload() {
        const update = "安全更新并重启";
        return await showMomoScriptMessage(
          "info",
          "MomoScript 已准备好离线更新。保存并安全重启以启用新版本。",
          [update],
          { id: "pwa-update-ready" },
        ) === update;
      },
      report(message, error) {
        const detail = error instanceof Error ? error.message : String(error ?? "");
        log("pwa:update", `${message}${detail ? `: ${detail}` : ""}`);
        if (error) void showMomoScriptMessage("error", `${message}: ${detail}`);
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
  subscribe(ownEventListener(window, "beforeunload", () => {
    recordE2ELifecycle("unload", lifecycleGeneration);
    controller.terminateAndDispose();
  }, { once: true }));
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
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


function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
  const response = await fetch(url, { headers });
  return {
    status: response.status,
    ok: response.ok,
    etag: response.headers.get("etag") ?? undefined,
    text: () => response.text()
  };
}

interface ExactExportWebviewMessage {
  readonly type: "exact-export";
  readonly format: ExactExportFormat;
  readonly staleChoice?: StaleExportChoice;
}

function isExportMessage(value: unknown): value is ExactExportWebviewMessage {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "exact-export") return false;
  if (!("format" in value) || !["pdf", "png", "jpg", "svg"].includes(String(value.format))) return false;
  if (!("staleChoice" in value) || value.staleChoice === undefined) return true;
  return value.staleChoice === "export-displayed" || value.staleChoice === "wait-for-latest";
}

function isExactExportCancelMessage(value: unknown): value is { readonly type: "exact-export-cancel" } {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "exact-export-cancel");
}

interface PreviewRendererReadyMetadata {
  readonly sessionId: string;
  readonly artifactDigest: string;
  readonly sourceDigest: string;
  readonly backendGeneration: number;
  readonly generation: number;
  readonly baseGeneration: number;
  readonly frameKind: "new" | "diff-v1";
  readonly byteLength: number;
  readonly pageGeometries: readonly {
    readonly offsetY: number;
    readonly pageIndex: number;
    readonly width: number;
    readonly height: number;
  }[];
  readonly patchedNodes: number;
  readonly reusedNodes: number;
  readonly removedNodes: number;
  readonly pageBuffers: number;
  readonly frameDecodeMs: number;
  readonly rendererApplyMs: number;
}

interface PreviewVisualReadyMessage {
  readonly type: "visual-ready";
  readonly requestSequence: number;
  readonly traceId?: string;
  readonly renderKey: RenderKey;
  readonly locations: readonly RenderArtifactLocation[];
  readonly domUpdateMs: number;
  readonly locationMeasureMs: number;
  readonly renderer?: PreviewRendererReadyMetadata;
  readonly viewportRenderMs?: number;
  readonly iframeTransferMs?: number;
}

function isPreviewWebviewReadyMessage(value: unknown): value is { readonly type: "ready" } {
  return Boolean(value && typeof value === "object" && "type" in value && value.type === "ready");
}

function isPreviewRenderRejectedMessage(
  value: unknown,
): value is { readonly type: "render-rejected"; readonly requestSequence: number; readonly renderKey: RenderKey; readonly error: string } {
  if (!value || typeof value !== "object") return false;
  const message = value as { type?: unknown; requestSequence?: unknown; renderKey?: unknown; error?: unknown };
  return message.type === "render-rejected"
    && Number.isSafeInteger(message.requestSequence)
    && typeof message.renderKey === "string"
    && typeof message.error === "string";
}

function isPreviewRendererResyncNeededMessage(
  value: unknown,
): value is { readonly type: "renderer-resync-needed"; readonly sessionId: string; readonly generation: number } {
  if (!value || typeof value !== "object") return false;
  const message = value as { type?: unknown; sessionId?: unknown; generation?: unknown };
  return message.type === "renderer-resync-needed"
    && typeof message.sessionId === "string"
    && message.sessionId.length > 0
    && Number.isSafeInteger(message.generation)
    && Number(message.generation) > 0;
}

function isPreviewVisualReadyMessage(value: unknown): value is PreviewVisualReadyMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<PreviewVisualReadyMessage>;
  return message.type === "visual-ready"
    && Number.isSafeInteger(message.requestSequence)
    && typeof message.renderKey === "string"
    && Array.isArray(message.locations)
    && typeof message.domUpdateMs === "number"
    && Number.isFinite(message.domUpdateMs)
    && message.domUpdateMs >= 0
    && typeof message.locationMeasureMs === "number"
    && Number.isFinite(message.locationMeasureMs)
    && message.locationMeasureMs >= 0
    && (message.viewportRenderMs === undefined
      || (typeof message.viewportRenderMs === "number"
        && Number.isFinite(message.viewportRenderMs)
        && message.viewportRenderMs >= 0))
    && (message.iframeTransferMs === undefined
      || (typeof message.iframeTransferMs === "number"
        && Number.isFinite(message.iframeTransferMs)
        && message.iframeTransferMs >= 0))
    && (message.renderer === undefined || isPreviewRendererReadyMetadata(message.renderer));
}

function isPreviewRendererReadyMetadata(value: unknown): value is PreviewRendererReadyMetadata {
  if (!value || typeof value !== "object") return false;
  const renderer = value as Partial<PreviewRendererReadyMetadata>;
  return typeof renderer.sessionId === "string"
    && renderer.sessionId.length > 0
    && typeof renderer.artifactDigest === "string"
    && typeof renderer.sourceDigest === "string"
    && Number.isSafeInteger(renderer.backendGeneration)
    && Number(renderer.backendGeneration) > 0
    && Number.isSafeInteger(renderer.generation)
    && Number(renderer.generation) > 0
    && Number.isSafeInteger(renderer.baseGeneration)
    && Number(renderer.baseGeneration) >= 0
    && (renderer.frameKind === "new" || renderer.frameKind === "diff-v1")
    && Number.isSafeInteger(renderer.byteLength)
    && Number(renderer.byteLength) > 0
    && Array.isArray(renderer.pageGeometries)
    && renderer.pageGeometries.length > 0
    && renderer.pageGeometries.every((geometry) => Boolean(
      geometry
      && typeof geometry === "object"
      && Number.isSafeInteger(geometry.pageIndex)
      && Number(geometry.pageIndex) >= 0
      && typeof geometry.offsetY === "number"
      && Number.isFinite(geometry.offsetY)
      && geometry.offsetY >= 0
      && typeof geometry.width === "number"
      && Number.isFinite(geometry.width)
      && geometry.width > 0
      && typeof geometry.height === "number"
      && Number.isFinite(geometry.height)
      && geometry.height > 0
    ))
    && renderer.pageGeometries.every((geometry, index, geometries) => (
      geometry.pageIndex === index
      && geometry.offsetY === (index === 0 ? 0 : geometries[index - 1].offsetY + geometries[index - 1].height)
    ))
    && Number.isSafeInteger(renderer.patchedNodes) && Number(renderer.patchedNodes) >= 0
    && Number.isSafeInteger(renderer.reusedNodes) && Number(renderer.reusedNodes) >= 0
    && Number.isSafeInteger(renderer.removedNodes) && Number(renderer.removedNodes) >= 0
    && Number.isSafeInteger(renderer.pageBuffers)
    && Number(renderer.pageBuffers) >= 0 && Number(renderer.pageBuffers) <= 8
    && typeof renderer.frameDecodeMs === "number"
    && Number.isFinite(renderer.frameDecodeMs) && renderer.frameDecodeMs >= 0
    && typeof renderer.rendererApplyMs === "number"
    && Number.isFinite(renderer.rendererApplyMs) && renderer.rendererApplyMs >= 0;
}

function isPreviewViewportMessage(value: unknown): value is { type: "viewport"; viewport: PreviewViewport } {
  if (!value || typeof value !== "object") return false;
  const message = value as { type?: unknown; viewport?: Partial<PreviewViewport> };
  const viewport = message.viewport;
  return message.type === "viewport"
    && Boolean(viewport)
    && typeof viewport?.page === "number"
    && typeof viewport.x === "number"
    && typeof viewport.y === "number"
    && typeof viewport.zoom === "number"
    && (viewport.fitMode === "manual" || viewport.fitMode === "width" || viewport.fitMode === "page");
}

function isPreviewNavigateMessage(value: unknown): value is { type: "navigate"; point: PreviewPagePoint } {
  if (!value || typeof value !== "object") return false;
  const message = value as { type?: unknown; point?: Partial<PreviewPagePoint> };
  return message.type === "navigate"
    && Boolean(message.point)
    && typeof message.point?.pageIndex === "number"
    && typeof message.point.x === "number"
    && typeof message.point.y === "number";
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function previewNonce(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function previewWebviewRuntimeResourceUri(): vscode.Uri {
  return vscode.Uri.parse(new URL(previewWebviewRuntimeUrl, location.href).href);
}

function previewWebviewRuntimeResourceRoot(): vscode.Uri {
  return vscode.Uri.parse(new URL(".", previewWebviewRuntimeResourceUri().toString()).href);
}

function previewWebviewHtml(webview: vscode.Webview, title: string): string {
  const nonce = previewNonce();
  const runtimeUri = webview.asWebviewUri(previewWebviewRuntimeResourceUri()).toString();
  const formats = [
    ["pdf", "PDF document"],
    ["png", "PNG image"],
    ["jpg", "JPEG image"],
    ["svg", "SVG vector"],
  ].map(([format, label]) => `<option value="${format}">${label}</option>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src blob: ${escapeHtml(webview.cspSource)}; img-src data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${escapeHtml(webview.cspSource)}; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; min-height: 100%; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    body { box-sizing: border-box; font-family: var(--vscode-font-family); }
    .preview-toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 34px; padding: 4px 12px; box-sizing: border-box; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
    .zoom-controls { display: flex; align-items: center; gap: 5px; }
    .zoom-controls button, .exact-export button, .exact-export select { min-height: 26px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    .zoom-label { width: 44px; color: var(--vscode-descriptionForeground); font: 12px var(--vscode-editor-font-family); text-align: center; }
    .exact-export { display: grid; grid-template-columns: auto auto; align-items: center; justify-content: end; gap: 4px 6px; min-width: 0; }
    .exact-export-format { display: inline-flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .exact-export button { padding: 3px 8px; }
    .exact-export select:disabled, .exact-export button:disabled { cursor: not-allowed; opacity: .55; }
    .exact-export-stale { display: flex; gap: 4px; }
    .exact-export-stale[hidden], .exact-export [hidden] { display: none; }
    .exact-export-status { grid-column: 1 / -1; max-width: 520px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 11px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
    .exact-export[data-availability="stale"] .exact-export-status { color: var(--vscode-editorWarning-foreground, #cca700); }
    .exact-export[data-availability="failed"] .exact-export-status, .exact-export[data-phase="error"] .exact-export-status { color: var(--vscode-errorForeground); }
    .viewport { display: flex; justify-content: center; min-width: min-content; height: calc(100vh - 43px); overflow: auto; box-sizing: border-box; padding: 24px; background: #e5e5e5; }
    .page { position: relative; flex: 0 0 auto; background: transparent; line-height: 0; box-shadow: 0 2px 5px #0008; transform-origin: top left; }
    .page > svg { display: block; width: 100%; height: 100%; max-width: none; }
    .page > .typst-renderer-root { display: block; width: 100%; height: 100%; max-width: none; user-select: text; }
    .page > .typst-renderer-root text { cursor: text; user-select: text; }
    .page .tsel { contain: layout paint style; left: 0; position: fixed; width: 100%; height: 100%; overflow: hidden; color: transparent; font-family: monospace; line-height: normal; text-align: left; text-align-last: left; white-space: pre; pointer-events: auto; user-select: text; cursor: text; transform: translateY(0.32em); transform-origin: left top; -webkit-text-size-adjust: none; text-size-adjust: none; }
    .page .tsel .tsel-token { display: inline-block; position: relative; width: 0.602em; height: 1em; line-height: normal; }
    .page .tsel::selection, .page .tsel .tsel-token::selection { color: transparent; background: #7db9dea0; }
    .preview-indicator, .preview-cursor { position: absolute; z-index: 4; pointer-events: none; transform: translate(-50%, -50%); }
    .preview-indicator { width: 18px; height: 18px; border: 2px solid #007acc; border-radius: 50%; background: #007acc28; box-shadow: 0 0 0 4px #007acc24; }
    .preview-cursor { width: 2px; height: 20px; background: #d16969; box-shadow: 0 0 0 1px #fff8; }
    .status { display: grid; min-height: 100vh; place-items: center; color: var(--vscode-descriptionForeground); }
    .status.error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>
  <nav class="preview-toolbar" aria-label="预览操作">
    <div class="zoom-controls">
      <button type="button" data-zoom="out" aria-label="Zoom out">−</button>
      <span class="zoom-label" aria-live="polite">100%</span>
      <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
      <button type="button" data-fit="width">Fit width</button>
      <button type="button" data-fit="page">Fit page</button>
    </div>
    <section class="exact-export" data-mode="exact" data-availability="no-document" data-phase="idle" aria-label="Exact snapshot export">
      <label class="exact-export-format"><span>Format</span><select aria-label="Export format" disabled>${formats}</select></label>
      <button type="button" data-export-action="ready" hidden disabled>Export exact revision</button>
      <div class="exact-export-stale" hidden>
        <button type="button" data-export-action="export-displayed" disabled>Export displayed revision</button>
        <button type="button" data-export-action="wait-for-latest" disabled>Wait for latest</button>
      </div>
      <button type="button" data-export-action="cancel" hidden disabled>Cancel export</button>
      <output class="exact-export-status" role="status">Open a preview to export its output.</output>
    </section>
  </nav>
  <main class="status">Rendering preview…</main>
  <main class="viewport" hidden><article class="page" data-page-index="0"></article></main>
  <script type="module" nonce="${nonce}" src="${escapeHtml(runtimeUri)}"></script>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[character]!);
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
  body.append(activity, primary);
  root.append(body, status);

  const sidebarMainSplit = new SplitView(primary, {
    orientation: Orientation.HORIZONTAL,
    proportionalLayout: false
  });
  sidebarMainSplit.addView(splitViewPart(sidebar, 180, 600), 260);
  sidebarMainSplit.addView(
    splitViewPart(main, 320, Number.POSITIVE_INFINITY),
    Math.max(320, primary.clientWidth - 260)
  );
  sidebarMainSplit.layout(primary.clientWidth);
  sidebarMainSplit.resizeView(0, 260);

  const editorPanelSplit = new SplitView(main, {
    orientation: Orientation.VERTICAL,
    proportionalLayout: false
  });
  editorPanelSplit.addView(
    splitViewPart(editor, 180, Number.POSITIVE_INFINITY),
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
      if (primary.clientWidth > 0) sidebarMainSplit.layout(primary.clientWidth);
      if (main.clientHeight > 0) editorPanelSplit.layout(main.clientHeight);
    });
  };
  const resizeObserver = new ResizeObserver(syncSplitLayout);
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
    setPanelVisible(visible: boolean) {
      if (editorPanelSplit.isViewVisible(1) !== visible) editorPanelSplit.setViewVisible(1, visible);
    },
    setSidebarVisible(visible: boolean) {
      if (sidebarMainSplit.isViewVisible(0) !== visible) sidebarMainSplit.setViewVisible(0, visible);
    },
    dispose() {
      activity.removeEventListener("click", syncActivitySelection, true);
      window.removeEventListener("resize", syncSplitLayout);
      window.visualViewport?.removeEventListener("resize", syncSplitLayout);
      cancelAnimationFrame(layoutFrame);
      resizeObserver.disconnect();
      editorPanelSplit.dispose();
      sidebarMainSplit.dispose();
    }
  };
}

function splitViewPart(
  element: HTMLElement,
  minimumSize: number,
  maximumSize: number
): IView {
  return {
    element,
    minimumSize,
    maximumSize,
    onDidChange: Event.None,
    layout() {}
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
  if (document.version !== expectedVersion) {
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
  documentSettings.append(documentHeading, documentDescription, configureDocument);
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
  urls.value = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_URL]).join("\n");
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
      urls.value = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_URL]).join("\n");
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

