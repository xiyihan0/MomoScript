import assert from "node:assert/strict";
import {
  applyComposerEdit,
  applyComposerTextEdit,
  getComposerNativeHistory,
  parseComposerAvatarChoice,
  parseComposerEditResult,
  parseComposerTextEditParams,
  parseComposerTextEndpoint,
  parseComposerTextProjectionParams,
  parseComposerTextProjectionResult,
  parseComposerTextSelection,
  parseComposerTextSelectionParams,
  parseComposerTextSelectionResult,
  parsePreviewComposerTargetResult,
} from "../src/composerEdit.ts";
import { composerDocumentSourceDigest } from "../src/composerDocument.ts";

const textDocument = { uri: "mmtfs://workspace/story.mmt", version: 7 };
const range = {
  start: { line: 4, character: 2 },
  end: { line: 4, character: 18 },
};
const statementText = {
  current: "当前正文😀",
  mode: "inherit",
  resolvedMode: "textMacro",
  inheritedMode: "textMacro",
};
const editableTarget = {
  kind: "Editable",
  textDocument,
  target: { kind: "statement", range },
  properties: {
    continued: "false",
    actorDisplayName: { current: "佳代子", scope: "fromStatement" },
    actorAvatar: {
      scope: "fromStatement",
      actorPresetId: "ba::佳代子",
      current: {
        kind: "packAvatar",
        entityId: "ba::佳代子",
        contributionNamespace: "ba",
        variantId: "default",
      },
    },
    statementText,
  },
};
const protocolEdit = {
  documentChanges: [{
    textDocument,
    edits: [{ range, newText: "server replacement" }],
  }],
};

assert.deepEqual(parsePreviewComposerTargetResult(structuredClone(editableTarget)), editableTarget);
assert.deepEqual(parsePreviewComposerTargetResult({
  ...editableTarget,
  properties: { continued: "auto" },
}), {
  ...editableTarget,
  properties: { continued: "auto" },
});
assert.deepEqual(parsePreviewComposerTargetResult({
  ...editableTarget,
  properties: { statementText: { ...statementText, current: "旁白正文" } },
}), {
  ...editableTarget,
  properties: { statementText: { ...statementText, current: "旁白正文" } },
});
assert.deepEqual(parsePreviewComposerTargetResult({
  ...editableTarget,
  properties: {
    statementText: {
      current: "#strong[Typst]",
      mode: "typstMacro",
      resolvedMode: "typstMacro",
      inheritedMode: "textMacro",
    },
  },
}).properties.statementText, {
  current: "#strong[Typst]",
  mode: "typstMacro",
  resolvedMode: "typstMacro",
  inheritedMode: "textMacro",
});
assert.deepEqual(parsePreviewComposerTargetResult({
  ...editableTarget,
  properties: {
    continued: "auto",
    actorAvatar: {
      scope: "fromStatement",
      actorPresetId: "ba::佳代子",
      current: { kind: "asset", assetName: "portrait" },
    },
  },
}).properties.actorAvatar.current, { kind: "asset", assetName: "portrait" });
assert.equal(parsePreviewComposerTargetResult({
  ...editableTarget,
  properties: {
    continued: "auto",
    actorAvatar: {
      scope: "fromStatement",
      actorPresetId: "ba::佳代子",
      current: null,
    },
  },
}).properties.actorAvatar.current, null);
assert.deepEqual(parseComposerAvatarChoice({
  kind: "packAvatar",
  entityId: "ba::佳代子",
  contributionNamespace: "ba",
  variantId: "default",
}), {
  kind: "packAvatar",
  entityId: "ba::佳代子",
  contributionNamespace: "ba",
  variantId: "default",
});
for (const reason of [
  "stalePreview",
  "nonMmtSource",
  "unmapped",
  "ambiguousOrigin",
  "unsupportedNode",
  "documentHasErrors",
  "actorUnavailable",
]) {
  assert.deepEqual(parsePreviewComposerTargetResult({ kind: "Unavailable", reason }), { kind: "Unavailable", reason });
}

