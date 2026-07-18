import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const mode = process.argv[2];
if (mode !== "native" && mode !== "worker") {
  throw new Error("usage: node scripts/test-rich-provider-artifact.mjs native|worker");
}

const sourceText = [
  "#let greet(name) = [Hello #name]",
  "#greet(\"MMT\")",
  "#let shade=rgb(\"ff0000\")",
  "#read(\"base.typ\")",
  "$ $",
  ""
].join("\n");

function probeRequests(uri) {
  const document = { textDocument: { uri } };
  return [
    ["prepareRename", "textDocument/prepareRename", { ...document, position: { line: 0, character: 7 } }],
    ["rename", "textDocument/rename", { ...document, position: { line: 0, character: 7 }, newName: "welcome" }],
    ["formatting", "textDocument/formatting", { ...document, options: { tabSize: 2, insertSpaces: true } }],
    ["rangeFormatting", "textDocument/rangeFormatting", {
      ...document,
      range: { start: { line: 0, character: 0 }, end: { line: 4, character: 3 } },
      options: { tabSize: 2, insertSpaces: true }
    }],
    ["documentLink", "textDocument/documentLink", document],
    ["documentColor", "textDocument/documentColor", document],
    ["colorPresentation", "textDocument/colorPresentation", {
      ...document,
      color: { red: 1, green: 0, blue: 0, alpha: 1 },
      range: { start: { line: 2, character: 11 }, end: { line: 2, character: 24 } }
    }],
    ["codeAction", "textDocument/codeAction", {
      ...document,
      range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } },
      context: { diagnostics: [] }
    }],
    ["inlayHint", "textDocument/inlayHint", {
      ...document,
      range: { start: { line: 0, character: 0 }, end: { line: 1, character: 13 } }
    }],
    ["codeLens", "textDocument/codeLens", document],
    ["signatureHelp", "textDocument/signatureHelp", {
      ...document,
      position: { line: 1, character: 7 },
      context: { triggerKind: 1, isRetrigger: false }
    }]
  ];
}

function initializeParams() {
  return {
    processId: null,
    rootUri: null,
    capabilities: {
      workspace: { configuration: true, workspaceFolders: true },
      general: { positionEncodings: ["utf-16"] },
      textDocument: {
        rename: { dynamicRegistration: true, prepareSupport: true },
        documentFormatting: { dynamicRegistration: true },
        documentRangeFormatting: { dynamicRegistration: true },
        documentLink: { dynamicRegistration: true },
        colorProvider: { dynamicRegistration: true },
        codeAction: { dynamicRegistration: true, resolveSupport: { properties: ["edit"] } },
        inlayHint: { dynamicRegistration: true, resolveSupport: { properties: ["textEdits", "tooltip", "label"] } },
        codeLens: { dynamicRegistration: true },
        signatureHelp: { dynamicRegistration: true }
      }
    }
  };
}

