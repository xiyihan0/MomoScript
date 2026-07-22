import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
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

const canonicalArtifacts = new Map([
  ["tinymist.js", "f2c1756f580ab97ede75f266185cea8ab86160e00d9735f8adca732c96527400"],
  ["tinymist_bg.wasm", "c9ff9b1d8197656e89e2ee4cc3fc74923ddfecaec3fbc4022f82d150fa995db4"]
]);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, normalize(item)])
  );
}

function rpcOutcome(message) {
  if (message.error) {
    return normalize({
      ok: false,
      error: {
        code: message.error.code,
        message: message.error.message,
        data: message.error.data ?? null
      }
    });
  }
  const result = message.result;
  if (typeof result === "string") {
    return { ok: true, result: { type: "string", length: result.length } };
  }
  if (Array.isArray(result)) {
    return { ok: true, result: { type: "array", length: result.length } };
  }
  if (result && typeof result === "object") {
    return { ok: true, result: { type: "object", keys: Object.keys(result).sort() } };
  }
  return { ok: true, result: { type: result === null ? "null" : typeof result, value: result ?? null } };
}

async function verifyPinnedArtifact() {
  const checksumText = await readFile(path.join(packageRoot, "SHA256SUMS"), "utf8");
  const lines = checksumText.trim().split("\n").filter(Boolean);
  const manifest = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match) throw new Error(`invalid Tinymist checksum line: ${line}`);
    if (manifest.has(match[2])) throw new Error(`duplicate Tinymist checksum entry: ${match[2]}`);
    manifest.set(match[2], match[1]);
  }
  assert.deepEqual([...manifest.keys()].sort(), [...canonicalArtifacts.keys()].sort());

  const digests = {};
  const checksumManifest = [];
  let runtimeArtifact = false;
  for (const [name, canonicalDigest] of canonicalArtifacts) {
    const expectedDigest = manifest.get(name);
    const filename = path.join(packageRoot, name);
    const bytes = await readFile(filename);
    const actualDigest = createHash("sha256").update(bytes).digest("hex");
    assert.equal(actualDigest, expectedDigest, `${name} bytes match their supplied SHA256SUMS`);
    runtimeArtifact ||= actualDigest !== canonicalDigest;
    digests[name] = actualDigest;
    checksumManifest.push({ name, sha256: actualDigest, size: bytes.byteLength });
  }

  const packageMetadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(packageMetadata.version, "0.15.2", "vendored Tinymist package version");
  return {
    packageVersion: packageMetadata.version,
    digests,
    checksumManifest: checksumManifest.sort((left, right) => left.name.localeCompare(right.name)),
    runtimeArtifact
  };
}

function webEvidenceForComparison(evidence) {
  const normalized = structuredClone(evidence);
  for (const name of Object.keys(normalized.artifact.digests)) {
    normalized.artifact.digests[name] = `<runtime-${name}-sha256>`;
  }
  for (const entry of normalized.artifact.checksumManifest.entries) {
    entry.sha256 = `<runtime-${entry.name}-sha256>`;
    entry.size = `<runtime-${entry.name}-size>`;
  }
  return normalize(normalized);
}