for (const malformed of [
  null,
  { kind: "Unknown" },
  { ...editableTarget, extra: true },
  { ...editableTarget, textDocument: { ...textDocument, extra: true } },
  { ...editableTarget, textDocument: { ...textDocument, uri: 42 } },
  { ...editableTarget, textDocument: { ...textDocument, version: 7.5 } },
  { ...editableTarget, textDocument: { ...textDocument, version: -1 } },
  { ...editableTarget, target: { ...editableTarget.target, extra: true } },
  { ...editableTarget, target: { ...editableTarget.target, kind: "actor" } },
  {
    ...editableTarget,
    target: {
      kind: "statement",
      range: { ...range, start: { line: -1, character: 0 } },
    },
  },
  {
    ...editableTarget,
    target: {
      kind: "statement",
      range: { ...range, start: { ...range.start, character: 2.5 } },
    },
  },
  {
    ...editableTarget,
    target: {
      kind: "statement",
      range: { ...range, start: { ...range.start, extra: true } },
    },
  },
  {
    ...editableTarget,
    target: {
      kind: "statement",
      range: { start: range.end, end: range.start },
    },
  },
  {
    ...editableTarget,
    target: {
      kind: "statement",
      range: { ...range, extra: true },
    },
  },
  { ...editableTarget, properties: { continued: true } },
  { ...editableTarget, properties: { continued: "auto", extra: true } },
  { ...editableTarget, properties: { continued: "auto", actorDisplayName: undefined } },
  { ...editableTarget, properties: { continued: "auto", actorDisplayName: { current: "name" } } },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      actorDisplayName: { current: "name", scope: "fromStatement", extra: true },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      actorDisplayName: { current: 1, scope: "fromStatement" },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      actorDisplayName: { current: "name", scope: "oneStatement" },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      statementText: undefined,
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      statementText: { ...statementText, current: "" },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      statementText: { ...statementText, current: "line one\nline two" },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      statementText: { ...statementText, current: "x".repeat((64 * 1024) + 1) },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      statementText: { ...statementText, current: "正文", sourceRange: range },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      statementText: { ...statementText, mode: "unknown" },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      statementText: { ...statementText, resolvedMode: "unknown" },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      statementText: {
        current: "正文",
        mode: "inherit",
        resolvedMode: "textMacro",
      },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      statementText: {
        ...statementText,
        inheritedMode: "textRaw",
      },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      statementText: {
        ...statementText,
        mode: "textRaw",
      },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      actorAvatar: {
        scope: "fromStatement",
        actorPresetId: "佳代子",
        current: null,
      },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      actorAvatar: {
        scope: "fromStatement",
        actorPresetId: "ba::佳代子",
        current: {
          kind: "packAvatar",
          entityId: "ba::佳代子",
          contributionNamespace: "ba",
          variantId: "default",
          path: "unsafe.png",
        },
      },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      actorAvatar: {
        scope: "fromStatement",
        actorPresetId: "ba::佳代子",
        current: { kind: "asset", assetName: "portrait", storage: "unsafe" },
      },
    },
  },
  {
    ...editableTarget,
    properties: {
      continued: "auto",
      actorAvatar: {
        scope: "fromStatement",
        actorPresetId: "ba::佳代子",
        current: {
          kind: "packAvatar",
          entityId: "ba::佳代子/unsafe",
          contributionNamespace: "ba",
          variantId: "default",
        },
      },
    },
  },
  { kind: "Unavailable", reason: "nearbyStatement" },
  { kind: "Unavailable", reason: "unmapped", extra: true },
]) {
  assert.throws(() => parsePreviewComposerTargetResult(malformed), TypeError);
}

const parsedEdit = parseComposerEditResult({ kind: "Edit", edit: protocolEdit }, textDocument);
assert.deepEqual(parsedEdit, { kind: "Edit", edit: protocolEdit });
for (const reason of [
  "staleDocument",
  "targetChanged",
  "documentHasErrors",
  "invalidValue",
  "actorUnavailable",
  "candidateInvalid",
  "avatarUnavailable",
  "unsupportedStructure",
  "speakerUnavailable",
]) {
  assert.deepEqual(parseComposerEditResult({ kind: "Rejected", reason }, textDocument), { kind: "Rejected", reason });
}

