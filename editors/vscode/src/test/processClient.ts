import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  releasePendingProjectFileAfterGrace,
  canonicalTypstUri,
  diagnosticVersionMatchesProjection,
  ProjectFileCloseRegistry,
  projectionRevisionIsCurrent,
  rotateProjectFileGenerations,
  serverRequestResponse,
  validateTinymistInitialize
} from "../tinymistClient";
import { TinymistProcessClient, type TinymistProcessFactory } from "../tinymistProcessClient";
import {
  synchronizePackSources,
  type PackCacheStore,
  type PackFetchResponse
} from "../packSync";

class MemoryPackCache implements PackCacheStore {
  readonly committed = new Map<string, string>();
  readonly staged = new Map<string, string>();
  readonly etags = new Map<string, string>();

  async read(url: string): Promise<string | undefined> {
    return this.committed.get(url);
  }

  async stage(url: string, revision: number, json: string): Promise<void> {
    this.staged.set(`${url}@${revision}`, json);
  }

  async promote(url: string, revision: number): Promise<void> {
    const key = `${url}@${revision}`;
    const json = this.staged.get(key);
    if (json === undefined) throw new Error("missing staged manifest");
    this.committed.set(url, json);
    this.staged.delete(key);
  }

  async discard(url: string, revision: number): Promise<void> {
    this.staged.delete(`${url}@${revision}`);
  }

  getEtag(url: string): string | undefined {
    return this.etags.get(url);
  }

  async setEtag(url: string, etag: string | undefined): Promise<void> {
    if (etag === undefined) this.etags.delete(url);
    else this.etags.set(url, etag);
  }
}

