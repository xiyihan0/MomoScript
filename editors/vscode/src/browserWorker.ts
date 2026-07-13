import {
  BrowserMessageReader,
  BrowserMessageWriter,
  createConnection
} from "vscode-languageserver/browser";
import init, { WasmLanguageServer } from "../wasm/mmt_lsp.js";

type ServerEvent = { method: string; params: unknown };
type ResponseEnvelope = { result?: unknown; error?: { code: number; message: string } };
type NotificationOutcome = {
  events: ServerEvent[];
  error?: { code: number; message: string };
};

async function start(wasmUri: string): Promise<void> {
  await init({ module_or_path: new URL(wasmUri) });
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

  function notification(method: string, params: unknown): void {
    const outcome = JSON.parse(
      server.notification(method, JSON.stringify(params))
    ) as NotificationOutcome;
    for (const event of outcome.events) {
      connection.sendNotification(event.method, event.params);
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
  connection.onRequest("mmt/updatePackManifests", (params) =>
    request("mmt/updatePackManifests", params)
  );
  connection.onRequest("mmt/getTypstProject", (params) =>
    request("mmt/getTypstProject", params)
  );
  connection.onRequest("mmt/getTypstRenderProject", (params) =>
    request("mmt/getTypstRenderProject", params)
  );
  connection.onRequest("mmt/updateDocument", (params) =>
    request("mmt/updateDocument", params)
  );
  connection.onDocumentSymbol((params) => request("textDocument/documentSymbol", params));
  connection.onFoldingRanges((params) => request("textDocument/foldingRange", params));
  connection.onCompletion((params) => request("textDocument/completion", params));
  connection.onHover((params) => request("textDocument/hover", params));
  connection.onSignatureHelp((params) => request("textDocument/signatureHelp", params));
  connection.onRequest("mmt/typstPosition", (params) =>
    request("mmt/typstPosition", params)
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
  connection.listen();
  self.postMessage({ jsonrpc: "2.0", method: "mmt/workerReady", params: null });
}

function waitForBoot(): Promise<string> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.data?.method !== "mmt/boot") return;
      self.removeEventListener("message", listener);
      resolve(event.data.params.wasmUri as string);
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