const textDocumentEdit = protocolEdit.documentChanges[0];
for (const malformed of [
  null,
  { kind: "Unknown" },
  { kind: "Rejected", reason: "stalePreview" },
  { kind: "Rejected", reason: "staleDocument", extra: true },
  { kind: "Edit", edit: protocolEdit, extra: true },
  { kind: "Edit", edit: { changes: { [textDocument.uri]: textDocumentEdit.edits } } },
  { kind: "Edit", edit: { documentChanges: protocolEdit.documentChanges, changes: {} } },
  { kind: "Edit", edit: { documentChanges: protocolEdit.documentChanges, changeAnnotations: {} } },
  { kind: "Edit", edit: { documentChanges: protocolEdit.documentChanges, changes: undefined } },
  { kind: "Edit", edit: { documentChanges: protocolEdit.documentChanges, extra: true } },
  { kind: "Edit", edit: { documentChanges: [] } },
  { kind: "Edit", edit: { documentChanges: [textDocumentEdit, textDocumentEdit] } },
  { kind: "Edit", edit: { documentChanges: [{ kind: "create", uri: textDocument.uri }] } },
  { kind: "Edit", edit: { documentChanges: [{ kind: "rename", oldUri: textDocument.uri, newUri: "mmtfs://workspace/other.mmt" }] } },
  { kind: "Edit", edit: { documentChanges: [{ kind: "delete", uri: textDocument.uri }] } },
  {
    kind: "Edit",
    edit: { documentChanges: [{ ...textDocumentEdit, textDocument: { uri: textDocument.uri } }] },
  },
  {
    kind: "Edit",
    edit: { documentChanges: [{ ...textDocumentEdit, textDocument: { ...textDocument, version: null } }] },
  },
  { kind: "Edit", edit: { documentChanges: null } },
  {
    kind: "Edit",
    edit: { documentChanges: [{ ...textDocumentEdit, textDocument: { ...textDocument, version: 7.5 } }] },
  },
  {
    kind: "Edit",
    edit: { documentChanges: [{ ...textDocumentEdit, textDocument: { ...textDocument, uri: "mmtfs://workspace/other.mmt" } }] },
  },
  {
    kind: "Edit",
    edit: { documentChanges: [{ ...textDocumentEdit, textDocument: { ...textDocument, uri: 42 } }] },
  },
  {
    kind: "Edit",
    edit: { documentChanges: [{ ...textDocumentEdit, textDocument: { ...textDocument, version: 8 } }] },
  },
  {
    kind: "Edit",
    edit: { documentChanges: [{ ...textDocumentEdit, textDocument: { ...textDocument, extra: true } }] },
  },
  { kind: "Edit", edit: { documentChanges: [{ ...textDocumentEdit, extra: true }] } },
  { kind: "Edit", edit: { documentChanges: [{ ...textDocumentEdit, edits: null }] } },
  {
    kind: "Edit",
    edit: {
      documentChanges: [{
        ...textDocumentEdit,
        edits: [{ ...textDocumentEdit.edits[0], annotationId: "unsafe" }],
      }],
    },
  },
  {
    kind: "Edit",
    edit: {
      documentChanges: [{
        ...textDocumentEdit,
        edits: [{ ...textDocumentEdit.edits[0], newText: 1 }],
      }],
    },
  },
  {
    kind: "Edit",
    edit: {
      documentChanges: [{
        ...textDocumentEdit,
        edits: [{ ...textDocumentEdit.edits[0], range: { ...range, end: { line: 1, character: 0 } } }],
      }],
    },
  },
]) {
  assert.throws(() => parseComposerEditResult(malformed, textDocument), TypeError);
}
assert.throws(
  () => parseComposerEditResult({ kind: "Edit", edit: protocolEdit }, { ...textDocument, extra: true }),
  TypeError,
);
for (const malformedChoice of [
  null,
  { kind: "packAvatar", entityId: "佳代子", contributionNamespace: "ba", variantId: "default" },
  { kind: "packAvatar", entityId: "ba::佳代子", contributionNamespace: "ba::ext", variantId: "default" },
  { kind: "packAvatar", entityId: "ba::佳代子", contributionNamespace: "ba", variantId: "bad/value" },
  { kind: "packAvatar", entityId: "ba::佳代子", contributionNamespace: "ba", variantId: "bad value" },
  {
    kind: "packAvatar",
    entityId: "ba::佳代子",
    contributionNamespace: "ba",
    variantId: "x".repeat(1025),
  },
  {
    kind: "packAvatar",
    entityId: "ba::佳代子",
    contributionNamespace: "ba",
    variantId: "default",
    url: "https://example.com/avatar.png",
  },
]) {
  assert.throws(() => parseComposerAvatarChoice(malformedChoice), TypeError);
}

