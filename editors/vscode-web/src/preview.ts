import { $typst, MemoryAccessModel } from "@myriaddreamin/typst.ts";
import { loadFonts } from "@myriaddreamin/typst.ts/dist/esm/options.init.mjs";
import { TypstSnippet } from "@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs";
import compilerWasmUrl from "@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm?url";
import rendererWasmUrl from "@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm?url";
import notoRegularUrl from "../../vscode/vendor/fonts/NotoSansCJK-Regular.ttc?url";
import notoBoldUrl from "../../vscode/vendor/fonts/NotoSansCJK-Bold.ttc?url";
import monoUrl from "../../vscode/vendor/fonts/DejaVuSansMono.ttf?url";
import type { TypstProjectUpdate } from "../../vscode/src/tinymistClient";

const encoder = new TextEncoder();
let initialized = false;

export class TypstPreviewController {
  private pending: TypstProjectUpdate | undefined;
  private rendering = false;
  private objectUrl: string | undefined;
  private mappedPaths = new Set<string>();
  private generation = 0;
  private closeRequested = false;

  constructor(private readonly container: HTMLElement) {
    this.container.classList.add("typst-preview");
    this.showStatus("Preview is waiting for the first MomoScript projection…");
  }

  async update(project: TypstProjectUpdate): Promise<void> {
    this.generation += 1;
    this.closeRequested = false;
    this.pending = project;
    await this.processPending();
  }

  async close(): Promise<void> {
    this.generation += 1;
    this.pending = undefined;
    this.closeRequested = true;
    await this.processPending();
  }

  private async processPending(): Promise<void> {
    if (this.rendering) return;
    this.rendering = true;
    try {
      while (this.closeRequested || this.pending) {
        if (this.closeRequested) {
          this.closeRequested = false;
          await this.resetPreview();
          continue;
        }
        const next = this.pending;
        if (!next) continue;
        const generation = this.generation;
        this.pending = undefined;
        await this.render(next, generation);
      }
    } finally {
      this.rendering = false;
    }
  }

  private async resetPreview(): Promise<void> {
    for (const path of this.mappedPaths) await $typst.unmapShadow(path);
    this.mappedPaths.clear();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
    delete this.container.dataset.previewRevision;
    delete this.container.dataset.previewShadowCount;
    this.container.dataset.previewReady = "false";
    this.showStatus("Preview is waiting for a valid MomoScript projection…");
  }

  private async render(project: TypstProjectUpdate, generation: number): Promise<void> {
    const revision = project.revision;
    const nextPaths = new Set(project.files.map((file) => virtualPath(file.uri)));
    const mappedThisAttempt = new Set<string>();
    this.showStatus("Rendering preview…");
    try {
      initializeTypst();
      for (const file of project.files) {
        const path = virtualPath(file.uri);
        const data = file.text === undefined ? decodeBase64(file.dataBase64) : encoder.encode(file.text);
        await $typst.mapShadow(path, data);
        mappedThisAttempt.add(path);
      }
      const svg = await $typst.svg({ mainFilePath: virtualPath(project.entryUri) });
      if (generation !== this.generation || this.pending) {
        await this.unmapAbandonedPaths(mappedThisAttempt);
        return;
      }
      const document = new DOMParser().parseFromString(svg, "text/html");
      const root = document.querySelector("svg");
      if (!root) throw new Error("Typst renderer returned no SVG root");
      const serialized = new XMLSerializer().serializeToString(root);
      const objectUrl = URL.createObjectURL(new Blob([serialized], { type: "image/svg+xml" }));
      const image = new Image();
      image.className = "typst-preview-page";
      image.alt = "Rendered MomoScript preview";
      image.src = objectUrl;
      try {
        await image.decode();
      } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
      }
      if (generation !== this.generation || this.pending) {
        URL.revokeObjectURL(objectUrl);
        await this.unmapAbandonedPaths(mappedThisAttempt);
        return;
      }
      for (const previous of this.mappedPaths) {
        if (!nextPaths.has(previous)) await $typst.unmapShadow(previous);
      }
      this.mappedPaths = nextPaths;
      const previousObjectUrl = this.objectUrl;
      this.objectUrl = objectUrl;
      this.container.replaceChildren(image);
      if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
      this.container.dataset.previewRevision = String(revision);
      this.container.dataset.previewShadowCount = String(this.mappedPaths.size);
      this.container.dataset.previewReady = "true";
    } catch (error) {
      await this.unmapAbandonedPaths(mappedThisAttempt);
      if (generation !== this.generation || this.pending) return;
      this.container.dataset.previewReady = "false";
      this.showStatus(`Preview failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }

  private async unmapAbandonedPaths(paths: ReadonlySet<string>): Promise<void> {
    for (const path of paths) {
      if (!this.mappedPaths.has(path)) await $typst.unmapShadow(path);
    }
  }

  private showStatus(message: string, error = false): void {
    const status = document.createElement("div");
    status.className = error ? "typst-preview-status error" : "typst-preview-status";
    status.textContent = message;
    this.container.replaceChildren(status);
  }
}

function initializeTypst(): void {
  if (initialized) return;
  $typst.setCompilerInitOptions({
    beforeBuild: [loadFonts([notoRegularUrl, notoBoldUrl, monoUrl], { assets: false })],
    getModule: () => compilerWasmUrl
  });
  $typst.setRendererInitOptions({ getModule: () => rendererWasmUrl });
  $typst.use(TypstSnippet.withAccessModel(new MemoryAccessModel()));
  initialized = true;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function virtualPath(uri: string): string {
  const parsed = new URL(uri);
  return decodeURIComponent(parsed.pathname);
}
