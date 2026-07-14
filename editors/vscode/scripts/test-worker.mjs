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
    async function waitForNotification(method, predicate = () => true) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const index = notifications.findIndex((message) => message.method === method && predicate(message));
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
    const semanticTokens = await request("textDocument/semanticTokens/full", {
      textDocument: { uri }
    });
    const completion = await request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 0, character: 1 }
    });
    const packSensitiveUri = "file:///workspace/pack-sensitive.mmt";
    notify("textDocument/didOpen", {
      textDocument: { uri: packSensitiveUri, languageId: "mmt", version: 1, text: "> 柚子: hello" }
    });
    const beforePackDiagnostics = await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === packSensitiveUri
    );
    if (!beforePackDiagnostics.params.diagnostics.some((diagnostic) => diagnostic.message.includes("unknown character preset"))) {
      throw new Error("pre-update unknown preset diagnostic is missing");
    }
    const beforePackProject = await waitForNotification(
      "mmt/typstProjectUpdated",
      (message) => message.params.sourceUri === packSensitiveUri
    );
    const beforePackText = beforePackProject.params.files.find(
      (file) => file.uri === beforePackProject.params.entryUri
    )?.text;
    const packUpdate = await request("mmt/updatePackManifests", {
      revision: 1,
      sources: [{
        manifestUrl: "https://example.test/manifest.json",
        baseUrl: "https://example.test/",
        json: JSON.stringify({
          schema: "mmt-pack.v3",
          pack: { namespace: "ba", name: "BA fixture", version: "1", type: "base" },
          entities: {
            "柚子": {
              names: ["柚子", "Yuzu"],
              display_name: "柚子",
              slots: { avatar: { default: "default", items: {
                default: { storage: "avatars", path: "yuzu.png" }
              } } }
            }
          },
          storage: { avatars: { kind: "image-dir", base: "assets/avatar" } }
        })
      }]
    });
    if (packUpdate.revision !== 1 || !packUpdate.updated) throw new Error("pack update was not acknowledged");
    const republishedDiagnostics = await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === packSensitiveUri
    );
    if (republishedDiagnostics.params.diagnostics.length !== 0) throw new Error("pack update left stale semantic diagnostics");
    const afterPackProject = await waitForNotification(
      "mmt/typstProjectUpdated",
      (message) => message.params.sourceUri === packSensitiveUri
    );
    const afterPackText = afterPackProject.params.files.find(
      (file) => file.uri === afterPackProject.params.entryUri
    )?.text;
    if (afterPackProject.params.sourceVersion !== beforePackProject.params.sourceVersion) {
      throw new Error("pack update changed the authored MMT source version");
    }
    if (afterPackProject.params.revision <= beforePackProject.params.revision) {
      throw new Error("pack update did not advance the virtual Typst projection revision");
    }
    if (afterPackText === beforePackText) throw new Error("pack update did not change projected Typst text");
    const beforePackRoot = beforePackProject.params.entryUri.slice(0, beforePackProject.params.entryUri.lastIndexOf("/"));
    const afterPackRoot = afterPackProject.params.entryUri.slice(0, afterPackProject.params.entryUri.lastIndexOf("/"));
    if (beforePackProject.params.entryUri === afterPackProject.params.entryUri) {
      throw new Error("projection revision reused its virtual entry URI");
    }
    if (beforePackRoot !== afterPackRoot || !/\/[0-9a-f]{32}$/.test(afterPackRoot)) {
      throw new Error(`projection session root is not stable UUID scope: ${afterPackRoot}`);
    }
    const requestedDiagnosticsNotification = waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === packSensitiveUri && message.params.version === 2
    );
    const requestedProject = await request("mmt/updateDocument", {
      textDocument: { uri: packSensitiveUri, version: 2 },
      contentChanges: [{ text: "> 柚子: updated" }]
    });
    await requestedDiagnosticsNotification;
    if (requestedProject.sourceVersion !== 2 || requestedProject.entryUri === afterPackProject.params.entryUri) {
      throw new Error("mmt/updateDocument did not unwrap its new project while forwarding diagnostics");
    }
    const presetUri = "file:///workspace/preset.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri: presetUri,
        languageId: "mmt",
        version: 1,
        text: "@actor yuzu\npreset: ba::柚\n@end\n> Yu"
      }
    });
    await waitForNotification("textDocument/publishDiagnostics", (message) => message.params.uri === presetUri);
    const presetCompletion = await request("textDocument/completion", {
      textDocument: { uri: presetUri },
      position: { line: 1, character: 13 }
    });
    const speakerCompletion = await request("textDocument/completion", {
      textDocument: { uri: presetUri },
      position: { line: 3, character: 4 }
    });
    const unknownUri = "file:///workspace/unknown-speaker.mmt";
    notify("textDocument/didOpen", {
      textDocument: { uri: unknownUri, languageId: "mmt", version: 1, text: "> ghost: hello" }
    });
    const semanticDiagnostics = await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === unknownUri
    );
    if (!semanticDiagnostics.params.diagnostics.some((diagnostic) => diagnostic.message.includes("unknown character preset"))) {
      throw new Error("browser Worker omitted unknown speaker semantic diagnostic");
    }
    const renderUri = "file:///workspace/render.mmt";
    const renderLanguageProjectPromise = waitForNotification(
      "mmt/typstProjectUpdated",
      (message) => message.params.sourceUri === renderUri
    );
    notify("textDocument/didOpen", {
      textDocument: {
        uri: renderUri,
        languageId: "mmt",
        version: 1,
        text: "@actor yuzu\npreset: ba::柚子\n@end\n> yuzu: Hello"
      }
    });
    await waitForNotification("textDocument/publishDiagnostics", (message) => message.params.uri === renderUri);
    const renderLanguageProject = await renderLanguageProjectPromise;
    const renderProject = await request("mmt/getTypstRenderProject", { uri: renderUri });
    if (renderProject.resources.length !== 1) throw new Error("render project omitted actor avatar");
    if (renderProject.resources[0].fileName !== "yuzu.png") throw new Error("render resource path mismatch");
    if (renderProject.entryUri !== renderLanguageProject.params.entryUri) {
      throw new Error("render project did not reuse the language projection session entry URI");
    }
    const renderEntry = renderProject.files.find((file) => file.uri === renderProject.entryUri);
    if (!renderEntry?.text?.includes("mmt-resources/0.png")) throw new Error("render entry omitted materialized avatar path");
    await request("shutdown", null);
    notify("exit", null);
    worker.terminate();
    return {
      positionEncoding: initialize.capabilities.positionEncoding,
      hoverProvider: initialize.capabilities.hoverProvider,
      semanticTokensProvider: initialize.capabilities.semanticTokensProvider,
      diagnosticCount: diagnostics.params.diagnostics.length,
      symbolNames: symbols.map((symbol) => symbol.name),
      foldingCount: folding.length,
      semanticTokenCount: semanticTokens.data.length,
      replySemanticToken: semanticTokens.data.slice(0, 5),
      completionLabels: completion.map((item) => item.label),
      presetLabels: presetCompletion.map((item) => item.label),
      speakerLabels: speakerCompletion.map((item) => item.label),
      semanticDiagnosticCount: semanticDiagnostics.params.diagnostics.length,
      packProjectionRevisions: [beforePackProject.params.revision, afterPackProject.params.revision],
      renderResource: renderProject.resources[0].fileName
    };
  }, `http://127.0.0.1:${address.port}/dist/${wasmAsset}`);

  if (result.positionEncoding !== "utf-16") throw new Error("position encoding mismatch");
  if (result.hoverProvider !== true) throw new Error("missing negotiated hover provider");
  if (!result.semanticTokensProvider?.full) throw new Error("missing negotiated semantic tokens provider");
  if (result.semanticTokenCount < 5) throw new Error("missing browser Worker semantic tokens");
  if (JSON.stringify(result.replySemanticToken) !== JSON.stringify([0, 0, 6, 0, 0])) {
    throw new Error(`unexpected @reply semantic token: ${JSON.stringify(result.replySemanticToken)}`);
  }
  if (result.diagnosticCount < 1) throw new Error("missing browser Worker diagnostics");
  if (!result.symbolNames.includes("@reply")) throw new Error("missing browser Worker symbol");
  if (result.foldingCount < 1) throw new Error("missing browser Worker folding range");
  if (!result.completionLabels.includes("@reply")) {
    throw new Error("missing browser Worker completion");
  }
  if (!result.presetLabels.includes("ba::柚子")) {
    throw new Error("missing browser Worker preset completion");
  }
  if (!result.speakerLabels.includes("Yuzu") || !result.speakerLabels.includes("ba::柚子")) {
    throw new Error("missing browser Worker speaker completion");
  }
  if (result.semanticDiagnosticCount < 1) throw new Error("missing browser Worker semantic diagnostics");
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
