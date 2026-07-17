import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = path.join(root, "src/test/fixtures/runtime-inventory.json");
const [
  fixtureText,
  mainSource,
  runtimeControllerSource,
  workerSource,
  processSource,
  hostSessionSource,
  transportSource,
  processTransportSource,
  projectStateSource,
  runtimeOwnerSource,
  desktopSource,
  webSource
] = await Promise.all([
  readFile(fixturePath, "utf8"),
  readFile(path.join(root, "../vscode-web/src/main.ts"), "utf8"),
  readFile(path.join(root, "../vscode-web/src/runtimeController.ts"), "utf8"),
  readFile(path.join(root, "src/tinymistClient.ts"), "utf8"),
  readFile(path.join(root, "src/tinymistProcessClient.ts"), "utf8"),
  readFile(path.join(root, "src/tinymistHostSession.ts"), "utf8"),
  readFile(path.join(root, "src/tinymistTransport.ts"), "utf8"),
  readFile(path.join(root, "src/tinymistProcessTransport.ts"), "utf8"),
  readFile(path.join(root, "src/typstProjectState.ts"), "utf8"),
  readFile(path.join(root, "../vscode-web/src/runtimeOwner.ts"), "utf8"),
  readFile(path.join(root, "src/extension.ts"), "utf8"),
  readFile(path.join(root, "src/extension.web.ts"), "utf8")
]);
const inventory = JSON.parse(fixtureText);
assert.equal(inventory.schemaVersion, 1);
assert.deepEqual(inventory.scope, [
  "editors/vscode-web/src/main.ts",
  "editors/vscode-web/src/runtimeController.ts",
  "editors/vscode/src/tinymistClient.ts",
  "editors/vscode/src/tinymistProcessClient.ts",
  "editors/vscode/src/tinymistHostSession.ts",
  "editors/vscode/src/tinymistTransport.ts",
  "editors/vscode/src/typstProjectState.ts"
]);

