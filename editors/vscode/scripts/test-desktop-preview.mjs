import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const vscodeStub = `
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
export class CancellationError extends Error { constructor() { super("Cancelled"); this.name = "CancellationError"; } }
export const FileType = { File: 1, Directory: 2 };
export class Uri {
  constructor(value) {
    this.value = value;
    const parsed = new URL(value);
    this.scheme = parsed.protocol.slice(0, -1);
    this.authority = parsed.host;
    this.path = parsed.pathname;
    this.query = parsed.search.slice(1);
    this.fragment = parsed.hash.slice(1);
    this.fsPath = this.scheme === "file" ? fileURLToPath(parsed) : this.path;
  }
  static parse(value) { return new Uri(value); }
  static file(value) { return new Uri(pathToFileURL(value).href); }
  static joinPath(base, ...parts) {
    return base.with({ path: path.posix.join(base.path, ...parts) });
  }
  with(change) {
    const parsed = new URL(this.value);
    if (change.path !== undefined) parsed.pathname = change.path;
    if (change.query !== undefined) parsed.search = change.query ? "?" + change.query : "";
    if (change.fragment !== undefined) parsed.hash = change.fragment ? "#" + change.fragment : "";
    return new Uri(parsed.href);
  }
  toString() { return this.value; }
}
export const __host = { documents: [], config: new Map() };
export const workspace = {
  get textDocuments() { return __host.documents; },
  getConfiguration(section) {
    return { get(key, fallback) { return __host.config.get(section + "." + key) ?? fallback; } };
  },
  fs: {
    readFile: async (uri) => new Uint8Array(await fs.readFile(uri.fsPath)),
    writeFile: async (uri, bytes) => fs.writeFile(uri.fsPath, bytes),
    rename: async (from, to) => fs.rename(from.fsPath, to.fsPath),
    delete: async (uri) => fs.rm(uri.fsPath, { recursive: true, force: true }),
    readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true })).map((entry) => [entry.name, entry.isDirectory() ? 2 : 1])
  }
};
export const window = {
  activeTextEditor: undefined,
  showSaveDialog: async () => undefined,
  showWarningMessage: async () => undefined,
  createWebviewPanel() {
    return {
      title: "",
      webview: { html: "" },
      onDidDispose() {},
      reveal() {},
      dispose() {}
    };
  }
};
export const ViewColumn = { Beside: 2 };
`;
const bundle = await build({
  stdin: {
    contents: "export { DesktopPreviewService } from './desktopPreview.ts'; export { Uri, __host } from 'vscode';",
    resolveDir: path.join(root, "src"),
    sourcefile: "desktop-preview-fixture.ts",
    loader: "ts"
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  write: false,
  logLevel: "silent",
  plugins: [{
    name: "vscode-fixture",
    setup(context) {
      context.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
      context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: vscodeStub, loader: "js" }));
    }
  }]
});
const runtime = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const { __host, DesktopPreviewService, Uri } = runtime;
const temp = await mkdtemp(path.join(os.tmpdir(), "mmt-desktop-preview-"));
const sourcePath = path.join(temp, "story.mmt");
const workspaceImagePath = path.join(temp, "workspace-image.png");
await writeFile(sourcePath, "> 佳代子: hello\n");
const avatar = await readFile(path.resolve(root, "../vscode-web/e2e/fixtures/佳代子.png"));
await writeFile(workspaceImagePath, avatar);
const sourceUri = Uri.file(sourcePath);
const document = { uri: sourceUri, languageId: "mmt", version: 1 };
__host.documents.push(document);

