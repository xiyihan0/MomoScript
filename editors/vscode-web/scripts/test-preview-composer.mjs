import assert from "node:assert/strict";
import {
  PreviewComposerController,
  createPreviewComposerApplyPort,
} from "../src/previewComposer.ts";

class ListenerSet {
  listeners = new Set();

  subscribe(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fire(value) {
    for (const listener of [...this.listeners]) listener(value);
  }
}

class FakeQuickPick {
  title = undefined;
  placeholder = undefined;
  items = [];
  selectedItems = [];
  activeItems = [];
  shown = 0;
  hidden = 0;
  disposed = 0;
  accepts = new ListenerSet();
  hides = new ListenerSet();

  onDidAccept(listener) { return this.accepts.subscribe(listener); }
  onDidHide(listener) { return this.hides.subscribe(listener); }
  show() { this.shown += 1; }
  hide() { this.hidden += 1; this.hides.fire(); }
  dispose() { this.disposed += 1; }

  accept(label) {
    const selected = this.items.find((item) => item.label === label);
    assert.ok(selected, `missing Quick Pick item: ${label}`);
    this.selectedItems = [selected];
    this.accepts.fire();
  }

  dismiss() {
    this.hides.fire();
  }
}

class FakeInputBox {
  title = undefined;
  prompt = undefined;
  value = "";
  validationMessage = undefined;
  shown = 0;
  hidden = 0;
  disposed = 0;
  accepts = new ListenerSet();
  hides = new ListenerSet();
  changes = new ListenerSet();

  onDidAccept(listener) { return this.accepts.subscribe(listener); }
  onDidHide(listener) { return this.hides.subscribe(listener); }
  onDidChangeValue(listener) { return this.changes.subscribe(listener); }
  show() { this.shown += 1; }
  hide() { this.hidden += 1; this.hides.fire(); }
  dispose() { this.disposed += 1; }
  accept() { this.accepts.fire(); }

  setValue(value) {
    this.value = value;
    this.changes.fire(value);
  }
}

class FakeCancellationTokenSource {
  cancelled = 0;
  disposed = 0;

  constructor() {
    const owner = this;
    this.token = {
      get isCancellationRequested() { return owner.cancelled > 0; },
    };
  }

