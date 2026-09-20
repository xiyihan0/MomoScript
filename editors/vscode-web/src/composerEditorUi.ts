import type { AvatarCatalogItem } from "./galleryPack.ts";
import { createAvatarPickerController } from "./avatarPicker.ts";
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
  ComposerStructureTarget,
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

export interface ComposerSpeakerOption {
  readonly reference: string;
  readonly label: string;
  readonly source: "scriptActor" | "packEntity";
}

export interface ComposerEditorUiPorts {
  readonly runtime: ComposerRuntime;
  readonly focus: () => unknown | PromiseLike<unknown>;
  readonly editText: (node: ComposerNodeRef, offsetUtf16: number) => unknown | PromiseLike<unknown>;
  readonly newDocument: () => unknown | PromiseLike<unknown>;
  readonly openDocument: () => unknown | PromiseLike<unknown>;
  readonly packSpeakers: () => readonly ComposerSpeakerOption[];
  readonly avatarCatalog: () => readonly AvatarCatalogItem[];
  readonly diagnosticsCount: () => number;
  readonly openProblems: () => unknown | PromiseLike<unknown>;
}

export class ComposerEditorUi implements ComposerRuntimeDisposable {
  readonly typesetContainer = document.createElement("main");
  readonly clippingContainer: HTMLElement;
  readonly #ports: ComposerEditorUiPorts;
  readonly #root = document.createElement("section");
  readonly #toolbar = document.createElement("header");
  readonly #content = document.createElement("div");
  readonly #placeholder = document.createElement("div");
  readonly #inspector = document.createElement("aside");
  readonly #sheet = document.createElement("div");
  readonly #subscription: ComposerRuntimeDisposable;
  readonly #layoutObserver: ResizeObserver;
  readonly #viewportChanged: (() => void) | undefined;
  #transient: ComposerRuntimeTransient | undefined;
  #sheetCleanup: (() => void) | undefined;
  #active = false;
  #disposed = false;