const entryUri = "untitled:/mmt-projection/test/session/main-1.typ";
const avatarUri = "untitled:/mmt-projection/test/session/avatar.png";
const workspaceUri = "untitled:/mmt-projection/test/session/workspace-image.png";
const baseProject = {
  sourceUri: sourceUri.toString(), sourceVersion: 1, revision: 1, entryUri,
  files: [{ uri: entryUri, text: "#set page(width: 20pt, height: 20pt)\n#image(\"avatar.png\")\n// REV-A" }],
  full: true, diagnostics: [], projectDigest: "project", mappingDigest: "mapping",
  sourceContent: "source", projectionKey: "projection", packRegistryDigest: "packs",
  resourcePlanDigest: "plan", resourceBytesDigest: "bytes",
  resources: [
    { kind: "image-dir", id: 1, uri: avatarUri, packNamespace: "ba", base: "assets/avatar", fileName: "佳代子.png", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
    { kind: "workspace-file", id: 2, uri: workspaceUri, fileName: "workspace-image.png", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }
  ]
};
let project = baseProject;
const client = { async sendRequest() { return structuredClone(project); } };
const responseFor = (bytes, url) => {
  const response = new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength) } });
  Object.defineProperty(response, "url", { value: url.href });
  return response;
};
const compileChecks = [];
const host = {
  async fetch(url) { return responseFor(avatar, url); },
  async runtimeIdentity() { return { compilerDigest: "compiler-a", fontDigest: "fonts-a" }; },
  async run(command, args, options) {
    assert.equal(command, "tinymist");
    assert.equal(args.includes("--format"), true);
    const output = args.at(-1);
    const entry = args.at(-2);
    const format = args[args.indexOf("--format") + 1];
    const renderRoot = options.cwd;
    const entryText = await readFile(entry, "utf8");
    const revision = entryText.includes("REV-B") ? "B" : "A";
    assert.deepEqual(await readFile(path.join(renderRoot, "avatar.png")), avatar);
    assert.deepEqual(await readFile(path.join(renderRoot, "workspace-image.png")), avatar);
    compileChecks.push(format);
    await writeFile(output, format === "svg" ? `<svg>${revision}</svg>` : `PDF-${revision}`);
  }
};
const service = new DesktopPreviewService(client, "tinymist", Uri.file(path.join(temp, "storage")), host);
service.setPackSources([{
  manifestUrl: "https://packs.example/manifest.json",
  baseUrl: "https://packs.example/",
  json: JSON.stringify({ pack: { namespace: "ba" } })
}]);
const target = Uri.file(path.join(temp, "story.pdf"));
await writeFile(target.fsPath, "OLD");
const previewA = await service.preview(document);
const exported = await service.exportPdf(document, target);
assert.equal(exported.format, "pdf");
assert.equal((await readFile(target.fsPath)).toString(), "PDF-A");
assert.deepEqual(compileChecks, ["svg", "pdf"]);

// Export requires a successfully displayed immutable artifact.
const noPreviewService = new DesktopPreviewService(
  client, "tinymist", Uri.file(path.join(temp, "no-preview-storage")), host
);
await writeFile(target.fsPath, "CURRENT");
await assert.rejects(() => noPreviewService.exportPdf(document, target), /ArtifactUnavailable/);
assert.equal((await readFile(target.fsPath)).toString(), "CURRENT");

// A stale displayed A supports an explicit displayed-A export or wait-latest B export.
document.version = 2;
const entryUriB = entryUri.replace("main-1", "main-2");
project = {
  ...baseProject,
  sourceVersion: 2,
  revision: 2,
  entryUri: entryUriB,
  projectionKey: "projection-b",
  sourceContent: "source-b",
  files: [{ uri: entryUriB, text: "#set page(width: 20pt, height: 20pt)\n#image(\"avatar.png\")\n// REV-B" }]
};
const displayedA = await service.exportPdf(document, target, "export-displayed");
assert.equal(displayedA.sourceVersion, 1);
assert.equal((await readFile(target.fsPath)).toString(), "PDF-A");
assert.equal(displayedA.renderKey, previewA.renderKey);
const latestB = await service.exportPdf(document, target, "wait-for-latest");
assert.equal(latestB.sourceVersion, 2);
assert.equal((await readFile(target.fsPath)).toString(), "PDF-B");
assert.notEqual(latestB.renderKey, previewA.renderKey);

