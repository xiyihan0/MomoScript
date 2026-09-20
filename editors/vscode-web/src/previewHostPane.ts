import type { Dimension } from "@codingame/monaco-vscode-api/vscode/vs/base/browser/dom";
import type { CancellationToken } from "@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import type { IEditorOptions } from "@codingame/monaco-vscode-api/vscode/vs/platform/editor/common/editor";
import type { IEditorOpenContext, IEditorSerializer } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";
import type { EditorInput } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor/editorInput";
import type { IEditorGroup } from "@codingame/monaco-vscode-api/services";
import {
  EditorInputCapabilities,
  SimpleEditorInput,
  SimpleEditorPane,
  registerEditorPane,
  registerEditorSerializer,
} from "@codingame/monaco-vscode-views-service-override";

export const PREVIEW_HOST_EDITOR_ID = "mmt.previewHost";

export interface PreviewHostMount {
  layout?(): void;
  setVisible?(visible: boolean): void;
  dispose(): void | Promise<void>;
}

export interface PreviewHostMountContext {
  readonly input: PreviewHostInput;
  readonly container: HTMLElement;
  readonly clippingContainer: HTMLElement;
  readonly group: IEditorGroup;
  readonly token: CancellationToken;
}

type PreviewHostMountHandler = (
  context: PreviewHostMountContext,
) => PromiseLike<PreviewHostMount> | PreviewHostMount;

interface PreviewHostSlot {
  readonly context: PreviewHostMountContext;
  generation: number;
  disposed: boolean;
  visible: boolean | undefined;
  mount: PreviewHostMount | undefined;
  error?: Error;
}

