import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
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
      || !hasExactKeys(composerTarget.properties, ["continued"])
      || composerTarget.textDocument.uri !== composerUri
      || composerTarget.textDocument.version !== 7
      || composerTarget.target.kind !== "statement"
      || composerTarget.target.range.start.line !== 0
      || composerTarget.target.range.start.character !== 0
      || composerTarget.target.range.end.character !== composerSource.length
      || composerTarget.properties.continued !== "auto"
      || Object.hasOwn(composerTarget.properties, "actorDisplayName")
    ) {
      throw new Error(`browser Worker preview Composer target mismatch: ${JSON.stringify(composerTarget)}`);
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
      composerResultKinds: [
        composerTarget.kind,
        unavailableComposerTarget.kind,
        composerEdit.kind,
        rejectedComposerEdit.kind
      ],
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
  }, `http://127.0.0.1:${address.port}/wasm/mmt_lsp_bg.wasm`);

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
    !== JSON.stringify(["Editable", "Unavailable", "Edit", "Rejected"])
  ) {
    throw new Error(`browser Worker Composer result unions mismatch: ${JSON.stringify(result.composerResultKinds)}`);
  }
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