function assertProbe(host, initialize, probes) {
  const capabilities = initialize.capabilities;
  assert.equal(initialize.serverInfo?.version, "0.15.2", `${host} version`);
  assert.equal(capabilities.positionEncoding, "utf-16", `${host} encoding`);
  assert.equal(capabilities.renameProvider?.prepareProvider, true, `${host} prepare rename advertisement`);
  for (const key of [
    "documentFormattingProvider",
    "documentRangeFormattingProvider",
    "documentLinkProvider",
    "colorProvider",
    "codeActionProvider",
    "inlayHintProvider",
    "codeLensProvider"
  ]) assert(capabilities[key], `${host} missing ${key}`);
  assert(probes.prepareRename && probes.prepareRename.range, `${host} prepare rename positive result`);
  const renameChanges = probes.rename?.changes ?? {};
  assert(Object.values(renameChanges).some((edits) => Array.isArray(edits) && edits.length >= 2), `${host} rename positive result`);
  assert(Array.isArray(probes.formatting), `${host} formatting request failed`);
  assert(Array.isArray(probes.rangeFormatting), `${host} range formatting request failed`);
  assert(Array.isArray(probes.documentLink) && probes.documentLink.length > 0, `${host} document-link positive result`);
  assert(Array.isArray(probes.documentColor) && probes.documentColor.length > 0, `${host} document-color positive result`);
  assert(Array.isArray(probes.colorPresentation) && probes.colorPresentation.length > 0, `${host} color-presentation positive result`);
  assert(probes.codeAction === null || Array.isArray(probes.codeAction), `${host} code-action protocol result`);
  assert.equal(probes.inlayHint, host === "native" ? null : undefined, `${host} inlay-hint negative transcript`);
  assert(Array.isArray(probes.codeLens) && probes.codeLens.some((item) => item.command?.command === "tinymist.exportPdf"),
    `${host} code-lens unsafe-command negative transcript`);
  assert.equal(capabilities.codeLensProvider.resolveProvider, false, `${host} code-lens resolve must remain disabled`);
  return {
    host,
    backendVersion: initialize.serverInfo.version,
    positionEncoding: capabilities.positionEncoding,
    qualified: {
      rename: true,
      formatting: true,
      rangeFormatting: true,
      documentLink: true,
      documentColor: true,
      colorPresentation: true,
      codeAction: true,
    },
    unavailable: {
      inlayHint: "native returns null and Worker returns no result for the checked positive fixture",
      codeLens: "effectful export command with resolveProvider=false"
    },
    responseKinds: Object.fromEntries(Object.entries(probes).map(([name, value]) => [
      name,
      value === null ? "null" : Array.isArray(value) ? `array:${value.length}` : typeof value
    ]))
  };
}

function serverRequestResult(message) {
  if (message.method === "workspace/configuration") {
    return (message.params?.items ?? []).map(() => ({ formatterMode: "typstyle" }));
  }
  if (message.method === "workspace/workspaceFolders") return [];
  if (message.method === "window/workDoneProgress/create" || message.method === "client/registerCapability"
    || message.method === "client/unregisterCapability") return null;
  return undefined;
}

