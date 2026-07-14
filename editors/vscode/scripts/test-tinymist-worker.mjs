import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageRoot = process.env.TINYMIST_WEB_PKG
  ? path.resolve(process.env.TINYMIST_WEB_PKG)
  : undefined;
if (!packageRoot) {
  throw new Error("TINYMIST_WEB_PKG must point to the fixed tinymist-web pkg directory");
}

const roots = new Map([
  ["/extension/", extensionRoot],
  ["/tinymist/", packageRoot]
]);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
    return;
  }
  const route = [...roots].find(([prefix]) => pathname.startsWith(prefix));
  if (!route) {
    response.writeHead(404).end();
    return;
  }
  const [prefix, root] = route;
  const candidate = path.resolve(root, pathname.slice(prefix.length));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    if (!(await stat(candidate)).isFile()) throw new Error("not a file");
    const contentType = candidate.endsWith(".wasm")
      ? "application/wasm"
      : candidate.endsWith(".js")
        ? "text/javascript"
        : "text/plain";
    response.writeHead(200, { "Content-Type": contentType });
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("failed to bind test server");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on("console", (message) => console.error(`[browser:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[pageerror] ${error.stack ?? error.message}`));
  page.on("requestfailed", (request) =>
    console.error(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ""}`)
  );
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const result = await page.evaluate(async () => {
    const started = performance.now();
    const worker = new Worker("/extension/dist/tinymistWorker.js");
    let nextId = 1;
    const pending = new Map();
    const notifications = [];
    let workerFailure;

    worker.addEventListener("error", (event) => {
      workerFailure = `${event.message || "worker failed"} at ${event.filename}:${event.lineno}:${event.colno}`;
    });
    worker.addEventListener("messageerror", () => {
      workerFailure = "worker message could not be deserialized";
    });

    worker.addEventListener("message", (event) => {
      const message = event.data;
      if (message.method && message.id !== undefined) {
        const items = message.method === "workspace/configuration" ? message.params?.items ?? [] : [];
        worker.postMessage({
          jsonrpc: "2.0",
          id: message.id,
          result: items.map(() => null)
        });
        return;
      }
      if (message.id !== undefined && ("result" in message || "error" in message)) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
        return;
      }
      if (message.method) notifications.push(message);
      if (message.method === "tinymist/workerBootProgress") {
        console.log(`Tinymist boot: ${message.params.stage}`);
      }
    });

    function request(method, params) {
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60_000);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            reject(error);
          }
        });
      });
      worker.postMessage({ jsonrpc: "2.0", id, method, params });
      return response;
    }
    function notify(method, params) {
      worker.postMessage({ jsonrpc: "2.0", method, params });
    }
    async function waitFor(method) {
      const deadline = performance.now() + 300_000;
      while (performance.now() < deadline) {
        const index = notifications.findIndex((item) => item.method === method);
        if (index >= 0) return notifications.splice(index, 1)[0];
        const failed = notifications.find((item) => item.method === "tinymist/workerFailed");
        if (failed) throw new Error(failed.params.message);
        if (workerFailure) throw new Error(workerFailure);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`timeout waiting for ${method}`);
    }

    worker.postMessage({
      method: "tinymist/boot",
      params: {
        moduleUri: `${location.origin}/tinymist/tinymist.js`,
        wasmUri: `${location.origin}/tinymist/tinymist_bg.wasm`
      }
    });
    const ready = await waitFor("tinymist/workerReady");
    const initialize = await request("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {
        workspace: { configuration: true },
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: { versionSupport: true, relatedInformation: true }
        }
      }
    });
    notify("initialized", {});
    const uri = "untitled:/mmt-projection/browser/main.typ";
    notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "typst",
        version: 1,
        text: "#let greet(name) = [Hello #name]\n#greet(\"MMT\")\n#gre\n#let broken = ("
      }
    });
    const diagnosticsV1 = await waitFor("textDocument/publishDiagnostics");
    notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{
        text: "#let greet(name) = [Hello #name]\n#greet(\"MMT\")\n#gre\n#let broken = ["
      }]
    });
    const diagnosticsV2 = await waitFor("textDocument/publishDiagnostics");
    const completion = await request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 4 }
    });
    const hover = await request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 0, character: 7 }
    });
    const signature = await request("textDocument/signatureHelp", {
      textDocument: { uri },
      position: { line: 1, character: 6 },
      context: { triggerKind: 1, isRetrigger: false }
    });
    await request("shutdown", null);
    notify("exit", null);
    worker.terminate();
    return {
      startupMs: performance.now() - started,
      ready: ready.params,
      serverInfo: initialize.serverInfo,
      completion,
      hover,
      signature,
      diagnosticProvider: initialize.capabilities?.diagnosticProvider,
      diagnosticVersions: [diagnosticsV1.params.version, diagnosticsV2.params.version],
    };
  });

  const completionText = JSON.stringify(result.completion);
  if (result.ready.backendVersion !== "0.15.2") throw new Error("Tinymist version mismatch");
  const versionedDiagnostics = result.diagnosticVersions[0] === 1 && result.diagnosticVersions[1] === 2;
  const unversionedDiagnostics = result.diagnosticVersions.every((version) => version == null);
  if (!versionedDiagnostics && !unversionedDiagnostics) {
    throw new Error(`Tinymist returned inconsistent diagnostic versions: ${JSON.stringify(result.diagnosticVersions)}`);
  }
  if (!completionText.includes("greet")) throw new Error("missing user-defined completion");
  if (!result.hover) throw new Error("missing hover response");
  if (!result.signature?.signatures?.some((item) => item.label.includes("greet"))) {
    throw new Error(`missing signature help: ${JSON.stringify(result.signature)}`);
  }
  await page.addScriptTag({ url: `${page.url()}extension/dist/test/workerClient.js` });
  const replay = await page.evaluate(
    async ({ origin }) =>
      globalThis.runTinymistWorkerClientTest(
        `${origin}/extension/dist/tinymistWorker.js`,
        `${origin}/tinymist/tinymist.js`,
        `${origin}/tinymist/tinymist_bg.wasm`
      ),
    { origin: `http://127.0.0.1:${address.port}` }
  );
  if (!replay.before || !replay.changed || !replay.after || replay.restarted !== 1) {
    throw new Error(`Tinymist Worker replay failed: ${JSON.stringify(replay)}`);
  }
  console.log(
    JSON.stringify({
      startupMs: Math.round(result.startupMs),
      backend: result.ready,
      serverInfo: result.serverInfo,
      diagnosticVersions: result.diagnosticVersions,
      versionedDiagnostics,
      diagnosticProvider: result.diagnosticProvider,
      replay
    })
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
