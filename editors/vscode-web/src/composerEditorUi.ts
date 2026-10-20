import type { AvatarCatalogItem } from "./galleryPack.ts";
import { avatarItemMatchesCurrent } from "./avatarPicker.ts";
import type {
  ComposerBoundary,
  ComposerDocumentNode,
  ComposerDocumentSnapshot,
  ComposerMessageSide,
  ComposerNodeRef,
  ComposerScriptActorChoice,
} from "./composerDocument.ts";
import type {
  ComposerNewStatement,
  ComposerStructureCommand,
  StatementContinuedValue,
  StatementTextMode,
} from "./composerEdit.ts";
import {
  ComposerRuntime,
  type ComposerRuntimeDisposable,
  type ComposerRuntimeIdentity,
  type ComposerRuntimeState,
  type ComposerRuntimeTransient,
} from "./composerRuntime.ts";
import type {
  PreviewComposerAvatarPickerPort,
  PreviewComposerContextInputPort,
  PreviewComposerContextMenuItem,
  PreviewComposerContextMenuPort,
  PreviewComposerContextMenuSelection,
  PreviewComposerMessageEditorPort,
} from "./previewComposer.ts";
import type { PreviewContextMenuAnchor } from "./previewWebviewProtocol.ts";

const COMPOSER_ICON_PATHS = {
  undo: "M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12",
  redo: "m15 4 5 5-5 5M20 9H10a6 6 0 0 0 0 12",
  save: "M18 3H4v18h16V5l-2-2ZM7 3v6h9V3M7 21v-8h10v8",
  export: "M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  send: "m3 4 18 8-18 8 3-8-3-8Zm3 8h15",
  person: "M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0Zm-4 14v-3a8 8 0 0 1 16 0v3M10 15l2 3 2-3",
  library: "M5 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM2 20v-2a6 6 0 0 1 12 0v2m4-13v8m-4-4h8",
} satisfies Record<"undo" | "redo" | "save" | "export" | "more" | "send" | "person" | "library", string>;

function composerIcon(icon: keyof typeof COMPOSER_ICON_PATHS): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", COMPOSER_ICON_PATHS[icon]);
  svg.append(path);
  return svg;
}

export interface ComposerSpeakerOption {
  readonly reference: string;
  readonly label: string;
  readonly source: "scriptActor" | "packEntity";
}

/** Unsubmitted presentation state, retained by the existing surface owner, never serialized. */
export interface ComposerEditorDraft {
  body: string;
  speaker: { readonly kind: "builtin" } | { readonly kind: "actor"; readonly reference: string };
  side: ComposerMessageSide;
  mode: StatementTextMode;
  recentSpeakers: string[];
}

export interface ComposerEditorUiPorts {
  readonly runtime: ComposerRuntime;
  readonly draft: ComposerEditorDraft;
  readonly contextMenu: PreviewComposerContextMenuPort;
  readonly contextInput: PreviewComposerContextInputPort;
  readonly messageEditor: PreviewComposerMessageEditorPort;
  readonly avatarPicker: PreviewComposerAvatarPickerPort;
  readonly focus: () => unknown | PromiseLike<unknown>;
  readonly editText: (node: ComposerNodeRef, offsetUtf16: number) => unknown | PromiseLike<unknown>;
  readonly newDocument: () => unknown | PromiseLike<unknown>;
  readonly openDocument: () => unknown | PromiseLike<unknown>;
  readonly packSpeakers: () => readonly ComposerSpeakerOption[];
  readonly avatarCatalog: () => readonly AvatarCatalogItem[];
  readonly diagnosticsCount: () => number;
  readonly documentLabel: () => string;
  readonly isDirty: () => boolean;
  readonly openProblems: () => unknown | PromiseLike<unknown>;
  readonly recover: (text: string, reason: string) => void;
}

