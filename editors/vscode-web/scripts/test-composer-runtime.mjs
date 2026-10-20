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
      textEditing: { text: body.replace(/\r\n?/gu, "\n") },
      capabilities: {
        setBody: options.setBody ?? true,
        delete: options.delete ?? true,
        replaceSource: options.replaceSource ?? true,
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
  assert.equal(runtime.state.snapshot, null, "catalog changes revoke source-unchanged capabilities");
  assert.equal(harness.documentRequests.length, 3, "a completed semantic catalog change requests one fresh snapshot");
  assert.deepEqual(harness.documentRequests[2].params, { textDocument: { uri: document.uri.toString(), version: 2 } });
  await runtime.execute({
    kind: "property",
    target: { range: acceptedSnapshot.nodes[0].statementRange },
    command: { kind: "setStatementBody", value: "stale", mode: "inherit" },
  }, captured);
  assert.equal(harness.editRequests.length, 0);

  harness.documentRequests[2].pending.resolve(secondSnapshot);
  await waitFor(() => runtime.state.snapshot !== null);
  const refreshedSnapshot = runtime.state.snapshot;
  assert.notEqual(refreshedSnapshot, acceptedSnapshot);
  assert.equal(refreshedSnapshot.sourceDigest, acceptedSnapshot.sourceDigest);
  assert.equal(runtime.captureIdentity().catalogEpoch, captured.catalogEpoch + 1);
  runtime.selectNode(refreshedSnapshot.nodes[0].nodeKey);
  runtime.expandNode(refreshedSnapshot.nodes[0].nodeKey);
  await runtime.navigateSource(refreshedSnapshot.nodes[0].range);
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
  const document = new TestDocument("file:///workspace/catalog-ready.mmt", 1, "- A");
  harness.documents.set(document.uri.toString(), document);
  const runtime = new ComposerRuntime(harness.ports);
  const unavailable = await narrationSnapshot(document, "A", { setBody: false, delete: false, replaceSource: false });
  unavailable.nodes[0].textEditing = null;
  runtime.bindDocument(document);
  harness.documentRequests[0].pending.resolve(unavailable);
  await waitFor(() => runtime.state.snapshot !== null);
  assert.equal(runtime.state.snapshot.boundaries.at(-1).insert, null);
  const initialIdentity = runtime.captureIdentity();
  runtime.selectNode(runtime.state.snapshot.nodes[0].nodeKey);
  runtime.expandNode(runtime.state.snapshot.nodes[0].nodeKey);
  let closed = 0;
  const transient = runtime.beginTransient(() => { closed += 1; });

  harness.catalogChanges.emit();
  assert.equal(runtime.state.snapshot, null);
  assert.equal(runtime.state.selectedNodeKey, null);
  assert.equal(runtime.state.expandedNodeKey, null);
  assert.equal(closed, 1);
  assert.equal(transient.isCurrent(), false);
  assert.equal(harness.documentRequests.length, 2);
  harness.catalogChanges.emit();
  assert.equal(harness.documentRequests[1].signal.aborted, true);
  assert.equal(harness.documentRequests.length, 3);
  harness.documentRequests[1].pending.resolve(unavailable);
  await settle();
  assert.equal(runtime.state.snapshot, null, "a superseded catalog response cannot restore stale restrictions");

  const ready = await narrationSnapshot(document, "A");
  ready.boundaries[1].insert = {
    boundary: ready.boundaries[1].target,
    messageSides: ["left", "right"],
    builtinMessageSides: ["right"],
    statementModes: ["textRaw"],
    speakerSources: ["packEntity"],
    narration: true,
  };
  harness.documentRequests[2].pending.resolve(ready);
  await waitFor(() => runtime.state.snapshot !== null);
  assert.equal(runtime.state.bound.version, 1);
  assert.equal(document.getText(), "- A");
  assert.equal(runtime.state.snapshot.sourceDigest, unavailable.sourceDigest);
  assert.equal(runtime.state.snapshot.nodes[0].capabilities.setBody, true);
  assert.equal(runtime.state.snapshot.nodes[0].textEditing.text, "A");
  assert.ok(runtime.state.snapshot.boundaries.at(-1).insert);
  assert.equal(runtime.state.selectedNodeKey, null, "semantic refresh does not guess a selection rebind");
  const insertion = {
    kind: "structure",
    target: runtime.state.snapshot.boundaries.at(-1).target,
    command: { kind: "insertStatement", statement: {
      kind: "message", side: "left", speaker: { kind: "actor", reference: "pack::A" },
      continued: "auto", body: { value: "new message", mode: "textRaw" },
    } },
  };
  assert.equal(await runtime.execute(insertion, initialIdentity), false);
  assert.equal(harness.editRequests.length, 0, "an old catalog identity remains stale at the same source version");
  const execution = runtime.execute(insertion, runtime.captureIdentity());
  assert.equal(harness.editRequests.length, 1, "the refreshed pack-backed insertion is now authorized");
  harness.editRequests[0].pending.resolve(editResult(document, '- A\n> pack::A: rt"""\nnew message"""\n'));
  assert.equal(await execution, true);
  assert.equal(harness.applyCalls.length, 1);
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
  assert.equal(await execution, true, "only an applied discrete command may clear a continuous draft");
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
  assert.equal(await rejected, false);
  assert.equal(harness.notifications.at(-1)[0], "warning");

  harness.setApply(async (options) => {
    harness.applyCalls.push(options);
    return { kind: "ApplyFailed" };
  });
  const failed = runtime.execute(capability);
  harness.editRequests[1].pending.resolve(editResult(document));
  assert.equal(await failed, false);
  assert.equal(harness.notifications.at(-1)[0], "error");
  const appliedBeforeWrongKind = harness.applyCalls.length;
  const wrongKind = runtime.execute(capability);
  const afterEndpoint = { statementRange: snapshot.nodes[0].statementRange, offsetUtf16: 1 };
  harness.editRequests[2].pending.resolve({
    ...editResult(document),
    kind: "TextEdit",
    sourceDigestAfter: snapshot.sourceDigest,
    selectionAfter: { anchor: afterEndpoint, focus: afterEndpoint },
  });
  assert.equal(await wrongKind, false);
  assert.equal(harness.applyCalls.length, appliedBeforeWrongKind, "discrete commands cannot apply text-selection results");
  assert.equal(document.getText(), "- A");
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
  assert.equal(await execution, false, "stale application cannot report success to the continuous composer");
  assert.equal(harness.applyCalls.length, 1);

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

// The transport fixture supplies explicit authorized candidates. This is deliberately
// not a second MMT serializer: the host must apply these edits and rebind exactly.
async function textSnapshot(document, records) {
  const snapshot = await narrationSnapshot(document, records[0].body);
  let cursor = 0;
  snapshot.nodes = await Promise.all(records.map(async (record, index) => {
    const start = cursor;
    cursor += record.source.length;
    const range = { start: document.positionAt(start), end: document.positionAt(cursor) };
    return {
      ...snapshot.nodes[0],
      nodeKey: await composerDocumentSourceDigest(`${document.version}:${index}:${record.source}`),
      range,
      statementRange: range,
      body: { current: record.body, mode: "inherit", resolvedMode: "textMacro", inheritedMode: "textMacro" },
      textEditing: { text: record.body },
    };
  }));
  const refs = snapshot.nodes.map((node) => ({ nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range }));
  snapshot.boundaries = Array.from({ length: refs.length + 1 }, (_, index) => ({
    target: { kind: "boundary", before: refs[index - 1] ?? null, after: refs[index] ?? null }, insert: null,
  }));
  return snapshot;
}

async function createTextHarness(initialRecords) {
  const harness = createHarness();
  const document = new TestDocument("file:///workspace/text-session.mmt", 1, initialRecords.map((record) => record.source).join(""));
  harness.documents.set(document.uri.toString(), document);
  const runtime = new ComposerRuntime(harness.ports);
  const requests = [];
  const candidates = new Map();
  const recovery = [];
  const clipboard = [];
  const states = [];
  const hitTests = [];
  const menus = [];
  const focusChanges = [];
  let records = initialRecords;
  let renderIdentity;
  let sequence = 0;
  let alternative = 1;
  let nextAlternative = 1;
  let group;
  let clipboardFailure = false;
  let corruptEvent = false;
  let coalesceEvent = false;
  const undo = [];
  const redo = [];
  const currentHistoryState = () => ({ source: document.text, records, alternative });
  const history = {
    uri: document.uri.toString(),
    getVersionId: () => document.version,
    getAlternativeVersionId: () => alternative,
    pushStackElement() {
      if (group) { undo.push(group); group = undefined; redo.length = 0; }
    },
    canUndo: () => !!group || undo.length > 0,
    canRedo: () => redo.length > 0,
    undo() {
      history.pushStackElement();
      const entry = undo.pop();
      if (!entry) return;
      redo.push(entry);
      restore(entry.before, 1);
    },
    redo() {
      const entry = redo.pop();
      if (!entry) return;
      undo.push(entry);
      restore(entry.after, 2);
    },
  };
  function restore(state, reason) {
    const range = { start: { line: 0, character: 0 }, end: document.positionAt(document.text.length) };
    document.text = state.source;
    document.version += 1;
    records = state.records;
    alternative = state.alternative;
    harness.documentChanges.emit({ document, reason, contentChanges: [{ range, text: state.source }] });
  }
  const caret = (endpoint) => ({ pageIndex: 0, x: endpoint.offsetUtf16 / 100, y: 0.1, width: 0.001, height: 0.03, affinity: "after" });
  function mapped(selection, identity) {
    const nodes = runtime.state.snapshot.nodes;
    const endpoints = [selection.anchor, selection.focus].map((endpoint) => ({
      endpoint, index: nodes.findIndex((node) => node.nodeKey === endpoint.node.nodeKey),
    })).sort((left, right) => left.index - right.index || left.endpoint.offsetUtf16 - right.endpoint.offsetUtf16);
    const [first, last] = endpoints;
    const text = nodes.slice(first.index, last.index + 1).map((node, index) => node.textEditing.text.slice(
      index === 0 ? first.endpoint.offsetUtf16 : 0,
      index === last.index - first.index ? last.endpoint.offsetUtf16 : undefined,
    )).join("\n");
    return {
      status: "mapped", identity, selection, text,
      anchorCarets: [caret(selection.anchor)], carets: [caret(selection.focus)],
      anchorCaret: caret(selection.anchor), focusCaret: caret(selection.focus),
      boxes: text ? [{ pageIndex: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.03 }] : [], preferredX: null,
    };
  }
  const ports = {
    currentGeometryIdentity: () => renderIdentity,
    geometry: {
      async selection(selection, identity) { return mapped(selection, identity); },
      async hitTest(point, uncertainty, identity) {
        hitTests.push({ point, uncertainty, identity });
        const node = runtime.state.snapshot.nodes[point.pageIndex];
        const endpoint = { node: { nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range }, offsetUtf16: Math.round(point.x * 100) };
        return { status: "mapped", identity, endpoint, caret: caret(endpoint), carets: [caret(endpoint)],
          authored: { uri: document.uri.toString(), range: { start: node.range.start, end: node.range.start } } };
      },
      async move(selection, direction, granularity, extend, _preferredX, identity) {
        if (granularity !== "document") return mapped(selection, identity);
        const nodes = runtime.state.snapshot.nodes;
        const node = direction === "left" ? nodes[0] : nodes.at(-1);
        const focus = { node: { nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range },
          offsetUtf16: direction === "left" ? 0 : node.textEditing.text.length };
        return mapped({ anchor: extend ? selection.anchor : focus, focus }, identity);
      },
      async caret(endpoint, identity) {
        return { status: "mapped", identity, endpoint, caret: caret(endpoint), carets: [caret(endpoint)],
          authored: { uri: document.uri.toString(), range: { start: endpoint.node.range.start, end: endpoint.node.range.start } } };
      },
    },
    requestTextEdit(params, signal) {
      const pending = deferred();
      requests.push({ params, signal, pending });
      return pending.promise;
    },
    async applyTextEdit(options) {
      const before = document.text;
      const wholeRange = { start: { line: 0, character: 0 }, end: document.positionAt(before.length) };
      const edits = options.result.edit.documentChanges[0].edits;
      const changes = edits.map((edit) => ({
        range: edit.range, text: edit.newText,
        start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end),
      })).sort((left, right) => right.start - left.start);
      let candidate = before;
      for (const change of changes) candidate = candidate.slice(0, change.start) + change.text + candidate.slice(change.end);
      if (options.signal.aborted || !options.canApply(candidate)) return { kind: "Stale" };
      if (options.undoStopBefore) history.pushStackElement();
      group ??= { before: currentHistoryState(), after: undefined };
      const corrupt = corruptEvent;
      const coalesced = coalesceEvent;
      corruptEvent = false;
      coalesceEvent = false;
      document.text = corrupt ? `${candidate}!` : candidate;
      document.version += 1;
      alternative = ++nextAlternative;
      records = candidates.get(options.result.sourceDigestAfter);
      group.after = currentHistoryState();
      harness.documentChanges.emit({
        document,
        contentChanges: coalesced
          ? [{ range: wholeRange, text: candidate }]
          : changes.map((change) => ({ range: change.range, text: change.text })),
      });
      if (options.undoStopAfter) history.pushStackElement();
      return { kind: "Applied", modelVersion: document.version, alternativeVersionId: alternative };
    },
    nativeHistory: () => history,
    async writeClipboard(text) {
      if (clipboardFailure) throw new Error("permission denied");
      clipboard.push(text);
    },
    async readClipboard() { return clipboard.at(-1) ?? ""; },
    async showContextMenu(request, signal) { menus.push({ request, signal }); return undefined; },
    navigateFocus(backward) { focusChanges.push(backward); },
    recover(text, reason, id) {
      const existing = recovery.find((entry) => entry.id === id);
      if (existing) { existing.text = text; existing.reason = reason; }
      else recovery.push({ id, text, reason });
    },
    notify(kind, text) { harness.notifications.push([kind, text]); },
  };
  const session = runtime.attachTextSession(ports);
  session.onDidChangeState((state) => states.push(state));
  runtime.bindDocument(document);
  async function publishSnapshot() {
    harness.documentRequests.at(-1).pending.resolve(await textSnapshot(document, records));
    await waitFor(() => runtime.state.snapshot?.textDocument.version === document.version);
  }
  async function publishRender() {
    const snapshot = runtime.state.snapshot;
    renderIdentity = {
      sourceUri: document.uri.toString(), version: document.version, sourceDigest: snapshot.sourceDigest,
      renderKey: `render-${document.version}`, sessionId: "renderer-not-input-session", generation: document.version,
      revision: `revision-${document.version}`, sourceContent: document.text, projectDigest: "d".repeat(64),
      projectionKey: `projection-${document.version}`, entryUri: "file:///workspace/entry.typ", backendEncoding: "utf-16",
    };
    await session.refreshGeometry();
  }
  await publishSnapshot();
  session.setActive(true);
  await publishRender();
  const nodeRef = (index = 0) => {
    const node = runtime.state.snapshot.nodes[index];
    return { nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range };
  };
  let sequenceSessionId = session.state.sessionId;
  const send = (intent, renderKey = session.state.renderKey, admitted = true) => {
    if (sequenceSessionId !== session.state.sessionId) {
      sequenceSessionId = session.state.sessionId;
      sequence = session.state.sequence;
    }
    sequence = Math.max(sequence, session.state.sequence) + 1;
    return session.handleIntent({
      type: "composer-intent", sessionId: session.state.sessionId, sequence, renderKey, intent,
    }, admitted);
  };
  async function respond(nextRecords, offset, nodeIndex = 0, override = {}) {
    const request = requests.find((request) => !request.answered);
    assert.ok(request, "a submitted semantic intent must reach Rust authorization");
    request.answered = true;
    const candidate = new TestDocument(document.uri.toString(), document.version + 1, nextRecords.map((record) => record.source).join(""));
    const snapshot = await textSnapshot(candidate, nextRecords);
    candidates.set(snapshot.sourceDigest, nextRecords);
    const endpoint = { statementRange: snapshot.nodes[nodeIndex].statementRange, offsetUtf16: offset };
    request.pending.resolve({
      kind: "TextEdit",
      edit: { documentChanges: [{ textDocument: request.params.textDocument, edits: [{
        range: { start: { line: 0, character: 0 }, end: document.positionAt(document.text.length) }, newText: candidate.text,
      }] }] },
      sourceDigestAfter: snapshot.sourceDigest, selectionAfter: { anchor: endpoint, focus: endpoint }, ...override,
    });
    await waitFor(() => document.version === candidate.version);
  }
  async function idle() { await waitFor(() => session.pendingIntentCount === 0); }
  return {
    ...harness, runtime, session, document, ports, requests, recovery, clipboard, states, history, hitTests, menus, focusChanges,
    nodeRef, send, respond, publishSnapshot, publishRender, idle,
    failClipboard(value = true) { clipboardFailure = value; },
    corruptOwnEvent() { corruptEvent = true; },
    coalesceOwnEvent() { coalesceEvent = true; },
    external(nextRecords) {
      records = nextRecords;
      document.text = records.map((record) => record.source).join("");
      document.version += 1;
      alternative = ++nextAlternative;
      harness.documentChanges.emit({ document, contentChanges: [{}] });
    },
  };
}

