import * as vscode from "vscode";
import { LogLevel } from "@codingame/monaco-vscode-api";
import { getService, IModelService } from "@codingame/monaco-vscode-api";
import getExplorerServiceOverride from "@codingame/monaco-vscode-explorer-service-override";
import getKeybindingsServiceOverride from "@codingame/monaco-vscode-keybindings-service-override";
import getMarkersServiceOverride from "@codingame/monaco-vscode-markers-service-override";
import getViewsServiceOverride, { attachPart, Parts } from "@codingame/monaco-vscode-views-service-override";
import { registerCustomProvider } from "@codingame/monaco-vscode-files-service-override";
import { configureDefaultWorkerFactory } from "monaco-languageclient/workerFactory";
import { MonacoVscodeApiWrapper } from "monaco-languageclient/vscodeApiWrapper";
import type { BaseLanguageClient } from "vscode-languageclient";
import { MmtIndexedDbFileSystemProvider, MmtWorkbenchFileSystemProvider } from "./filesystem";
import { IndexedDbPackCache } from "./packCache";
import { mmtExtension } from "./mmtExtension";
import { startMmtLanguageClient } from "./mmtLanguageClient";
import type { MmtLanguageClientHandle } from "./mmtLanguageClient";
import { startTinymistLanguageClient } from "./tinymistLanguageClient";
import type { TinymistHandle } from "./tinymistLanguageClient";
import { synchronizePackSources } from "../../vscode/src/packSync";
import type { PackManifestSource } from "../../vscode/src/packSync";
import { TypstPreviewController } from "./preview";
import type { TypstProjectUpdate, TypstRenderProjectUpdate } from "../../vscode/src/tinymistClient";

