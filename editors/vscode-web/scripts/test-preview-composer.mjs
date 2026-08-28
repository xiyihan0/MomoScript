import assert from "node:assert/strict";
import {
  PreviewComposerController,
  createPreviewComposerApplyPort,
  isTextContentChangeEvent,
} from "../src/previewComposer.ts";

assert.equal(isTextContentChangeEvent({ contentChanges: [] }), false, "metadata-only document events are not source advances");
assert.equal(isTextContentChangeEvent({ contentChanges: [{}] }), true, "text changes advance Composer source identity");


class FakeContextMenuSession {
  closed = 0;

  constructor(anchor, items) {
    this.anchor = anchor;
    this.items = items;
    const { promise, resolve } = Promise.withResolvers();
    this.result = promise;
    this.resolve = resolve;
    this.settled = false;
  }

  select(label) {
    const selected = findMenuItem(this.items, label);
    assert.ok(selected, `missing context-menu item: ${label}`);
    assert.ok(selected.selection, `context-menu item is not selectable: ${label}`);
    this.finish(selected.selection);
  }

  close() {
    this.closed += 1;
    this.finish(undefined);
  }

  finish(selection) {
    if (this.settled) return;
    this.settled = true;
    this.resolve(selection);
  }
}

function findMenuItem(items, label) {
  for (const item of items) {
    if (item.label === label) return item;
    const nested = item.children && findMenuItem(item.children, label);
    if (nested) return nested;
  }
  return undefined;
}

class FakeContextInputSession {
  closed = 0;
  validationMessage = undefined;

  constructor(anchor, options) {
    this.anchor = anchor;
    this.options = options;
    const { promise, resolve } = Promise.withResolvers();
    this.result = promise;
    this.resolve = resolve;
    this.settled = false;
  }

  submit(value) {
    if (value.length === 0) {
      this.validationMessage = this.options.requiredMessage;
      return;
    }
    this.finish(value);
  }

  close() {
    this.closed += 1;
    this.finish(undefined);
  }

  finish(value) {
    if (this.settled) return;
    this.settled = true;
    this.resolve(value);
  }
}

class FakeAvatarPickerSession {
  closed = 0;

  constructor(anchor, options) {
    this.anchor = anchor;
    this.options = options;
    const { promise, resolve, reject } = Promise.withResolvers();
    this.result = promise;
    this.resolve = resolve;
    this.reject = reject;
    this.settled = false;
  }

  async choose(choice) {
    try {
      await this.options.choose(choice);
      this.finish();
    } catch (error) {
      if (this.settled) return;
      this.settled = true;
      this.reject(error);
    }
  }

  close() {
    this.closed += 1;
    this.finish();
  }

