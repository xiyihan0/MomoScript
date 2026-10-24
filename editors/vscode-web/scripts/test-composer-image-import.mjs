import assert from "node:assert/strict";
import { File } from "node:buffer";
import { build } from "esbuild";

const fixture = {
  selected: null,
  directories: [],
  writes: [],
  deleted: [],
  files: new Map(),
  writable: true,
  sourceVersion: 1,
  workspace: { workspaceId: "workspace-1", backendGeneration: 1, headSequence: 0 },
  decode: async () => {},
};
globalThis.__composerImageImportFixture = fixture;
const bundle = await build({
  stdin: {
    contents: "export { importComposerLocalImage } from './composerImageImport.ts'; export { Uri, FileSystemError } from 'vscode';",
    resolveDir: new URL("../src", import.meta.url).pathname,
    sourcefile: "composer-image-import-fixture.ts",
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [{
    name: "vscode-fixture",
    setup(context) {
      context.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
      context.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        loader: "js",
        contents: `
          import path from "node:path";
          const fixture = globalThis.__composerImageImportFixture;
          export class Uri {
            constructor(value) { const url = new URL(value); this.value = url.href; this.scheme = url.protocol.slice(0, -1); this.authority = url.host; this.path = url.pathname; this.query = url.search.slice(1); this.fragment = url.hash.slice(1); }
            static parse(value) { return new Uri(value); }
            static joinPath(base, ...parts) { const url = new URL(base.value); url.pathname = path.posix.join(url.pathname, ...parts); return new Uri(url.href); }
            toString() { return this.value; }
          }
          export class FileSystemError extends Error { constructor(code) { super(code); this.code = code; } }
          export const FileType = { File: 1, Directory: 2, SymbolicLink: 64 };
          export const workspace = { fs: { async createDirectory(uri) { fixture.directories.push(uri.toString()); } } };
        `,
      }));
    },
  }],
});
const { importComposerLocalImage, Uri, FileSystemError } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
const originalDocument = globalThis.document;
const originalImage = globalThis.Image;
globalThis.document = {
  body: { append() {} },
  createElement() {
    const input = new EventTarget();
    input.remove = () => {};
    input.click = () => {
      input.files = fixture.selected ? [fixture.selected] : [];
      input.dispatchEvent(new Event(fixture.selected ? "change" : "cancel"));
    };
    return input;
  },
};
globalThis.Image = class {
  naturalWidth = 1;
  naturalHeight = 1;
  decode() { return fixture.decode(); }
  removeAttribute() {}
};
const provider = {
  coordinator: { get state() { return { metadata: fixture.workspace }; } },
  async writeFile(uri, bytes) {
    const key = uri.toString();
    if (fixture.files.has(key)) throw new FileSystemError("FileExists");
    fixture.writes.push(key);
    fixture.files.set(key, bytes.slice());
    fixture.workspace.headSequence += 1;
  },
  readFile(uri) {
    const bytes = fixture.files.get(uri.toString());
    if (!bytes) throw new FileSystemError("FileNotFound");
    return bytes.slice();
  },
  async delete(uri) {
    fixture.deleted.push(uri.toString());
    fixture.files.delete(uri.toString());
    fixture.workspace.headSequence += 1;
  },
};
const source = Uri.parse("mmtfs://workspace/books/chapter.mmt");
const workspace = Uri.parse("mmtfs://workspace/");
const importImage = () => {
  const sourceVersion = fixture.sourceVersion;
  return importComposerLocalImage(source, workspace, provider, () => fixture.writable,
    () => fixture.sourceVersion === sourceVersion, new AbortController().signal);
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvNsAAAAASUVORK5CYII=", "base64");
const existing = "mmtfs://workspace/books/assets/existing.png";
fixture.files.set(existing, Uint8Array.from([7]));

assert.equal(await importImage(), null);
assert.equal(fixture.writes.length, 0);
fixture.selected = new File(["not an image"], "fake.png", { type: "image/png" });
await assert.rejects(importImage, /PNG 或 JPEG/);
assert.equal(fixture.directories.length, 0);
fixture.selected = { size: 8 * 1024 * 1024 + 1, arrayBuffer() { throw new Error("oversized input must not be read"); } };
await assert.rejects(importImage, /8 MiB/);
assert.equal(fixture.directories.length, 0);
fixture.selected = new File([png], "../../untrusted.jpg", { type: "image/jpeg" });
fixture.decode = async () => { throw new Error("decoder refused image"); };
await assert.rejects(importImage, /无法解码/);
assert.equal(fixture.writes.length, 0);
assert.equal(fixture.directories.length, 0);

const started = Promise.withResolvers();
const decoded = Promise.withResolvers();
fixture.decode = () => { started.resolve(); return decoded.promise; };
const pending = importImage();
await started.promise;
assert.equal(fixture.writes.length, 0, "image bytes must decode before any file write");
assert.equal(fixture.directories.length, 0, "image bytes must decode before creating assets directory");
decoded.resolve();
const rejected = await pending;
assert.match(rejected.media.relativePath, /^assets\/[0-9a-f-]{36}\.png$/);
assert.equal(fixture.directories.at(-1), "mmtfs://workspace/books/assets");
assert.equal(fixture.writes.at(-1), `mmtfs://workspace/books/${rejected.media.relativePath}`);
await rejected.finish(false);
assert.equal(fixture.files.has(fixture.writes.at(-1)), false);
assert.deepEqual(fixture.files.get(existing), Uint8Array.from([7]));

fixture.decode = async () => {};
const accepted = await importImage();
const acceptedPath = fixture.writes.at(-1);
await accepted.finish(true);
await accepted.finish(false);
assert.deepEqual(fixture.files.get(acceptedPath), new Uint8Array(png));
const changed = await importImage();
const changedPath = fixture.writes.at(-1);
fixture.files.set(changedPath, Uint8Array.from([9]));
await changed.finish(false);
assert.deepEqual(fixture.files.get(changedPath), Uint8Array.from([9]), "cleanup must not delete a replaced file");

const referenced = await importImage();
const referencedPath = fixture.writes.at(-1);
fixture.sourceVersion += 1;
await referenced.finish(false);
assert.deepEqual(fixture.files.get(referencedPath), new Uint8Array(png), "a native source edit may accept a reference while the original insertion is pending");
const workspaceChanged = await importImage();
const workspaceChangedPath = fixture.writes.at(-1);
fixture.workspace.headSequence += 1;
await workspaceChanged.finish(false);
assert.deepEqual(fixture.files.get(workspaceChangedPath), new Uint8Array(png), "cleanup must retain the file when another persisted workspace change makes reference ownership uncertain");

fixture.decode = async () => { fixture.writable = false; };
const writesBeforePermissionChange = fixture.writes.length;
await assert.rejects(importImage, /编辑权限已改变/);
assert.equal(fixture.writes.length, writesBeforePermissionChange);
assert.deepEqual(fixture.files.get(existing), Uint8Array.from([7]));
globalThis.document = originalDocument;
globalThis.Image = originalImage;
delete globalThis.__composerImageImportFixture;
console.log(JSON.stringify({ cancellation: true, pngSignature: true, perFileBudget: true, decodeBeforeWrite: true, sourceRelativeUuidPath: true, rejectionCleanup: true, acceptedFileRetained: true, sourceChangeRetainsImport: true, workspaceChangeRetained: true, replacedFileRetained: true, permissionChangeRejected: true }));
