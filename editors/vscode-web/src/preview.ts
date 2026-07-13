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

  constructor(private readonly container: HTMLElement) {
    this.container.classList.add("typst-preview");
    this.showStatus("Preview is waiting for the first MomoScript projection…");
  }

  async update(project: TypstProjectUpdate): Promise<void> {
    this.pending = project;
    if (this.rendering) return;
    this.rendering = true;
    try {
      while (this.pending) {
        const next = this.pending;
        this.pending = undefined;
        await this.render(next);
      }
    } finally {
      this.rendering = false;
    }
  }

  private async render(project: TypstProjectUpdate): Promise<void> {
    const revision = project.revision;
    this.showStatus("Rendering preview…");
    try {
      initializeTypst();
      for (const file of project.files) {
        const data = file.text === undefined ? decodeBase64(file.dataBase64) : encoder.encode(file.text);
        await $typst.mapShadow(virtualPath(file.uri), data);
      }
      const svg = await $typst.svg({ mainFilePath: virtualPath(project.entryUri) });
      if (this.pending) return;
      this.container.replaceChildren();
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
      const previousObjectUrl = this.objectUrl;
      this.objectUrl = objectUrl;
      this.container.append(image);
      if (previousObjectUrl) URL.revokeObjectURL(previousObjectUrl);
      this.container.dataset.previewRevision = String(revision);
      this.container.dataset.previewReady = "true";
    } catch (error) {
      if (this.pending) return;
      this.container.dataset.previewReady = "false";
      this.showStatus(`Preview failed: ${error instanceof Error ? error.message : String(error)}`, true);
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
    beforeBuild: [loadFonts([notoRegularUrl, notoBoldUrl, monoUrl])],
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