export class ComposerEditorUi implements ComposerRuntimeDisposable {
  readonly typesetContainer = document.createElement("main");
  readonly clippingContainer: HTMLElement;
  readonly #ports: ComposerEditorUiPorts;
  readonly #root = document.createElement("section");
  readonly #toolbar = document.createElement("header");
  readonly #toolbarControls: {
    readonly title: HTMLElement;
    readonly saveState: HTMLElement;
    readonly undo: HTMLButtonElement;
    readonly redo: HTMLButtonElement;
    readonly save: HTMLButtonElement;
    readonly more: HTMLButtonElement;
  };
  readonly #content = document.createElement("div");
  readonly #placeholder = document.createElement("div");
  readonly #context = document.createElement("div");
  readonly #nodeMenuButton: HTMLButtonElement;
  readonly #bottom = document.createElement("footer");
  readonly #roles = document.createElement("div");
  readonly #draftInput = document.createElement("textarea");
  readonly #send: HTMLButtonElement;
  readonly #currentRole: HTMLButtonElement;
  readonly #draftStatus = document.createElement("span");
  readonly #sheet = document.createElement("div");
  readonly #subscription: ComposerRuntimeDisposable;
  readonly #layoutObserver: ResizeObserver;
  readonly #viewportChanged: (() => void) | undefined;
  #transient: ComposerRuntimeTransient | undefined;
  #active = false;
  #disposed = false;
  #arranging = false;
  #composing = false;
  #sending = false;
  #localEditor: { readonly dirty: boolean; close(): void } | undefined;
  #portraitCatalog: readonly AvatarCatalogItem[] = [];
  #portraitCatalogEpoch: number | undefined;

  constructor(container: HTMLElement, ports: ComposerEditorUiPorts) {
    this.clippingContainer = container;
    this.#ports = ports;
    this.#root.className = "mmt-composer-surface";
    this.#root.setAttribute("aria-label", "MomoScript GUI 创作");
    this.#toolbar.className = "mmt-composer-toolbar";
    const identity = document.createElement("div");
    identity.className = "mmt-composer-document-identity";
    const title = document.createElement("strong");
    title.className = "mmt-composer-document-title";
    const saveState = document.createElement("span");
    saveState.className = "mmt-composer-save-state";
    identity.append(title, saveState);
    const actions = document.createElement("div");
    actions.className = "mmt-composer-toolbar-actions";
    const iconButton = (label: string, icon: keyof typeof COMPOSER_ICON_PATHS, run: () => unknown | PromiseLike<unknown>) => {
      const button = this.#button(label, run, icon === "export" ? "primary" : undefined);
      button.className = "mmt-composer-icon-action";
      button.setAttribute("aria-label", label);
      button.title = label;
      button.replaceChildren(composerIcon(icon));
      return button;
    };
    const undo = iconButton("撤销", "undo", () => this.#ports.runtime.textSession?.runContextAction("undo"));
    const redo = iconButton("重做", "redo", () => this.#ports.runtime.textSession?.runContextAction("redo"));
    const save = iconButton("保存", "save", () => this.#ports.runtime.save());
    const exportButton = iconButton("导出", "export", () => this.#ports.runtime.exportExact());
    const more = iconButton("更多操作", "more", () => this.#openDocumentMenu(elementAnchor(more)));
    more.setAttribute("aria-haspopup", "menu");
    this.#toolbarControls = { title, saveState, undo, redo, save, more };
    actions.append(undo, redo, save, exportButton, more);
    this.#toolbar.append(identity, actions);
    this.#content.className = "mmt-composer-content";
    this.typesetContainer.className = "mmt-composer-typeset";
    this.typesetContainer.tabIndex = -1;
    this.typesetContainer.setAttribute("aria-label", "排版正文编辑画布");
    this.#placeholder.className = "mmt-composer-inactive";
    this.#placeholder.append(this.#status("此文档的排版画布当前未激活。"), this.#button("在此继续创作", () => ports.focus(), "primary"));
    this.#context.className = "mmt-composer-context-actions";
    this.#context.setAttribute("aria-label", "选中内容操作");
    this.#context.hidden = true;
    this.#nodeMenuButton = this.#button("内容操作", () => {
      const state = this.#ports.runtime.state;
      const node = state.snapshot?.nodes.find((candidate) => candidate.nodeKey === state.selectedNodeKey);
      if (node) return this.openNodeContext(node, elementAnchor(this.#nodeMenuButton));
    });
    this.#nodeMenuButton.classList.add("mmt-composer-context-menu");
    this.#bottom.className = "mmt-composer-bottom";
    this.#bottom.setAttribute("aria-label", "连续创作");
    this.#roles.className = "mmt-composer-role-tray";
    this.#roles.setAttribute("aria-label", "最近使用的角色");
    const inputRow = document.createElement("div");
    inputRow.className = "mmt-composer-draft-row";
    this.#draftInput.className = "mmt-composer-draft";
    this.#draftInput.rows = 1;
    this.#draftInput.value = ports.draft.body;
    this.#draftInput.placeholder = "写下一条消息…";
    this.#draftInput.setAttribute("aria-label", "新消息正文");
    this.#draftInput.addEventListener("input", () => {
      ports.draft.body = this.#draftInput.value;
      this.#resizeDraft();
      this.#syncDraft(ports.runtime.state);
    });
    this.#draftInput.addEventListener("compositionstart", () => { this.#composing = true; });
    this.#draftInput.addEventListener("compositionend", () => { this.#composing = false; });
    this.#draftInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || this.#composing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      void this.#sendDraft();
    });
    this.#send = this.#button("发送", () => this.#sendDraft(), "primary");
    this.#send.className = "mmt-composer-send";
    this.#send.setAttribute("aria-label", "发送");
    this.#send.title = "发送";
    const sendLabel = document.createElement("span");
    sendLabel.textContent = "发送";
    this.#send.replaceChildren(composerIcon("send"), sendLabel);
    this.#currentRole = this.#button("切换角色", () => this.#openSpeakerLibrary());
    this.#currentRole.className = "mmt-composer-current-role";
    this.#currentRole.setAttribute("aria-label", "切换角色");
    this.#currentRole.title = "切换角色";
    inputRow.append(this.#currentRole, this.#draftInput, this.#send);
    this.#draftStatus.className = "mmt-composer-draft-status";
    this.#draftStatus.setAttribute("role", "status");
    this.#bottom.append(inputRow, this.#roles, this.#draftStatus);
    this.#sheet.className = "mmt-composer-sheet";
    this.#sheet.hidden = true;
    this.#content.append(this.typesetContainer, this.#placeholder, this.#context);
    this.#root.append(this.#toolbar, this.#content, this.#bottom, this.#sheet);
    container.replaceChildren(this.#root);
    this.#layoutObserver = new ResizeObserver(() => this.#syncResponsiveLayout());
    this.#layoutObserver.observe(container);
    this.#syncResponsiveLayout();
    this.#subscription = ports.runtime.onDidChangeState((state) => this.#render(state));
    const viewport = globalThis.visualViewport;
    if (viewport) {
      const changed = () => {
        this.#syncResponsiveLayout();
        this.#root.querySelector<HTMLElement>("input:focus, textarea:focus, select:focus, button:focus")?.scrollIntoView({ block: "nearest" });
      };
      viewport.addEventListener("resize", changed);
      viewport.addEventListener("scroll", changed);
      this.#viewportChanged = () => {
        viewport.removeEventListener("resize", changed);
        viewport.removeEventListener("scroll", changed);
      };
    }
    this.#resizeDraft();
    this.#render(ports.runtime.state);
  }

  setActive(active: boolean): void {
    if (this.#disposed || this.#active === active) return;
    this.#active = active;
    if (!active) {
      this.prepareToLeave();
      this.#closeSheet();
    }
    this.#render(this.#ports.runtime.state);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closeSheet();
    this.prepareToLeave();
    this.#layoutObserver.disconnect();
    this.#subscription.dispose();
    this.#viewportChanged?.();
    this.#root.remove();
  }
  refresh(): void {
    if (this.#draftInput.value !== this.#ports.draft.body) {
      this.#draftInput.value = this.#ports.draft.body;
      this.#resizeDraft();
    }
    this.#render(this.#ports.runtime.state);
  }

  focusFromCanvas(backward: boolean): void {
    if (!this.#active) return;
    if (backward) [...this.#toolbar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].at(-1)?.focus();
    else this.#draftInput.focus();
  }

  get hasUnsubmittedInput(): boolean {
    return this.#localEditor?.dirty ?? false;
  }

  prepareToLeave(): void {
    this.#localEditor?.close();
  }

  /** The caller supplies only a node from the exact current Rust snapshot. */
  async openNodeContext(node: ComposerDocumentNode, anchor: PreviewContextMenuAnchor): Promise<void> {
    const snapshot = this.#ports.runtime.state.snapshot;
    if (!this.#active || this.#disposed || !snapshot?.nodes.includes(node)) return;
    this.#ports.runtime.selectNode(node.nodeKey);
    const session = this.#ports.contextMenu.open(anchor, this.#nodeMenu(snapshot, node));
    const transient = this.#ports.runtime.beginTransient(() => session.close());
    if (!transient) { session.close(); return; }
    const selection = await session.result;
    const current = transient.isCurrent();
    transient.close();
    if (!current || !selection) return;
    await this.#dispatch(node, selection, anchor, transient.identity);
  }

  #syncResponsiveLayout(): void {
    const bounds = this.clippingContainer.getBoundingClientRect();
    const viewport = globalThis.visualViewport;
    const top = viewport?.offsetTop ?? 0;
    const height = Math.max(0, Math.min(bounds.bottom, top + (viewport?.height ?? globalThis.innerHeight)) - Math.max(bounds.top, top));
    const laidOut = bounds.width > 0 && bounds.height > 0 && height > 0;
    this.#root.dataset.compactLayout = String(laidOut && bounds.width <= 720 && height <= 420);
    if (laidOut) this.#root.style.setProperty("--mmt-composer-viewport-height", `${height}px`);
    else this.#root.style.removeProperty("--mmt-composer-viewport-height");
    this.#resizeDraft();
  }

  #render(state: ComposerRuntimeState): void {
    if (this.#disposed) return;
    this.#renderToolbar(state);
    this.#root.dataset.active = String(this.#active);
    this.#root.dataset.arranging = String(this.#arranging);
    this.typesetContainer.hidden = !this.#active || !this.#sheet.hidden;
    this.#placeholder.hidden = this.#active;
    this.#bottom.inert = !this.#active || !this.#sheet.hidden;
    this.#renderRoles(state);
    this.#syncDraft(state);
    this.#renderContext(state);
  }

  #renderToolbar(state: ComposerRuntimeState): void {
    const { title, saveState, undo, redo, save, more } = this.#toolbarControls;
    const label = this.#ports.documentLabel();
    if (title.textContent !== label) title.textContent = label;
    if (title.title !== label) title.title = label;
    const status = this.#ports.isDirty() ? "未保存" : "已保存";
    if (saveState.textContent !== status) saveState.textContent = status;
    const unavailable = !state.bound || state.pending || !this.#active;
    const history = this.#ports.runtime.textSession?.contextActions;
    undo.disabled = unavailable || !history?.some((action) => action.id === "undo" && action.enabled);
    redo.disabled = unavailable || !history?.some((action) => action.id === "redo" && action.enabled);
    save.disabled = unavailable;
    more.disabled = !this.#active;
  }

  async #openDocumentMenu(anchor: PreviewContextMenuAnchor): Promise<void> {
    const runtime = this.#ports.runtime;
    const state = runtime.state;
    const available = !!state.bound && !state.pending;
    const items: PreviewComposerContextMenuItem[] = [
      { label: "新建", selection: { kind: "toolbar", action: "new" } },
      { label: "打开", selection: { kind: "toolbar", action: "open" } },
      { label: this.#arranging ? "完成整理" : "整理", checked: this.#arranging, enabled: available && !!state.snapshot, selection: { kind: "toolbar", action: "arrange" } },
      { label: "高级源码", enabled: available, selection: { kind: "toolbar", action: "source" } },
      { label: `问题 (${this.#ports.diagnosticsCount()})`, enabled: available, selection: { kind: "toolbar", action: "problems" } },
      { label: "预览", enabled: available, selection: { kind: "toolbar", action: "preview" } },
      { label: "历史", enabled: available, selection: { kind: "toolbar", action: "history" } },
    ];
    const session = this.#ports.contextMenu.open(anchor, items);
    const transient = runtime.beginTransient(() => session.close());
    const subscription = runtime.onDidChangeState((next) => {
      if (next.bound !== state.bound) session.close();
    });
    let selection: PreviewComposerContextMenuSelection | undefined;
    let current = false;
    try {
      selection = await session.result;
      current = transient ? transient.isCurrent() : runtime.state.bound === state.bound;
    } finally {
      subscription.dispose();
      transient?.close();
    }
    if (!current || selection?.kind !== "toolbar" || !this.#active || this.#disposed) return;
    switch (selection.action) {
      case "new": await this.#ports.newDocument(); break;
      case "open": await this.#ports.openDocument(); break;
      case "source": {
        const node = state.snapshot?.nodes.find((candidate) => candidate.nodeKey === state.selectedNodeKey);
        await runtime.navigateSource(node?.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } });
        break;
      }
      case "problems": await this.#ports.openProblems(); break;
      case "preview": await runtime.openPreview(); break;
      case "history": await runtime.showHistory(); break;
      case "arrange":
        this.#arranging = !this.#arranging;
        this.#render(runtime.state);
        break;
    }
  }

  #renderContext(state: ComposerRuntimeState): void {
    const outlineFocused = document.activeElement === this.#context.querySelector("select");
    const menuFocused = document.activeElement === this.#nodeMenuButton;
    this.#context.replaceChildren();
    const snapshot = state.snapshot;
    const node = snapshot?.nodes.find((candidate) => candidate.nodeKey === state.selectedNodeKey);
    this.#context.hidden = !this.#active || (!node && !this.#arranging);
    this.#context.inert = state.pending;
    if (!snapshot) return;
    if (this.#arranging) {
      this.#context.append(this.#button("完成整理", () => {
        this.#arranging = false;
        this.#render(this.#ports.runtime.state);
      }));
      const chosen = selectField("整理内容", [["", "选择内容"], ...snapshot.nodes.map((item) => [item.nodeKey, nodeLabel(item)] as const)], node?.nodeKey ?? "");
      chosen.control.addEventListener("change", () => this.#ports.runtime.selectNode(chosen.control.value || null));
      this.#context.append(chosen.label);
      if (outlineFocused) chosen.control.focus();
    }
    if (!node) return;
    if (!this.#arranging) {
      const title = document.createElement("span");
      title.className = "mmt-composer-selected-label";
      title.textContent = nodeLabel(node);
      this.#context.append(title);
    }
    this.#context.append(this.#nodeMenuButton);
    if (menuFocused && !this.#context.hidden && !state.pending) this.#nodeMenuButton.focus();
    if (node.kind !== "opaque" && node.textEditing) this.#context.append(this.#button("在排版中编辑", () => this.#ports.editText(nodeRef(node), 0)));
    if (node.capabilities.replaceSource) {
      const source = this.#button("局部源码", () => this.#openLocalEditor(node, elementAnchor(source), true));
      this.#context.append(source);
    }
    if (!this.#arranging) return;
    const index = snapshot.nodes.indexOf(node);
    const before = snapshot.boundaries[index];
    const after = snapshot.boundaries[index + 1];
    if (before?.insert) this.#context.append(this.#button("在前面添加", () => this.#openInsert(before)));
    if (after?.insert) this.#context.append(this.#button("在后面添加", () => this.#openInsert(after)));
    if (node.kind === "opaque") return;
    if (node.capabilities.moveUp) this.#context.append(this.#button("上移", () => this.#executeStructure(node, { kind: "moveNode", anchor: node.capabilities.moveUp! })));
    if (node.capabilities.moveDown) this.#context.append(this.#button("下移", () => this.#executeStructure(node, { kind: "moveNode", anchor: node.capabilities.moveDown! })));
    if (node.capabilities.delete) this.#context.append(this.#button("删除整条", () => this.#executeStructure(node, { kind: "deleteNode" })));
  }

  #renderRoles(state: ComposerRuntimeState): void {
    const snapshot = state.snapshot;
    const draft = this.#ports.draft;
    if (snapshot) {
      for (const node of snapshot.nodes) {
        if (node.kind === "message" && node.speaker?.kind === "actor" && !draft.recentSpeakers.includes(node.speaker.reference)) {
          draft.recentSpeakers.push(node.speaker.reference);
        }
      }
    }
    this.#roles.replaceChildren();
    const teacher = this.#button("老师", () => {
      draft.speaker = { kind: "builtin" };
      draft.side = "right";
      this.#renderRoles(this.#ports.runtime.state);
      this.#syncDraft(this.#ports.runtime.state);
      this.#draftInput.focus();
    });
    teacher.ariaPressed = String(draft.speaker.kind === "builtin");
    teacher.className = "mmt-composer-role-chip mmt-composer-role-teacher";
    const teacherLabel = document.createElement("span");
    teacherLabel.textContent = "老师";
    teacher.replaceChildren(this.#portrait("teacher"), teacherLabel);
    const builtinAllowed = snapshot?.boundaries.at(-1)?.insert?.builtinMessageSides.includes("right") ?? false;
    teacher.disabled = !this.#active || !builtinAllowed;
    teacher.title = builtinAllowed ? "以老师身份发送" : "此位置的右侧说话人已由源码指定，不能切换为老师";
    this.#roles.append(teacher);
    const options = this.#speakerOptions();
    for (const reference of draft.recentSpeakers) {
      const option = options.find((candidate) => candidate.reference === reference);
      if (!option) continue;
      const role = this.#button(option.label, () => this.#selectSpeaker(option));
      role.ariaPressed = String(draft.speaker.kind === "actor" && draft.speaker.reference === option.reference);
      role.dataset.speaker = option.reference;
      role.className = "mmt-composer-role-chip";
      role.title = option.label;
      const label = document.createElement("span");
      label.textContent = option.label;
      role.replaceChildren(this.#portrait(option), label);
      this.#roles.append(role);
    }
    const library = this.#button("角色库", () => this.#openSpeakerLibrary());
    library.disabled = !this.#active || !snapshot;
    library.className = "mmt-composer-role-chip mmt-composer-role-library";
    library.title = "角色库";
    const libraryLabel = document.createElement("span");
    libraryLabel.textContent = "角色库";
    library.replaceChildren(this.#portrait("library"), libraryLabel);
    this.#roles.append(library);
    const current = draft.speaker.kind === "actor"
      ? options.find((option) => draft.speaker.kind === "actor" && option.reference === draft.speaker.reference)
      : undefined;
    const currentName = current?.label ?? (draft.speaker.kind === "actor" ? draft.speaker.reference : "老师");
    this.#currentRole.disabled = !this.#active || !snapshot;
    this.#currentRole.replaceChildren(this.#portrait(current ?? (draft.speaker.kind === "builtin" ? "teacher" : "person")));
    this.#currentRole.title = `切换角色 · ${currentName}`;
    this.#draftInput.placeholder = `${currentName}的下一条消息…`;
  }

  #portrait(option: ComposerSpeakerOption | "teacher" | "library" | "person"): HTMLSpanElement {
    const portrait = document.createElement("span");
    portrait.className = "mmt-composer-avatar";
    portrait.setAttribute("aria-hidden", "true");
    portrait.dataset.kind = typeof option === "string" ? option : "actor";
    portrait.append(composerIcon(option === "library" ? "library" : "person"));
    if (typeof option === "string") return portrait;
    const identity = this.#ports.runtime.captureIdentity();
    if (identity && identity.catalogEpoch !== this.#portraitCatalogEpoch) {
      this.#portraitCatalog = this.#ports.avatarCatalog();
      this.#portraitCatalogEpoch = identity.catalogEpoch;
    }
    const snapshot = this.#ports.runtime.state.snapshot;
    const choice = snapshot?.scriptActorChoices.find((actor) => actor.reference === option.reference);
    let presetId = choice?.presetId ?? option.reference;
    let current = choice?.avatar ?? null;
    if (!choice && snapshot) {
      for (let index = snapshot.nodes.length - 1; index >= 0; index -= 1) {
        const node = snapshot.nodes[index]!;
        if (node.kind !== "message" || node.speaker?.kind !== "actor" || node.speaker.reference !== option.reference) continue;
        presetId = node.speaker.presetId;
        current = node.speaker.avatar;
        break;
      }
    }
    const item = current
      ? this.#portraitCatalog.find((candidate) => candidate.selectable && avatarItemMatchesCurrent(candidate, current))
      : this.#portraitCatalog.find((candidate) => candidate.selectable && candidate.variant.entityId === presetId && candidate.variant.isEntityDefault);
    if (item?.thumbnailUrl) {
      const image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      image.src = item.thumbnailUrl;
      image.addEventListener("error", () => image.remove(), { once: true });
      portrait.append(image);
    }
    return portrait;
  }

  #syncDraft(state: ComposerRuntimeState): void {
    const boundary = state.snapshot?.boundaries.at(-1);
    const draft = this.#ports.draft;
    const insert = boundary?.insert;
    const speakerAllowed = draft.speaker.kind === "builtin"
      ? insert?.builtinMessageSides.includes("right")
      : this.#speakerOptions().some((option) => option.reference === (draft.speaker.kind === "actor" ? draft.speaker.reference : "")
        && insert?.speakerSources.includes(option.source) && insert.messageSides.includes(draft.side));
    this.#send.disabled = !this.#active || this.#sending || state.pending || !insert || !speakerAllowed
      || !insert.statementModes.includes(draft.mode) || draft.body.length === 0;
    this.#draftInput.disabled = !this.#active;
    this.#send.querySelector("span")!.textContent = this.#sending ? "发送中…" : "发送";
    this.#send.setAttribute("aria-busy", String(this.#sending));
    this.#draftStatus.textContent = !state.bound ? "没有打开 MomoScript 文档" : !state.snapshot ? "正在读取文档…"
      : !insert ? "此处不能插入消息" : !speakerAllowed ? "请选择可在此处使用的角色" : "";
    this.#draftStatus.hidden = this.#draftStatus.textContent.length === 0;
  }

  #selectSpeaker(option: ComposerSpeakerOption): void {
    const draft = this.#ports.draft;
    draft.speaker = { kind: "actor", reference: option.reference };
    draft.side = "left";
    if (!draft.recentSpeakers.includes(option.reference)) draft.recentSpeakers.push(option.reference);
    this.#renderRoles(this.#ports.runtime.state);
    this.#syncDraft(this.#ports.runtime.state);
    this.#draftInput.focus();
  }

  async #sendDraft(): Promise<void> {
    if (this.#send.disabled || this.#sending || this.#composing) return;
    const draft = this.#ports.draft;
    const body = draft.body;
    const speaker = draft.speaker;
    const snapshot = this.#ports.runtime.state.snapshot;
    const boundary = snapshot?.boundaries.at(-1);
    const insert = boundary?.insert;
    const identity = this.#ports.runtime.captureIdentity();
    if (!boundary || !insert || !identity) return;
    this.#sending = true;
    this.#syncDraft(this.#ports.runtime.state);
    try {
      const applied = await this.#ports.runtime.execute({
        kind: "structure", target: boundary.target,
        command: { kind: "insertStatement", statement: {
          kind: "message", side: speaker.kind === "builtin" ? "right" : draft.side,
          speaker, body: { value: body, mode: draft.mode }, continued: "auto",
        } },
      }, identity);
      if (applied && draft.body === body) {
        draft.body = "";
        this.#draftInput.value = "";
        this.#resizeDraft();
      }
    } finally {
      this.#sending = false;
      this.#syncDraft(this.#ports.runtime.state);
      if (this.#active) this.#draftInput.focus();
    }
  }

  #resizeDraft(): void {
    const input = this.#draftInput;
    if (input.clientWidth === 0) return;
    const scrollTop = input.scrollTop;
    input.style.height = "auto";
    const styles = getComputedStyle(input);
    const borders = Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth);
    const maximum = Number.parseFloat(styles.maxHeight);
    const required = input.value.length === 0 ? Number.parseFloat(styles.minHeight) : input.scrollHeight + borders;
    input.style.height = `${Math.min(maximum, required)}px`;
    input.style.overflowY = required > maximum ? "auto" : "hidden";
    input.scrollTop = scrollTop;
  }

  #nodeMenu(snapshot: ComposerDocumentSnapshot, node: ComposerDocumentNode): PreviewComposerContextMenuItem[] {
    const items: PreviewComposerContextMenuItem[] = [];
    const canvas = (label: string, action: Extract<PreviewComposerContextMenuSelection, { kind: "canvas" }>["action"]) => items.push({ label, selection: { kind: "canvas", action } });
    if (node.kind !== "opaque") {
      if (node.textEditing) canvas("在排版中编辑", "edit");
      if (node.capabilities.setBody) {
        canvas(node.body.resolvedMode?.startsWith("typst") ? "编辑 Typst 正文…" : "编辑正文…", "body");
        canvas("文本模式", "mode");
      }
      if (node.kind === "message") {
        if (node.capabilities.setSpeaker) canvas("更换说话人…", "speaker");
        if (node.capabilities.setContinued) items.push({ label: "连续消息", children: (["auto", "true", "false"] as const).map((value) => ({
          label: value === "auto" ? "自动" : value === "true" ? "强制连续" : "强制新消息", checked: node.continued === value, selection: { kind: "continued", value },
        })) });
        if (node.capabilities.setDisplayName) items.push({ label: "从本条起修改人物显示名…", selection: { kind: "displayName" } });
        if (node.capabilities.setAvatar && node.actorAvatar) items.push({ label: "从本条起更换人物头像…", selection: { kind: "avatar" } });
      }
    }
    if (node.capabilities.replaceSource) canvas("编辑局部源码…", "source");
    const index = snapshot.nodes.indexOf(node);
    if (snapshot.boundaries[index]?.insert) canvas("在前面添加…", "insertBefore");
    if (snapshot.boundaries[index + 1]?.insert) canvas("在后面添加…", "insertAfter");
    if (node.kind !== "opaque") {
      if (node.capabilities.moveUp) canvas("上移", "moveUp");
      if (node.capabilities.moveDown) canvas("下移", "moveDown");
      if (node.capabilities.delete) canvas(node.kind === "message" ? "删除整条消息" : "删除整条旁白", "delete");
    }
    for (const action of this.#ports.runtime.textSession?.contextActions ?? []) {
      if (action.id !== "undo" && action.id !== "redo") continue;
      items.push({ label: action.id === "undo" ? "撤销" : "重做", enabled: action.enabled, selection: { kind: "text", action: action.id } });
    }
    items.push({ label: "转到源码", selection: { kind: "navigate" } });
    return items;
  }

  async #dispatch(node: ComposerDocumentNode, selection: PreviewComposerContextMenuSelection, anchor: PreviewContextMenuAnchor, identity: ComposerRuntimeIdentity): Promise<void> {
    const snapshot = this.#ports.runtime.state.snapshot;
    if (!snapshot?.nodes.includes(node)) return;
    if (selection.kind === "navigate") { await this.#ports.runtime.navigateSource(node.range); return; }
    if (selection.kind === "text") { await this.#ports.runtime.textSession?.runContextAction(selection.action); return; }
    if (selection.kind === "canvas") {
      if (selection.action === "source") { await this.#openLocalEditor(node, anchor, true); return; }
      if (selection.action === "insertBefore" || selection.action === "insertAfter") {
        const index = snapshot.nodes.indexOf(node) + (selection.action === "insertAfter" ? 1 : 0);
        const boundary = snapshot.boundaries[index];
        if (boundary?.insert) this.#openInsert(boundary);
        return;
      }
      if (node.kind === "opaque") return;
      if (selection.action === "edit") { await this.#ports.editText(nodeRef(node), 0); return; }
      if (selection.action === "body") { await this.#openLocalEditor(node, anchor, false); return; }
      if (selection.action === "mode") { this.#openMode(node); return; }
      if (selection.action === "speaker" && node.kind === "message") { this.#openSpeaker(snapshot, node); return; }
      if (selection.action === "delete") { await this.#executeStructure(node, { kind: "deleteNode" }, identity); return; }
      const move = selection.action === "moveUp" ? node.capabilities.moveUp : selection.action === "moveDown" ? node.capabilities.moveDown : null;
      if (move) await this.#executeStructure(node, { kind: "moveNode", anchor: move }, identity);
      return;
    }
    if (node.kind !== "message") return;
    if (selection.kind === "continued") await this.#ports.runtime.execute({ kind: "property", target: { kind: "statement", range: node.statementRange }, command: { kind: "setStatementContinued", value: selection.value } }, identity);
    if (selection.kind === "displayName") await this.#openDisplayName(node, anchor);
    if (selection.kind === "avatar") await this.#openAvatar(node, anchor);
  }

  async #openLocalEditor(node: ComposerDocumentNode, anchor: PreviewContextMenuAnchor, source: boolean): Promise<void> {
    const runtime = this.#ports.runtime;
    const identity = runtime.captureIdentity();
    if (!identity || !runtime.state.snapshot?.nodes.includes(node) || (!source && node.kind === "opaque")) return;
    const document = identity.documentIncarnation;
    const initial = source ? document.getText().slice(document.offsetAt(node.range.start), document.offsetAt(node.range.end)) : node.kind === "opaque" ? "" : node.body.current;
    let value = initial;
    let mode = node.kind === "opaque" ? "inherit" as const : node.body.mode;
    const session = this.#ports.messageEditor.open(anchor, {
      title: source ? "编辑局部源码" : node.kind !== "opaque" && node.body.resolvedMode?.startsWith("typst") ? "编辑 Typst 正文" : "编辑正文",
      kind: source ? "source" : "body", value, mode,
      inheritedMode: node.kind === "opaque" ? "textMacro" : node.body.inheritedMode ?? "textMacro",
      onDidChange: (next, selectedMode) => { value = next; mode = selectedMode; },
    });
    const localEditor = {
      get dirty() { return value !== initial; },
      close: () => {
        if (value !== initial) this.#ports.recover(value, "局部编辑已关闭；未提交内容已保留。");
        value = initial;
        session.close();
      },
    };
    this.#localEditor = localEditor;
    const transient = runtime.beginTransient(() => localEditor.close());
    if (!transient) {
      this.#localEditor = undefined;
      session.close();
      return;
    }
    const result = await session.result;
    const current = transient.isCurrent();
    // Closing our own transient is not a stale-source recovery.
    const changed = value !== initial;
    value = initial;
    transient.close();
    if (this.#localEditor === localEditor) this.#localEditor = undefined;
    if (!result || !current) return;
    if (!changed && result.value === initial && (source || node.kind === "opaque" || result.mode === node.body.mode)) return;
    const applied = source
      ? await runtime.execute({ kind: "structure", target: { kind: "node", node: nodeRef(node) }, command: { kind: "replaceNodeSource", source: result.value } }, identity)
      : node.kind !== "opaque" && await runtime.execute({ kind: "property", target: { kind: "statement", range: node.statementRange }, command: { kind: "setStatementBody", value: result.value, mode: result.mode } }, identity);
    if (!applied) this.#ports.recover(result.value, "局部编辑未能应用；未提交内容已保留。");
  }

  #openSpeakerLibrary(): void {
    this.#openSheet("选择角色", (form) => {
      const search = textField("搜索角色", "input");
      const choices = document.createElement("div");
      choices.className = "mmt-composer-speaker-library";
      const render = () => {
        const query = search.control.value.trim().toLocaleLowerCase();
        choices.replaceChildren();
        for (const option of this.#speakerOptions().filter((candidate) => !query || `${candidate.label} ${candidate.reference}`.toLocaleLowerCase().includes(query))) {
          const role = this.#button(option.label, () => { this.#selectSpeaker(option); this.#closeSheet(); this.#draftInput.focus(); });
          role.className = "mmt-composer-library-card";
          role.title = option.label;
          role.ariaPressed = String(this.#ports.draft.speaker.kind === "actor" && this.#ports.draft.speaker.reference === option.reference);
          const label = document.createElement("span");
          label.textContent = option.label;
          role.replaceChildren(this.#portrait(option), label);
          choices.append(role);
        }
      };
      search.control.addEventListener("input", render);
      form.append(search.label, choices);
      render();
    });
  }

  #openInsert(boundary: ComposerBoundary): void {
    if (!boundary.insert) return;
    this.#openSheet("添加内容", (form, identity) => {
      const kind = selectField("类型", [["message", "消息"], ["narration", "旁白"]]);
      const side = selectField("方向", boundary.insert!.messageSides.map((value) => [value, value === "left" ? "左侧" : "右侧"]));
      const speaker = selectField("说话人", this.#speakerOptions().map((option) => [option.reference, option.label]));
      const body = textField("正文", "textarea");
      const mode = modeField(boundary.insert!.statementModes);
      const continued = selectField("连续状态", [["auto", "自动"], ["true", "是"], ["false", "否"]]);
      form.append(kind.label, side.label, speaker.label, body.label, mode.label, continued.label, this.#submitButton("添加", async () => {
        const statement: ComposerNewStatement = kind.control.value === "narration"
          ? { kind: "narration", body: { value: body.control.value, mode: mode.control.value as StatementTextMode } }
          : { kind: "message", side: side.control.value as ComposerMessageSide, speaker: { kind: "actor", reference: speaker.control.value }, body: { value: body.control.value, mode: mode.control.value as StatementTextMode }, continued: continued.control.value as StatementContinuedValue };
        if (await this.#ports.runtime.execute({ kind: "structure", target: boundary.target, command: { kind: "insertStatement", statement } }, identity)) this.#closeSheet();
      }));
    });
  }

  #openMode(node: Exclude<ComposerDocumentNode, { readonly kind: "opaque" }>): void {
    this.#openSheet("文本模式", (form, identity) => {
      const mode = modeField(["inherit", "textMacro", "textRaw", "typstMacro", "typstRaw"], node.body.mode);
      form.append(mode.label, this.#submitButton("应用", async () => {
        if (await this.#ports.runtime.execute({ kind: "property", target: { kind: "statement", range: node.statementRange }, command: { kind: "setStatementBody", value: node.body.current, mode: mode.control.value as StatementTextMode } }, identity)) this.#closeSheet();
      }));
    });
  }

  #openSpeaker(snapshot: ComposerDocumentSnapshot, node: Extract<ComposerDocumentNode, { readonly kind: "message" }>): void {
    this.#openSheet("更换说话人", (form, identity) => {
      const options = mergeSpeakers(snapshot.scriptActorChoices, this.#ports.packSpeakers());
      const speaker = selectField("说话人", options.map((option) => [option.reference, option.label]), node.speaker?.kind === "actor" ? node.speaker.reference : undefined);
      form.append(speaker.label, this.#submitButton("应用", async () => {
        if (await this.#ports.runtime.execute({ kind: "structure", target: { kind: "node", node: nodeRef(node) }, command: { kind: "setStatementSpeaker", speaker: { kind: "actor", reference: speaker.control.value } } }, identity)) this.#closeSheet();
      }));
    });
  }

  async #openDisplayName(node: Extract<ComposerDocumentNode, { readonly kind: "message" }>, anchor: PreviewContextMenuAnchor): Promise<void> {
    const session = this.#ports.contextInput.open(anchor, { title: "从本条起修改人物显示名", placeholder: "输入新的显示名", value: node.actorDisplayName ?? "", requiredMessage: "显示名不能为空。" });
    const transient = this.#ports.runtime.beginTransient(() => session.close());
    if (!transient) { session.close(); return; }
    const value = await session.result;
    const current = transient.isCurrent();
    transient.close();
    if (current && value !== undefined) await this.#ports.runtime.execute({ kind: "property", target: { kind: "statement", range: node.statementRange }, command: { kind: "setActorDisplayNameFromStatement", value } }, transient.identity);
  }

  async #openAvatar(node: Extract<ComposerDocumentNode, { readonly kind: "message" }>, anchor: PreviewContextMenuAnchor): Promise<void> {
    if (!node.actorAvatar) return;
    const identity = this.#ports.runtime.captureIdentity();
    if (!identity) return;
    const session = this.#ports.avatarPicker.open(anchor, {
      actorPresetId: node.actorAvatar.actorPresetId,
      actorLabel: node.speaker?.kind === "actor" ? node.speaker.displayName : node.actorAvatar.actorPresetId,
      current: node.actorAvatar.current, items: this.#ports.avatarCatalog(),
      choose: async (avatar) => { await this.#ports.runtime.execute({ kind: "property", target: { kind: "statement", range: node.statementRange }, command: { kind: "setActorAvatarFromStatement", avatar } }, identity); },
    });
    const transient = this.#ports.runtime.beginTransient(() => session.close());
    if (!transient) { session.close(); return; }
    try { await session.result; } finally { transient.close(); }
  }

  #executeStructure(node: ComposerDocumentNode, command: ComposerStructureCommand, identity?: ComposerRuntimeIdentity): Promise<boolean> {
    return this.#ports.runtime.execute({ kind: "structure", target: { kind: "node", node: nodeRef(node) }, command }, identity);
  }

  #speakerOptions(): readonly ComposerSpeakerOption[] {
    const snapshot = this.#ports.runtime.state.snapshot;
    return snapshot ? mergeSpeakers(snapshot.scriptActorChoices, this.#ports.packSpeakers()) : [];
  }

  #openSheet(title: string, render: (form: HTMLFormElement, identity: ComposerRuntimeIdentity) => void): void {
    if (!this.#active || this.#disposed) return;
    this.#closeSheet();
    const identity = this.#ports.runtime.captureIdentity();
    if (!identity) return;
    this.#sheet.hidden = false;
    this.typesetContainer.hidden = true;
    this.#sheet.replaceChildren();
    this.#content.inert = true;
    this.#toolbar.inert = true;
    this.#bottom.inert = true;
    const panel = document.createElement("div");
    panel.className = "mmt-composer-sheet-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", title);
    const heading = document.createElement("h2");
    heading.textContent = title;
    const form = document.createElement("form");
    form.addEventListener("submit", (event) => event.preventDefault());
    panel.append(heading, form, this.#button("取消", () => this.#closeSheet()));
    this.#sheet.append(panel);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); this.#closeSheet(); return; }
      if (event.key !== "Tab") return;
      const controls = [...panel.querySelectorAll<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)")];
      const next = event.shiftKey ? controls.at(-1) : controls[0];
      const edge = event.shiftKey ? controls[0] : controls.at(-1);
      if (document.activeElement === edge && next) { event.preventDefault(); next.focus(); }
    });
    this.#transient = this.#ports.runtime.beginTransient(() => this.#closeSheet(false));
    render(form, identity);
    panel.querySelector<HTMLElement>("input, textarea, select, button")?.focus();
  }

  #closeSheet(closeTransient = true): void {
    const transient = this.#transient;
    this.#transient = undefined;
    this.#sheet.hidden = true;
    this.#sheet.replaceChildren();
    this.#content.inert = false;
    this.#toolbar.inert = false;
    this.#bottom.inert = !this.#active;
    this.typesetContainer.hidden = !this.#active;
    if (closeTransient) transient?.close();
  }

  #submitButton(label: string, action: () => unknown | PromiseLike<unknown>): HTMLButtonElement {
    const button = this.#button(label, action, "primary");
    button.type = "submit";
    return button;
  }

  #button(label: string, action: () => unknown | PromiseLike<unknown>, kind?: "primary"): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (kind) button.dataset.kind = kind;
    button.addEventListener("click", (event) => { event.stopPropagation(); void Promise.resolve(action()); });
    return button;
  }

  #status(message: string): HTMLParagraphElement {
    const status = document.createElement("p");
    status.className = "mmt-composer-status";
    status.textContent = message;
    return status;
  }
}