{
  // A stalled renderer and deliberately delayed snapshots cannot debounce/drop text.
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  const sessionId = h.session.state.sessionId;
  for (const text of ["x", "y", "\n", "z"]) assert.equal(h.send({ kind: "replace", origin: "typing", text }), true);
  assert.equal(h.session.pendingIntentCount, 4);
  assert.equal(h.session.hasUnsubmittedInput, true);
  const candidates = [
    [{ source: "- Ax", body: "Ax" }, 2],
    [{ source: "- Axy", body: "Axy" }, 3],
    [{ source: '- """\nAxy\n"""', body: "Axy\n" }, 4],
    [{ source: '- """\nAxy\nz"""', body: "Axy\nz" }, 5],
  ];
  for (let index = 0; index < candidates.length; index += 1) {
    await waitFor(() => h.requests.length === index + 1);
    assert.equal(h.requests[index].params.target.selection.focus.offsetUtf16, index + 1);
    await h.respond([candidates[index][0]], candidates[index][1]);
    await settle();
    assert.equal(h.requests.length, index + 1, "next edit waits for the candidate snapshot, not just the mutation event");
    assert.equal(h.session.state.sessionId, sessionId, "own edits retain the input bridge identity");
    assert.equal(h.session.state.status, "pending");
    await h.publishSnapshot();
  }
  await h.idle();
  assert.equal(h.document.text, '- """\nAxy\nz"""');
  assert.equal(h.runtime.state.snapshot.nodes[0].textEditing.text, "Axy\nz");
  assert.equal(h.session.selection.focus.offsetUtf16, 5);
  assert.equal(h.session.hasUnsubmittedInput, false);
  assert.deepEqual(h.recovery, []);
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  const rejectedSessionId = h.session.state.sessionId;
  const rejectedRenderKey = h.session.state.renderKey;
  assert.equal(h.send({ kind: "replace", origin: "typing", text: "x" }), true);
  assert.equal(h.send({ kind: "replace", origin: "typing", text: "w" }), true);
  await waitFor(() => h.requests.length === 1);
  const pointerSequence = h.session.state.sequence + 1;
  assert.equal(h.send({
    kind: "pointer", phase: "start", point: { pageIndex: 0, x: 0, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 1,
  }, rejectedRenderKey, false), false);
  assert.ok(h.states.some((state) => state.sessionId === rejectedSessionId
    && state.sequence === pointerSequence && state.status === "blocked"),
  "an explicitly rejected pointer sequence is acknowledged as blocked");
  assert.equal(h.send({ kind: "replace", origin: "typing", text: "y" }, rejectedRenderKey, false), false);
  await h.respond([{ source: "- Ax", body: "Ax" }], 2);
  await h.publishSnapshot();
  await waitFor(() => h.requests.length === 2);
  await h.respond([{ source: "- Axw", body: "Axw" }], 3);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- Axw", "a rejected pointer never cancels preceding accepted text");
  assert.equal(h.requests.length, 2);
  assert.equal(h.session.recoveryText, "y", "text following the rejected gesture is recovered, not sent to the old caret");
  await h.publishRender();
  await waitFor(() => h.session.state.status === "ready");
  assert.equal(h.session.selection, null);
  assert.equal(h.send({ kind: "replace", origin: "typing", text: "z" }), false);
  assert.equal(h.session.recoveryText, "yz", "a fresh semantic selection is required after pointer rejection");
  assert.equal(h.send({
    kind: "pointer", phase: "start", point: { pageIndex: 0, x: 0.03, y: 0.1 },
    uncertainty: { x: 0.001, y: 0.002 }, extend: false, clickCount: 1,
  }), true);
  await h.idle();
  assert.deepEqual(h.hitTests.at(-1).uncertainty, { x: 0.001, y: 0.002 },
    "pointer precision reaches the geometry authorization port unchanged");
  assert.equal(h.send({
    kind: "pointer", phase: "end", point: { pageIndex: 0, x: 0.03, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 1,
  }), true);
  await h.idle();
  assert.equal(h.send({ kind: "replace", origin: "typing", text: "q" }), true);
  await waitFor(() => h.requests.length === 3);
  await h.respond([{ source: "- Axwq", body: "Axwq" }], 4);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- Axwq", "input resumes only after a newly authorized pointer target");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "replace", origin: "typing", text: "x" });
  h.send({ kind: "replace", origin: "typing", text: "y" });
  await waitFor(() => h.requests.length === 1);
  h.external([{ source: "- external", body: "external" }]);
  await h.idle();
  await waitFor(() => h.recovery.length === 1);
  assert.equal(h.document.text, "- external");
  assert.equal(h.recovery[0].text, "xy", "external conflicts retain the complete unsubmitted FIFO");
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.session.resolveRecovery(h.recovery[0].id, "x"), false, "a partial chunk cannot discard the remaining user text");
  h.runtime.dispose();
  assert.equal(h.session.resolveRecovery(h.recovery[0].id, "xy"), true, "recovery remains copyable after pane disposal");
  assert.equal(h.session.hasUnsubmittedInput, false);
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "replace", origin: "typing", text: "x" });
  h.send({ kind: "replace", origin: "typing", text: "y" });
  await h.respond([{ source: "- Ax", body: "Ax" }], 2);
  h.external([{ source: "- outside", body: "outside" }]);
  await h.idle();
  await waitFor(() => h.recovery.length === 1);
  assert.equal(h.recovery[0].text, "y", "a proved applied intent must not be offered again as unsubmitted text");
  assert.equal(h.document.text, "- outside");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.corruptOwnEvent();
  h.send({ kind: "replace", origin: "typing", text: "x" });
  h.send({ kind: "replace", origin: "typing", text: "y" });
  await h.respond([{ source: "- Ax", body: "Ax" }], 2);
  await h.idle();
  assert.equal(h.document.text, "- Ax!");
  assert.equal(h.requests.length, 1, "a resulting document that differs from the authorized candidate is external");
  assert.equal(h.session.selection, null);
  assert.ok(h.session.recoveryText.includes("y"));
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- AB", body: "AB" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.coalesceOwnEvent();
  h.send({ kind: "replace", origin: "typing", text: "x" });
  h.send({ kind: "replace", origin: "typing", text: "z" });
  await waitFor(() => h.requests.length === 1);
  const textDocument = h.requests[0].params.textDocument;
  await h.respond([{ source: "- xABy", body: "xABy" }], 4, 0, {
    edit: { documentChanges: [{ textDocument, edits: [
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, newText: "x" },
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 4 } }, newText: "y" },
    ] }] },
  });
  await h.publishSnapshot();
  await waitFor(() => h.requests.length === 2);
  assert.equal(h.requests[1].params.target.selection.focus.offsetUtf16, 4,
    "a coalesced Monaco event is owned by its exact resulting candidate");
  await h.respond([{ source: "- xAByz", body: "xAByz" }], 5);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- xAByz");
  assert.equal(h.session.recoveryText, "");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "composition", phase: "start", text: "" });
  h.send({ kind: "composition", phase: "update", text: "中" });
  h.send({ kind: "composition", phase: "update", text: "中文" });
  await h.idle();
  assert.equal(h.document.text, "- A");
  assert.equal(h.requests.length, 0, "IME updates never request temporary workspace edits");
  assert.equal(h.session.hasUnsubmittedInput, true);
  h.send({ kind: "composition", phase: "end", text: "中文" });
  h.send({ kind: "composition", phase: "end", text: "中文" });
  await waitFor(() => h.requests.length === 1);
  await h.respond([{ source: "- A中文", body: "A中文" }], 3);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- A中文");
  assert.equal(h.requests.length, 1, "duplicate compositionend cannot commit twice");
  h.send({ kind: "history", direction: "undo" });
  await waitFor(() => h.document.text === "- A");
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.session.selection.focus.offsetUtf16, 1, "native alternative-version bookmark restores the pre-composition caret");
  await h.publishRender();
  h.send({ kind: "composition", phase: "start", text: "" });
  h.send({ kind: "composition", phase: "update", text: "取消" });
  h.send({ kind: "composition", phase: "cancel", text: "" });
  await h.idle();
  assert.equal(h.document.text, "- A");
  assert.equal(h.requests.length, 1);
  assert.equal(h.session.hasUnsubmittedInput, false);
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A😀é中", body: "A😀é中" }]);
  await h.session.enter(h.nodeRef(), 3);
  h.send({ kind: "replace", origin: "delete", text: "", direction: "backward", granularity: "grapheme" });
  await waitFor(() => h.requests.length === 1);
  const deletion = h.requests[0].params.target.selection;
  assert.deepEqual([deletion.anchor.offsetUtf16, deletion.focus.offsetUtf16], [3, 1], "Backspace selects the whole emoji, never one surrogate");
  await h.respond([{ source: "- Aé中", body: "Aé中" }], 1);
  await h.publishSnapshot();
  await h.idle();
  await h.session.enter(h.nodeRef(), 3);
  h.send({ kind: "replace", origin: "delete", text: "", direction: "backward", granularity: "grapheme" });
  await waitFor(() => h.requests.length === 2);
  assert.deepEqual([h.requests[1].params.target.selection.anchor.offsetUtf16, h.requests[1].params.target.selection.focus.offsetUtf16], [3, 1]);
  await h.respond([{ source: "- A中", body: "A中" }], 1);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- A中", "combining cluster deletion preserves the neighboring CJK character");
  h.send({ kind: "history", direction: "undo" });
  await waitFor(() => h.document.text === "- Aé中");
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.session.selection.focus.offsetUtf16, 3, "undo restores the pre-Backspace caret, not the temporary deletion range");
  assert.equal(h.session.selection.anchor.offsetUtf16, 3);
  h.runtime.dispose();
}

