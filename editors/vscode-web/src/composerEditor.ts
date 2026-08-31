import type { CancellationToken } from "@codingame/monaco-vscode-api/vscode/vs/base/common/cancellation";
import type { IEditorOptions } from "@codingame/monaco-vscode-api/vscode/vs/platform/editor/common/editor";
import type { IEditorOpenContext, IEditorSerializer } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor";
import type { EditorInput } from "@codingame/monaco-vscode-api/vscode/vs/workbench/common/editor/editorInput";
import type { IEditorGroup } from "@codingame/monaco-vscode-api/services";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import {
  EditorInputCapabilities,
  RegisteredEditorPriority,
  SimpleEditorInput,
  SimpleEditorPane,
  registerEditor,
  registerEditorPane,
  registerEditorSerializer,
} from "@codingame/monaco-vscode-views-service-override";

export const COMPOSER_EDITOR_ID = "mmt.guiComposer";

export interface ComposerEditorMount {
  dispose(): void | Promise<void>;
}

export interface ComposerEditorMountContext {
  readonly input: ComposerEditorInput;
  readonly container: HTMLElement;
  readonly token: CancellationToken;
}

type ComposerEditorMountHandler = (
  context: ComposerEditorMountContext,
) => PromiseLike<ComposerEditorMount> | ComposerEditorMount;

interface ComposerEditorSlot {
  readonly context: ComposerEditorMountContext;
  generation: number;
  disposed: boolean;
  mount: ComposerEditorMount | undefined;
}

export class ComposerEditorSurfaceRegistry {
  readonly #slots = new Set<ComposerEditorSlot>();
  #handler: ComposerEditorMountHandler | undefined;
  #disposed = false;