async function testRejectedManifestPreservesCache(): Promise<void> {
  const url = "https://example.test/manifest.json";
  const valid = '{"schema":"mmt-pack.v3","pack":{"namespace":"ba"}}';
  const malformed = "{";
  const cache = new MemoryPackCache();
  cache.committed.set(url, valid);
  cache.etags.set(url, '"valid"');
  const malformedResponse: PackFetchResponse = {
    status: 200,
    ok: true,
    etag: '"malformed"',
    async text() { return malformed; }
  };
  let rejected = false;
  try {
    await synchronizePackSources(
      [url],
      1,
      cache,
      async () => { throw new Error("Rust rejected malformed manifest"); },
      async () => malformedResponse
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("malformed manifest update was accepted");
  if (cache.committed.get(url) !== valid) throw new Error("malformed manifest replaced valid cache bytes");
  if (cache.etags.get(url) !== '"valid"') throw new Error("malformed manifest replaced valid ETag");
  if (cache.staged.size !== 0) throw new Error("rejected manifest left staging data");

  let offlineJson: string | undefined;
  await synchronizePackSources(
    [url],
    2,
    cache,
    async (params) => {
      offlineJson = params.sources[0]?.json;
      return { revision: params.revision, updated: true };
    },
    async () => { throw new Error("offline"); }
  );
  if (offlineJson !== valid) throw new Error("offline sync did not reuse the last valid manifest");
}

interface CompletionList {
  items: Array<{ label: string }>;
}



function testProjectFileGenerationRetention(): void {
  const shared = "untitled:/projection/template.typ";
  const first = new Set([shared, "untitled:/projection/main-1.typ"]);
  const second = new Set([shared, "untitled:/projection/main-2.typ"]);
  const third = new Set([shared, "untitled:/projection/main-3.typ"]);
  const fourth = new Set([shared, "untitled:/projection/main-4.typ"]);
  const afterSecond = rotateProjectFileGenerations(second, first, []);
  const afterThird = rotateProjectFileGenerations(third, second, afterSecond.retained);
  const afterFourth = rotateProjectFileGenerations(fourth, third, afterThird.retained);
  if (afterSecond.close.length !== 0 || afterThird.close.length !== 0) {
    throw new Error("projection entry closed before its two-generation grace window");
  }
  if (
    afterFourth.close.length !== 1 ||
    afterFourth.close[0] !== "untitled:/projection/main-1.typ"
  ) {
    throw new Error(`projection grace rotation closed the wrong files: ${afterFourth.close.join(",")}`);
  }
}

function testProjectFileCloseOwnership(): void {
  const scheduled = new ProjectFileCloseRegistry();
  const sourceA = "file:///workspace/a.mmt";
  const sourceB = "file:///workspace/b.mmt";
  const sourceC = "file:///workspace/c.mmt";
  const sourceD = "file:///workspace/d.mmt";
  const aOnly = "untitled:/projection/a/main-1.typ";
  const bRetired = "untitled:/projection/b/main-1.typ";
  const cRetired = "untitled:/projection/c/main-1.typ";
  const bLive = "untitled:/projection/b/main-2.typ";
  const cLive = "untitled:/projection/c/main-2.typ";
  const shared = "untitled:/projection/shared/template.typ";
  const finalOnly = "untitled:/projection/d/main-4.typ";
  for (const [source, uri] of [
    [sourceA, aOnly],
    [sourceA, shared],
    [sourceB, bRetired],
    [sourceB, shared],
    [sourceB, bLive],
    [sourceC, cRetired]
  ] as const) scheduled.add(source, uri);
  const openVersions = new Map([
    [aOnly, 1],
    [bRetired, 1],
    [cRetired, 1],
    [bLive, 2],
    [cLive, 2],
    [shared, 2],
    [finalOnly, 4]
  ]);
  const projectFiles = new Map<string, Set<string>>([
    [sourceB, new Set([bLive, shared])],
    [sourceC, new Set([cLive, shared])]
  ]);
  const didClose: string[] = [];
  const attempt = (uri: string, expectedRevision: number) => releasePendingProjectFileAfterGrace(
    scheduled,
    uri,
    expectedRevision,
    (candidate) => openVersions.get(candidate),
    projectFiles,
    new Map(),
    new Map(),
    (candidate) => {
      didClose.push(candidate);
      openVersions.delete(candidate);
    }
  );

  if (attempt(aOnly, 0)) throw new Error("wrong open revision closed a projection file");
  if (!attempt(aOnly.replace("untitled:/", "untitled:"), 1) || didClose.join(",") !== aOnly) {
    throw new Error("grace fallback did not close the exact projection revision");
  }
  if (attempt(bLive, 2) || attempt(shared, 2)) {
    throw new Error("grace fallback closed a currently owned projection file");
  }
  if (!scheduled.has(sourceC, cRetired)) {
    throw new Error("exact grace fallback disturbed an unrelated pending file");
  }
  projectFiles.delete(sourceB);
  projectFiles.delete(sourceC);
  if (!attempt(shared.replace("untitled:/", "untitled:"), 2)) {
    throw new Error("globally unowned shared URI was not closed");
  }
  if (scheduled.has(sourceA, shared) || scheduled.has(sourceB, shared)) {
    throw new Error("global shared URI close left a stale owner marker");
  }

  scheduled.add(sourceD, finalOnly);
  if (!attempt(finalOnly, 4) || didClose.at(-1) !== finalOnly) {
    throw new Error("clean final project did not close after its bounded grace");
  }
}

interface FakeTinymistProcess {
  child: ChildProcessWithoutNullStreams;
  killed: boolean;
}
interface FakeTinymistOptions {
  failPrime?: boolean;
  methods?: string[];
}


function fakeTinymistProcess(version: string, options: FakeTinymistOptions = {}): FakeTinymistProcess {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let input = Buffer.alloc(0);
  const state = { killed: false };
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, { stdin, stdout, stderr, exitCode: null });
  child.kill = () => {
    if (state.killed) return false;
    state.killed = true;
    Object.defineProperty(child, "exitCode", { value: 0, writable: true });
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  stdin.on("data", (chunk: Buffer) => {
    input = Buffer.concat([input, chunk]);
    while (true) {
      const headerEnd = input.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = input.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (!Number.isSafeInteger(length) || input.length < bodyEnd) return;
      const message = JSON.parse(input.subarray(bodyStart, bodyEnd).toString("utf8")) as {
        id?: number | string;
        method?: string;
      };
      input = input.subarray(bodyEnd);
      if (message.method) options.methods?.push(message.method);
      if (message.id === undefined) continue;
      const result = message.method === "initialize"
        ? {
            serverInfo: { name: "tinymist", version },
            capabilities: {
              completionProvider: {},
              hoverProvider: true,
              signatureHelpProvider: {}
            }
          }
        : null;
      const response = options.failPrime && message.method === "textDocument/foldingRange"
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "projection not ready" } }
        : { jsonrpc: "2.0", id: message.id, result };
      const body = Buffer.from(JSON.stringify(response), "utf8");
      stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
      stdout.write(body);
    }
  });
  return {
    child,
    get killed() {
      return state.killed;
    }
  };
}