  cancel() { this.cancelled += 1; }
  dispose() { this.disposed += 1; }
}

const sourceUri = "mmtfs://workspace/story.mmt";
const identity = (version = 7, overrides = {}) => ({
  workspaceId: "workspace-a",
  sourceUri,
  sourceContent: `source-${version}`,
  sourceStaleToken: {
    hostUri: sourceUri,
    documentIncarnation: "document-a",
    documentVersion: version,
  },
  projectDigest: `project-${version}`,
  projectionKey: `projection-${version}`,
  revision: version,
  entryUri: "mmt-projection:story/main.typ",
  languageId: "mmt",
  backendEncoding: "utf-8",
  ...overrides,
});
const point = { page: 0, x: 0.35, y: 0.6 };
const rendererLocation = {
  uri: "mmt-projection:story/main.typ",
  range: {
    start: { line: 8, character: 2 },
    end: { line: 8, character: 9 },
  },
};
const statementRange = {
  start: { line: 4, character: 0 },
  end: { line: 4, character: 18 },
};
const textDocument = { uri: sourceUri, version: 7 };
const editableTarget = ({ actor = true, continued = "false" } = {}) => ({
  kind: "Editable",
  textDocument,
  target: { kind: "statement", range: statementRange },
  properties: {
    continued,
    ...(actor ? { actorDisplayName: { current: "佳代子", scope: "fromStatement" } } : {}),
  },
});
const protocolEdit = {
  documentChanges: [{
    textDocument,
    edits: [{ range: statementRange, newText: "server replacement" }],
  }],
};

function harness(options = {}) {
  const state = {
    acceptingWork: true,
    identity: identity(),
    document: { ...textDocument },
    bidirectionalNavigation: options.bidirectionalNavigation ?? true,
  };
  const quickPicks = [];
  const inputBoxes = [];
  const cancellationSources = [];
  const locateCalls = [];
  const requestCalls = [];
  const applyCalls = [];
  const navigationCalls = [];
  const warnings = [];
  const errors = [];
  let targetResult = options.targetResult ?? editableTarget(options.targetOptions);
  let editResult = options.editResult ?? { kind: "Edit", edit: protocolEdit };
  let applicationResult = options.applicationResult ?? { kind: "Applied" };

  const ports = {
    async locatePreviewPoint(requestPoint, signal) {
      locateCalls.push({ point: requestPoint, signal });
      if (options.locatePreviewPoint) return options.locatePreviewPoint(requestPoint, signal);
      return { identity: structuredClone(state.identity), location: structuredClone(rendererLocation) };
    },
    async request(method, params, token) {
      requestCalls.push({ method, params: structuredClone(params), token });
      if (options.request) return options.request(method, params, token);
      return structuredClone(method === "mmt/previewComposerTarget" ? targetResult : editResult);
    },
    createCancellationTokenSource() {
      const source = new FakeCancellationTokenSource();
      cancellationSources.push(source);
      return source;
    },
    createQuickPick() {
      const quickPick = new FakeQuickPick();
      quickPicks.push(quickPick);
      return quickPick;
    },
    createInputBox() {
      const input = new FakeInputBox();
      inputBoxes.push(input);
      return input;
    },
    apply: options.apply ?? {
      async apply(applyOptions) {
        applyCalls.push(applyOptions);
        if (!applyOptions.canApply()) return { kind: "Stale" };
        return applicationResult;
      },
    },
    acceptingWork: () => state.acceptingWork,
    currentIdentity: () => state.identity,
    currentDocument: (uri) => state.document?.uri === uri ? state.document : undefined,
    bidirectionalNavigation: () => state.bidirectionalNavigation,
    async navigatePreviewPoint(requestPoint, signal) {
      navigationCalls.push({ point: requestPoint, signal });
    },
    showWarningMessage(message) { warnings.push(message); },
    showErrorMessage(message) { errors.push(message); },
  };
  const controller = new PreviewComposerController(ports);
  return {
    controller,
    state,
    ports,
    quickPicks,
    inputBoxes,
    cancellationSources,
    locateCalls,
    requestCalls,
    applyCalls,
    navigationCalls,
    warnings,
    errors,
    setTargetResult(value) { targetResult = value; },
    setEditResult(value) { editResult = value; },
    setApplicationResult(value) { applicationResult = value; },
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail(message);
}

async function chooseContinued(fixture, label = "强制连续") {
  const operation = fixture.controller.handleContextPoint(point);
  await waitFor(() => fixture.quickPicks.length === 1, "root Quick Pick was not shown");
  fixture.quickPicks[0].accept("编辑连续消息状态…");
  await waitFor(() => fixture.quickPicks.length === 2, "continued Quick Pick was not shown");
  fixture.quickPicks[1].accept(label);
  await operation;
}

{
  const fixture = harness();
  await chooseContinued(fixture);
  const [root, continued] = fixture.quickPicks;
  assert.deepEqual(root.items.map((item) => item.label), [
    "编辑连续消息状态…",
    "从本条起修改人物显示名…",
    "转到源码",
  ]);
  assert.equal(root.title, "编辑预览内容");
  assert.deepEqual(continued.items.map((item) => item.label), ["自动", "强制连续", "强制新消息"]);
  assert.equal(continued.items.find((item) => item.label === "强制新消息").description, "当前");
  assert.equal(continued.items.find((item) => item.label === "强制新消息").picked, true);
  assert.equal(continued.activeItems[0].label, "强制新消息");
  assert.deepEqual(fixture.requestCalls[0].params, {
    sourceUri,
    revision: 7,
    sourceContent: "source-7",
    projectDigest: "project-7",
    projectionKey: "projection-7",
    entryUri: "mmt-projection:story/main.typ",
    backendEncoding: "utf-8",
    location: rendererLocation,
  });
  assert.deepEqual(fixture.requestCalls[1], {
    method: "mmt/composerEdit",
    params: {
      textDocument,
      target: { kind: "statement", range: statementRange },
      command: { kind: "setStatementContinued", value: "true" },
    },
    token: fixture.requestCalls[1].token,
  });
  assert.equal(fixture.applyCalls.length, 1);
  assert.equal(fixture.applyCalls[0].canApply(), false, "a completed operation must not retain apply authority");
  assert.equal(fixture.cancellationSources[0].cancelled, 0);
  assert.equal(fixture.cancellationSources[0].disposed, 1);
}

{
  const fixture = harness({ bidirectionalNavigation: false });
  const operation = fixture.controller.handleContextPoint(point);
  await waitFor(() => fixture.quickPicks.length === 1, "display-name root Quick Pick was not shown");
  fixture.quickPicks[0].accept("从本条起修改人物显示名…");
  await waitFor(() => fixture.inputBoxes.length === 1, "display-name Input Box was not shown");
  const input = fixture.inputBoxes[0];
  assert.equal(input.title, "从本条起修改人物显示名");
  assert.equal(input.value, "佳代子");
  input.setValue("");
  input.accept();
  assert.equal(input.validationMessage, "显示名不能为空。");
  assert.equal(input.disposed, 0, "an empty value must keep the Input Box open");
  input.setValue(" 老师 ");
  input.accept();
  await operation;
  assert.deepEqual(fixture.requestCalls[1].params.command, {
    kind: "setActorDisplayNameFromStatement",
    value: " 老师 ",
  }, "display-name input must not be trimmed or normalized");
}

{
  const fixture = harness({ bidirectionalNavigation: false, targetOptions: { actor: false } });
  const operation = fixture.controller.handleContextPoint(point);
  await waitFor(() => fixture.quickPicks.length === 1, "actor-omission root Quick Pick was not shown");
  assert.deepEqual(fixture.quickPicks[0].items.map((item) => item.label), ["编辑连续消息状态…"]);
  fixture.quickPicks[0].dismiss();
  await operation;
  assert.equal(fixture.requestCalls.length, 1);
  assert.equal(fixture.applyCalls.length, 0);
}

{
  const fixture = harness();
  const operation = fixture.controller.handleContextPoint(point);
  await waitFor(() => fixture.quickPicks.length === 1, "navigation root Quick Pick was not shown");
  fixture.quickPicks[0].accept("转到源码");
  await operation;
  assert.deepEqual(fixture.navigationCalls.map((call) => call.point), [point]);
  assert.equal(fixture.requestCalls.length, 1, "source navigation must not request a Composer edit");
}

{
  const fixture = harness({ targetResult: { kind: "Unavailable", reason: "unsupportedNode" } });
  await fixture.controller.handleContextPoint(point);
  assert.deepEqual(fixture.warnings, ["无法编辑此预览内容。"]);
  assert.equal(fixture.quickPicks.length, 0);
  assert.equal(fixture.applyCalls.length, 0);
}

{
  const fixture = harness({ editResult: { kind: "Rejected", reason: "candidateInvalid" } });
  await chooseContinued(fixture);
  assert.deepEqual(fixture.warnings, ["无法应用此预览编辑。"]);
  assert.equal(fixture.applyCalls.length, 0);
  assert.deepEqual(fixture.requestCalls.map((call) => call.method), [
    "mmt/previewComposerTarget",
    "mmt/composerEdit",
  ], "a rejected edit must never retry");
}

for (const [applicationResult, expectedWarnings, expectedErrors] of [
  [{ kind: "Stale" }, ["源码已更改，未应用编辑。"], []],
  [{ kind: "ApplyFailed" }, [], ["无法应用预览编辑。"]],
]) {
  const fixture = harness({ applicationResult });
  await chooseContinued(fixture);
  assert.deepEqual(fixture.warnings, expectedWarnings);
  assert.deepEqual(fixture.errors, expectedErrors);
  assert.equal(fixture.requestCalls.length, 2, "an application failure must never retry either request");
  assert.equal(fixture.applyCalls.length, 1);
}

{
  const fixture = harness();
  const first = fixture.controller.handleContextPoint(point);
  await waitFor(() => fixture.quickPicks.length === 1, "first root Quick Pick was not shown");
  const firstQuickPick = fixture.quickPicks[0];
  const firstSource = fixture.cancellationSources[0];
  const second = fixture.controller.handleContextPoint(point);
  await waitFor(() => fixture.quickPicks.length === 2, "replacement root Quick Pick was not shown");
  assert.equal(fixture.locateCalls[0].signal.aborted, true);
  assert.equal(firstSource.cancelled, 1);
  assert.equal(firstSource.disposed, 1);
  assert.equal(firstQuickPick.hidden, 1);
  assert.equal(firstQuickPick.disposed, 1);
  fixture.controller.invalidate();
  assert.equal(fixture.cancellationSources[1].cancelled, 1);
  assert.equal(fixture.cancellationSources[1].disposed, 1);
  assert.equal(fixture.quickPicks[1].disposed, 1);
  await Promise.all([first, second]);
  assert.deepEqual(fixture.warnings, [], "replacement and explicit invalidation are silent cancellation");
}

{
  const fixture = harness();
  const operation = fixture.controller.handleContextPoint(point);
  await waitFor(() => fixture.quickPicks.length === 1, "stale invalidation root Quick Pick was not shown");
  fixture.state.document = { uri: sourceUri, version: textDocument.version + 1 };
  fixture.controller.sourceDocumentChanged(fixture.state.document);
  await operation;
  assert.equal(fixture.quickPicks[0].disposed, 1);
  assert.deepEqual(fixture.warnings, ["源码已更改，未应用编辑。"]);
  assert.equal(fixture.requestCalls.length, 1, "stale invalidation must not retry");
}

{
  let fixture;
  let applyCalls = 0;
  fixture = harness({
    apply: {
      async apply(options) {
        applyCalls += 1;
        assert.equal(options.canApply(), true);
        fixture.state.document = {
          uri: sourceUri,
          version: options.textDocument.version + 1,
        };
        fixture.controller.sourceDocumentChanged(fixture.state.document);
        return { kind: "Applied" };
      },
    },
  });
  await chooseContinued(fixture);
  assert.equal(applyCalls, 1);
  assert.deepEqual(fixture.warnings, [], "the accepted WorkspaceEdit advance is not stale");
}

for (const drift of ["identity", "document"]) {
  const fixture = harness();
  const operation = fixture.controller.handleContextPoint(point);
  await waitFor(() => fixture.quickPicks.length === 1, `${drift} drift root Quick Pick was not shown`);
  if (drift === "identity") fixture.state.identity = identity(8);
  else fixture.state.document = { uri: sourceUri, version: 8 };
  fixture.quickPicks[0].accept("编辑连续消息状态…");
  await operation;
  assert.deepEqual(fixture.warnings, ["源码已更改，未应用编辑。"]);
  assert.equal(fixture.quickPicks.length, 1, `${drift} drift must not open another control`);
  assert.equal(fixture.requestCalls.length, 1, `${drift} drift must not request an edit`);
}

{
  const fixture = harness();
  const operation = fixture.controller.handleContextPoint(point);
  await waitFor(() => fixture.quickPicks.length === 1, "quiesce root Quick Pick was not shown");
  fixture.state.acceptingWork = false;
  fixture.quickPicks[0].accept("编辑连续消息状态…");
  await operation;
  assert.equal(fixture.requestCalls.length, 1);
  assert.equal(fixture.applyCalls.length, 0, "quiescing runtime must not create or apply an edit");
  assert.deepEqual(fixture.warnings, [], "quiesce is cancellation, not a stale document warning");
}

for (const drift of ["runtime", "identity", "document"]) {
  let fixture;
  let workspaceApplyCalls = 0;
  const boundaryApply = createPreviewComposerApplyPort({
    client: {
      protocol2CodeConverter: {
        async asWorkspaceEdit() {
          if (drift === "runtime") fixture.state.acceptingWork = false;
          else if (drift === "identity") fixture.state.identity = identity(8);
          else fixture.state.document = { uri: sourceUri, version: 8 };
          return { converted: true };
        },
      },
    },
    workspace: {
      get textDocuments() {
        return fixture.state.document
          ? [{
              uri: { toString: () => fixture.state.document.uri },
              version: fixture.state.document.version,
            }]
          : [];
      },
      async applyEdit() {
        workspaceApplyCalls += 1;
        return true;
      },
    },
  });
  fixture = harness({ apply: boundaryApply });
  await chooseContinued(fixture);
  assert.equal(
    workspaceApplyCalls,
    0,
    `the boundary adapter must reject ${drift} drift immediately before applyEdit`,
  );
  assert.deepEqual(fixture.warnings, ["源码已更改，未应用编辑。"]);
}

{
  let releaseLocation;
  const { promise: locationPromise, resolve } = Promise.withResolvers();
  releaseLocation = resolve;
  const fixture = harness({ locatePreviewPoint: () => locationPromise });
  const operation = fixture.controller.handleContextPoint(point);
  await waitFor(() => fixture.locateCalls.length === 1, "pending location request was not captured");
  fixture.controller.dispose();
  assert.equal(fixture.locateCalls[0].signal.aborted, true);
  assert.equal(fixture.cancellationSources[0].cancelled, 1);
  assert.equal(fixture.cancellationSources[0].disposed, 1);
  releaseLocation({ identity: identity(), location: rendererLocation });
  await operation;
  await fixture.controller.handleContextPoint(point);
  assert.equal(fixture.locateCalls.length, 1, "a disposed controller must reject new context operations");
}

console.log(JSON.stringify({
  rootAndContinuedFlow: true,
  exactDisplayNameFlow: true,
  actorAndNavigationGates: true,
  unavailableRejectedAndApplicationNotifications: true,
  cancellationDisposesEveryResource: true,
  identityDocumentAndQuiesceGuards: true,
  boundaryFinalApplyGuard: true,
  noRetry: true,
}));
