import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";

import type { PackManifestSource } from "./packSync";
import {
  materializeProjectResources,
  type MaterializationPackSource,
  type ResourceMaterializationDependencies,
  type ResourceMaterializationLimits,
  type StringResourceCache
} from "./resourceMaterializer";
import type { TypstRenderProjectUpdate, TypstResourceRequest, TypstVirtualFile } from "./tinymistClient";

const executeFile = promisify(execFile);
const MAX_WORKSPACE_FILE_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_RESOURCE_BYTES = 32 * 1024 * 1024;

type RenderFormat = "svg" | "pdf";
type ImageSequenceResource = Extract<TypstResourceRequest, { kind: "image-sequence" }>;

interface RenderOperation {
  readonly generation: number;
  readonly sourceUri: string;
  readonly sourceVersion: number;
  readonly signal: AbortSignal;
}

export interface DesktopRenderRuntimeIdentity {
  readonly compilerDigest: string;
  readonly fontDigest: string;
}

interface DisplayedDesktopArtifact {
  readonly sourceUri: string;
  readonly project: TypstRenderProjectUpdate;
  readonly runtime: DesktopRenderRuntimeIdentity;
  readonly renderKey: string;
}

export type DesktopStaleExportChoice = "export-displayed" | "wait-for-latest";

export interface DesktopPreviewHost {
  run(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly signal: AbortSignal;
      readonly timeout: number;
      readonly maxBuffer: number;
    }
  ): Promise<unknown>;
  fetch(url: URL, signal: AbortSignal): Promise<Response>;
  runtimeIdentity(command: string): Promise<DesktopRenderRuntimeIdentity>;
}

const DEFAULT_DESKTOP_PREVIEW_HOST: DesktopPreviewHost = {
  run: async (command, args, options) => await executeFile(command, [...args], options),
  fetch: async (url, signal) => await fetch(url, { signal, redirect: "follow" }),
  runtimeIdentity: async (command) => await nativeRenderRuntimeIdentity(command)
};

export interface DesktopRenderResult {
  readonly sourceUri: string;
  readonly sourceVersion: number;
  readonly revision: number;
  readonly format: RenderFormat;
  readonly outputUri: vscode.Uri;
  readonly renderKey: string;
}

export class DesktopArtifactUnavailableError extends Error {
  override readonly name = "ArtifactUnavailable";
}

/** Revision-bound native preview/export using the pinned Tinymist compiler. */
export class DesktopPreviewService implements vscode.Disposable {
  private readonly packSources = new Map<string, MaterializationPackSource>();
  private readonly resourceCache = new BoundedResourceCache(64 * 1024 * 1024);
  private previewPanel: vscode.WebviewPanel | undefined;
  private displayedArtifact: DisplayedDesktopArtifact | undefined;
  private generation = 0;
  private active: AbortController | undefined;

  constructor(
    private readonly client: BaseLanguageClient,
    private readonly tinymistCommand: string,
    private readonly storageRoot: vscode.Uri,
    private readonly host: DesktopPreviewHost = DEFAULT_DESKTOP_PREVIEW_HOST
  ) {}

  setPackSources(sources: readonly PackManifestSource[]): void {
    const next = new Map<string, MaterializationPackSource>();
    for (const source of sources) {
      const manifest = JSON.parse(source.json) as { pack?: { namespace?: unknown } };
      const namespace = manifest.pack?.namespace;
      if (typeof namespace !== "string" || namespace.length === 0) {
        throw new Error(`Pack manifest has no namespace: ${source.manifestUrl}`);
      }
      const cacheIdentity = createHash("sha256")
        .update(source.manifestUrl)
        .update("\0")
        .update(source.json)
        .digest("hex");
      next.set(namespace, Object.freeze({ ...source, cacheIdentity }));
    }
    this.packSources.clear();
    for (const [namespace, source] of next) this.packSources.set(namespace, source);
  }

