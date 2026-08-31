import assert from "node:assert/strict";

import {
  composerDocumentSourceDigest,
  parseComposerDocumentResult,
  validateComposerSnapshotAgainstDocument,
} from "../src/composerDocument.ts";

class TestDocument {
  constructor(uri, version, text) {
    this.uri = { toString: () => uri };
    this.version = version;
    this.text = text;
    this.lineStarts = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] === "\n") this.lineStarts.push(index + 1);
    }
  }

  getText() {
    return this.text;
  }

  positionAt(rawOffset) {
    const offset = Math.max(0, Math.min(rawOffset, this.text.length));
    let line = 0;
    while (line + 1 < this.lineStarts.length && this.lineStarts[line + 1] <= offset) line += 1;
    return { line, character: offset - this.lineStarts[line] };
  }

  offsetAt(position) {
    const start = this.lineStarts[position.line];
    if (start === undefined) return this.text.length;
    const next = this.lineStarts[position.line + 1] ?? this.text.length;
    return Math.max(start, Math.min(start + position.character, next));
  }
}

const source = "- Unicode 😀\r\n";
const uri = "mmtfs://workspace/story.mmt";
const digest = "b764fdd6f4a8bb209bebee01873de5b29986a4ef2263ab6deae0c853ee1249f0";
assert.equal(await composerDocumentSourceDigest(source), digest);
assert.equal(
  await composerDocumentSourceDigest(""),
  "5229a1859903f18b147ff1dc5ac552d83d0f4550fb28f0de4fd413c8e5ee1b0a",
);

const nodeRef = {
  nodeKey: "a".repeat(64),
  nodeKind: "narration",
  range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
};
const insert = (boundary) => ({
  boundary,
  messageSides: ["left", "right"],
  statementModes: ["inherit", "textMacro", "textRaw", "typstMacro", "typstRaw"],
  speakerSources: ["scriptActor", "packEntity"],
  narration: true,
});
const startBoundary = { kind: "boundary", before: null, after: nodeRef };
const endBoundary = { kind: "boundary", before: nodeRef, after: null };
const snapshotWire = {
  kind: "Snapshot",
  textDocument: { uri, version: 7 },
  sourceDigest: digest,
  nodes: [{
    kind: "narration",
    nodeKey: nodeRef.nodeKey,
    range: nodeRef.range,
    statementRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
    body: {
      current: "Unicode 😀",
      mode: "inherit",
      resolvedMode: "textMacro",
      inheritedMode: "textMacro",
    },
    capabilities: { setBody: true, delete: true, moveUp: null, moveDown: null },
  }],
  boundaries: [
    { target: startBoundary, insert: insert(startBoundary) },
    { target: endBoundary, insert: insert(endBoundary) },
  ],
  scriptActorChoices: [],
};
const snapshot = parseComposerDocumentResult(structuredClone(snapshotWire));
assert.deepEqual(snapshot, snapshotWire);
assert.ok(Object.isFrozen(snapshot));
await validateComposerSnapshotAgainstDocument(snapshot, new TestDocument(uri, 7, source));

assert.deepEqual(parseComposerDocumentResult({ kind: "Rejected", reason: "staleDocument" }), {
  kind: "Rejected",
  reason: "staleDocument",
});
assert.deepEqual(parseComposerDocumentResult({ kind: "Rejected", reason: "documentUnavailable" }), {
  kind: "Rejected",
  reason: "documentUnavailable",
});

const opaqueSource = "// 😀\r\n";
const opaqueDigest = await composerDocumentSourceDigest(opaqueSource);
const opaqueRef = {
  nodeKey: "b".repeat(64),
  nodeKind: "opaque",
  range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
};
const opaqueSnapshot = parseComposerDocumentResult({
  kind: "Snapshot",
  textDocument: { uri, version: 8 },
  sourceDigest: opaqueDigest,
  nodes: [{
    kind: "opaque",
    nodeKey: opaqueRef.nodeKey,
    range: opaqueRef.range,
    category: "recoverableError",
    sourcePreview: opaqueSource,
    sourceTruncated: false,
    summary: opaqueSource,
    canOpenSource: true,
  }],
  boundaries: [
    { target: { kind: "boundary", before: null, after: opaqueRef }, insert: null },
    { target: { kind: "boundary", before: opaqueRef, after: null }, insert: null },
  ],
  scriptActorChoices: [],
});
await validateComposerSnapshotAgainstDocument(
  opaqueSnapshot,
  new TestDocument(uri, 8, opaqueSource),
);

for (const malformed of [
  { ...snapshotWire, unknown: true },
  { ...snapshotWire, sourceDigest: "A".repeat(64) },
  { ...snapshotWire, nodes: [{ ...snapshotWire.nodes[0], kind: "future" }] },
  { ...snapshotWire, nodes: [{ ...snapshotWire.nodes[0], extra: true }] },
  { ...snapshotWire, boundaries: [] },
  { ...snapshotWire, scriptActorChoices: [{ reference: "x", displayName: "x", primaryName: "x", presetId: "x", avatar: null, extra: true }] },
  { kind: "Rejected", reason: "future" },
]) {
  assert.throws(() => parseComposerDocumentResult(structuredClone(malformed)));
}

for (const invalid of [
  { ...snapshotWire, sourceDigest: "c".repeat(64) },
  { ...snapshotWire, textDocument: { uri, version: 6 } },
  {
    ...snapshotWire,
    nodes: [{
      ...snapshotWire.nodes[0],
      range: { start: { line: 0, character: 1 }, end: { line: 1, character: 0 } },
    }],
  },
  {
    ...snapshotWire,
    boundaries: [
      snapshotWire.boundaries[0],
      { ...snapshotWire.boundaries[1], target: startBoundary },
    ],
  },
]) {
  const parsed = parseComposerDocumentResult(structuredClone(invalid));
  await assert.rejects(validateComposerSnapshotAgainstDocument(parsed, new TestDocument(uri, 7, source)));
}

const longOpaque = `// ${"😀".repeat(1100)}`;
const longBytes = new TextEncoder().encode(longOpaque);
let previewEnd = Math.min(4096, longBytes.length);
while ((longBytes[previewEnd] & 0xc0) === 0x80) previewEnd -= 1;
const preview = new TextDecoder().decode(longBytes.slice(0, previewEnd));
assert.ok(new TextEncoder().encode(preview).length <= 4096);

console.log("composer document contract tests passed");