async function nativeProbe() {
  const binary = process.env.TINYMIST_BIN;
  if (!binary) throw new Error("TINYMIST_BIN is required for the native rich-provider transcript");
  const child = spawn(binary, ["lsp"], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  const send = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const match = /Content-Length:\s*(\d+)/iu.exec(buffer.subarray(0, headerEnd).toString("ascii"));
      if (!match) throw new Error("Tinymist response omitted Content-Length");
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const message = JSON.parse(buffer.subarray(bodyStart, bodyStart + length).toString("utf8"));
      buffer = buffer.subarray(bodyStart + length);
      if (message.method && message.id !== undefined) {
        const result = serverRequestResult(message);
        send(result === undefined
          ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }
          : { jsonrpc: "2.0", id: message.id, result });
      } else if (message.id !== undefined) {
        const request = pending.get(message.id);
        if (!request) continue;
        pending.delete(message.id);
        message.error ? request.reject(Object.assign(new Error(message.error.message), message.error)) : request.resolve(message.result);
      }
    }
  });
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, 30_000);
      pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  };
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
  try {
    const initialize = await request("initialize", initializeParams());
    notify("initialized", {});
    const uri = "untitled:/rich-provider/native.typ";
    notify("textDocument/didOpen", { textDocument: {
      uri: "untitled:/rich-provider/base.typ",
      languageId: "typst",
      version: 1,
      text: "linked"
    } });
    notify("textDocument/didOpen", { textDocument: { uri, languageId: "typst", version: 1, text: sourceText } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const probes = {};
    for (const [name, method, params] of probeRequests(uri)) probes[name] = await request(method, params);
    const summary = assertProbe("native", initialize, probes);
    await request("shutdown", null);
    notify("exit", null);
    return summary;
  } finally {
    child.kill();
  }
}

async function workerProbe() {
  const packageRoot = process.env.TINYMIST_WEB_PKG ? path.resolve(process.env.TINYMIST_WEB_PKG) : undefined;
  if (!packageRoot) throw new Error("TINYMIST_WEB_PKG is required for the Worker rich-provider transcript");
  const roots = new Map([["/extension/", extensionRoot], ["/tinymist/", packageRoot]]);
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname === "/") return response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html>");
    const route = [...roots].find(([prefix]) => pathname.startsWith(prefix));
    if (!route) return response.writeHead(404).end();
    const [prefix, root] = route;
    const candidate = path.resolve(root, pathname.slice(prefix.length));
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return response.writeHead(403).end();
    try {
      if (!(await stat(candidate)).isFile()) throw new Error("not a file");
      const type = candidate.endsWith(".wasm") ? "application/wasm" : candidate.endsWith(".js") ? "text/javascript" : "text/plain";
      response.writeHead(200, { "Content-Type": type });
      createReadStream(candidate).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind Worker fixture server");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${address.port}/`);
    const output = await page.evaluate(async ({ sourceText, initialize, requests }) => {
      const worker = new Worker("/extension/dist/tinymistWorker.js");
      let nextId = 1;
      const pending = new Map();
      const request = (method, params) => {
        const id = nextId++;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 30_000);
          pending.set(id, {
            resolve: (value) => { clearTimeout(timeout); resolve(value); },
            reject: (error) => { clearTimeout(timeout); reject(error); }
          });
          worker.postMessage({ jsonrpc: "2.0", id, method, params });
        });
      };
      const notify = (method, params) => worker.postMessage({ jsonrpc: "2.0", method, params });
      worker.addEventListener("message", (event) => {
        const message = event.data;
        if (message.method && message.id !== undefined) {
          let result;
          if (message.method === "workspace/configuration") result = (message.params?.items ?? []).map(() => ({ formatterMode: "typstyle" }));
          else if (message.method === "workspace/workspaceFolders") result = [];
          else if (["window/workDoneProgress/create", "client/registerCapability", "client/unregisterCapability"].includes(message.method)) result = null;
          worker.postMessage(result === undefined
            ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } }
            : { jsonrpc: "2.0", id: message.id, result });
        } else if (message.id !== undefined) {
          const item = pending.get(message.id);
          if (!item) return;
          pending.delete(message.id);
          message.error ? item.reject(Object.assign(new Error(message.error.message), message.error)) : item.resolve(message.result);
        }
      });
      worker.postMessage({ method: "tinymist/boot", params: {
        moduleUri: `${location.origin}/tinymist/tinymist.js`,
        wasmUri: `${location.origin}/tinymist/tinymist_bg.wasm`
      } });
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("worker boot timeout")), 30_000);
        const listener = (event) => {
          if (event.data?.method !== "tinymist/workerReady") return;
          clearTimeout(timeout);
          worker.removeEventListener("message", listener);
          resolve();
        };
        worker.addEventListener("message", listener);
      });
      const initialized = await request("initialize", initialize);
      notify("initialized", {});
      const uri = "untitled:/rich-provider/worker.typ";
      notify("textDocument/didOpen", { textDocument: {
        uri: "untitled:/rich-provider/base.typ",
        languageId: "typst",
        version: 1,
        text: "linked"
      } });
      notify("textDocument/didOpen", { textDocument: { uri, languageId: "typst", version: 1, text: sourceText } });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const probes = {};
      for (const [name, method, params] of requests) probes[name] = await request(method, params);
      await request("shutdown", null);
      notify("exit", null);
      worker.terminate();
      return { initialize: initialized, probes };
    }, {
      sourceText,
      initialize: initializeParams(),
      requests: probeRequests("untitled:/rich-provider/worker.typ")
    });
    return assertProbe("worker", output.initialize, output.probes);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

const summary = mode === "native" ? await nativeProbe() : await workerProbe();
const qualification = JSON.parse(await readFile(path.join(
  extensionRoot,
  "src",
  "test",
  "fixtures",
  "tinymist-rich-provider-qualification.json"
), "utf8"));
assert.deepEqual(summary, qualification[mode], `${mode} rich-provider qualification evidence changed`);
console.log(JSON.stringify({ checked: true, ...summary }));
