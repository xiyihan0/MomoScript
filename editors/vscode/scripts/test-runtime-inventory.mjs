import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixturePath = path.join(root, "src/test/fixtures/runtime-inventory.json");
const [
  fixtureText,
  mainSource,
  workerSource,
  processSource,
  transportSource,
  processTransportSource,
  projectStateSource,
  runtimeOwnerSource,
  desktopSource,
  webSource
] = await Promise.all([
  readFile(fixturePath, "utf8"),
  readFile(path.join(root, "../vscode-web/src/main.ts"), "utf8"),
  readFile(path.join(root, "src/tinymistClient.ts"), "utf8"),
  readFile(path.join(root, "src/tinymistProcessClient.ts"), "utf8"),
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
  "editors/vscode/src/tinymistClient.ts",
  "editors/vscode/src/tinymistProcessClient.ts",
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
  assert.match(mainSource, new RegExp(`\\b${name}\\b`), `inventory entry ${name} no longer exists in main.ts`);
}
assert.ok(inventory.main.collections.every((entry) => entry.role && entry.owner && entry.dispose));

const listenerAnchors = {
  panelVisibilityRegistration: "const panelVisibilityRegistration = own(",
  sidebarVisibilityRegistration: "const sidebarVisibilityRegistration = own(",
  typstDocumentOpenRegistration: "const typstDocumentOpenRegistration = own(",
  typstEditorActivationRegistration: "const typstEditorActivationRegistration = own(",
  "mmt/typstProjectUpdated": "activeClient.onNotification(\"mmt/typstProjectUpdated\"",
  "mmt/typstProjectClosed": "\"mmt/typstProjectClosed\"",
  documentConfigCommandRegistration: "const documentConfigCommandRegistration = own(",
  previewCommandRegistration: "const previewCommandRegistration = own(",
  previewPanelDisposeRegistration: "previewPanelDisposeRegistration = own(",
  previewPanelMessageRegistration: "previewPanelMessageRegistration = own(",
  packConfigRegistration: "const packConfigRegistration = own(",
  previewConfigRegistration: "const previewConfigRegistration = own(",
  markerEditingRegistration: "const markerEditingRegistration = own",
  documentPersistenceRegistration: "const documentPersistenceRegistration = own(",
  typstDocumentChangeRegistration: "const typstDocumentChangeRegistration = own(",
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
assert.equal(inventory.main.dispose.primaryOwner, "RuntimeOwner");
assert.match(mainSource, /const own = <T extends \{ dispose\(\): void \| Promise<void> \}>/);
assert.match(mainSource, /disposeWithFallback\(ownerDispose/);
assert.match(mainSource, /terminateOnUnload\(\{ terminate: terminateWorkers \}, ownerDispose\)/);

const duplicateNames = inventory.duplicatedClientState.map((entry) => [entry.worker, entry.process]);
assert.equal(duplicateNames.length, 4, "remaining client wrapper state inventory is incomplete");
for (const entry of inventory.duplicatedClientState) {
  assert.match(workerSource, new RegExp(`\\b${entry.worker}\\b`), `Worker wrapper state ${entry.worker} disappeared`);
  assert.match(processSource, new RegExp(`\\b${entry.process}\\b`), `process wrapper state ${entry.process} disappeared`);
}
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