  finish() {
    if (this.settled) return;
    this.settled = true;
    this.resolve();
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
const anchor = { screenX: 800, screenY: 500 };
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
const editableTarget = ({
  actor = true,
  avatar = false,
  message = true,
  messageMode = "inherit",
  resolvedMode = "textMacro",
  inheritedMode = "textMacro",
  continued = "false",
} = {}) => ({
  kind: "Editable",
  textDocument,
  target: { kind: "statement", range: statementRange },
  properties: {
    ...(continued == null ? {} : { continued }),
    ...(message ? { statementText: {
      current: "当前正文😀",
      mode: messageMode,
      resolvedMode,
      inheritedMode,
    } } : {}),
    ...(actor ? { actorDisplayName: { current: "佳代子", scope: "fromStatement" } } : {}),
    ...(avatar ? { actorAvatar: {
      scope: "fromStatement",
      actorPresetId: "ba::佳代子",
      current: {
        kind: "packAvatar",
        entityId: "ba::佳代子",
        contributionNamespace: "ba",
        variantId: "default",
      },
    } } : {}),
  },
});
const protocolEdit = {
  documentChanges: [{
    textDocument,
    edits: [{ range: statementRange, newText: "server replacement" }],
  }],
};

function avatarItem(entityId, entityDisplayName, contributionNamespace, variantId, selectable = true) {
  return {
    variant: {
      entityId,
      entityDisplayName,
      contributionNamespace,
      variantId,
      handles: [],
      storageKey: "avatars",
      path: `${variantId}.png`,
      isEntityDefault: variantId === "default" && contributionNamespace === entityId.split("::")[0],
      isSourceDefault: variantId === "default",
    },
    ...(selectable ? { thumbnailUrl: `https://packs.example/${variantId}.png` } : {}),
    selectable,
    searchTerms: [entityId, entityDisplayName, contributionNamespace, variantId],
  };
}

function harness(options = {}) {
  const state = {
    acceptingWork: true,
    identity: identity(),
    document: { ...textDocument },
    bidirectionalNavigation: options.bidirectionalNavigation ?? true,
  };
  const contextMenus = [];
  const contextInputs = [];
  const cancellationSources = [];
  const avatarPickers = [];
  const avatarCatalogListeners = new Set();
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
    contextMenu: {
      open(menuAnchor, items) {
        const session = new FakeContextMenuSession(menuAnchor, items);
        contextMenus.push(session);
        return session;
      },
    },
    contextInput: {
      open(inputAnchor, inputOptions) {
        const session = new FakeContextInputSession(inputAnchor, inputOptions);
        contextInputs.push(session);
        return session;
      },
    },
    avatarPicker: {
      open(pickerAnchor, pickerOptions) {
        const session = new FakeAvatarPickerSession(pickerAnchor, pickerOptions);
        avatarPickers.push(session);
        return session;
      },
    },
    getAvatarCatalog: () => options.avatarCatalog ?? [],
    onDidChangeAvatarCatalog(listener) {
      avatarCatalogListeners.add(listener);
      return { dispose: () => avatarCatalogListeners.delete(listener) };
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
    contextMenus,
    contextInputs,
    cancellationSources,
    locateCalls,
    avatarPickers,
    requestCalls,
    applyCalls,
    navigationCalls,
    warnings,
    errors,
    setTargetResult(value) { targetResult = value; },
    setEditResult(value) { editResult = value; },
    setApplicationResult(value) { applicationResult = value; },
    fireAvatarCatalogChanged() {
      for (const listener of avatarCatalogListeners) listener();
    },
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
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "context menu was not shown");
  fixture.contextMenus[0].select(label);
  await operation;
}

{
  const fixture = harness();
  await chooseContinued(fixture);
  const [menu] = fixture.contextMenus;
  assert.deepEqual(menu.anchor, anchor);
  assert.deepEqual(menu.items.map((item) => item.label), [
    "编辑连续消息状态…",
    "编辑消息…",
    "解析模式",
    "从本条起修改人物显示名…",
    "转到源码",
  ]);
  const continued = menu.items[0].children;
  assert.deepEqual(continued.map((item) => item.label), ["自动", "强制连续", "强制新消息"]);
  assert.equal(continued.find((item) => item.label === "强制新消息").checked, true);
  assert.equal(continued.filter((item) => item.checked).length, 1);
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
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "display-name context menu was not shown");
  fixture.contextMenus[0].select("从本条起修改人物显示名…");
  await waitFor(() => fixture.contextInputs.length === 1, "display-name context input was not shown");
  const input = fixture.contextInputs[0];
  assert.equal(input.options.title, "从本条起修改人物显示名");
  assert.equal(input.options.value, "佳代子");
  assert.deepEqual(input.anchor, anchor);
  input.submit("");
  assert.equal(input.validationMessage, "显示名不能为空。");
  assert.equal(input.settled, false, "an empty value must keep the context input open");
  input.submit(" 老师 ");
  await operation;
  assert.deepEqual(fixture.requestCalls[1].params.command, {
    kind: "setActorDisplayNameFromStatement",
    value: " 老师 ",
  }, "display-name input must not be trimmed or normalized");
}

{
  const fixture = harness({ bidirectionalNavigation: false });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "message context menu was not shown");
  fixture.contextMenus[0].select("编辑消息…");
  await waitFor(() => fixture.contextInputs.length === 1, "message context input was not shown");
  const input = fixture.contextInputs[0];
  assert.equal(input.options.title, "编辑消息");
  assert.equal(input.options.placeholder, "输入新的消息正文");
  assert.equal(input.options.value, "当前正文😀");
  assert.deepEqual(input.anchor, anchor);
  input.submit("新正文😀 \"quoted\" \\\\path");
  await operation;
  assert.deepEqual(fixture.requestCalls[1].params.command, {
    kind: "setStatementText",
    value: "新正文😀 \"quoted\" \\\\path",
  }, "message text must remain structured and unnormalized");
  assert.equal(fixture.requestCalls.length, 2);
  assert.equal(fixture.applyCalls.length, 1);
}

