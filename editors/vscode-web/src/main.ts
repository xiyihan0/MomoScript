import "@codingame/monaco-vscode-language-pack-zh-hans";
import * as vscode from "vscode";
import { LogLevel } from "@codingame/monaco-vscode-api";
import { getService, ICodeEditorService, IModelService } from "@codingame/monaco-vscode-api";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
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
import { materializeProjectResources } from "./resourceMaterializer";
import type { MaterializationPackSource, ResourceMaterializationDependencies } from "./resourceMaterializer";
import { mmtExtension } from "./mmtExtension";
import { normalizeResourceLimits } from "./resourceSettings";
import { startMmtLanguageClient } from "./mmtLanguageClient";
import type { MmtLanguageClientHandle } from "./mmtLanguageClient";
import { startTinymistLanguageClient } from "./tinymistLanguageClient";
import type { TinymistHandle } from "./tinymistLanguageClient";
import { synchronizePackSources } from "../../vscode/src/packSync";
import type { PackManifestSource } from "../../vscode/src/packSync";
import { projectionSessionKey } from "../../vscode/src/tinymistClient";
import { sanitizeSvg, TypstPreviewController, type TypstExportFormat, type TypstPreviewBinding } from "./preview";
import { PreviewBuildState } from "./previewDiagnostics";
import { ownEventListener } from "./runtimeOwner";
import { EditorRuntimeController } from "./runtimeController";
import { PwaSafeRestartQuiesceAdapter } from "./pwaSafeRestart";
import { createPreviewArtifact, type LocationProviderKey, type PreviewPagePoint, type PreviewSourceTarget, type PreviewViewport } from "./previewArtifact.ts";
import type {
  PreviewBackendLocation,
  PreviewEditorSelection,
  PreviewSourceIdentity,
  ProjectedPreviewSelection,
} from "./previewInteraction.ts";
import type { TypstProjectUpdate, TypstRenderProjectUpdate, TypstResourceRequest, TypstVirtualFile } from "../../vscode/src/tinymistClient";
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
  type SourceStaleToken,
} from "../../vscode/src/runtimeIdentity";

if (import.meta.env.VITE_MMT_E2E === "1") {
  Reflect.set(globalThis, "__mmtSanitizeSvg", sanitizeSvg);
}

type E2ELifecycleKind = "runtime-ready" | "dispose-invoked" | "dispose-complete" | "unload" | "hmr" | "hmr-fallback";

interface PreviewInteractionFixtureRequest {
  readonly action: "install-provider" | "install-immutable" | "position" | "navigate" | "restart-provider" | "advance-source" | "state";
  readonly range?: { start: { line: number; character: number }; end: { line: number; character: number } };
  readonly point?: PreviewPagePoint;
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



const WORKSPACE = vscode.Uri.parse("mmtfs://workspace/");
const STORY = vscode.Uri.parse("mmtfs://workspace/story.mmt");
const INTRO = vscode.Uri.parse("mmtfs://workspace/intro.typ");
const DEFAULT_DOCUMENT = INTRO;
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
    await vscode.window.showTextDocument(document);
    return uri.toString();
  });
  Reflect.set(globalThis, "__mmtShowWorkspaceDocument", async (name: string) => {
    if (!/^[^./\\][^/\\]*(?:\.mmt(?:\.txt)?|\.typ)$/.test(name)) throw new Error("invalid workspace document basename");
    const uri = vscode.Uri.joinPath(WORKSPACE, name);
    const opened = await vscode.workspace.openTextDocument(uri);
    const expectedLanguage = name.endsWith(".typ") ? "typst" : "mmt";
    const document = opened.languageId === expectedLanguage ? opened : await vscode.languages.setTextDocumentLanguage(opened, expectedLanguage);
    await vscode.window.showTextDocument(document);
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
}
const DEFAULT_STORY = "> 佳代子: 你好，老师！\n>_: 我也可以继续说。\n< 老师好！\n> 佳代子: 看看这个：[:#1:](width: 2em)\n";
const PACK_URL = "https://mms-pack.xiyihan.cn/ba_kivo/manifest.json";
const encoder = new TextEncoder();
const PREVIEW_RUNTIME_KEY = runtimeArtifactKey(
  "0.7.0-rc2",
  "acac51459fa84907843d7a1927ae7b6fc5c743d5de4f61473c866829c9c46e2d",
  "0.7.0-rc2",
  "7e295cdf8a429e41de9d964581a4aa0c08b48757e5b9f8a3dceebe85cc8729eb",
  "mmt-template-bundle-v1",
  "c02a98146312b8756f9f23654b194885358f603eed736f037f172d617330c05c",
);
const PREVIEW_RENDER_OPTIONS_DIGEST = canonicalBytesDigest(
  "mmt-preview-render-options-v1",
  [encoder.encode("svg:default")],
);
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
  encodeBase64: bytesToBase64
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
    const root = document.querySelector<HTMLElement>("#workbench");
    if (root) root.textContent = error instanceof Error ? error.message : String(error);
  });
}

async function start(): Promise<void> {
  const lifecycleGeneration = beginE2ELifecycle();
  const controller = new EditorRuntimeController({
    captureAcceptedPreviewProjects: import.meta.env.VITE_MMT_E2E === "1"
  });
  runtimeController = controller;
  await controller.start(() => initializeRuntime(controller, lifecycleGeneration));
  recordE2ELifecycle("runtime-ready", lifecycleGeneration);
}