{
  const records = [{ source: "- abc\n", body: "abc" }, { source: "- def\n", body: "def" }];
  const h = await createTextHarness(records);
  await h.session.enter(h.nodeRef(1), 0);
  h.send({ kind: "replace", origin: "delete", text: "", direction: "backward", granularity: "grapheme" });
  await h.idle();
  await h.session.enter(h.nodeRef(0), 3);
  h.send({ kind: "replace", origin: "delete", text: "", direction: "forward", granularity: "word" });
  await h.idle();
  assert.equal(h.requests.length, 0, "collapsed body-boundary deletes never merge neighboring messages");
  assert.equal(h.document.text, "- abc\n- def\n");
  await h.publishRender();
  h.send({ kind: "pointer", phase: "start", point: { pageIndex: 0, x: 0.01, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 1 });
  await h.idle();
  h.send({ kind: "pointer", phase: "end", point: { pageIndex: 1, x: 0.02, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: true, clickCount: 1 });
  await h.idle();
  await h.session.runContextAction("copy");
  await h.idle();
  assert.equal(h.clipboard.at(-1), "bc\nde");
  h.failClipboard();
  await h.session.runContextAction("cut");
  await h.idle();
  assert.equal(h.document.text, "- abc\n- def\n");
  assert.equal(h.requests.length, 0, "failed clipboard writes must not authorize cut deletion");
  h.send({ kind: "replace", origin: "typing", text: "X" });
  await waitFor(() => h.requests.length === 1);
  assert.notEqual(h.requests[0].params.target.selection.anchor.node.nodeKey, h.requests[0].params.target.selection.focus.node.nodeKey);
  await h.respond([{ source: "- aXf\n", body: "aXf" }], 2);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- aXf\n");
  h.send({ kind: "history", direction: "undo" });
  await waitFor(() => h.document.text === "- abc\n- def\n");
  await h.publishSnapshot();
  await h.idle();
  assert.deepEqual([h.session.selection.anchor.offsetUtf16, h.session.selection.focus.offsetUtf16], [1, 2]);
  assert.notEqual(h.session.selection.anchor.node.nodeKey, h.session.selection.focus.node.nodeKey);
  h.send({ kind: "history", direction: "redo" });
  await waitFor(() => h.document.text === "- aXf\n");
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.session.selection.focus.offsetUtf16, 2);
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "replace", origin: "typing", text: "x" });
  h.send({ kind: "replace", origin: "typing", text: "y" });
  await h.respond([{ source: "- Ax", body: "Ax" }], 2);
  await h.publishSnapshot();
  await waitFor(() => h.requests.length === 2);
  await h.respond([{ source: "- Axy", body: "Axy" }], 3);
  await h.publishSnapshot();
  await h.idle();
  h.send({ kind: "replace", origin: "paste", text: "P" });
  await waitFor(() => h.requests.length === 3);
  await h.respond([{ source: "- AxyP", body: "AxyP" }], 4);
  await h.publishSnapshot();
  await h.idle();
  h.send({ kind: "history", direction: "undo" });
  await waitFor(() => h.document.text === "- Axy");
  await h.publishSnapshot();
  await h.idle();
  h.send({ kind: "history", direction: "undo" });
  await waitFor(() => h.document.text === "- A");
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.session.selection.focus.offsetUtf16, 1, "continuous typing is one native group, separate from paste");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "replace", origin: "typing", text: "x" });
  h.send({ kind: "replace", origin: "typing", text: "y" });
  await h.respond([{ source: "- Ax", body: "Ax" }], 2);
  await h.publishSnapshot();
  await waitFor(() => h.requests.length === 2);
  let closed = 0;
  const transient = h.runtime.beginTransient(() => { closed += 1; });
  assert.ok(transient);
  transient.close();
  await settle();
  assert.equal(closed, 1);
  assert.equal(h.session.state.status, "blocked",
    "closing a transient early keeps admission paused until its accepted FIFO settles");
  await h.respond([{ source: "- Axy", body: "Axy" }], 3);
  await h.publishSnapshot();
  await h.idle();
  await h.publishRender();
  await waitFor(() => h.session.state.status === "ready");
  h.send({ kind: "composition", phase: "start", text: "" });
  h.send({ kind: "composition", phase: "update", text: "新输入" });
  await h.idle();
  assert.equal(h.session.hasUnsubmittedInput, true,
    "the retired transient drain cannot cancel a newer IME composition");
  assert.equal(h.session.recoveryText, "");
  h.send({ kind: "composition", phase: "cancel", text: "" });
  await h.idle();
  h.send({ kind: "history", direction: "undo" });
  await waitFor(() => h.document.text === "- A");
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- A",
    "the pause boundary closes after preceding accepted typing, so one undo removes the burst");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  const originalKey = h.session.state.renderKey;
  h.send({ kind: "replace", origin: "typing", text: "x" });
  await h.respond([{ source: "- Ax", body: "Ax" }], 2);
  await h.publishSnapshot();
  await h.idle();
  await h.publishRender();
  assert.notEqual(h.session.state.renderKey, originalKey);
  assert.equal(h.send({ kind: "replace", origin: "typing", text: "y" }, originalKey), true,
    "an in-flight keyboard message may use an actually published earlier render from the uninterrupted own-edit chain");
  await waitFor(() => h.requests.length === 2);
  await h.respond([{ source: "- Axy", body: "Axy" }], 3);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.send({ kind: "replace", origin: "typing", text: "lost" }, "never-published"), false);
  assert.equal(h.document.text, "- Axy");
  assert.equal(h.session.recoveryText, "lost", "unknown render identity cannot silently drop or retarget user text");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "composition", phase: "start", text: "" });
  h.send({ kind: "composition", phase: "update", text: "草稿" });
  await h.idle();
  h.session.quiesce();
  await waitFor(() => h.recovery.length === 1);
  assert.equal(h.recovery[0].text, "草稿");
  assert.equal(h.document.text, "- A");
  assert.equal(h.session.pendingIntentCount, 0);
  assert.equal(h.session.hasUnsubmittedInput, true);
  assert.equal(h.session.resolveRecovery(h.recovery[0].id, "草稿"), true);
  assert.equal(h.session.hasUnsubmittedInput, false);
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "replace", origin: "typing", text: "x" });
  h.send({ kind: "replace", origin: "typing", text: "y" });
  await waitFor(() => h.requests.length === 1);
  h.requests[0].pending.resolve({ kind: "Rejected", reason: "candidateInvalid" });
  await h.idle();
  assert.equal(h.document.text, "- A");
  assert.equal(h.requests.length, 1);
  assert.equal(h.session.recoveryText, "xy", "backend candidate failure preserves the rejected input and every later accepted character");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "replace", origin: "typing", text: "x" });
  h.send({ kind: "replace", origin: "typing", text: "y" });
  const shifted = { statementRange: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } }, offsetUtf16: 2 };
  await h.respond([{ source: "- Ax", body: "Ax" }], 2, 0, { selectionAfter: { anchor: shifted, focus: shifted } });
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- Ax");
  assert.equal(h.requests.length, 1, "an overlapping but unequal candidate statement range is not a rebind");
  assert.equal(h.session.selection, null);
  assert.equal(h.session.recoveryText, "y");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- abc\n", body: "abc" }, { source: "- def\n", body: "def" }]);
  h.send({ kind: "pointer", phase: "start", point: { pageIndex: 0, x: 0.01, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 1 });
  await h.idle();
  h.send({ kind: "pointer", phase: "end", point: { pageIndex: 1, x: 0.02, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: true, clickCount: 1 });
  await h.idle();
  const permission = deferred();
  let clipboardStarted = false;
  h.ports.writeClipboard = async (text) => {
    assert.equal(text, "bc\nde");
    clipboardStarted = true;
    await permission.promise;
  };
  const cutting = h.session.runContextAction("cut");
  await waitFor(() => clipboardStarted);
  assert.equal(h.requests.length, 0, "cut authorization must wait until clipboard permission succeeds");
  h.external([{ source: "- elsewhere", body: "elsewhere" }]);
  permission.resolve();
  await h.idle();
  await cutting;
  assert.equal(h.document.text, "- elsewhere");
  assert.equal(h.requests.length, 0, "clipboard completion cannot revive a stale selection");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- abcdef", body: "abcdef" }]);
  h.send({ kind: "pointer", phase: "start", point: { pageIndex: 0, x: 0.01, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 1 });
  await h.idle();
  const hit = h.ports.geometry.hitTest;
  const gate = deferred();
  let waiting = false;
  h.ports.geometry.hitTest = async (point, uncertainty, identity, signal) => {
    if (point.x === 0.02) { waiting = true; await gate.promise; }
    return hit(point, uncertainty, identity, signal);
  };
  h.send({ kind: "pointer", phase: "move", point: { pageIndex: 0, x: 0.02, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: true, clickCount: 1 });
  await waitFor(() => waiting);
  h.send({ kind: "pointer", phase: "move", point: { pageIndex: 0, x: 0.03, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: true, clickCount: 1 });
  h.send({ kind: "pointer", phase: "move", point: { pageIndex: 0, x: 0.04, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: true, clickCount: 1 });
  h.send({ kind: "replace", origin: "typing", text: "X" });
  gate.resolve();
  await waitFor(() => h.requests.length === 1);
  assert.deepEqual([h.requests[0].params.target.selection.anchor.offsetUtf16, h.requests[0].params.target.selection.focus.offsetUtf16], [1, 4]);
  await h.respond([{ source: "- aXef", body: "aXef" }], 2);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- aXef", "latest drag point coalescing does not coalesce or drop the following text");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "composition", phase: "start", text: "" });
  h.send({ kind: "composition", phase: "update", text: "你" });
  await h.idle();
  const retired = h.session.state;
  h.session.setActive(false);
  await waitFor(() => h.recovery.length === 1);
  const id = h.recovery[0].id;
  assert.equal(h.session.recoverRetiredIntent({
    type: "composer-intent", sessionId: retired.sessionId, renderKey: retired.renderKey, sequence: retired.sequence + 1,
    intent: { kind: "composition", phase: "update", text: "你好" },
  }), true);
  assert.equal(h.session.recoveryText, "你好", "late composition updates replace the captured draft instead of concatenating 你你好");
  assert.equal(h.session.resolveRecovery(id, "你"), false, "a stale clipboard-copy completion cannot discard an updated draft");
  h.session.recoverRetiredIntent({
    type: "composer-intent", sessionId: retired.sessionId, renderKey: retired.renderKey, sequence: retired.sequence + 2,
    intent: { kind: "composition", phase: "end", text: "你好" },
  });
  h.session.recoverRetiredIntent({
    type: "composer-intent", sessionId: retired.sessionId, renderKey: retired.renderKey, sequence: retired.sequence + 3,
    intent: { kind: "composition", phase: "end", text: "你好" },
  });
  await settle();
  assert.equal(h.recovery.length, 1);
  assert.equal(h.recovery[0].id, id);
  assert.equal(h.recovery[0].text, "你好");
  assert.equal(h.document.text, "- A", "retired transport recovery has no edit authority");
  assert.equal(h.session.resolveRecovery(id, "你好"), true);
  h.session.acknowledgeDrained(retired.sessionId);
  assert.equal(h.session.recoverRetiredIntent({
    type: "composer-intent", sessionId: retired.sessionId, renderKey: retired.renderKey, sequence: retired.sequence + 4,
    intent: { kind: "replace", origin: "typing", text: "late" },
  }), false, "the authenticated drain acknowledgement retires transport proof");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  const old = h.session.state;
  const pause = h.session.pauseInput();
  await h.session.drainAccepted();
  h.session.acknowledgeDrained(old.sessionId);
  pause.dispose();
  await waitFor(() => h.session.state.status === "ready");
  assert.notEqual(h.session.state.sessionId, old.sessionId, "a resumed Sheet cannot be retired by the previous activation's delayed drain acknowledgement");
  assert.equal(h.session.selection.focus.offsetUtf16, 1);
  assert.equal(h.session.recoverRetiredIntent({
    type: "composer-intent", sessionId: old.sessionId, renderKey: old.renderKey, sequence: old.sequence + 1,
    intent: { kind: "replace", origin: "typing", text: "stale" },
  }), false);
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- one two", body: "one two" }]);
  const hit = h.ports.geometry.hitTest;
  h.ports.geometry.hitTest = async (point, uncertainty, identity, signal) => {
    const result = await hit(point, uncertainty, identity, signal);
    return { ...result, endpoint: { ...result.endpoint, affinity: "after" } };
  };
  h.send({ kind: "pointer", phase: "start", point: { pageIndex: 0, x: 0.03, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 2 });
  await h.idle();
  await h.session.runContextAction("copy");
  await h.idle();
  assert.equal(h.clipboard.at(-1), "one", "double-click at a glyph's trailing caret selects its word, not the following space");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "replace", origin: "typing", text: "x" });
  await h.respond([{ source: "- Ax", body: "Ax" }], 2);
  await h.publishSnapshot();
  await h.idle();
  h.session.closeTextGroup();
  h.history.undo();
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- A");
  assert.equal(h.session.selection.focus.offsetUtf16, 1, "source-initiated native undo restores the GUI semantic bookmark");
  h.send({ kind: "history", direction: "redo" });
  await waitFor(() => h.document.text === "- Ax");
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.session.selection.focus.offsetUtf16, 2, "GUI redo consumes the same native history after source undo");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "replace", origin: "typing", text: "x" });
  const pause = h.session.pauseInput();
  const controller = new AbortController();
  const leaving = h.session.prepareToLeave(controller.signal);
  controller.abort();
  await assert.rejects(leaving);
  pause.dispose();
  await waitFor(() => h.session.state.status === "ready");
  h.send({ kind: "composition", phase: "start", text: "" });
  h.send({ kind: "composition", phase: "update", text: "新输入" });
  await h.respond([{ source: "- Ax", body: "Ax" }], 2);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.session.isActive, true);
  assert.equal(h.session.hasUnsubmittedInput, true, "an aborted leave cannot later cancel IME in a resumed activation");
  assert.equal(h.session.recoveryText, "");
  assert.equal(h.document.text, "- Ax");
  h.runtime.dispose();
}

