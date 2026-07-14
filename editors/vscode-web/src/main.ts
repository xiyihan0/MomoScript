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
import { BoundedStringCache, MATERIALIZED_RESOURCE_CACHE_MAX_BYTES } from "./boundedStringCache";
import { advanceLanguageProjection } from "./languageProjection";
import type { LanguageProjectionToken } from "./languageProjection";
import { materializeProjectResources } from "./resourceMaterializer";
import type { MaterializationPackSource, ResourceMaterializationDependencies } from "./resourceMaterializer";
import { mmtExtension } from "./mmtExtension";
import { startMmtLanguageClient } from "./mmtLanguageClient";
import type { MmtLanguageClientHandle } from "./mmtLanguageClient";
import { startTinymistLanguageClient } from "./tinymistLanguageClient";
import type { TinymistHandle } from "./tinymistLanguageClient";
import { synchronizePackSources } from "../../vscode/src/packSync";
import type { PackManifestSource } from "../../vscode/src/packSync";
import { projectionSessionKey } from "../../vscode/src/tinymistClient";
import { sanitizeSvg, TypstPreviewController } from "./preview";
import type { TypstProjectUpdate, TypstRenderProjectUpdate, TypstResourceRequest } from "../../vscode/src/tinymistClient";

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
  Reflect.set(globalThis, "__mmtColorDecorators", () =>
    vscode.workspace
      .getConfiguration("editor", vscode.window.activeTextEditor?.document)
      .get<string>("defaultColorDecorators")
  );
}
const DEFAULT_STORY = "@reply\n- 选项 A\n- 选项 B\n@end\n";
const PACK_URL = "https://mms-pack.xiyihan.cn/ba_kivo/manifest.json";
const encoder = new TextEncoder();
const MAX_RESOURCE_BYTES = 20 * 1024 * 1024;
const MATERIALIZATION_DEPENDENCIES: ResourceMaterializationDependencies = {
  resourceUrl: (source, resource) => {
    const relativePath = resource.kind === "image-dir"
      ? `${resource.base}/${resource.fileName}`
      : resource.path;
    return packResourceUrl(source.baseUrl, relativePath, resource.kind);
  },
  fetch: fetchResource,
  decodeSequence: decodeAvifSequence,
  encodeBase64: bytesToBase64
};


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
  const packSourcesByNamespace = new Map<string, MaterializationPackSource>();
  const latestProjectBySource = new Map<string, { session: string; revision: number }>();
  const retiredProjectSessions = new Map<string, Set<string>>();
  const materializationControllers = new Map<string, AbortController>();
  const materializedResourceCache = new BoundedStringCache(MATERIALIZED_RESOURCE_CACHE_MAX_BYTES);
  const latestLanguageProjectionBySource = new Map<string, LanguageProjectionToken>();
  const retiredLanguageProjectionSessions = new Map<string, Set<string>>();
  const requestedRenderTokens = new WeakSet<LanguageProjectionToken>();
  let displayedPreviewSourceUri: string | undefined;
  const showActivePreview = () => {
    const uri = vscode.window.activeTextEditor?.document.uri.toString();
    const project = uri ? previewProjects.get(uri) : undefined;
    if (project && uri) {
      displayedPreviewSourceUri = uri;
      void preview.update(project);
    } else if (displayedPreviewSourceUri) {
      displayedPreviewSourceUri = undefined;
      void preview.close();
    }
  };
  const closePreviewProject = (sourceUri: string) => {
    materializationControllers.get(sourceUri)?.abort();
    materializationControllers.delete(sourceUri);
    latestProjectBySource.delete(sourceUri);
    retiredProjectSessions.delete(sourceUri);
    previewProjects.delete(sourceUri);
    latestLanguageProjectionBySource.delete(sourceUri);
    retiredLanguageProjectionSessions.delete(sourceUri);
    if (displayedPreviewSourceUri === sourceUri) {
      displayedPreviewSourceUri = undefined;
      void preview.close();
    }
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
        "editor.wordBasedSuggestions": "off",
        "[mmt]": { "editor.defaultColorDecorators": "never" }
      })
    },
    extensions: [mmtExtension()],
    monacoWorkerFactory: configureDefaultWorkerFactory
  });
  await api.start();
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
    let prepared;
    try {
      prepared = await materializeProjectResources(
        project,
        packSourcesByNamespace,
        materializedResourceCache,
        controller.signal,
        MATERIALIZATION_DEPENDENCIES
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
    }
    previewProjects.set(project.sourceUri, prepared.project);
    if (vscode.window.activeTextEditor?.document.uri.toString() === project.sourceUri) {
      displayedPreviewSourceUri = project.sourceUri;
      await preview.update(prepared.project);
    }
  };
  const trackLanguageProjection = (project: TypstProjectUpdate) => advanceLanguageProjection(
    project,
    projectionSessionKey(project.entryUri),
    latestLanguageProjectionBySource,
    retiredLanguageProjectionSessions
  );
  const requestRenderProject = async (
    client: BaseLanguageClient,
    project: TypstProjectUpdate,
    token: LanguageProjectionToken
  ) => {
    if (requestedRenderTokens.has(token)) return;
    requestedRenderTokens.add(token);
    try {
      const renderProject = await client.sendRequest<TypstRenderProjectUpdate | null>(
        "mmt/getTypstRenderProject", { uri: project.sourceUri }
      );
      if (latestLanguageProjectionBySource.get(project.sourceUri) !== token) return;
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
      const tracked = trackLanguageProjection(project);
      if (!tracked) return;
      if (tracked.advanced) tinymist?.backend.syncProject(project);
      void requestRenderProject(activeClient!, project, tracked.token).catch((error: unknown) => {
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
      if (typeof namespace === "string" && namespace.length > 0) {
        packSourcesByNamespace.set(namespace, {
          ...source,
          cacheIdentity: await manifestCacheIdentity(source)
        });
      }
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
  if (currentProject) {
    const tracked = trackLanguageProjection(currentProject);
    if (tracked) {
      if (tracked.advanced) tinymist?.backend.syncProject(currentProject);
      await requestRenderProject(activeClient, currentProject, tracked.token);
    }
  }
  const modelService = await getService(IModelService);
  const storyModel = modelService.getModels().find((model) =>
    model.uri.toString() === STORY.toString() && model.getLanguageId() === "mmt"
  );
  if (!storyModel) throw new Error("MomoScript text model is unavailable");
  let sourceVersion = mmtStory.version;
  let changeSync = Promise.resolve();
  let persistenceSync = Promise.resolve();
  const storyChangeRegistration = storyModel.onDidChangeContent(() => {
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
      if (!current) {
        const latest = latestLanguageProjectionBySource.get(uri);
        if (latest && tinymist?.backend.closeProject(uri, latest.entryUri)) {
          closePreviewProject(uri);
        }
        return;
      }
      const tracked = trackLanguageProjection(current);
      if (!tracked) return;
      if (tracked.advanced) tinymist?.backend.syncProject(current);
      await requestRenderProject(activeClient, current, tracked.token);
    }).catch((error: unknown) => {
      console.error("MomoScript document synchronization failed", error);
    });
  });
  document.documentElement.dataset.mmtLanguageId = mmtStory.languageId;
  document.documentElement.dataset.mmtWorkspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.toString() ?? "";
  document.documentElement.dataset.mmtReady = "true";
  window.addEventListener("beforeunload", () => {
    storyChangeRegistration.dispose();
    previewSelectionRegistration.dispose();
    workbenchProvider.dispose();
    void mmt?.dispose();
    void tinymist?.dispose();
    packCache?.dispose();
    provider?.dispose();
  });
}

async function fetchResource(url: URL, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(url, { signal, mode: "cors", credentials: "omit" });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.href}`);
  if (response.url !== url.href) throw new Error("Pack resource redirected outside its declared URL");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESOURCE_BYTES) {
    throw new Error(`Pack resource exceeds ${MAX_RESOURCE_BYTES} bytes`);
  }
  return readResponseBytes(response, MAX_RESOURCE_BYTES, signal);
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

function createLayout(root: HTMLElement) {
  root.replaceChildren();
  const activity = part("activity");
  const sidebar = part("sidebar");
  const editor = part("editor");
  const splitter = part("splitter");
  const preview = part("preview");
  const panel = part("panel");
  const status = part("status");
  const sidebarToggle = paneToggle("left", "file explorer");
  const previewToggle = paneToggle("right", "preview");
  const togglePane = (button: HTMLButtonElement, className: string, paneName: string) => {
    const collapsed = root.classList.toggle(className);
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${paneName}`);
    button.title = button.getAttribute("aria-label") ?? "";
  };
  sidebarToggle.addEventListener("click", () =>
    togglePane(sidebarToggle, "sidebar-collapsed", "file explorer")
  );
  previewToggle.addEventListener("click", () =>
    togglePane(previewToggle, "preview-collapsed", "preview")
  );
  root.append(sidebarToggle, previewToggle);
  root.append(activity, sidebar, editor, splitter, preview, panel, status);
  installEditorPreviewSplitter(root, editor, splitter);
  return { activity, sidebar, editor, preview, panel, status };
}