function applicationFixture({
  documentUri = textDocument.uri,
  documentVersion = textDocument.version,
  applyResult = true,
  signal = { aborted: false },
  converterError = false,
  applyError = false,
  afterConvert,
} = {}) {
  const state = { source: "original" };
  const converted = { converted: true };
  const client = {
    protocol2CodeConverter: {
      async asWorkspaceEdit() {
        if (converterError) throw new Error("conversion failed");
        afterConvert?.();
        return converted;
      },
    },
  };
  const workspace = {
    get textDocuments() {
      return [{ uri: { toString: () => documentUri }, version: documentVersion }];
    },
    async applyEdit() {
      if (applyError) throw new Error("apply failed");
      if (applyResult) state.source = "changed";
      return applyResult;
    },
  };
  return {
    state,
    options: { client, workspace, result: parsedEdit, textDocument, signal },
  };
}

{
  const fixture = applicationFixture();
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "Applied" });
  assert.equal(fixture.state.source, "changed");
}
{
  const fixture = applicationFixture({ documentVersion: textDocument.version + 1 });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "Stale" });
  assert.equal(fixture.state.source, "original");
}
{
  const fixture = applicationFixture({ documentUri: "mmtfs://workspace/other.mmt" });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "Stale" });
  assert.equal(fixture.state.source, "original");
}
{
  const fixture = applicationFixture({ applyResult: false });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "ApplyFailed" });
  assert.equal(fixture.state.source, "original");
}
{
  const fixture = applicationFixture({ signal: { aborted: true } });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "Cancelled" });
  assert.equal(fixture.state.source, "original");
}
{
  const signal = { aborted: false };
  const fixture = applicationFixture({ signal, afterConvert: () => { signal.aborted = true; } });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "Cancelled" });
  assert.equal(fixture.state.source, "original");
}
{
  const fixture = applicationFixture({ converterError: true });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "ApplyFailed" });
  assert.equal(fixture.state.source, "original");
}
{
  const fixture = applicationFixture({ applyError: true });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "ApplyFailed" });
  assert.equal(fixture.state.source, "original");
}

