import assert from "node:assert/strict";

import { composerDocumentSourceDigest } from "../src/composerDocument.ts";
import { ComposerRuntime } from "../src/composerRuntime.ts";

class TestDocument {
  constructor(uri, version, text) {
    this.uri = { toString: () => uri };
    this.version = version;
    this.text = text;
    this.languageId = "mmt";
  }

  getText() { return this.text; }

  offsetAt(position) {
    const lines = this.text.split(/(?<=\n)/u);
    let offset = 0;
    for (let line = 0; line < position.line; line += 1) offset += lines[line]?.length ?? 0;
    return offset + position.character;
  }

  positionAt(offset) {
    const prefix = this.text.slice(0, offset);
    const lines = prefix.split("\n");
    return { line: lines.length - 1, character: lines.at(-1).length };
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

function disposableListeners() {
  const listeners = new Set();
  return {
    listeners,
    subscribe(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    emit(value) { for (const listener of [...listeners]) listener(value); },
  };
}

async function narrationSnapshot(document, body, options = {}) {
  const range = { start: { line: 0, character: 0 }, end: document.positionAt(document.getText().length) };
  const ref = { nodeKey: options.nodeKey ?? "a".repeat(64), nodeKind: "narration", range };
  const before = { kind: "boundary", before: null, after: ref };
  const after = { kind: "boundary", before: ref, after: null };
  return {
    kind: "Snapshot",
    textDocument: { uri: document.uri.toString(), version: document.version },
    sourceDigest: await composerDocumentSourceDigest(document.getText()),
    nodes: [{
      kind: "narration",
      nodeKey: ref.nodeKey,
      range,
      statementRange: range,
      body: { current: body, mode: "inherit", resolvedMode: "textMacro", inheritedMode: "textMacro" },
      capabilities: {
        setBody: options.setBody ?? true,
        delete: options.delete ?? true,
        moveUp: null,
        moveDown: null,
      },
    }],
    boundaries: [
      { target: before, insert: options.insert ?? null },
      { target: after, insert: options.insert ?? null },
    ],
    scriptActorChoices: [],
  };
}

function editResult(document, newText = "- changed") {
  return {
    kind: "Edit",
    edit: {
      documentChanges: [{
        textDocument: { uri: document.uri.toString(), version: document.version },
        edits: [{
          range: { start: { line: 0, character: 0 }, end: document.positionAt(document.getText().length) },
          newText,
        }],
      }],
    },
  };
}

function createHarness() {
  const documents = new Map();
  const documentChanges = disposableListeners();
  const catalogChanges = disposableListeners();
  const documentRequests = [];
  const editRequests = [];
  const applyCalls = [];
  const notifications = [];
  const hostCalls = [];
  let apply = async (options) => {
    applyCalls.push(options);
    return options.canApply() ? { kind: "Applied" } : { kind: "Stale" };
  };
  const ports = {
    requestDocument(params, signal) {
      const pending = deferred();
      documentRequests.push({ params, signal, pending });
      return pending.promise;
    },
    requestEdit(params, signal) {
      const pending = deferred();
      editRequests.push({ params, signal, pending });
      return pending.promise;
    },
    applyEdit(options) { return apply(options); },
    currentDocument(uri) { return documents.get(uri); },
    isWorkspaceDocument(document) { return documents.get(document.uri.toString()) === document; },
    onDidChangeDocument(listener) { return documentChanges.subscribe(listener); },
    getPackSpeakerReferences() { return ["pack::A"]; },
    onDidChangeCatalog(listener) { return catalogChanges.subscribe(listener); },
    navigateSource(uri, range) { hostCalls.push(["source", uri, range]); },
    openPreview(uri) { hostCalls.push(["preview", uri]); },
    showHistory(uri) { hostCalls.push(["history", uri]); },
    save(uri) { hostCalls.push(["save", uri]); },
    exportExact(uri) { hostCalls.push(["export", uri]); },
    notify(kind, message) { notifications.push([kind, message]); },
  };
  return {
    documents,
    documentChanges,
    catalogChanges,
    documentRequests,
    editRequests,
    applyCalls,
    notifications,
    hostCalls,
    ports,
    setApply(next) { apply = next; },
  };
}


async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await settle();
  }
  throw new Error("timed out waiting for Composer runtime state");
}
async function settle() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

{
  const harness = createHarness();
  const runtime = new ComposerRuntime(harness.ports);
  const wrongExtension = new TestDocument("file:///workspace/story.txt", 1, "text");
  harness.documents.set(wrongExtension.uri.toString(), wrongExtension);
  assert.equal(runtime.bindDocument(wrongExtension), false);
  const outside = new TestDocument("file:///outside/story.mmt", 1, "- A");
  assert.equal(runtime.bindDocument(outside), false);
  runtime.dispose();
}

{
  const harness = createHarness();
  const document = new TestDocument("file:///workspace/story.mmt", 1, "- A");
  harness.documents.set(document.uri.toString(), document);
  const runtime = new ComposerRuntime(harness.ports);
  assert.equal(runtime.bindDocument(document), true);
  assert.equal(harness.documentRequests.length, 1);
  const firstSnapshot = await narrationSnapshot(document, "A");

  document.version = 2;
  document.text = "- B";
  harness.documentChanges.emit({ document, contentChanges: [{}] });
  assert.equal(runtime.state.snapshot, null);
  assert.equal(harness.documentRequests[0].signal.aborted, true);
  assert.equal(harness.documentRequests.length, 2);
  const secondSnapshot = await narrationSnapshot(document, "B", { nodeKey: "b".repeat(64) });
  harness.documentRequests[1].pending.resolve(secondSnapshot);
  await waitFor(() => runtime.state.snapshot !== null);
  assert.equal(runtime.state.snapshot.nodes[0].body.current, "B");
  const acceptedSnapshot = runtime.state.snapshot;
  harness.documentRequests[0].pending.resolve(firstSnapshot);
  await settle();
  assert.equal(runtime.state.snapshot, acceptedSnapshot);

  let closed = 0;
  const transient = runtime.beginTransient(() => { closed += 1; });
  const captured = transient.identity;
  harness.catalogChanges.emit();
  assert.equal(closed, 1);
  assert.equal(transient.isCurrent(), false);
  assert.equal(runtime.state.snapshot, acceptedSnapshot);
  assert.equal(harness.documentRequests.length, 2);
  await runtime.execute({
    kind: "property",
    target: { range: acceptedSnapshot.nodes[0].statementRange },
    command: { kind: "setStatementBody", value: "stale", mode: "inherit" },
  }, captured);
  assert.equal(harness.editRequests.length, 0);
  assert.match(harness.notifications.at(-1)[1], /源码已更改/u);

  runtime.selectNode(acceptedSnapshot.nodes[0].nodeKey);
  runtime.expandNode(acceptedSnapshot.nodes[0].nodeKey);
  await runtime.navigateSource(acceptedSnapshot.nodes[0].range);
  await runtime.openPreview();
  await runtime.showHistory();
  await runtime.save();
  await runtime.exportExact();
  assert.deepEqual(harness.hostCalls.map((call) => call[0]), ["source", "preview", "history", "save", "export"]);

  document.version = 3;
  document.text = "- C";
  const reopened = runtime.beginTransient(() => { closed += 1; });
  harness.documentChanges.emit({ document, contentChanges: [{}] });
  assert.equal(closed, 2);
  assert.equal(reopened.isCurrent(), false);
  assert.equal(runtime.state.snapshot, null);
  assert.equal(runtime.state.selectedNodeKey, null);
  assert.equal(runtime.state.expandedNodeKey, null);
  runtime.dispose();
}

{
  const harness = createHarness();
  const document = new TestDocument("file:///workspace/apply.mmt", 4, "- A");
  harness.documents.set(document.uri.toString(), document);
  const runtime = new ComposerRuntime(harness.ports);
  runtime.bindDocument(document);
  const snapshot = await narrationSnapshot(document, "A");
  harness.documentRequests[0].pending.resolve(snapshot);
  await waitFor(() => runtime.state.snapshot !== null);
  const acceptedSnapshot = runtime.state.snapshot;

  const execution = runtime.execute({
    kind: "property",
    target: { range: snapshot.nodes[0].statementRange },
    command: { kind: "setStatementBody", value: "changed", mode: "inherit" },
  });
  assert.equal(harness.editRequests.length, 1);
  harness.editRequests[0].pending.resolve(editResult(document));
  await execution;
  assert.equal(harness.editRequests.length, 1);
  assert.equal(harness.applyCalls.length, 1);
  assert.equal(runtime.state.snapshot, acceptedSnapshot);
  assert.equal(harness.documentRequests.length, 1);

  const barrierSnapshot = await narrationSnapshot(document, "A", { setBody: false, delete: false });
  runtime.dispose();
  const barrierHarness = createHarness();
  barrierHarness.documents.set(document.uri.toString(), document);
  const barrierRuntime = new ComposerRuntime(barrierHarness.ports);
  barrierRuntime.bindDocument(document);
  barrierHarness.documentRequests[0].pending.resolve(barrierSnapshot);
  await waitFor(() => barrierRuntime.state.snapshot !== null);
  await barrierRuntime.execute({
    kind: "property",
    target: { range: barrierSnapshot.nodes[0].statementRange },
    command: { kind: "setStatementBody", value: "blocked", mode: "inherit" },
  });
  assert.equal(barrierHarness.editRequests.length, 0);


  barrierRuntime.dispose();
}
{
  const harness = createHarness();
  const document = new TestDocument("file:///workspace/errors.mmt", 1, "- A");
  harness.documents.set(document.uri.toString(), document);
  const runtime = new ComposerRuntime(harness.ports);
  runtime.bindDocument(document);
  const snapshot = await narrationSnapshot(document, "A");
  harness.documentRequests[0].pending.resolve(snapshot);
  await waitFor(() => runtime.state.snapshot !== null);
  const capability = {
    kind: "property",
    target: { range: snapshot.nodes[0].statementRange },
    command: { kind: "setStatementBody", value: "changed", mode: "inherit" },
  };

  const rejected = runtime.execute(capability);
  harness.editRequests[0].pending.resolve({ kind: "Rejected", reason: "candidateInvalid" });
  await rejected;
  assert.equal(harness.notifications.at(-1)[0], "warning");
  assert.match(harness.notifications.at(-1)[1], /无法应用/u);

  harness.setApply(async (options) => {
    harness.applyCalls.push(options);
    return { kind: "ApplyFailed" };
  });
  const failed = runtime.execute(capability);
  harness.editRequests[1].pending.resolve(editResult(document));
  await failed;
  assert.equal(harness.notifications.at(-1)[0], "error");
  assert.match(harness.notifications.at(-1)[1], /无法应用编辑/u);
  runtime.dispose();
}

{
  const harness = createHarness();
  const document = new TestDocument("file:///workspace/drift.mmt", 1, "- A");
  harness.documents.set(document.uri.toString(), document);
  const runtime = new ComposerRuntime(harness.ports);
  runtime.bindDocument(document);
  const snapshot = await narrationSnapshot(document, "A");
  harness.documentRequests[0].pending.resolve(snapshot);
  await waitFor(() => runtime.state.snapshot !== null);
  harness.setApply(async (options) => {
    harness.applyCalls.push(options);
    document.version = 2;
    return options.canApply() ? { kind: "Applied" } : { kind: "Stale" };
  });
  const execution = runtime.execute({
    kind: "structure",
    target: { kind: "node", node: {
      nodeKey: snapshot.nodes[0].nodeKey,
      nodeKind: "narration",
      range: snapshot.nodes[0].range,
    } },
    command: { kind: "deleteNode" },
  });
  harness.editRequests[0].pending.resolve(editResult(document, ""));
  await execution;
  assert.equal(harness.applyCalls.length, 1);
  assert.match(harness.notifications.at(-1)[1], /源码已更改/u);

  const listenerStates = [];
  runtime.onDidChangeState((state) => listenerStates.push(state));
  const requestCount = harness.documentRequests.length;
  runtime.dispose();
  assert.equal(harness.documentChanges.listeners.size, 0);
  assert.equal(harness.catalogChanges.listeners.size, 0);
  harness.documentChanges.emit({ document, contentChanges: [{}] });
  harness.catalogChanges.emit();
  assert.equal(harness.documentRequests.length, requestCount);
  assert.equal(listenerStates.length, 0);
}

console.log("composer runtime contracts passed");
