import assert from "node:assert/strict";
import { build } from "esbuild";

const result = await build({
  entryPoints: [new URL("../src/workspaceAssetMirror.ts", import.meta.url).pathname],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [{
    name: "vscode-fixture",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
      buildApi.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        loader: "js",
        contents: `
          const fixture = globalThis.__workspaceMirrorFixture;
          export class Uri {
            constructor(value) { this.value = value; const parsed = new URL(value); this.scheme = parsed.protocol.slice(0, -1); this.authority = parsed.host; this.path = parsed.pathname; }
            static parse(value) { return new Uri(value); }
            static joinPath(base, ...segments) { const suffix = segments.map((part) => encodeURIComponent(part)).join("/"); return new Uri(base.value.replace(/\\/$/, "") + "/" + suffix); }
            with(change) { const parsed = new URL(this.value); if (change.path !== undefined) parsed.pathname = change.path; return new Uri(parsed.toString()); }
            toString() { return this.value; }
          }
          export const FileType = { File: 1, Directory: 2 };
          export const workspace = {
            fs: {
              readDirectory: (uri) => fixture.readDirectory(uri),
              readFile: (uri) => fixture.readFile(uri),
            },
            createFileSystemWatcher: () => fixture.createWatcher(),
          };
        `,
      }));
    },
  }],
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`;

const files = new Map([
  ["mmtfs://workspace/basic.png", Uint8Array.from([1, 2, 3])],
  ["mmtfs://workspace/nested/other.webp", Uint8Array.from([4, 5])],
  ["mmtfs://cancel/later.png", Uint8Array.from([6])],
]);
const listeners = { create: new Set(), change: new Set(), delete: new Set() };
let reads = 0;
let disposed = false;
let releaseCancelledScan;
const cancelledScanGate = new Promise((resolve) => { releaseCancelledScan = resolve; });
globalThis.__workspaceMirrorFixture = {
  async readDirectory(uri) {
    if (uri.toString() === "mmtfs://workspace/") return [["basic.png", 1], ["nested", 2], ["notes.txt", 1]];
    if (uri.toString() === "mmtfs://workspace/nested") return [["other.webp", 1]];
    if (uri.toString() === "mmtfs://cancel/") {
      await cancelledScanGate;
      return [["later.png", 1]];
    }
    return [];
  },
  async readFile(uri) {
    reads += 1;
    const value = files.get(uri.toString());
    if (!value) throw new Error(`missing fixture file ${uri}`);
    return value;
  },
  createWatcher() {
    return {
      onDidCreate(callback) { listeners.create.add(callback); return { dispose: () => listeners.create.delete(callback) }; },
      onDidChange(callback) { listeners.change.add(callback); return { dispose: () => listeners.change.delete(callback) }; },
      onDidDelete(callback) { listeners.delete.add(callback); return { dispose: () => listeners.delete.delete(callback) }; },
      dispose() { disposed = true; },
    };
  },
};

const { WorkspaceAssetMirror } = await import(moduleUrl);
const mirror = new WorkspaceAssetMirror(true);
const project = {
  sourceUri: "mmtfs://workspace/story.mmt",
  entryUri: "untitled:/session/main.typ",
  files: [],
};
const signal = new AbortController().signal;
const first = await mirror.snapshot(project, signal);
assert.equal(first.length, 2);
assert.equal(reads, 2);
assert.deepEqual(first.map((file) => new URL(file.uri).pathname), ["/session/basic.png", "/session/nested/other.webp"]);

const warm = await mirror.snapshot(project, signal);
assert.equal(reads, 2, "unchanged warm snapshots must not rescan workspace files");
assert.deepEqual(warm, first);

files.set("mmtfs://workspace/basic.png", Uint8Array.from([9, 8, 7]));
for (const listener of listeners.change) listener({ toString: () => "mmtfs://workspace/basic.png", scheme: "mmtfs", authority: "workspace", path: "/basic.png" });
await new Promise((resolve) => setTimeout(resolve, 0));
const changed = await mirror.snapshot(project, signal);
assert.equal(reads, 3);
assert.notEqual(changed.find((file) => file.uri.endsWith("basic.png"))?.digest, first.find((file) => file.uri.endsWith("basic.png"))?.digest);

files.delete("mmtfs://workspace/nested/other.webp");
for (const listener of listeners.delete) listener({ toString: () => "mmtfs://workspace/nested/other.webp", scheme: "mmtfs", authority: "workspace", path: "/nested/other.webp" });
await new Promise((resolve) => setTimeout(resolve, 0));
const deleted = await mirror.snapshot(project, signal);
assert.deepEqual(deleted.map((file) => file.uri), ["untitled:/session/basic.png"]);

const cancelledProject = {
  sourceUri: "mmtfs://cancel/story.mmt",
  entryUri: "untitled:/cancel-session/main.typ",
  files: [],
};
const cancelled = new AbortController();
const interrupted = mirror.snapshot(cancelledProject, cancelled.signal);
cancelled.abort();
await assert.rejects(interrupted, (error) => error?.name === "AbortError");
releaseCancelledScan();
const recovered = await mirror.snapshot(cancelledProject, new AbortController().signal);
assert.deepEqual(recovered.map((file) => file.uri), ["untitled:/cancel-session/later.png"]);

mirror.dispose();
assert.equal(disposed, true);
assert.equal([...Object.values(listeners)].every((set) => set.size === 0), true);
delete globalThis.__workspaceMirrorFixture;
console.log(JSON.stringify({ warmReads: 2, changeReads: 1, deleteReads: 0, cancellationRecovered: true, watcherDisposed: true }));
