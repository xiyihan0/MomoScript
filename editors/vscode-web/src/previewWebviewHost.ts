import type { IOverlayWebview } from "@codingame/monaco-vscode-a654b07e-8806-5425-b124-18f03ba8e11a-common/vscode/vs/workbench/contrib/webview/browser/webview";
import { mainWindow } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/window";
import type { IDisposable } from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import type { IWebviewService } from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/webview/browser/webview.service";
import {
  asWebviewUri,
  webviewGenericCspSource,
} from "@codingame/monaco-vscode-api/vscode/vs/workbench/contrib/webview/common/webview";
import type { TypstPreviewBinding, TypstPreviewPublication } from "./preview.ts";
import type { PreviewArtifact } from "./previewArtifact.ts";
import type { PreviewRendererCandidate } from "./previewRendererSession.ts";
import previewWebviewRuntimeUrl from "./previewWebviewRuntime.ts?worker&url";
import {
  acceptsComposerIntent,
  isComposerStateMessage,
  type ComposerIntentMessage,
  type ComposerStateMessage,
  bytesToBase64,
  escapeHtml,
  isPreviewWebviewToHostMessage,
  isPreviewContextPointMessage,
  type PreviewContextMenuAnchor,
  type PreviewExactExportState,
  type PreviewHostToWebviewMessage,
  type PreviewNavigationPoint,
  type PreviewPagePoint,
  type PreviewRendererFrameMessage,
  type PreviewViewport,
  type PreviewVisualReadyMessage,
  type PreviewWebviewToHostMessage,
  ComposerState,
  float32CoordinatePrecision,
} from "./previewWebviewProtocol.ts";

export type PreviewExactExportRequest = Extract<PreviewWebviewToHostMessage, { type: "exact-export" }>;

export interface PreviewWebviewHostEvents {
  readonly ready?: () => void;
  readonly viewportChanged: (viewport: PreviewViewport) => void;
  readonly navigationRequested: (point: PreviewNavigationPoint) => void | Promise<void>;
  readonly contextMenuRequested: (
    point: PreviewNavigationPoint,
    anchor: PreviewContextMenuAnchor,
  ) => void | Promise<void>;
  readonly composerIntent: (message: ComposerIntentMessage, admitted: boolean) => void | Promise<void>;
  readonly composerDrained: (sessionId: string) => void;
  readonly exactExportRequested: (request: PreviewExactExportRequest) => void | Promise<void>;
  readonly exactExportCancelled: () => void;
}
interface PreviewWebviewHostOptions {
  readonly webviewService: IWebviewService;
  readonly defaultExportFormat?: () => "pdf" | "png";
}

interface PendingReadyWaiter {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

interface PendingPublication {
  readonly renderKey: string;
  readonly resolve: (message: PreviewVisualReadyMessage) => void;
  readonly reject: (error: Error) => void;
}

interface ComposerTransportSession {
  state: ComposerStateMessage;
  receivedSequence: number;
  readonly renderKeys: Set<string>;
  readonly pending: Set<Promise<void>>;
}

interface RendererGeneration {
  readonly sessionId: string;
  readonly backendGeneration: number;
  readonly generation: number;
}

/** Owns one retained preview webview and its transport, independently of its visible pane. */
export class PreviewWebviewHost implements IDisposable {
  readonly #events: PreviewWebviewHostEvents;
  readonly #options: PreviewWebviewHostOptions;
  readonly #readyWaiters = new Set<PendingReadyWaiter>();
  readonly #pendingPublications = new Map<number, PendingPublication>();
  #webview: IOverlayWebview | undefined;
  #messageRegistration: IDisposable | undefined;
  #surface: {
    readonly claimant: object;
    readonly container: HTMLElement;
    readonly clippingContainer: HTMLElement;
  } | undefined;
  #surfaceLayoutCleanup: (() => void) | undefined;
  #ready = false;
  #publicationSequence = 1;
  #rendererGeneration: RendererGeneration | undefined;
  #rendererResyncRequested: { readonly sessionId: string; readonly generation: number } | undefined;
  #composerState: ComposerStateMessage | undefined;
  readonly #composerSessions = new Map<string, ComposerTransportSession>();
  #disposed = false;

