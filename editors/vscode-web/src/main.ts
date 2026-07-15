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
import getViewsServiceOverride, { attachPart, isPartVisibile, onPartVisibilityChange, Parts, registerCustomView, setPartVisibility, ViewContainerLocation } from "@codingame/monaco-vscode-views-service-override";
import { registerCustomProvider } from "@codingame/monaco-vscode-files-service-override";
import { useWorkerFactory } from "monaco-languageclient/workerFactory";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import type { BaseLanguageClient } from "vscode-languageclient";
import { MmtIndexedDbFileSystemProvider, MmtWorkbenchFileSystemProvider } from "./filesystem";
import { IndexedDbPackCache } from "./packCache";
import { BoundedStringCache, MATERIALIZED_RESOURCE_CACHE_MAX_BYTES } from "./boundedStringCache";
import { advanceLanguageProjection } from "./languageProjection";
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
import { sanitizeSvg, TypstPreviewController, type TypstExportFormat } from "./preview";
import type { TypstProjectUpdate, TypstRenderProjectUpdate, TypstResourceRequest, TypstVirtualFile } from "../../vscode/src/tinymistClient";

if (import.meta.env.VITE_MMT_E2E === "1") {
  Reflect.set(globalThis, "__mmtSanitizeSvg", sanitizeSvg);
}

const WORKSPACE = vscode.Uri.parse("mmtfs://workspace/");
const STORY = vscode.Uri.parse("mmtfs://workspace/story.mmt");
if (import.meta.env.VITE_MMT_E2E === "1") {
  Reflect.set(globalThis, "__mmtCompletionLabels", async (line: number, character: number) => {
    const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      STORY,
      new vscode.Position(line, character)
    );
    return completions?.items.map((item) => item.label) ?? [];
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
    if (!/^[^./\\][^/\\]*(?:\.mmt\.txt|\.typ)$/.test(name)) throw new Error("invalid workspace document basename");
    const uri = vscode.Uri.joinPath(WORKSPACE, name);
    await vscode.workspace.fs.writeFile(uri, encoder.encode(text));
    const opened = await vscode.workspace.openTextDocument(uri);
    const expectedLanguage = name.endsWith(".typ") ? "typst" : "mmt";
    const document = opened.languageId === expectedLanguage ? opened : await vscode.languages.setTextDocumentLanguage(opened, expectedLanguage);
    await vscode.window.showTextDocument(document);
    return uri.toString();
  });
  Reflect.set(globalThis, "__mmtReadWorkspaceDocument", async (name: string) => {
    if (!/^[^./\\][^/\\]*\.mmt\.txt$/.test(name)) throw new Error("invalid MMT workspace basename");
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(WORKSPACE, name)));
  });
}
const DEFAULT_STORY = "@reply\n- 选项 A\n- 选项 B\n@end\n";
const PACK_URL = "https://mms-pack.xiyihan.cn/ba_kivo/manifest.json";
const encoder = new TextEncoder();
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

void start().catch((error: unknown) => {
  document.documentElement.dataset.mmtStage = "failed";
  console.error("MomoScript editor failed to start", error);
  const root = document.querySelector<HTMLElement>("#workbench");
  if (root) root.textContent = error instanceof Error ? error.message : String(error);
});