const pointRange = (character, line = 0) => ({
  start: { line, character },
  end: { line, character },
});
const bodyNode = (text, line, nodeKey = String(line + 1).repeat(64)) => ({
  kind: "narration",
  nodeKey,
  range: { start: { line, character: 0 }, end: { line: line + 1, character: 0 } },
  statementRange: { start: { line, character: 0 }, end: { line, character: text.length + 2 } },
  body: { current: text, mode: "inherit", resolvedMode: "textMacro", inheritedMode: "textMacro" },
  textEditing: { text },
  capabilities: { setBody: false, delete: true, moveUp: null, moveDown: null },
});
const endpoint = (node, offsetUtf16) => ({
  node: { nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range },
  offsetUtf16,
});
const selectionSource = "- A😀é中\n- 第二条\n";
const selectionSnapshot = {
  kind: "Snapshot",
  textDocument,
  sourceDigest: await composerDocumentSourceDigest(selectionSource),
  nodes: [bodyNode("A😀é中", 0), bodyNode("第二条", 1)],
  boundaries: [],
  scriptActorChoices: [],
};
const unicodeNode = selectionSnapshot.nodes[0];
const unicodeEndpoint = endpoint(unicodeNode, 3);
assert.equal(parseComposerTextEndpoint(unicodeEndpoint, selectionSnapshot).offsetUtf16, 3);
for (const offsetUtf16 of [2, 4, 7, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
  assert.throws(() => parseComposerTextEndpoint(endpoint(unicodeNode, offsetUtf16), selectionSnapshot));
}
for (const bad of [
  { ...unicodeEndpoint, extra: true },
  { ...unicodeEndpoint, node: { ...unicodeEndpoint.node, extra: true } },
  { ...unicodeEndpoint, node: { ...unicodeEndpoint.node, nodeKey: "a".repeat(64) } },
  { ...unicodeEndpoint, node: { ...unicodeEndpoint.node, nodeKind: "opaque" } },
]) {
  assert.throws(() => parseComposerTextEndpoint(bad, selectionSnapshot));
}
const emptyTextNode = bodyNode("", 0, "e".repeat(64));
assert.equal(parseComposerTextEndpoint(endpoint(emptyTextNode, 0), {
  ...selectionSnapshot, nodes: [emptyTextNode],
}).offsetUtf16, 0);
const crossSelection = {
  anchor: endpoint(unicodeNode, 3),
  focus: endpoint(selectionSnapshot.nodes[1], 2),
};
const selectionWire = {
  kind: "Selection",
  textDocument,
  sourceDigest: selectionSnapshot.sourceDigest,
  selection: crossSelection,
  text: "é中\n第二",
};
const selectionIdentity = { textDocument, sourceDigest: selectionSnapshot.sourceDigest };
assert.equal(parseComposerTextSelectionResult(selectionWire, selectionIdentity, selectionSnapshot).text, "é中\n第二");
assert.equal(parseComposerTextSelectionResult({
  ...selectionWire,
  selection: { anchor: crossSelection.focus, focus: crossSelection.anchor },
}, selectionIdentity, selectionSnapshot).text, "é中\n第二");
for (const bad of [
  { ...selectionWire, text: "e中\n第二" },
  { ...selectionWire, text: "é中\r\n第二" },
  { ...selectionWire, sourceDigest: "a".repeat(64) },
  { ...selectionWire, textDocument: { ...textDocument, version: 8 } },
  { ...selectionWire, textDocument: { ...textDocument, uri: "mmtfs://workspace/other.mmt" } },
  { ...selectionWire, extra: true },
  { ...selectionWire, selection: { ...crossSelection, extra: true } },
]) {
  assert.throws(() => parseComposerTextSelectionResult(bad, selectionIdentity, selectionSnapshot));
}
const blankNode = {
  kind: "opaque",
  nodeKey: "c".repeat(64),
  range: { start: { line: 1, character: 0 }, end: { line: 2, character: 0 } },
  category: "blank",
};
const afterBlankNode = bodyNode("第二条", 2);
const blankSelection = { anchor: crossSelection.anchor, focus: endpoint(afterBlankNode, 2) };
const withBlank = { ...selectionSnapshot, nodes: [unicodeNode, blankNode, afterBlankNode] };
assert.equal(parseComposerTextSelectionResult({
  ...selectionWire, selection: blankSelection,
}, selectionIdentity, withBlank).text, selectionWire.text);
for (const nodes of [
  [unicodeNode, { ...blankNode, category: "directive" }, afterBlankNode],
  [unicodeNode, blankNode, { ...afterBlankNode, body: { ...afterBlankNode.body, resolvedMode: "textRaw" } }],
  [unicodeNode, blankNode, { ...afterBlankNode, textEditing: null }],
]) {
  assert.throws(() => parseComposerTextSelection(blankSelection, { ...selectionSnapshot, nodes }));
}
const selectionParams = { ...selectionIdentity, anchor: pointRange(5), focus: pointRange(4, 1) };
assert.equal(parseComposerTextSelectionParams(selectionParams).anchor.start.character, 5);
assert.throws(() => parseComposerTextSelectionParams({ ...selectionParams, anchor: range }));
assert.throws(() => parseComposerTextSelectionParams({
  ...selectionParams, textDocument: { ...textDocument, uri: "relative/path.mmt" },
}));
assert.throws(() => parseComposerTextSelectionParams({ ...selectionParams, extra: true }));
const textParams = {
  ...selectionIdentity,
  target: { kind: "textSelection", selection: crossSelection },
  command: { kind: "replaceTextSelection", replacement: "first\r\n> @不是语法 \"\"\"" },
};
assert.equal(parseComposerTextEditParams(textParams, selectionSnapshot).command.replacement, textParams.command.replacement);
for (const bad of [
  { ...textParams, sourceDigest: "f".repeat(64) },
  { ...textParams, command: { ...textParams.command, extra: true } },
  { ...textParams, command: { kind: "setStatementBody", replacement: "text" } },
  { ...textParams, command: { ...textParams.command, replacement: "\udc00" } },
  { ...textParams, command: { ...textParams.command, replacement: "x".repeat(65537) } },
]) {
  assert.throws(() => parseComposerTextEditParams(bad, selectionSnapshot));
}

const projectionParams = {
  sourceUri: textDocument.uri,
  revision: 4,
  sourceContent: "a".repeat(64),
  projectDigest: "b".repeat(64),
  projectionKey: "c".repeat(64),
  entryUri: "file:///generated/main.typ",
  backendEncoding: "utf-16",
  selection: crossSelection,
};
const projectionLocation = (range) => ({ uri: projectionParams.entryUri, range });
const projectionWire = {
  kind: "Mapped",
  anchor: projectionLocation(pointRange(17)),
  focus: projectionLocation(pointRange(24, 1)),
  segments: [projectionLocation(range)],
};
assert.equal(parseComposerTextProjectionParams(projectionParams, selectionSnapshot).revision, 4);
assert.equal(parseComposerTextProjectionResult(projectionWire, projectionParams.entryUri).anchor.range.start.character, 17);
assert.throws(() => parseComposerTextProjectionParams({ ...projectionParams, location: projectionLocation(range) }));
assert.throws(() => parseComposerTextProjectionParams({ ...projectionParams, backendEncoding: "unknown" }));
for (const bad of [
  { ...projectionWire, extra: true },
  { ...projectionWire, anchor: { ...projectionWire.anchor, kind: "location" } },
  { ...projectionWire, anchor: projectionLocation(range) },
  { ...projectionWire, focus: { ...projectionWire.focus, uri: textDocument.uri } },
  { ...projectionWire, segments: [{ ...projectionWire.segments[0], extra: true }] },
]) {
  assert.throws(() => parseComposerTextProjectionResult(bad, projectionParams.entryUri));
}

const nativeSource = "- abc\n- def\n";
const nativeAfter = "- aXf\n";
const nativeDigest = await composerDocumentSourceDigest(nativeSource);
const nativePostEndpoint = {
  statementRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
  offsetUtf16: 2,
};
const nativeTextEdit = {
  kind: "TextEdit",
  edit: {
    documentChanges: [{
      textDocument,
      edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: nativeAfter }],
    }],
  },
  sourceDigestAfter: await composerDocumentSourceDigest(nativeAfter),
  selectionAfter: { anchor: nativePostEndpoint, focus: nativePostEndpoint },
};
assert.equal(parseComposerEditResult(nativeTextEdit, textDocument, "TextEdit").selectionAfter.focus.offsetUtf16, 2);
assert.throws(() => parseComposerEditResult(nativeTextEdit, textDocument));
assert.throws(() => parseComposerEditResult({ kind: "Edit", edit: protocolEdit }, textDocument, "TextEdit"));
for (const bad of [
  { ...nativeTextEdit, extra: true },
  { ...nativeTextEdit, sourceDigestAfter: "A".repeat(64) },
  { ...nativeTextEdit, selectionAfter: { anchor: nativePostEndpoint, focus: { ...nativePostEndpoint, offsetUtf16: 3 } } },
  { ...nativeTextEdit, selectionAfter: { ...nativeTextEdit.selectionAfter, nodeKey: "a".repeat(64) } },
]) {
  assert.throws(() => parseComposerEditResult(bad, textDocument, "TextEdit"));
}

