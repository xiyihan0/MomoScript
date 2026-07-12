import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
    return;
  }
  const candidate = path.resolve(extensionRoot, `.${pathname}`);
  if (!candidate.startsWith(`${extensionRoot}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const file = await stat(candidate);
    if (!file.isFile()) {
      throw new Error("not a file");
    }
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
if (!address || typeof address === "string") {
  throw new Error("failed to bind worker test server");
}
const wasmAsset = (await readdir(path.join(extensionRoot, "dist"))).find((name) =>
  name.endsWith(".wasm")
);
if (!wasmAsset) throw new Error("built WASM asset was not found");

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on("console", (message) => console.error(`[browser:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[pageerror] ${error.stack ?? error.message}`));
  page.on("requestfailed", (request) =>
    console.error(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ""}`)
  );
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const result = await page.evaluate(async (wasmUri) => {
    const worker = new Worker("/dist/browserWorker.js");
    let nextId = 1;
    const pending = new Map();
    const notifications = [];
    let workerFailure;

    worker.addEventListener("error", (event) => {
      workerFailure = `${event.message || "worker initialization failed"} at ${event.filename}:${event.lineno}:${event.colno}`;
      for (const { reject } of pending.values()) {
        reject(new Error(event.message));
      }
      pending.clear();
    });
    worker.addEventListener("message", (event) => {
      const message = event.data;
      if ("id" in message && ("result" in message || "error" in message)) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new Error(message.error.message));
        else request.resolve(message.result);
      } else if (message.method) {
        notifications.push(message);
      }
    });

    function request(method, params) {
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timed out waiting for response to ${method}`));
        }, 10_000);
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
    async function waitForNotification(method) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const index = notifications.findIndex((message) => message.method === method);
        if (index >= 0) return notifications.splice(index, 1)[0];
        if (workerFailure) throw new Error(workerFailure);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`timed out waiting for ${method}`);
    }

    worker.postMessage({ method: "mmt/boot", params: { wasmUri } });
    await waitForNotification("mmt/workerReady");
    const initialize = await request("initialize", {
      capabilities: { general: { positionEncodings: ["utf-16"] } },
      initializationOptions: { previewOnChange: false, typstLanguageFeatures: true }
    });
    notify("initialized", {});
    const uri = "file:///workspace/browser-worker.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "mmt",
        version: 1,
        text: "@reply\n- 选项 A\n- 选项 B\n@end\n@end"
      }
    });
    const diagnostics = await waitForNotification("textDocument/publishDiagnostics");
    const symbols = await request("textDocument/documentSymbol", { textDocument: { uri } });
    const folding = await request("textDocument/foldingRange", { textDocument: { uri } });
    const completion = await request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 0, character: 1 }
    });
    const packUpdate = await request("mmt/updatePackManifests", {
      revision: 1,
      sources: [{
        manifestUrl: "https://example.test/manifest.json",
        baseUrl: "https://example.test/",
        json: JSON.stringify({
          schema: "mmt-pack.v3",
          pack: { namespace: "ba", name: "BA fixture", version: "1", type: "base" },
          entities: { "柚子": { names: ["柚子", "Yuzu"], display_name: "柚子" } }
        })
      }]
    });
    if (packUpdate.revision !== 1 || !packUpdate.updated) throw new Error("pack update was not acknowledged");
    const presetUri = "file:///workspace/preset.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri: presetUri,
        languageId: "mmt",
        version: 1,
        text: "@actor yuzu\npreset: ba::柚\n@end"
      }
    });
    await waitForNotification("textDocument/publishDiagnostics");
    const presetCompletion = await request("textDocument/completion", {
      textDocument: { uri: presetUri },
      position: { line: 1, character: 13 }
    });
    await request("shutdown", null);
    notify("exit", null);
    worker.terminate();
    return {
      positionEncoding: initialize.capabilities.positionEncoding,
      hoverProvider: initialize.capabilities.hoverProvider,
      diagnosticCount: diagnostics.params.diagnostics.length,
      symbolNames: symbols.map((symbol) => symbol.name),
      foldingCount: folding.length,
      completionLabels: completion.map((item) => item.label),
      presetLabels: presetCompletion.map((item) => item.label)
    };
  }, `http://127.0.0.1:${address.port}/dist/${wasmAsset}`);

  if (result.positionEncoding !== "utf-16") throw new Error("position encoding mismatch");
  if (result.hoverProvider !== true) throw new Error("missing negotiated hover provider");
  if (result.diagnosticCount < 1) throw new Error("missing browser Worker diagnostics");
  if (!result.symbolNames.includes("@reply")) throw new Error("missing browser Worker symbol");
  if (result.foldingCount < 1) throw new Error("missing browser Worker folding range");
  if (!result.completionLabels.includes("@reply")) {
    throw new Error("missing browser Worker completion");
  }
  if (!result.presetLabels.includes("ba::柚子")) {
    throw new Error("missing browser Worker preset completion");
  }
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