async function start(): Promise<void> {
  const root = document.querySelector<HTMLElement>("#workbench");
  if (!root) throw new Error("Missing #workbench container");
  let output: vscode.OutputChannel | undefined;
  const log = (scope: string, message: string) => {
    const line = `[${new Date().toISOString()}] [${scope}] ${message}`;
    if (output) output.appendLine(line);
    else console.info(line);
  };
  log("host", "Starting Web Workbench");
  document.documentElement.dataset.mmtStage = "api-starting";
  const layout = createLayout(root);
  const mmsViewRegistration = registerCustomView({
    id: "momoscript.project",
    name: "MomoScript",
    location: ViewContainerLocation.Sidebar,
    icon: mmsViewIcon(),
    canMoveView: false,
    renderBody: (container) => renderMmsProjectView(container)
  });
  let previewPanel: vscode.WebviewPanel | undefined;
  let previewPanelTitle = "MomoScript 预览";
  let previewPanelDisposeRegistration: vscode.Disposable | undefined;
  let previewPanelMessageRegistration: vscode.Disposable | undefined;
  const preview = new TypstPreviewController(layout.preview, {
    status(message, error) {
      log(error ? "preview:error" : "preview", message);
      if (previewPanel) previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, message, error);
    },
    rendered(svg, revision, shadowCount, pageSize) {
      log("preview", `Rendered revision ${revision} with ${shadowCount} virtual files`);
      if (previewPanel) previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, svg, "", false, pageSize);
    }
  });
  const previewProjects = new Map<string, TypstRenderProjectUpdate>();
  const packSourcesByNamespace = new Map<string, MaterializationPackSource>();
  const latestProjectBySource = new Map<string, { session: string; revision: number }>();
  const retiredProjectSessions = new Map<string, Set<string>>();
  const materializationControllers = new Map<string, AbortController>();
  const materializedResourceCache = new BoundedStringCache(MATERIALIZED_RESOURCE_CACHE_MAX_BYTES);
  const latestLanguageProjectionBySource = new Map<string, LanguageProjectionToken>();
  const typstRevisions = new Map<string, number>();
  const typstProjects = new Map<string, TypstProjectUpdate>();
  const retiredLanguageProjectionSessions = new Map<string, Set<string>>();
  const requestedRenderTokens = new WeakSet<LanguageProjectionToken>();
  if (import.meta.env.VITE_MMT_E2E === "1") {
    Reflect.set(globalThis, "__mmtLatestProjectionRevision", () => {
      const sourceUri = vscode.window.activeTextEditor?.document.uri.toString();
      return sourceUri ? latestLanguageProjectionBySource.get(sourceUri)?.revision : undefined;
    });
  }
  let displayedPreviewSourceUri: string | undefined;
  if (import.meta.env.VITE_MMT_E2E === "1") {
    Reflect.set(globalThis, "__mmtDisplayedPreviewSourceUri", () => displayedPreviewSourceUri);
  }
  const refreshOpenedPreview = () => {
    if (!displayedPreviewSourceUri) return;
    const project = previewProjects.get(displayedPreviewSourceUri);
    if (project) void preview.update(project);
  };
  const closePreviewProject = (sourceUri: string) => {
    materializationControllers.get(sourceUri)?.abort();
    materializationControllers.delete(sourceUri);
    latestProjectBySource.delete(sourceUri);
    retiredProjectSessions.delete(sourceUri);
    previewProjects.delete(sourceUri);
    latestLanguageProjectionBySource.delete(sourceUri);
    retiredLanguageProjectionSessions.delete(sourceUri);
    if (displayedPreviewSourceUri === sourceUri) previewPanel?.dispose();
  };
  try {
    provider = await MmtIndexedDbFileSystemProvider.open();
  } catch (error) {
    throw new Error("Browser storage is unavailable; MomoScript editor cannot persist files.", {
      cause: error
    });
  }
  const workbenchProvider = new MmtWorkbenchFileSystemProvider(provider);
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
  output = vscode.window.createOutputChannel("MomoScript");
  log("host", "VS Code Workbench ready");
  root.classList.toggle("sidebar-collapsed", !isPartVisibile(Parts.SIDEBAR_PART));
  const sidebarVisibilityRegistration = onPartVisibilityChange(Parts.SIDEBAR_PART, (visible) => {
    root.classList.toggle("sidebar-collapsed", !visible);
  });
  const applyProject = async (project: TypstRenderProjectUpdate) => {
    const session = projectionSessionKey(project.entryUri);
    const latest = latestProjectBySource.get(project.sourceUri);
    const retiredSessions = retiredProjectSessions.get(project.sourceUri);
    if (retiredSessions?.has(session)) return;
    if ((!latest || latest.session !== session) && !project.full) return;
    if (latest?.session === session && project.revision <= latest.revision) return;
    if (latest && latest.session !== session) {
      const nextRetiredSessions = retiredSessions ?? new Set<string>();
      nextRetiredSessions.add(latest.session);
      retiredProjectSessions.set(project.sourceUri, nextRetiredSessions);
    }
    latestProjectBySource.set(project.sourceUri, { session, revision: project.revision });
    materializationControllers.get(project.sourceUri)?.abort();
    const controller = new AbortController();
    materializationControllers.set(project.sourceUri, controller);
    const mirroredProject = await mirrorWorkspaceFiles(project, project, controller.signal);
    let prepared;
    try {
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
      throw error;
    }
    const current = latestProjectBySource.get(project.sourceUri);
    if (current?.session !== session || current.revision !== project.revision) return;
    if (prepared.errors.length > 0) {
      console.error("MomoScript preview resources failed", prepared.errors);
      void vscode.window.showWarningMessage(prepared.errors[0]);
      for (const error of prepared.errors) log("resources:error", error);
    }
    previewProjects.set(project.sourceUri, prepared.project);
    if (displayedPreviewSourceUri === project.sourceUri && previewPanel) {
      await preview.update(prepared.project);
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
    if (requestedRenderTokens.has(token)) return;
    requestedRenderTokens.add(token);
    log("preview", `Requesting render project for ${sourceUri}`);
    try {
      const renderProject = await client.sendRequest<TypstRenderProjectUpdate | null>(
        "mmt/getTypstRenderProject", { uri: sourceUri }
      );
      if (latestLanguageProjectionBySource.get(sourceUri) !== token) return;
      if (!force && !previewOnChange()) {
        requestedRenderTokens.delete(token);
        return;
      }
      if (
        !renderProject ||
        renderProject.entryUri !== token.entryUri ||
        renderProject.revision !== token.revision
      ) return;
      await applyProject(renderProject);
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
  await ensureDefaultStory();
  document.documentElement.dataset.mmtStage = "filesystem-ready";


  document.documentElement.dataset.mmtStage = "tinymist-starting";
  try {
    tinymist = await startTinymistLanguageClient();
    log("tinymist", "Tinymist Worker ready");
  } catch (error) {
    log("tinymist:error", error instanceof Error ? error.message : String(error));
    void vscode.window.showWarningMessage(
      `内置 Typst 语言服务不可用：${error instanceof Error ? error.message : String(error)}`
    );
  }
  document.documentElement.dataset.mmtStage = tinymist ? "tinymist-ready" : "tinymist-unavailable";

  let activeClient: BaseLanguageClient | undefined;
  try {
    mmt = await startMmtLanguageClient(Boolean(tinymist), (options) => {
      tinymist?.installMiddleware(options, () => {
        const client = mmt?.client.getLanguageClient();
        if (!client) throw new Error("MMT language client did not start");
        return client;
      });
    });
    activeClient = mmt.client.getLanguageClient();
    if (!activeClient) throw new Error("MMT language client did not start");
    activeClient.onNotification("mmt/typstProjectUpdated", (project: TypstProjectUpdate) => {
      const tracked = trackLanguageProjection(project);
      if (!tracked) return;
      if (tracked.advanced) tinymist?.backend.syncProject(project);
      void schedulePreviewIfEnabled(activeClient!, project.sourceUri, tracked.token).catch((error: unknown) => {
        console.error("MomoScript preview materialization failed", error);
      });
    });
    activeClient.onNotification(
      "mmt/typstProjectClosed",
      (params: { sourceUri: string; entryUri: string }) => {
        if (latestLanguageProjectionBySource.get(params.sourceUri)?.entryUri !== params.entryUri) return;
        closePreviewProject(params.sourceUri);
      }
    );
    tinymist?.connect(activeClient);
    log("mmt", "MMT language server ready");
  } catch (error) {
    log("mmt:error", error instanceof Error ? error.message : String(error));
    void vscode.window.showErrorMessage(
      `MomoScript 浏览器语言服务器启动失败：${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
  const previewCommandRegistration = vscode.commands.registerCommand("mmt.preview.open", async (resource?: vscode.Uri) => {
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
      previewPanel = vscode.window.createWebviewPanel(
        "mmt.typstPreview",
        previewPanelTitle,
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      previewPanelDisposeRegistration = previewPanel.onDidDispose(() => {
        previewPanel = undefined;
        displayedPreviewSourceUri = undefined;
        previewPanelDisposeRegistration?.dispose();
        previewPanelDisposeRegistration = undefined;
        previewPanelMessageRegistration?.dispose();
        previewPanelMessageRegistration = undefined;
        void preview.close();
        log("preview", "Preview editor closed");
      });
      previewPanelMessageRegistration = previewPanel.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!isExportMessage(message)) return;
        const sourceName = displayedPreviewSourceUri ? new URL(displayedPreviewSourceUri).pathname.split("/").at(-1) : "document";
        const baseName = (sourceName ?? "document").replace(/\.(?:mmt(?:\.txt)?|typ)$/i, "") || "document";
        try {
          const exported = await preview.createExport(message.format);
          downloadBlob(exported.blob, `${baseName}.${exported.extension}`);
          log("export", `Downloaded ${baseName}.${exported.extension}`);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log("export:error", detail);
          void vscode.window.showErrorMessage(`导出失败：${detail}`);
        }
      });
    } else {
      previewPanel.title = previewPanelTitle;
      previewPanel.reveal(vscode.ViewColumn.Beside, true);
    }
    log("preview", `Opening ${sourceUri}`);
    if (document.languageId === "typst") {
      previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, "正在准备 Typst 预览…");
      const project = await buildTypstProject(document, typstRevisions);
      typstProjects.set(sourceUri, project);
      await preview.update(project);
      return;
    }
    previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, "正在准备 MomoScript 投影…");
    const project = await activeClient!.sendRequest<TypstProjectUpdate | null>("mmt/getTypstProject", { uri: sourceUri });
    if (!project) {
      const message = `无法为 ${document.fileName} 获取 Typst 投影。`;
      previewPanel.webview.html = previewWebviewHtml(previewPanel.webview, previewPanelTitle, undefined, message, true);
      log("preview:error", message);
      return;
    }
    const tracked = trackLanguageProjection(project);
    if (!tracked) return;
    if (tracked.advanced) tinymist?.backend.syncProject(project);
    await requestRenderProject(activeClient!, project.sourceUri, tracked.token, true);
    refreshOpenedPreview();
  });

  packCache = await IndexedDbPackCache.open();
  const syncConfiguredPackSources = async () => {
    const configured = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_URL]);
    const packSources = await synchronizePackSources(
      configured,
      Date.now(),
      packCache!,
      (params) => activeClient!.sendRequest("mmt/updatePackManifests", params),
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
  const packConfigRegistration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("mmt.resourcePacks.manifestUrls")) return;
    const values = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_URL]);
    const input = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Resource pack manifest URLs"]');
    if (input) input.value = values.join("\n");
    void syncConfiguredPackSources().catch((error: unknown) => {
      void vscode.window.showWarningMessage(`MomoScript resource packs are unavailable: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
  const previewConfigRegistration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (!event.affectsConfiguration("mmt.preview.onChange")) return;
    if (!previewOnChange()) return;
    const sourceUri = vscode.window.activeTextEditor?.document.uri.toString();
    const token = sourceUri ? latestLanguageProjectionBySource.get(sourceUri) : undefined;
    if (!sourceUri || !token) return;
    void schedulePreviewIfEnabled(activeClient!, sourceUri, token).catch((error: unknown) => {
      console.error("MomoScript preview materialization failed", error);
    });
  });
  const packUrls = vscode.workspace.getConfiguration("mmt.resourcePacks").get<string[]>("manifestUrls", [PACK_URL]);
  const packUrlsInput = root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Resource pack manifest URLs"]');
  if (packUrlsInput) packUrlsInput.value = packUrls.join("\n");

  const story = await vscode.workspace.openTextDocument(STORY);
  const mmtStory = story.languageId === "mmt" ? story : await vscode.languages.setTextDocumentLanguage(story, "mmt");
  await vscode.window.showTextDocument(mmtStory);
  const currentProject = await activeClient.sendRequest<TypstProjectUpdate | null>("mmt/getTypstProject", {
    uri: mmtStory.uri.toString()
  });
  if (currentProject) {
    const tracked = trackLanguageProjection(currentProject);
    if (tracked) {
      if (tracked.advanced) tinymist?.backend.syncProject(currentProject);
      await schedulePreviewIfEnabled(activeClient, currentProject.sourceUri, tracked.token);
    }
  }
  const modelService = await getService(IModelService);
  const codeEditorService = await getService(ICodeEditorService);
  const storyModel = modelService.getModels().find((model) =>
    model.uri.toString() === STORY.toString() && model.getLanguageId() === "mmt"
  );
  if (!storyModel) throw new Error("MomoScript text model is unavailable");
  const markerEditingRegistration = storyModel.onDidChangeContent((event) => {
    const ranges = event.changes.flatMap((change) => {
      const range = change.range;
      if (change.text !== ":") return [];
      const line = storyModel.getLineContent(range.startLineNumber);
      if (range.startColumn < 2
        || line.slice(range.startColumn - 2, range.startColumn + 1) !== "[:]") return [];
      return [range];
    });
    if (ranges.length === 0) return;
    const focused = codeEditorService.getFocusedCodeEditor() ?? codeEditorService.getActiveCodeEditor();
    const editor = focused?.getModel() === storyModel
      ? focused
      : codeEditorService.listCodeEditors().find((candidate) => candidate.getModel() === storyModel);
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
  });
  const persistenceByUri = new Map<string, Promise<void>>();
  const documentPersistenceRegistration = vscode.workspace.onDidChangeTextDocument((event) => {
    const document = event.document;
    if (document.languageId !== "mmt" || document.uri.scheme !== "mmtfs" || document.uri.authority !== "workspace") return;
    const uri = document.uri.toString();
    const priorRevision = latestLanguageProjectionBySource.get(uri)?.revision ?? -1;
    const previous = persistenceByUri.get(uri) ?? Promise.resolve();
    const next = previous.then(async () => {
      await vscode.workspace.fs.writeFile(document.uri, encoder.encode(document.getText()));
      log("document", `Saved ${document.uri.path}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      if ((latestLanguageProjectionBySource.get(uri)?.revision ?? -1) > priorRevision) return;
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
  });
  document.documentElement.dataset.mmtStage = "mmt-ready";
  document.documentElement.dataset.mmtLanguageId = mmtStory.languageId;
  document.documentElement.dataset.mmtWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "";
  const typstDocumentChangeRegistration = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.document.languageId !== "typst" || event.document.uri.scheme !== "mmtfs" || event.document.uri.authority !== "workspace") return;
    const sourceUri = event.document.uri.toString();
    void buildTypstProject(event.document, typstRevisions).then((project) => {
      if (typstRevisions.get(sourceUri) !== project.revision) return;
      typstProjects.set(sourceUri, project);
      if (displayedPreviewSourceUri === sourceUri) return preview.update(project);
    }).catch((error: unknown) => log("preview:error", `Typst: ${error instanceof Error ? error.message : String(error)}`));
  });
  log("host", "MomoScript editor ready");
  output.show(false);
  document.documentElement.dataset.mmtReady = "true";
  window.addEventListener("beforeunload", () => {
    markerEditingRegistration.dispose();
    mmsViewRegistration.dispose();
    layout.dispose();
    sidebarVisibilityRegistration.dispose();
    documentPersistenceRegistration.dispose();
    typstDocumentChangeRegistration.dispose();
    packConfigRegistration.dispose();
    previewCommandRegistration.dispose();
    previewPanel?.dispose();
    previewPanelDisposeRegistration?.dispose();
    previewConfigRegistration.dispose();
    workbenchProvider.dispose();
    void mmt?.dispose();
    void tinymist?.dispose();
    packCache?.dispose();
    output?.dispose();
    provider?.dispose();
  });
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


async function ensureDefaultStory(): Promise<void> {
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
  pageSize?: { width: number; height: number }
): string {
  void webview;
  const nonce = previewNonce();
  const pageStyle = pageSize ? ` style="width:${pageSize.width}px;height:${pageSize.height}px" data-intrinsic-width="${pageSize.width}" data-intrinsic-height="${pageSize.height}"` : "";
  const formats = (["pdf", "png", "jpg", "svg"] as const)
    .map((format) => `<button type="button" data-format="${format}">${format.toUpperCase()}</button>`)
    .join("");
  const body = svg
    ? `<nav class="export-toolbar" aria-label="导出预览">${formats}</nav><main class="viewport"><article class="page"${pageStyle}>${svg}</article></main>`
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
    .export-toolbar { position: sticky; top: 0; z-index: 1; display: flex; justify-content: flex-end; gap: 6px; padding: 8px 24px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
    .export-toolbar button { padding: 3px 9px; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    .export-toolbar button:hover { background: var(--vscode-button-hoverBackground); }
    .viewport { display: flex; justify-content: center; min-width: min-content; padding: 24px; background: #e5e5e5; }
    .page { background: #ffffff; box-shadow: 0 2px 10px #0008; line-height: 0; }
    .page svg { display: block; width: 100%; height: 100%; max-width: none; }
    .page .tsel, .page .tsel span { position: fixed; left: 0; width: 100%; height: 100%; color: transparent; white-space: pre; text-align: justify; text-align-last: justify; pointer-events: auto; user-select: text; cursor: text; }
    .page .tsel::selection, .page .tsel span::selection { color: transparent; background: #7db9dea0; }
    .status { display: grid; min-height: 100vh; place-items: center; color: var(--vscode-descriptionForeground); }
    .status.error { color: var(--vscode-errorForeground); }
  </style>
</head>
<body>${body}</body>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelector('.export-toolbar')?.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-format]');
    if (button) vscode.postMessage({ type: 'export', format: button.dataset.format });
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

function renderMmsProjectView(container: HTMLElement): vscode.Disposable {
  container.classList.add("mms-project-view");
  const project = document.createElement("section");
  project.innerHTML = '<h3>项目</h3><div class="mms-setting-row"><span>入口文件</span><code>story.mmt</code></div>';
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
  container.append(project, previewSettings, resources);
  return {
    dispose() {
      previewToggle.removeEventListener("change", updatePreviewSetting);
      configurationRegistration.dispose();
      save.removeEventListener("click", saveSettings);
      advanced.removeEventListener("click", openAdvanced);
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
  return { sourceUri, sourceVersion: document.version, revision, entryUri, files, full: true };
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