function nativeApplicationFixture({
  source = nativeSource,
  sourceDigest = nativeDigest,
  result = nativeTextEdit,
  beforeSelection = { anchor: { line: 0, character: 3 }, focus: { line: 1, character: 4 } },
  trimAutoWhitespace = true,
  pendingAutoWhitespace = false,
} = {}) {
  const state = {
    source,
    documentVersion: 7,
    modelVersion: 11,
    alternativeVersion: 11,
    trimAutoWhitespace,
    pendingAutoWhitespace,
  };
  const uri = { toString: () => textDocument.uri };
  const model = {
    uri,
    isDisposed: () => false,
    getVersionId: () => state.modelVersion,
    getAlternativeVersionId: () => state.alternativeVersion,
    getValue: () => state.source,
    getOptions: () => ({ trimAutoWhitespace: state.trimAutoWhitespace }),
    updateOptions(options) {
      if (typeof options.trimAutoWhitespace === "boolean") {
        state.trimAutoWhitespace = options.trimAutoWhitespace;
      }
    },
    pushStackElement() {},
    pushEditOperations(_before, edits, cursorStateComputer) {
      const offsetAt = (line, column) => state.source.split("\n").slice(0, line - 1)
        .reduce((offset, value) => offset + value.length + 1, column - 1);
      for (const edit of [...edits].reverse()) {
        const start = offsetAt(edit.range.startLineNumber, edit.range.startColumn);
        const end = offsetAt(edit.range.endLineNumber, edit.range.endColumn);
        state.source = state.source.slice(0, start) + edit.text + state.source.slice(end);
      }
      if (state.pendingAutoWhitespace && state.trimAutoWhitespace) {
        state.source = state.source.replace("  \n", "\n");
      }
      state.modelVersion += 1;
      state.documentVersion += 1;
      state.alternativeVersion += 1;
      return cursorStateComputer([]);
    },
  };
  const document = {
    uri,
    get version() { return state.documentVersion; },
    getText: () => state.source,
  };
  const modelService = { getModel: () => model };
  return {
    state,
    model,
    options: {
      modelService,
      document,
      textDocument,
      sourceDigest,
      modelVersion: 11,
      result,
      beforeSelection,
      canApply: () => true,
    },
  };
}
{
  const fixture = nativeApplicationFixture();
  fixture.options.canApply = (candidate) => candidate === nativeAfter;
  assert.equal((await applyComposerTextEdit(fixture.options)).kind, "Applied");
  assert.equal(fixture.state.source, nativeAfter, "the existing source model receives the Rust edit, not body serialization");
  assert.equal(fixture.state.documentVersion, 8);
  assert.equal(fixture.state.trimAutoWhitespace, true);
}
{
  const source = "- abc\n  \n- def\n";
  const candidate = "- aXc\n  \n- def\n";
  const endpoint = {
    statementRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
    offsetUtf16: 2,
  };
  const result = {
    kind: "TextEdit",
    edit: {
      documentChanges: [{
        textDocument,
        edits: [{ range: { start: { line: 0, character: 3 }, end: { line: 0, character: 4 } }, newText: "X" }],
      }],
    },
    sourceDigestAfter: await composerDocumentSourceDigest(candidate),
    selectionAfter: { anchor: endpoint, focus: endpoint },
  };
  const fixture = nativeApplicationFixture({
    source,
    sourceDigest: await composerDocumentSourceDigest(source),
    result,
    beforeSelection: { anchor: { line: 0, character: 3 }, focus: { line: 0, character: 3 } },
    pendingAutoWhitespace: true,
  });
  assert.equal((await applyComposerTextEdit(fixture.options)).kind, "Applied");
  assert.equal(fixture.state.source, candidate, "pending auto-indent outside the authorized edit is not trimmed");
  assert.equal(fixture.state.trimAutoWhitespace, true, "the prior model option is restored");
}
{
  const fixture = nativeApplicationFixture();
  fixture.model.pushEditOperations = () => {
    throw new Error("synthetic native apply failure");
  };
  assert.equal((await applyComposerTextEdit(fixture.options)).kind, "ApplyFailed");
  assert.equal(fixture.state.source, nativeSource);
  assert.equal(fixture.state.trimAutoWhitespace, true, "the prior model option is restored when native apply throws");
}
for (const invalidate of [
  (fixture) => { fixture.options.sourceDigest = "f".repeat(64); },
  (fixture) => { fixture.state.documentVersion += 1; },
  (fixture) => { fixture.state.modelVersion += 1; },
  (fixture) => { fixture.options.modelService.getModel = () => null; },
  (fixture) => { fixture.model.getValue = () => "- different model contents\n"; },
]) {
  const fixture = nativeApplicationFixture();
  invalidate(fixture);
  assert.equal((await applyComposerTextEdit(fixture.options)).kind, "Stale");
  assert.equal(fixture.state.source, nativeSource);
}
{
  const fixture = nativeApplicationFixture();
  fixture.options.canApply = () => false;
  assert.equal((await applyComposerTextEdit(fixture.options)).kind, "Cancelled");
  assert.equal(fixture.state.source, nativeSource);
}
{
  const fixture = nativeApplicationFixture();
  fixture.options.canApply = () => { fixture.state.modelVersion += 1; return true; };
  assert.equal((await applyComposerTextEdit(fixture.options)).kind, "Stale");
  assert.equal(fixture.state.source, nativeSource);
}
{
  const fixture = nativeApplicationFixture();
  let gateCalls = 0;
  fixture.options.result = { ...nativeTextEdit, sourceDigestAfter: nativeDigest };
  fixture.options.canApply = () => {
    gateCalls += 1;
    return true;
  };
  assert.equal((await applyComposerTextEdit(fixture.options)).kind, "ApplyFailed");
  assert.equal(gateCalls, 0, "the permission gate never sees a candidate whose digest proof failed");
  assert.equal(fixture.state.source, nativeSource);
}
{
  const fixture = nativeApplicationFixture();
  fixture.options.result = { kind: "Edit", edit: nativeTextEdit.edit };
  assert.equal((await applyComposerTextEdit(fixture.options)).kind, "ApplyFailed");
  assert.equal(fixture.state.source, nativeSource);
}
{
  const fixture = nativeApplicationFixture();
  const applying = applyComposerTextEdit(fixture.options);
  fixture.state.modelVersion += 1;
  assert.equal((await applying).kind, "Stale");
  assert.equal(fixture.state.source, nativeSource);
}
{
  const fixture = nativeApplicationFixture();
  fixture.options.canApply = async () => true;
  assert.equal((await applyComposerTextEdit(fixture.options)).kind, "Cancelled");
  assert.equal(fixture.state.source, nativeSource);
}
for (const edits of [
  [{ range: pointRange(100), newText: "outside line" }],
  [nativeTextEdit.edit.documentChanges[0].edits[0], nativeTextEdit.edit.documentChanges[0].edits[0]],
]) {
  const fixture = nativeApplicationFixture();
  fixture.options.result = {
    ...nativeTextEdit,
    edit: { documentChanges: [{ textDocument, edits }] },
  };
  assert.equal((await applyComposerTextEdit(fixture.options)).kind, "ApplyFailed");
  assert.equal(fixture.state.source, nativeSource);
}

{
  const fixture = nativeApplicationFixture();
  const history = getComposerNativeHistory(fixture.options.modelService, textDocument.uri);
  fixture.options.modelService.getModel = () => ({ ...fixture.model });
  assert.throws(() => history.getAlternativeVersionId(), /no longer current/u);
}

console.log("Composer edit boundary contract passed");