async function testFailedRecoveryCleanup(): Promise<void> {
  const processes: FakeTinymistProcess[] = [];
  const versions = ["0.15.2", "0.15.1", "0.15.2"];
  const factory: TinymistProcessFactory = () => {
    const process = fakeTinymistProcess(versions[processes.length] ?? "0.15.2");
    processes.push(process);
    return process.child;
  };
  const client = await TinymistProcessClient.start("fake-tinymist", 1, factory);
  try {
    let rejected = false;
    try {
      await client.restart();
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("0.15.2 required");
    }
    if (!rejected) throw new Error("invalid recovery handshake was accepted");
    await new Promise((resolve) => setImmediate(resolve));
    const currentChild = (client as unknown as { child?: unknown }).child;
    if (processes.length !== 2 || !processes[1].killed || currentChild !== undefined) {
      throw new Error("failed recovery child remained live or current");
    }
    await client.restart();
    const third = processes.at(2);
    if (!third || third.killed) {
      throw new Error("subsequent recovery did not create a fresh process");
    }
  } finally {
    await client.stop();
  }
}

async function testPrimeFailureBlocksFeatureRequest(): Promise<void> {
  const methods: string[] = [];
  const process = fakeTinymistProcess("0.15.2", { failPrime: true, methods });
  const client = await TinymistProcessClient.start("fake-tinymist", 1, () => process.child);
  try {
    const entryUri = "untitled:/mmt-projection/prime-failure/main-1.typ";
    client.syncProject({
      sourceUri: "file:///workspace/prime-failure.mmt",
      sourceVersion: 1,
      revision: 1,
      entryUri,
      full: true,
      files: [{ uri: entryUri, text: "#let greet = 1" }]
    });
    let rejected = false;
    try {
      await client.request("textDocument/completion", {
        textDocument: { uri: entryUri },
        position: { line: 0, character: 1 }
      });
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("projection not ready");
    }
    if (!rejected) throw new Error("feature request bypassed a failed projection prime");
    if (methods.includes("textDocument/completion")) {
      throw new Error("completion was sent after projection prime failure");
    }
  } finally {
    await client.stop();
  }
}

async function testSupersededPrimeBlocksStaleFeatureRequest(): Promise<void> {
  const methods: string[] = [];
  const process = fakeTinymistProcess("0.15.2", { methods });
  const client = await TinymistProcessClient.start("fake-tinymist", 1, () => process.child);
  try {
    const sourceUri = "file:///workspace/prime-superseded.mmt";
    const oldEntryUri = "untitled:/mmt-projection/prime-superseded/main-6.typ";
    const nextEntryUri = "untitled:/mmt-projection/prime-superseded/main-7.typ";
    client.syncProject({
      sourceUri,
      sourceVersion: 1,
      revision: 6,
      entryUri: oldEntryUri,
      full: true,
      files: [{ uri: oldEntryUri, text: "#let old = 6" }]
    });
    const staleRequest = client.request("textDocument/completion", {
      textDocument: { uri: oldEntryUri },
      position: { line: 0, character: 1 }
    });
    await Promise.resolve();
    client.syncProject({
      sourceUri,
      sourceVersion: 2,
      revision: 7,
      entryUri: nextEntryUri,
      full: true,
      files: [{ uri: nextEntryUri, text: "#let current = 7" }]
    });
    let rejected = false;
    try {
      await staleRequest;
    } catch (error) {
      rejected = error instanceof Error && error.message.includes("superseded");
    }
    if (!rejected) throw new Error("stale feature request survived projection replacement");
    if (methods.includes("textDocument/completion")) {
      throw new Error("completion was sent for a superseded projection entry");
    }
  } finally {
    await client.stop();
  }
}