  constructor(container: HTMLElement, ports: ComposerEditorUiPorts) {
    this.clippingContainer = container;
    this.#ports = ports;
    this.#root.className = "mmt-composer-surface";
    this.#root.setAttribute("aria-label", "MomoScript GUI 创作");
    this.#toolbar.className = "mmt-composer-toolbar";
    this.#content.className = "mmt-composer-content";
    this.typesetContainer.className = "mmt-composer-typeset";
    this.typesetContainer.tabIndex = -1;
    this.typesetContainer.setAttribute("aria-label", "排版正文编辑画布");
    this.#placeholder.className = "mmt-composer-inactive";
    this.#placeholder.append(
      this.#status("此文档的排版画布当前未激活。"),
      this.#button("在此继续创作", () => ports.focus(), "primary"),
    );
    this.#inspector.className = "mmt-composer-inspector";
    this.#inspector.setAttribute("aria-label", "内容属性与结构");
    this.#sheet.className = "mmt-composer-sheet";
    this.#sheet.hidden = true;
    this.#content.append(this.typesetContainer, this.#placeholder, this.#inspector);
    this.#root.append(this.#toolbar, this.#content, this.#sheet);
    container.replaceChildren(this.#root);
    this.#layoutObserver = new ResizeObserver(() => this.#syncResponsiveLayout());
    this.#layoutObserver.observe(container);
    this.#syncResponsiveLayout();
    this.#subscription = ports.runtime.onDidChangeState((state) => this.#render(state));
    const viewport = globalThis.visualViewport;
    if (viewport) {
      const changed = () => {
        this.#syncResponsiveLayout();
        this.#sheet.querySelector<HTMLElement>("input:focus, textarea:focus, select:focus, button:focus")
          ?.scrollIntoView({ block: "nearest" });
      };
      viewport.addEventListener("resize", changed);
      viewport.addEventListener("scroll", changed);
      changed();
      this.#viewportChanged = () => {
        viewport.removeEventListener("resize", changed);
        viewport.removeEventListener("scroll", changed);
      };
    }
    this.#render(ports.runtime.state);
  }

  setActive(active: boolean): void {
    if (this.#disposed || this.#active === active) return;
    this.#active = active;
    if (!active) this.#closeSheet();
    this.#render(this.#ports.runtime.state);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closeSheet();
    this.#layoutObserver.disconnect();
    this.#subscription.dispose();
    this.#viewportChanged?.();
    this.#root.remove();
  }

  #syncResponsiveLayout(): void {
    const bounds = this.clippingContainer.getBoundingClientRect();
    const viewport = globalThis.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop + (viewport?.height ?? globalThis.innerHeight);
    const visibleHeight = Math.max(
      0,
      Math.min(bounds.bottom, viewportBottom) - Math.max(bounds.top, viewportTop),
    );
    const hasLayout = bounds.width > 0 && bounds.height > 0 && visibleHeight > 0;
    this.#root.dataset.compactLayout = String(
      hasLayout && bounds.width <= 720 && visibleHeight <= 420,
    );
    if (hasLayout) {
      this.#root.style.setProperty("--mmt-composer-viewport-height", `${visibleHeight}px`);
    } else {
      this.#root.style.removeProperty("--mmt-composer-viewport-height");
    }
  }

  #render(state: ComposerRuntimeState): void {
    if (this.#disposed) return;
    this.#renderToolbar(state);
    this.#root.dataset.active = String(this.#active);
    this.typesetContainer.hidden = !this.#active || !this.#sheet.hidden;
    this.#placeholder.hidden = this.#active;
    this.#inspector.inert = !this.#active || state.pending;
    this.#inspector.replaceChildren();
    const snapshot = state.snapshot;
    if (!state.bound) {
      this.#inspector.append(this.#status("没有打开 MomoScript 文档。"));
      return;
    }
    if (!snapshot) {
      this.#inspector.append(this.#status("正在读取创作文档…"));
      return;
    }
    if (snapshot.nodes.length === 0) {
      this.#inspector.append(this.#status("空白故事"));
      const boundary = snapshot.boundaries[0];
      if (boundary?.insert) this.#inspector.append(this.#button("添加第一条内容", () => this.#openInsert(boundary), "primary"));
      return;
    }
    const selectedNode = selectField("选中内容", [
      ["", "点击排版内容以选择"],
      ...snapshot.nodes.map((node) => [node.nodeKey, nodeLabel(node)] as const),
    ], state.selectedNodeKey ?? "");
    selectedNode.control.addEventListener("change", () => this.#ports.runtime.selectNode(selectedNode.control.value || null));
    this.#inspector.append(selectedNode.label);
    const selected = snapshot.nodes.find((node) => node.nodeKey === state.selectedNodeKey);
    if (selected) this.#renderInspector(snapshot, selected);
    else {
      this.#inspector.append(this.#status("在排版中选择内容以编辑属性；空行和高级内容可从上方选择后打开源码。"));
      const end = snapshot.boundaries.at(-1);
      if (end?.insert) this.#inspector.append(this.#button("在末尾添加内容", () => this.#openInsert(end)));
    }
  }

  #renderToolbar(state: ComposerRuntimeState): void {
    this.#toolbar.replaceChildren();
    const title = document.createElement("strong");
    title.textContent = "GUI 创作";
    const actions = document.createElement("div");
    actions.className = "mmt-composer-toolbar-actions";
    actions.append(
      this.#button("新建", () => this.#ports.newDocument()),
      this.#button("打开", () => this.#ports.openDocument()),
      this.#button("高级源码", () => {
        const node = state.snapshot?.nodes.find((candidate) => candidate.nodeKey === state.selectedNodeKey);
        return this.#ports.runtime.navigateSource(node?.range ?? {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        });
      }),
      this.#button(`问题 (${this.#ports.diagnosticsCount()})`, () => this.#ports.openProblems()),
      this.#button("预览", () => this.#ports.runtime.openPreview()),
      this.#button("历史", () => this.#ports.runtime.showHistory()),
      this.#button("保存", () => this.#ports.runtime.save()),
      this.#button("导出", () => this.#ports.runtime.exportExact()),
    );
    for (const button of actions.querySelectorAll("button")) button.disabled = !state.bound || state.pending || !this.#active;
    actions.querySelector<HTMLButtonElement>("button:first-child")!.disabled = false;
    actions.querySelector<HTMLButtonElement>("button:nth-child(2)")!.disabled = false;
    this.#toolbar.append(title, actions);
  }


  #renderInspector(snapshot: ComposerDocumentSnapshot, node: ComposerDocumentNode): void {
    const heading = document.createElement("h2");
    heading.textContent = nodeLabel(node);
    this.#inspector.append(heading);
    this.#inspector.append(this.#button("打开源码", () => this.#ports.runtime.navigateSource(node.range)));
    const index = snapshot.nodes.indexOf(node);
    const before = snapshot.boundaries[index];
    const after = snapshot.boundaries[index + 1];
    const structure = document.createElement("div");
    structure.className = "mmt-composer-structure-actions";
    if (before?.insert) structure.append(this.#button("在前面添加", () => this.#openInsert(before)));
    if (after?.insert) structure.append(this.#button("在后面添加", () => this.#openInsert(after)));
    this.#inspector.append(structure);
    if (node.kind === "opaque") {
      this.#inspector.append(this.#status(node.category === "blank" ? "空行保留原始源码字节。" : "此内容只能在高级源码中编辑。"));
      return;
    }
    if (node.capabilities.moveUp) structure.append(this.#button("上移", () => this.#executeMove(node, node.capabilities.moveUp!)));
    if (node.capabilities.moveDown) structure.append(this.#button("下移", () => this.#executeMove(node, node.capabilities.moveDown!)));
    if (node.capabilities.delete) structure.append(this.#button("删除整条", () => this.#executeStructure(node, { kind: "deleteNode" })));
    if (node.textEditing) {
      this.#inspector.append(this.#button(
        node.textEditing.text.length === 0 ? "输入正文" : "在排版中编辑",
        () => this.#ports.editText(nodeRef(node), 0),
        "primary",
      ));
      if (node.capabilities.setBody) this.#inspector.append(this.#button("文本模式", () => this.#openMode(node)));
    } else if (node.capabilities.setBody && (node.body.resolvedMode === "typstMacro" || node.body.resolvedMode === "typstRaw")) {
      this.#inspector.append(this.#button("编辑 Typst 正文", () => this.#openBody(node)));
    } else {
      this.#inspector.append(this.#status("此正文无法唯一映射，请使用源码编辑。"));
    }
    if (node.kind === "message") {
      if (node.capabilities.setSpeaker) this.#inspector.append(this.#button("更换说话人", () => this.#openSpeaker(snapshot, node)));
      if (node.capabilities.setContinued) this.#inspector.append(this.#button("连续消息", () => this.#openContinued(node)));
      if (node.capabilities.setDisplayName) this.#inspector.append(this.#button("显示名", () => this.#openDisplayName(node)));
      if (node.capabilities.setAvatar && node.actorAvatar) this.#inspector.append(this.#button("头像", () => this.#openAvatar(node)));
    }
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
      form.append(kind.label, side.label, speaker.label, body.label, mode.label, continued.label);
      form.append(this.#submitButton("添加", async () => {
        const statement: ComposerNewStatement = kind.control.value === "narration"
          ? { kind: "narration", body: { value: body.control.value, mode: mode.control.value as StatementTextMode } }
          : {
              kind: "message",
              side: side.control.value as ComposerMessageSide,
              speaker: { kind: "actor", reference: speaker.control.value },
              body: { value: body.control.value, mode: mode.control.value as StatementTextMode },
              continued: continued.control.value as StatementContinuedValue,
            };
        await this.#ports.runtime.execute({
          kind: "structure",
          target: boundary.target,
          command: { kind: "insertStatement", statement },
        }, identity);
        this.#closeSheet();
      }));
    });
  }

  #openBody(node: Exclude<ComposerDocumentNode, { readonly kind: "opaque" }>): void {
    this.#openSheet("编辑正文", (form, identity) => {
      const body = textField("正文", "textarea", node.body.current);
      const mode = modeField(["inherit", "textMacro", "textRaw", "typstMacro", "typstRaw"], node.body.mode);
      form.append(body.label, mode.label, this.#submitButton("应用", async () => {
        await this.#ports.runtime.execute({
          kind: "property",
          target: { kind: "statement", range: node.statementRange },
          command: { kind: "setStatementBody", value: body.control.value, mode: mode.control.value as StatementTextMode },
        }, identity);
        this.#closeSheet();
      }));
    });
  }

  #openMode(node: Exclude<ComposerDocumentNode, { readonly kind: "opaque" }>): void {
    this.#openSheet("文本模式", (form, identity) => {
      const mode = modeField(["inherit", "textMacro", "textRaw", "typstMacro", "typstRaw"], node.body.mode);
      form.append(mode.label, this.#submitButton("应用", async () => {
        await this.#ports.runtime.execute({
          kind: "property",
          target: { kind: "statement", range: node.statementRange },
          command: { kind: "setStatementBody", value: node.body.current, mode: mode.control.value as StatementTextMode },
        }, identity);
        this.#closeSheet();
      }));
    });
  }

  #openSpeaker(snapshot: ComposerDocumentSnapshot, node: Extract<ComposerDocumentNode, { readonly kind: "message" }>): void {
    this.#openSheet("更换说话人", (form, identity) => {
      const options = mergeSpeakers(snapshot.scriptActorChoices, this.#ports.packSpeakers());
      const speaker = selectField("说话人", options.map((option) => [option.reference, option.label]));
      form.append(speaker.label, this.#submitButton("应用", async () => {
        await this.#ports.runtime.execute({
          kind: "structure",
          target: { kind: "node", node: nodeRef(node) },
          command: { kind: "setStatementSpeaker", speaker: { kind: "actor", reference: speaker.control.value } },
        }, identity);
        this.#closeSheet();
      }));
    });
  }

  #openContinued(node: Extract<ComposerDocumentNode, { readonly kind: "message" }>): void {
    this.#openSheet("连续消息", (form, identity) => {
      const value = selectField("状态", [["auto", "自动"], ["true", "是"], ["false", "否"]], node.continued ?? "auto");
      form.append(value.label, this.#submitButton("应用", async () => {
        await this.#ports.runtime.execute({
          kind: "property",
          target: { kind: "statement", range: node.statementRange },
          command: { kind: "setStatementContinued", value: value.control.value as StatementContinuedValue },
        }, identity);
        this.#closeSheet();
      }));
    });
  }

  #openDisplayName(node: Extract<ComposerDocumentNode, { readonly kind: "message" }>): void {
    this.#openSheet("显示名", (form, identity) => {
      const value = textField("显示名", "input", node.actorDisplayName ?? "");
      form.append(value.label, this.#submitButton("应用", async () => {
        await this.#ports.runtime.execute({
          kind: "property",
          target: { kind: "statement", range: node.statementRange },
          command: { kind: "setActorDisplayNameFromStatement", value: value.control.value },
        }, identity);
        this.#closeSheet();
      }));
    });
  }

  #openAvatar(node: Extract<ComposerDocumentNode, { readonly kind: "message" }>): void {
    this.#openSheet("头像", (form, identity) => {
      const items = this.#ports.avatarCatalog();
      const actorAvatar = node.actorAvatar;
      if (!actorAvatar) return;
      const controller = createAvatarPickerController({
        actorPresetId: actorAvatar.actorPresetId,
        actorLabel: node.speaker?.kind === "actor" ? node.speaker.displayName : actorAvatar.actorPresetId,
        current: actorAvatar.current,
        items,
        choose: async (avatar) => {
          await this.#ports.runtime.execute({
            kind: "property",
            target: { kind: "statement", range: node.statementRange },
            command: { kind: "setActorAvatarFromStatement", avatar },
          }, identity);
        },
      });
      this.#sheetCleanup = () => controller.dispose();
      const selectable = items.filter((item) => item.selectable);
      const picker = selectField(
        "头像",
        selectable.map((item, index) => [String(index), `${item.variant.entityDisplayName} · ${item.variant.variantId}`]),
      );
      form.append(picker.label, this.#submitButton("应用", async () => {
        const item = selectable[Number(picker.control.value)];
        if (!item) return;
        if (await controller.select(item)) this.#closeSheet();
      }));
    });
  }

  #executeMove(node: Exclude<ComposerDocumentNode, { readonly kind: "opaque" }>, anchor: NonNullable<typeof node.capabilities.moveUp>): Promise<void> {
    return this.#executeStructure(node, { kind: "moveNode", anchor });
  }

  #executeStructure(node: Exclude<ComposerDocumentNode, { readonly kind: "opaque" }>, command: ComposerStructureCommand): Promise<void> {
    const target: ComposerStructureTarget = { kind: "node", node: nodeRef(node) };
    return this.#ports.runtime.execute({ kind: "structure", target, command });
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
    this.#sheet.replaceChildren();
    this.#content.inert = true;
    this.#toolbar.inert = true;
    this.typesetContainer.hidden = true;
    const panel = document.createElement("div");
    panel.className = "mmt-composer-sheet-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", title);
    const heading = document.createElement("h2");
    heading.textContent = title;
    const close = this.#button("取消", () => this.#closeSheet());
    const form = document.createElement("form");
    form.addEventListener("submit", (event) => event.preventDefault());
    panel.append(heading, form, close);
    this.#sheet.append(panel);
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.#closeSheet();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = [...panel.querySelectorAll<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)")];
      const next = event.shiftKey ? controls.at(-1) : controls[0];
      const edge = event.shiftKey ? controls[0] : controls.at(-1);
      if (document.activeElement === edge && next) {
        event.preventDefault();
        next.focus();
      }
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
    this.#sheetCleanup?.();
    this.#sheetCleanup = undefined;
    this.#content.inert = false;
    this.#toolbar.inert = false;
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
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void Promise.resolve(action());
    });
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