  setMountHandler(handler: ComposerEditorMountHandler): ComposerEditorMount {
    if (this.#disposed) throw new Error("Composer editor surface registry is disposed");
    if (this.#handler) throw new Error("Composer editor surface is already registered");
    this.#handler = handler;
    for (const slot of this.#slots) this.#activate(slot, handler);
    return {
      dispose: () => {
        if (this.#handler !== handler) return;
        this.#handler = undefined;
        for (const slot of this.#slots) this.#deactivate(slot);
      },
    };
  }

  mount(context: ComposerEditorMountContext): ComposerEditorMount {
    if (this.#disposed || context.token.isCancellationRequested) return { dispose() {} };
    context.container.textContent = "正在打开 GUI 创作…";
    const slot: ComposerEditorSlot = {
      context,
      generation: 0,
      disposed: false,
      mount: undefined,
    };
    this.#slots.add(slot);
    if (this.#handler) this.#activate(slot, this.#handler);
    return {
      dispose: () => {
        if (slot.disposed) return;
        slot.disposed = true;
        slot.generation += 1;
        this.#slots.delete(slot);
        this.#disposeMount(slot.mount);
        slot.mount = undefined;
        context.container.replaceChildren();
      },
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#handler = undefined;
    for (const slot of this.#slots) {
      slot.disposed = true;
      slot.generation += 1;
      this.#disposeMount(slot.mount);
      slot.context.container.replaceChildren();
    }
    this.#slots.clear();
  }

  #activate(slot: ComposerEditorSlot, handler: ComposerEditorMountHandler): void {
    if (slot.disposed || this.#handler !== handler) return;
    const generation = ++slot.generation;
    void Promise.resolve(handler(slot.context)).then((mount) => {
      if (slot.disposed || slot.generation !== generation || this.#handler !== handler) {
        this.#disposeMount(mount);
        return;
      }
      this.#disposeMount(slot.mount);
      slot.mount = mount;
    }).catch((error: unknown) => {
      if (!slot.disposed && slot.generation === generation) {
        slot.context.container.textContent = error instanceof Error ? error.message : String(error);
      }
    });
  }

  #deactivate(slot: ComposerEditorSlot): void {
    slot.generation += 1;
    this.#disposeMount(slot.mount);
    slot.mount = undefined;
  }

  #disposeMount(mount: ComposerEditorMount | undefined): void {
    if (mount) void Promise.resolve(mount.dispose());
  }
}

export class ComposerEditorInput extends SimpleEditorInput {
  constructor(resource: URI) {
    if (!isComposerResource(resource)) throw new TypeError("Composer editor only accepts workspace MMT resources");
    super(resource);
    this.addCapability(EditorInputCapabilities.Singleton);
    const name = resource.path.split("/").filter(Boolean).at(-1) ?? "MomoScript";
    this.setName(name);
    this.setTitle({ short: name, medium: `${name}（GUI）`, long: `${resource.toString()}（GUI 创作）` });
    this.setDescription("MomoScript GUI 创作");
  }

  override get typeId(): string { return COMPOSER_EDITOR_ID; }

  override matches(other: EditorInput): boolean {
    return other instanceof ComposerEditorInput && other.resource?.toString() === this.resource?.toString();
  }
}

export class ComposerEditorInputSerializer implements IEditorSerializer {
  canSerialize(editor: EditorInput): boolean {
    return editor instanceof ComposerEditorInput
      && editor.resource !== undefined
      && isComposerResource(editor.resource);
  }

  serialize(editor: EditorInput): string | undefined {
    return this.canSerialize(editor) && editor.resource
      ? JSON.stringify({ version: 1, uri: editor.resource.toString() })
      : undefined;
  }

  deserialize(_instantiationService: unknown, serializedEditor: string): EditorInput | undefined {
    const resource = deserializeComposerEditorResource(serializedEditor);
    return resource ? new ComposerEditorInput(resource) : undefined;
  }
}

export function registerComposerEditor(registry: ComposerEditorSurfaceRegistry): ComposerEditorMount {
  class BoundComposerEditorPane extends SimpleEditorPane {
    constructor(group: IEditorGroup) { super(COMPOSER_EDITOR_ID, group); }

    initialize(): HTMLElement {
      const container = document.createElement("div");
      container.className = "mmt-composer-editor";
      container.tabIndex = -1;
      return container;
    }

    async renderInput(
      input: EditorInput,
      _options: IEditorOptions | undefined,
      _context: IEditorOpenContext,
      token: CancellationToken,
    ): Promise<ComposerEditorMount> {
      if (!(input instanceof ComposerEditorInput)) throw new TypeError("Composer pane received an invalid input");
      return registry.mount({ input, container: this.container, token });
    }
  }

  const registrations = [
    registerEditorPane(COMPOSER_EDITOR_ID, "MomoScript GUI 创作", BoundComposerEditorPane, [ComposerEditorInput]),
    registerEditorSerializer(COMPOSER_EDITOR_ID, ComposerEditorInputSerializer),
    ...["**/*.mmt", "**/*.mmt.txt"].map((globPattern) => registerEditor(
      globPattern,
      { id: COMPOSER_EDITOR_ID, label: "MomoScript GUI 创作", priority: RegisteredEditorPriority.option },
      { singlePerResource: true },
      { createEditorInput: ({ resource, options }) => ({ editor: new ComposerEditorInput(resource), options }) },
    )),
  ];
  return { dispose: () => { for (const registration of registrations.reverse()) registration.dispose(); } };
}

export function deserializeComposerEditorResource(serializedEditor: string): URI | undefined {
  try {
    const value: unknown = JSON.parse(serializedEditor);
    if (!isSerializedInput(value)) return undefined;
    const resource = URI.parse(value.uri, true);
    return isComposerResource(resource) ? resource : undefined;
  } catch {
    return undefined;
  }
}

export function isComposerResource(resource: Pick<URI, "scheme" | "authority" | "path" | "query" | "fragment">): boolean {
  if (resource.scheme !== "mmtfs" || resource.authority !== "workspace" || resource.query || resource.fragment) return false;
  const segments = resource.path.split("/").slice(1);
  if (segments.length === 0 || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\\"))) {
    return false;
  }
  return /\.(?:mmt(?:\.txt)?)$/i.test(segments.at(-1) ?? "");
}

function isSerializedInput(value: unknown): value is { readonly version: 1; readonly uri: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 && record.version === 1 && typeof record.uri === "string" && record.uri.length > 0;
}
