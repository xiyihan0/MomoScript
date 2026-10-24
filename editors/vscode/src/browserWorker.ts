import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection
} from "vscode-languageserver/browser";
import { initSync, WasmLanguageServer } from "../wasm/mmt_lsp.js";
import { parseRenderPreset, type RenderPreset } from "./renderPreset";
import type { TypstRenderProjectUpdate } from "./tinymistClient";

type ServerEvent = { method: string; params: unknown };
type ResponseEnvelope = { result?: unknown; error?: { code: number; message: string } };
type NotificationOutcome = {
  events: ServerEvent[];
  error?: { code: number; message: string };
};
type PackUpdateOutcome = { revision: number; updated: boolean; events?: ServerEvent[] };

async function start(wasmBytes: ArrayBuffer): Promise<void> {
  initSync({ module: wasmBytes });
  const server = new WasmLanguageServer();
  const connection = createConnection(
    new BrowserMessageReader(self),
    new BrowserMessageWriter(self)
  );

  function request<T>(method: string, params: unknown): T {
    const envelope = JSON.parse(
      server.request(method, JSON.stringify(params))
    ) as ResponseEnvelope;
    if (envelope.error) {
      throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
    }
    return envelope.result as T;
  }

  function sendEvent(event: ServerEvent): void {
    if (event.method === "mmt/typstRenderProjectUpdated") {
      const update = event.params as { renderPreset?: unknown } | null;
      parseRenderPreset(update?.renderPreset);
    }
    connection.sendNotification(event.method, event.params);
  }

  function notification(method: string, params: unknown): void {
    const outcome = JSON.parse(
      server.notification(method, JSON.stringify(params))
    ) as NotificationOutcome;
    for (const event of outcome.events) {
      sendEvent(event);
    }
    if (outcome.error) {
      console.error(`${method}: ${outcome.error.code}: ${outcome.error.message}`);
    }
  }

  connection.onInitialize((params) => request("initialize", params));
  connection.onShutdown(() => request("shutdown", null));
  connection.onInitialized((params) => notification("initialized", params));
  connection.onDidOpenTextDocument((params) => notification("textDocument/didOpen", params));
  connection.onDidChangeTextDocument((params) => notification("textDocument/didChange", params));
  connection.onDidCloseTextDocument((params) => notification("textDocument/didClose", params));
  connection.onRequest("mmt/updatePackManifests", (params) => {
    const outcome = request<PackUpdateOutcome>("mmt/updatePackManifests", params);
    for (const event of outcome.events ?? []) sendEvent(event);
    return outcome;
  });
  connection.onRequest("mmt/getTypstProject", (params) =>
    request("mmt/getTypstProject", params)
  );
  connection.onRequest("mmt/getTypstRenderProject", (params) => {
    const requested = typeof params === "object" && params !== null && Object.hasOwn(params, "renderPreset")
      ? parseRenderPreset((params as Record<string, unknown>).renderPreset)
      : { kind: "output" } as const;
    const outcome = request<(TypstRenderProjectUpdate & { events?: ServerEvent[] }) | null>(
      "mmt/getTypstRenderProject",
      params
    );
    if (outcome === null) return null;
    const renderPreset = parseRenderPreset(outcome.renderPreset);
    if (!renderPresetsMatch(renderPreset, requested)) {
      throw new Error("MomoScript render response preset does not match its request");
    }
    for (const event of outcome.events ?? []) sendEvent(event);
    const { events: _, ...update } = outcome;
    return update;
  });
  connection.onRequest("mmt/getDocumentConfig", (params) =>
    request("mmt/getDocumentConfig", params)
  );
  connection.onRequest("mmt/previewComposerTarget", (params) =>
    request("mmt/previewComposerTarget", params)
  );
  connection.onRequest("mmt/composerDocument", (params) =>
    request("mmt/composerDocument", params)
  );
  connection.onRequest("mmt/composerTextSelection", (params) =>
    request("mmt/composerTextSelection", params)
  );
  connection.onRequest("mmt/composerTextProjection", (params) =>
    request("mmt/composerTextProjection", params)
  );
  connection.onRequest("mmt/composerEdit", (params) =>
    request("mmt/composerEdit", params)
  );
  connection.onDocumentSymbol((params) => request("textDocument/documentSymbol", params));
  connection.onFoldingRanges((params) => request("textDocument/foldingRange", params));
  connection.languages.semanticTokens.on((params) =>
    request("textDocument/semanticTokens/full", params)
  );
  connection.languages.inlayHint.on((params) =>
    request("textDocument/inlayHint", params)
  );
  connection.onCompletion((params) => request("textDocument/completion", params));
  connection.onHover((params) => request("textDocument/hover", params));
  connection.onSignatureHelp((params) => request("textDocument/signatureHelp", params));
  connection.onDefinition((params) => request("textDocument/definition", params));
  connection.onReferences((params) => request("textDocument/references", params));
  connection.onPrepareRename((params) => request("textDocument/prepareRename", params));
  connection.onRenameRequest((params) => request("textDocument/rename", params));
  connection.onRequest("mmt/semanticRoute", (params) =>
    request("mmt/semanticRoute", params)
  );
  connection.onRequest("mmt/typstPosition", (params) =>
    request("mmt/typstPosition", params)
  );
  connection.onRequest("mmt/typstRange", (params) =>
    request("mmt/typstRange", params)
  );
  connection.onRequest("mmt/mapTypstCompletion", (params) =>
    request("mmt/mapTypstCompletion", params)
  );
  connection.onRequest("mmt/mapTypstHover", (params) =>
    request("mmt/mapTypstHover", params)
  );
  connection.onRequest("mmt/mapTypstDiagnostics", (params) =>
    request("mmt/mapTypstDiagnostics", params)
  );
  connection.onRequest("mmt/mapTypstReadLocations", (params) =>
    request("mmt/mapTypstReadLocations", params)
  );
  connection.listen();
  self.postMessage({ jsonrpc: "2.0", method: "mmt/workerReady", params: null });
}

function renderPresetsMatch(left: RenderPreset, right: RenderPreset): boolean {
  return left.kind === right.kind
    && (left.kind !== "chat" || (right.kind === "chat" && left.widthPt === right.widthPt));
}

function waitForBoot(): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent) => {
      if (event.data?.method !== "mmt/boot") return;
      self.removeEventListener("message", listener);
      const wasmBytes = event.data.params?.wasmBytes;
      if (wasmBytes instanceof ArrayBuffer) resolve(wasmBytes);
      else reject(new Error("MomoScript worker boot requires WASM bytes"));
    };
    self.addEventListener("message", listener);
  });
}

void waitForBoot().then(start).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  self.postMessage({
    jsonrpc: "2.0",
    method: "mmt/workerFailed",
    params: { message }
  });
});