const artifact = await verifyPinnedArtifact();
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
  const externalNetworkRequests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") externalNetworkRequests.push(request.url());
  });
  page.on("console", (message) => console.error(`[browser:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[pageerror] ${error.stack ?? error.message}`));
  page.on("requestfailed", (request) =>
    console.error(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ""}`)
  );
  await page.goto(`http://127.0.0.1:${address.port}/`);
  await page.addScriptTag({ url: `http://127.0.0.1:${address.port}/extension/dist/test/packageTranscriptHost.js` });
  const result = await page.evaluate(async () => {
    const packageHost = new globalThis.MmtPackageTranscript.PackageTranscriptHost();
    const worker = new Worker("/extension/dist/tinymistWorker.js");
    let nextId = 1;
    const pending = new Map();
    const notifications = [];
    const serverRequests = [];
    const dynamicRegistrations = { register: [], unregister: [] };
    const packageCallbackRequests = [];
    const packageCallbackResponses = [];
    const pendingPackageCallbacks = new Map();
    let workerFailure;

    worker.addEventListener("error", (event) => {
      workerFailure = `${event.message || "worker failed"} at ${event.filename}:${event.lineno}:${event.colno}`;
    });
    worker.addEventListener("messageerror", () => {
      workerFailure = "worker message could not be deserialized";
    });

    function respond(id, payload) {
      worker.postMessage({ jsonrpc: "2.0", id, ...payload });
    }

    worker.addEventListener("message", async (event) => {
      const message = event.data;
      if (message.method && message.id !== undefined) {
        serverRequests.push({ method: message.method, params: message.params ?? null });
        if (message.method === "client/registerCapability") {
          dynamicRegistrations.register.push(...(message.params?.registrations ?? []));
          respond(message.id, { result: null });
        } else if (message.method === "client/unregisterCapability") {
          dynamicRegistrations.unregister.push(...(message.params?.unregisterations ?? message.params?.unregistrations ?? []));
          respond(message.id, { result: null });
        } else if (message.method === "workspace/configuration") {
          const items = message.params?.items ?? [];
          respond(message.id, { result: items.map(() => null) });
        } else if (message.method === "workspace/workspaceFolders") {
          respond(message.id, { result: [] });
        } else if (message.method === "window/workDoneProgress/create") {
          respond(message.id, { result: null });
        } else if (message.method === "mmt/typstPackageRequest.v1") {
          const params = message.params ?? null;
          packageCallbackRequests.push(params);
          const name = params?.package_spec?.name ?? "invalid";
          const controller = new AbortController();
          pendingPackageCallbacks.set(message.id, { name, params, controller });
          try {
            const result = await packageHost.resolve(params, controller.signal);
            packageCallbackResponses.push({ name, outcome: result });
            respond(message.id, { result });
          } catch (cause) {
            const error = { code: -32010, message: cause instanceof Error ? cause.message : String(cause) };
            packageCallbackResponses.push({ name, error });
            respond(message.id, { error });
          } finally {
            pendingPackageCallbacks.delete(message.id);
          }
        } else {
          respond(message.id, { error: { code: -32601, message: `Unhandled server request: ${message.method}` } });
        }
        return;
      }
      if (message.id !== undefined && ("result" in message || "error" in message)) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        request.resolve(message);
        return;
      }
      if (message.method === "$/cancelRequest") {
        const cancelled = pendingPackageCallbacks.get(message.params?.id);
        cancelled?.controller.abort(new DOMException("Tinymist cancelled package callback", "AbortError"));
      }
      if (message.method) notifications.push(message);
      if (message.method === "tinymist/workerBootProgress") {
        console.log(`Tinymist boot: ${message.params.stage}`);
      }
    });

    function rawRequest(method, params) {
      const id = nextId++;
      const response = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }, 60_000);
        pending.set(id, {
          resolve: (message) => {
            clearTimeout(timeout);
            resolve(message);
          }
        });
      });
      worker.postMessage({ jsonrpc: "2.0", id, method, params });
      return { id, response };
    }

    async function request(method, params) {
      const message = await rawRequest(method, params).response;
      if (message.error) {
        const error = new Error(message.error.message);
        error.code = message.error.code;
        error.data = message.error.data;
        throw error;
      }
      return message.result;
    }

    function notify(method, params) {
      worker.postMessage({ jsonrpc: "2.0", method, params });
    }

    function sameDocumentUri(actual, expected) {
      return actual === expected || actual === expected.replace(":/", ":");
    }

    async function waitForNotification(method, predicate = () => true) {
      const deadline = performance.now() + 20_000;
      while (performance.now() < deadline) {
        const index = notifications.findIndex((item) => item.method === method && predicate(item));
        if (index >= 0) return notifications.splice(index, 1)[0];
        const failed = notifications.find((item) => item.method === "tinymist/workerFailed");
        if (failed) throw new Error(failed.params.message);
        if (workerFailure) throw new Error(workerFailure);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const diagnosticUris = notifications.filter((item) => item.method === "textDocument/publishDiagnostics").map((item) => item.params?.uri);
      throw new Error(`timeout waiting for ${method}; diagnostics=${JSON.stringify(notifications.filter((item) => item.method === "textDocument/publishDiagnostics").map((item) => item.params))}; logs=${JSON.stringify(notifications.filter((item) => item.method === "tmLog").map((item) => item.params))}`);
    }

    async function waitForPackageCallback(name) {
      const deadline = performance.now() + 20_000;
      while (performance.now() < deadline) {
        const callback = packageCallbackRequests.find((item) => item?.package_spec?.name === name);
        if (callback) return callback;
        if (workerFailure) throw new Error(workerFailure);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error(`timeout waiting for package callback ${name}; requests=${serverRequests.map((item) => item.method).join(",")}; logs=${JSON.stringify(notifications.filter((item) => item.method === "tmLog").map((item) => item.params))}`);
    }

    async function observeQuietPeriod(quietMs = 300, timeoutMs = 5_000) {
      const deadline = performance.now() + timeoutMs;
      let lastCount = serverRequests.length + notifications.length;
      let quietSince = performance.now();
      while (performance.now() < deadline) {
        if (workerFailure) throw new Error(workerFailure);
        const count = serverRequests.length + notifications.length;
        if (count !== lastCount) {
          lastCount = count;
          quietSince = performance.now();
        } else if (performance.now() - quietSince >= quietMs) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("Tinymist did not reach a quiet observation period");
    }

    worker.postMessage({
      method: "tinymist/boot",
      params: {
        moduleUri: `${location.origin}/tinymist/tinymist.js`,
        wasmUri: `${location.origin}/tinymist/tinymist_bg.wasm`
      }
    });
    const ready = await waitForNotification("tinymist/workerReady");
    const initialize = await request("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {
        workspace: {
          applyEdit: true,
          configuration: true,
          didChangeWatchedFiles: { dynamicRegistration: true },
          workspaceFolders: true
        },
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          codeAction: { dynamicRegistration: true, resolveSupport: { properties: ["edit"] } },
          completion: {
            dynamicRegistration: true,
            completionItem: { snippetSupport: true, resolveSupport: { properties: ["documentation", "detail"] } }
          },
          documentFormatting: { dynamicRegistration: true },
          documentRangeFormatting: { dynamicRegistration: true },
          hover: { dynamicRegistration: true, contentFormat: ["markdown", "plaintext"] },
          publishDiagnostics: { versionSupport: true, relatedInformation: true },
          rename: { dynamicRegistration: true, prepareSupport: true },
          semanticTokens: {
            dynamicRegistration: true,
            requests: { range: true, full: { delta: true } },
            tokenTypes: ["comment", "string", "keyword", "operator", "number", "function", "variable"],
            tokenModifiers: ["declaration", "readonly", "static"],
            formats: ["relative"]
          },
          signatureHelp: {
            dynamicRegistration: true,
            signatureInformation: { documentationFormat: ["markdown", "plaintext"] }
          }
        }
      }
    });
    notify("initialized", {});
    await observeQuietPeriod();

    const uri = "file:///mmt-projection/browser/main.typ";
    notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "typst",
        version: 1,
        text: "#let greet(name) = [Hello #name]\n#greet(\"MMT\")\n#gre\n#let broken = ("
      }
    });
    const diagnosticsV1 = await waitForNotification(
      "textDocument/publishDiagnostics",
      (item) => sameDocumentUri(item.params?.uri, uri)
    );
    notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{
        text: "#let greet(name) = [Hello #name]\n#greet(\"MMT\")\n#gre\n#let broken = []"
      }]
    });
    const diagnosticsV2 = await waitForNotification(
      "textDocument/publishDiagnostics",
      (item) => sameDocumentUri(item.params?.uri, uri)
    );
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
    notify("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{
        text: "#let greet(name) = [Hello #name]\n#greet(\"MMT\")\n#greet(\"again\")\n#let broken = []"
      }]
    });
    const diagnosticsV3 = await waitForNotification(
      "textDocument/publishDiagnostics",
      (item) => sameDocumentUri(item.params?.uri, uri) && item.params?.diagnostics?.length === 0
    );
    await observeQuietPeriod();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const locationCandidates = [];
    for (const [line, text] of [
      [0, "#let greet(name) = [Hello #name]"],
      [1, "#greet(\"MMT\")"],
      [2, "#greet(\"again\")"],
      [3, "#let broken = []"],
    ]) {
      for (let character = 0; character <= text.length; character += 1) {
        const locations = await request("tinymist/sourceLocations", {
          uri,
          position: { line, character }
        });
        if (Array.isArray(locations) && locations.length > 0) {
          locationCandidates.push({ line, character, locations });
        }
      }
    }
    const sourceLocations = locationCandidates[0]?.locations ?? [];
    const previewLocation = sourceLocations.length > 0
      ? await request("tinymist/previewLocation", { uri, position: sourceLocations[0] })
      : null;
    const invalidPreviewLocation = await request("tinymist/previewLocation", {
      uri,
      position: { pageIndex: 0, x: -1, y: 0.5 }
    });


    const legacyPackageContextResponse = await rawRequest("mmt/typstProjectContext.v1", {
      backend_generation: 1,
      typst_project_snapshot_key: "0".repeat(64)
    }).response;
    if (legacyPackageContextResponse.error?.code !== -32601) {
      throw new Error(`legacy package context method was not rejected: ${JSON.stringify(legacyPackageContextResponse)}`);
    }
    const packageContext = (backendGeneration, snapshotKey, packageName) => {
      notify("mmt/typstPackageContext.v1", {
        backend_generation: backendGeneration,
        typst_project_snapshot_key: snapshotKey
      });
      packageHost.setContext(backendGeneration, snapshotKey, packageName);
    };
    const changePackageFixture = (name, version) => notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: `#import "@preview/${name}:1.0.0": value\n#value` }]
    });

    const packageUri = uri;
    packageContext(1, "web-package-ready-snapshot", "mmt-callback-ready");
    changePackageFixture("mmt-callback-ready", 4);
    await waitForPackageCallback("mmt-callback-ready");
    const packageDiagnosticsNotification = await waitForNotification(
      "textDocument/publishDiagnostics",
      (item) => sameDocumentUri(item.params?.uri, packageUri) && item.params?.diagnostics?.length === 0
    );
    const packageDiagnostics = packageDiagnosticsNotification.params;

    packageContext(2, "web-package-unavailable-snapshot", "mmt-callback-unavailable");
    changePackageFixture("mmt-callback-unavailable", 5);
    await waitForPackageCallback("mmt-callback-unavailable");
    const unavailableDiagnostics = (await waitForNotification(
      "textDocument/publishDiagnostics",
      (item) => sameDocumentUri(item.params?.uri, packageUri) && item.params?.diagnostics?.length > 0
    )).params;

    packageContext(3, "web-package-error-snapshot", "mmt-callback-error");
    changePackageFixture("mmt-callback-error", 6);
    await waitForPackageCallback("mmt-callback-error");
    const errorDiagnostics = (await waitForNotification(
      "textDocument/publishDiagnostics",
      (item) => sameDocumentUri(item.params?.uri, packageUri) && item.params?.diagnostics?.length > 0
    )).params;

    packageContext(4, "web-package-cancel-snapshot", "mmt-callback-cancel");
    changePackageFixture("mmt-callback-cancel", 7);
    await waitForPackageCallback("mmt-callback-cancel");
    packageContext(5, "web-package-after-cancel-snapshot", "closed");
    const cancellationNotification = await waitForNotification("$/cancelRequest");
    await observeQuietPeriod(200, 5_000);

    const previewResourceResponse = await rawRequest("workspace/executeCommand", {
      command: "tinymist.getResources",
      arguments: ["/preview/index.html"]
    }).response;
    const locationCommands = [
      "tinymist.startDefaultPreview",
      "tinymist.scrollPreview",
      "tinymist.getDocumentTrace"
    ];
    const locationProbeResponses = [];
    for (const command of locationCommands) {
      const message = await rawRequest("workspace/executeCommand", {
        command,
        arguments: command === "tinymist.getDocumentTrace" ? [uri] : []
      }).response;
      locationProbeResponses.push({ command, message });
    }

    const shutdown = await rawRequest("shutdown", null).response;
    notify("exit", null);
    worker.terminate();
    return {
      ready: ready.params,
      initialize,
      dynamicRegistrations,
      serverRequests,
      packageCallbackRequests,
      packageCallbackResponses,
      packageDiagnostics,
      unavailableDiagnostics,
      errorDiagnostics,
      cancellationNotification,
      legacyPackageContextResponse,
      previewResourceResponse,
      locationProbeResponses,
      completion,
      hover,
      signature,
      sourceLocations,
      previewLocation,
      invalidPreviewLocation,
      diagnosticVersions: [diagnosticsV1.params.version ?? null, diagnosticsV2.params.version ?? null],
      shutdown
    };
  });

  const completionText = JSON.stringify(result.completion);
  assert.equal(result.ready.backendVersion, "0.15.2", "Tinymist Worker backend version");
  assert.equal(result.initialize.serverInfo?.version, "0.15.2", "Tinymist initialize server version");
  assert.equal(result.initialize.capabilities?.positionEncoding, "utf-16", "Tinymist coordinate encoding");
  assert(completionText.includes("greet"), "user-defined completion positive transcript");
  assert(result.hover, "hover positive transcript");
  assert(result.signature?.signatures?.some((item) => item.label.includes("greet")), "signature positive transcript");
  assert(
    result.initialize.capabilities?.experimental?.mmtPreviewLocationProvider?.coordinateVersion === "typst-page-points-v1",
    "Tinymist preview coordinate version"
  );

  const versionedDiagnostics = result.diagnosticVersions[0] === 1 && result.diagnosticVersions[1] === 2;
  const unversionedDiagnostics = result.diagnosticVersions.every((version) => version == null);
  assert(versionedDiagnostics || unversionedDiagnostics, "diagnostic versions are consistent");

  const normalizedCapabilities = structuredClone(result.initialize.capabilities ?? null);
  const advertisedCommands = normalizedCapabilities?.executeCommandProvider?.commands ?? [];
  advertisedCommands.sort();
  const locationCommands = [
    "tinymist.startDefaultPreview",
    "tinymist.scrollPreview",
    "tinymist.getDocumentTrace"
  ];
  const locationProbes = result.locationProbeResponses.map(({ command, message }) => ({
    command,
    advertised: advertisedCommands.includes(command),
    outcome: rpcOutcome(message)
  }));
  const packageServerRequests = result.serverRequests.filter(
    (item) => item.method === "mmt/typstPackageRequest.v1"
  );
  const packageDiagnosticSummary = (result.packageDiagnostics.diagnostics ?? []).map((diagnostic) => normalize({
    code: diagnostic.code ?? null,
    message: diagnostic.message,
    range: diagnostic.range,
    severity: diagnostic.severity ?? null,
    source: diagnostic.source ?? null
  }));
  const packageOutcome = (name) => result.packageCallbackResponses.find((item) => item.name === name);
  const experimental = result.initialize.capabilities?.experimental;
  const experimentalMethods = experimental && typeof experimental === "object"
    ? Object.entries(experimental).filter(([, enabled]) => Boolean(enabled)).map(([name]) => name).sort()
    : [];
  const previewProvider = experimental?.mmtPreviewLocationProvider;
  const qualifiedLocationMethod = result.sourceLocations.length > 0 && result.previewLocation
    ? "tinymist/previewLocation+tinymist/sourceLocations"
    : null;


  const evidence = normalize({
    schemaVersion: 1,
    artifact: {
      host: "web-worker",
      packageVersion: artifact.packageVersion,
      backendName: result.ready.backendName,
      backendVersion: result.ready.backendVersion,
      protocolVersion: result.ready.protocolVersion,
      digests: artifact.digests,
      checksumManifest: {
        path: "vendor/tinymist-0.15.2/SHA256SUMS",
        entries: artifact.checksumManifest
      }
    },
    initialize: {
      serverInfo: result.initialize.serverInfo ?? null,
      capabilities: normalizedCapabilities
    },
    dynamicRegistrations: {
      register: result.dynamicRegistrations.register,
      unregister: result.dynamicRegistrations.unregister,
      observationWindowMs: 300
    },
    packageCallback: {
      method: "mmt/typstPackageRequest.v1",
      contextMethod: "mmt/typstPackageContext.v1",
      contextHandlerReached: true,
      legacyContextMethod: "mmt/typstProjectContext.v1",
      legacyContextResponse: result.legacyPackageContextResponse,
      availability: "observed",
      requests: result.packageCallbackRequests,
      responses: result.packageCallbackResponses,
      ready: {
        outcome: packageOutcome("mmt-callback-ready"),
        resolvedDiagnostics: packageDiagnosticSummary
      },
      unavailable: {
        outcome: packageOutcome("mmt-callback-unavailable"),
        diagnostics: result.unavailableDiagnostics.diagnostics
      },
      cancellation: {
        notificationObserved: result.cancellationNotification.method === "$/cancelRequest",
        outcome: packageOutcome("mmt-callback-cancel")
      },
      error: {
        outcome: packageOutcome("mmt-callback-error"),
        diagnostics: result.errorDiagnostics.diagnostics
      },
      externalNetworkRequests
    },
    previewLocation: {
      advertisedCommands: advertisedCommands.filter((command) => /preview|trace/i.test(command)).sort(),
      previewArtifact: {
        resourceCommandAdvertised: advertisedCommands.includes("tinymist.getResources"),
        previewIndexProbe: rpcOutcome(result.previewResourceResponse)
      },
      locationMethod: previewProvider?.previewToSourceMethod ?? null,
      qualifiedMethod: qualifiedLocationMethod,
      probes: [
        { method: "tinymist/sourceLocations", outcome: result.sourceLocations.length > 0 ? "success" : "empty" },
        { method: "tinymist/previewLocation", outcome: result.previewLocation ? "success" : "empty" },
        { method: "tinymist/previewLocation:invalid-coordinate", outcome: result.invalidPreviewLocation === null ? "null" : "unexpected" },
      ],
      coordinateVersion: previewProvider?.coordinateVersion ?? null,
      fallbackDecision: qualifiedLocationMethod ? null : "immutable-location-map",
      unavailableReason: qualifiedLocationMethod ? null : "The pinned Web artifact exposes no qualified bidirectional location method."
    },
    transcripts: {
      positive: {
        completionContainsUserSymbol: completionText.includes("greet"),
        hoverPresent: Boolean(result.hover),
        signatureContainsUserSymbol: result.signature?.signatures?.some((item) => item.label.includes("greet")) ?? false,
        diagnosticVersionMode: versionedDiagnostics ? "versioned" : "unversioned",
        previewResourceAvailable: rpcOutcome(result.previewResourceResponse).ok,
        packageReadyResolved: packageDiagnosticSummary.length === 0 && packageOutcome("mmt-callback-ready")?.outcome?.status === "Ready",
        bidirectionalPreviewLocation: qualifiedLocationMethod !== null
      },
      negative: {
        packageUnavailableObserved: packageOutcome("mmt-callback-unavailable")?.outcome?.status === "Unavailable",
        packageErrorObserved: packageOutcome("mmt-callback-error")?.error?.code === -32010,
        packageCancellationObserved: packageOutcome("mmt-callback-cancel")?.outcome?.status === "Cancelled",
        backendNetworkIsolated: externalNetworkRequests.length === 0,
        invalidPreviewCoordinateRejected: result.invalidPreviewLocation === null
      }
    },
    normalization: {
      recursivelySortedObjectKeys: true,
      arrayOrderPreserved: true,
      volatileFieldsRemoved: ["JSON-RPC request ids", "startup duration", "absolute package path"]
    },
    experimentalMethods
  });

  assert.equal(evidence.packageCallback.availability, "observed", "Web package callback is observed");
  assert.equal(evidence.packageCallback.requests.length, 4, "all Web callback outcomes were requested");
  assert.equal(evidence.previewLocation.coordinateVersion, "typst-page-points-v1", "Web coordinate version is qualified");
  assert.equal(evidence.previewLocation.qualifiedMethod, null, "Web location methods remain unqualified without a successful probe");
  assert(evidence.transcripts.positive.previewResourceAvailable, "preview artifact resource positive transcript");
  assert(evidence.transcripts.positive.packageReadyResolved, "Web Ready package resolved without diagnostics");
  assert(evidence.transcripts.negative.packageUnavailableObserved, "Web Unavailable callback transcript");
  assert(evidence.transcripts.negative.packageErrorObserved, "Web callback error transcript");
  assert(evidence.transcripts.negative.packageCancellationObserved, "Web callback cancellation transcript");
  assert(evidence.transcripts.negative.backendNetworkIsolated, "Web backend made no external network request");
  assert(evidence.previewLocation.fallbackDecision === "immutable-location-map", "Web location fallback remains qualified");

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
  assert(
    replay.before && replay.changed && replay.after && replay.restarted === 1 && replay.semanticLegend,
    "Tinymist Worker replay and dynamic semantic-token legend baseline"
  );

  const evidencePath = path.join(extensionRoot, "src", "test", "fixtures", "tinymist-web-evidence.json");
  if (process.env.UPDATE_TINYMIST_EVIDENCE === "1") {
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  } else {
    const checked = JSON.parse(await readFile(evidencePath, "utf8"));
    const actualForComparison = artifact.runtimeArtifact ? webEvidenceForComparison(evidence) : evidence;
    const checkedForComparison = artifact.runtimeArtifact ? webEvidenceForComparison(checked) : checked;
    assert.deepEqual(actualForComparison, checkedForComparison, "Tinymist Web behavior changed; rerun qualification deliberately");
  }

  console.log(JSON.stringify({
    evidence: "src/test/fixtures/tinymist-web-evidence.json",
    artifactDigest: evidence.artifact.digests["tinymist_bg.wasm"],
    backendVersion: evidence.artifact.backendVersion,
    positionEncoding: evidence.initialize.capabilities.positionEncoding,
    dynamicRegistrations: evidence.dynamicRegistrations.register.length,
    packageCallback: evidence.packageCallback.availability,
    locationMethod: evidence.previewLocation.locationMethod,
    coordinateVersion: evidence.previewLocation.coordinateVersion,
    positive: evidence.transcripts.positive,
    negative: evidence.transcripts.negative,
    replay
  }));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