const expectedMainCollections = [
  "previewProjects",
  "packSourcesByNamespace",
  "latestProjectBySource",
  "retiredProjectSessions",
  "materializationControllers",
  "latestLanguageProjectionBySource",
  "typstRevisions",
  "typstProjects",
  "acceptedPreviewLanguageProjects",
  "retiredLanguageProjectionSessions",
  "requestedRenderTokens",
  "renderRequestIdBySource",
  "persistenceByUri"
];
assert.deepEqual(
  inventory.main.collections.map((entry) => entry.name),
  expectedMainCollections,
  "main.ts collection ownership inventory changed"
);
for (const name of expectedMainCollections) {
  assert.match(runtimeControllerSource, new RegExp(`\\b${name}\\b`), `controller store ${name} is missing`);
  assert.match(mainSource, new RegExp(`\\b${name}\\b`), `production composition no longer consumes ${name}`);
  assert.doesNotMatch(mainSource, new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*new\\s+(?:Map|Set|WeakSet)`), `${name} returned to main.ts ownership`);
}
assert.ok(inventory.main.collections.every((entry) => entry.role && entry.owner && entry.dispose));

const listenerAnchors = {
  panelVisibilityRegistration: "const panelVisibilityRegistration = own(",
  sidebarVisibilityRegistration: "const sidebarVisibilityRegistration = own(",
  typstDocumentOpenRegistration: "const typstDocumentOpenRegistration = subscribe(",
  typstEditorActivationRegistration: "const typstEditorActivationRegistration = subscribe(",
  "mmt/typstProjectUpdated": "activeClient.onNotification(\"mmt/typstProjectUpdated\"",
  "mmt/typstProjectClosed": "\"mmt/typstProjectClosed\"",
  documentConfigCommandRegistration: "const documentConfigCommandRegistration = subscribe(",
  previewCommandRegistration: "const previewCommandRegistration = subscribe(",
  previewPanelDisposeRegistration: "previewPanelDisposeRegistration = subscribe(",
  previewPanelMessageRegistration: "previewPanelMessageRegistration = subscribe(",
  packConfigRegistration: "const packConfigRegistration = subscribe(",
  previewConfigRegistration: "const previewConfigRegistration = subscribe(",
  markerEditingRegistration: "const markerEditingRegistration = subscribe",
  documentPersistenceRegistration: "const documentPersistenceRegistration = subscribe(",
  typstDocumentChangeRegistration: "const typstDocumentChangeRegistration = subscribe(",
  beforeunload: "ownEventListener(window, \"beforeunload\"",
  hmr: "hot?.dispose(hotDispose)",
  "layout activity click": "activity.addEventListener(\"click\", syncActivitySelection, true)",
  "settings controls": "previewToggle.addEventListener(\"change\", updatePreviewSetting)",
  "preview webview controls": "exportTrigger?.addEventListener('click'",
  "AVIFS abort": "signal.addEventListener(\"abort\", abort, { once: true })"
};
for (const listener of inventory.main.listeners) {
  const anchor = listenerAnchors[listener.name];
  assert.ok(anchor, `listener ${listener.name} has no machine-check anchor`);
  assert.ok(mainSource.includes(anchor), `listener ${listener.name} no longer matches main.ts`);
  assert.ok(listener.owner, `listener ${listener.name} has no dispose owner`);
}

assert.deepEqual(inventory.main.timers.map((entry) => entry.name), [
  "document projection catch-up",
  "download object URL revoke",
  "HMR graceful fallback"
]);
assert.match(mainSource, /setTimeout\(resolve, 50\)/);
assert.match(mainSource, /setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 0\)/);
assert.match(runtimeOwnerSource, /setTimeout\(\(\) => \{ timedOut = true; resolve\(\); \}, deadlineMs\)/);
assert.match(runtimeControllerSource, /disposeWithFallback/);

const workerNames = inventory.main.workersAndProcesses.map((entry) => entry.name);
assert.deepEqual(workerNames, [
  "TextEditorWorker",
  "TextMateWorker",
  "OutputLinkDetectionWorker",
  "Tinymist Worker",
  "MMT Worker",
  "AVIFS decoder",
  "native Tinymist",
  "native MMT LSP"
]);
for (const anchor of ["TextEditorWorker", "TextMateWorker", "OutputLinkDetectionWorker", "./avifSequenceWorker.ts"]) {
  assert.ok(mainSource.includes(anchor), `Worker anchor ${anchor} disappeared`);
}
assert.match(webSource, /TinymistWorkerClient\.start/);
assert.match(webSource, /worker = new Worker/);
assert.match(desktopSource, /TinymistProcessClient\.start/);
assert.match(desktopSource, /new LanguageClient/);
assert.equal(inventory.main.dispose.primaryOwner, "EditorRuntimeController");
assert.match(mainSource, /controller\.own\(resource\)/);
assert.match(mainSource, /controller\.subscribe\(subscription\)/);
assert.match(mainSource, /controller\.dispose\(750/);
assert.match(mainSource, /controller\.terminateAndDispose\(\)/);

assert.deepEqual(inventory.duplicatedClientState, [], "Worker/process lifecycle state is still duplicated");
const duplicatedFieldDeclaration = /private(?:\s+readonly)?\s+(?:handlers|ready|stopped|restarting)\b/;
assert.doesNotMatch(workerSource, duplicatedFieldDeclaration, "Worker adapter owns shared lifecycle state");
assert.doesNotMatch(processSource, duplicatedFieldDeclaration, "process adapter owns shared lifecycle state");
assert.doesNotMatch(workerSource, /new\s+TypstProjectState|\.onFailure\(|\.onNotification\(/, "Worker adapter bypasses the shared host session");
assert.doesNotMatch(processSource, /new\s+TypstProjectState|\.onFailure\(|\.onNotification\(/, "process adapter bypasses the shared host session");
for (const entry of inventory.sharedHostSessionState) {
  assert.match(hostSessionSource, new RegExp(`private(?:\\s+readonly)?\\s+${entry.name}\\b`), `shared host-session state ${entry.name} is missing`);
}
assert.equal(inventory.hostSessionLifecycle.owner, "TinymistHostSession");
assert.match(hostSessionSource, /if \(this\.stopped \|\| this\.ready \|\| this\.restarting\) return;/, "recovery is not serialized");
assert.match(hostSessionSource, /this\.stopped = true;[\s\S]*await this\.options\.transport\.stop\(\);/, "graceful disposal is not terminal before shutdown");
assert.match(hostSessionSource, /this\.stopped = true;[\s\S]*this\.options\.transport\.terminateNow\(error\);/, "immediate disposal does not synchronously terminate");
for (const entry of inventory.sharedTransportState) {
  assert.match(transportSource, new RegExp(`\\b${entry.name}\\b`), `shared transport state ${entry.name} disappeared`);
}
for (const entry of inventory.sharedProjectState) {
  assert.match(projectStateSource, new RegExp(`\\b${entry.name}\\b`), `shared project state ${entry.name} disappeared`);
}
for (const entry of inventory.processOnlyState) {
  assert.match(processTransportSource, new RegExp(`\\b${entry.name}\\b`), `process-only state ${entry.name} disappeared`);
}
for (const entry of inventory.workerOnlyState) {
  assert.match(workerSource, new RegExp(`\\b${entry.name}\\b`), `Worker-only state ${entry.name} disappeared`);
}

assert.doesNotMatch(fixtureText, /(?:file|https?):\/\//, "inventory contains a host/network URI");
assert.doesNotMatch(fixtureText, /(?:\/home\/|[A-Z]:\\\\)/, "inventory contains an absolute host path");
assert.doesNotMatch(fixtureText, /"(?:capturedAt|durationMs|timestamp)"/, "inventory contains volatile timing evidence");
console.log(JSON.stringify({
  checked: true,
  mainCollections: inventory.main.collections.length,
  listeners: inventory.main.listeners.length,
  timers: inventory.main.timers.length,
  workersAndProcesses: inventory.main.workersAndProcesses.length,
  duplicatedClientState: inventory.duplicatedClientState.length
}));