{
  // Baseline: a mapped hit whose complete range crosses an unmapped/opaque span
  // published blocked, clearing host selection and releasing iframe pointer capture.
  const h = await createTextHarness([{ source: "- abcdef", body: "abcdef" }]);
  const hit = h.ports.geometry.hitTest;
  const selection = h.ports.geometry.selection;
  h.ports.geometry.hitTest = async (point, uncertainty, identity, signal) => point.x === 0.04
    ? { status: "unavailable", reason: "unmapped" } : hit(point, uncertainty, identity, signal);
  h.ports.geometry.selection = async (candidate, identity, signal) => candidate.focus.offsetUtf16 === 5
    ? { status: "unavailable", reason: "unsupportedStructure" } : selection(candidate, identity, signal);
  const pointer = (phase, x) => h.send({ kind: "pointer", phase, point: { pageIndex: 0, x, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: phase !== "start", clickCount: 1 });
  pointer("start", 0.01);
  await h.idle();
  pointer("move", 0.03);
  await h.idle();
  const sessionId = h.session.state.sessionId;
  const proved = h.session.selection;
  pointer("move", 0.04);
  await h.idle();
  assert.deepEqual(h.session.selection, proved, "an unmapped margin retains the last proved directional range");
  assert.equal(h.session.state.status, "ready");
  pointer("move", 0.05);
  await h.idle();
  assert.deepEqual(h.session.selection, proved, "denied cross-barrier geometry is not a truncated new selection");
  assert.equal(h.session.state.clipboard, null, "an unproved drag range cannot authorize clipboard deletion");
  assert.equal(h.send({ kind: "replace", origin: "typing", text: "must-not-cross" }), false);
  assert.equal(h.requests.length, 0);
  pointer("move", 0.02);
  await h.idle();
  pointer("end", 0.02);
  await h.idle();
  assert.equal(h.session.state.sessionId, sessionId, "returning to text must not retire the pointer session");
  assert.deepEqual([h.session.selection.anchor.offsetUtf16, h.session.selection.focus.offsetUtf16], [1, 2]);
  assert.equal(h.session.state.clipboard.text, "b");
  assert.equal(h.document.text, "- abcdef");
  h.runtime.dispose();
}

{
  const body = "one 😀\ntwo e\u0301";
  const h = await createTextHarness([{ source: '- """\none 😀\ntwo e\u0301"""', body }]);
  for (const phase of ["start", "end"]) {
    h.send({ kind: "pointer", phase, point: { pageIndex: 0, x: 0.04, y: 0.1 },
      uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 3 });
    await h.idle();
  }
  assert.deepEqual([h.session.selection.anchor.offsetUtf16, h.session.selection.focus.offsetUtf16], [0, body.length],
    "triple-click selects the entire semantic body and pointerup must not collapse it");
  assert.equal(h.session.state.clipboard.text, body, "whole-body copy text is Rust-authorized plaintext, not fenced DSL");
  assert.equal(h.requests.length, 0);
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- abc", body: "abc" }]);
  h.send({ kind: "pointer", phase: "start", point: { pageIndex: 0, x: 0.01, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 3 });
  await h.idle();
  const payload = h.session.state.clipboard;
  assert.equal(payload.text, "abc");
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "clipboard", action: "cut", authorization: payload.authorization });
  await h.idle();
  assert.equal(h.requests.length, 0, "a late keyboard cut acknowledgement must not delete a new selection");
  assert.equal(h.clipboard.length, 0, "keyboard clipboard acknowledgement never starts async clipboard writes");
  h.send({ kind: "pointer", phase: "start", point: { pageIndex: 0, x: 0.01, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 3 });
  await h.idle();
  const current = h.session.state.clipboard;
  assert.notEqual(current.authorization, payload.authorization);
  h.send({ kind: "clipboard", action: "cut", authorization: current.authorization });
  await waitFor(() => h.requests.length === 1);
  assert.equal(h.requests[0].params.command.replacement, "");
  assert.deepEqual([h.requests[0].params.target.selection.anchor.offsetUtf16,
    h.requests[0].params.target.selection.focus.offsetUtf16], [0, 3]);
  await h.respond([{ source: "- ", body: "" }], 0);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- ");
  assert.equal(h.clipboard.length, 0, "confirmed synchronous clipboard writes must not be repeated asynchronously");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- abc", body: "abc" }]);
  h.send({ kind: "pointer", phase: "start", point: { pageIndex: 0, x: 0.01, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 3 });
  await h.idle();
  const payload = h.session.state.clipboard;
  const selected = h.session.selection;
  const choice = deferred();
  let opened;
  h.ports.showContextMenu = (request, signal) => {
    opened = { request, signal };
    return choice.promise;
  };
  h.send({ kind: "contextMenu", anchor: { screenX: 120, screenY: 240 } });
  await waitFor(() => !!opened);
  assert.deepEqual(h.session.selection, selected, "native right-click does not retarget or collapse the range");
  assert.deepEqual(opened.request.actions.filter((item) => item.enabled).map((item) => item.id),
    ["cut", "copy", "paste", "delete", "selectAll"]);
  h.external([{ source: "- xyz", body: "xyz" }]);
  assert.equal(opened.signal.aborted, true, "external source changes dismiss the native menu immediately");
  choice.resolve("delete");
  await h.idle();
  await h.publishSnapshot();
  await h.publishRender();
  assert.equal(h.session.selection, null, "equal old offsets and statement ranges do not rebind across external drift");
  h.send({ kind: "clipboard", action: "cut", authorization: payload.authorization });
  await h.idle();
  assert.equal(h.requests.length, 0, "a stale menu choice or clipboard token cannot revive old source authority");
  assert.equal(h.document.text, "- xyz");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- abc", body: "abc" }]);
  await h.session.enter(h.nodeRef(), 1);
  const choice = deferred();
  let opened;
  h.ports.showContextMenu = (_request, signal) => { opened = signal; return choice.promise; };
  h.send({ kind: "contextMenu", anchor: { screenX: 120, screenY: 240 } });
  await waitFor(() => !!opened);
  const identity = h.ports.currentGeometryIdentity();
  h.ports.currentGeometryIdentity = () => ({ ...identity, generation: identity.generation + 1, renderKey: "rerendered" });
  await h.session.refreshGeometry();
  assert.equal(opened.aborted, true, "a new committed renderer generation dismisses the old native menu");
  choice.resolve("paste");
  await h.idle();
  assert.equal(h.requests.length, 0);
  assert.equal(h.document.text, "- abc");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- abc", body: "abc" }]);
  await h.session.enter(h.nodeRef(), 1);
  const choice = deferred();
  let opened;
  h.ports.showContextMenu = (_request, signal) => { opened = signal; return choice.promise; };
  h.send({ kind: "contextMenu", anchor: { screenX: 120, screenY: 240 } });
  await waitFor(() => !!opened);
  h.send({ kind: "pointer", phase: "start", point: { pageIndex: 0, x: 0.02, y: 0.1 },
    uncertainty: { x: 0, y: 0 }, extend: false, clickCount: 1 });
  choice.resolve("delete");
  await h.idle();
  assert.equal(opened.aborted, true, "a newer physical selection cancels the previous menu before its choice can execute");
  assert.equal(h.session.selection.focus.offsetUtf16, 2);
  assert.equal(h.requests.length, 0);
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- abc\n", body: "abc" }, { source: "- def", body: "def" }]);
  await h.session.enter(h.nodeRef(), 1);
  await h.session.runContextAction("selectAll");
  assert.equal(h.session.state.clipboard.text, "abc\ndef");
  assert.deepEqual([h.session.selection.anchor.offsetUtf16, h.session.selection.focus.offsetUtf16], [0, 3]);
  h.ports.showContextMenu = async () => "copy";
  h.send({ kind: "contextMenu", anchor: { screenX: 100, screenY: 200 } });
  await h.idle();
  assert.equal(h.clipboard.at(-1), "abc\ndef", "native selection Copy uses the whole authorized directional range");
  h.clipboard.push('> @literal\n"""');
  const pasting = h.session.runContextAction("paste");
  await waitFor(() => h.requests.length === 1);
  assert.equal(h.requests[0].params.command.replacement, '> @literal\n"""', "native Paste forwards literal plaintext to Rust");
  h.requests[0].pending.resolve({ kind: "Rejected", reason: "candidateInvalid" });
  await pasting;
  await h.idle();
  assert.equal(h.document.text, "- abc\n- def", "rejected native paste leaves canonical source untouched");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- A", body: "A" }]);
  await h.session.enter(h.nodeRef(), 1);
  h.send({ kind: "replace", origin: "typing", text: "x" });
  h.send({ kind: "focus", backward: false });
  await waitFor(() => h.requests.length === 1);
  assert.deepEqual(h.focusChanges, [], "Tab focus navigation cannot overtake already admitted body input");
  await h.respond([{ source: "- Ax", body: "Ax" }], 2);
  await h.publishSnapshot();
  await h.idle();
  assert.deepEqual(h.focusChanges, [false]);
  assert.equal(h.document.text, "- Ax", "Tab changes visible focus without inserting whitespace or DSL");
  h.runtime.dispose();
}

{
  // Recorded Chrome failure: Home/Shift+End/Copy arrived before multi-line
  // geometry settled. Copy must join the FIFO rather than consume old plaintext.
  const body = "\n中\nnew\nline\n";
  const h = await createTextHarness([{ source: '- """\r\n\r\n中\r\nnew\r\nline\r\n"""\r\n', body }]);
  await h.session.enter(h.nodeRef(), 1);
  const move = h.ports.geometry.move;
  const gate = deferred();
  let extending = false;
  h.ports.geometry.move = async (...args) => {
    if (args[0] && args[1] === "right" && args[3]) {
      extending = true;
      await gate.promise;
    }
    return move(...args);
  };
  h.send({ kind: "move", direction: "left", granularity: "document", extend: false });
  h.send({ kind: "move", direction: "right", granularity: "document", extend: true });
  h.send({ kind: "clipboardRequest", action: "copy" });
  await waitFor(() => extending);
  assert.equal(h.session.state.clipboard, null);
  assert.deepEqual(h.clipboard, [], "pending Copy cannot write the previous collapsed selection");
  assert.equal(h.requests.length, 0);
  gate.resolve();
  await h.idle();
  assert.deepEqual(h.clipboard, [body], "ordered Copy writes the resulting Rust-authorized semantic LF text");
  assert.deepEqual([h.session.selection.anchor.offsetUtf16, h.session.selection.focus.offsetUtf16], [0, body.length]);
  assert.equal(h.document.text, '- """\r\n\r\n中\r\nnew\r\nline\r\n"""\r\n');
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- abc", body: "abc" }]);
  await h.session.enter(h.nodeRef(), 1);
  const move = h.ports.geometry.move;
  const gate = deferred();
  let extending = false;
  h.ports.geometry.move = async (...args) => {
    if (args[1] === "right") { extending = true; await gate.promise; }
    return move(...args);
  };
  h.failClipboard();
  h.send({ kind: "move", direction: "left", granularity: "document", extend: false });
  h.send({ kind: "move", direction: "right", granularity: "document", extend: true });
  h.send({ kind: "clipboardRequest", action: "cut" });
  await waitFor(() => extending);
  assert.equal(h.requests.length, 0);
  gate.resolve();
  await h.idle();
  assert.equal(h.document.text, "- abc");
  assert.equal(h.requests.length, 0, "a failed native write after delayed movement must not authorize Cut deletion");
  assert.deepEqual(h.clipboard, []);
  assert.equal(h.notifications.at(-1)[0], "warning", "clipboard permission failure remains visible");
  h.failClipboard(false);
  h.send({ kind: "clipboardRequest", action: "cut" });
  await waitFor(() => h.requests.length === 1);
  assert.deepEqual(h.clipboard, ["abc"]);
  assert.deepEqual([h.requests[0].params.target.selection.anchor.offsetUtf16,
    h.requests[0].params.target.selection.focus.offsetUtf16], [0, 3]);
  await h.respond([{ source: "- ", body: "" }], 0);
  await h.publishSnapshot();
  await h.idle();
  assert.equal(h.document.text, "- ");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- abc", body: "abc" }]);
  await h.session.enter(h.nodeRef(), 1);
  await h.session.runContextAction("selectAll");
  const permission = deferred();
  const writes = [];
  h.ports.writeClipboard = async (text) => { writes.push(text); await permission.promise; };
  h.send({ kind: "clipboardRequest", action: "cut" });
  await waitFor(() => writes.length === 1);
  h.send({ kind: "clipboardRequest", action: "copy" });
  const old = h.ports.currentGeometryIdentity();
  h.ports.currentGeometryIdentity = () => ({ ...old, generation: old.generation + 1, renderKey: "external-render" });
  permission.resolve();
  await h.idle();
  assert.equal(h.requests.length, 0, "Cut must revalidate its exact renderer authorization after native write acknowledgement");
  assert.deepEqual(writes, ["abc"], "the queued Copy request cannot rebind to a newer renderer generation");
  assert.equal(h.document.text, "- abc");
  h.runtime.dispose();
}

{
  const h = await createTextHarness([{ source: "- abc", body: "abc" }]);
  await h.session.enter(h.nodeRef(), 1);
  const move = h.ports.geometry.move;
  const gate = deferred();
  let extending = false;
  h.ports.geometry.move = async (...args) => {
    if (args[1] === "right") { extending = true; await gate.promise; }
    return args[6].aborted ? { status: "unavailable", reason: "aborted" } : move(...args);
  };
  h.send({ kind: "move", direction: "left", granularity: "document", extend: false });
  h.send({ kind: "move", direction: "right", granularity: "document", extend: true });
  h.send({ kind: "clipboardRequest", action: "cut" });
  await waitFor(() => extending);
  h.external([{ source: "- elsewhere", body: "elsewhere" }]);
  gate.resolve();
  await h.idle();
  assert.deepEqual(h.clipboard, [], "source invalidation retires a pending clipboard request before any write");
  assert.equal(h.requests.length, 0);
  assert.equal(h.session.selection, null);
  assert.equal(h.document.text, "- elsewhere");
  h.runtime.dispose();
}

console.log("composer runtime contracts passed");
