import * as vscode from "vscode";
import type { TypstPreviewBinding, TypstPreviewPublication } from "./preview.ts";
import type { PreviewArtifact } from "./previewArtifact.ts";
import type { PreviewRendererCandidate } from "./previewRendererSession.ts";
import previewWebviewRuntimeUrl from "./previewWebviewRuntime.ts?worker&url";
import {
  bytesToBase64,
  escapeHtml,
  isPreviewWebviewToHostMessage,
  type PreviewExactExportState,
  type PreviewHostToWebviewMessage,
  type PreviewPagePoint,
  type PreviewRendererFrameMessage,
  type PreviewViewport,
  type PreviewVisualReadyMessage,
  type PreviewWebviewToHostMessage,
} from "./previewWebviewProtocol.ts";

export type PreviewExactExportRequest = Extract<PreviewWebviewToHostMessage, { type: "exact-export" }>;

export interface PreviewWebviewHostEvents {
  readonly ready?: () => void;
  readonly closed?: () => void;
  readonly viewportChanged: (viewport: PreviewViewport) => void;
  readonly navigationRequested: (point: PreviewPagePoint) => void | Promise<void>;
  readonly exactExportRequested: (request: PreviewExactExportRequest) => void | Promise<void>;
  readonly exactExportCancelled: () => void;
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

interface RendererGeneration {
  readonly sessionId: string;
  readonly backendGeneration: number;
  readonly generation: number;
}

/** Owns only the preview panel and its host/webview transport lifecycle. */
export class PreviewWebviewHost implements vscode.Disposable {
  readonly #events: PreviewWebviewHostEvents;
  readonly #readyWaiters = new Set<PendingReadyWaiter>();
  readonly #pendingPublications = new Map<number, PendingPublication>();
  #panel: vscode.WebviewPanel | undefined;
  #panelDisposeRegistration: vscode.Disposable | undefined;
  #panelMessageRegistration: vscode.Disposable | undefined;
  #ready = false;
  #publicationSequence = 1;
  #rendererGeneration: RendererGeneration | undefined;
  #rendererResyncRequested: { readonly sessionId: string; readonly generation: number } | undefined;
  #disposed = false;

  constructor(events: PreviewWebviewHostEvents) {
    this.#events = events;
  }

  get isOpen(): boolean {
    return this.#panel !== undefined;
  }

  async open(title: string): Promise<void> {
    if (this.#disposed) throw new Error("Preview Webview host is disposed");
    if (this.#panel) {
      this.#panel.title = title;
      this.#panel.reveal(undefined, false);
      await this.waitUntilReady();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "mmt.typstPreview",
      title,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [previewWebviewRuntimeResourceRoot()],
      },
    );
    this.#panel = panel;
    this.#ready = false;
    this.#panelDisposeRegistration = panel.onDidDispose(() => this.#handlePanelClosed(panel));
    this.#panelMessageRegistration = panel.webview.onDidReceiveMessage((message: unknown) => {
      if (isPreviewWebviewToHostMessage(message)) void this.#dispatch(message);
    });
    panel.webview.html = previewWebviewHtml(panel.webview, title);
    await this.waitUntilReady();
  }

  reveal(): boolean {
    this.#panel?.reveal(undefined, false);
    return this.#panel !== undefined;
  }

  close(): void {
    this.#panel?.dispose();
  }

  async waitUntilReady(signal?: AbortSignal): Promise<void> {
    if (this.#ready) return;
    if (!this.#panel) throw new Error("Preview Webview is closed");
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
    if (!this.#panel || !firstPage || visual.kind !== "svg") return;
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
    const panel = this.#panel;
    if (!panel) throw new Error("Preview Webview is closed");
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
    if (!delivered || panel !== this.#panel) {
      this.#pendingPublications.delete(requestSequence);
      throw new Error("Preview Webview rejected the render publication");
    }
    return this.#waitForAcknowledgement(requestSequence, acknowledgement, publication.signal);
  }

  async publishRendererFrame(
    candidate: PreviewRendererCandidate,
    binding: TypstPreviewBinding,
  ): Promise<PreviewVisualReadyMessage> {
    const panel = this.#panel;
    if (!panel) throw new Error("Preview Webview is closed");
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
    if (!delivered || panel !== this.#panel) {
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
    if (this.#panel) this.#panel.dispose();
    else this.#rejectPending(new Error("Preview Webview host disposed"));
    this.#panelDisposeRegistration?.dispose();
    this.#panelMessageRegistration?.dispose();
    this.#panelDisposeRegistration = undefined;
    this.#panelMessageRegistration = undefined;
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
    return Promise.resolve(this.#panel?.webview.postMessage(message) ?? false);
  }

  async #dispatch(message: PreviewWebviewToHostMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.#ready = true;
        for (const waiter of [...this.#readyWaiters]) waiter.resolve();
        this.#events.ready?.();
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
      case "exact-export":
        await this.#events.exactExportRequested(message);
        return;
      case "exact-export-cancel":
        this.#events.exactExportCancelled();
        return;
    }
  }

  #handlePanelClosed(panel: vscode.WebviewPanel): void {
    if (this.#panel !== panel) return;
    this.#panel = undefined;
    this.#ready = false;
    this.clearRendererGeneration();
    this.#rejectPending(new Error("Preview Webview closed before visual readiness"));
    this.#panelDisposeRegistration?.dispose();
    this.#panelMessageRegistration?.dispose();
    this.#panelDisposeRegistration = undefined;
    this.#panelMessageRegistration = undefined;
    this.#events.closed?.();
  }

  #rejectPending(error: Error): void {
    for (const waiter of [...this.#readyWaiters]) waiter.reject(error);
    for (const pending of this.#pendingPublications.values()) pending.reject(error);
    this.#pendingPublications.clear();
  }
}

function previewWebviewRuntimeResourceUri(): vscode.Uri {
  return vscode.Uri.parse(new URL(previewWebviewRuntimeUrl, location.href).href);
}

function previewWebviewRuntimeResourceRoot(): vscode.Uri {
  return vscode.Uri.parse(new URL(".", previewWebviewRuntimeResourceUri().toString()).href);
}

function previewWebviewHtml(webview: vscode.Webview, title: string): string {
  const nonce = crypto.randomUUID().replaceAll("-", "");
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
    .status[hidden], .viewport[hidden] { display: none; }
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