  async preview(document = vscode.window.activeTextEditor?.document): Promise<DesktopRenderResult> {
    const source = requireMmtDocument(document);
    const operation = this.begin(source);
    const runtime = await this.host.runtimeIdentity(this.tinymistCommand);
    const prepared = await this.prepare(source, operation);
    const output = path.join(prepared.root, "preview.svg");
    await this.compile(prepared.entry, prepared.root, output, "svg", operation.signal);
    const completedRuntime = await this.host.runtimeIdentity(this.tinymistCommand);
    if (!runtimeIdentityMatches(runtime, completedRuntime)) {
      throw new DesktopArtifactUnavailableError(
        "ArtifactUnavailable: Desktop compiler or font inputs changed during preview"
      );
    }
    this.assertCurrent(operation);
    const svg = await fs.readFile(output);
    const renderKey = desktopRenderKey(prepared.project, runtime);
    this.displayedArtifact = Object.freeze({
      sourceUri: operation.sourceUri,
      project: prepared.project,
      runtime,
      renderKey
    });
    const panel = this.previewPanel ?? vscode.window.createWebviewPanel(
      "mmt.preview",
      "MomoScript Preview",
      vscode.ViewColumn.Beside,
      { enableScripts: false, retainContextWhenHidden: true }
    );
    this.previewPanel = panel;
    panel.onDidDispose(() => {
      if (this.previewPanel === panel) this.previewPanel = undefined;
    });
    panel.title = `MomoScript Preview — ${path.basename(source.uri.path)}`;
    panel.webview.html = previewHtml(svg.toString("base64"));
    panel.reveal(vscode.ViewColumn.Beside, true);
    return Object.freeze({
      sourceUri: operation.sourceUri,
      sourceVersion: prepared.project.sourceVersion,
      revision: prepared.project.revision,
      format: "svg" as const,
      outputUri: vscode.Uri.file(output),
      renderKey
    });
  }