{
  const fixture = harness({
    bidirectionalNavigation: false,
    targetOptions: { actor: false, message: true, continued: null },
  });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "narration context menu was not shown");
  assert.deepEqual(
    fixture.contextMenus[0].items.map((item) => item.label),
    ["编辑消息…", "解析模式"],
    "narration must expose text editing and local parse mode without actor actions",
  );
  fixture.contextMenus[0].select("编辑消息…");
  await waitFor(() => fixture.contextInputs.length === 1, "narration context input was not shown");
  fixture.contextInputs[0].submit("新的旁白正文");
  await operation;
  assert.deepEqual(fixture.requestCalls[1].params.command, {
    kind: "setStatementText",
    value: "新的旁白正文",
  });
  assert.equal(fixture.applyCalls.length, 1);
}

{
  const fixture = harness({ bidirectionalNavigation: false });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "message mode menu was not shown");
  const modeMenu = fixture.contextMenus[0].items.find((item) => item.label === "解析模式");
  assert.deepEqual(
    modeMenu.children.map(({ label, checked }) => ({ label, checked })),
    [
      { label: "继承（当前：文本宏 t）", checked: true },
      { label: "文本宏（t）", checked: false },
      { label: "原始文本（rt）", checked: false },
      { label: "Typst（T）", checked: false },
      { label: "原始 Typst（rT）", checked: false },
    ],
  );
  fixture.contextMenus[0].select("Typst（T）");
  await operation;
  assert.deepEqual(fixture.requestCalls[1].params.command, {
    kind: "setStatementTextMode",
    value: "typstMacro",
  });
  assert.equal(fixture.applyCalls.length, 1);
}

{
  const fixture = harness({
    bidirectionalNavigation: false,
    targetOptions: {
      actor: false,
      continued: null,
      messageMode: "textMacro",
      resolvedMode: "textMacro",
      inheritedMode: "typstMacro",
    },
  });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "Typst-inherited mode menu was not shown");
  const modeMenu = fixture.contextMenus[0].items.find((item) => item.label === "解析模式");
  assert.equal(modeMenu.children[0].label, "继承（当前：Typst T）");
  assert.equal(modeMenu.children[0].enabled, undefined);
  assert.equal(modeMenu.children[1].checked, true);
  fixture.contextMenus[0].select("继承（当前：Typst T）");
  await operation;
  assert.deepEqual(fixture.requestCalls[1].params.command, {
    kind: "setStatementTextMode",
    value: "inherit",
  });
  assert.equal(fixture.applyCalls.length, 1);
}

{
  const fixture = harness({ bidirectionalNavigation: false });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "current mode menu was not shown");
  fixture.contextMenus[0].select("继承（当前：文本宏 t）");
  await operation;
  assert.equal(fixture.requestCalls.length, 1, "selecting the current local mode must be a no-op");
  assert.equal(fixture.applyCalls.length, 0);
}

for (const finishInput of [
  (session) => session.close(),
  (session) => session.submit("当前正文😀"),
]) {
  const fixture = harness();
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "message no-op menu was not shown");
  fixture.contextMenus[0].select("编辑消息…");
  await waitFor(() => fixture.contextInputs.length === 1, "message no-op input was not shown");
  finishInput(fixture.contextInputs[0]);
  await operation;
  assert.equal(fixture.requestCalls.length, 1, "cancelled or unchanged text must not request an edit");
  assert.equal(fixture.applyCalls.length, 0, "cancelled or unchanged text must not apply");
}

{
  const fixture = harness({ targetOptions: { message: false } });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "capability-filtered menu was not shown");
  assert.equal(
    fixture.contextMenus[0].items.some((item) => item.label === "编辑消息…"),
    false,
  );
  fixture.contextMenus[0].close();
  await operation;
}