function mergeSpeakers(
  script: readonly ComposerScriptActorChoice[],
  pack: readonly ComposerSpeakerOption[],
): readonly ComposerSpeakerOption[] {
  const choices = new Map<string, ComposerSpeakerOption>();
  for (const choice of script) choices.set(choice.reference, {
    reference: choice.reference,
    label: choice.displayName,
    source: "scriptActor",
  });
  for (const choice of pack) if (!choices.has(choice.reference)) choices.set(choice.reference, choice);
  return [...choices.values()];
}

function nodeLabel(node: ComposerDocumentNode): string {
  const kind = node.kind === "message"
    ? node.speaker?.kind === "actor" ? `消息 · ${node.speaker.displayName}` : "消息"
    : node.kind === "narration" ? "旁白" : opaqueLabel(node.category);
  return `${kind} · 第 ${node.range.start.line + 1} 行`;
}

function opaqueLabel(category: string): string {
  if (category === "blank") return "空行";
  if (category === "directive") return "高级指令";
  if (category === "recoverableError") return "需要修复的源码";
  return "高级源码";
}

function modeField(modes: readonly StatementTextMode[], selected = modes[0]): Field<HTMLSelectElement> {
  return selectField("文本模式", modes.map((mode) => [mode, mode]), selected);
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

function selectField(
  labelText: string,
  options: readonly (readonly [string, string])[],
  selected?: string,
): Field<HTMLSelectElement> {
  const label = document.createElement("label");
  const caption = document.createElement("span");
  caption.textContent = labelText;
  const control = document.createElement("select");
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