const WORKSPACE = vscode.Uri.parse("mmtfs://workspace/");
const STORY = vscode.Uri.parse("mmtfs://workspace/story.mmt");
const DEFAULT_STORY = "@reply\n- 选项 A\n- 选项 B\n@end\n";
const PACK_URL = "https://mms-pack.xiyihan.cn/ba_kivo/manifest.json";
const encoder = new TextEncoder();
const MAX_RESOURCE_BYTES = 20 * 1024 * 1024;

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
  document.documentElement.dataset.mmtStage = "api-starting";
  const layout = createLayout(root);
  const preview = new TypstPreviewController(layout.preview);
  const previewProjects = new Map<string, TypstRenderProjectUpdate>();
  const packSourcesByNamespace = new Map<string, PackManifestSource>();
  const latestProjectRevision = new Map<string, number>();
  const materializationControllers = new Map<string, AbortController>();
  const materializedResourceCache = new Map<string, { manifest: string; dataBase64: string }>();
  const showActivePreview = () => {
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    if (!uri) return;
    const project = previewProjects.get(uri);
    if (project) void preview.update(project);
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
      ...getMarkersServiceOverride(),
      ...getViewsServiceOverride(),
    },
    viewsConfig: {
      $type: "ViewsService",
      htmlContainer: root,
      async viewsInitFunc() {
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
        "editor.wordBasedSuggestions": "off"
      })
    },
    extensions: [mmtExtension()],
    monacoWorkerFactory: configureDefaultWorkerFactory
  });
  await api.start();
  const applyProject = async (project: TypstRenderProjectUpdate) => {
    const latest = latestProjectRevision.get(project.sourceUri);
    if (latest !== undefined && latest > project.revision) return;
    latestProjectRevision.set(project.sourceUri, project.revision);
    materializationControllers.get(project.sourceUri)?.abort();
    const controller = new AbortController();
    materializationControllers.set(project.sourceUri, controller);
    let prepared;
    try {
      prepared = await materializeProjectResources(
        project,
        packSourcesByNamespace,
        materializedResourceCache,
        controller.signal
      );
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    }
    if (latestProjectRevision.get(project.sourceUri) !== project.revision) return;
    if (prepared.errors.length > 0) {
      console.error("MomoScript preview resources failed", prepared.errors);
      void vscode.window.showWarningMessage(prepared.errors[0]);
    }
    previewProjects.set(project.sourceUri, prepared.project);
    if (vscode.window.activeTextEditor?.document.uri.toString() === project.sourceUri) {
      await preview.update(prepared.project);
    }
  };
  const previewSelectionRegistration = vscode.window.onDidChangeActiveTextEditor(showActivePreview);
  document.documentElement.dataset.mmtStage = "api-ready";
  await ensureDefaultStory();
  document.documentElement.dataset.mmtStage = "filesystem-ready";


  document.documentElement.dataset.mmtStage = "tinymist-starting";
  try {
    tinymist = await startTinymistLanguageClient();
  } catch (error) {
    void vscode.window.showWarningMessage(
      `Embedded Typst language service is unavailable: ${error instanceof Error ? error.message : String(error)}`
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
      tinymist?.backend.syncProject(project);
      void activeClient!.sendRequest<TypstRenderProjectUpdate | null>("mmt/getTypstRenderProject", {
        uri: project.sourceUri
      }).then((renderProject) => renderProject && applyProject(renderProject)).catch((error: unknown) => {
        console.error("MomoScript preview materialization failed", error);
      });
    });
    tinymist?.connect(activeClient);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `MomoScript browser language server failed: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
  document.documentElement.dataset.mmtStage = "mmt-ready";

  packCache = await IndexedDbPackCache.open();
  try {
    const packSources = await synchronizePackSources(
      [PACK_URL],
      Date.now(),
      packCache,
      (params) => activeClient!.sendRequest("mmt/updatePackManifests", params),
      fetchManifest
    );
    for (const source of packSources) {
      const manifest = JSON.parse(source.json) as { pack?: { namespace?: unknown } };
      const namespace = manifest.pack?.namespace;
      if (typeof namespace === "string" && namespace.length > 0) packSourcesByNamespace.set(namespace, source);
    }
  } catch (error) {
    void vscode.window.showWarningMessage(
      `MomoScript resource packs are unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const story = await vscode.workspace.openTextDocument(STORY);
  const mmtStory = story.languageId === "mmt" ? story : await vscode.languages.setTextDocumentLanguage(story, "mmt");
  await vscode.window.showTextDocument(mmtStory);
  const currentProject = await activeClient.sendRequest<TypstProjectUpdate | null>("mmt/getTypstProject", {
    uri: mmtStory.uri.toString()
  });
  if (currentProject) tinymist?.backend.syncProject(currentProject);
  const currentRenderProject = await activeClient.sendRequest<TypstRenderProjectUpdate | null>(
    "mmt/getTypstRenderProject", { uri: mmtStory.uri.toString() }
  );
  if (currentRenderProject) await applyProject(currentRenderProject);
  const modelService = await getService(IModelService);
  const storyModel = modelService.getModels().find((model) =>
    model.uri.toString() === STORY.toString() && model.getLanguageId() === "mmt"
  );
  if (!storyModel) throw new Error("MomoScript text model is unavailable");
  let sourceVersion = currentProject?.sourceVersion ?? mmtStory.version;
  let changeSync = Promise.resolve();
  let persistenceSync = Promise.resolve();
  const changeSyncRegistration = storyModel.onDidChangeContent(() => {
    const uri = storyModel.uri.toString();
    const version = ++sourceVersion;
    const text = storyModel.getValue();
    persistenceSync = persistenceSync.then(() =>
      Promise.resolve(vscode.workspace.fs.writeFile(STORY, encoder.encode(text)))
    ).catch((error: unknown) => {
      console.error("MomoScript document persistence failed", error);
    });
    changeSync = changeSync.then(async () => {
      const current = await activeClient.sendRequest<TypstProjectUpdate | null>("mmt/updateDocument", {
        textDocument: { uri, version },
        contentChanges: [{ text }]
      });
      if (!current) return;
      tinymist?.backend.syncProject(current);
      const renderProject = await activeClient.sendRequest<TypstRenderProjectUpdate | null>(
        "mmt/getTypstRenderProject", { uri }
      );
      if (renderProject) await applyProject(renderProject);
    }).catch((error: unknown) => {
      console.error("MomoScript document synchronization failed", error);
    });
  });
  document.documentElement.dataset.mmtLanguageId = mmtStory.languageId;
  document.documentElement.dataset.mmtWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "";
  document.documentElement.dataset.mmtReady = "true";
  window.addEventListener("beforeunload", () => {
    changeSyncRegistration.dispose();
    previewSelectionRegistration.dispose();
    workbenchProvider.dispose();
    void mmt?.dispose();
    void tinymist?.dispose();
    packCache?.dispose();
    provider?.dispose();
  });
}
async function materializeProjectResources(
  project: TypstRenderProjectUpdate,
  sources: Map<string, PackManifestSource>,
  cache: Map<string, { manifest: string; dataBase64: string }>,
  signal: AbortSignal
): Promise<{ project: TypstRenderProjectUpdate; errors: string[] }> {
  const files = [...project.files];
  const errors: string[] = [];
  for (const resource of project.resources) {
    try {
      const source = sources.get(resource.packNamespace);
      if (!source) throw new Error(`Pack source '${resource.packNamespace}' is unavailable`);
      const url = packResourceUrl(source.baseUrl, resource.base, resource.fileName);
      let dataBase64 = cache.get(url.href)?.manifest === source.json
        ? cache.get(url.href)!.dataBase64
        : undefined;
      if (!dataBase64) {
        const response = await fetch(url, { signal, mode: "cors", credentials: "omit" });
        if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.href}`);
        if (response.url !== url.href) throw new Error("Pack resource redirected outside its declared URL");
        const declaredLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(declaredLength) && declaredLength > MAX_RESOURCE_BYTES) {
          throw new Error(`Pack resource exceeds ${MAX_RESOURCE_BYTES} bytes`);
        }
        const bytes = await readResponseBytes(response, MAX_RESOURCE_BYTES, signal);
        if (bytes.byteLength > MAX_RESOURCE_BYTES) {
          throw new Error(`Pack resource exceeds ${MAX_RESOURCE_BYTES} bytes`);
        }
        dataBase64 = bytesToBase64(bytes);
        cache.set(url.href, { manifest: source.json, dataBase64 });
      }
      files.push({ uri: resource.uri, dataBase64 });
    } catch (error) {
      if (signal.aborted) throw error;
      errors.push(
        `Failed to materialize character resource: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return { project: { ...project, files }, errors };
}

function packResourceUrl(packBase: string, storageBase: string, fileName: string): URL {
  const root = new URL(packBase);
  if (root.protocol !== "https:") throw new Error("Pack resource base must use HTTPS");
  if (fileName.length === 0 || fileName === "." || fileName === ".." || /[\\/]/.test(fileName)) {
    throw new Error("Pack resource path must be a basename");
  }
  if (!/\.(?:png|jpe?g|webp)$/i.test(fileName)) throw new Error("Pack resource is not a supported image");
  if (/[\\?#:]/.test(storageBase)) throw new Error("Pack storage base contains forbidden characters");
  const segments = storageBase.split("/");
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error("Pack storage base must contain relative directory segments");
  }
  const relative = [...segments, fileName].map(encodeURIComponent).join("/");
  const rootHref = root.href.endsWith("/") ? root.href : `${root.href}/`;
  const url = new URL(relative, rootHref);
  const rootPath = new URL(rootHref).pathname;
  if (url.protocol !== "https:" || url.origin !== root.origin || !url.pathname.startsWith(rootPath)) {
    throw new Error("Pack resource escaped its HTTPS pack root");
  }
  return url;
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

function createLayout(root: HTMLElement) {
  root.replaceChildren();
  const activity = part("activity");
  const sidebar = part("sidebar");
  const editor = part("editor");
  const preview = part("preview");
  const panel = part("panel");
  const status = part("status");
  root.append(activity, sidebar, editor, preview, panel, status);
  return { activity, sidebar, editor, preview, panel, status };
}

function part(name: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = `workbench-${name}`;
  return element;
}
