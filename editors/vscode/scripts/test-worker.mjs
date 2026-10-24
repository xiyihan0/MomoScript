import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extensionRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const composerPackSources = await Promise.all(["base", "extension"].map(async (name) => ({
  manifestUrl: `https://example.test/composer/${name}-manifest.json`,
  baseUrl: "https://example.test/composer/",
  json: await readFile(new URL(`../../../mmt_rs/tests/fixtures/pack-v3/${name}-manifest.json`, import.meta.url), "utf8")
})));
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

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on("console", (message) => console.error(`[browser:${message.type()}] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[pageerror] ${error.stack ?? error.message}`));
  page.on("requestfailed", (request) =>
    console.error(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ""}`)
  );
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const result = await page.evaluate(async ({ wasmUri, composerPackSources }) => {
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
    function positionAtUtf16(text, offset) {
      let line = 0;
      let lineStart = 0;
      for (let index = 0; index < offset; index += 1) {
        if (text.charCodeAt(index) === 10) {
          line += 1;
          lineStart = index + 1;
        }
      }
      return { line, character: offset - lineStart };
    }
    function hasExactKeys(value, keys) {
      return value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).length === keys.length
        && keys.every((key) => Object.hasOwn(value, key));
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

    const wasmResponse = await fetch(wasmUri);
    if (!wasmResponse.ok) throw new Error(`WASM fetch failed: HTTP ${wasmResponse.status}`);
    const wasmBytes = await wasmResponse.arrayBuffer();
    worker.postMessage({ method: "mmt/boot", params: { wasmBytes } }, [wasmBytes]);
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
            },
            "花子": {
              names: ["花子"],
              display_name: "浦和花子",
              slots: { avatar: { default: "default", items: {
                default: { storage: "avatars", path: "hanako.png" }
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
    const semanticUri = "file:///workspace/semantic-routing.mmt";
    const semanticText = [
      "@actor main",
      "preset: ba::柚子",
      "also-as: [alias]",
      "@end",
      "> alias: one",
      "> _0: history",
      "@asset: hero src:hero.png",
      "- [:asset, hero:]",
      "> main: hello # world"
    ].join("\n");
    notify("textDocument/didOpen", {
      textDocument: {
        uri: semanticUri,
        languageId: "mmt",
        version: 1,
        text: semanticText
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === semanticUri
    );
    const semanticPosition = (line, needle) => ({
      line,
      character: semanticText.split("\n")[line].indexOf(needle)
    });
    const aliasReferencePosition = semanticPosition(4, "alias");
    const aliasBindingPosition = semanticPosition(2, "alias");
    const historyPosition = semanticPosition(5, "_0");
    const assetReferencePosition = semanticPosition(7, "hero");
    const routeAt = (uri, position) => request("mmt/semanticRoute", {
      textDocument: { uri },
      position,
      version: 1,
      backendEncoding: "utf-16"
    });
    if (await routeAt(semanticUri, aliasReferencePosition) !== "native") {
      throw new Error("browser Worker did not route an actor reference to native semantics");
    }
    const projectedRouteUri = "file:///workspace/projected-semantic-routing.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri: projectedRouteUri,
        languageId: "mmt",
        version: 1,
        text: "@typ\n#let projected = 1\n@end"
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === projectedRouteUri
    );
    await waitForNotification(
      "mmt/typstProjectUpdated",
      (message) => message.params.sourceUri === projectedRouteUri
    );
    const projectedRoute = await routeAt(projectedRouteUri, { line: 1, character: 7 });
    if (projectedRoute !== "projected") {
      const projectedPosition = await request("mmt/typstPosition", {
        textDocument: { uri: projectedRouteUri },
        position: { line: 1, character: 7 },
        backendEncoding: "utf-16"
      });
      throw new Error(
        `browser Worker did not route an authored Typst token to projected semantics: `
        + `${JSON.stringify({ projectedRoute, projectedPosition })}`
      );
    }
    if (await routeAt(projectedRouteUri, { line: 0, character: 1 }) !== "none") {
      throw new Error("browser Worker routed a structural directive to a semantic provider");
    }
    const aliasDefinition = await request("textDocument/definition", {
      textDocument: { uri: semanticUri },
      position: aliasReferencePosition
    });
    if (aliasDefinition?.range?.start?.line !== aliasBindingPosition.line) {
      throw new Error(`browser Worker resolved the alias to the wrong definition: ${JSON.stringify(aliasDefinition)}`);
    }
    const aliasReferences = await request("textDocument/references", {
      textDocument: { uri: semanticUri },
      position: aliasReferencePosition,
      context: { includeDeclaration: true }
    });
    if (!Array.isArray(aliasReferences)
      || !aliasReferences.some((location) => location.range.start.line === 0)
      || !aliasReferences.some((location) => location.range.start.line === 4)
      || !aliasReferences.some((location) => location.range.start.line === 5)) {
      throw new Error(`browser Worker returned incomplete actor references: ${JSON.stringify(aliasReferences)}`);
    }
    const preparedAlias = await request("textDocument/prepareRename", {
      textDocument: { uri: semanticUri },
      position: aliasBindingPosition
    });
    if (preparedAlias?.placeholder !== "alias") {
      throw new Error(`browser Worker did not prepare the alias binding: ${JSON.stringify(preparedAlias)}`);
    }
    const aliasRename = await request("textDocument/rename", {
      textDocument: { uri: semanticUri },
      position: aliasBindingPosition,
      newName: "alias2"
    });
    const aliasDocumentChange = aliasRename?.documentChanges?.[0];
    const aliasEditLines = aliasDocumentChange?.edits?.map((edit) => edit.range.start.line) ?? [];
    if (aliasDocumentChange?.textDocument?.version !== 1
      || !aliasEditLines.includes(2)
      || !aliasEditLines.includes(4)
      || aliasEditLines.includes(0)
      || aliasEditLines.includes(5)) {
      throw new Error(`browser Worker returned an unsafe alias rename: ${JSON.stringify(aliasRename)}`);
    }
    const historyPrepare = await request("textDocument/prepareRename", {
      textDocument: { uri: semanticUri },
      position: historyPosition
    });
    if (historyPrepare !== null) throw new Error("browser Worker allowed history-marker rename");
    const assetDefinition = await request("textDocument/definition", {
      textDocument: { uri: semanticUri },
      position: assetReferencePosition
    });
    if (assetDefinition?.range?.start?.line !== 6) {
      throw new Error(`browser Worker resolved the script asset incorrectly: ${JSON.stringify(assetDefinition)}`);
    }
    const staleRoute = await request("mmt/semanticRoute", {
      textDocument: { uri: semanticUri },
      position: aliasReferencePosition,
      version: 0,
      backendEncoding: "utf-16"
    });
    if (staleRoute !== "none") throw new Error("browser Worker accepted a stale semantic route");
    const inlayHintUri = "file:///workspace/speaker-inlay-hints.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri: inlayHintUri,
        languageId: "mmt",
        version: 1,
        text: "> 柚子: first\n> 花子: second\n> _1: third\n> ~1: fourth\n> fifth"
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === inlayHintUri
    );
    const speakerInlayHints = await request("textDocument/inlayHint", {
      textDocument: { uri: inlayHintUri },
      range: {
        start: { line: 0, character: 0 },
        end: { line: 4, character: 7 }
      }
    });
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
    const requestedProjectNotification = waitForNotification(
      "mmt/typstProjectUpdated",
      (message) => message.params.sourceUri === packSensitiveUri && message.params.sourceVersion === 2
    );
    notify("textDocument/didChange", {
      textDocument: { uri: packSensitiveUri, version: 2 },
      contentChanges: [{ text: "> 柚子: updated" }]
    });
    const requestedProject = (await requestedProjectNotification).params;
    await requestedDiagnosticsNotification;
    if (requestedProject.entryUri === afterPackProject.params.entryUri) {
      throw new Error("standard didChange did not publish its new project");
    }
    notify("textDocument/didChange", {
      textDocument: { uri: packSensitiveUri, version: 2 },
      contentChanges: [{ text: "> 柚子: stale duplicate" }]
    });
    const afterDuplicate = await request("mmt/getTypstProject", { uri: packSensitiveUri });
    if (afterDuplicate.sourceVersion !== 2 || afterDuplicate.revision !== requestedProject.revision) {
      throw new Error("same-version didChange rebuilt the current snapshot");
    }
    let legacySyncError;
    try {
      await request("mmt/updateDocument", {
        uri: packSensitiveUri,
        version: 3,
        text: "> 柚子: legacy route must not exist"
      });
    } catch (error) {
      legacySyncError = error;
    }
    if (!legacySyncError || !/not found|method/i.test(legacySyncError.message)) {
      throw new Error("legacy mmt/updateDocument synchronization route is still available");
    }
    notify("textDocument/didChange", {
      textDocument: { uri: packSensitiveUri, version: 1 },
      contentChanges: [{ text: "> 柚子: stale older version" }]
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterOlder = await request("mmt/getTypstProject", { uri: packSensitiveUri });
    if (afterOlder.sourceVersion !== 2 || afterOlder.revision !== requestedProject.revision) {
      throw new Error("older didChange rebuilt or replaced the current snapshot");
    }
    if (notifications.some((message) =>
      message.method === "mmt/typstProjectUpdated"
      && message.params.sourceUri === packSensitiveUri
      && message.params.sourceVersion === 1
    )) {
      throw new Error("older didChange published a replacement project");
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
    const acceptedRenderProject = await waitForNotification(
      "mmt/typstRenderProjectUpdated",
      (message) => message.params.sourceUri === renderUri
    );
    if (acceptedRenderProject.params.projectDigest !== renderProject.projectDigest) {
      throw new Error("accepted render notification identity differs from its request response");
    }
    if (!hasExactKeys(renderProject.renderPreset, ["kind"]) || renderProject.renderPreset.kind !== "output"
      || JSON.stringify(acceptedRenderProject.params.renderPreset) !== JSON.stringify(renderProject.renderPreset)) {
      throw new Error("browser Worker omitted the default output render preset");
    }
    if (renderProject.resources.length !== 1) throw new Error("render project omitted actor avatar");
    if (renderProject.resources[0].fileName !== "yuzu.png") throw new Error("render resource path mismatch");
    if (renderProject.entryUri !== renderLanguageProject.params.entryUri) {
      throw new Error("render project did not reuse the language projection session entry URI");
    }
    const renderEntry = renderProject.files.find((file) => file.uri === renderProject.entryUri);
    if (!renderEntry?.text?.includes("mmt-resources/0.png")) throw new Error("render entry omitted materialized avatar path");
    const avatarWrapper = renderEntry.text.indexOf("#text(\"");
    if (avatarWrapper < 0) throw new Error("avatar Composer projection omitted rendered text wrapper");
    const avatarOffset = avatarWrapper + 1;
    const avatarPreviewParams = {
      sourceUri: renderUri,
      revision: renderProject.revision,
      sourceContent: renderProject.sourceContent,
      projectDigest: renderProject.projectDigest,
      projectionKey: renderProject.projectionKey,
      entryUri: renderProject.entryUri,
      backendEncoding: "utf-16",
      location: {
        uri: renderProject.entryUri,
        range: {
          start: positionAtUtf16(renderEntry.text, avatarOffset),
          end: positionAtUtf16(renderEntry.text, avatarOffset + 1)
        }
      }
    };
    const avatarTarget = await request("mmt/previewComposerTarget", avatarPreviewParams);
    const actorAvatar = avatarTarget.properties?.actorAvatar;
    if (
      avatarTarget.kind !== "Editable"
      || actorAvatar?.scope !== "fromStatement"
      || actorAvatar.actorPresetId !== "ba::柚子"
      || actorAvatar.current?.kind !== "packAvatar"
      || actorAvatar.current.entityId !== "ba::柚子"
      || actorAvatar.current.contributionNamespace !== "ba"
      || actorAvatar.current.variantId !== "default"
      || !hasExactKeys(avatarTarget.properties.statementText, [
        "current",
        "mode",
        "resolvedMode",
        "inheritedMode"
      ])
      || avatarTarget.properties.statementText.current !== "Hello"
      || avatarTarget.properties.statementText.mode !== "inherit"
      || avatarTarget.properties.statementText.resolvedMode !== "textMacro"
      || avatarTarget.properties.statementText.inheritedMode !== "textMacro"
      || Object.hasOwn(actorAvatar, "actorId")
      || Object.hasOwn(actorAvatar.current, "path")
      || Object.hasOwn(actorAvatar.current, "storage")
      || Object.hasOwn(actorAvatar.current, "url")
    ) {
      throw new Error(`browser Worker avatar target mismatch: ${JSON.stringify(avatarTarget)}`);
    }
    const avatarNotificationCount = notifications.length;
    const avatarEdit = await request("mmt/composerEdit", {
      textDocument: avatarTarget.textDocument,
      target: avatarTarget.target,
      command: {
        kind: "setActorAvatarFromStatement",
        avatar: {
          kind: "packAvatar",
          entityId: "ba::花子",
          contributionNamespace: "ba",
          variantId: "default"
        }
      }
    });
    if (
      avatarEdit.kind !== "Edit"
      || !avatarEdit.edit?.documentChanges?.[0]?.edits?.[0]?.newText?.includes(
        "avatar: ba::花子/ba::avatar/default"
      )
      || Object.hasOwn(avatarEdit.edit, "changes")
    ) {
      throw new Error(`browser Worker avatar edit mismatch: ${JSON.stringify(avatarEdit)}`);
    }
    if (notifications.length !== avatarNotificationCount) {
      throw new Error("browser Worker avatar edit emitted an apply or server event");
    }
    const messageEdit = await request("mmt/composerEdit", {
      textDocument: avatarTarget.textDocument,
      target: avatarTarget.target,
      command: {
        kind: "setStatementBody",
        value: "Worker 正文😀 \\\\path",
        mode: "inherit"
      }
    });
    if (
      messageEdit.kind !== "Edit"
      || Object.hasOwn(messageEdit.edit, "changes")
      || messageEdit.edit?.documentChanges?.length !== 1
      || messageEdit.edit.documentChanges[0].textDocument.version !== 1
      || messageEdit.edit.documentChanges[0].edits?.length !== 1
      || messageEdit.edit.documentChanges[0].edits[0].newText !== "Worker 正文😀 \\\\path"
    ) {
      throw new Error(`browser Worker message edit mismatch: ${JSON.stringify(messageEdit)}`);
    }
    if (notifications.length !== avatarNotificationCount) {
      throw new Error("browser Worker message edit emitted an apply or server event");
    }
    const messageModeEdit = await request("mmt/composerEdit", {
      textDocument: avatarTarget.textDocument,
      target: avatarTarget.target,
      command: {
        kind: "setStatementBody",
        value: "Worker #strong[正文]",
        mode: "typstRaw"
      }
    });
    if (
      messageModeEdit.kind !== "Edit"
      || Object.hasOwn(messageModeEdit.edit, "changes")
      || messageModeEdit.edit?.documentChanges?.length !== 1
      || messageModeEdit.edit.documentChanges[0].edits?.length !== 1
      || messageModeEdit.edit.documentChanges[0].edits[0].newText !== "rT\"\"\"\nWorker #strong[正文]\"\"\""
    ) {
      throw new Error(`browser Worker message-mode edit mismatch: ${JSON.stringify(messageModeEdit)}`);
    }
    let malformedModeError;
    try {
      await request("mmt/composerEdit", {
        textDocument: avatarTarget.textDocument,
        target: avatarTarget.target,
        command: {
          kind: "setStatementBody",
          value: "Hello",
          mode: "unknown"
        }
      });
    } catch (error) {
      malformedModeError = error;
    }
    if (!malformedModeError || !/unknown variant|decode|invalid params|did not match/i.test(malformedModeError.message)) {
      throw new Error(`browser Worker accepted an unsupported statement-text mode: ${malformedModeError?.message ?? "no error"}`);
    }
    let malformedMessageError;
    try {
      await request("mmt/composerEdit", {
        textDocument: avatarTarget.textDocument,
        target: avatarTarget.target,
        command: {
          kind: "setStatementBody",
          value: "unsafe",
          mode: "inherit",
          rawSource: "> yuzu: unsafe"
        }
      });
    } catch (error) {
      malformedMessageError = error;
    }
    if (!malformedMessageError || !/unknown field|decode|invalid params|did not match/i.test(malformedMessageError.message)) {
      throw new Error(`browser Worker accepted unknown statement-text command fields: ${malformedMessageError?.message ?? "no error"}`);
    }
    const unchangedMessageTarget = await request("mmt/previewComposerTarget", avatarPreviewParams);
    if (unchangedMessageTarget.properties?.statementText?.current !== "Hello") {
      throw new Error("browser Worker message edit mutated the WASM document snapshot");
    }
    const missingAvatar = await request("mmt/composerEdit", {
      textDocument: avatarTarget.textDocument,
      target: avatarTarget.target,
      command: {
        kind: "setActorAvatarFromStatement",
        avatar: {
          kind: "packAvatar",
          entityId: "ba::花子",
          contributionNamespace: "ba",
          variantId: "missing"
        }
      }
    });
    if (missingAvatar.kind !== "Rejected" || missingAvatar.reason !== "avatarUnavailable") {
      throw new Error(`browser Worker unavailable avatar mismatch: ${JSON.stringify(missingAvatar)}`);
    }
    const composerUri = "file:///workspace/composer-worker.mmt";
    const composerSource = "< _0: hello";
    const composerLanguageProjectPromise = waitForNotification(
      "mmt/typstProjectUpdated",
      (message) => message.params.sourceUri === composerUri
    );
    notify("textDocument/didOpen", {
      textDocument: {
        uri: composerUri,
        languageId: "mmt",
        version: 7,
        text: composerSource
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === composerUri
    );
    await composerLanguageProjectPromise;
    const composerProject = await request("mmt/getTypstRenderProject", { uri: composerUri });
    await waitForNotification(
      "mmt/typstRenderProjectUpdated",
      (message) => message.params.sourceUri === composerUri
    );
    const composerEntry = composerProject.files.find((file) => file.uri === composerProject.entryUri);
    const composerWrapper = composerEntry?.text?.indexOf("#text(\"") ?? -1;
    if (composerWrapper < 0) throw new Error("composer projection omitted rendered text wrapper");
    const composerGeneratedOffset = composerWrapper + 1;
    const composerPreviewParams = {
      sourceUri: composerUri,
      revision: composerProject.revision,
      sourceContent: composerProject.sourceContent,
      projectDigest: composerProject.projectDigest,
      projectionKey: composerProject.projectionKey,
      entryUri: composerProject.entryUri,
      backendEncoding: "utf-16",
      location: {
        uri: composerProject.entryUri,
        range: {
          start: positionAtUtf16(composerEntry.text, composerGeneratedOffset),
          end: positionAtUtf16(composerEntry.text, composerGeneratedOffset + 1)
        }
      }
    };
    const composerTarget = await request("mmt/previewComposerTarget", composerPreviewParams);
    if (
      composerTarget.kind !== "Editable"
      || !hasExactKeys(composerTarget, ["kind", "textDocument", "target", "properties"])
      || !hasExactKeys(composerTarget.textDocument, ["uri", "version"])
      || !hasExactKeys(composerTarget.target, ["kind", "range"])
      || !hasExactKeys(composerTarget.properties, ["continued", "statementText"])
      || composerTarget.textDocument.uri !== composerUri
      || composerTarget.textDocument.version !== 7
      || composerTarget.target.kind !== "statement"
      || composerTarget.target.range.start.line !== 0
      || composerTarget.target.range.start.character !== 0
      || composerTarget.target.range.end.character !== composerSource.length
      || composerTarget.properties.continued !== "auto"
      || !hasExactKeys(composerTarget.properties.statementText, [
        "current",
        "mode",
        "resolvedMode",
        "inheritedMode"
      ])
      || composerTarget.properties.statementText.current !== "hello"
      || composerTarget.properties.statementText.mode !== "inherit"
      || composerTarget.properties.statementText.resolvedMode !== "textMacro"
      || composerTarget.properties.statementText.inheritedMode !== "textMacro"
      || Object.hasOwn(composerTarget.properties, "actorDisplayName")
      || Object.hasOwn(composerTarget.properties, "actorAvatar")
    ) {
      throw new Error(`browser Worker preview Composer target mismatch: ${JSON.stringify(composerTarget)}`);
    }
    const composerDocument = await request("mmt/composerDocument", {
      textDocument: composerTarget.textDocument
    });
    if (
      composerDocument.kind !== "Snapshot"
      || !hasExactKeys(composerDocument, [
        "kind",
        "textDocument",
        "sourceDigest",
        "nodes",
        "boundaries",
        "scriptActorChoices",
        "assetChoices"
      ])
      || composerDocument.sourceDigest !== "bce2aba48a26a2a0563a796525448e08544fde34437b58b077b2f890f60ecc9a"
      || composerDocument.textDocument.uri !== composerUri
      || composerDocument.textDocument.version !== 7
      || composerDocument.nodes.length !== 1
      || composerDocument.nodes[0].kind !== "message"
      || composerDocument.nodes[0].range.start.character !== 0
      || composerDocument.nodes[0].range.end.character !== composerSource.length
      || composerDocument.nodes[0].body.current !== "hello"
      || !hasExactKeys(composerDocument.nodes[0].textEditing, ["text"])
      || composerDocument.nodes[0].textEditing.text !== "hello"
      || composerDocument.nodes[0].capabilities.setSpeaker !== false
      || JSON.stringify(composerDocument.nodes[0].capabilities.setSide) !== '["right"]'
      || !Array.isArray(composerDocument.nodes[0].capabilities.moveTargets)
      || composerDocument.nodes[0].capabilities.moveTargets.length !== 0
      || composerDocument.assetChoices.length !== 0
      || composerDocument.boundaries.length !== 2
    ) {
      throw new Error(
        `browser Worker Composer document mismatch: ${JSON.stringify(composerDocument)}`
      );
    }
    const staleComposerDocument = await request("mmt/composerDocument", {
      textDocument: { ...composerTarget.textDocument, version: 6 }
    });
    if (
      staleComposerDocument.kind !== "Rejected"
      || staleComposerDocument.reason !== "staleDocument"
      || !hasExactKeys(staleComposerDocument, ["kind", "reason"])
    ) {
      throw new Error(
        `browser Worker stale Composer document mismatch: ${JSON.stringify(staleComposerDocument)}`
      );
    }
    const structureUri = "file:///workspace/structure-worker.mmt";
    const structureProjectPromise = waitForNotification(
      "mmt/typstProjectUpdated",
      (message) => message.params.sourceUri === structureUri
    );
    notify("textDocument/didOpen", {
      textDocument: {
        uri: structureUri,
        languageId: "mmt",
        version: 1,
        text: "- A\n- B"
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === structureUri
    );
    await structureProjectPromise;
    const structureDocument = await request("mmt/composerDocument", {
      textDocument: { uri: structureUri, version: 1 }
    });
    const structureNode = structureDocument.nodes?.[0];
    const structureEdit = await request("mmt/composerEdit", {
      textDocument: structureDocument.textDocument,
      sourceDigest: structureDocument.sourceDigest,
      target: {
        kind: "node",
        node: {
          nodeKey: structureNode.nodeKey,
          nodeKind: structureNode.kind,
          range: structureNode.range
        }
      },
      command: {
        kind: "moveNode",
        anchor: structureNode.capabilities.moveDown
      }
    });
    if (
      structureDocument.kind !== "Snapshot"
      || structureEdit.kind !== "Edit"
      || structureEdit.edit?.documentChanges?.length !== 1
      || structureEdit.edit.documentChanges[0].edits?.length !== 1
      || structureEdit.edit.documentChanges[0].edits[0].newText !== "- B\n- A"
    ) {
      throw new Error(
        `browser Worker structural Composer mismatch: ${JSON.stringify({ structureDocument, structureEdit })}`
      );
    }
    const eofBoundary = structureDocument.boundaries.at(-1);
    if (!eofBoundary?.insert) throw new Error("Complete EOF without final EOL must allow insertion");
    const eofEdit = await request("mmt/composerEdit", {
      textDocument: structureDocument.textDocument,
      sourceDigest: structureDocument.sourceDigest,
      target: eofBoundary.target,
      command: {
        kind: "insertStatement",
        statement: { kind: "narration", body: { value: "EOF append", mode: "inherit" } },
      },
    });
    const eofSourceEdit = eofEdit.edit?.documentChanges?.[0]?.edits?.[0];
    if (eofEdit.kind !== "Edit"
      || eofSourceEdit?.newText !== "\n- EOF append\n"
      || eofSourceEdit.range.start.line !== 1
      || eofSourceEdit.range.start.character !== 3
      || eofSourceEdit.range.end.line !== 1
      || eofSourceEdit.range.end.character !== 3) {
      throw new Error(`Worker EOF insertion changed existing bytes: ${JSON.stringify(eofEdit)}`);
    }
    for (const body of ["", "first\n> literal\n\"\"\" C:\\path\""]) {
      const bodyEdit = await request("mmt/composerEdit", {
        textDocument: structureDocument.textDocument,
        target: { kind: "statement", range: structureNode.statementRange },
        command: { kind: "setStatementBody", value: body, mode: "textRaw" },
      });
      const insertEdit = await request("mmt/composerEdit", {
        textDocument: structureDocument.textDocument,
        sourceDigest: structureDocument.sourceDigest,
        target: structureDocument.boundaries[0].target,
        command: {
          kind: "insertStatement",
          statement: {
            kind: "message", side: "right", speaker: { kind: "builtin" },
            body: { value: body, mode: "textRaw" }, continued: "auto",
            avatar: null,
          },
        },
      });
      if (bodyEdit.kind !== "Edit" || insertEdit.kind !== "Edit"
        || bodyEdit.edit.documentChanges[0].edits[0].newText.length === 0
        || !insertEdit.edit.documentChanges[0].edits[0].newText.startsWith("< _0: rt")) {
        throw new Error(`Worker whole-body/insertion mismatch: ${JSON.stringify({ bodyEdit, insertEdit })}`);
      }
    }
    if (structureNode.capabilities.replaceSource !== true
      || JSON.stringify(structureDocument.boundaries[0].insert.builtinMessageSides) !== '["right"]'
      || !Array.isArray(structureNode.capabilities.moveTargets)
      || !structureNode.capabilities.moveTargets.some((target) =>
        JSON.stringify(target) === JSON.stringify(structureNode.capabilities.moveDown))) {
      throw new Error("Worker is missing declared SourceLens or Teacher insertion capabilities");
    }
    const lensUri = "file:///workspace/source-lens-worker.mmt";
    const lensSource = "- before😀\r\n\r\n@typ\r\n#strong[old]\r\n@end\r\n- after\r\n";
    const lensProject = waitForNotification("mmt/typstProjectUpdated", (message) => message.params.sourceUri === lensUri);
    notify("textDocument/didOpen", { textDocument: {
      uri: lensUri, languageId: "mmt", version: 7, text: lensSource,
    } });
    await waitForNotification("textDocument/publishDiagnostics", (message) => message.params.uri === lensUri);
    await lensProject;
    const lensDocument = await request("mmt/composerDocument", { textDocument: { uri: lensUri, version: 7 } });
    const lensNode = lensDocument.nodes[2];
    const lensParams = {
      textDocument: lensDocument.textDocument,
      sourceDigest: lensDocument.sourceDigest,
      target: { kind: "node", node: { nodeKey: lensNode.nodeKey, nodeKind: lensNode.kind, range: lensNode.range } },
      command: { kind: "replaceNodeSource", source: "@typ\r\n#strong[new😀]\r\n@end\r\n" },
    };
    const lensEdit = await request("mmt/composerEdit", lensParams);
    if (lensNode.capabilities.replaceSource !== true
      || lensDocument.nodes[1].capabilities.replaceSource !== false
      || lensEdit.kind !== "Edit"
      || lensEdit.edit.documentChanges[0].textDocument.version !== 7
      || lensEdit.edit.documentChanges[0].edits[0].newText !== lensParams.command.source) {
      throw new Error(`Worker SourceLens edit mismatch: ${JSON.stringify(lensEdit)}`);
    }
    for (const command of [
      { kind: "replaceNodeSource", source: "@typ\r\n#strong[swallowed]" },
      { kind: "replaceNodeSource", source: "@typ\r\n#strong[ok]\r\n@end\r\n- injected\r\n" },
    ]) {
      const rejected = await request("mmt/composerEdit", { ...lensParams, command });
      if (rejected.kind !== "Rejected" || rejected.reason !== "candidateInvalid") {
        throw new Error(`Worker SourceLens crossed its source partition: ${JSON.stringify(rejected)}`);
      }
    }
    const staleLens = await request("mmt/composerEdit", { ...lensParams, sourceDigest: "0".repeat(64) });
    if (staleLens.kind !== "Rejected" || staleLens.reason !== "staleDocument") {
      throw new Error(`Worker SourceLens accepted stale identity: ${JSON.stringify(staleLens)}`);
    }
    const unchangedLens = await request("mmt/composerDocument", { textDocument: lensDocument.textDocument });
    if (unchangedLens.sourceDigest !== lensDocument.sourceDigest) throw new Error("SourceLens request mutated the Worker snapshot");
    const collapsed = (position) => ({ start: position, end: position });
    const sameRange = (actual, expected) =>
      hasExactKeys(actual, ["start", "end"])
      && hasExactKeys(actual.start, ["line", "character"])
      && hasExactKeys(actual.end, ["line", "character"])
      && actual.start.line === expected.start.line
      && actual.start.character === expected.start.character
      && actual.end.line === expected.end.line
      && actual.end.character === expected.end.character;
    const composerSelection = await request("mmt/composerTextSelection", {
      textDocument: composerDocument.textDocument,
      sourceDigest: composerDocument.sourceDigest,
      anchor: collapsed({ line: 0, character: 7 }),
      focus: collapsed({ line: 0, character: 10 })
    });
    if (
      !hasExactKeys(composerSelection, ["kind", "textDocument", "sourceDigest", "selection", "text"])
      || composerSelection.kind !== "Selection"
      || composerSelection.sourceDigest !== composerDocument.sourceDigest
      || composerSelection.textDocument.uri !== composerUri
      || composerSelection.textDocument.version !== 7
      || composerSelection.text !== "ell"
      || !hasExactKeys(composerSelection.selection, ["anchor", "focus"])
      || !hasExactKeys(composerSelection.selection.anchor, ["node", "offsetUtf16"])
      || !hasExactKeys(composerSelection.selection.anchor.node, ["nodeKey", "nodeKind", "range"])
      || composerSelection.selection.anchor.node.nodeKey !== composerDocument.nodes[0].nodeKey
      || composerSelection.selection.anchor.offsetUtf16 !== 1
      || composerSelection.selection.focus.offsetUtf16 !== 4
    ) {
      throw new Error(`browser Worker text selection mismatch: ${JSON.stringify(composerSelection)}`);
    }
    const { location: _composerLocation, ...composerProjectionIdentity } = composerPreviewParams;
    const composerTextProjection = await request("mmt/composerTextProjection", {
      ...composerProjectionIdentity,
      selection: composerSelection.selection
    });
    const expectedTextAnchor = positionAtUtf16(composerEntry.text, composerWrapper + "#text(\"".length + 1);
    const expectedTextFocus = positionAtUtf16(composerEntry.text, composerWrapper + "#text(\"".length + 4);
    if (
      composerTextProjection.kind !== "Mapped"
      || !hasExactKeys(composerTextProjection, ["kind", "anchor", "focus", "segments"])
      || !hasExactKeys(composerTextProjection.anchor, ["uri", "range"])
      || !hasExactKeys(composerTextProjection.focus, ["uri", "range"])
      || composerTextProjection.anchor.uri !== composerProject.entryUri
      || composerTextProjection.focus.uri !== composerProject.entryUri
      || !sameRange(composerTextProjection.anchor.range, collapsed(expectedTextAnchor))
      || !sameRange(composerTextProjection.focus.range, collapsed(expectedTextFocus))
      || !Array.isArray(composerTextProjection.segments)
      || composerTextProjection.segments.some((segment) =>
        !hasExactKeys(segment, ["uri", "range"]) || segment.uri !== composerProject.entryUri)
    ) {
      throw new Error(`browser Worker text projection mismatch: ${JSON.stringify(composerTextProjection)}`);
    }
    const generatedOffsetAt = (position) => composerEntry.text.split("\n").slice(0, position.line)
      .reduce((offset, line) => offset + line.length + 1, position.character);
    const projectedText = composerTextProjection.segments.map(({ range }) =>
      composerEntry.text.slice(generatedOffsetAt(range.start), generatedOffsetAt(range.end))).join("");
    if (projectedText !== "ell") {
      throw new Error(`browser Worker text projection included non-body source: ${JSON.stringify(projectedText)}`);
    }

    const textUri = "file:///workspace/text-selection-worker.mmt";
    const textSource = "- A😀é中\n\n- 第二条\n";
    const textProjectPromise = waitForNotification("mmt/typstProjectUpdated", (message) => message.params.sourceUri === textUri);
    notify("textDocument/didOpen", {
      textDocument: { uri: textUri, languageId: "mmt", version: 1, text: textSource }
    });
    await textProjectPromise;
    const textSnapshot = await request("mmt/composerDocument", { textDocument: { uri: textUri, version: 1 } });
    const textReadParams = {
      textDocument: textSnapshot.textDocument,
      sourceDigest: textSnapshot.sourceDigest,
      anchor: collapsed({ line: 0, character: 5 }),
      focus: collapsed({ line: 2, character: 4 })
    };
    const textRead = await request("mmt/composerTextSelection", textReadParams);
    const reverseRead = await request("mmt/composerTextSelection", {
      ...textReadParams, anchor: textReadParams.focus, focus: textReadParams.anchor
    });
    if (textRead.kind !== "Selection" || textRead.text !== "é中\n第二"
      || reverseRead.text !== textRead.text
      || reverseRead.selection.anchor.node.nodeKey !== textRead.selection.focus.node.nodeKey) {
      throw new Error(`browser Worker cross-node copy mismatch: ${JSON.stringify({ textRead, reverseRead })}`);
    }
    const textEditParams = {
      textDocument: textSnapshot.textDocument,
      sourceDigest: textSnapshot.sourceDigest,
      target: { kind: "textSelection", selection: textRead.selection },
      command: { kind: "replaceTextSelection", replacement: "X" }
    };
    const invalidBoundary = await request("mmt/composerEdit", {
      ...textEditParams,
      target: {
        kind: "textSelection",
        selection: {
          ...textRead.selection,
          anchor: { ...textRead.selection.anchor, offsetUtf16: 2 }
        }
      }
    });
    if (invalidBoundary.kind !== "Rejected" || invalidBoundary.reason !== "invalidValue") {
      throw new Error(`browser Worker split-surrogate text edit was not rejected: ${JSON.stringify(invalidBoundary)}`);
    }
    const staleTextRead = await request("mmt/composerTextSelection", { ...textReadParams, sourceDigest: "f".repeat(64) });
    if (staleTextRead.kind !== "Rejected" || staleTextRead.reason !== "staleDocument") {
      throw new Error(`browser Worker stale text digest was not rejected: ${JSON.stringify(staleTextRead)}`);
    }
    for (const [method, params] of [
      ["mmt/composerTextSelection", { ...textReadParams, unknown: true }],
      ["mmt/composerTextProjection", { ...composerProjectionIdentity, selection: composerSelection.selection, location: composerPreviewParams.location }],
      ["mmt/composerEdit", { ...textEditParams, command: { ...textEditParams.command, unknown: true } }]
    ]) {
      let invalidParamsRejected = false;
      try {
        await request(method, params);
      } catch {
        invalidParamsRejected = true;
      }
      if (!invalidParamsRejected) throw new Error(`browser Worker ${method} accepted unknown text fields`);
    }
    const textEdit = await request("mmt/composerEdit", textEditParams);
    if (
      textEdit.kind !== "TextEdit"
      || !hasExactKeys(textEdit, ["kind", "edit", "sourceDigestAfter", "selectionAfter"])
      || !hasExactKeys(textEdit.edit, ["documentChanges"])
      || textEdit.edit.documentChanges.length !== 1
      || !hasExactKeys(textEdit.edit.documentChanges[0], ["textDocument", "edits"])
      || textEdit.edit.documentChanges[0].textDocument.uri !== textUri
      || textEdit.edit.documentChanges[0].textDocument.version !== 1
      || !hasExactKeys(textEdit.selectionAfter, ["anchor", "focus"])
      || !hasExactKeys(textEdit.selectionAfter.anchor, ["statementRange", "offsetUtf16"])
      || !hasExactKeys(textEdit.selectionAfter.focus, ["statementRange", "offsetUtf16"])
      || textEdit.selectionAfter.anchor.offsetUtf16 !== textEdit.selectionAfter.focus.offsetUtf16
      || !sameRange(textEdit.selectionAfter.anchor.statementRange, textEdit.selectionAfter.focus.statementRange)
      || textEdit.selectionAfter.focus.offsetUtf16 !== 4
    ) {
      throw new Error(`browser Worker TextEdit result mismatch: ${JSON.stringify(textEdit)}`);
    }
    const textOffsetAt = (position) => textSource.split("\n").slice(0, position.line)
      .reduce((offset, line) => offset + line.length + 1, position.character);
    let editedText = textSource;
    const textChanges = textEdit.edit.documentChanges[0].edits.map((edit) => ({
      ...edit, start: textOffsetAt(edit.range.start), end: textOffsetAt(edit.range.end)
    })).sort((left, right) => right.start - left.start);
    for (const edit of textChanges) editedText = editedText.slice(0, edit.start) + edit.newText + editedText.slice(edit.end);
    if (editedText !== "- A😀X条\n\n") {
      throw new Error(`browser Worker cross-node text edit lost blank bytes or envelope: ${JSON.stringify(editedText)}`);
    }
    const unchangedText = await request("mmt/composerDocument", { textDocument: textSnapshot.textDocument });
    if (unchangedText.sourceDigest !== textSnapshot.sourceDigest) throw new Error("TextEdit request mutated the Worker document");
    const changedTextProject = waitForNotification("mmt/typstProjectUpdated", (message) =>
      message.params.sourceUri === textUri && message.params.sourceVersion === 2);
    notify("textDocument/didChange", {
      textDocument: { uri: textUri, version: 2 }, contentChanges: [{ text: editedText }]
    });
    await changedTextProject;
    const afterTextSnapshot = await request("mmt/composerDocument", { textDocument: { uri: textUri, version: 2 } });
    const afterTextNodes = afterTextSnapshot.nodes.filter((node) => node.kind !== "opaque");
    if (afterTextSnapshot.sourceDigest !== textEdit.sourceDigestAfter
      || afterTextNodes.length !== 1
      || afterTextNodes[0].textEditing.text !== "A😀X条"
      || !sameRange(afterTextNodes[0].statementRange, textEdit.selectionAfter.focus.statementRange)) {
      throw new Error(`browser Worker post-edit authorization mismatch: ${JSON.stringify(afterTextSnapshot)}`);
    }
    const unavailableComposerTarget = await request("mmt/previewComposerTarget", {
      ...composerPreviewParams,
      revision: composerPreviewParams.revision + 1
    });
    if (
      unavailableComposerTarget.kind !== "Unavailable"
      || !hasExactKeys(unavailableComposerTarget, ["kind", "reason"])
      || unavailableComposerTarget.reason !== "stalePreview"
    ) {
      throw new Error(
        `browser Worker preview Composer unavailable result mismatch: ${JSON.stringify(unavailableComposerTarget)}`
      );
    }
    const composerNotificationCount = notifications.length;
    const composerEdit = await request("mmt/composerEdit", {
      textDocument: composerTarget.textDocument,
      target: composerTarget.target,
      command: { kind: "setStatementContinued", value: "true" }
    });
    const composerDocumentChanges = composerEdit.edit?.documentChanges;
    if (
      composerEdit.kind !== "Edit"
      || !hasExactKeys(composerEdit, ["kind", "edit"])
      || !hasExactKeys(composerEdit.edit, ["documentChanges"])
      || Object.hasOwn(composerEdit.edit, "changes")
      || !Array.isArray(composerDocumentChanges)
      || composerDocumentChanges.length !== 1
      || !hasExactKeys(composerDocumentChanges[0], ["textDocument", "edits"])
      || !hasExactKeys(composerDocumentChanges[0].textDocument, ["uri", "version"])
      || !Array.isArray(composerDocumentChanges[0].edits)
      || composerDocumentChanges[0].textDocument.uri !== composerUri
      || composerDocumentChanges[0].textDocument.version !== 7
      || composerDocumentChanges[0].edits.length !== 1
      || !hasExactKeys(composerDocumentChanges[0].edits[0], ["range", "newText"])
      || !composerDocumentChanges[0].edits[0].newText.includes("continued: true")
    ) {
      throw new Error(`browser Worker Composer edit result mismatch: ${JSON.stringify(composerEdit)}`);
    }
    if (notifications.length !== composerNotificationCount) {
      throw new Error("browser Worker Composer edit emitted an apply or server event");
    }
    const unchangedComposerTarget = await request("mmt/previewComposerTarget", composerPreviewParams);
    if (
      unchangedComposerTarget.kind !== "Editable"
      || unchangedComposerTarget.properties.continued !== "auto"
      || unchangedComposerTarget.textDocument.version !== 7
    ) {
      throw new Error("browser Worker Composer edit mutated the WASM document snapshot");
    }
    const rejectedComposerEdit = await request("mmt/composerEdit", {
      textDocument: { ...composerTarget.textDocument, version: 6 },
      target: composerTarget.target,
      command: { kind: "setStatementContinued", value: "false" }
    });
    if (
      rejectedComposerEdit.kind !== "Rejected"
      || !hasExactKeys(rejectedComposerEdit, ["kind", "reason"])
      || rejectedComposerEdit.reason !== "staleDocument"
    ) {
      throw new Error(
        `browser Worker Composer rejected result mismatch: ${JSON.stringify(rejectedComposerEdit)}`
      );
    }
    const renderDiagnosticsUri = "file:///workspace/render-diagnostics.mmt";
    const renderDiagnosticsNotification = waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === renderDiagnosticsUri
    );
    const renderDiagnosticsProjectNotification = waitForNotification(
      "mmt/typstProjectUpdated",
      (message) => message.params.sourceUri === renderDiagnosticsUri
    );
    notify("textDocument/didOpen", {
      textDocument: {
        uri: renderDiagnosticsUri,
        languageId: "mmt",
        version: 4,
        text: "@asset hero\nsrc: first.png\n@end\n@asset hero\nsrc: second.png\n@end\n> 柚子: [:missing:]"
      }
    });
    const liveRenderDiagnostics = await renderDiagnosticsNotification;
    const liveRenderProject = await renderDiagnosticsProjectNotification;
    const renderDiagnosticsProject = await request("mmt/getTypstRenderProject", { uri: renderDiagnosticsUri });
    if (renderDiagnosticsProject.sourceVersion !== 4 || renderDiagnosticsProject.revision !== liveRenderProject.params.revision) {
      throw new Error("render diagnostics lost source version or projection revision binding");
    }
    const renderPhases = new Set(renderDiagnosticsProject.diagnostics.map((diagnostic) => diagnostic.phase));
    for (const phase of ["semantic", "resolve"]) {
      if (!renderPhases.has(phase)) throw new Error(`render project omitted ${phase} planning diagnostics`);
    }
    const renderDiagnosticIds = renderDiagnosticsProject.diagnostics.map((diagnostic) =>
      JSON.stringify([diagnostic.phase, diagnostic.message, diagnostic.range, diagnostic.labels])
    );
    for (const diagnostic of renderDiagnosticsProject.diagnostics) {
      if (!liveRenderDiagnostics.params.diagnostics.some((live) =>
        live.message === diagnostic.message && live.data?.phase === diagnostic.phase
      )) {
        throw new Error(`live diagnostics lost render planning diagnostic: ${diagnostic.message}`);
      }
    }
    if (new Set(renderDiagnosticIds).size !== renderDiagnosticIds.length) {
      throw new Error("render project diagnostics contain duplicate identities");
    }
    if (notifications.some((message) =>
      message.method === "textDocument/publishDiagnostics" && message.params.uri === renderDiagnosticsUri
    )) {
      throw new Error("render project request published a second live diagnostic set");
    }
    if (liveRenderDiagnostics.params.diagnostics.length === 0) {
      throw new Error("live render-diagnostics fixture did not produce planning diagnostics");
    }
    const documentConfigUri = "file:///workspace/document-config.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri: documentConfigUri,
        languageId: "mmt",
        version: 1,
        text: "@document\ntitle: Worker document\ncompiled-at: auto\ntimezone: +08:00\n@end\n- hello"
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === documentConfigUri
    );
    const documentConfig = await request("mmt/getDocumentConfig", { uri: documentConfigUri });
    if (documentConfig.title !== "Worker document" || documentConfig.compiledAt.mode !== "auto") {
      throw new Error("browser Worker document config response mismatch");
    }
    if (!documentConfig.range || documentConfig.range.start.line !== 0) {
      throw new Error("browser Worker document config range is missing");
    }
    const documentDirectiveHover = await request("textDocument/hover", {
      textDocument: { uri: documentConfigUri },
      position: { line: 0, character: 4 }
    });
    if (!documentDirectiveHover?.contents?.value?.includes("Configure document title")) {
      throw new Error("browser Worker omitted @document hover");
    }
    if (
      documentDirectiveHover.range?.start?.line !== 0 ||
      documentDirectiveHover.range?.start?.character !== 0 ||
      documentDirectiveHover.range?.end?.line !== 0 ||
      documentDirectiveHover.range?.end?.character !== 9
    ) {
      throw new Error(
        `browser Worker returned an invalid @document hover range: ${JSON.stringify(documentDirectiveHover.range)}`
      );
    }
    const documentFieldHover = await request("textDocument/hover", {
      textDocument: { uri: documentConfigUri },
      position: { line: 1, character: 2 }
    });
    if (!documentFieldHover?.contents?.value?.includes("document title; defaults to 无题")) {
      throw new Error("browser Worker omitted @document field hover");
    }
    if (
      documentFieldHover.range?.start?.line !== 1 ||
      documentFieldHover.range?.start?.character !== 0 ||
      documentFieldHover.range?.end?.line !== 1 ||
      documentFieldHover.range?.end?.character !== 5
    ) {
      throw new Error(
        `browser Worker returned an invalid @document field hover range: ${JSON.stringify(documentFieldHover.range)}`
      );
    }
    const typHoverUri = "file:///workspace/typ-hover.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri: typHoverUri,
        languageId: "mmt",
        version: 1,
        text: "@typ: #text(\"checked\")"
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === typHoverUri
    );
    const typDirectiveHover = await request("textDocument/hover", {
      textDocument: { uri: typHoverUri },
      position: { line: 0, character: 3 }
    });
    if (!typDirectiveHover?.contents?.value?.includes("raw Typst content")) {
      throw new Error("browser Worker omitted @typ hover");
    }
    if (
      typDirectiveHover.range?.start?.line !== 0 ||
      typDirectiveHover.range?.start?.character !== 0 ||
      typDirectiveHover.range?.end?.line !== 0 ||
      typDirectiveHover.range?.end?.character !== 4
    ) {
      throw new Error(
        `browser Worker returned an invalid @typ hover range: ${JSON.stringify(typDirectiveHover.range)}`
      );
    }
    const multilineTypUri = "file:///workspace/multiline-typ.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri: multilineTypUri,
        languageId: "mmt",
        version: 1,
        text: "@typ\r\n\r\n#let step(body) = text(fill: white, weight: \"bold\", body)\r\n\r\n@end"
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === multilineTypUri
    );
    const multilineTypProject = await request("mmt/getTypstProject", { uri: multilineTypUri });
    if (!multilineTypProject) throw new Error("browser Worker discarded the multiline @typ projection");
    const multilineTypEntry = multilineTypProject.files.find(
      (file) => file.uri === multilineTypProject.entryUri
    );
    if (
      !multilineTypEntry?.text?.includes("#let step(body) = text(fill: white, weight: \"bold\", body)") ||
      !multilineTypEntry.text.includes("\r\n")
    ) {
      throw new Error("browser Worker omitted content from the multiline @typ projection");
    }
    const multilineTypProjectionError = notifications.find(
      (message) => message.method === "window/logMessage"
        && message.params?.message?.startsWith("mmt/projection:")
    );
    if (multilineTypProjectionError) {
      throw new Error(`browser Worker emitted a projection error: ${multilineTypProjectionError.params.message}`);
    }
    const documentCompletionUri = "file:///workspace/document-completion.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri: documentCompletionUri,
        languageId: "mmt",
        version: 1,
        text: "@document\ntitle: Story\nti"
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === documentCompletionUri
    );
    const documentFieldCompletions = await request("textDocument/completion", {
      textDocument: { uri: documentCompletionUri },
      position: { line: 2, character: 2 }
    });
    if (!documentFieldCompletions.some((item) => item.label === "timezone")) {
      throw new Error("browser Worker omitted @document field completions");
    }
    if (documentFieldCompletions.some((item) => item.label === "title")) {
      throw new Error("browser Worker repeated an existing unique @document field");
    }

    const documentValueUri = "file:///workspace/document-value-completion.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri: documentValueUri,
        languageId: "mmt",
        version: 1,
        text: "@document\ntimezone: \n@end"
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === documentValueUri
    );
    const documentValueCompletions = await request("textDocument/completion", {
      textDocument: { uri: documentValueUri },
      position: { line: 1, character: 10 }
    });
    for (const expected of ["local", "utc", "Z", "+08:00"]) {
      if (!documentValueCompletions.some((item) => item.label === expected)) {
        throw new Error(`browser Worker omitted @document value completion ${expected}`);
      }
    }
    const renderPresetUri = "file:///workspace/render-presets.mmt";
    notify("textDocument/didOpen", {
      textDocument: {
        uri: renderPresetUri,
        languageId: "mmt",
        version: 1,
        text: "@actor yuzu\npreset: ba::柚子\n@end\n> yuzu: Hello"
      }
    });
    await waitForNotification(
      "textDocument/publishDiagnostics",
      (message) => message.params.uri === renderPresetUri
    );
    const presetRequest = {
      uri: renderPresetUri,
      timestamp: { unixMillis: 1_700_000_000_000, localOffsetMinutes: 0 }
    };
    const outputPresetProject = await request("mmt/getTypstRenderProject", presetRequest);
    await waitForNotification(
      "mmt/typstRenderProjectUpdated",
      (message) => message.params.sourceUri === renderPresetUri
        && message.params.projectDigest === outputPresetProject.projectDigest
    );
    const explicitOutputPresetProject = await request("mmt/getTypstRenderProject", {
      ...presetRequest, renderPreset: { kind: "output" }
    });
    if (!hasExactKeys(outputPresetProject.renderPreset, ["kind"])
      || outputPresetProject.renderPreset.kind !== "output"
      || explicitOutputPresetProject.projectDigest !== outputPresetProject.projectDigest
      || explicitOutputPresetProject.projectionKey !== outputPresetProject.projectionKey) {
      throw new Error("browser Worker changed the omitted-preset output contract");
    }
    const presetProjects = [outputPresetProject];
    for (const widthPt of [240, 390, 720]) {
      const previous = presetProjects.at(-1);
      const chatProject = await request("mmt/getTypstRenderProject", {
        ...presetRequest,
        renderPreset: { kind: "chat", widthPt },
        baseRevision: previous.revision,
        baseProjectDigest: previous.projectDigest
      });
      const publication = await waitForNotification(
        "mmt/typstRenderProjectUpdated",
        (message) => message.params.sourceUri === renderPresetUri
          && message.params.projectDigest === chatProject.projectDigest
      );
      if (!hasExactKeys(chatProject.renderPreset, ["kind", "widthPt"])
        || chatProject.renderPreset.kind !== "chat" || chatProject.renderPreset.widthPt !== widthPt
        || JSON.stringify(publication.params.renderPreset) !== JSON.stringify(chatProject.renderPreset)
        || chatProject.sourceVersion !== outputPresetProject.sourceVersion
        || chatProject.sourceContent !== outputPresetProject.sourceContent
        || !chatProject.full || chatProject.baseRevision !== undefined || chatProject.baseProjectDigest !== undefined
        || Object.hasOwn(chatProject, "events")
        || presetProjects.some((candidate) => candidate.projectDigest === chatProject.projectDigest
          || candidate.projectionKey === chatProject.projectionKey
          || candidate.entryUri === chatProject.entryUri)) {
        throw new Error(`browser Worker failed render preset isolation at width ${widthPt}`);
      }
      const entry = chatProject.files.find((file) => file.uri === chatProject.entryUri);
      const wrapper = entry?.text?.indexOf("#text(\"") ?? -1;
      if (wrapper < 0) throw new Error("chat preset omitted the authored text projection");
      const offset = wrapper + 1;
      const target = await request("mmt/previewComposerTarget", {
        sourceUri: renderPresetUri,
        revision: chatProject.revision,
        sourceContent: chatProject.sourceContent,
        projectDigest: chatProject.projectDigest,
        projectionKey: chatProject.projectionKey,
        entryUri: chatProject.entryUri,
        backendEncoding: "utf-16",
        location: {
          uri: chatProject.entryUri,
          range: {
            start: positionAtUtf16(entry.text, offset),
            end: positionAtUtf16(entry.text, offset + 1)
          }
        }
      });
      if (target.kind !== "Editable" || target.properties?.statementText?.current !== "Hello") {
        throw new Error("chat preset did not authorize the same authored message");
      }
      presetProjects.push(chatProject);
    }
    const lastChatProject = presetProjects.at(-1);
    const restoredOutputPresetProject = await request("mmt/getTypstRenderProject", {
      ...presetRequest,
      renderPreset: { kind: "output" },
      baseRevision: lastChatProject.revision,
      baseProjectDigest: lastChatProject.projectDigest
    });
    if (restoredOutputPresetProject.renderPreset.kind !== "output"
      || restoredOutputPresetProject.sourceContent !== outputPresetProject.sourceContent
      || !restoredOutputPresetProject.full
      || restoredOutputPresetProject.baseRevision !== undefined
      || restoredOutputPresetProject.baseProjectDigest !== undefined) {
      throw new Error("browser Worker reused a chat incremental base for output");
    }
    const invalidRenderPresets = [
      null, "output", {}, { kind: "unknown" },
      { kind: "output", widthPt: 390 }, { kind: "output", extra: true },
      { kind: "chat" }, { kind: "chat", widthPt: "390" },
      { kind: "chat", widthPt: 239 }, { kind: "chat", widthPt: 721 },
      { kind: "chat", widthPt: 390.5 }, { kind: "chat", width_pt: 390 },
      { kind: "chat", widthPt: 390, extra: true }
    ];
    for (const renderPreset of invalidRenderPresets) {
      let rejection;
      try {
        await request("mmt/getTypstRenderProject", { ...presetRequest, renderPreset });
      } catch (error) {
        rejection = error;
      }
      if (!rejection || !/Invalid render preset/.test(rejection.message)) {
        throw new Error(`browser Worker accepted an invalid render preset: ${JSON.stringify(renderPreset)}`);
      }
    }
    const languagePresetProject = await request("mmt/getTypstProject", { uri: renderPresetUri });
    if (Object.hasOwn(languagePresetProject, "renderPreset")) {
      throw new Error("browser Worker leaked a render preset into the language projection DTO");
    }

    const authoringPackUpdate = await request("mmt/updatePackManifests", {
      revision: 2, sources: composerPackSources
    });
    if (authoringPackUpdate.revision !== 2 || !authoringPackUpdate.updated) {
      throw new Error("Worker did not activate the shared native/WASM Composer pack fixtures");
    }
    const nodeTarget = (node) => ({
      kind: "node", node: { nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range }
    });
    const structureParams = (snapshot, target, command) => ({
      textDocument: snapshot.textDocument, sourceDigest: snapshot.sourceDigest, target, command
    });
    async function authoringSnapshot(uri, source, version = 1) {
      const projected = waitForNotification("mmt/typstProjectUpdated", (message) =>
        message.params.sourceUri === uri && message.params.sourceVersion === version);
      notify(version === 1 ? "textDocument/didOpen" : "textDocument/didChange", version === 1
        ? { textDocument: { uri, languageId: "mmt", version, text: source } }
        : { textDocument: { uri, version }, contentChanges: [{ text: source }] });
      await projected;
      const snapshot = await request("mmt/composerDocument", { textDocument: { uri, version } });
      if (snapshot.kind !== "Snapshot"
        || !Array.isArray(snapshot.assetChoices)
        || snapshot.assetChoices.some((choice) => !hasExactKeys(choice, ["assetName"]) || typeof choice.assetName !== "string")) {
        throw new Error(`Worker did not return validated authoring choices: ${JSON.stringify(snapshot)}`);
      }
      return snapshot;
    }
    async function applyAtomicStructureEdit(source, snapshot, result) {
      const documents = result.edit?.documentChanges;
      if (result.kind !== "Edit" || !hasExactKeys(result, ["kind", "edit"])
        || !hasExactKeys(result.edit, ["documentChanges"])
        || documents?.length !== 1
        || !hasExactKeys(documents[0], ["textDocument", "edits"])
        || JSON.stringify(documents[0].textDocument) !== JSON.stringify(snapshot.textDocument)
        || documents[0].edits?.length !== 1
        || !hasExactKeys(documents[0].edits[0], ["range", "newText"])) {
        throw new Error(`Worker structure edit is not one versioned atomic change: ${JSON.stringify(result)}`);
      }
      const unchanged = await request("mmt/composerDocument", { textDocument: snapshot.textDocument });
      if (unchanged.sourceDigest !== snapshot.sourceDigest) throw new Error("Worker structure request mutated canonical source");
      const edit = documents[0].edits[0];
      const offsetAt = (position) => source.split("\n").slice(0, position.line)
        .reduce((offset, line) => offset + line.length + 1, position.character);
      const changed = source.slice(0, offsetAt(edit.range.start)) + edit.newText + source.slice(offsetAt(edit.range.end));
      return {
        source: changed,
        snapshot: await authoringSnapshot(snapshot.textDocument.uri, changed, snapshot.textDocument.version + 1)
      };
    }
    async function expectStructureRejection(params, reason) {
      const result = await request("mmt/composerEdit", params);
      if (!hasExactKeys(result, ["kind", "reason"]) || result.kind !== "Rejected"
        || (reason !== undefined && result.reason !== reason)) {
        throw new Error(`Worker accepted an unauthorized structure intent: ${JSON.stringify(result)}`);
      }
    }
    async function expectMalformedStructure(params) {
      let rejection;
      try { await request("mmt/composerEdit", params); } catch (error) { rejection = error; }
      if (!rejection || !/-32602|unknown field|unknown variant|decode|invalid params|did not match/iu.test(rejection.message)) {
        throw new Error(`Worker accepted malformed structure fields: ${JSON.stringify(params)}`);
      }
    }

    const insertionAvatar = {
      kind: "packAvatar", entityId: "ba_fixture::佳代子",
      contributionNamespace: "ba_fixture", variantId: "smile"
    };
    const hasInsertionAvatar = (node) => {
      const current = node.actorAvatar?.current;
      return hasExactKeys(current, ["kind", "entityId", "contributionNamespace", "variantId"])
        && Object.keys(insertionAvatar).every((key) => current[key] === insertionAvatar[key]);
    };
    const semanticAuthoringContract = { sideChanges: 0, explicitMoves: 0, avatarInsertions: 0, mediaInsertions: 0 };
    for (const [lineEnding, eol] of [["lf", "\n"], ["crlf", "\r\n"]]) {
      const sideSource = [
        "< _0: teacher", "> 佳代子: first😀", "> 小雪: second", "- fourth", "",
        "@typ: #strong[barrier]", "- isolated", ""
      ].join(eol);
      const sideSnapshot = await authoringSnapshot(`file:///workspace/side-${lineEnding}.mmt`, sideSource);
      const firstActor = sideSnapshot.nodes[1];
      if (JSON.stringify(sideSnapshot.nodes[0].capabilities.setSide) !== '["right"]'
        || JSON.stringify(firstActor.capabilities.setSide) !== '["left","right"]'
        || !Array.isArray(firstActor.capabilities.moveTargets)
        || !Array.isArray(sideSnapshot.nodes[3].capabilities.moveTargets)) {
        throw new Error("Worker did not publish explicit message-side and move-boundary capabilities");
      }
      const sideParams = structureParams(sideSnapshot, nodeTarget(firstActor), {
        kind: "setStatementSide", side: "right"
      });
      await expectStructureRejection({
        ...sideParams, target: nodeTarget(sideSnapshot.nodes[0]),
        command: { kind: "setStatementSide", side: "left" }
      }, "unsupportedStructure");
      await expectMalformedStructure({ ...sideParams, command: { kind: "setStatementSide", side: "center" } });
      await expectMalformedStructure({ ...sideParams, command: { kind: "setStatementSide", side: "right", sigil: "<" } });
      const sideChanged = await applyAtomicStructureEdit(sideSource, sideSnapshot, await request("mmt/composerEdit", sideParams));
      const afterSide = sideChanged.snapshot.nodes[1];
      if (sideChanged.source !== sideSource.replace("> 佳代子", "< 佳代子")
        || afterSide.side !== "right"
        || JSON.stringify(afterSide.body) !== JSON.stringify(firstActor.body)
        || JSON.stringify(afterSide.speaker) !== JSON.stringify(firstActor.speaker)
        || afterSide.continued !== firstActor.continued) {
        throw new Error("Worker side change altered message semantics or neighboring source bytes");
      }
      await expectStructureRejection(sideParams, "staleDocument");
      semanticAuthoringContract.sideChanges += 1;

      const moveSnapshot = await authoringSnapshot(`file:///workspace/move-${lineEnding}.mmt`, sideSource);
      const moveAnchor = moveSnapshot.boundaries[4].target;
      if (!moveSnapshot.nodes[1].capabilities.moveTargets.some((target) =>
        JSON.stringify(target) === JSON.stringify(moveAnchor))) {
        throw new Error("Worker omitted an authorized nonadjacent move boundary");
      }
      const moveParams = structureParams(moveSnapshot, nodeTarget(moveSnapshot.nodes[1]), {
        kind: "moveNode", anchor: moveAnchor
      });
      await expectStructureRejection({
        ...moveParams, command: { kind: "moveNode", anchor: moveSnapshot.boundaries.at(-1).target }
      }, "unsupportedStructure");
      const moved = await applyAtomicStructureEdit(sideSource, moveSnapshot, await request("mmt/composerEdit", moveParams));
      const editableBodies = moved.snapshot.nodes.filter((node) => node.kind !== "opaque").map((node) => node.body.current);
      if (JSON.stringify(editableBodies) !== JSON.stringify(["teacher", "second", "fourth", "first😀", "isolated"])
        || !moved.source.endsWith(`${eol}@typ: #strong[barrier]${eol}- isolated${eol}`)) {
        throw new Error("Worker explicit move crossed the opaque barrier or changed message content");
      }
      semanticAuthoringContract.explicitMoves += 1;

      const avatarSource = ["> 佳代子: before", "> 小雪: other", "> 佳代子: later", ""].join(eol);
      const avatarSnapshot = await authoringSnapshot(`file:///workspace/insert-avatar-${lineEnding}.mmt`, avatarSource);
      const avatarParams = structureParams(avatarSnapshot, avatarSnapshot.boundaries[1].target, {
        kind: "insertStatement",
        statement: {
          kind: "message", side: "left", speaker: { kind: "actor", reference: "佳代子" },
          avatar: insertionAvatar, body: { value: "new 😀\nsecond", mode: "textRaw" }, continued: "true"
        }
      });
      const insertedAvatar = await applyAtomicStructureEdit(
        avatarSource, avatarSnapshot, await request("mmt/composerEdit", avatarParams)
      );
      const avatarMessages = insertedAvatar.snapshot.nodes.filter((node) => node.kind === "message");
      const beforeMessages = avatarSnapshot.nodes.filter((node) => node.kind === "message");
      if (avatarMessages.length !== 4 || avatarMessages[1].body.current !== `new 😀${eol}second`
        || avatarMessages[1].continued !== "true"
        || JSON.stringify(avatarMessages[0].actorAvatar) !== JSON.stringify(beforeMessages[0].actorAvatar)
        || JSON.stringify(avatarMessages[2].actorAvatar) !== JSON.stringify(beforeMessages[1].actorAvatar)
        || [1, 3].some((index) => !hasInsertionAvatar(avatarMessages[index]))
        || !insertedAvatar.source.startsWith(`> 佳代子: before${eol}`)
        || !insertedAvatar.source.endsWith(`> 小雪: other${eol}> 佳代子: later${eol}`)) {
        throw new Error("Worker message-plus-avatar insertion did not preserve its scoped atomic semantics");
      }
      semanticAuthoringContract.avatarInsertions += 1;

      const mediaSource = ["@asset image_1", "src: old.png", "@end", "> 佳代子: before😀", "> 小雪: other", ""].join(eol);
      const mediaCases = [
        { name: "asset", media: { kind: "asset", assetName: "image_1" }, fileName: "old.png" },
        { name: "workspace", media: {
          kind: "workspaceImage", relativePath: "assets/88112233-4400-4400-8800-889911223344.jpg"
        }, avatar: insertionAvatar, fileName: "assets/88112233-4400-4400-8800-889911223344.jpg" },
        { name: "base-sticker", media: {
          kind: "sticker", entityId: "ba_fixture::佳代子", setId: "default", ordinal: 2
        }, namespace: "ba_fixture", frame: 1 },
        { name: "extension-sticker", media: {
          kind: "sticker", entityId: "ba_fixture::佳代子", setId: "festival", ordinal: 1
        }, namespace: "ba_fixture_ext", frame: 0 }
      ];
      for (const choice of mediaCases) {
        const uri = `file:///workspace/media-${choice.name}-${lineEnding}.mmt`;
        const mediaSnapshot = await authoringSnapshot(uri, mediaSource);
        if (JSON.stringify(mediaSnapshot.assetChoices) !== JSON.stringify([{ assetName: "image_1" }])) {
          throw new Error("Worker asset choices did not reflect declared canonical assets");
        }
        const statement = {
          kind: "media", side: choice.avatar ? "left" : "right",
          speaker: choice.avatar ? { kind: "actor", reference: "佳代子" } : { kind: "builtin" },
          avatar: choice.avatar ?? null, continued: choice.avatar ? "auto" : "false", media: choice.media
        };
        const params = structureParams(mediaSnapshot, mediaSnapshot.boundaries.at(-1).target, {
          kind: "insertStatement", statement
        });
        const inserted = await applyAtomicStructureEdit(mediaSource, mediaSnapshot, await request("mmt/composerEdit", params));
        const mediaNode = inserted.snapshot.nodes.filter((node) => node.kind === "message").at(-1);
        const expectedAssets = choice.name === "workspace"
          ? [{ assetName: "image_1" }, { assetName: "image_2" }]
          : [{ assetName: "image_1" }];
        if (!inserted.source.startsWith(mediaSource)
          || mediaNode.side !== statement.side || mediaNode.continued !== statement.continued
          || mediaNode.textEditing !== null || mediaNode.capabilities.delete !== true
          || !Array.isArray(mediaNode.capabilities.moveTargets)
          || JSON.stringify(inserted.snapshot.assetChoices) !== JSON.stringify(expectedAssets)
          || (choice.avatar && !hasInsertionAvatar(mediaNode))) {
          throw new Error(`Worker ${choice.name} media did not reparse into its authorized non-caret message`);
        }
        const mediaProject = await request("mmt/getTypstRenderProject", { uri });
        const resolved = choice.fileName
          ? mediaProject.resources.find((resource) => resource.kind === "workspace-file" && resource.fileName === choice.fileName)
          : mediaProject.resources.find((resource) => resource.kind === "image-sequence"
            && resource.packNamespace === choice.namespace && resource.frame === choice.frame);
        if (!resolved) throw new Error(`Worker ${choice.name} media lost its canonical resource reference or physical frame`);
        await expectStructureRejection(params, "staleDocument");
        semanticAuthoringContract.mediaInsertions += 1;
      }
    }

    const invalidMediaSource = "- keep😀\n";
    const invalidMediaSnapshot = await authoringSnapshot("file:///workspace/media-invalid-worker.mmt", invalidMediaSource);
    const mediaIntent = (media) => structureParams(invalidMediaSnapshot, invalidMediaSnapshot.boundaries.at(-1).target, {
      kind: "insertStatement", statement: {
        kind: "media", side: "right", speaker: { kind: "builtin" }, avatar: null, continued: "auto", media
      }
    });
    for (const media of [
      { kind: "asset", assetName: "undeclared" },
      { kind: "asset", assetName: "pack_portrait" },
      { kind: "workspaceImage", relativePath: "assets/../secret.png" },
      { kind: "workspaceImage", relativePath: "/assets/new.png" },
      { kind: "workspaceImage", relativePath: "assets/nested/new.png" },
      { kind: "workspaceImage", relativePath: "assets/new.svg" },
      { kind: "sticker", entityId: "ba_fixture::佳代子", setId: "missing", ordinal: 1 },
      { kind: "sticker", entityId: "ba_fixture::佳代子", setId: "default", ordinal: 9 }
    ]) await expectStructureRejection(mediaIntent(media), "invalidValue");
    for (const media of [
      { kind: "workspaceImage", relativePath: "assets/new.png", url: "https://example.test/x.png" },
      { kind: "asset", assetName: "image_1", source: "[:arbitrary:]" },
      { kind: "sticker", entityId: "ba_fixture::佳代子", setId: "default", ordinal: 0 },
      { kind: "sticker", entityId: "ba_fixture::佳代子", setId: "default", ordinal: 1.5 },
      { kind: "url", url: "https://example.test/x.png" }
    ]) await expectMalformedStructure(mediaIntent(media));
    const validMediaIntent = mediaIntent({ kind: "workspaceImage", relativePath: "assets/new.png" });
    await expectStructureRejection({ ...validMediaIntent, sourceDigest: "0".repeat(64) }, "staleDocument");
    await expectStructureRejection({
      ...validMediaIntent, textDocument: { ...validMediaIntent.textDocument, version: 0 }
    }, "staleDocument");
    const changedBoundary = structuredClone(validMediaIntent);
    changedBoundary.target.before.nodeKey = "0".repeat(64);
    await expectStructureRejection(changedBoundary);
    const teacherWithAvatar = structuredClone(validMediaIntent);
    teacherWithAvatar.command.statement.avatar = insertionAvatar;
    await expectStructureRejection(teacherWithAvatar, "invalidValue");
    const missingInsertionAvatar = structuredClone(validMediaIntent);
    missingInsertionAvatar.command.statement.side = "left";
    missingInsertionAvatar.command.statement.speaker = { kind: "actor", reference: "佳代子" };
    missingInsertionAvatar.command.statement.avatar = { ...insertionAvatar, variantId: "missing" };
    await expectStructureRejection(missingInsertionAvatar, "invalidValue");
    const unchangedInvalidMedia = await request("mmt/composerDocument", { textDocument: invalidMediaSnapshot.textDocument });
    if (unchangedInvalidMedia.sourceDigest !== invalidMediaSnapshot.sourceDigest
      || unchangedInvalidMedia.assetChoices.length !== 0) {
      throw new Error("Rejected media intent partially modified source or introduced an asset declaration");
    }

    await request("shutdown", null);
    notify("exit", null);
    worker.terminate();
    return {
      positionEncoding: initialize.capabilities.positionEncoding,
      hoverProvider: initialize.capabilities.hoverProvider,
      semanticTokensProvider: initialize.capabilities.semanticTokensProvider,
      inlayHintProvider: initialize.capabilities.inlayHintProvider,
      completionTriggerCharacters: initialize.capabilities.completionProvider?.triggerCharacters ?? [],
      diagnosticCount: diagnostics.params.diagnostics.length,
      symbolNames: symbols.map((symbol) => symbol.name),
      foldingCount: folding.length,
      semanticTokenCount: semanticTokens.data.length,
      replySemanticToken: semanticTokens.data.slice(0, 5),
      completionLabels: completion.map((item) => item.label),
      presetLabels: presetCompletion.map((item) => item.label),
      speakerLabels: speakerCompletion.map((item) => item.label),
      speakerInlayHints,
      semanticDiagnosticCount: semanticDiagnostics.params.diagnostics.length,
      packProjectionRevisions: [beforePackProject.params.revision, afterPackProject.params.revision],
      renderResource: renderProject.resources[0].fileName,
      renderNotificationIdentity: acceptedRenderProject.params.projectDigest === renderProject.projectDigest,
      renderPresetContract: {
        presets: presetProjects.map((project) => project.renderPreset),
        rejected: invalidRenderPresets.length,
        sameAuthoredSource: true,
        independentProjectionIdentities: true,
        crossPresetDeltaRejected: true
      },
      composerResultKinds: [
        composerTarget.kind,
        composerDocument.kind,
        staleComposerDocument.kind,
        unavailableComposerTarget.kind,
        composerEdit.kind,
        structureEdit.kind,
        rejectedComposerEdit.kind
      ],
      textComposerContract: {
        selection: composerSelection.kind,
        projection: composerTextProjection.kind,
        edit: textEdit.kind,
        copy: textRead.text,
        mergedSource: editedText,
        digestRestored: afterTextSnapshot.sourceDigest === textEdit.sourceDigestAfter,
        staleDigest: staleTextRead.reason,
        invalidBoundary: invalidBoundary.reason
      },
      semanticAuthoringContract,
      synchronizationVersions: [afterDuplicate.sourceVersion, afterOlder.sourceVersion],
      legacyUpdateDocumentUnavailable: true,
      renderDiagnosticPhases: [...renderPhases].sort(),
      renderDiagnosticCount: renderDiagnosticsProject.diagnostics.length,
      duplicateRenderPublication: false,
      documentConfigMode: documentConfig.compiledAt.mode,
      documentFieldLabels: documentFieldCompletions.map((item) => item.label),
      documentValueLabels: documentValueCompletions.map((item) => item.label),
      documentHoverKinds: [
        documentDirectiveHover.contents.kind,
        documentFieldHover.contents.kind,
        typDirectiveHover.contents.kind
      ],
      multilineTypProjectionVersion: multilineTypProject.sourceVersion
    };
  }, {
    wasmUri: `http://127.0.0.1:${address.port}/wasm/mmt_lsp_bg.wasm`,
    composerPackSources
  });

  if (result.positionEncoding !== "utf-16") throw new Error("position encoding mismatch");
  if (result.hoverProvider !== true) throw new Error("missing negotiated hover provider");
  if (!result.semanticTokensProvider?.full) throw new Error("missing negotiated semantic tokens provider");
  if (result.inlayHintProvider !== true) throw new Error("missing negotiated inlay hint provider");
  if (!result.completionTriggerCharacters.includes(".")) {
    throw new Error("missing negotiated Typst member completion trigger");
  }
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
  const expectedSpeakerHintPositions = [[2, 4], [3, 4], [4, 1]];
  if (
    result.speakerInlayHints.length !== expectedSpeakerHintPositions.length ||
    result.speakerInlayHints.some((hint, index) =>
      hint.label !== "→ 柚子" ||
      hint.tooltip !== "实际说话人：柚子" ||
      hint.paddingLeft !== true ||
      hint.position.line !== expectedSpeakerHintPositions[index][0] ||
      hint.position.character !== expectedSpeakerHintPositions[index][1]
    )
  ) {
    throw new Error(`unexpected browser Worker speaker inlay hints: ${JSON.stringify(result.speakerInlayHints)}`);
  }
  if (result.semanticDiagnosticCount < 1) throw new Error("missing browser Worker semantic diagnostics");
  if (
    JSON.stringify(result.composerResultKinds)
    !== JSON.stringify(["Editable", "Snapshot", "Rejected", "Unavailable", "Edit", "Edit", "Rejected"])
  ) {
    throw new Error(`browser Worker Composer result unions mismatch: ${JSON.stringify(result.composerResultKinds)}`);
  }
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