async function main(): Promise<void> {
  await testRejectedManifestPreservesCache();
  testProjectFileGenerationRetention();
  testProjectFileCloseOwnership();
  await testFailedRecoveryCleanup();
  await testPrimeFailureBlocksFeatureRequest();
  await testSupersededPrimeBlocksStaleFeatureRequest();
  const rapidDiagnosticSequence = [
    diagnosticVersionMatchesProjection(1, 1),
    diagnosticVersionMatchesProjection(2, 1),
    diagnosticVersionMatchesProjection(2, 2)
  ];
  if (rapidDiagnosticSequence.join(",") !== "true,false,true") {
    throw new Error("late revision 1 diagnostics were accepted after projection revision 2");
  }
  if (!diagnosticVersionMatchesProjection(2, null)) {
    throw new Error("unversioned diagnostic compatibility fallback was removed");
  }
  let currentProjectionRevision = 1;
  const diagnosticBackend = {
    projectForEntry: () => ({ revision: currentProjectionRevision })
  };
  const diagnosticRequestRevision = currentProjectionRevision;
  currentProjectionRevision = 2;
  if (projectionRevisionIsCurrent(diagnosticBackend, "untitled:/main.typ", diagnosticRequestRevision)) {
    throw new Error("late revision 1 diagnostics could overwrite projection revision 2");
  }
  const command = process.env.TINYMIST_BIN;
  if (!command) throw new Error("TINYMIST_BIN is required");
  const configuration = serverRequestResponse({
    jsonrpc: "2.0",
    id: 1,
    method: "workspace/configuration",
    params: { items: [{ section: "typst" }] }
  });
  if (!Array.isArray(configuration.result) || configuration.result.length !== 1) {
    throw new Error("workspace/configuration response shape is invalid");
  }
  const unsupported = serverRequestResponse({ jsonrpc: "2.0", id: 2, method: "workspace/unknown" });
  if (unsupported.error?.code !== -32601) throw new Error("unknown server request was not rejected");
  let incompatibleRejected = false;
  try {
    validateTinymistInitialize({ serverInfo: { version: "0.15.1" }, capabilities: {} });
  } catch {
    incompatibleRejected = true;
  }
  if (!incompatibleRejected) throw new Error("incompatible Tinymist version was accepted");
  const client = await TinymistProcessClient.start(command, 100);
  const cancelled = new AbortController();
  cancelled.abort();
  let cancellationObserved = false;
  try {
    await client.request("textDocument/hover", {}, cancelled.signal);
  } catch (error) {
    cancellationObserved = error instanceof Error && error.message.includes("cancelled");
  }
  if (!cancellationObserved) throw new Error("cancelled Tinymist request was not rejected");
  const uriV1 = "untitled:/mmt-projection/process-test/main-1.typ";
  const uriV2 = "untitled:/mmt-projection/process-test/main-2.typ";
  const uriNextSession = "untitled:/mmt-projection/process-test-next/main-1.typ";
  const lateOldUri = "untitled:/mmt-projection/process-test/main-3.typ";
  const sourceUri = "file:///workspace/process-test.mmt";
  const retiredUri = "untitled:/mmt-projection/retired-test/main-1.typ";
  const retiredSourceUri = "file:///workspace/retired-test.mmt";
  type PublishedDiagnostics = { uri: string; version?: number | null };
  const diagnosticWaiters = new Map<string, (params: PublishedDiagnostics) => void>();
  client.on("textDocument/publishDiagnostics", (value) => {
    const params = value as PublishedDiagnostics;
    diagnosticWaiters.get(canonicalTypstUri(params.uri))?.(params);
  });
  const waitForDiagnostics = (uri: string): Promise<PublishedDiagnostics> => new Promise((resolve, reject) => {
    const key = canonicalTypstUri(uri);
    const timeout = setTimeout(() => {
      diagnosticWaiters.delete(key);
      reject(new Error(`timed out waiting for diagnostics: ${uri}`));
    }, 10_000);
    diagnosticWaiters.set(key, (params) => {
      clearTimeout(timeout);
      diagnosticWaiters.delete(key);
      resolve(params);
    });
  });
  const virtualCloseCounts = new Map<string, number>();
  const virtualCloseWaiters = new Map<string, () => void>();
  client.on("tinymist/virtualFileClosed", (value) => {
    const key = canonicalTypstUri((value as { uri: string }).uri);
    virtualCloseCounts.set(key, (virtualCloseCounts.get(key) ?? 0) + 1);
    virtualCloseWaiters.get(key)?.();
  });
  const waitForVirtualClose = (uri: string): Promise<void> => new Promise((resolve, reject) => {
    const key = canonicalTypstUri(uri);
    const timeout = setTimeout(() => {
      virtualCloseWaiters.delete(key);
      reject(new Error(`timed out waiting for virtual file close: ${uri}`));
    }, 2_000);
    virtualCloseWaiters.set(key, () => {
      clearTimeout(timeout);
      virtualCloseWaiters.delete(key);
      resolve();
    });
  });
  const primeWaiters = new Map<string, { resolve(): void; reject(error: Error): void }>();
  client.on("tinymist/projectPrimed", (value) => {
    const key = canonicalTypstUri((value as { entryUri: string }).entryUri);
    primeWaiters.get(key)?.resolve();
    primeWaiters.delete(key);
  });
  client.on("tinymist/projectPrimeFailed", (value) => {
    const params = value as { entryUri: string; error: string };
    const key = canonicalTypstUri(params.entryUri);
    primeWaiters.get(key)?.reject(new Error(params.error));
    primeWaiters.delete(key);
  });
  const waitForPrime = (uri: string): Promise<void> => new Promise((resolve, reject) => {
    const key = canonicalTypstUri(uri);
    const timeout = setTimeout(() => {
      primeWaiters.delete(key);
      reject(new Error(`timed out waiting for projection prime: ${uri}`));
    }, 5_000);
    primeWaiters.set(key, {
      resolve: () => { clearTimeout(timeout); resolve(); },
      reject: (error) => { clearTimeout(timeout); reject(error); }
    });
  });
  try {
    const firstDiagnostics = waitForDiagnostics(uriV1);
    client.syncProject({
      sourceUri,
      sourceVersion: 1,
      revision: 1,
      entryUri: uriV1,
      full: true,
      files: [
        {
          uri: uriV1,
          text: "#let greet(name) = [Hello #name]\n#greet(\"MMT\")\n#gre"
        }
      ]
    });
    await firstDiagnostics;
    const completion = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri: uriV1 },
      position: { line: 2, character: 4 }
    });
    if (!completion.items.some((item) => item.label === "greet")) {
      throw new Error("native process completion omitted greet");
    }
    const hover = await client.request<unknown>("textDocument/hover", {
      textDocument: { uri: uriV1 },
      position: { line: 1, character: 3 }
    });
    if (!hover) throw new Error("native process hover was empty");
    const signature = await client.request<{ signatures: Array<{ label: string }> }>(
      "textDocument/signatureHelp",
      {
        textDocument: { uri: uriV1 },
        position: { line: 1, character: 6 },
        context: { triggerKind: 1, isRetrigger: false }
      }
    );
    if (!signature.signatures.some((item) => item.label.includes("greet"))) {
      throw new Error("native process signature help omitted greet");
    }
    const retiredClosed = waitForVirtualClose(retiredUri);
    client.syncProject({
      sourceUri: retiredSourceUri,
      sourceVersion: 1,
      revision: 1,
      entryUri: retiredUri,
      full: true,
      files: [{ uri: retiredUri, text: "#let retired = 1" }]
    });
    if (!client.closeProject(retiredSourceUri, retiredUri)) {
      throw new Error("current retired fixture project was not closed");
    }
    await retiredClosed;
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (virtualCloseCounts.get(canonicalTypstUri(retiredUri)) !== 1) {
      throw new Error("clean final project emitted duplicate or missing didClose");
    }
    const changedPrime = waitForPrime(uriV2);
    client.syncProject({
      sourceUri,
      sourceVersion: 1,
      revision: 2,
      entryUri: uriV2,
      full: false,
      files: [{
        uri: uriV2,
        text: "#let repacked(name) = [Updated #name]\n#repacked(\"MMT\")\n#rep"
      }]
    });
    await changedPrime;
    if (client.closeProject(sourceUri, uriV1)) {
      throw new Error("stale close removed a newer project with the same source URI");
    }
    if (!client.projectForEntry(uriV2)) {
      throw new Error("newer project disappeared after stale close delivery");
    }
    if (client.projectForEntry(uriV1)) {
      throw new Error("retired projection entry remained addressable");
    }
    client.syncProject({
      sourceUri,
      sourceVersion: 1,
      revision: 2,
      entryUri: uriV2,
      full: false,
      files: [{ uri: uriV2, text: "#let stale = 1" }]
    });
    const changed = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri: uriV2 },
      position: { line: 2, character: 4 }
    });
    if (!changed.items.some((item) => item.label === "repacked")) {
      throw new Error("native process ignored a newer projection with the same MMT source version");
    }
    client.syncProject({
      sourceUri,
      sourceVersion: 1,
      revision: 1,
      entryUri: uriNextSession,
      full: false,
      files: [{ uri: uriNextSession, text: "#let incomplete = 1" }]
    });
    if (client.projectForEntry(uriNextSession)) throw new Error("cross-session process delta was accepted");
    client.syncProject({
      sourceUri,
      sourceVersion: 1,
      revision: 1,
      entryUri: uriNextSession,
      full: true,
      files: [{
        uri: uriNextSession,
        text: "#let repacked(name) = [Updated #name]\n#repacked(\"MMT\")\n#rep"
      }]
    });
    if (client.closeProject(sourceUri, uriV1)) {
      throw new Error("stale close removed a reopened project with the same source URI");
    }
    if (!client.projectForEntry(uriNextSession)) {
      throw new Error("reopened project disappeared after stale close delivery");
    }
    client.syncProject({
      sourceUri,
      sourceVersion: 1,
      revision: 3,
      entryUri: lateOldUri,
      full: true,
      files: [{ uri: lateOldUri, text: "#let stale = 1" }]
    });
    if (!client.projectForEntry(uriNextSession)) throw new Error("new process projection session was rejected");
    if (client.projectForEntry(lateOldUri)) {
      throw new Error("retired process projection session was restored by a late update");
    }
    await client.restart();
    const replayed = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri: uriNextSession },
      position: { line: 2, character: 4 }
    });
    if (!replayed.items.some((item) => item.label === "repacked")) {
      throw new Error("native process restart did not replay the newest virtual project");
    }
    const reopenedSourceUri = "file:///workspace/reopened-clean.mmt";
    const reopenedUri = "untitled:/mmt-projection/reopened-clean/main-1.typ";
    client.syncProject({
      sourceUri: reopenedSourceUri,
      sourceVersion: 1,
      revision: 1,
      entryUri: reopenedUri,
      full: true,
      files: [{ uri: reopenedUri, text: "#let clean = 1" }]
    });
    if (!client.closeProject(reopenedSourceUri, reopenedUri)) {
      throw new Error("clean reopen fixture was not scheduled for close");
    }
    client.syncProject({
      sourceUri: reopenedSourceUri,
      sourceVersion: 2,
      revision: 2,
      entryUri: reopenedUri,
      full: true,
      files: [{ uri: reopenedUri, text: "#let clean = 2" }]
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (virtualCloseCounts.has(canonicalTypstUri(reopenedUri))) {
      throw new Error("reopening a clean virtual file did not cancel its close fallback");
    }
    console.log(JSON.stringify({
      completion: true,
      hover: true,
      signature: true,
      changed: true,
      restarted: true
    }));
  } finally {
    await client.stop();
  }
}

void main();