{
  const currentAvatar = avatarItem("ba::佳代子", "佳代子", "ba", "default");
  const alternateAvatar = avatarItem("ba::佳代子", "佳代子", "ba", "smile");
  const crossAvatar = avatarItem("ba::小雪", "小雪", "ba", "default");
  const unavailableAvatar = avatarItem("ba::佳代子", "佳代子", "event", "sequence", false);
  const avatarCatalog = [currentAvatar, alternateAvatar, crossAvatar, unavailableAvatar];
  const fixture = harness({
    targetOptions: { avatar: true },
    avatarCatalog,
  });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "avatar context menu was not shown");
  assert.deepEqual(fixture.contextMenus[0].items.map((item) => item.label), [
    "编辑连续消息状态…",
    "编辑消息…",
    "解析模式",
    "从本条起修改人物显示名…",
    "从本条起更换人物头像…",
    "转到源码",
  ]);
  fixture.contextMenus[0].select("从本条起更换人物头像…");
  await waitFor(() => fixture.avatarPickers.length === 1, "avatar picker was not shown");
  const picker = fixture.avatarPickers[0];
  assert.deepEqual(picker.anchor, anchor);
  assert.equal(picker.options.actorPresetId, "ba::佳代子");
  assert.equal(picker.options.actorLabel, "佳代子");
  assert.deepEqual(picker.options.current, {
    kind: "packAvatar",
    entityId: "ba::佳代子",
    contributionNamespace: "ba",
    variantId: "default",
  });
  assert.deepEqual(picker.options.items, avatarCatalog);
  await picker.choose({
    kind: "packAvatar",
    entityId: "ba::小雪",
    contributionNamespace: "ba",
    variantId: "default",
  });
  await operation;
  assert.deepEqual(fixture.requestCalls[1].params.command, {
    kind: "setActorAvatarFromStatement",
    avatar: {
      kind: "packAvatar",
      entityId: "ba::小雪",
      contributionNamespace: "ba",
      variantId: "default",
    },
  });
  assert.equal(fixture.requestCalls.length, 2);
  assert.equal(fixture.applyCalls.length, 1);
}

{
  const currentAvatar = avatarItem("ba::佳代子", "佳代子", "ba", "default");
  const unavailableAvatar = avatarItem("ba::佳代子", "佳代子", "event", "sequence", false);
  const fixture = harness({
    bidirectionalNavigation: false,
    targetOptions: { avatar: true },
    avatarCatalog: [currentAvatar, unavailableAvatar],
  });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "avatar omission menu was not shown");
  assert.deepEqual(fixture.contextMenus[0].items.map((item) => item.label), [
    "编辑连续消息状态…",
    "编辑消息…",
    "解析模式",
    "从本条起修改人物显示名…",
  ]);
  fixture.contextMenus[0].close();
  await operation;
  assert.equal(fixture.avatarPickers.length, 0);
}

{
  const fixture = harness({
    targetOptions: { avatar: true },
    avatarCatalog: [
      avatarItem("ba::佳代子", "佳代子", "ba", "default"),
      avatarItem("ba::佳代子", "佳代子", "ba", "smile"),
    ],
    editResult: { kind: "Rejected", reason: "avatarUnavailable" },
  });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "unavailable avatar menu was not shown");
  fixture.contextMenus[0].select("从本条起更换人物头像…");
  await waitFor(() => fixture.avatarPickers.length === 1, "unavailable avatar picker was not shown");
  await fixture.avatarPickers[0].choose({
    kind: "packAvatar",
    entityId: "ba::佳代子",
    contributionNamespace: "ba",
    variantId: "smile",
  });
  await operation;
  assert.deepEqual(fixture.warnings, ["所选头像已不可用，未应用编辑。"]);
  assert.equal(fixture.requestCalls.length, 2, "an unavailable avatar must not retry");
  assert.equal(fixture.applyCalls.length, 0);
}

{
  const fixture = harness({
    targetOptions: { avatar: true },
    avatarCatalog: [
      avatarItem("ba::佳代子", "佳代子", "ba", "default"),
      avatarItem("ba::佳代子", "佳代子", "ba", "smile"),
    ],
  });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "Pack invalidation menu was not shown");
  fixture.contextMenus[0].select("从本条起更换人物头像…");
  await waitFor(() => fixture.avatarPickers.length === 1, "Pack invalidation picker was not shown");
  fixture.fireAvatarCatalogChanged();
  await operation;
  assert.equal(fixture.avatarPickers[0].closed, 1);
  assert.equal(fixture.cancellationSources[0].cancelled, 1);
  assert.equal(fixture.requestCalls.length, 1, "Pack invalidation must not request or retry an edit");
}

{
  const fixture = harness({
    bidirectionalNavigation: false,
    targetOptions: { actor: false, message: false },
  });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "actor-omission context menu was not shown");
  assert.deepEqual(fixture.contextMenus[0].items.map((item) => item.label), ["编辑连续消息状态…"]);
  fixture.contextMenus[0].close();
  await operation;
  assert.equal(fixture.requestCalls.length, 1);
  assert.equal(fixture.applyCalls.length, 0);
}

{
  const fixture = harness();
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "navigation context menu was not shown");
  fixture.contextMenus[0].select("转到源码");
  await operation;
  assert.deepEqual(fixture.navigationCalls.map((call) => call.point), [point]);
  assert.equal(fixture.requestCalls.length, 1, "source navigation must not request a Composer edit");
}