  constructor(events: PreviewWebviewHostEvents, options: PreviewWebviewHostOptions) {
    this.#events = events;
    this.#options = options;
  }

  get isOpen(): boolean {
    return this.#surface !== undefined;
  }

  attachSurface(claimant: object, container: HTMLElement, clippingContainer: HTMLElement): void {
    if (this.#disposed) throw new Error("Preview Webview host is disposed");
    if (container.ownerDocument.defaultView !== mainWindow || clippingContainer.ownerDocument !== container.ownerDocument) {
      throw new Error("Preview surfaces must belong to the main workbench window");
    }
    if (this.#surface?.claimant === claimant
      && this.#surface.container === container
      && this.#surface.clippingContainer === clippingContainer) {
      this.layoutSurface(claimant);
      return;
    }
    this.#surfaceLayoutCleanup?.();
    this.#surface = { claimant, container, clippingContainer };
    const webview = this.#ensureWebview();
    webview.claim(claimant, mainWindow, undefined);
    const layout = () => this.layoutSurface(claimant);
    const observer = new ResizeObserver(layout);
    observer.observe(container);
    observer.observe(clippingContainer);
    mainWindow.addEventListener("resize", layout);
    mainWindow.addEventListener("scroll", layout, true);
    mainWindow.visualViewport?.addEventListener("resize", layout);
    mainWindow.visualViewport?.addEventListener("scroll", layout);
    this.#surfaceLayoutCleanup = () => {
      observer.disconnect();
      mainWindow.removeEventListener("resize", layout);
      mainWindow.removeEventListener("scroll", layout, true);
      mainWindow.visualViewport?.removeEventListener("resize", layout);
      mainWindow.visualViewport?.removeEventListener("scroll", layout);
    };
    layout();
  }

