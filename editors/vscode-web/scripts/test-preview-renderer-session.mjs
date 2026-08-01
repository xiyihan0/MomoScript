import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { PreviewRendererSessionOwner } from "../src/previewRendererSession.ts";
import {
  PREVIEW_RENDERER_PROTOCOL_VERSION,
  preparePreviewProject,
} from "../../vscode/src/previewRendererProtocol.ts";

const encoder = new TextEncoder();
const sourceUri = "mmtfs://workspace/story.mmt";
const entryUri = "untitled:/mmt-projection/story/main.typ";
const mount = { logicalSourceId: "a".repeat(64) };
const renderKey = (value) => value.repeat(64);
const project = (revision) => ({
  sourceUri,
  sourceVersion: revision,
  revision,
  entryUri,
  files: [{ uri: entryUri, text: `[generation ${revision}]`, digest: `${revision}`.repeat(64).slice(0, 64) }],
  full: true,
  sourceContent: renderKey("b"),
  projectDigest: renderKey("c"),
  projectionKey: renderKey("d"),
  mappingDigest: renderKey("e"),
});
const artifact = async (frameKind, generation) => {
  const bytes = encoder.encode(`${frameKind},payload-${generation}`);
  return {
    bytes,
    dataBase64: Buffer.from(bytes).toString("base64"),
    artifactDigest: createHash("sha256").update(bytes).digest("hex"),
  };
};

class FakeBackend {
  generation = 1;
  calls = [];
  closes = [];
  transitions = [];
  requests = [];
  responses = [];

  backendGeneration() { return this.generation; }
  async previewRenderer(update, requestedMount, options, signal) {
    this.calls.push({ update, mount: requestedMount, options });
    const synchronized = await preparePreviewProject(update, requestedMount);
    const responseFactory = this.responses.shift();
    if (responseFactory) return { synchronized, response: await responseFactory(synchronized, options, signal) };
    return { synchronized, response: await this.readyResponse(synchronized, options) };
  }
  async readyResponse(synchronized, options) {
    const generation = options.baseGeneration === undefined ? 1 : options.baseGeneration + 1;
    const frameKind = options.forceFull ? "new" : "diff-v1";
    const payload = await artifact(frameKind, generation);
    return {
      status: "ready",
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      sessionId: options.sessionId,
      snapshotToken: options.snapshotToken,
      sourceDigest: synchronized.sourceDigest,
      artifactDigest: payload.artifactDigest,
      compilerRevision: generation,
      generation,
      baseGeneration: frameKind === "new" ? 0 : options.baseGeneration,
      frameKind,
      dataBase64: payload.dataBase64,
      byteLength: payload.bytes.byteLength,
      pageCount: 1,
    };
  }
  async transitionPreviewRenderer(transition) {
    this.transitions.push(transition);
    return {
      status: transition.action === "commit" ? "committed" : "discarded",
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      sessionId: transition.sessionId,
      snapshotToken: transition.snapshotToken,
      generation: transition.generation,
    };
  }
  async closePreviewRenderer(sessionId) { this.closes.push(sessionId); }
  async request(_method, request) {
    this.requests.push(request);
    if (request.action === "locateSource") {
      return {
        status: "locatedSource",
        protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
        sessionId: request.sessionId,
        generation: request.generation,
        locations: [{ pageIndex: 0, x: 12, y: 18 }],
      };
    }
    return {
      status: "locatedPoint",
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      sessionId: request.sessionId,
      generation: request.generation,
      location: {
        uri: (await preparePreviewProject(this.calls.at(-1).update, mount)).project.entryUri,
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } },
      },
    };
  }
}

const backend = new FakeBackend();
let sessionCounter = 0;
const owner = new PreviewRendererSessionOwner({
  backend,
  createSessionId: () => `session-${++sessionCounter}`,
});
const first = await owner.render(project(1), mount, renderKey("1"));
assert.equal(first.ready.frameKind, "new");
assert.equal(first.ready.baseGeneration, 0);
assert.equal(first.sourceUris.get(entryUri), first.synchronized.project.entryUri);
await assert.rejects(() => owner.render(project(2), mount, renderKey("2")), /already has a staged generation/);
await owner.commit(first);

const sourcePoints = await owner.locateSource(first, entryUri, { line: 0, character: 1 });
assert.deepEqual(sourcePoints, [{ pageIndex: 0, x: 12, y: 18 }]);
assert.equal(backend.requests.at(-1).uri, first.synchronized.project.entryUri);
const sourceLocation = await owner.locatePoint(first, sourcePoints[0]);
assert.equal(sourceLocation.uri, entryUri);

backend.responses.push(async (_synchronized, options) => ({
  status: "resync",
  protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
  sessionId: options.sessionId,
  snapshotToken: options.snapshotToken,
  expectedBaseGeneration: 0,
}));
const replacement = await owner.render(project(2), mount, renderKey("2"));
assert.equal(replacement.ready.frameKind, "new", "resync must retry once with a full frame");
assert.deepEqual(backend.calls.slice(-2).map((call) => call.options.forceFull ?? false), [false, true]);
await owner.commit(replacement);
await assert.rejects(() => owner.locateSource(first, entryUri, { line: 0, character: 1 }), /not the committed generation/);

const staged = await owner.render(project(3), mount, renderKey("3"));
await owner.discard(staged);
assert.equal(backend.transitions.at(-1).action, "discard");

let releaseDelayedRender;
let markDelayedRenderStarted;
const delayedRenderStarted = new Promise((resolve) => { markDelayedRenderStarted = resolve; });
const delayedRender = new Promise((resolve) => { releaseDelayedRender = resolve; });
backend.responses.push(async (synchronized, options) => {
  markDelayedRenderStarted();
  await delayedRender;
  return backend.readyResponse(synchronized, options);
});
const abort = new AbortController();
const cancelled = owner.render(project(4), mount, renderKey("4"), abort.signal);
await delayedRenderStarted;
abort.abort(new DOMException("superseded", "AbortError"));
releaseDelayedRender();
await assert.rejects(cancelled, /superseded/);
assert.deepEqual(backend.closes, [], "a known staged generation must be discarded without closing its committed session");
assert.equal(backend.transitions.at(-1).action, "discard");
const restarted = await owner.render(project(4), mount, renderKey("4"));
assert.equal(restarted.sessionId, "session-1");
assert.equal(restarted.ready.frameKind, "diff-v1");
await owner.commit(restarted);

backend.generation = 2;
const afterRestart = await owner.render(project(5), mount, renderKey("5"));
assert.equal(afterRestart.sessionId, "session-2");
assert.equal(afterRestart.ready.frameKind, "new", "a backend restart must force a full frame");
await owner.commit(afterRestart);
await owner.closeAll();
assert.ok(backend.closes.includes("session-2"));
owner.dispose();
console.log(JSON.stringify({
  committedGenerations: backend.transitions.filter((value) => value.action === "commit").length,
  discardedGenerations: backend.transitions.filter((value) => value.action === "discard").length,
  closedSessions: backend.closes,
  locationRequests: backend.requests.length,
}));
