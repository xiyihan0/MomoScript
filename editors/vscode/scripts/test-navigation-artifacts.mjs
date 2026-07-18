import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = [
  "#let greet(name) = [Hello #name]",
  "#let outer(value) = {",
  "  let nested = value",
  "  nested",
  "}",
  "#greet(\"one\")",
  "#greet(\"two\")",
  "#outer(1)",
  "= Parent",
  "== Child",
  "#for i in range(2) {",
  "  if i == 1 { break }",
  "  break",
  "}"
].join("\n");

function initializeParams(rootUri) {
  return {
    processId: null,
    rootUri,
    capabilities: {
      general: { positionEncodings: ["utf-16"] },
      workspace: { configuration: true, symbol: { dynamicRegistration: true, resolveSupport: { properties: ["location.range"] } } },
      textDocument: {
        definition: { dynamicRegistration: true, linkSupport: true },
        documentHighlight: { dynamicRegistration: true },
        documentSymbol: { dynamicRegistration: true, hierarchicalDocumentSymbolSupport: true },
        implementation: { dynamicRegistration: true, linkSupport: true },
        references: { dynamicRegistration: true },
        typeDefinition: { dynamicRegistration: true, linkSupport: true },
        selectionRange: { dynamicRegistration: true },
        publishDiagnostics: { versionSupport: true }
      }
    },
    clientInfo: { name: "mmt-navigation-transcript", version: "1" }
  };
}

async function exercise(rpc, uri, rootUri) {
  const initialize = await rpc.request("initialize", initializeParams(rootUri));
  rpc.notify("initialized", {});
  await rpc.pause(250);
  rpc.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "typst", version: 1, text: source }
  });
  await rpc.pause(350);
  const definition = await rpc.request("textDocument/definition", {
    textDocument: { uri }, position: { line: 5, character: 2 }
  });
  const references = await rpc.request("textDocument/references", {
    textDocument: { uri }, position: { line: 0, character: 6 }, context: { includeDeclaration: true }
  });
  const highlights = await rpc.request("textDocument/documentHighlight", {
    textDocument: { uri }, position: { line: 11, character: 19 }
  });
  const selectionRanges = await rpc.request("textDocument/selectionRange", {
    textDocument: { uri }, positions: [{ line: 11, character: 19 }]
  });
  const documentSymbols = await rpc.request("textDocument/documentSymbol", {
    textDocument: { uri }
  });
  const workspaceSymbols = await rpc.request("workspace/symbol", { query: "greet" });
  const cancelled = rpc.rawRequest("textDocument/references", {
    textDocument: { uri }, position: { line: 0, character: 6 }, context: { includeDeclaration: true }
  });
  rpc.notify("$/cancelRequest", { id: cancelled.id });
  const cancelledOutcome = await cancelled.response;
  rpc.notify("textDocument/didClose", { textDocument: { uri } });
  await rpc.request("shutdown", null);
  rpc.notify("exit", null);
  return {
    initialize,
    definition,
    references,
    highlights,
    documentSymbols,
    workspaceSymbols,
    selectionRanges,
    cancelledOutcome,
    serverRequests: rpc.serverRequests
  };
}

function verify(host, transcript) {
  const capabilities = transcript.initialize.capabilities ?? {};
  for (const key of [
    "definitionProvider",
    "referencesProvider",
    "documentSymbolProvider",
    "workspaceSymbolProvider",
    "documentHighlightProvider",
    "selectionRangeProvider"
  ]) assert(capabilities[key], `${host} omitted ${key}`);
  assert.equal(Boolean(capabilities.typeDefinitionProvider), false, `${host} unexpectedly advertised typeDefinition`);
  assert.equal(Boolean(capabilities.implementationProvider), false, `${host} unexpectedly advertised implementation`);

  const definitions = Array.isArray(transcript.definition) ? transcript.definition : [transcript.definition];
  assert(definitions.some((item) => item && (item.uri || item.targetUri)), `${host} definition has no target`);
  assert(Array.isArray(transcript.references) && transcript.references.length >= 3, `${host} references omitted multi-location result`);
  assert(Array.isArray(transcript.highlights) && transcript.highlights.length > 0, `${host} document highlights absent`);
  assert(Array.isArray(transcript.selectionRanges) && transcript.selectionRanges.length === 1, `${host} selection range absent`);
  assert(transcript.selectionRanges[0]?.parent, `${host} selection range omitted its parent chain`);
  assert(Array.isArray(transcript.documentSymbols) && transcript.documentSymbols.length > 0, `${host} document symbols absent`);
  const symbolText = JSON.stringify(transcript.documentSymbols);
  assert(symbolText.includes("Parent") && symbolText.includes("Child"), `${host} heading symbols absent`);
  assert(Array.isArray(transcript.workspaceSymbols), `${host} workspace symbols are not a list`);
  return {
    host,
    providers: {
      definition: definitions.length,
      references: transcript.references.length,
      highlights: transcript.highlights.length,
      selectionRanges: transcript.selectionRanges.length,
      documentSymbols: transcript.documentSymbols.length,
      workspaceSymbols: transcript.workspaceSymbols.length,
      hierarchicalHeadings: symbolText.includes("children") && symbolText.includes("Parent") && symbolText.includes("Child")
    },
    absent: { typeDefinition: true, implementation: true },
    cancellation: transcript.cancelledOutcome.error?.code ?? "completed-before-cancel",
    dynamicRegistrations: transcript.serverRequests.filter((item) => item.method === "client/registerCapability").length
  };
}