  async exportPdf(
    document = vscode.window.activeTextEditor?.document,
    destination?: vscode.Uri,
    staleChoice?: DesktopStaleExportChoice
  ): Promise<DesktopRenderResult | undefined> {
    const source = requireMmtDocument(document);
    const target = destination ?? await vscode.window.showSaveDialog({
      defaultUri: defaultPdfUri(source),
      filters: { PDF: ["pdf"] },
      saveLabel: "Export exact MomoScript revision"
    });
    if (target === undefined) return undefined;
    if (target.scheme !== "file") throw new Error("Desktop PDF export requires a file destination");

    let artifact = this.displayedArtifact?.sourceUri === source.uri.toString()
      ? this.displayedArtifact
      : undefined;
    if (!artifact) {
      throw new DesktopArtifactUnavailableError(
        "ArtifactUnavailable: preview this MomoScript document before exporting"
      );
    }
    let allowStalePublication = false;
    if (artifact.project.sourceVersion !== source.version) {
      const selected = staleChoice ?? await staleExportChoice();
      if (selected === undefined) return undefined;
      if (selected === "wait-for-latest") {
        await this.preview(source);
        artifact = this.displayedArtifact;
        if (!artifact || artifact.sourceUri !== source.uri.toString()) {
          throw new DesktopArtifactUnavailableError(
            "ArtifactUnavailable: latest preview did not produce an exportable artifact"
          );
        }
      } else {
        allowStalePublication = true;
      }
    }

    const operation = this.begin(source);
    const project = artifact.project;
    const runtime = await this.host.runtimeIdentity(this.tinymistCommand);
    if (!runtimeIdentityMatches(runtime, artifact.runtime)) {
      throw new DesktopArtifactUnavailableError(
        "ArtifactUnavailable: Desktop compiler or font inputs changed after the displayed preview"
      );
    }
    const root = path.join(
      this.storageRoot.fsPath,
      "desktop-export",
      `${project.projectionKey}-${operation.generation}`
    );

    await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
    const staging = vscode.Uri.file(path.join(
      path.dirname(target.fsPath),
      `.${path.basename(target.fsPath)}.mmt-${project.projectionKey}.tmp.pdf`
    ));
    try {
      await fs.rm(root, { recursive: true, force: true });
      await fs.mkdir(root, { recursive: true });
      const entry = await materializeProject(project, root);
      await this.compile(entry, root, staging.fsPath, "pdf", operation.signal);
      const completedRuntime = await this.host.runtimeIdentity(this.tinymistCommand);
      if (!runtimeIdentityMatches(completedRuntime, artifact.runtime)) {
        throw new DesktopArtifactUnavailableError(
          "ArtifactUnavailable: Desktop compiler or font inputs changed during export"
        );
      }
      if (allowStalePublication) this.assertActive(operation);
      else this.assertCurrent(operation);
      await vscode.workspace.fs.rename(staging, target, { overwrite: true });
    } catch (error) {
      await Promise.resolve(vscode.workspace.fs.delete(staging)).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
    return Object.freeze({
      sourceUri: project.sourceUri,
      sourceVersion: project.sourceVersion,
      revision: project.revision,
      format: "pdf" as const,
      outputUri: target,
      renderKey: artifact.renderKey
    });
  }

  dispose(): void {
    this.generation += 1;
    this.active?.abort();
    this.active = undefined;
    this.previewPanel?.dispose();
    this.previewPanel = undefined;
    this.displayedArtifact = undefined;
  }

  private begin(source: vscode.TextDocument): RenderOperation {
    this.active?.abort();
    const controller = new AbortController();
    this.active = controller;
    return Object.freeze({
      generation: ++this.generation,
      sourceUri: source.uri.toString(),
      sourceVersion: source.version,
      signal: controller.signal
    });
  }

  private async prepare(
    source: vscode.TextDocument,
    operation: RenderOperation
  ): Promise<{ readonly project: TypstRenderProjectUpdate; readonly root: string; readonly entry: string }> {
    let project = await this.client.sendRequest<TypstRenderProjectUpdate | null>(
      "mmt/getTypstRenderProject",
      { uri: operation.sourceUri }
    );
    this.assertCurrent(operation);
    if (project === null || project.sourceUri !== operation.sourceUri || project.sourceVersion !== operation.sourceVersion) {
      throw new Error("MomoScript render project is stale or unavailable");
    }
    const errors = project.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("\n"));
    const root = path.join(this.storageRoot.fsPath, "desktop-render", String(project.projectionKey));
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });
    project = await mirrorWorkspaceResources(source, project, operation.signal);
    const materialized = await materializeProjectResources(
      project,
      this.packSources,
      this.resourceCache,
      operation.signal,
      this.materializationDependencies(root),
      configuredResourceLimits()
    );
    if (materialized.diagnostics.length > 0) {
      throw new Error(materialized.diagnostics.map((diagnostic) => `${diagnostic.phase}: ${diagnostic.message}`).join("\n"));
    }
    project = materialized.project;
    const entry = await materializeProject(project, root);
    this.assertCurrent(operation);
    return { project, root, entry };
  }

  private materializationDependencies(root: string): ResourceMaterializationDependencies {
    return {
      resourceUrl: (source, resource) => {
        if (resource.kind === "workspace-file") throw new Error("Workspace resources do not have pack URLs");
        return packResourceUrl(
          source.baseUrl,
          resource.kind === "image-dir" ? `${resource.base}/${resource.fileName}` : resource.path,
          resource.kind
        );
      },
      fetch: async (url, signal) => await fetchResource(
        url,
        configuredMaxFileBytes(),
        signal,
        this.host.fetch
      ),
      decodeSequence: async (bytes, resource, signal) => await this.decodeSequence(root, bytes, resource, signal),
      encodeBase64: (bytes) => Buffer.from(bytes).toString("base64"),
      decodeBase64: (value) => Buffer.from(value, "base64")
    };
  }

  private async decodeSequence(
    root: string,
    bytes: Uint8Array,
    resource: ImageSequenceResource,
    signal: AbortSignal
  ): Promise<Uint8Array> {
    if (resource.container !== "avifs" || resource.codec !== "av1") {
      throw new Error(`Unsupported image sequence ${resource.container}/${resource.codec}`);
    }
    if (!Number.isSafeInteger(resource.frame) || resource.frame < 0 || resource.frame >= resource.frameCount) {
      throw new Error(`AVIFS frame ${resource.frame} is outside frameCount ${resource.frameCount}`);
    }
    const pixels = resource.size[0] * resource.size[1];
    if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > 16_777_216) {
      throw new Error(`AVIFS canvas ${resource.size.join("x")} exceeds the native decode limit`);
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (!/^[0-9a-f]{64}$/u.test(resource.sha256) || digest !== resource.sha256) {
      throw new Error(`AVIFS sequence digest mismatch for resource ${resource.id}`);
    }
    const stem = `sequence-${resource.id}-${resource.frame}`;
    const input = path.join(root, `${stem}.avifs`);
    const output = path.join(root, `${stem}.png`);
    await fs.writeFile(input, bytes);
    const avifdec = vscode.workspace.getConfiguration("mmt.resources").get<string>("avifdec.path", "avifdec");
    try {
      await this.host.run(
        avifdec,
        [
          "-j", "1",
          "-c", "dav1d",
          "--index", String(resource.frame),
          "--size-limit", String(pixels),
          "--dimension-limit", String(Math.max(...resource.size)),
          "--",
          input,
          output
        ],
        { cwd: root, signal, timeout: 30_000, maxBuffer: 1024 * 1024 }
      );
      const png = await fs.readFile(output);
      if (png.byteLength > configuredMaxFileBytes()
        || png.byteLength < 24
        || !png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        || png.toString("ascii", 12, 16) !== "IHDR") {
        throw new Error("AVIFS decoder returned an invalid or oversized PNG");
      }
      const decodedSize: [number, number] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      if (decodedSize[0] !== resource.size[0] || decodedSize[1] !== resource.size[1]) {
        throw new Error(
          `AVIFS decoder returned ${decodedSize.join("x")}; expected ${resource.size.join("x")}`
        );
      }
      return png;
    } catch (error) {
      if (signal.aborted) throw new vscode.CancellationError();
      const stderr = commandStderr(error);
      throw new Error(stderr || `AVIFS decoder failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await Promise.all([
        fs.rm(input, { force: true }),
        fs.rm(output, { force: true })
      ]);
    }
  }

  private async compile(
    entry: string,
    root: string,
    output: string,
    format: RenderFormat,
    signal: AbortSignal
  ): Promise<void> {
    try {
      await this.host.run(
        this.tinymistCommand,
        ["compile", "--root", root, "--format", format, entry, output],
        { cwd: root, signal, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
      );
    } catch (error) {
      if (signal.aborted) throw new vscode.CancellationError();
      throw new Error(commandStderr(error) || (error instanceof Error ? error.message : String(error)));
    }
  }

  private assertActive(operation: RenderOperation): void {
    if (operation.signal.aborted || operation.generation !== this.generation) {
      throw new vscode.CancellationError();
    }
  }

  private assertCurrent(operation: RenderOperation): void {
    this.assertActive(operation);
    const current = vscode.workspace.textDocuments.find((document) => document.uri.toString() === operation.sourceUri);
    if (current === undefined || current.version !== operation.sourceVersion) {
      throw new Error("Authored MomoScript revision changed during preview/export");
    }
  }
}

class BoundedResourceCache implements StringResourceCache {
  private readonly values = new Map<string, string>();
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  get(key: string): string | undefined {
    const value = this.values.get(key);
    if (value === undefined) return undefined;
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    const previous = this.values.get(key);
    if (previous !== undefined) this.bytes -= previous.length * 2;
    this.values.delete(key);
    const bytes = value.length * 2;
    if (bytes > this.maxBytes) return;
    while (this.bytes + bytes > this.maxBytes) {
      const oldest = this.values.entries().next().value as [string, string] | undefined;
      if (oldest === undefined) break;
      this.values.delete(oldest[0]);
      this.bytes -= oldest[1].length * 2;
    }
    this.values.set(key, value);
    this.bytes += bytes;
  }
}

async function mirrorWorkspaceResources(
  source: vscode.TextDocument,
  project: TypstRenderProjectUpdate,
  signal: AbortSignal
): Promise<TypstRenderProjectUpdate> {
  const files = [...project.files];
  const existing = new Set(files.map((file) => file.uri));
  const directory = source.uri.with({ path: path.posix.dirname(source.uri.path), query: "", fragment: "" });
  let total = 0;
  for (const resource of project.resources) {
    if (resource.kind !== "workspace-file" || existing.has(resource.uri)) continue;
    if (signal.aborted) throw new vscode.CancellationError();
    if (resource.fileName !== path.posix.basename(resource.fileName)
      || !/\.(?:png|jpe?g|gif|webp|svg|bmp|avif)$/iu.test(resource.fileName)) {
      throw new Error(`Unsafe workspace resource name: ${resource.fileName}`);
    }
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, resource.fileName));
    if (bytes.byteLength > MAX_WORKSPACE_FILE_BYTES || total + bytes.byteLength > MAX_WORKSPACE_RESOURCE_BYTES) {
      throw new Error(`Workspace resource budget exceeded by ${resource.fileName}`);
    }
    total += bytes.byteLength;
    files.push({ uri: resource.uri, dataBase64: Buffer.from(bytes).toString("base64") });
    existing.add(resource.uri);
  }
  return files.length === project.files.length ? project : { ...project, files };
}

async function materializeProject(project: TypstRenderProjectUpdate, root: string): Promise<string> {
  const entry = vscode.Uri.parse(project.entryUri, true);
  const basePath = path.posix.dirname(entry.path);
  let entryPath: string | undefined;
  for (const file of project.files) {
    const uri = vscode.Uri.parse(file.uri, true);
    if (uri.scheme !== entry.scheme || uri.authority !== entry.authority || uri.query || uri.fragment) {
      throw new Error(`Render project contains an unsafe virtual file URI: ${file.uri}`);
    }
    const relative = path.posix.relative(basePath, uri.path);
    if (!relative || relative === ".." || relative.startsWith("../") || path.posix.isAbsolute(relative)) {
      throw new Error(`Render project file escapes its retained root: ${file.uri}`);
    }
    const destination = path.join(root, ...relative.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, fileBytes(file));
    if (file.uri === project.entryUri) entryPath = destination;
  }
  if (entryPath === undefined) throw new Error("Render project entry file is missing");
  return entryPath;
}

function fileBytes(file: TypstVirtualFile): Uint8Array {
  if (typeof file.text === "string") return Buffer.from(file.text, "utf8");
  if (typeof file.dataBase64 === "string") return Buffer.from(file.dataBase64, "base64");
  throw new Error("Render project file has no content");
}

function packResourceUrl(packBase: string, relativePath: string, kind: TypstResourceRequest["kind"]): URL {
  const root = new URL(packBase);
  if (root.protocol !== "https:") throw new Error("Pack resource base must use HTTPS");
  if (/[\\?#:]/u.test(relativePath)) throw new Error("Pack resource path contains forbidden characters");
  const segments = relativePath.split("/");
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Pack resource path must contain relative segments");
  }
  const fileName = segments.at(-1) as string;
  const extension = kind === "image-dir" ? /\.(?:png|jpe?g|webp)$/iu : /\.avifs$/iu;
  if (!extension.test(fileName)) throw new Error(`Pack ${kind} resource has an unsupported extension`);
  const rootHref = root.href.endsWith("/") ? root.href : `${root.href}/`;
  const url = new URL(segments.map(encodeURIComponent).join("/"), rootHref);
  const rootPath = new URL(rootHref).pathname;
  if (url.protocol !== "https:" || url.origin !== root.origin || !url.pathname.startsWith(rootPath)) {
    throw new Error("Pack resource escaped its HTTPS pack root");
  }
  return url;
}

async function fetchResource(
  url: URL,
  limit: number,
  signal: AbortSignal,
  fetcher: DesktopPreviewHost["fetch"]
): Promise<Uint8Array> {
  const response = await fetcher(url, signal);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url.href}`);
  if (response.url !== url.href) throw new Error("Pack resource redirected outside its declared URL");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) throw new Error(`Pack resource exceeds ${limit} bytes`);
  if (!response.body) throw new Error("Pack resource response has no readable body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      if (signal.aborted) throw new vscode.CancellationError();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel("resource size limit exceeded");
        throw new Error(`Pack resource exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function runtimeIdentityMatches(
  left: DesktopRenderRuntimeIdentity,
  right: DesktopRenderRuntimeIdentity
): boolean {
  return left.compilerDigest === right.compilerDigest && left.fontDigest === right.fontDigest;
}

function desktopRenderKey(
  project: TypstRenderProjectUpdate,
  runtime: DesktopRenderRuntimeIdentity
): string {
  return createHash("sha256").update(JSON.stringify([
    "mmt-desktop-render-key.v1",
    project.sourceUri,
    project.sourceVersion,
    project.revision,
    project.projectionKey,
    project.projectDigest,
    project.mappingDigest,
    project.packRegistryDigest ?? null,
    project.resourcePlanDigest,
    project.resourceBytesDigest,
    runtime.compilerDigest,
    runtime.fontDigest
  ])).digest("hex");
}

async function nativeRenderRuntimeIdentity(command: string): Promise<DesktopRenderRuntimeIdentity> {
  const executable = await resolveExecutable(command);
  const compilerDigest = createHash("sha256").update(await fs.readFile(executable)).digest("hex");
  const fontDigest = await systemFontDigest();
  return Object.freeze({ compilerDigest, fontDigest });
}

async function resolveExecutable(command: string): Promise<string> {
  if (path.isAbsolute(command)) return await fs.realpath(command);
  const finder = process.platform === "win32" ? "where" : "which";
  const { stdout } = await executeFile(finder, [command], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024
  });
  const resolved = stdout.split(/\r?\n/u).find((candidate) => candidate.length > 0);
  if (!resolved) throw new DesktopArtifactUnavailableError(
    `ArtifactUnavailable: cannot resolve Desktop compiler '${command}'`
  );
  return await fs.realpath(resolved);
}

async function systemFontDigest(): Promise<string> {
  const files = await systemFontFiles();
  if (files.length === 0) {
    throw new DesktopArtifactUnavailableError(
      "ArtifactUnavailable: no deterministic Desktop font inventory is available"
    );
  }
  const digest = createHash("sha256").update("mmt-desktop-font-inputs.v1\0");
  for (const file of files) {
    digest.update(file).update("\0").update(await fs.readFile(file)).update("\0");
  }
  return digest.digest("hex");
}

async function systemFontFiles(): Promise<string[]> {
  if (process.platform !== "win32") {
    try {
      const { stdout } = await executeFile("fc-list", ["--format=%{file}\\n"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
      });
      const files = [...new Set(stdout.split(/\r?\n/u).filter((candidate) => candidate.length > 0))].sort();
      if (files.length > 0) return files;
    } catch {
      // Fall back to the platform font roots below.
    }
  }
  const roots = process.platform === "win32"
    ? [path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts")]
    : process.platform === "darwin"
      ? ["/System/Library/Fonts", "/Library/Fonts", path.join(os.homedir(), "Library", "Fonts")]
      : ["/usr/share/fonts", "/usr/local/share/fonts", path.join(os.homedir(), ".local", "share", "fonts")];
  const files: string[] = [];
  for (const root of roots) await collectFontFiles(root, files);
  return [...new Set(files)].sort();
}

async function collectFontFiles(root: string, files: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) await collectFontFiles(candidate, files);
    else if (entry.isFile() && /\.(?:ttf|otf|ttc|woff2?)$/iu.test(entry.name)) files.push(candidate);
  }
}

function configuredMaxFileBytes(): number {
  const mb = vscode.workspace.getConfiguration("mmt.resources").get<number>("maxFileSizeMb", 20);
  return Math.max(1, Math.min(64, Number.isFinite(mb) ? mb : 20)) * 1024 * 1024;
}

function configuredResourceLimits(): ResourceMaterializationLimits {
  const config = vscode.workspace.getConfiguration("mmt.resources");
  const count = config.get<number>("maxProjectResources", 128);
  const sizeMb = config.get<number>("maxProjectSizeMb", 64);
  return {
    maxResources: Math.max(1, Math.min(512, Math.trunc(Number.isFinite(count) ? count : 128))),
    maxBytes: Math.max(1, Math.min(256, Number.isFinite(sizeMb) ? sizeMb : 64)) * 1024 * 1024
  };
}

async function staleExportChoice(): Promise<DesktopStaleExportChoice | undefined> {
  const selected = await vscode.window.showWarningMessage(
    "The displayed MomoScript preview is stale. Choose the exact revision to export.",
    { modal: true },
    "Export displayed revision",
    "Wait for latest"
  );
  if (selected === "Export displayed revision") return "export-displayed";
  if (selected === "Wait for latest") return "wait-for-latest";
  return undefined;
}

function defaultPdfUri(source: vscode.TextDocument): vscode.Uri | undefined {
  if (source.uri.scheme !== "file") return undefined;
  const stem = path.basename(source.uri.fsPath).replace(/(?:\.mmt)?(?:\.txt)?$/u, "") || "document";
  return vscode.Uri.file(path.join(path.dirname(source.uri.fsPath), `${stem}.pdf`));
}

function requireMmtDocument(document: vscode.TextDocument | undefined): vscode.TextDocument {
  if (document === undefined || document.languageId !== "mmt") {
    throw new Error("Open an MMT document before previewing or exporting");
  }
  return document;
}

function commandStderr(error: unknown): string {
  return typeof error === "object" && error !== null && "stderr" in error
    ? String((error as { stderr?: unknown }).stderr ?? "").trim()
    : "";
}

function previewHtml(svgBase64: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;background:var(--vscode-editor-background)}main{display:grid;place-items:start center;padding:16px}img{max-width:100%;height:auto;background:white;box-shadow:0 2px 12px #0005}</style></head><body><main><img alt="MomoScript preview" src="data:image/svg+xml;base64,${svgBase64}"></main></body></html>`;
}
