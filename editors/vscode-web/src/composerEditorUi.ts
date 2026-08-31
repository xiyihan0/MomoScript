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
  readonly newDocument: () => unknown | PromiseLike<unknown>;
  readonly openDocument: () => unknown | PromiseLike<unknown>;
  readonly packSpeakers: () => readonly ComposerSpeakerOption[];
  readonly avatarCatalog: () => readonly AvatarCatalogItem[];
  readonly diagnosticsCount: () => number;
  readonly openProblems: () => unknown | PromiseLike<unknown>;
}

export class ComposerEditorUi implements ComposerRuntimeDisposable {
  readonly #container: HTMLElement;
  readonly #ports: ComposerEditorUiPorts;
  readonly #root = document.createElement("section");
  readonly #toolbar = document.createElement("header");
  readonly #content = document.createElement("div");
  readonly #cards = document.createElement("main");
  readonly #inspector = document.createElement("aside");
  readonly #sheet = document.createElement("div");
  readonly #subscription: ComposerRuntimeDisposable;
  readonly #viewportChanged: (() => void) | undefined;
  #transient: ComposerRuntimeTransient | undefined;
  #sheetCleanup: (() => void) | undefined;
  #disposed = false;

  constructor(container: HTMLElement, ports: ComposerEditorUiPorts) {
    this.#container = container;
    this.#ports = ports;
    this.#root.className = "mmt-composer-surface";
    this.#root.setAttribute("aria-label", "MomoScript GUI 创作");
    this.#toolbar.className = "mmt-composer-toolbar";
    this.#content.className = "mmt-composer-content";
    this.#cards.className = "mmt-composer-cards";
    this.#cards.tabIndex = -1;
    this.#inspector.className = "mmt-composer-inspector";
    this.#inspector.setAttribute("aria-label", "卡片属性");
    this.#sheet.className = "mmt-composer-sheet";
    this.#sheet.hidden = true;
    this.#content.append(this.#cards, this.#inspector);
    this.#root.append(this.#toolbar, this.#content, this.#sheet);
    container.replaceChildren(this.#root);
    this.#subscription = ports.runtime.onDidChangeState((state) => this.#render(state));
    const viewport = globalThis.visualViewport;
    if (viewport) {
      const changed = () => {
        this.#root.style.setProperty("--mmt-composer-viewport-height", `${viewport.height}px`);
        this.#sheet.querySelector<HTMLElement>("input:focus, textarea:focus, button:focus")
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

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closeSheet();
    this.#subscription.dispose();
    this.#viewportChanged?.();
    this.#root.remove();
  }

  #render(state: ComposerRuntimeState): void {
    if (this.#disposed) return;
    this.#renderToolbar(state);
    this.#cards.replaceChildren();
    this.#inspector.replaceChildren();
    const snapshot = state.snapshot;
    if (!state.bound) {
      this.#cards.append(this.#status("没有打开 MomoScript 文档。"));
      return;
    }
    if (!snapshot) {
      this.#cards.append(this.#status("正在读取创作文档…"));
      return;
    }
    if (snapshot.nodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "mmt-composer-empty";
      empty.append(this.#status("空白故事"));
      const boundary = snapshot.boundaries[0];
      if (boundary?.insert) empty.append(this.#button("添加第一条内容", () => this.#openInsert(boundary), "primary"));
      this.#cards.append(empty);
    } else {
      snapshot.boundaries.forEach((boundary, index) => {
        if (boundary.insert) this.#cards.append(this.#insertButton(boundary, index));
        const node = snapshot.nodes[index];
        if (node) this.#cards.append(this.#card(snapshot, node, state.selectedNodeKey === node.nodeKey));
      });
    }
    const selected = snapshot.nodes.find((node) => node.nodeKey === state.selectedNodeKey);
    if (selected) this.#renderInspector(snapshot, selected);
    else this.#inspector.append(this.#status("选择卡片以编辑属性。"));
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
    for (const button of actions.querySelectorAll("button")) button.disabled = !state.bound || state.pending;
    actions.querySelector<HTMLButtonElement>("button:first-child")!.disabled = false;
    actions.querySelector<HTMLButtonElement>("button:nth-child(2)")!.disabled = false;
    this.#toolbar.append(title, actions);
  }

  #card(snapshot: ComposerDocumentSnapshot, node: ComposerDocumentNode, selected: boolean): HTMLElement {
    const card = document.createElement("article");
    card.className = `mmt-composer-card mmt-composer-card-${node.kind}`;
    card.dataset.nodeKey = node.nodeKey;
    card.tabIndex = 0;
    card.setAttribute("aria-selected", String(selected));
    card.addEventListener("click", () => this.#ports.runtime.selectNode(node.nodeKey));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.#ports.runtime.selectNode(node.nodeKey);
      }
    });
    const heading = document.createElement("header");
    const label = document.createElement("strong");
    if (node.kind === "message") {
      label.textContent = node.speaker?.kind === "actor"
        ? node.speaker.displayName
        : node.speaker?.kind === "builtin" ? node.speaker.id : "消息";
      heading.dataset.side = node.side;
    } else if (node.kind === "narration") label.textContent = "旁白";
    else label.textContent = opaqueLabel(node.category);
    heading.append(label);
    const body = document.createElement("p");
    body.className = "mmt-composer-card-body";
    body.textContent = node.kind === "opaque" ? node.summary || node.sourcePreview : node.body.current;
    card.append(heading, body);
    if (node.kind === "opaque") {
      card.dataset.category = node.category;
      if (node.category === "recoverableError") card.dataset.severity = "error";
      card.append(this.#button("打开源码", () => this.#ports.runtime.navigateSource(node.range)));
      return card;
    }
    const controls = document.createElement("div");
    controls.className = "mmt-composer-card-actions";
    if (node.capabilities.moveUp) controls.append(this.#button("上移", () => this.#executeMove(node, node.capabilities.moveUp!)));
    if (node.capabilities.moveDown) controls.append(this.#button("下移", () => this.#executeMove(node, node.capabilities.moveDown!)));
    if (node.capabilities.delete) controls.append(this.#button("删除", () => this.#executeStructure(node, { kind: "deleteNode" })));
    card.append(controls);
    return card;
  }

  #renderInspector(snapshot: ComposerDocumentSnapshot, node: ComposerDocumentNode): void {
    const heading = document.createElement("h2");
    heading.textContent = "编辑卡片";
    this.#inspector.append(heading);
    if (node.kind === "opaque") {
      this.#inspector.append(this.#status("高级源码块只支持源码编辑。"));
      return;
    }
    if (node.capabilities.setBody) this.#inspector.append(this.#button("编辑正文", () => this.#openBody(node), "primary"));
    if (node.kind === "message") {
      if (node.capabilities.setSpeaker) this.#inspector.append(this.#button("更换说话人", () => this.#openSpeaker(snapshot, node)));
      if (node.capabilities.setContinued) this.#inspector.append(this.#button("连续消息", () => this.#openContinued(node)));
      if (node.capabilities.setDisplayName) this.#inspector.append(this.#button("显示名", () => this.#openDisplayName(node)));
      if (node.capabilities.setAvatar && node.actorAvatar) this.#inspector.append(this.#button("头像", () => this.#openAvatar(node)));
    }
  }

  #insertButton(boundary: ComposerBoundary, index: number): HTMLButtonElement {
    const button = this.#button(index === 0 ? "在开头添加" : "在此添加", () => this.#openInsert(boundary));
    button.classList.add("mmt-composer-insert");
    return button;
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
    this.#closeSheet();
    const identity = this.#ports.runtime.captureIdentity();
    if (!identity) return;
    this.#sheet.hidden = false;
    this.#sheet.replaceChildren();
    this.#cards.inert = true;
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
    this.#cards.inert = false;
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