  releaseSurface(claimant: object): void {
    if (this.#surface?.claimant !== claimant) return;
    this.#surfaceLayoutCleanup?.();
    this.#surfaceLayoutCleanup = undefined;
    this.#surface = undefined;
    this.#webview?.release(claimant);
  }

  layoutSurface(claimant: object): void {
    const surface = this.#surface;
    const webview = this.#webview;
    if (this.#disposed || !surface || !webview || surface.claimant !== claimant) return;
    const { container, clippingContainer } = surface;
    const rect = container.getBoundingClientRect();
    const visible = container.isConnected
      && clippingContainer.isConnected
      && rect.width > 0
      && rect.height > 0
      && mainWindow.getComputedStyle(container).visibility !== "hidden";
    webview.container.style.visibility = visible ? "visible" : "hidden";
    webview.container.inert = !visible;
    if (visible) webview.layoutWebviewOverElement(container, undefined, clippingContainer);
    if (this.#composerState && this.#composerState.screenCoordinatePrecision !== float32CoordinatePrecision(
      Math.max(mainWindow.innerWidth, mainWindow.innerHeight),
    )) this.postComposerState(this.#composerState);
  }

  focusSurface(claimant: object): void {
    if (this.#surface?.claimant === claimant && !this.#webview?.container.inert) this.#webview?.focus();
  }

  async waitUntilReady(signal?: AbortSignal): Promise<void> {
    if (this.#ready) return;
    if (!this.#webview || this.#disposed) throw new Error("Preview Webview is not attached");
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => finish(new Error("Preview Webview runtime did not become ready")), 30_000);
      const aborted = () => finish(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
      const waiter: PendingReadyWaiter = {
        resolve: () => finish(),
        reject: (error) => finish(error),
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        signal?.removeEventListener("abort", aborted);
        this.#readyWaiters.delete(waiter);
        if (error) reject(error);
        else resolve();
      };
      signal?.addEventListener("abort", aborted, { once: true });
      this.#readyWaiters.add(waiter);
    });
  }

  postExactExportState(state: PreviewExactExportState): void {
    void this.#post({ type: "exactExportState", state });
  }

  postStatus(message: string, error: boolean): void {
    void this.#post({ type: "status", message, error });
  }

  postIndicator(point: PreviewPagePoint | undefined): Promise<boolean> {
    return this.#post({ type: "indicator", point });
  }

  postCursor(point: PreviewPagePoint | undefined): void {
    void this.#post({ type: "cursor", point });
  }

  postComposerState(state: ComposerState): void {
    if (this.#disposed) return;
    const message: ComposerStateMessage = {
      ...state,
      screenCoordinatePrecision: float32CoordinatePrecision(Math.max(mainWindow.innerWidth, mainWindow.innerHeight)),
    };
    if (!isComposerStateMessage(message)) return;
    let session = this.#composerSessions.get(message.sessionId);
    if (session && message.sequence < session.state.sequence) return;
    if (!session) {
      session = { state: message, receivedSequence: message.sequence, renderKeys: new Set(), pending: new Set() };
      this.#composerSessions.set(message.sessionId, session);
    }
    // Blocked slots retain issued identities only for draining/recovery, never mutation admission.
    session.state = message;
    if (message.status !== "blocked") session.renderKeys.add(message.renderKey);
    this.#composerState = message;
    void this.#post(message);
  }

  restoreViewport(viewport: PreviewViewport): void {
    void this.#post({ type: "restoreViewport", viewport });
  }

  clearRendererGeneration(): void {
    this.#rendererGeneration = undefined;
    this.#rendererResyncRequested = undefined;
  }

  resetRenderer(): void {
    this.clearRendererGeneration();
    void this.#post({ type: "renderer-reset" });
  }

  acceptsRendererCandidate(candidate: PreviewRendererCandidate): boolean {
    if (candidate.ready.frameKind !== "diff-v1") return true;
    return this.#rendererGeneration?.sessionId === candidate.sessionId
      && this.#rendererGeneration.backendGeneration === candidate.backendGeneration
      && this.#rendererGeneration.generation === candidate.ready.baseGeneration;
  }

  commitRendererCandidate(candidate: PreviewRendererCandidate): void {
    this.#rendererGeneration = Object.freeze({
      sessionId: candidate.sessionId,
      backendGeneration: candidate.backendGeneration,
      generation: candidate.ready.generation,
    });
    if (!this.#rendererResyncRequested) return;
    if (this.#rendererResyncRequested.sessionId === candidate.sessionId
      && this.#rendererResyncRequested.generation === candidate.ready.generation) {
      this.#rendererGeneration = undefined;
    }
    this.#rendererResyncRequested = undefined;
  }

  async publishFixtureArtifact(artifact: PreviewArtifact): Promise<void> {
    const visual = artifact.visualSnapshot;
    const firstPage = visual.kind === "svg" ? visual.pages[0] : undefined;
    if (!this.#webview || !firstPage || visual.kind !== "svg") return;
    await this.waitUntilReady();
    const imageAssets = await Promise.all(visual.imageAssets.map(async (asset) => ({
      digest: asset.digest,
      mimeType: asset.mimeType,
      dataBase64: bytesToBase64(new Uint8Array(await asset.blob.arrayBuffer())),
    })));
    await this.#post({
      type: "render",
      svg: firstPage.sanitizedSvg,
      imageAssets,
      pageSize: { width: firstPage.geometry.cssWidth, height: firstPage.geometry.cssHeight },
      requestSequence: this.#publicationSequence++,
      renderKey: artifact.renderKey,
      spans: [],
    });
  }

  async publishFullSvg(publication: TypstPreviewPublication): Promise<PreviewVisualReadyMessage> {
    const webview = this.#webview;
    if (!webview) throw new Error("Preview Webview is not attached");
    await this.waitUntilReady(publication.signal);
    publication.signal?.throwIfAborted();
    const requestSequence = this.#publicationSequence++;
    const imageAssets = await Promise.all(publication.imageAssets.map(async (asset) => ({
      digest: asset.digest,
      mimeType: asset.mimeType,
      dataBase64: bytesToBase64(new Uint8Array(await asset.blob.arrayBuffer())),
    })));
    const acknowledgement = this.#acknowledgement(requestSequence, publication.artifact.renderKey);
    const delivered = await this.#post({
      type: "render",
      svg: publication.compactSvg,
      imageAssets,
      pageSize: publication.pageSize,
      requestSequence,
      traceId: publication.traceId,
      renderKey: publication.artifact.renderKey,
      spans: publication.spans,
    });
    if (!delivered || webview !== this.#webview) {
      this.#pendingPublications.delete(requestSequence);
      throw new Error("Preview Webview rejected the render publication");
    }
    return this.#waitForAcknowledgement(requestSequence, acknowledgement, publication.signal);
  }

