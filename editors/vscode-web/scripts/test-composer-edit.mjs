import assert from "node:assert/strict";
import {
  applyComposerEdit,
  parseComposerAvatarChoice,
  parseComposerEditResult,
  parsePreviewComposerTargetResult,
} from "../src/composerEdit.ts";

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
      statementText: { ...statementText, mode: "typstMacro" },
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
  const calls = { convert: 0, readDocuments: 0, apply: 0 };
  const converted = { converted: true };
  const client = {
    protocol2CodeConverter: {
      async asWorkspaceEdit(edit) {
        calls.convert += 1;
        assert.equal(edit, parsedEdit.edit);
        if (converterError) throw new Error("conversion failed");
        afterConvert?.();
        return converted;
      },
    },
  };
  const workspace = {
    get textDocuments() {
      calls.readDocuments += 1;
      return [{ uri: { toString: () => documentUri }, version: documentVersion }];
    },
    async applyEdit(edit) {
      calls.apply += 1;
      assert.equal(edit, converted);
      if (applyError) throw new Error("apply failed");
      return applyResult;
    },
  };
  return {
    calls,
    options: { client, workspace, result: parsedEdit, textDocument, signal },
  };
}

{
  const fixture = applicationFixture();
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "Applied" });
  assert.deepEqual(fixture.calls, { convert: 1, readDocuments: 1, apply: 1 });
}
{
  const fixture = applicationFixture({ documentVersion: textDocument.version + 1 });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "Stale" });
  assert.deepEqual(fixture.calls, { convert: 1, readDocuments: 1, apply: 0 });
}
{
  const fixture = applicationFixture({ documentUri: "mmtfs://workspace/other.mmt" });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "Stale" });
  assert.equal(fixture.calls.apply, 0);
}
{
  const fixture = applicationFixture({ applyResult: false });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "ApplyFailed" });
  assert.deepEqual(fixture.calls, { convert: 1, readDocuments: 1, apply: 1 });
}
{
  const fixture = applicationFixture({ signal: { aborted: true } });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "Cancelled" });
  assert.deepEqual(fixture.calls, { convert: 0, readDocuments: 0, apply: 0 });
}
{
  const signal = { aborted: false };
  const fixture = applicationFixture({ signal, afterConvert: () => { signal.aborted = true; } });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "Cancelled" });
  assert.deepEqual(fixture.calls, { convert: 1, readDocuments: 0, apply: 0 });
}
{
  const fixture = applicationFixture({ converterError: true });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "ApplyFailed" });
  assert.deepEqual(fixture.calls, { convert: 1, readDocuments: 0, apply: 0 });
}
{
  const fixture = applicationFixture({ applyError: true });
  assert.deepEqual(await applyComposerEdit(fixture.options), { kind: "ApplyFailed" });
  assert.deepEqual(fixture.calls, { convert: 1, readDocuments: 1, apply: 1 });
}

console.log("Composer edit boundary contract passed");