function installEditorPreviewSplitter(
  root: HTMLElement,
  editor: HTMLElement,
  splitter: HTMLElement
): void {
  splitter.setAttribute("role", "separator");
  splitter.setAttribute("aria-label", "Resize editor and preview");
  splitter.setAttribute("aria-orientation", "vertical");
  splitter.setAttribute("aria-valuemin", "0");
  splitter.setAttribute("aria-valuemax", "100");
  splitter.setAttribute("aria-valuenow", "50");
  splitter.tabIndex = 0;

  const resize = (clientX: number) => {
    const rootBounds = root.getBoundingClientRect();
    const editorStart = editor.getBoundingClientRect().left;
    const available = rootBounds.right - editorStart - splitter.offsetWidth;
    const minimum = Math.min(320, Math.floor(available / 2));
    const width = Math.min(available - minimum, Math.max(minimum, clientX - editorStart));
    root.style.setProperty("--editor-pane-width", `${width}px`);
    const percentage = available > 0 ? Math.round(width / available * 100) : 50;
    splitter.setAttribute("aria-valuenow", String(percentage));
  };
  const reset = () => {
    root.style.removeProperty("--editor-pane-width");
    splitter.setAttribute("aria-valuenow", "50");
  };

  splitter.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    splitter.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => resize(moveEvent.clientX);
    const finish = (finishEvent: PointerEvent) => {
      if (splitter.hasPointerCapture(finishEvent.pointerId)) {
        splitter.releasePointerCapture(finishEvent.pointerId);
      }
      splitter.removeEventListener("pointermove", move);
      splitter.removeEventListener("pointerup", finish);
      splitter.removeEventListener("pointercancel", finish);
    };
    splitter.addEventListener("pointermove", move);
    splitter.addEventListener("pointerup", finish);
    splitter.addEventListener("pointercancel", finish);
  });
  splitter.addEventListener("dblclick", reset);
  splitter.addEventListener("keydown", (event) => {
    if (event.key === "Home") {
      reset();
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const current = editor.getBoundingClientRect();
    resize(current.right + (event.key === "ArrowLeft" ? -20 : 20));
  });
}
function paneToggle(side: "left" | "right", paneName: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `workbench-pane-toggle ${side}`;
  button.textContent = side === "left" ? "‹" : "›";
  button.setAttribute("aria-expanded", "true");
  button.setAttribute("aria-label", `Collapse ${paneName}`);
  button.title = button.getAttribute("aria-label") ?? "";
  return button;
}


function part(name: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = `workbench-${name}`;
  return element;
}
