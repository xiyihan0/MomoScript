import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";

import {
  releasePendingProjectFileAfterGrace,
  canonicalTypstUri,
  diagnosticVersionMatchesProjection,
  ProjectFileCloseRegistry,
  projectionRevisionIsCurrent,
  rotateProjectFileGenerations,
  serverRequestResponse,
  validateTinymistInitialize,
  type TypstProjectUpdate
} from "../tinymistClient";
import { TinymistProcessClient, type TinymistProcessFactory } from "../tinymistProcessClient";
import {
  synchronizePackSources,
  type PackCacheStore,
  type PackFetchResponse
} from "../packSync";

function fixtureIdentity(revision: number): Pick<
  TypstProjectUpdate,
  "sourceContent" | "projectDigest" | "projectionKey" | "mappingDigest"
> {
  const key = `fixture-${revision}`;
  return {
    sourceContent: key as TypstProjectUpdate["sourceContent"],
    projectDigest: key as TypstProjectUpdate["projectDigest"],
    projectionKey: key as TypstProjectUpdate["projectionKey"],
    mappingDigest: key
  };
}

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
      ...fixtureIdentity(1),
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
      ...fixtureIdentity(6),
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
      ...fixtureIdentity(7),
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


type TranscriptId = number | string;

interface TranscriptMessage {
  jsonrpc?: "2.0";
  id?: TranscriptId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

declare global {
  interface PromiseConstructor {
    withResolvers<T>(): {
      promise: Promise<T>;
      resolve(value: T | PromiseLike<T>): void;
      reject(reason?: unknown): void;
    };
  }
}

function isTranscriptRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTranscriptMessage(json: string): TranscriptMessage {
  const parsed: unknown = JSON.parse(json);
  if (!isTranscriptRecord(parsed)) throw new Error("native evidence response is not an object");
  const message: TranscriptMessage = {};
  if (parsed.jsonrpc !== undefined) {
    if (parsed.jsonrpc !== "2.0") throw new Error("native evidence response has an invalid jsonrpc version");
    message.jsonrpc = "2.0";
  }
  if (parsed.id !== undefined) {
    if (parsed.id !== null && typeof parsed.id !== "number" && typeof parsed.id !== "string") {
      throw new Error("native evidence response has an invalid id");
    }
    message.id = parsed.id;
  }
  if (parsed.method !== undefined) {
    if (typeof parsed.method !== "string") throw new Error("native evidence response has an invalid method");
    message.method = parsed.method;
  }
  if (parsed.params !== undefined) message.params = parsed.params;
  if (parsed.result !== undefined) message.result = parsed.result;
  if (parsed.error !== undefined) {
    if (
      !isTranscriptRecord(parsed.error) ||
      typeof parsed.error.code !== "number" ||
      typeof parsed.error.message !== "string"
    ) {
      throw new Error("native evidence response has an invalid error");
    }
    message.error = {
      code: parsed.error.code,
      message: parsed.error.message,
      ...(parsed.error.data === undefined ? {} : { data: parsed.error.data })
    };
  }
  return message;
}

interface TranscriptWaiter {
  resolve(message: TranscriptMessage): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

class NativeTranscriptSession {
  private buffer = Buffer.alloc(0);
  private readonly messages: TranscriptMessage[] = [];
  private readonly waiters: TranscriptWaiter[] = [];
  readonly child: ChildProcessWithoutNullStreams;