function nodeRef(node: ComposerDocumentNode): ComposerNodeRef {
  return { nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range };
}

function mergeSpeakers(script: readonly ComposerScriptActorChoice[], pack: readonly ComposerSpeakerOption[]): readonly ComposerSpeakerOption[] {
  const choices = new Map<string, ComposerSpeakerOption>();
  for (const choice of script) choices.set(choice.reference, { reference: choice.reference, label: choice.displayName, source: "scriptActor" });
  for (const choice of pack) if (!choices.has(choice.reference)) choices.set(choice.reference, choice);
  return [...choices.values()];
}

function nodeLabel(node: ComposerDocumentNode): string {
  const kind = node.kind === "message" ? node.speaker?.kind === "actor" ? `消息 · ${node.speaker.displayName}` : "老师的消息"
    : node.kind === "narration" ? "旁白" : node.category === "blank" ? "空行" : node.summary || "高级源码";
  return `${kind} · 第 ${node.range.start.line + 1} 行`;
}

function elementAnchor(element: HTMLElement): PreviewContextMenuAnchor {
  const bounds = element.getBoundingClientRect();
  const sideInset = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const topInset = Math.max(sideInset, window.outerHeight - window.innerHeight - sideInset);
  return { screenX: window.screenX + sideInset + bounds.left, screenY: window.screenY + topInset + bounds.bottom };
}

function modeField(modes: readonly StatementTextMode[], selected = modes[0]): Field<HTMLSelectElement> {
  return selectField("文本模式", modes.map((mode) => [mode, mode === "inherit" ? "继承" : mode === "textMacro" ? "文本宏 · t" : mode === "textRaw" ? "纯文本 · rt" : mode === "typstMacro" ? "Typst · T" : "原始 Typst · rT"]), selected);
}

interface Field<Control extends HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement> {
  readonly label: HTMLLabelElement;
  readonly control: Control;
}

function textField(labelText: string, kind: "input" | "textarea", value = ""): Field<HTMLInputElement | HTMLTextAreaElement> {
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const control = kind === "textarea" ? document.createElement("textarea") : document.createElement("input");
  control.value = value;
  label.append(caption, control);
  return { label, control };
}

function selectField(labelText: string, options: readonly (readonly [string, string])[], selected?: string): Field<HTMLSelectElement> {
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const control = document.createElement("select");
  control.setAttribute("aria-label", labelText);
  for (const [value, text] of options) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    option.selected = selected === value;
    control.append(option);
  }
  label.append(caption, control);
  return { label, control };
}