// A current displayed export must not publish if the authored revision advances mid-compile.
const guardedHost = {
  ...host,
  async run(command, args, options) {
    const format = args[args.indexOf("--format") + 1];
    if (format === "svg") return await host.run(command, args, options);
    await writeFile(args.at(-1), "UNSAFE");
    document.version = 3;
  }
};
const guarded = new DesktopPreviewService(client, "tinymist", Uri.file(path.join(temp, "guarded-storage")), guardedHost);
guarded.setPackSources([{
  manifestUrl: "https://packs.example/manifest.json", baseUrl: "https://packs.example/",
  json: JSON.stringify({ pack: { namespace: "ba" } })
}]);
document.version = 2;
await guarded.preview(document);
await writeFile(target.fsPath, "CURRENT");
await assert.rejects(() => guarded.exportPdf(document, target), /revision changed/);
assert.equal((await readFile(target.fsPath)).toString(), "CURRENT");
document.version = 2;

// Compiler/font drift invalidates the displayed artifact before publication.
let runtimeGeneration = "runtime-a";
const driftHost = {
  ...host,
  async runtimeIdentity() {
    return { compilerDigest: runtimeGeneration, fontDigest: "fonts-a" };
  }
};
const drifted = new DesktopPreviewService(client, "tinymist", Uri.file(path.join(temp, "drift-storage")), driftHost);
drifted.setPackSources([{
  manifestUrl: "https://packs.example/manifest.json", baseUrl: "https://packs.example/",
  json: JSON.stringify({ pack: { namespace: "ba" } })
}]);
await drifted.preview(document);
runtimeGeneration = "runtime-b";
await writeFile(target.fsPath, "CURRENT");
await assert.rejects(() => drifted.exportPdf(document, target), /compiler or font inputs changed/);
assert.equal((await readFile(target.fsPath)).toString(), "CURRENT");

// Runtime identity is checked again after compilation to close the publication TOCTOU.
let midflightRuntime = "runtime-a";
let advanceDuringPdf = false;
const midflightHost = {
  ...host,
  async runtimeIdentity() {
    return { compilerDigest: midflightRuntime, fontDigest: "fonts-a" };
  },
  async run(command, args, options) {
    await host.run(command, args, options);
    if (advanceDuringPdf && args.includes("pdf")) midflightRuntime = "runtime-b";
  }
};
const midflight = new DesktopPreviewService(client, "tinymist", Uri.file(path.join(temp, "midflight-storage")), midflightHost);
midflight.setPackSources([{
  manifestUrl: "https://packs.example/manifest.json", baseUrl: "https://packs.example/",
  json: JSON.stringify({ pack: { namespace: "ba" } })
}]);
await midflight.preview(document);
advanceDuringPdf = true;
await writeFile(target.fsPath, "CURRENT");
await assert.rejects(() => midflight.exportPdf(document, target), /changed during export/);
assert.equal((await readFile(target.fsPath)).toString(), "CURRENT");

// Starting a newer export aborts the older compile and only the newer target publishes.
project = {
  ...baseProject,
  sourceVersion: 2,
  revision: 2,
  projectionKey: "overlap",
  resources: []
};
let firstStartedResolve;
const firstStarted = new Promise((resolve) => { firstStartedResolve = resolve; });
let compileCall = 0;
const overlapHost = {
  async fetch() { throw new Error("unexpected fetch"); },
  async runtimeIdentity() { return { compilerDigest: "compiler-a", fontDigest: "fonts-a" }; },
  async run(_command, args, options) {
    compileCall += 1;
    if (compileCall === 1) {
      await writeFile(args.at(-1), "<svg/>");
      return;
    }
    if (compileCall === 2) {
      firstStartedResolve();
      await new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return;
    }
    await writeFile(args.at(-1), "NEWER");
  }
};
const overlap = new DesktopPreviewService(client, "tinymist", Uri.file(path.join(temp, "overlap-storage")), overlapHost);
await overlap.preview(document);
const firstTarget = Uri.file(path.join(temp, "first.pdf"));
const secondTarget = Uri.file(path.join(temp, "second.pdf"));
await writeFile(firstTarget.fsPath, "FIRST-OLD");
const first = overlap.exportPdf(document, firstTarget);
await firstStarted;
const second = overlap.exportPdf(document, secondTarget);
await assert.rejects(first, (error) => error?.name === "CancellationError");
await second;
assert.equal((await readFile(firstTarget.fsPath)).toString(), "FIRST-OLD");
assert.equal((await readFile(secondTarget.fsPath)).toString(), "NEWER");