/** Registers mounting targets only; the product runtime owns the shared renderer and webview. */
export class PreviewHostSurfaceRegistry {
  readonly #slots = new Set<PreviewHostSlot>();
  readonly #mountWaiters = new Set<{
    readonly input: PreviewHostInput;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }>();
  #handler: PreviewHostMountHandler | undefined;
  #disposed = false;

  setMountHandler(handler: PreviewHostMountHandler): PreviewHostMount {
    if (this.#disposed) throw new Error("Preview surface registry is disposed");
    if (this.#handler) throw new Error("Preview surface is already registered");
    this.#handler = handler;
    for (const slot of this.#slots) void this.#activate(slot, handler);
    return {
      dispose: () => {
        if (this.#handler !== handler) return;
        this.#handler = undefined;
        for (const slot of this.#slots) this.#deactivate(slot);
      },
    };
  }

  mount(context: PreviewHostMountContext): PreviewHostMount {
    if (this.#disposed || context.token.isCancellationRequested) return { dispose() {} };
    for (const slot of this.#slots) {
      if (slot.context.container === context.container) this.#disposeSlot(slot);
    }
    context.container.textContent = "正在打开排版预览…";
    const slot: PreviewHostSlot = { context, generation: 0, disposed: false, visible: undefined, mount: undefined };
    this.#slots.add(slot);
    if (this.#handler) void this.#activate(slot, this.#handler);
    return {
      layout: () => { if (!slot.disposed) slot.mount?.layout?.(); },
      setVisible: (visible) => {
        if (slot.disposed) return;
        slot.visible = visible;
        slot.mount?.setVisible?.(visible);
      },
      dispose: () => this.#disposeSlot(slot),
    };
  }

  async waitUntilMounted(input: PreviewHostInput, signal?: AbortSignal): Promise<void> {
    if (this.#disposed) throw new Error("Preview surface registry is disposed");
    signal?.throwIfAborted();
    for (const slot of this.#slots) {
      if (!slot.context.input.matches(input)) continue;
      if (slot.error) throw slot.error;
      if (slot.mount) return;
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        signal?.removeEventListener("abort", aborted);
        this.#mountWaiters.delete(waiter);
        if (error) reject(error);
        else resolve();
      };
      const aborted = () => finish(signal?.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError"));
      const timeout = window.setTimeout(() => finish(new Error("Preview pane did not finish mounting")), 30_000);
      const waiter = { input, resolve: () => finish(), reject: (error: Error) => finish(error) };
      signal?.addEventListener("abort", aborted, { once: true });
      this.#mountWaiters.add(waiter);
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#handler = undefined;
    for (const slot of this.#slots) this.#disposeSlot(slot);
    this.#slots.clear();
    for (const waiter of this.#mountWaiters) waiter.reject(new Error("Preview surface registry is disposed"));
  }

  async #activate(slot: PreviewHostSlot, handler: PreviewHostMountHandler): Promise<void> {
    if (slot.disposed || this.#handler !== handler) return;
    const generation = ++slot.generation;
    slot.error = undefined;
    try {
      const mount = await handler(slot.context);
      if (slot.disposed || slot.generation !== generation || this.#handler !== handler) {
        this.#disposeMount(mount);
        return;
      }
      this.#disposeMount(slot.mount);
      slot.mount = mount;
      if (slot.visible !== undefined) mount.setVisible?.(slot.visible);
      mount.layout?.();
      for (const waiter of this.#mountWaiters) {
        if (slot.context.input.matches(waiter.input)) waiter.resolve();
      }
    } catch (error) {
      if (!slot.disposed && slot.generation === generation) {
        slot.error = error instanceof Error ? error : new Error(String(error));
        slot.context.container.textContent = slot.error.message;
        for (const waiter of this.#mountWaiters) {
          if (slot.context.input.matches(waiter.input)) waiter.reject(slot.error);
        }
      }
    }
  }

  #deactivate(slot: PreviewHostSlot): void {
    slot.generation += 1;
    this.#disposeMount(slot.mount);
    slot.mount = undefined;
    slot.error = new Error("Preview pane released before mounting");
    for (const waiter of this.#mountWaiters) {
      if (slot.context.input.matches(waiter.input)) waiter.reject(slot.error);
    }
  }

  #disposeSlot(slot: PreviewHostSlot): void {
    if (slot.disposed) return;
    slot.disposed = true;
    this.#deactivate(slot);
    this.#slots.delete(slot);
    slot.context.container.replaceChildren();
  }

  #disposeMount(mount: PreviewHostMount | undefined): void {
    if (mount) void Promise.resolve(mount.dispose());
  }
}

export class PreviewHostInput extends SimpleEditorInput {
  constructor(resource: URI) {
    if (!isPreviewResource(resource)) throw new TypeError("Preview only accepts workspace MMT or Typst resources");
    super(resource);
    this.addCapability(EditorInputCapabilities.Singleton | EditorInputCapabilities.Readonly);
    const name = resource.path.split("/").at(-1) ?? "MomoScript";
    this.setName(`${name}（预览）`);
    this.setTitle({ short: `${name}（预览）`, medium: `${name}（排版预览）`, long: `${resource.toString()}（排版预览）` });
    this.setDescription("MomoScript 排版预览");
  }

  override get typeId(): string { return PREVIEW_HOST_EDITOR_ID; }

  override matches(other: EditorInput): boolean {
    return other instanceof PreviewHostInput && other.resource?.toString() === this.resource?.toString();
  }
}

class PreviewHostInputSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput): boolean {
    return editor instanceof PreviewHostInput && editor.resource !== undefined && isPreviewResource(editor.resource);
  }

  serialize(editor: EditorInput): string | undefined {
    return this.canSerialize(editor) && editor.resource
      ? JSON.stringify({ version: 1, uri: editor.resource.toString() })
      : undefined;
  }

  deserialize(_instantiationService: unknown, serializedEditor: string): EditorInput | undefined {
    try {
      const value: unknown = JSON.parse(serializedEditor);
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length !== 2 || record.version !== 1 || typeof record.uri !== "string") return undefined;
      const resource = URI.parse(record.uri, true);
      return isPreviewResource(resource) ? new PreviewHostInput(resource) : undefined;
    } catch {
      return undefined;
    }
  }
}

export function registerPreviewHostPane(registry: PreviewHostSurfaceRegistry): PreviewHostMount {
  class BoundPreviewHostPane extends SimpleEditorPane {
    #mount: PreviewHostMount | undefined;

    constructor(group: IEditorGroup) { super(PREVIEW_HOST_EDITOR_ID, group); }

    initialize(): HTMLElement {
      const container = document.createElement("div");
      container.className = "mmt-preview-host-pane";
      container.tabIndex = -1;
      container.setAttribute("aria-label", "MomoScript 排版预览");
      return container;
    }

    async renderInput(
      input: EditorInput,
      _options: IEditorOptions | undefined,
      _context: IEditorOpenContext,
      token: CancellationToken,
    ): Promise<PreviewHostMount> {
      if (!(input instanceof PreviewHostInput)) throw new TypeError("Preview pane received an invalid input");
      this.#mount?.dispose();
      const mount = registry.mount({
        input,
        container: this.container,
        clippingContainer: this.wrapper,
        group: this.group,
        token,
      });
      this.#mount = mount;
      mount.setVisible?.(this.isVisible());
      return mount;
    }

    override layout(dimension: Dimension): void {
      super.layout(dimension);
      this.#mount?.layout?.();
    }

    protected override setEditorVisible(visible: boolean): void {
      super.setEditorVisible(visible);
      this.#mount?.setVisible?.(visible);
    }

    override clearInput(): void {
      this.#mount = undefined;
      super.clearInput();
    }
  }

  const registrations = [
    registerEditorPane(PREVIEW_HOST_EDITOR_ID, "MomoScript 排版预览", BoundPreviewHostPane, [PreviewHostInput]),
    registerEditorSerializer(PREVIEW_HOST_EDITOR_ID, PreviewHostInputSerializer),
  ];
  return { dispose: () => { for (const registration of registrations.reverse()) registration.dispose(); } };
}

function isPreviewResource(resource: URI): boolean {
  if (resource.scheme !== "mmtfs" || resource.authority !== "workspace" || resource.query || resource.fragment) return false;
  const segments = resource.path.split("/").slice(1);
  return segments.length > 0
    && segments.every((segment) => segment && segment !== "." && segment !== ".." && !segment.includes("\\"))
    && /\.(?:mmt(?:\.txt)?|typ)$/iu.test(segments.at(-1) ?? "");
}