  async publishRendererFrame(
    candidate: PreviewRendererCandidate,
    binding: TypstPreviewBinding,
  ): Promise<PreviewVisualReadyMessage> {
    const webview = this.#webview;
    if (!webview) throw new Error("Preview Webview is not attached");
    await this.waitUntilReady(binding.signal);
    binding.signal?.throwIfAborted();
    const requestSequence = this.#publicationSequence++;
    const acknowledgement = this.#acknowledgement(requestSequence, binding.renderKey);
    const message: PreviewRendererFrameMessage = {
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
      publishedAtEpochMs: Date.now(),
    };
    const delivered = await this.#post(message);
    if (!delivered || webview !== this.#webview) {
      this.#pendingPublications.delete(requestSequence);
      throw new Error("Preview Webview rejected the renderer frame");
    }
    const ready = await this.#waitForAcknowledgement(requestSequence, acknowledgement, binding.signal);
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
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#surface) this.releaseSurface(this.#surface.claimant);
    this.#ready = false;
    this.clearRendererGeneration();
    this.#composerState = undefined;
    this.#composerSessions.clear();
    this.#rejectPending(new Error("Preview Webview host disposed"));
    this.#messageRegistration?.dispose();
    this.#messageRegistration = undefined;
    this.#webview?.dispose();
    this.#webview = undefined;
  }