// Sequence integrity is checked before invoking avifdec.
document.version = 1;
const sequence = new Uint8Array([1, 2, 3, 4]);
project = {
  ...baseProject,
  resources: [{
    kind: "image-sequence", id: 9, uri: avatarUri, packNamespace: "ba", path: "bad.avifs",
    frame: 0, sha256: "0".repeat(64), size: [1, 1], frameCount: 1,
    container: "avifs", codec: "av1", alpha: true, profile: {},
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  }]
};
let decoderCalled = false;
const sequenceHost = {
  async fetch(url) { return responseFor(sequence, url); },
  async runtimeIdentity() { return { compilerDigest: "compiler-a", fontDigest: "fonts-a" }; },
  async run() { decoderCalled = true; }
};
const sequenceService = new DesktopPreviewService(client, "tinymist", Uri.file(path.join(temp, "sequence-storage")), sequenceHost);
sequenceService.setPackSources([{
  manifestUrl: "https://packs.example/manifest.json", baseUrl: "https://packs.example/",
  json: JSON.stringify({ pack: { namespace: "ba" } })
}]);
await assert.rejects(() => sequenceService.preview(document), /digest mismatch/);
assert.equal(decoderCalled, false);

// A digest-valid sequence still fails if avifdec reports the wrong dimensions.
const digest = (await import("node:crypto")).createHash("sha256").update(sequence).digest("hex");
project = { ...project, resources: [{ ...project.resources[0], sha256: digest, size: [2, 2] }] };
const wrongSizeHost = {
  async fetch(url) { return responseFor(sequence, url); },
  async runtimeIdentity() { return { compilerDigest: "compiler-a", fontDigest: "fonts-a" }; },
  async run(command, args) {
    if (command !== "avifdec") throw new Error("compile must not run after invalid decoded dimensions");
    const png = Buffer.alloc(24);
    Buffer.from("89504e470d0a1a0a", "hex").copy(png, 0);
    png.write("IHDR", 12, "ascii");
    png.writeUInt32BE(1, 16); png.writeUInt32BE(1, 20);
    await writeFile(args.at(-1), png);
  }
};
const wrongSize = new DesktopPreviewService(client, "tinymist", Uri.file(path.join(temp, "wrong-size-storage")), wrongSizeHost);
wrongSize.setPackSources([{
  manifestUrl: "https://packs.example/manifest.json", baseUrl: "https://packs.example/",
  json: JSON.stringify({ pack: { namespace: "ba" } })
}]);
await assert.rejects(() => wrongSize.preview(document), /returned 1x1; expected 2x2/);

service.dispose(); noPreviewService.dispose(); guarded.dispose(); drifted.dispose(); midflight.dispose();
overlap.dispose(); sequenceService.dispose(); wrongSize.dispose();
await rm(temp, { recursive: true, force: true });
console.log(JSON.stringify({
  avatarAndWorkspaceMaterialized: true,
  displayedAAndWaitLatestB: true,
  stalePublicationRejected: true,
  runtimeDriftRejected: true,
  runtimeMidflightRejected: true,
  overlappingExportAborted: true,
  sequenceDigestRejected: true,
  sequenceDimensionsRejected: true
}));
