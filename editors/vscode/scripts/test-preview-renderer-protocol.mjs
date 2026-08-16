import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: [new URL("../src/previewRendererProtocol.ts", import.meta.url).pathname],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
});
const protocol = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].contents).toString("base64")}`);
const digest = "1".repeat(64);
const update = {
  sourceUri: "file:///workspace/story.mmt",
  sourceVersion: 7,
  revision: 11,
  entryUri: "mmtfs:/workspace/generated/main.typ",
  files: [
    { uri: "mmtfs:/workspace/generated/main.typ", digest, text: "#image(\"assets/a.png\")" },
    { uri: "mmtfs:/workspace/generated/assets/a.png", digest: "2".repeat(64), dataBase64: "AA==" }
  ],
  full: true,
  sourceContent: "3".repeat(64),
  projectDigest: "4".repeat(64),
  projectionKey: "5".repeat(64),
  mappingDigest: "6".repeat(64),
};
const font = { contentDigest: "9".repeat(64), dataBase64: "AA==" };
const mount = { logicalSourceId: "7".repeat(64), fonts: [font] };
const first = await protocol.preparePreviewProject(update, mount);
const second = await protocol.preparePreviewProject({ ...update, sourceVersion: 8, revision: 12 }, mount);
assert.equal(first.project.entryUri, second.project.entryUri);
assert.deepEqual(first.project.files.map((file) => file.uri), second.project.files.map((file) => file.uri));
assert.equal(first.sourceDigest, second.sourceDigest);
assert.match(first.project.entryUri, /^mmt-preview:\/__mmt_preview\/7{64}\//);
assert.equal(first.project.sourceUri, `mmt-preview:/${"7".repeat(64)}`);
assert.deepEqual(first.fonts, [font]);
await assert.rejects(
  protocol.preparePreviewProject(update, { ...mount, fonts: [font, font] }),
  /unique digests/
);
await assert.rejects(
  protocol.preparePreviewProject({ ...update, full: false }, mount),
  /complete project snapshot/
);

const frame = new TextEncoder().encode("new,renderer-frame");
const artifactDigest = Buffer.from(await crypto.subtle.digest("SHA-256", frame)).toString("hex");
const diagnostic = {
  range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } },
  severity: 1,
  code: "compile",
  codeDescription: { href: "https://typst.app/docs/" },
  source: "typst",
  message: "unknown variable",
  tags: [1],
  relatedInformation: [{
    location: {
      uri: "mmt-preview:/__mmt_preview/dependency.typ",
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    },
    message: "used here",
  }],
  data: { phase: "layout" },
};
const diagnosticRecord = {
  uri: first.project.entryUri,
  diagnostic,
};

const ready = {
  status: "ready",
  protocolVersion: protocol.PREVIEW_RENDERER_PROTOCOL_VERSION,
  sessionId: "preview-source",
  snapshotToken: "8".repeat(64),
  sourceDigest: first.sourceDigest,
  artifactDigest,
  compilerRevision: 3,
  generation: 1,
  baseGeneration: 0,
  frameKind: "new",
  dataBase64: Buffer.from(frame).toString("base64"),
  byteLength: frame.byteLength,
  pageCount: 2,
  diagnostics: [diagnosticRecord],
};
const decoded = await protocol.validatePreviewRendererReady(ready, {
  sessionId: ready.sessionId,
  snapshotToken: ready.snapshotToken,
  sourceDigest: ready.sourceDigest,
});
assert.deepEqual(decoded, frame);
await assert.rejects(
  protocol.validatePreviewRendererReady({ ...ready, artifactDigest: "0".repeat(64) }, {
    sessionId: ready.sessionId,
    snapshotToken: ready.snapshotToken,
    sourceDigest: ready.sourceDigest,
  }),
  /artifact digest mismatch/
);
await assert.rejects(
  protocol.validatePreviewRendererReady({ ...ready, generation: 0 }, {
    sessionId: ready.sessionId,
    snapshotToken: ready.snapshotToken,
    sourceDigest: ready.sourceDigest,
  }),
  /generation metadata/
);
const compileFailed = {
  status: "compileFailed",
  protocolVersion: protocol.PREVIEW_RENDERER_PROTOCOL_VERSION,
  sessionId: ready.sessionId,
  snapshotToken: ready.snapshotToken,
  sourceDigest: ready.sourceDigest,
  compilerRevision: 4,
  diagnostics: [diagnosticRecord],
};
assert.equal(
  protocol.validatePreviewRendererCompileFailed(compileFailed, {
    sessionId: ready.sessionId,
    snapshotToken: ready.snapshotToken,
    sourceDigest: ready.sourceDigest,
  }),
  compileFailed
);
for (const invalid of [
  { ...compileFailed, generation: 2 },
  { ...compileFailed, diagnostics: [{ ...diagnosticRecord, uri: "not a uri" }] },
  { ...compileFailed, diagnostics: [{ ...diagnosticRecord, diagnostic: { ...diagnostic, unexpected: true } }] },
  { ...compileFailed, diagnostics: [{ ...diagnosticRecord, diagnostic: { ...diagnostic, severity: 5 } }] },
  { ...compileFailed, diagnostics: [{ ...diagnosticRecord, diagnostic: { ...diagnostic, code: {} } }] },
  { ...compileFailed, diagnostics: [{ ...diagnosticRecord, diagnostic: { ...diagnostic, data: { value: undefined } } }] },
  {
    ...compileFailed,
    diagnostics: [{
      ...diagnosticRecord,
      diagnostic: {
        ...diagnostic,
        relatedInformation: [{
          location: {
            uri: "not a uri",
            range: diagnostic.range,
          },
          message: "bad",
        }],
      },
    }],
  },
  {
    ...compileFailed,
    diagnostics: [{
      ...diagnosticRecord,
      diagnostic: {
        ...diagnostic,
        range: { start: diagnostic.range.end, end: diagnostic.range.start },
      },
    }],
  },
]) {
  assert.throws(
    () => protocol.validatePreviewRendererCompileFailed(invalid, {
      sessionId: ready.sessionId,
      snapshotToken: ready.snapshotToken,
      sourceDigest: ready.sourceDigest,
    }),
    /Preview renderer/
  );
}
console.log("preview renderer protocol fixture ok");