  constructor(command: string) {
    this.child = spawn(command, ["--log-filter", "error", "lsp"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TINYMIST_LOG: "error" }
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    this.child.once("error", (error) => this.rejectWaiters(error));
    this.child.once("exit", (code, signal) => {
      if (this.waiters.length > 0) {
        this.rejectWaiters(new Error(`native evidence process exited with ${code ?? signal}`));
      }
    });
  }

  send(message: TranscriptMessage): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  nextMessage(timeoutMs: number): Promise<TranscriptMessage> {
    const message = this.messages.shift();
    if (message) return Promise.resolve(message);
    const { promise, resolve, reject } = Promise.withResolvers<TranscriptMessage>();
    const timeout = setTimeout(() => {
      const index = this.waiters.findIndex((waiter) => waiter.resolve === resolve);
      if (index >= 0) this.waiters.splice(index, 1);
      reject(new Error(`native evidence message timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    this.waiters.push({ resolve, reject, timeout });
    return promise;
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null) return;
    this.send({ jsonrpc: "2.0", id: 9_999, method: "shutdown", params: null });
    try {
      while (true) {
        const message = await this.nextMessage(2_000);
        if (message.id === 9_999) break;
      }
      this.send({ jsonrpc: "2.0", method: "exit", params: null });
      const { promise, resolve } = Promise.withResolvers<void>();
      const timeout = setTimeout(resolve, 2_000);
      this.child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
      await promise;
    } catch {
      this.child.kill();
    }
    if (this.child.exitCode === null) this.child.kill();
  }

  private drain(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthText = /Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (!lengthText) throw new Error("native evidence response omitted Content-Length");
      const length = Number(lengthText);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const message = parseTranscriptMessage(this.buffer.subarray(bodyStart, bodyEnd).toString("utf8"));
      this.buffer = this.buffer.subarray(bodyEnd);
      const waiter = this.waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else {
        this.messages.push(message);
      }
    }
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
  }
}

function normalizedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizedJson);
  if (!isTranscriptRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    normalized[key] = normalizedJson(value[key]);
  }
  return normalized;
}

interface NativePackageCallbackHarness {
  responses: unknown[];
  pending: Map<string | number, { name: string; requestId: string }>;
}

let nativePackageCallbackHarness: NativePackageCallbackHarness | undefined;

function respondToServerRequest(
  session: NativeTranscriptSession,
  message: TranscriptMessage,
  serverRequests: TranscriptMessage[]
): void {
  if (message.method === "$/cancelRequest" && nativePackageCallbackHarness && isTranscriptRecord(message.params)) {
    const rpcId = message.params.id;
    if (typeof rpcId === "string" || typeof rpcId === "number") {
      const pending = nativePackageCallbackHarness.pending.get(rpcId);
      if (pending) {
        nativePackageCallbackHarness.pending.delete(rpcId);
        const result = { status: "Cancelled", request_id: pending.requestId };
        nativePackageCallbackHarness.responses.push({ name: pending.name, outcome: result });
        session.send({ jsonrpc: "2.0", id: rpcId, result });
      }
    }
  }
  if (!message.method || message.id == null) return;
  serverRequests.push(message);
  if (message.method === "workspace/configuration") {
    const items = isTranscriptRecord(message.params) && Array.isArray(message.params.items)
      ? message.params.items
      : [];
    session.send({ jsonrpc: "2.0", id: message.id, result: items.map(() => null) });
    return;
  }
  if (
    message.method === "window/workDoneProgress/create" ||
    message.method === "client/registerCapability" ||
    message.method === "client/unregisterCapability"
  ) {
    session.send({ jsonrpc: "2.0", id: message.id, result: null });
    return;
  }
  if (message.method === "mmt/typstPackageRequest.v1" && nativePackageCallbackHarness && isTranscriptRecord(message.params)) {
    const packageSpec = isTranscriptRecord(message.params.package_spec) ? message.params.package_spec : undefined;
    const name = typeof packageSpec?.name === "string" ? packageSpec.name : "invalid";
    const requestId = typeof message.params.request_id === "string" ? message.params.request_id : "invalid";
    if (name === "mmt-callback-ready") {
      const result = {
        status: "Ready",
        request_id: requestId,
        package_generation: "native-generation-1",
        files_digest: "2222222222222222222222222222222222222222222222222222222222222222",
        files: [
          {
            path: "typst.toml",
            content_base64: Buffer.from('[package]\nname = "mmt-callback-ready"\nversion = "1.0.0"\nentrypoint = "lib.typ"\nauthors = ["MMT"]\n').toString("base64")
          },
          { path: "lib.typ", content_base64: Buffer.from("#let value = [host-ready]\n").toString("base64") }
        ]
      };
      nativePackageCallbackHarness.responses.push({ name, outcome: result });
      session.send({ jsonrpc: "2.0", id: message.id, result });
    } else if (name === "mmt-callback-unavailable") {
      const result = { status: "Unavailable", request_id: requestId, reason: "offline fixture", retryable: true };
      nativePackageCallbackHarness.responses.push({ name, outcome: result });
      session.send({ jsonrpc: "2.0", id: message.id, result });
    } else if (name === "mmt-callback-cancel") {
      nativePackageCallbackHarness.pending.set(message.id, { name, requestId });
    } else {
      const error = { code: -32010, message: "host package fixture error" };
      nativePackageCallbackHarness.responses.push({ name, error });
      session.send({ jsonrpc: "2.0", id: message.id, error });
    }
    return;
  }
  session.send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `Unsupported native evidence server request: ${message.method}` }
  });
}

async function transcriptRequest(
  session: NativeTranscriptSession,
  id: number,
  method: string,
  params: unknown,
  serverRequests: TranscriptMessage[],
  timeoutMs = 10_000
): Promise<TranscriptMessage> {
  session.send({ jsonrpc: "2.0", id, method, params });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const message = await session.nextMessage(Math.max(1, deadline - Date.now()));
    if (message.id === id && !message.method) return message;
    respondToServerRequest(session, message, serverRequests);
  }
}

async function collectTranscriptWindow(
  session: NativeTranscriptSession,
  durationMs: number,
  serverRequests: TranscriptMessage[]
): Promise<TranscriptMessage[]> {
  const messages: TranscriptMessage[] = [];
  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    try {
      const message = await session.nextMessage(Math.max(1, deadline - Date.now()));
      messages.push(message);
      respondToServerRequest(session, message, serverRequests);
    } catch (error) {
      if (error instanceof Error && error.message.includes("timed out")) break;
      throw error;
    }
  }
  return messages;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function captureNativeTinymistEvidence(command: string): Promise<Record<string, unknown>> {
  const checksumPath = process.env.TINYMIST_SHA256_FILE ?? resolve(dirname(command), "../../../tinymist-native.sha256");
  const checksumManifest = (await readFile(checksumPath, "utf8")).trim();
  const checksumMatch = /^([a-f0-9]{64})\s+(.+)$/.exec(checksumManifest);
  if (!checksumMatch) throw new Error(`invalid native checksum manifest: ${checksumPath}`);
  const artifactDigest = await sha256File(command);
  if (artifactDigest !== checksumMatch[1]) {
    throw new Error(`native artifact digest ${artifactDigest} does not match ${checksumMatch[1]}`);
  }

  const session = new NativeTranscriptSession(command);
  const serverRequests: TranscriptMessage[] = [];
  const dynamicRequests: TranscriptMessage[] = [];
  const packageImport = "@preview/mmt-callback-ready:1.0.0";
  const packageUri = "file:///tmp/mmt-native-evidence/package.typ";
  const packageMessages: TranscriptMessage[] = [];
  const packageHarness: NativePackageCallbackHarness = { responses: [], pending: new Map() };
  nativePackageCallbackHarness = packageHarness;
  try {
    const initializeResponse = await transcriptRequest(session, 1, "initialize", {
      processId: process.pid,
      rootUri: "file:///tmp/mmt-native-evidence",
      capabilities: {
        workspace: { configuration: true },
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {},
          publishDiagnostics: { versionSupport: true, relatedInformation: true }
        }
      },
      clientInfo: { name: "momoscript-vscode", version: "0.1.0" }
    }, serverRequests);
    if (initializeResponse.error || !isTranscriptRecord(initializeResponse.result)) {
      throw new Error(`native initialize failed: ${JSON.stringify(initializeResponse.error)}`);
    }
    const normalizedInitialize = normalizedJson(initializeResponse.result);
    if (!isTranscriptRecord(normalizedInitialize)) throw new Error("normalized initialize result is invalid");
    const initialize = normalizedInitialize;
    if (!isTranscriptRecord(initialize.capabilities)) throw new Error("native initialize omitted capabilities");
    const capabilities = initialize.capabilities;
    const executeCommandProvider = capabilities.executeCommandProvider;
    let executeCommands: string[] = [];
    if (isTranscriptRecord(executeCommandProvider) && executeCommandProvider.commands !== undefined) {
      if (!Array.isArray(executeCommandProvider.commands) || !executeCommandProvider.commands.every((item) => typeof item === "string")) {
        throw new Error("native initialize returned invalid execute commands");
      }
      executeCommands = [...executeCommandProvider.commands].sort();
      executeCommandProvider.commands = executeCommands;
    }

    session.send({ jsonrpc: "2.0", method: "initialized", params: {} });
    const dynamicWindowMs = 750;
    const afterInitialize = await collectTranscriptWindow(session, dynamicWindowMs, dynamicRequests);
    const registrations = dynamicRequests
      .filter((message) => message.method === "client/registerCapability")
      .flatMap((message) => {
        if (!isTranscriptRecord(message.params) || !Array.isArray(message.params.registrations)) return [];
        return message.params.registrations;
      })
      .map(normalizedJson)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const unregistrations = dynamicRequests
      .filter((message) => message.method === "client/unregisterCapability")
      .flatMap((message) => {
        if (!isTranscriptRecord(message.params)) return [];
        if (Array.isArray(message.params.unregisterations)) return message.params.unregisterations;
        return Array.isArray(message.params.unregistrations) ? message.params.unregistrations : [];
      })
      .map(normalizedJson)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));

    const sendPackageContext = (backendGeneration: number, snapshot: string): void => session.send({
      jsonrpc: "2.0",
      method: "mmt/typstPackageContext.v1",
      params: {
        backend_generation: backendGeneration,
        typst_project_snapshot_key: snapshot.padEnd(64, snapshot)
      }
    });
    const changePackageDocument = (version: number, name: string): void => session.send({
      jsonrpc: "2.0",
      method: version === 1 ? "textDocument/didOpen" : "textDocument/didChange",
      params: version === 1
        ? { textDocument: { uri: packageUri, languageId: "typst", version, text: `#import "@preview/${name}:1.0.0": *\n#value` } }
        : { textDocument: { uri: packageUri, version }, contentChanges: [{ text: `#import "@preview/${name}:1.0.0": *\n#value` }] }
    });

    const legacyContextResponse = await transcriptRequest(session, 19, "mmt/typstProjectContext.v1", {
      backend_generation: 1,
      typst_project_snapshot_key: "0".repeat(64)
    }, serverRequests);
    if (legacyContextResponse.error?.code !== -32601) {
      throw new Error(`legacy package context method was not rejected: ${JSON.stringify(legacyContextResponse)}`);
    }
    sendPackageContext(1, "1");
    changePackageDocument(1, "mmt-callback-ready");
    await transcriptRequest(session, 20, "textDocument/hover", { textDocument: { uri: packageUri }, position: { line: 1, character: 2 } }, serverRequests);
    packageMessages.push(...await collectTranscriptWindow(session, 1_200, serverRequests));
    sendPackageContext(2, "2");
    changePackageDocument(2, "mmt-callback-unavailable");
    packageMessages.push(...await collectTranscriptWindow(session, 900, serverRequests));
    sendPackageContext(3, "3");
    changePackageDocument(3, "mmt-callback-error");
    packageMessages.push(...await collectTranscriptWindow(session, 900, serverRequests));
    sendPackageContext(4, "4");
    changePackageDocument(4, "mmt-callback-cancel");
    packageMessages.push(...await collectTranscriptWindow(session, 400, serverRequests));
    session.send({ jsonrpc: "2.0", method: "textDocument/didClose", params: { textDocument: { uri: packageUri } } });
    sendPackageContext(5, "5");
    packageMessages.push(...await collectTranscriptWindow(session, 700, serverRequests));
    session.send({
      jsonrpc: "2.0",
      method: "textDocument/didOpen",
      params: { textDocument: { uri: packageUri, languageId: "typst", version: 1, text: "#let value = 1\n#value" } }
    });
    packageMessages.push(...await collectTranscriptWindow(session, 300, serverRequests));

    const traceResponse = await transcriptRequest(
      session,
      2,
      "workspace/executeCommand",
      { command: "tinymist.getDocumentTrace", arguments: [packageUri] },
      serverRequests
    );
    const scrollResponse = await transcriptRequest(
      session,
      3,
      "workspace/executeCommand",
      { command: "tinymist.scrollPreview", arguments: [] },
      serverRequests
    );
    const locationResponse = await transcriptRequest(
      session,
      4,
      "mmt/previewLocation.v1",
      { uri: packageUri, position: { line: 0, character: 0 } },
      serverRequests
    );

    const callbackMessages = packageMessages
      .filter((message) => message.method === "mmt/typstPackageRequest.v1");
    const cancellationMessages = packageMessages
      .filter((message) => message.method === "$/cancelRequest");
    const callbackResponses = packageHarness.responses.map(normalizedJson);
    const callbackResponseText = JSON.stringify(callbackResponses);
    for (const required of ["Ready", "Unavailable", "Cancelled", "host package fixture error"]) {
      if (!callbackResponseText.includes(required)) throw new Error(`native callback transcript omitted ${required}: messages=${JSON.stringify(packageMessages)}, responses=${callbackResponseText}`);
    }
    if (packageHarness.pending.size !== 0 || cancellationMessages.length === 0) {
      throw new Error("native callback cancellation was not completed");
    }
    const diagnosticMessages = packageMessages
      .filter((message) => message.method === "textDocument/publishDiagnostics")
      .map((message) => normalizedJson(message.params));
    const advertisedCommands = executeCommands.filter((commandName) =>
      /preview|documenttrace/i.test(commandName)
    );
    const traceResult = isTranscriptRecord(traceResponse.result) ? traceResponse.result : undefined;
    const traceRequest = isTranscriptRecord(traceResult?.request) ? traceResult.request : undefined;
    const traceMessages = Array.isArray(traceResult?.messages)
      ? traceResult.messages.filter(isTranscriptRecord)
      : [];
    const traceShape = traceResult ? {
      keys: Object.keys(traceResult).sort(),
      requestKeys: traceRequest ? Object.keys(traceRequest).sort() : [],
      messageMethods: traceMessages
        .map((message) => typeof message.method === "string" ? message.method : null)
        .filter((method): method is string => method !== null)
        .sort()
    } : null;
    const configurationPositive = serverRequestResponse({
      jsonrpc: "2.0",
      id: 100,
      method: "workspace/configuration",
      params: { items: [{ section: "typst" }] }
    });
    const unknownNegative = serverRequestResponse({
      jsonrpc: "2.0",
      id: 101,
      method: "workspace/unknown"
    });
    const serverInfo = isTranscriptRecord(initialize.serverInfo) ? initialize.serverInfo : undefined;
    const backendName = typeof serverInfo?.name === "string" ? serverInfo.name : null;
    const backendVersion = typeof serverInfo?.version === "string" ? serverInfo.version : null;

    const normalizedEvidence = normalizedJson({
      schemaVersion: 1,
      artifact: {
        host: "native-process",
        packageVersion: "0.15.2",
        backendName,
        backendVersion,
        protocolVersion: "LSP 3.17",
        digests: { tinymist: artifactDigest },
        checksumManifest: {
          reference: basename(checksumPath),
          referencedArtifact: basename(checksumMatch[2]),
          expectedSha256: checksumMatch[1],
          verified: true
        }
      },
      initialize,
      dynamicRegistrations: {
        register: registrations,
        unregister: unregistrations,
        observationWindowMs: dynamicWindowMs,
        otherMessages: afterInitialize
          .filter((message) => message.method !== "client/registerCapability" && message.method !== "client/unregisterCapability")
          .map(normalizedJson)
      },
      packageCallback: {
        method: "mmt/typstPackageRequest.v1",
        contextNotification: {
          method: "mmt/typstPackageContext.v1",
          handlerReached: true,
          legacyMethod: "mmt/typstProjectContext.v1",
          legacyResponse: normalizedJson(legacyContextResponse)
        },
        availability: "available",
        networkIsolation: "native artifact receives only host-provided logical package bytes",
        trigger: {
          importUri: packageImport,
          serverRequests: callbackMessages.map(normalizedJson),
          hostResponses: callbackResponses,
          diagnostics: diagnosticMessages
        },
        cancellation: {
          observed: true,
          notifications: cancellationMessages.map(normalizedJson)
        },
        error: { observed: true, channel: "JSON-RPC error response" },
        unavailable: { observed: true, retryable: true }
      },
      previewLocation: {
        advertised: {
          commands: advertisedCommands,
          experimental: capabilities.experimental ?? null
        },
        probes: [
          {
            method: "workspace/executeCommand:tinymist.getDocumentTrace",
            outcome: traceResponse.error ? "error" : "success",
            error: traceResponse.error ?? null,
            resultShape: traceShape
          },
          {
            method: "workspace/executeCommand:tinymist.scrollPreview",
            outcome: scrollResponse.error ? "error" : "success",
            error: scrollResponse.error ?? null,
            resultShape: scrollResponse.result === undefined ? null : typeof scrollResponse.result
          },
          {
            method: "mmt/previewLocation.v1",
            outcome: locationResponse.error ? "error" : "success",
            error: locationResponse.error ?? null,
            resultShape: locationResponse.result === undefined ? null : typeof locationResponse.result
          }
        ],
        coordinateVersion: null,
        qualifiedMethod: null,
        availabilityReason: "artifact exposes preview commands but no versioned location method or coordinate version"
      },
      transcripts: {
        positive: [
          { request: "initialize", outcome: "complete-result" },
          { request: "client/registerCapability", outcome: registrations.length > 0 ? "observed" : "missing" },
          { request: "workspace/configuration", response: configurationPositive },
          { request: "package import", outcome: "host-ready-resolved" },
          { request: "tinymist.getDocumentTrace", outcome: traceResponse.error ? "error" : "success" }
        ],
        negative: [
          { request: "workspace/unknown", response: unknownNegative },
          { request: "mmt/typstPackageRequest.v1 unavailable/error", outcome: "observed" },
          { request: "logical package callback cancellation", outcome: "observed" },
          { request: "tinymist.scrollPreview without focused preview", response: scrollResponse },
          { request: "mmt/previewLocation.v1", response: locationResponse }
        ]
      },
      normalization: {
        recursivelySortedObjectKeys: true,
        semanticallyUnorderedCommandArraysSorted: true,
        volatileFieldsRemoved: [
          "initialize.params.processId",
          "trace.result.request.compilerProgram",
          "trace.result.result.tracingUrl"
        ]
      }
    });
    if (!isTranscriptRecord(normalizedEvidence)) throw new Error("normalized native evidence is invalid");
    return normalizedEvidence;
  } finally {
    nativePackageCallbackHarness = undefined;
    await session.stop();
  }
}

async function verifyCheckedNativeEvidence(command: string): Promise<Record<string, unknown>> {
  const evidence = await captureNativeTinymistEvidence(command);
  const evidencePath = process.env.TINYMIST_NATIVE_EVIDENCE ?? resolve("src/test/fixtures/tinymist-native-evidence.json");
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.env.UPDATE_TINYMIST_NATIVE_EVIDENCE === "1") {
    await writeFile(evidencePath, serialized, "utf8");
  } else {
    const checked = await readFile(evidencePath, "utf8");
    if (checked !== serialized) {
      throw new Error(
        `native Tinymist evidence differs from ${evidencePath}; ` +
        "run with UPDATE_TINYMIST_NATIVE_EVIDENCE=1 only after reviewing the fixed artifact change"
      );
    }
  }
  return evidence;
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
  const nativeEvidence = await verifyCheckedNativeEvidence(command);
  console.log(JSON.stringify({ checkedEvidence: true, evidence: nativeEvidence }, null, 2));
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
      ...fixtureIdentity(1),
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
      ...fixtureIdentity(1),
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
      ...fixtureIdentity(2),
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
      ...fixtureIdentity(2),
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
      ...fixtureIdentity(1),
      entryUri: uriNextSession,
      full: false,
      files: [{ uri: uriNextSession, text: "#let incomplete = 1" }]
    });
    if (client.projectForEntry(uriNextSession)) throw new Error("cross-session process delta was accepted");
    client.syncProject({
      sourceUri,
      sourceVersion: 1,
      revision: 1,
      ...fixtureIdentity(1),
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
      ...fixtureIdentity(3),
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
      ...fixtureIdentity(1),
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
      ...fixtureIdentity(2),
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