class NativeRpc {
  nextId = 1;
  buffer = Buffer.alloc(0);
  pending = new Map();
  serverRequests = [];

  constructor(command) {
    this.child = spawn(command, ["lsp"], { stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = "";
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.child.stdout.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  send(message) {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  rawRequest(method, params) {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`native ${method} timed out; stderr=${this.stderr}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timeout });
    });
    this.send({ jsonrpc: "2.0", id, method, params });
    return { id, response };
  }

  async request(method, params) {
    const message = await this.rawRequest(method, params).response;
    if (message.error) throw new Error(`${method}: ${message.error.code} ${message.error.message}`);
    return message.result;
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async pause(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  drain() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString("ascii"))?.[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (!Number.isSafeInteger(length) || this.buffer.byteLength < bodyEnd) return;
      const message = JSON.parse(this.buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      this.buffer = this.buffer.subarray(bodyEnd);
      if (message.method && message.id !== undefined) {
        this.serverRequests.push(message);
        const result = message.method === "workspace/configuration"
          ? (message.params?.items ?? []).map(() => null)
          : message.method === "workspace/workspaceFolders"
            ? []
            : null;
        this.send({ jsonrpc: "2.0", id: message.id, result });
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(message.id);
          pending.resolve(message);
        }
      }
    }
  }

  stop() {
    if (this.child.exitCode === null) this.child.kill();
  }
}

async function nativeTranscript() {
  const command = process.env.TINYMIST_BIN;
  if (!command) throw new Error("TINYMIST_BIN is required");
  const rpc = new NativeRpc(path.resolve(command));
  try {
    return await exercise(rpc, "file:///tmp/mmt-navigation-transcript/main.typ", "file:///tmp/mmt-navigation-transcript");
  } finally {
    rpc.stop();
  }
}

async function webTranscript() {
  const packageRoot = process.env.TINYMIST_WEB_PKG ? path.resolve(process.env.TINYMIST_WEB_PKG) : undefined;
  if (!packageRoot) throw new Error("TINYMIST_WEB_PKG is required");
  const roots = new Map([["/extension/", root], ["/tinymist/", packageRoot]]);
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
    const [prefix, directory] = route;
    const candidate = path.resolve(directory, pathname.slice(prefix.length));
    try {
      if ((candidate !== directory && !candidate.startsWith(`${directory}${path.sep}`)) || !(await stat(candidate)).isFile()) {
        throw new Error("invalid path");
      }
      response.writeHead(200, { "Content-Type": candidate.endsWith(".wasm") ? "application/wasm" : "text/javascript" });
      createReadStream(candidate).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind Web transcript server");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    return await page.evaluate(async ({ source, initializeParams }) => {
      const worker = new Worker("/extension/dist/tinymistWorker.js");
      let nextId = 1;
      const pending = new Map();
      const notifications = [];
      const serverRequests = [];
      worker.addEventListener("message", (event) => {
        const message = event.data;
        if (message.method && message.id !== undefined) {
          serverRequests.push(message);
          const result = message.method === "workspace/configuration"
            ? (message.params?.items ?? []).map(() => null)
            : message.method === "workspace/workspaceFolders"
              ? []
              : null;
          worker.postMessage({ jsonrpc: "2.0", id: message.id, result });
        } else if (message.id !== undefined) {
          const entry = pending.get(message.id);
          if (entry) {
            pending.delete(message.id);
            clearTimeout(entry.timeout);
            entry.resolve(message);
          }
        } else if (message.method) notifications.push(message);
      });
      const rawRequest = (method, params) => {
        const id = nextId++;
        const response = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`Worker ${method} timed out`));
          }, 20_000);
          pending.set(id, { resolve, reject, timeout });
        });
        worker.postMessage({ jsonrpc: "2.0", id, method, params });
        return { id, response };
      };
      const request = async (method, params) => {
        const message = await rawRequest(method, params).response;
        if (message.error) throw new Error(`${method}: ${message.error.code} ${message.error.message}`);
        return message.result;
      };
      const notify = (method, params) => worker.postMessage({ jsonrpc: "2.0", method, params });
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      worker.postMessage({
        method: "tinymist/boot",
        params: { moduleUri: `${location.origin}/tinymist/tinymist.js`, wasmUri: `${location.origin}/tinymist/tinymist_bg.wasm` }
      });
      const deadline = performance.now() + 60_000;
      while (!notifications.some((item) => item.method === "tinymist/workerReady")) {
        if (performance.now() > deadline) throw new Error("Worker boot timed out");
        await pause(20);
      }
      const uri = "untitled:/mmt-navigation-transcript/main.typ";
      const initialize = await request("initialize", initializeParams);
      notify("initialized", {});
      await pause(250);
      notify("textDocument/didOpen", { textDocument: { uri, languageId: "typst", version: 1, text: source } });
      await pause(350);
      const definition = await request("textDocument/definition", { textDocument: { uri }, position: { line: 5, character: 2 } });
      const references = await request("textDocument/references", { textDocument: { uri }, position: { line: 0, character: 6 }, context: { includeDeclaration: true } });
      const highlights = await request("textDocument/documentHighlight", { textDocument: { uri }, position: { line: 11, character: 19 } });
      const selectionRanges = await request("textDocument/selectionRange", { textDocument: { uri }, positions: [{ line: 11, character: 19 }] });
      const documentSymbols = await request("textDocument/documentSymbol", { textDocument: { uri } });
      const workspaceSymbols = await request("workspace/symbol", { query: "greet" });
      const cancelled = rawRequest("textDocument/references", { textDocument: { uri }, position: { line: 0, character: 6 }, context: { includeDeclaration: true } });
      notify("$/cancelRequest", { id: cancelled.id });
      const cancelledOutcome = await cancelled.response;
      notify("textDocument/didClose", { textDocument: { uri } });
      await request("shutdown", null);
      notify("exit", null);
      worker.terminate();
      return { initialize, definition, references, highlights, selectionRanges, documentSymbols, workspaceSymbols, cancelledOutcome, serverRequests };
    }, { source, initializeParams: initializeParams(null) });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

const native = verify("native", await nativeTranscript());
const web = verify("web", await webTranscript());
const nativeDigest = createHash("sha256").update(await readFile(path.resolve(process.env.TINYMIST_BIN))).digest("hex");
const webDigest = createHash("sha256").update(await readFile(path.resolve(process.env.TINYMIST_WEB_PKG, "tinymist_bg.wasm"))).digest("hex");
const evidence = { schema: "mmt-typst-navigation-transcript.v1", artifacts: { native: nativeDigest, web: webDigest }, native, web };
if (process.env.TINYMIST_SHA256_FILE) {
  const manifest = (await readFile(path.resolve(process.env.TINYMIST_SHA256_FILE), "utf8")).trim();
  const match = /^([a-f0-9]{64})\s+(.+)$/.exec(manifest);
  if (!match) throw new Error(`invalid native checksum manifest: ${process.env.TINYMIST_SHA256_FILE}`);
  assert.equal(nativeDigest, match[1], "native artifact matches its runtime checksum manifest");
}
if (process.env.TINYMIST_WEB_SHA256_FILE) {
  const manifest = (await readFile(path.resolve(process.env.TINYMIST_WEB_SHA256_FILE), "utf8")).trim();
  const match = manifest.split("\n")
    .map((line) => /^([a-f0-9]{64})\s+(.+)$/.exec(line))
    .find((entry) => entry?.[2] === "tinymist_bg.wasm");
  if (!match) throw new Error(`invalid Web checksum manifest: ${process.env.TINYMIST_WEB_SHA256_FILE}`);
  assert.equal(webDigest, match[1], "Web artifact matches its runtime checksum manifest");
}
const checkedPath = path.join(root, "src/test/fixtures/typst-navigation-evidence.json");
if (process.env.UPDATE_TINYMIST_NAVIGATION_EVIDENCE === "1") {
  await writeFile(checkedPath, `${JSON.stringify(evidence, null, 2)}\n`);
} else {
  const checked = JSON.parse(await readFile(checkedPath, "utf8"));
  const comparisonEvidence = structuredClone(evidence);
  if (process.env.TINYMIST_SHA256_FILE) {
    comparisonEvidence.artifacts.native = checked.artifacts.native;
  }
  if (process.env.TINYMIST_WEB_SHA256_FILE) {
    comparisonEvidence.artifacts.web = checked.artifacts.web;
  }
  assert.deepEqual(comparisonEvidence, checked, "navigation evidence changed for the pinned source and patch");
}
console.log(JSON.stringify(evidence, null, 2));