{
  const fixture = harness({ targetResult: { kind: "Unavailable", reason: "unsupportedNode" } });
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "navigation-only context menu was not shown");
  assert.deepEqual(fixture.contextMenus[0].items.map((item) => item.label), ["转到源码"]);
  fixture.contextMenus[0].select("转到源码");
  await operation;
  assert.deepEqual(fixture.navigationCalls.map((call) => call.point), [point]);
  assert.deepEqual(fixture.warnings, []);
  assert.equal(fixture.applyCalls.length, 0);
}

{
  const fixture = harness({ targetResult: { kind: "Unavailable", reason: "unmapped" } });
  await fixture.controller.handleContextPoint(point, anchor);
  assert.deepEqual(fixture.warnings, ["无法编辑此预览内容。"]);
  assert.equal(fixture.contextMenus.length, 0);
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
  const first = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "first context menu was not shown");
  const firstMenu = fixture.contextMenus[0];
  const firstSource = fixture.cancellationSources[0];
  const second = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 2, "replacement context menu was not shown");
  assert.equal(fixture.locateCalls[0].signal.aborted, true);
  assert.equal(firstSource.cancelled, 1);
  assert.equal(firstSource.disposed, 1);
  assert.equal(firstMenu.closed, 1);
  fixture.controller.invalidate();
  assert.equal(fixture.cancellationSources[1].cancelled, 1);
  assert.equal(fixture.cancellationSources[1].disposed, 1);
  assert.equal(fixture.contextMenus[1].closed, 1);
  await Promise.all([first, second]);
  assert.deepEqual(fixture.warnings, [], "replacement and explicit invalidation are silent cancellation");
}
{
  const fixture = harness();
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "display-name context menu was not shown");
  fixture.contextMenus[0].select("从本条起修改人物显示名…");
  await waitFor(() => fixture.contextInputs.length === 1, "display-name context input was not shown");
  fixture.controller.invalidate();
  await operation;
  assert.equal(fixture.contextInputs[0].closed, 1);
  assert.equal(fixture.cancellationSources[0].cancelled, 1);
  assert.equal(fixture.cancellationSources[0].disposed, 1);
}
{
  const fixture = harness();
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "message stale context menu was not shown");
  fixture.contextMenus[0].select("编辑消息…");
  await waitFor(() => fixture.contextInputs.length === 1, "message stale input was not shown");
  fixture.state.document = { uri: sourceUri, version: textDocument.version + 1 };
  fixture.controller.sourceDocumentChanged(fixture.state.document);
  await operation;
  assert.equal(fixture.contextInputs[0].closed, 1);
  assert.deepEqual(fixture.warnings, ["源码已更改，未应用编辑。"]);
  assert.equal(fixture.requestCalls.length, 1, "stale message input must not request an edit");
  assert.equal(fixture.applyCalls.length, 0);
}



{
  const fixture = harness();
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "stale invalidation context menu was not shown");
  fixture.state.document = { uri: sourceUri, version: textDocument.version + 1 };
  fixture.controller.sourceDocumentChanged(fixture.state.document);
  await operation;
  assert.equal(fixture.contextMenus[0].closed, 1);
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
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, `${drift} drift context menu was not shown`);
  if (drift === "identity") fixture.state.identity = identity(8);
  else fixture.state.document = { uri: sourceUri, version: 8 };
  fixture.contextMenus[0].select("强制连续");
  await operation;
  assert.deepEqual(fixture.warnings, ["源码已更改，未应用编辑。"]);
  assert.equal(fixture.contextMenus.length, 1, `${drift} drift must not open another control`);
  assert.equal(fixture.requestCalls.length, 1, `${drift} drift must not request an edit`);
}

{
  const fixture = harness();
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.contextMenus.length === 1, "quiesce context menu was not shown");
  fixture.state.acceptingWork = false;
  fixture.contextMenus[0].select("强制连续");
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
  const operation = fixture.controller.handleContextPoint(point, anchor);
  await waitFor(() => fixture.locateCalls.length === 1, "pending location request was not captured");
  fixture.controller.dispose();
  assert.equal(fixture.locateCalls[0].signal.aborted, true);
  assert.equal(fixture.cancellationSources[0].cancelled, 1);
  assert.equal(fixture.cancellationSources[0].disposed, 1);
  releaseLocation({ identity: identity(), location: rendererLocation });
  await operation;
  await fixture.controller.handleContextPoint(point, anchor);
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