  #ensureWebview(): IOverlayWebview {
    if (this.#webview) return this.#webview;
    const webview = this.#options.webviewService.createWebviewOverlay({
      providedViewType: "mmt.typstPreview",
      title: "MomoScript 排版",
      options: { retainContextWhenHidden: true },
      contentOptions: {
        allowScripts: true,
        localResourceRoots: [previewWebviewRuntimeResourceRoot()],
      },
      extension: undefined,
    });
    this.#webview = webview;
    this.#messageRegistration = webview.onMessage((event) => {
      if (!this.#disposed && isPreviewWebviewToHostMessage(event.message)) void this.#dispatch(event.message);
    });
    webview.setHtml(previewWebviewHtml("MomoScript 排版", this.#options.defaultExportFormat?.() ?? "pdf"));
    return webview;
  }

  #acknowledgement(requestSequence: number, renderKey: string): Promise<PreviewVisualReadyMessage> {
    return new Promise<PreviewVisualReadyMessage>((resolve, reject) => {
      this.#pendingPublications.set(requestSequence, { renderKey, resolve, reject });
    });
  }

  async #waitForAcknowledgement(
    requestSequence: number,
    acknowledgement: Promise<PreviewVisualReadyMessage>,
    signal: AbortSignal | undefined,
  ): Promise<PreviewVisualReadyMessage> {
    const abort = () => {
      const pending = this.#pendingPublications.get(requestSequence);
      if (!pending) return;
      this.#pendingPublications.delete(requestSequence);
      pending.reject(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await acknowledgement;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  #post(message: PreviewHostToWebviewMessage): Promise<boolean> {
    return Promise.resolve(this.#webview?.postMessage(message) ?? false);
  }

  async #dispatch(message: PreviewWebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.#ready = true;
        for (const waiter of [...this.#readyWaiters]) waiter.resolve();
        this.#events.ready?.();
        if (this.#composerState) void this.#post(this.#composerState);
        return;
      case "visual-ready": {
        const pending = this.#pendingPublications.get(message.requestSequence);
        if (!pending) return;
        this.#pendingPublications.delete(message.requestSequence);
        if (pending.renderKey !== message.renderKey) pending.reject(new Error("Preview Webview visual-ready render key mismatch"));
        else pending.resolve(message);
        return;
      }
      case "render-rejected": {
        const pending = this.#pendingPublications.get(message.requestSequence);
        if (!pending) return;
        this.#pendingPublications.delete(message.requestSequence);
        pending.reject(new Error(message.error));
        return;
      }
      case "renderer-resync-needed": {
        const current = this.#rendererGeneration;
        if (current?.sessionId === message.sessionId && current.generation === message.generation) {
          this.#rendererGeneration = undefined;
        } else if (!current || (current.sessionId === message.sessionId && current.generation < message.generation)) {
          this.#rendererResyncRequested = message;
        }
        return;
      }
      case "viewport":
        this.#events.viewportChanged(message.viewport);
        return;
      case "navigate":
        await this.#events.navigationRequested(message.point);
        return;
      case "context-point":
        if (isPreviewContextPointMessage(message)) {
          await this.#events.contextMenuRequested(message.point, message.anchor);
        }
        return;
      case "composer-intent": {
        const session = this.#composerSessions.get(message.sessionId);
        if (!session || message.sequence <= session.receivedSequence) return;
        const admitted = this.#surface !== undefined && this.#composerState?.sessionId === message.sessionId
          && acceptsComposerIntent(message, session.state, session.receivedSequence, session.renderKeys);
        session.receivedSequence = message.sequence;
        if (admitted) {
          // iframe→host postMessage is FIFO: seeing a newer issued key retires preceding keys.
          for (const key of session.renderKeys) {
            if (key === message.renderKey) break;
            session.renderKeys.delete(key);
          }
        }
        // Every handled sequence needs an acknowledgement. Rejected work is explicitly
        // recovery-only; Main routes retired IDs away from the active document's handler.
        const delivered = Promise.resolve(this.#events.composerIntent(message, admitted));
        session.pending.add(delivered);
        try {
          await delivered;
        } finally {
          session.pending.delete(delivered);
        }
        return;
      }
      case "composer-drained": {
        const session = this.#composerSessions.get(message.sessionId);
        if (!session || session.state.status !== "blocked" || message.sequence !== session.receivedSequence) return;
        await Promise.allSettled(session.pending);
        if (this.#composerSessions.get(message.sessionId) !== session || session.state.status !== "blocked") return;
        this.#composerSessions.delete(message.sessionId);
        this.#events.composerDrained(message.sessionId);
        return;
      }
      case "exact-export":
        await this.#events.exactExportRequested(message);
        return;
      case "exact-export-cancel":
        this.#events.exactExportCancelled();
        return;
    }
  }

  #rejectPending(error: Error): void {
    for (const waiter of [...this.#readyWaiters]) waiter.reject(error);
    for (const pending of this.#pendingPublications.values()) pending.reject(error);
    this.#pendingPublications.clear();
  }
}

function previewWebviewRuntimeResourceUri(): URI {
  return URI.parse(new URL(previewWebviewRuntimeUrl, location.href).href);
}

function previewWebviewRuntimeResourceRoot(): URI {
  return URI.parse(new URL(".", previewWebviewRuntimeResourceUri().toString()).href);
}

function previewWebviewHtml(title: string, defaultExportFormat: "pdf" | "png"): string {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const runtimeUri = asWebviewUri(previewWebviewRuntimeResourceUri()).toString();
  const formats = [
    ["pdf", "PDF document"],
    ["png", "PNG image"],
    ["jpg", "JPEG image"],
    ["svg", "SVG vector"],
  ].map(([format, label]) => (
    `<option value="${format}"${format === defaultExportFormat ? " selected" : ""}>${label}</option>`
  )).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src blob: ${escapeHtml(webviewGenericCspSource)}; img-src data: blob:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval' ${escapeHtml(webviewGenericCspSource)}; object-src 'none'; base-uri 'none'; form-action 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; min-width: 0; min-height: 0; overflow: hidden; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); }
    body { display: flex; flex-direction: column; box-sizing: border-box; font-family: var(--vscode-font-family); }
    .preview-toolbar { position: relative; z-index: 2; display: flex; flex: 0 0 auto; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; min-height: 34px; padding: 4px 12px; box-sizing: border-box; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
    .zoom-controls { display: flex; flex: 0 0 auto; align-items: center; gap: 5px; }
    .zoom-controls > * { flex: 0 0 auto; }
    .zoom-controls button, .exact-export button, .exact-export select { min-height: 26px; border: 1px solid var(--vscode-button-border, var(--vscode-panel-border)); border-radius: 2px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; white-space: nowrap; }
    .zoom-label { width: 44px; color: var(--vscode-descriptionForeground); font: 12px var(--vscode-editor-font-family); text-align: center; }
    .exact-export { display: grid; flex: 1 1 440px; grid-template-columns: auto auto minmax(100px, 1fr); align-items: center; justify-content: stretch; gap: 4px 6px; min-width: 0; }
    .exact-export-format { display: inline-flex; align-items: center; gap: 5px; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .exact-export button { padding: 3px 8px; }
    .exact-export select:disabled, .exact-export button:disabled { cursor: not-allowed; opacity: .55; }
    .exact-export-stale { display: flex; gap: 4px; }
    .exact-export-stale[hidden], .exact-export [hidden] { display: none; }
    .exact-export-status { grid-column: auto; min-width: 0; max-width: 360px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 11px; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
    .exact-export[data-availability="stale"] .exact-export-status { color: var(--vscode-editorWarning-foreground, #cca700); }
    .exact-export[data-availability="failed"] .exact-export-status, .exact-export[data-phase="error"] .exact-export-status { color: var(--vscode-errorForeground); }
    .viewport { display: flex; flex: 1 1 auto; width: 100%; min-width: 0; min-height: 0; overflow: auto; box-sizing: border-box; padding: 24px; background: #e5e5e5; }
    .page { position: relative; flex: 0 0 auto; margin-inline: auto; background: transparent; line-height: 0; box-shadow: 0 2px 5px #0008; transform-origin: top left; }
    .page > svg { display: block; width: 100%; height: 100%; max-width: none; }
    .page > .typst-renderer-root { display: block; width: 100%; height: 100%; max-width: none; }
    .page .typst-text { pointer-events: bounding-box; cursor: text; }
    .page .typst-text:hover > use { fill: #f75c2f; stroke: #f75c2f; }
    .page .tsel { left: 0; position: fixed; width: 100%; height: 100%; color: transparent; font-family: initial; line-height: normal; text-align: justify; text-align-last: justify; white-space: pre; user-select: text; }
    .page .tsel span::selection, .page .tsel::selection { color: transparent; background: #7db9dea0; }
    .preview-indicator, .preview-cursor { position: absolute; z-index: 4; pointer-events: none; transform: translate(-50%, -50%); }
    .preview-indicator { width: 18px; height: 18px; border: 2px solid #007acc; border-radius: 50%; background: #007acc28; box-shadow: 0 0 0 4px #007acc24; }
    .preview-cursor { width: 2px; height: 20px; background: #d16969; box-shadow: 0 0 0 1px #fff8; }
    .status { display: grid; flex: 1 1 auto; min-height: 0; place-items: center; color: var(--vscode-descriptionForeground); }
    .status.error { color: var(--vscode-errorForeground); }
    .status[hidden], .viewport[hidden] { display: none; }
    @media (max-width: 720px) {
      .preview-toolbar { align-items: stretch; }
      .zoom-controls { width: 100%; }
      .exact-export { flex-basis: 100%; grid-template-columns: minmax(0, 1fr) auto; }
      .exact-export-format select { min-width: 0; max-width: 100%; }
      .exact-export-status { grid-column: 1 / -1; max-width: none; text-align: left; }
    }
    @media (max-width: 550px) {
      .zoom-controls { flex-wrap: wrap; }
      .zoom-controls button, .exact-export button, .exact-export select { min-width: 44px; min-height: 44px; }
      .preview-toolbar { padding-inline: max(8px, env(safe-area-inset-left)) max(8px, env(safe-area-inset-right)); }
      .viewport { padding: 12px; }
    }
    @media (max-height: 240px) {
      .preview-toolbar { flex-wrap: nowrap; align-items: center; justify-content: flex-start; min-width: 0; overflow-x: auto; overflow-y: hidden; overscroll-behavior-x: contain; scrollbar-width: none; }
      .preview-toolbar::-webkit-scrollbar { display: none; }
      .zoom-controls { flex: 0 0 auto; width: auto; flex-wrap: nowrap; }
      .exact-export { display: flex; flex: 0 0 auto; align-items: center; gap: 6px; }
      .exact-export-format, .exact-export-stale, .exact-export-status { flex: 0 0 auto; }
      .exact-export-format select { min-width: 0; max-width: none; }
      .exact-export-status { grid-column: auto; max-width: 360px; text-align: left; }
    }
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
