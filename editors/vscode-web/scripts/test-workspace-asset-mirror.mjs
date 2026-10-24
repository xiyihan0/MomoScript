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
    if (uri.toString() === "mmtfs://workspace/") return [["basic.png", 1], ["nested", 2], ["notes.txt", 1], ["..", 2], ["../escape.png", 1], ["bad:name.png", 1], ["bad\u0001.png", 1]];
    if (uri.toString() === "mmtfs://workspace/nested") return [["other.webp", 1]];
    if (uri.toString() === "mmtfs://full/") return Array.from({ length: 256 }, (_, index) => [`unused-${index}.png`, 1]);
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
  resources: [],
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

const importedPath = "mmtfs://workspace/nested/assets/59a6add6-4513-4b79-a4f8-851fb9a18dd4.png";
files.set(importedPath, Uint8Array.from([3, 1, 4]));
for (const listener of listeners.create) listener({
  toString: () => importedPath, scheme: "mmtfs", authority: "workspace",
  path: "/nested/assets/59a6add6-4513-4b79-a4f8-851fb9a18dd4.png",
});
const nestedProject = {
  sourceUri: "mmtfs://workspace/nested/chapter.mmt",
  entryUri: "untitled:/nested-session/main.typ",
  files: [],
  resources: [],
};
const nested = await mirror.snapshot(nestedProject, signal);
assert.deepEqual(nested.map((file) => file.uri), ["untitled:/nested-session/assets/59a6add6-4513-4b79-a4f8-851fb9a18dd4.png"]);
assert.equal(nested[0].dataBase64, Buffer.from([3, 1, 4]).toString("base64"));
const nestedWarm = await mirror.snapshot({ ...nestedProject, files: nested }, signal);
assert.deepEqual(nestedWarm, [], "already retained nested resources must not be duplicated");
const nestedDeclared = await mirror.snapshot({
  ...nestedProject,
  resources: [{
    kind: "workspace-file", id: 0, uri: "untitled:/nested-session/mmt-resources/0.png",
    fileName: "assets/59a6add6-4513-4b79-a4f8-851fb9a18dd4.png",
  }],
}, signal);
assert.equal(nestedDeclared.find((file) => file.uri === "untitled:/nested-session/mmt-resources/0.png")?.dataBase64, nested[0].dataBase64, "generated local-resource aliases must read paths relative to the nested source document");
assert.ok(nestedDeclared.some((file) => file.uri === nested[0].uri), "unclaimed raw authored image paths must remain available beside the semantic asset alias");

const readsBeforeUnsafePaths = reads;
for (const unsafePath of ["/nested/assets/../escape.png", "/nested/assets\\escape.png", "/nested/assets/bad:name.png", "/nested/assets/bad\u0001.png"]) {
  for (const listener of listeners.create) listener({
    toString: () => `mmtfs://workspace${unsafePath}`, scheme: "mmtfs", authority: "workspace", path: unsafePath,
  });
}
assert.deepEqual(await mirror.snapshot(nestedProject, signal), nested);
assert.equal(reads, readsBeforeUnsafePaths, "unsafe watcher paths must never be read or mirrored");

const reservedLookingPath = "mmtfs://workspace/mmt-resources/0.png";
files.set(reservedLookingPath, Uint8Array.from([8, 6, 7]));
for (const listener of listeners.create) listener({
  toString: () => reservedLookingPath, scheme: "mmtfs", authority: "workspace", path: "/mmt-resources/0.png",
});
const mixedProject = {
  ...project,
  entryUri: "untitled:/mixed/main.typ",
  resources: [
    { kind: "image-dir", id: 0, uri: "untitled:/mixed/mmt-resources/0.png", packNamespace: "base", base: "avatars", fileName: "pack.png" },
    { kind: "workspace-file", id: 1, uri: "untitled:/mixed/mmt-resources/1.png", fileName: "mmt-resources/0.png" },
  ],
};
const mixed = await mirror.snapshot(mixedProject, signal);
assert.equal(mixed.some((file) => file.uri === mixedProject.resources[0].uri), false, "raw local files must not claim pack resource identities");
assert.equal(mixed.find((file) => file.uri === mixedProject.resources[1].uri)?.dataBase64, Buffer.from([8, 6, 7]).toString("base64"), "declared local files must use the generated workspace resource identity");
assert.ok(mixed.some((file) => file.uri === "untitled:/mixed/basic.png"), "unclaimed authored image paths must remain mirrored");
assert.equal(new Set(mixed.map((file) => file.uri)).size, mixed.length);
const retainedMixed = await mirror.snapshot({ ...mixedProject, files: mixed }, signal);
assert.deepEqual(retainedMixed, [], "generated workspace aliases must not duplicate retained project files");

for (let index = 0; index < 256; index += 1) files.set(`mmtfs://full/unused-${index}.png`, Uint8Array.from([index % 256]));
const fullProject = { sourceUri: "mmtfs://full/story.mmt", entryUri: "untitled:/full-session/main.typ", files: [], resources: [] };
const full = await mirror.snapshot(fullProject, signal);
assert.equal(full.length, WorkspaceAssetMirror.MAX_FILES);
const newReferencedPath = "mmtfs://full/assets/new.png";
files.set(newReferencedPath, Uint8Array.from([5, 4, 3, 2, 1]));
for (const listener of listeners.create) listener({
  toString: () => newReferencedPath, scheme: "mmtfs", authority: "full", path: "/assets/new.png",
});
const requestedFullProject = {
  ...fullProject,
  resources: [{ kind: "workspace-file", id: 0, uri: "untitled:/full-session/mmt-resources/0.png", fileName: "assets/new.png" }],
};
const requestedFull = await mirror.snapshot(requestedFullProject, signal);
assert.equal(requestedFull.find((file) => file.uri === requestedFullProject.resources[0].uri)?.dataBase64, Buffer.from([5, 4, 3, 2, 1]).toString("base64"), "unreferenced cache occupancy must not hide a newly declared image");
assert.ok(requestedFull.length <= WorkspaceAssetMirror.MAX_FILES, "prioritizing a declared image must preserve the existing project file limit");
const readsBeforeRequestedWarm = reads;
assert.deepEqual(await mirror.snapshot(requestedFullProject, signal), requestedFull);
assert.equal(reads, readsBeforeRequestedWarm, "the existing cache must retain the explicitly requested image after evicting an unreferenced entry");

const cancelledProject = {
  sourceUri: "mmtfs://cancel/story.mmt",
  entryUri: "untitled:/cancel-session/main.typ",
  files: [],
  resources: [],
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
console.log(JSON.stringify({ warmReads: 2, changeReads: 1, deleteReads: 0, nestedSourceRelativeAssets: true, unsafePathsRejected: true, generatedWorkspaceAlias: true, packResourceIdentityProtected: true, authoredImagePathsRetained: true, requestedImageSurvivesFullCache: true, cancellationRecovered: true, watcherDisposed: true }));