async function initializeRuntime(controller: EditorRuntimeController, lifecycleGeneration: number | undefined): Promise<void> {
  const own = <T extends { dispose(): void | Promise<void> }>(resource: T): T => controller.own(resource);
  const subscribe = <T extends { dispose(): void | Promise<void> }>(subscription: T): T => controller.subscribe(subscription);
  const root = document.querySelector<HTMLElement>("#workbench");
  if (!root) throw new Error("Missing #workbench container");
  await controller.initializeOriginStorage();
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
  let previewPanel: vscode.WebviewPanel | undefined;
  let previewPanelTitle = "MomoScript 预览";
  let previewPanelDisposeRegistration: vscode.Disposable | undefined;
  let previewPanelMessageRegistration: vscode.Disposable | undefined;
  let activeClient: BaseLanguageClient | undefined;
  const previewBuildState = new PreviewBuildState();
  const {
    previewProjects,
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
  const previewBindingFor = async (project: TypstProjectUpdate, document: vscode.TextDocument): Promise<TypstPreviewBinding> => {
    const renderProject = project as Partial<TypstRenderProjectUpdate>;
    const materialization = await materializationKey(
      project.projectionKey,
      renderProject.packRegistryDigest ?? project.projectDigest,
      renderProject.resourcePlanDigest ?? project.projectDigest,
      renderProject.resourceBytesDigest ?? project.projectDigest,
    );
    const key = await renderKey(materialization, await PREVIEW_RUNTIME_KEY, await PREVIEW_RENDER_OPTIONS_DIGEST);
    const mapDigest = await canonicalBytesDigest("mmt-preview-empty-location-map-v1", [encoder.encode(key)]);
    return Object.freeze({
      renderKey: key,
      locationProviderKey: Object.freeze({
        kind: "immutable-map",
        digest: mapDigest,
        coordinateVersion: "typst-page-points-v1",
      }),
      locationMap: Object.freeze({ digest: mapDigest, sourceToPreview: Object.freeze([]), previewToSource: Object.freeze([]) }),
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
  const preview = own(new TypstPreviewController(layout.preview, {
    status(message, error, revision) {
      if (revision && !previewBuildState.isCurrent(revision)) return;
      if (error && revision) previewBuildState.fail(revision, "render-layout", message);
      const scope = message.includes("WASM") ? "wasm" : (error ? "preview:error" : "preview");
      log(scope, message);
      if (previewPanel) previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, message, error);
    },
    rendered(svg, revision, shadowCount, pageSize) {
      if (!previewBuildState.isCurrent(revision)) return;
      log("preview", `Rendered revision ${revision.revision} with ${shadowCount} virtual files`);
      if (previewPanel) previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, svg, "", false, pageSize, preview.viewportState);
    },
  }, {
    currentIdentity: currentPreviewIdentity,
    mapProjectedSelection: mapProjectedPreviewSelection,
    mapPreviewSource,
    openSource: openPreviewSource,
    events: {
      statusChanged(status, message) { log(`preview:navigation:${status}`, message); },
      indicatorChanged(indicator) {
        if (previewPanel) previewPanel.webview.postMessage({ type: "indicator", point: indicator?.point });
      },
      cursorChanged(cursor) {
        if (previewPanel) previewPanel.webview.postMessage({ type: "cursor", point: cursor?.point });
      },
      viewportChanged(viewport) {
        if (previewPanel) previewPanel.webview.postMessage({ type: "restoreViewport", viewport });
      },
      fullRefreshRequested(reason) { log("preview:refresh", `Full refresh required: ${reason}`); },
    },
  }));
  const renderPreview = async (project: TypstProjectUpdate): Promise<void> => {
    const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === project.sourceUri);
    if (!document) return;
    const binding = await previewBindingFor(project, document);
    controller.stores.previewArtifacts.request(project.sourceUri, binding.renderKey);
    const retained = controller.stores.previewArtifacts.get(binding.renderKey);
    if (retained) {
      preview.displayArtifact(retained, binding.identity, binding.resolver);
    } else {
      await preview.update(project, binding);
      const artifact = preview.displayedArtifact;
      if (!artifact || artifact.renderKey !== binding.renderKey) return;
      controller.stores.previewArtifacts.put(artifact);
    }
    controller.stores.previewArtifacts.display(project.sourceUri, binding.renderKey);
  };
  let fixtureProviderKey: LocationProviderKey | undefined;
  let fixtureSelection: PreviewEditorSelection | undefined;
  if (import.meta.env.VITE_MMT_E2E === "1") {
    Reflect.set(globalThis, "__mmtPreviewInteractionFixture", async (request: PreviewInteractionFixtureRequest) => {
      if (request.action === "state") {
        return {
          renderKey: preview.displayedRenderKey ?? null,
          viewport: preview.viewportState,
          status: layout.preview.querySelector(".typst-preview-interaction-status")?.getAttribute("data-status") ?? null,
          statusText: layout.preview.querySelector(".typst-preview-interaction-status")?.textContent ?? "",
          indicatorCount: layout.preview.querySelectorAll(".typst-preview-indicator").length,
          cursorCount: layout.preview.querySelectorAll(".typst-preview-cursor").length,
          pageCount: layout.preview.querySelectorAll(".typst-preview-page").length,
        };
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
        preview.providerRestarted(restarted);
        return true;
      }
      if (request.action === "position") {
        if (!fixtureSelection) return false;
        preview.scheduleEditorSelection(fixtureSelection);
        return true;
      }
      if (request.action === "navigate") {
        return request.point ? Boolean(await preview.navigatePreviewPoint(request.point)) : false;
      }
      if (request.action === "advance-source") {
        const current = fixtureSelection?.identity;
        if (!current) return false;
        preview.sourceIdentityAdvanced({
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
          pages,
        });
        preview.displayArtifact(artifact, identity, {
          key: fixtureProviderKey,
          async locateSelection() { return [{ pageIndex: 0, x: 0.2, y: 0.15 }, { pageIndex: 1, x: 0.9, y: 0.95 }]; },
          async locatePoint() { return { uri: identity.entryUri, range: selectedRange }; },
        });
        if (previewPanel) previewPanel.webview.html = previewWebviewHtml(
          previewPanel.webview,
          previewPanelTitle,
          artifact.pages[0]!.sanitizedSvg,
          "",
          false,
          { width: artifact.pages[0]!.geometry.cssWidth, height: artifact.pages[0]!.geometry.cssHeight },
          preview.viewportState,
        );
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
          pages,
        });
        preview.displayArtifact(artifact, identity);
        if (previewPanel) previewPanel.webview.html = previewWebviewHtml(
          previewPanel.webview,
          previewPanelTitle,
          artifact.pages[0]!.sanitizedSvg,
          "",
          false,
          { width: artifact.pages[0]!.geometry.cssWidth, height: artifact.pages[0]!.geometry.cssHeight },
          preview.viewportState,
        );
      }
      return true;
    });
  }
  const materializedResourceCache = new BoundedStringCache(MATERIALIZED_RESOURCE_CACHE_MAX_BYTES);
  const previewClock = new RevisionPinnedPreviewClock();
  if (import.meta.env.VITE_MMT_E2E === "1") {
    Reflect.set(globalThis, "__mmtLatestProjectionRevision", () => {
      const sourceUri = vscode.window.activeTextEditor?.document.uri.toString();
      return sourceUri ? latestLanguageProjectionBySource.get(sourceUri)?.revision : undefined;
    });
    Reflect.set(globalThis, "__mmtLanguageProjectionEntry", (name: string) => {
      const uri = vscode.Uri.joinPath(WORKSPACE, name).toString();
      const project = acceptedPreviewLanguageProjects!.get(uri);
      if (!project) return null;
      const entry = project.files.find((file) => file.uri === project.entryUri);
      return { sourceVersion: project.sourceVersion, text: entry?.text };
    });
    Reflect.set(globalThis, "__mmtPreviewBuildDiagnostics", (sourceUri: string) => previewBuildState.diagnostics(sourceUri));
  }
  let displayedPreviewSourceUri: string | undefined;
  if (import.meta.env.VITE_MMT_E2E === "1") {
    Reflect.set(globalThis, "__mmtDisplayedPreviewSourceUri", () => displayedPreviewSourceUri);
  }
  const refreshOpenedPreview = () => {
    if (!displayedPreviewSourceUri) return;
    const project = previewProjects.get(displayedPreviewSourceUri);
    if (project) void renderPreview(project);
  };
  const closePreviewProject = (sourceUri: string) => {
    controller.stores.closeSource(sourceUri);
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
        attachPart(Parts.ACTIVITYBAR_PART, layout.activity);
        attachPart(Parts.SIDEBAR_PART, layout.sidebar);
        attachPart(Parts.EDITOR_PART, layout.editor);
        attachPart(Parts.PANEL_PART, layout.panel);
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
        "editor.wordWrap": "on",
        "editor.wordBasedSuggestions": "off",
        "[mmt]": { "editor.defaultColorDecorators": "never" }
      })
    },
    extensions: [mmtExtension()],
    monacoWorkerFactory: configureWorkbenchWorkerFactory
  });
  await api.start();
  output = own(vscode.window.createOutputChannel("MomoScript"));
  log("host", "VS Code Workbench ready");
  const applyPanelVisibility = (visible: boolean) => {
    layout.panel.hidden = !visible;
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
  root.classList.toggle("sidebar-collapsed", !isPartVisibile(Parts.SIDEBAR_PART));
  const sidebarVisibilityRegistration = own(onPartVisibilityChange(Parts.SIDEBAR_PART, (visible) => {
    root.classList.toggle("sidebar-collapsed", !visible);
  }));
  const applyProject = async (project: TypstRenderProjectUpdate, replaceSameRevision = false) => {
    const session = projectionSessionKey(project.entryUri);
    const latest = latestProjectBySource.get(project.sourceUri);
    const retiredSessions = retiredProjectSessions.get(project.sourceUri);
    if (retiredSessions?.has(session)) return;
    if ((!latest || latest.session !== session) && !project.full) return;
    if (
      latest?.session === session
      && (project.revision < latest.revision
        || (project.revision === latest.revision && project.sourceVersion !== latest.sourceVersion)
        || (!replaceSameRevision && project.revision === latest.revision))
    ) return;
    if (latest && latest.session !== session) {
      const nextRetiredSessions = retiredSessions ?? new Set<string>();
      nextRetiredSessions.add(latest.session);
      retiredProjectSessions.set(project.sourceUri, nextRetiredSessions);
    }
    latestProjectBySource.set(project.sourceUri, { session, sourceVersion: project.sourceVersion, revision: project.revision });
    const projectRevision = { sourceUri: project.sourceUri, sourceVersion: project.sourceVersion, revision: project.revision };
    previewBuildState.activate(projectRevision);
    if (displayedPreviewSourceUri === project.sourceUri) preview.invalidate();
    materializationControllers.get(project.sourceUri)?.abort();
    const controller = new AbortController();
    materializationControllers.set(project.sourceUri, controller);
    let prepared;
    try {
      const mirroredProject = await mirrorWorkspaceFiles(project, project, controller.signal);
      const limits = configuredResourceLimits();
      log("resources", `Materializing ${project.resources.length} resources for revision ${project.revision} (file ${limits.maxFileBytes} bytes, project ${limits.maxProjectBytes} bytes)`);
      prepared = await materializeProjectResources(
        mirroredProject,
        packSourcesByNamespace,
        materializedResourceCache,
        controller.signal,
        MATERIALIZATION_DEPENDENCIES,
        {
          maxResources: limits.maxResources,
          maxBytes: limits.maxProjectBytes
        }
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      const failedCurrent = latestProjectBySource.get(project.sourceUri);
      if (
        failedCurrent?.session !== session
        || failedCurrent.sourceVersion !== project.sourceVersion
        || failedCurrent.revision !== project.revision
      ) return;
      const message = `Failed to fetch preview workspace resources: ${error instanceof Error ? error.message : String(error)}`;
      previewBuildState.fail(projectRevision, "fetch", message);
      log("resources:fetch:error", message);
      void vscode.window.showWarningMessage(`Preview fetch failed: ${message}`);
      if (displayedPreviewSourceUri === project.sourceUri && previewPanel) {
        previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, message, true);
      }
      return;
    }
    const current = latestProjectBySource.get(project.sourceUri);
    if (
      current?.session !== session
      || current.sourceVersion !== project.sourceVersion
      || current.revision !== project.revision
    ) return;
    if (prepared.diagnostics.length > 0) {
      for (const diagnostic of prepared.diagnostics) {
        previewBuildState.fail(projectRevision, diagnostic.phase, diagnostic.message);
        log(`resources:${diagnostic.phase}:error`, diagnostic.message);
      }
      const first = prepared.diagnostics[0];
      void vscode.window.showWarningMessage(`Preview ${first.phase} failed: ${first.message}`);
    }
    previewProjects.set(project.sourceUri, prepared.project);
    if (displayedPreviewSourceUri === project.sourceUri && previewPanel) {
      await renderPreview(prepared.project);
    }
  };
  const trackLanguageProjection = (project: TypstProjectUpdate) => advanceLanguageProjection(
    project,
    projectionSessionKey(project.entryUri),
    latestLanguageProjectionBySource,
    retiredLanguageProjectionSessions
  );
  const previewOnChange = () => vscode.workspace.getConfiguration("mmt.preview").get<boolean>("onChange", true);
  const requestRenderProject = async (
    client: BaseLanguageClient,
    sourceUri: string,
    token: LanguageProjectionToken,
    force = false
  ) => {
    if (!force && requestedRenderTokens.has(token)) return;
    requestedRenderTokens.add(token);
    const timestamp = previewClock.timestamp(token, force);
    const requestId = (renderRequestIdBySource.get(sourceUri) ?? 0) + 1;
    renderRequestIdBySource.set(sourceUri, requestId);
    log("preview", `Requesting render project for ${sourceUri}`);
    try {
      const renderProject = await client.sendRequest<TypstRenderProjectUpdate | null>(
        "mmt/getTypstRenderProject", { uri: sourceUri, timestamp }
      );
      if (
        latestLanguageProjectionBySource.get(sourceUri) !== token
        || renderRequestIdBySource.get(sourceUri) !== requestId
      ) return;
      if (!force && !previewOnChange()) {
        requestedRenderTokens.delete(token);
        return;
      }
      if (
        !renderProject
        || renderProject.entryUri !== token.entryUri
        || renderProject.revision !== token.revision
        || renderProject.sourceVersion !== token.sourceVersion
      ) return;
      const application = applyProject(renderProject, force);
      pendingMaterializations.add(application);
      try {
        await application;
      } finally {
        pendingMaterializations.delete(application);
      }
    } catch (error) {
      requestedRenderTokens.delete(token);
      throw error;
    }
  };
  const schedulePreviewIfEnabled = async (
    client: BaseLanguageClient,
    sourceUri: string,
    token: LanguageProjectionToken
  ) => {
    if (!previewOnChange()) return;
    await requestRenderProject(client, sourceUri, token);
  };
  document.documentElement.dataset.mmtStage = "api-ready";
  await ensureDefaultWorkspace();
  document.documentElement.dataset.mmtStage = "filesystem-ready";


  document.documentElement.dataset.mmtStage = "tinymist-starting";
  try {
    tinymist = await startTinymistLanguageClient((message) => log("wasm", message));
    const handle = tinymist;
    own({ dispose: () => handle.dispose() });
    controller.registerTermination(() => handle.terminate());
    log("tinymist", "Tinymist Worker ready");
  } catch (error) {
    log("tinymist:error", error instanceof Error ? error.message : String(error));
    void vscode.window.showWarningMessage(
      `内置 Typst 语言服务不可用：${error instanceof Error ? error.message : String(error)}`
    );
  }
  document.documentElement.dataset.mmtStage = tinymist ? "tinymist-ready" : "tinymist-unavailable";
  const syncTypstLanguageDocument = async (document: vscode.TextDocument): Promise<TypstProjectUpdate | undefined> => {
    if (document.languageId !== "typst" || document.uri.scheme !== "mmtfs" || document.uri.authority !== "workspace") return undefined;
    const sourceUri = document.uri.toString();
    const project = await buildTypstProject(document, typstRevisions);
    if (typstRevisions.get(sourceUri) !== project.revision) return undefined;
    tinymist?.backend.syncProject(project);
    return project;
  };
  const recognizeAndSyncTypst = async (document: vscode.TextDocument): Promise<TypstProjectUpdate | undefined> => {
    if (!document.uri.path.toLowerCase().endsWith(".typ")) return undefined;
    const recognized = document.languageId === "typst" ? document : await vscode.languages.setTextDocumentLanguage(document, "typst");
    return syncTypstLanguageDocument(recognized);
  };
  if (import.meta.env.VITE_MMT_E2E === "1") {
    Reflect.set(globalThis, "__mmtSyncWorkspaceTypst", async (name: string) => {
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
    void recognizeAndSyncTypst(editor.document).catch((error: unknown) => log("tinymist:error", error instanceof Error ? error.message : String(error)));
  }));
  const previewSelectionRegistration = subscribe(vscode.window.onDidChangeTextEditorSelection((event) => {
    const sourceUri = event.textEditor.document.uri.toString();
    if (displayedPreviewSourceUri !== sourceUri) return;
    const identity = currentPreviewIdentity(sourceUri);
    if (!identity) return;
    const selection = event.selections[0];
    if (!selection) return;
    preview.scheduleEditorSelection({
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
    controller.stores.previewArtifacts.markStale(sourceUri);
    const project = previewProjects.get(sourceUri) ?? typstProjects.get(sourceUri);
    if (project) preview.sourceIdentityAdvanced(previewIdentityFor(project, event.document));
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
      if (tracked.advanced) tinymist?.backend.syncProject(project);
      void schedulePreviewIfEnabled(activeClient!, project.sourceUri, tracked.token).catch((error: unknown) => {
        log("preview:error", error instanceof Error ? error.message : String(error));
      });
    }));
    subscribe(activeClient.onNotification(
      "mmt/typstProjectClosed",
      (params: { sourceUri: string; entryUri: string }) => {
        if (latestLanguageProjectionBySource.get(params.sourceUri)?.entryUri !== params.entryUri) return;
        closePreviewProject(params.sourceUri);
      }
    ));
    tinymist?.connect(activeClient);
    log("mmt", "MMT language server ready");
  } catch (error) {
    log("mmt:error", error instanceof Error ? error.message : String(error));
    void vscode.window.showErrorMessage(
      `MomoScript 浏览器语言服务器启动失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const documentConfigCommandRegistration = subscribe(vscode.commands.registerCommand("mmt.document.configure", async () => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || document.languageId !== "mmt") {
      void vscode.window.showWarningMessage("请先打开一个 MomoScript 文档。");
      return;
    }
    try {
      if (!activeClient) throw new Error("MMT 语言服务器不可用");
      await configureDocumentSettings(document, activeClient);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log("document:error", detail);
      void vscode.window.showErrorMessage(`文档设置失败：${detail}`);
    }
  }));
  const previewCommandRegistration = subscribe(vscode.commands.registerCommand("mmt.preview.open", async (resource?: vscode.Uri) => {
    const resourceDocument = resource
      ? vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === resource.toString())
      : undefined;
    const document = resourceDocument ?? vscode.window.activeTextEditor?.document;
    if (!document || !["mmt", "typst"].includes(document.languageId)) {
      void vscode.window.showWarningMessage("请先打开一个 MomoScript 或 Typst 文档，再启动预览。");
      return;
    }
    const sourceUri = document.uri.toString();
    displayedPreviewSourceUri = sourceUri;
    previewPanelTitle = `${document.uri.path.split("/").at(-1) ?? "文档"}（预览）`;
    if (!previewPanel) {
      previewPanel = own(vscode.window.createWebviewPanel(
        "mmt.typstPreview",
        previewPanelTitle,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      ));
      previewPanelDisposeRegistration = subscribe(previewPanel.onDidDispose(() => {
        previewPanel = undefined;
        displayedPreviewSourceUri = undefined;
        previewPanelDisposeRegistration?.dispose();
        previewPanelDisposeRegistration = undefined;
        previewPanelMessageRegistration?.dispose();
        previewPanelMessageRegistration = undefined;
        void preview.close();
        log("preview", "Preview editor closed");
      }));
      previewPanelMessageRegistration = subscribe(previewPanel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (isPreviewViewportMessage(message)) {
          preview.updateViewportFromHost(message.viewport);
          return;
        }
        if (isPreviewNavigateMessage(message)) {
          await preview.navigatePreviewPoint(message.point);
          return;
        }
        if (!isExportMessage(message)) return;
        const sourceName = displayedPreviewSourceUri ? new URL(displayedPreviewSourceUri).pathname.split("/").at(-1) : "document";
        const baseName = (sourceName ?? "document").replace(/\.(?:mmt(?:\.txt)?|typ)$/i, "") || "document";
        try {
          if (displayedPreviewSourceUri && activeClient) {
            const sourceDocument = vscode.workspace.textDocuments.find(
              (candidate) => candidate.uri.toString() === displayedPreviewSourceUri
            );
            const token = latestLanguageProjectionBySource.get(displayedPreviewSourceUri);
            if (sourceDocument?.languageId === "mmt" && token) {
              await requestRenderProject(activeClient, displayedPreviewSourceUri, token, true);
            }
          }
          const exported = await preview.createExport(message.format);
          downloadBlob(exported.blob, `${baseName}.${exported.extension}`);
          log("export", `Downloaded ${baseName}.${exported.extension}`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log("export:error", detail);
          void vscode.window.showErrorMessage(`导出失败：${detail}`);
        }
      }));
    } else {
      previewPanel.title = previewPanelTitle;
      previewPanel.reveal(undefined, false);
    }
    log("preview", `Opening ${sourceUri}`);
    if (document.languageId === "typst") {
      previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, "正在准备 Typst 预览…");
      const project = await buildTypstProject(document, typstRevisions);
      typstProjects.set(sourceUri, project);
      tinymist?.backend.syncProject(project);
      previewBuildState.activate({ sourceUri: project.sourceUri, sourceVersion: project.sourceVersion, revision: project.revision });
      await renderPreview(project);
      return;
    }
    if (!activeClient) {
      const message = "MomoScript 语言服务器不可用；Typst 编辑与语言服务仍可继续使用。";
      previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, message, true);
      return;
    }
    previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, "正在准备 MomoScript 投影…");
    let project: TypstProjectUpdate | null;
    try {
      project = await waitForSynchronizedLanguageProjection(
        () => activeClient.sendRequest<TypstProjectUpdate | null>("mmt/getTypstProject", { uri: sourceUri }),
        document.version
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const message = `无法为 ${document.fileName} 构建 Typst 投影：${detail}`;
      previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, message, true);
      log("preview:error", message);
      return;
    }
    if (displayedPreviewSourceUri !== sourceUri) return;
    if (!project) {
      const message = `语言服务器未能及时同步 ${document.fileName} 的文档版本 ${document.version}。`;
      previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, message, true);
      log("preview:error", message);
      return;
    }
    const tracked = trackLanguageProjection(project);
    if (!tracked) return;
    acceptedPreviewLanguageProjects?.set(sourceUri, project);
    if (tracked.advanced) tinymist?.backend.syncProject(project);
    await requestRenderProject(activeClient, project.sourceUri, tracked.token, true);
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
    for (const source of packSources) {
      const manifest = JSON.parse(source.json) as { pack?: { namespace?: unknown } };
      const namespace = manifest.pack?.namespace;
      if (typeof namespace === "string" && namespace.length > 0) {
        packSourcesByNamespace.set(namespace, { ...source, cacheIdentity: await manifestCacheIdentity(source) });
      }
    }
    log("resources", `Accepted ${packSources.length} resource pack manifests`);
  };
  try {
    await syncConfiguredPackSources();
  } catch (error) {
    void vscode.window.showWarningMessage(`MomoScript resource packs are unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const packConfigRegistration = subscribe(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("mmt.resourcePacks.manifestUrls")) return;
    const values = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_URL]);
    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Resource pack manifest URLs"]');
    if (input) input.value = values.join("\n");
    void syncConfiguredPackSources().catch((error: unknown) => {
      void vscode.window.showWarningMessage(`MomoScript resource packs are unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  }));
  const previewConfigRegistration = subscribe(vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("mmt.preview.onChange")) return;
    if (!previewOnChange()) return;
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

  const initialDocument = await vscode.workspace.openTextDocument(DEFAULT_DOCUMENT);
  const recognizedDocument = initialDocument.languageId === "typst"
    ? initialDocument
    : await vscode.languages.setTextDocumentLanguage(initialDocument, "typst");
  await vscode.window.showTextDocument(recognizedDocument);
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
  const documentPersistenceRegistration = subscribe(vscode.workspace.onDidChangeTextDocument((event) => {
    if (!controller.acceptingWork) return;
    const document = event.document;
    if ((document.languageId !== "mmt" && document.languageId !== "typst")
      || document.uri.scheme !== "mmtfs" || document.uri.authority !== "workspace") return;
    const uri = document.uri.toString();
    const text = document.getText();
    const priorRevision = latestLanguageProjectionBySource.get(uri)?.revision ?? -1;
    const previous = persistenceByUri.get(uri) ?? Promise.resolve();
    const next = previous.then(async () => {
      await vscode.workspace.fs.writeFile(document.uri, encoder.encode(text));
      log("document", `Saved ${document.uri.path}`);
      if (document.languageId === "typst") return;
      await new Promise((resolve) => setTimeout(resolve, 50));
      if ((latestLanguageProjectionBySource.get(uri)?.revision ?? -1) > priorRevision) return;
      if (!activeClient) return;
      const current = await activeClient.sendRequest<TypstProjectUpdate | null>("mmt/getTypstProject", { uri });
      if (!current || current.revision <= priorRevision) return;
      const tracked = trackLanguageProjection(current);
      if (!tracked) return;
      if (tracked.advanced) tinymist?.backend.syncProject(current);
      await schedulePreviewIfEnabled(activeClient, current.sourceUri, tracked.token);
    }).catch((error: unknown) => {
      log("document:error", `${document.uri.path}: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (persistenceByUri.get(uri) === next) persistenceByUri.delete(uri);
    });
    persistenceByUri.set(uri, next);
  }));
  document.documentElement.dataset.mmtStage = "mmt-ready";
  document.documentElement.dataset.mmtLanguageId = recognizedDocument.languageId;
  document.documentElement.dataset.mmtWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "";
  const typstDocumentChangeRegistration = subscribe(vscode.workspace.onDidChangeTextDocument((event) => {
    if (!controller.acceptingWork) return;
    void recognizeAndSyncTypst(event.document).then((project) => {
      if (!project) return;
      const sourceUri = event.document.uri.toString();
      typstProjects.set(sourceUri, project);
      if (displayedPreviewSourceUri === sourceUri) return renderPreview(project);
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
  let disposalRecorded = false;
  const controllerDispose = async () => {
    recordE2ELifecycle("dispose-invoked", lifecycleGeneration);
    await controller.dispose(750, () => recordE2ELifecycle("hmr-fallback", lifecycleGeneration));
    if (disposalRecorded) return;
    disposalRecorded = true;
    recordE2ELifecycle("dispose-complete", lifecycleGeneration);
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

function packResourceUrl(packBase: string, relativePath: string, kind: TypstResourceRequest["kind"]): URL {
  const root = new URL(packBase);
  if (root.protocol !== "https:") throw new Error("Pack resource base must use HTTPS");
  if (/[\\?#:]/.test(relativePath)) throw new Error("Pack resource path contains forbidden characters");
  const segments = relativePath.split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Pack resource path must contain relative segments");
  }
  const fileName = segments.at(-1)!;
  const extension = kind === "image-dir" ? /\.(?:png|jpe?g|webp)$/i : /\.avifs$/i;
  if (!extension.test(fileName)) throw new Error(`Pack ${kind} resource has an unsupported extension`);
  const rootHref = root.href.endsWith("/") ? root.href : `${root.href}/`;
  const url = new URL(segments.map(encodeURIComponent).join("/"), rootHref);
  const rootPath = new URL(rootHref).pathname;
  if (url.protocol !== "https:" || url.origin !== root.origin || !url.pathname.startsWith(rootPath)) {
    throw new Error("Pack resource escaped its HTTPS pack root");
  }
  return url;
}

type ImageSequenceResource = Extract<TypstResourceRequest, { kind: "image-sequence" }>;

interface AvifWorkerResponse {
  id: number;
  png?: ArrayBuffer;
  error?: string;
}

async function decodeAvifSequence(
  bytes: Uint8Array,
  resource: ImageSequenceResource,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (resource.container !== "avifs" || resource.codec !== "av1") {
    throw new Error(`Unsupported image sequence ${resource.container}/${resource.codec}`);
  }
  if (resource.frame < 0 || resource.frame >= resource.frameCount) {
    throw new Error(`AVIFS frame ${resource.frame} is outside frameCount ${resource.frameCount}`);
  }
  const worker = new Worker(new URL("./avifSequenceWorker.ts", import.meta.url), { type: "module" });
  return new Promise<Uint8Array>((resolve, reject) => {
    const abort = () => {
      worker.terminate();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
      reject(new Error(event.message || "AVIFS decoder Worker failed"));
    };
    worker.onmessage = (event: MessageEvent<AvifWorkerResponse>) => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.png instanceof ArrayBuffer) resolve(new Uint8Array(event.data.png));
      else reject(new Error("AVIFS decoder Worker returned no PNG"));
    };
    const payload = bytes.buffer;
    worker.postMessage({
      id: resource.id,
      bytes: payload,
      frame: resource.frame,
      sha256: resource.sha256,
      size: resource.size,
      profile: resource.profile
    }, [payload]);
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
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

async function ensureDefaultWorkspace(): Promise<void> {
  try {
    await vscode.workspace.fs.stat(INTRO);
  } catch {
    await vscode.workspace.fs.writeFile(INTRO, await loadDefaultIntro());
  }
  await loadIntroAssets();
  try {
    await vscode.workspace.fs.stat(STORY);
  } catch {
    await vscode.workspace.fs.writeFile(STORY, encoder.encode(DEFAULT_STORY));
  }
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

function isExportMessage(value: unknown): value is { type: "export"; format: TypstExportFormat } {
  if (!value || typeof value !== "object") return false;
  const message = value as { type?: unknown; format?: unknown };
  return message.type === "export" && ["pdf", "png", "jpg", "svg"].includes(String(message.format));
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

function previewWebviewHtml(
  webview: vscode.Webview,
  title: string,
  svg?: string,
  status = "Rendering preview…",
  error = false,
  pageSize?: { width: number; height: number },
  viewportState: PreviewViewport = { page: 0, x: 0, y: 0, zoom: 1, fitMode: "width" },
): string {
  void webview;
  const nonce = previewNonce();
  const pageStyle = pageSize ? ` style="width:${pageSize.width}px;height:${pageSize.height}px" data-intrinsic-width="${pageSize.width}" data-intrinsic-height="${pageSize.height}"` : "";
  const formats = [
    { format: "pdf", label: "PDF 文档", extension: ".pdf" },
    { format: "png", label: "PNG 图片", extension: ".png" },
    { format: "jpg", label: "JPEG 图片", extension: ".jpg" },
    { format: "svg", label: "SVG 矢量图", extension: ".svg" }
  ].map(({ format, label, extension }) =>
    `<button type="button" role="menuitem" data-format="${format}"><span>${label}</span><span class="export-extension">${extension}</span></button>`
  ).join("");
  const body = svg
    ? `<nav class="preview-toolbar" aria-label="预览操作"><div class="zoom-controls"><button type="button" data-zoom="out" aria-label="Zoom out">−</button><span class="zoom-label" aria-live="polite">100%</span><button type="button" data-zoom="in" aria-label="Zoom in">+</button><button type="button" data-fit="width">Fit width</button><button type="button" data-fit="page">Fit page</button></div><div class="export-control"><button type="button" class="export-trigger" aria-haspopup="menu" aria-expanded="false">导出<span class="export-chevron" aria-hidden="true"></span></button><div class="export-menu" role="menu" aria-label="导出格式" hidden>${formats}</div></div></nav><main class="viewport"><article class="page" data-page-index="0"${pageStyle}>${svg}</article></main>`
    : `<main class="status${error ? " error" : ""}">${escapeHtml(status)}</main>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; min-height: 100%; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    body { box-sizing: border-box; font-family: var(--vscode-font-family); }
    .preview-toolbar { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 34px; padding: 4px 12px; box-sizing: border-box; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
    .zoom-controls { display: flex; align-items: center; gap: 5px; }
    .zoom-controls button { min-height: 26px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    .zoom-label { width: 44px; color: var(--vscode-descriptionForeground); font: 12px var(--vscode-editor-font-family); text-align: center; }
    .export-control { position: relative; display: flex; align-items: center; }
    .export-trigger { display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px; border: 1px solid var(--vscode-button-border, transparent); border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); font: inherit; cursor: pointer; }
    .export-trigger:hover { background: var(--vscode-button-hoverBackground); }
    .export-trigger:focus-visible, .export-menu button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .export-chevron { width: 6px; height: 6px; margin-top: -3px; border-right: 1px solid currentColor; border-bottom: 1px solid currentColor; transform: rotate(45deg); }
    .export-menu { position: absolute; top: calc(100% + 4px); right: 0; z-index: 3; min-width: 190px; padding: 4px; border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-menu-background, #252526); box-shadow: 0 2px 8px #0008; }
    .export-menu[hidden] { display: none; }
    .export-menu button { display: flex; align-items: center; justify-content: space-between; width: 100%; min-height: 26px; padding: 4px 8px; border: 0; border-radius: 2px; color: var(--vscode-menu-foreground, var(--vscode-foreground)); background: transparent; font: inherit; text-align: left; cursor: pointer; }
    .export-menu button:hover, .export-menu button:focus { color: var(--vscode-menu-selectionForeground, var(--vscode-button-foreground)); background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground)); outline: none; }
    .export-extension { margin-left: 20px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; text-transform: uppercase; }
    .export-menu button:hover .export-extension, .export-menu button:focus .export-extension { color: inherit; opacity: .8; }
    .viewport { display: flex; justify-content: center; min-width: min-content; height: calc(100vh - 43px); overflow: auto; box-sizing: border-box; padding: 24px; background: #e5e5e5; }
    .page { position: relative; flex: 0 0 auto; background: transparent; line-height: 0; transform-origin: top left; }
    .page svg { display: block; width: 100%; height: 100%; max-width: none; filter: drop-shadow(0 2px 5px #0008); }
    .page .tsel, .page .tsel span { color: transparent; line-height: 1; white-space: pre; pointer-events: auto; user-select: text; cursor: text; }
    .page .tsel::selection, .page .tsel span::selection { color: transparent; background: #7db9dea0; }
    .preview-indicator, .preview-cursor { position: absolute; z-index: 4; pointer-events: none; transform: translate(-50%, -50%); }
    .preview-indicator { width: 18px; height: 18px; border: 2px solid #007acc; border-radius: 50%; background: #007acc28; box-shadow: 0 0 0 4px #007acc24; }
    .preview-cursor { width: 2px; height: 20px; background: #d16969; box-shadow: 0 0 0 1px #fff8; }
    .status { display: grid; min-height: 100vh; place-items: center; color: var(--vscode-descriptionForeground); }
    .status.error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>${body}</body>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const viewport = document.querySelector('.viewport');
  const page = document.querySelector('.page');
  const zoomLabel = document.querySelector('.zoom-label');
  const initialViewport = ${JSON.stringify(viewportState)};
  let zoom = initialViewport.zoom;
  let fitMode = initialViewport.fitMode;
  const intrinsicWidth = Number(page?.dataset.intrinsicWidth);
  const intrinsicHeight = Number(page?.dataset.intrinsicHeight);
  const applyZoom = (nextZoom, nextFitMode, notify = true) => {
    if (!page || !(intrinsicWidth > 0) || !(intrinsicHeight > 0)) return;
    zoom = Math.round(Math.min(5, Math.max(.1, nextZoom)) * 100) / 100;
    fitMode = nextFitMode;
    page.style.width = intrinsicWidth * zoom + 'px';
    page.style.height = intrinsicHeight * zoom + 'px';
    if (zoomLabel) zoomLabel.textContent = Math.round(zoom * 100) + '%';
    if (notify) reportViewport();
  };
  const reportViewport = () => {
    if (!viewport || !page) return;
    const viewportBounds = viewport.getBoundingClientRect();
    const pageBounds = page.getBoundingClientRect();
    if (!(pageBounds.width > 0) || !(pageBounds.height > 0)) return;
    const x = Math.min(1, Math.max(0, (viewportBounds.left + viewportBounds.width / 2 - pageBounds.left) / pageBounds.width));
    const y = Math.min(1, Math.max(0, (viewportBounds.top + viewportBounds.height / 2 - pageBounds.top) / pageBounds.height));
    vscode.postMessage({ type: 'viewport', viewport: { page: 0, x, y, zoom, fitMode } });
  };
  const fitWidth = (notify = true) => {
    if (!viewport || !(intrinsicWidth > 0)) return;
    applyZoom((viewport.clientWidth - 48) / intrinsicWidth, 'width', notify);
  };
  const fitPage = (notify = true) => {
    if (!viewport || !(intrinsicWidth > 0) || !(intrinsicHeight > 0)) return;
    applyZoom(Math.min((viewport.clientWidth - 48) / intrinsicWidth, (viewport.clientHeight - 48) / intrinsicHeight), 'page', notify);
  };
  const restoreViewport = (state) => {
    if (!viewport || !page || !state) return;
    if (state.fitMode === 'width') fitWidth(false);
    else if (state.fitMode === 'page') fitPage(false);
    else applyZoom(state.zoom, 'manual', false);
    requestAnimationFrame(() => {
      viewport.scrollLeft = page.offsetLeft + Math.min(1, Math.max(0, state.x)) * page.offsetWidth - viewport.clientWidth / 2;
      viewport.scrollTop = page.offsetTop + Math.min(1, Math.max(0, state.y)) * page.offsetHeight - viewport.clientHeight / 2;
    });
  };
  restoreViewport(initialViewport);
  document.querySelector('[data-zoom="out"]')?.addEventListener('click', () => applyZoom(zoom - .1, 'manual'));
  document.querySelector('[data-zoom="in"]')?.addEventListener('click', () => applyZoom(zoom + .1, 'manual'));
  document.querySelector('[data-fit="width"]')?.addEventListener('click', () => fitWidth());
  document.querySelector('[data-fit="page"]')?.addEventListener('click', () => fitPage());
  viewport?.addEventListener('wheel', (event) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    if (!page) return;
    const pageBounds = page.getBoundingClientRect();
    const anchorX = (event.clientX - pageBounds.left) / pageBounds.width;
    const anchorY = (event.clientY - pageBounds.top) / pageBounds.height;
    applyZoom(zoom * Math.exp(-event.deltaY * .002), 'manual', false);
    const resizedBounds = page.getBoundingClientRect();
    viewport.scrollLeft += resizedBounds.left + anchorX * resizedBounds.width - event.clientX;
    viewport.scrollTop += resizedBounds.top + anchorY * resizedBounds.height - event.clientY;
    reportViewport();
  }, { passive: false });
  let viewportFrame;
  viewport?.addEventListener('scroll', () => {
    if (viewportFrame) return;
    viewportFrame = requestAnimationFrame(() => { viewportFrame = undefined; reportViewport(); });
  }, { passive: true });
  page?.addEventListener('click', (event) => {
    const bounds = page.getBoundingClientRect();
    if (!(bounds.width > 0) || !(bounds.height > 0)) return;
    vscode.postMessage({
      type: 'navigate',
      point: {
        pageIndex: 0,
        x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
        y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
      },
    });
  });
  const showOverlay = (className, point) => {
    document.querySelector('.' + className)?.remove();
    if (!point || point.pageIndex !== 0 || !page) return;
    const overlay = document.createElement('span');
    overlay.className = className;
    overlay.style.left = Math.min(1, Math.max(0, point.x)) * 100 + '%';
    overlay.style.top = Math.min(1, Math.max(0, point.y)) * 100 + '%';
    page.append(overlay);
    if (className === 'preview-indicator') overlay.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
  };
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'restoreViewport') restoreViewport(event.data.viewport);
    else if (event.data?.type === 'indicator') showOverlay('preview-indicator', event.data.point);
    else if (event.data?.type === 'cursor') showOverlay('preview-cursor', event.data.point);
  });
  const exportControl = document.querySelector('.export-control');
  const exportTrigger = document.querySelector('.export-trigger');
  const exportMenu = document.querySelector('.export-menu');
  const exportItems = [...document.querySelectorAll('.export-menu button[data-format]')];
  const setExportMenuOpen = (open, focusFirst = false) => {
    if (!exportTrigger || !exportMenu) return;
    exportMenu.hidden = !open;
    exportTrigger.setAttribute('aria-expanded', String(open));
    if (open && focusFirst) exportItems[0]?.focus();
  };
  exportTrigger?.addEventListener('click', () => {
    setExportMenuOpen(exportMenu?.hidden ?? true);
  });
  exportMenu?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-format]');
    if (!button) return;
    setExportMenuOpen(false);
    exportTrigger?.focus();
    vscode.postMessage({ type: 'export', format: button.dataset.format });
  });
  exportTrigger?.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    setExportMenuOpen(true, true);
  });
  exportMenu?.addEventListener('keydown', (event) => {
    const current = exportItems.indexOf(document.activeElement);
    let next = current;
    if (event.key === 'ArrowDown') next = (current + 1) % exportItems.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + exportItems.length) % exportItems.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = exportItems.length - 1;
    else return;
    event.preventDefault();
    exportItems[next]?.focus();
  });
  document.addEventListener('pointerdown', (event) => {
    if (!exportControl?.contains(event.target)) setExportMenuOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || exportMenu?.hidden) return;
    event.preventDefault();
    setExportMenuOpen(false);
    exportTrigger?.focus();
  });
</script>
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
  const activity = part("activity");
  const sidebar = part("sidebar");
  const editor = part("editor");
  const preview = part("preview");
  const panel = part("panel");
  const status = part("status");
  const syncActivitySelection = (event: MouseEvent) => {
    const tab = (event.target as Element | null)?.closest<HTMLElement>('[role="tab"]');
    if (!tab || !activity.contains(tab)) return;
    if (tab.getAttribute("aria-selected") !== "true") return;
    event.stopPropagation();
    setPartVisibility(Parts.SIDEBAR_PART, !isPartVisibile(Parts.SIDEBAR_PART));
  };
  activity.addEventListener("click", syncActivitySelection, true);
  root.append(activity, sidebar, editor, preview, panel, status);
  return {
    activity,
    sidebar,
    editor,
    preview,
    panel,
    status,
    dispose: () => activity.removeEventListener("click", syncActivitySelection, true)
  };
}

function mmsViewIcon(): string {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M4 5.5h16v10H9l-5 4v-14Zm4 4h8M8 12h5"/></svg>';
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
  const project = document.createElement("section");
  project.innerHTML = '<h3>项目</h3><div class="mms-setting-row"><span>入口文件</span><code>intro.typ</code></div>';
  const documentSettings = document.createElement("section");
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
  const resourceHeading = document.createElement("h3");
  resourceHeading.textContent = "资源包";
  const label = document.createElement("label");
  label.textContent = "清单地址";
  const urls = document.createElement("textarea");
  urls.rows = 4;
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
  resources.append(resourceHeading, label, urls, save, status, advanced);
  container.append(project, documentSettings, previewSettings, resources);
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
async function buildTypstProject(document: vscode.TextDocument, revisions: Map<string, number>): Promise<TypstProjectUpdate> {
  const sourceUri = document.uri.toString();
  const revision = (revisions.get(sourceUri) ?? 0) + 1;
  revisions.set(sourceUri, revision);
  const root = vscode.Uri.parse(`${document.uri.scheme}://${document.uri.authority}/`);
  const entryUri = document.uri.toString();
  const files: TypstVirtualFile[] = [{ uri: entryUri, text: document.getText() }];
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
  await visit(root);
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
  const logicalFiles = new Map<LogicalProjectFileId, string>();
  for (const file of files) {
    const fileUri = vscode.Uri.parse(file.uri);
    const id: LogicalProjectFileId = {
      kind: "workspace",
      logicalWorkspaceId: workspaceId,
      canonicalWorkspaceRelativePath: mountedPath(fileUri)
    };
    const bytes = file.text !== undefined
      ? encoder.encode(file.text)
      : Uint8Array.from(atob(file.dataBase64), (character) => character.charCodeAt(0));
    logicalFiles.set(id, await canonicalBytesDigest("mmt-project-file-v1", [bytes]));
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
    files,
    full: true,
    projectDigest,
    sourceContent,
    projectionKey,
    mappingDigest
  };
}

async function mirrorWorkspaceFiles(
  sourceProject: TypstRenderProjectUpdate,
  project: TypstRenderProjectUpdate,
  signal: AbortSignal
): Promise<TypstRenderProjectUpdate> {
  const source = vscode.Uri.parse(sourceProject.sourceUri);
  const root = vscode.Uri.parse(`${source.scheme}://${source.authority}/`);
  const entry = vscode.Uri.parse(project.entryUri);
  const basePath = entry.path.slice(0, entry.path.lastIndexOf("/") + 1);
  const sourcePath = source.path;
  const existing = new Set(project.files.map((file) => file.uri));
  const imagePattern = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/i;
  const maxFileBytes = 8 * 1024 * 1024;
  const maxTotalBytes = 32 * 1024 * 1024;
  let totalBytes = 0;
  const files: TypstVirtualFile[] = [];
  for (const [name, type] of await vscode.workspace.fs.readDirectory(root)) {
    if (signal.aborted || type !== vscode.FileType.File || name === source.path.split("/").pop()) continue;
    if (name === "." || name === ".." || name.includes("/") || name.includes("\\") || !imagePattern.test(name)) continue;
    const uri = entry.with({ path: `${basePath}${name}` }).toString();
    if (existing.has(uri)) continue;
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, name));
    if (bytes.byteLength > maxFileBytes || totalBytes + bytes.byteLength > maxTotalBytes) continue;
    totalBytes += bytes.byteLength;
    files.push({ uri, dataBase64: bytesToBase64(bytes) });
  }
  return files.length === 0 ? project : { ...project, files: [...project.files, ...files] };
}
