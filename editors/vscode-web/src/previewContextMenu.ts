import * as monaco from "monaco-editor";
import { getService } from "@codingame/monaco-vscode-api";
import {
  InputBox,
  MessageType,
} from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/inputbox/inputBox";
import {
  SubmenuAction,
  toAction,
  type IAction,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import {
  DisposableStore,
  toDisposable,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import {
  IContextMenuService,
  IContextViewService,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { defaultInputBoxStyles } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/browser/defaultStyles";
import type { ComposerBodyMode, StatementTextMode } from "./composerEdit.ts";
import type {
  PreviewComposerContextMenuItem,
  PreviewComposerContextMenuPort,
  PreviewComposerContextInputPort,
  PreviewComposerContextInputSession,
  PreviewComposerContextMenuSelection,
  PreviewComposerAvatarPickerPort,
  PreviewComposerAvatarPickerSession,
  PreviewComposerContextMenuSession,
  PreviewComposerMessageEditorPort,
  PreviewComposerMessageEditorResult,
  PreviewComposerMessageEditorSession,
} from "./previewComposer.ts";
import type { PreviewContextMenuAnchor } from "./previewWebviewProtocol.ts";
import {
  avatarItemMatchesCurrent,
  createAvatarPickerController,
  type AvatarPickerSnapshot,
} from "./avatarPicker.ts";
import type { AvatarCatalogItem } from "./galleryPack.ts";

export interface PreviewContextMenuWindowGeometry {
  readonly screenX: number;
  readonly screenY: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
}

export function contextMenuAnchorInWorkbench(
  anchor: PreviewContextMenuAnchor,
  geometry: PreviewContextMenuWindowGeometry,
): { readonly x: number; readonly y: number } {
  const sideInset = Math.max(0, (geometry.outerWidth - geometry.innerWidth) / 2);
  const topInset = Math.max(sideInset, geometry.outerHeight - geometry.innerHeight - sideInset);
  return {
    x: clamp(anchor.screenX - geometry.screenX - sideInset, 0, geometry.innerWidth),
    y: clamp(anchor.screenY - geometry.screenY - topInset, 0, geometry.innerHeight),
  };
}

export async function createWorkbenchPreviewContextMenu(): Promise<PreviewComposerContextMenuPort> {
  const [contextMenuService, contextViewService] = await Promise.all([
    getService(IContextMenuService),
    getService(IContextViewService),
  ]);
  let active: PreviewComposerContextMenuSession | undefined;

  return {
    open(anchor, items) {
      active?.close();
      const { promise, resolve } = Promise.withResolvers<PreviewComposerContextMenuSelection | undefined>();
      let settled = false;
      let pendingSelection: PreviewComposerContextMenuSelection | undefined;
      let session: PreviewComposerContextMenuSession;
      const finish = (selection: PreviewComposerContextMenuSelection | undefined) => {
        if (settled) return;
        settled = true;
        if (active === session) active = undefined;
        resolve(selection);
      };
      session = {
        result: promise,
        close() {
          if (settled) return;
          if (active === session) contextViewService.hideContextView();
          finish(undefined);
        },
      };
      active = session;
      const actions = items.map((item, index) => menuAction(item, String(index), (selection) => {
        pendingSelection = selection;
      }));
      contextMenuService.showContextMenu({
        getAnchor: () => contextMenuAnchorInWorkbench(anchor, window),
        getActions: () => actions,
        getCheckedActionsRepresentation: () => "radio",
        autoSelectFirstItem: true,
        onHide: () => setTimeout(() => finish(pendingSelection), 0),
      });
      return session;
    },
  };
}

export async function createWorkbenchPreviewContextInput(): Promise<PreviewComposerContextInputPort> {
  const contextViewService = await getService(IContextViewService);
  let active: PreviewComposerContextInputSession | undefined;

  return {
    open(anchor, options) {
      active?.close();
      const { promise, resolve } = Promise.withResolvers<string | undefined>();
      let settled = false;
      let pendingValue: string | undefined;
      let contextView: { close(): void } | undefined;
      let input: InputBox | undefined;
      let session: PreviewComposerContextInputSession;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        if (active === session) active = undefined;
        resolve(value);
      };
      session = {
        result: promise,
        close() {
          if (settled) return;
          if (active === session) contextView?.close();
          finish(undefined);
        },
      };
      active = session;
      contextView = contextViewService.showContextView({
        getAnchor: () => contextMenuAnchorInWorkbench(anchor, window),
        render(container) {
          const disposables = new DisposableStore();
          const root = document.createElement("div");
          root.className = "mmt-preview-context-input";
          const width = Math.max(160, Math.min(320, window.innerWidth - 24));
          root.style.width = `${width}px`;
          Object.assign(root.style, {
            boxSizing: "border-box",
            padding: "8px",
            border: "1px solid var(--vscode-widget-border, transparent)",
            background: "var(--vscode-editorWidget-background)",
            boxShadow: "0 2px 8px var(--vscode-widget-shadow)",
          });
          const title = document.createElement("div");
          title.className = "mmt-preview-context-input__title";
          title.textContent = options.title;
          Object.assign(title.style, {
            overflow: "hidden",
            marginBottom: "6px",
            color: "var(--vscode-foreground)",
            fontSize: "12px",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          });
          root.append(title);
          container.append(root);

          input = new InputBox(root, contextViewService, {
            placeholder: options.placeholder,
            ariaLabel: `${options.title}。按 Enter 确认，按 Escape 取消。`,
            flexibleWidth: true,
            inputBoxStyles: defaultInputBoxStyles,
          });
          input.width = width - 16;
          input.value = options.value;
          disposables.add(input);
          disposables.add(input.onDidChange((value) => {
            if (value.length > 0) input?.hideMessage();
          }));
          const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (!input || input.value.length === 0) {
                input?.showMessage({ content: options.requiredMessage, type: MessageType.ERROR }, true);
                return;
              }
              pendingValue = input.value;
              contextView?.close();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              contextView?.close();
            }
          };
          input.inputElement.addEventListener("keydown", onKeyDown);
          disposables.add(toDisposable(() => input?.inputElement.removeEventListener("keydown", onKeyDown)));
          return disposables;
        },
        focus() {
          input?.focus();
          input?.select();
        },
        onHide: () => finish(pendingValue),
      });
      return session;
    },
  };
}
const COMPOSER_TEXT_LANGUAGE_ID = "mmt-composer-text";
const COMPOSER_TYPST_LANGUAGE_ID = "mmt-composer-typst";
let composerLanguagesRegistered = false;

function ensureComposerLanguages(): void {
  if (composerLanguagesRegistered) return;
  composerLanguagesRegistered = true;
  monaco.languages.register({ id: COMPOSER_TEXT_LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(COMPOSER_TEXT_LANGUAGE_ID, {
    tokenizer: {
      root: [
        [/\[:/, { token: "delimiter.bracket", next: "@macro" }],
        [/\\./, "string.escape"],
      ],
      macro: [
        [/:]/, { token: "delimiter.bracket", next: "@pop" }],
        [/\\./, "string.escape"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
      ],
    },
  });
  monaco.languages.register({ id: COMPOSER_TYPST_LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(COMPOSER_TYPST_LANGUAGE_ID, {
    defaultToken: "",
    tokenizer: {
      root: [
        [/\/\/.*$/, "comment"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/\b(?:auto|false|none|true)\b/, "keyword"],
        [/\b(?:and|break|continue|else|for|if|in|let|not|or|return|set|show|while)\b/, "keyword"],
        [/#(?:[A-Za-z_][\w-]*|[0-9]+)/, "keyword"],
        [/\b\d+(?:\.\d+)?(?:pt|mm|cm|in|em|deg|rad|%|fr)?\b/, "number"],
        [/[()[\]{}]/, "@brackets"],
        [/[+\-*/=<>!&|]+/, "operator"],
      ],
    },
  });
}

function composerLanguage(mode: StatementTextMode, inheritedMode: ComposerBodyMode): string {
  const effective = mode === "inherit" ? inheritedMode : mode;
  switch (effective) {
    case "textMacro":
      return COMPOSER_TEXT_LANGUAGE_ID;
    case "textRaw":
      return "plaintext";
    case "typstMacro":
    case "typstRaw":
      return COMPOSER_TYPST_LANGUAGE_ID;
  }
}

function composerModeLabel(mode: StatementTextMode, inheritedMode: ComposerBodyMode): string {
  switch (mode) {
    case "inherit":
      return `继承 · ${composerBodyModeLabel(inheritedMode)}`;
    case "textMacro":
      return "文本宏 · t";
    case "textRaw":
      return "原始文本 · rt";
    case "typstMacro":
      return "Typst · T";
    case "typstRaw":
      return "原始 Typst · rT";
  }
}

function composerBodyModeLabel(mode: ComposerBodyMode): string {
  switch (mode) {
    case "textMacro":
      return "t";
    case "textRaw":
      return "rt";
    case "typstMacro":
      return "T";
    case "typstRaw":
      return "rT";
  }
}

function statementTextValidationMessage(value: string, requiredMessage: string): string | undefined {
  if (value.length === 0) return requiredMessage;
  if (value.includes("\r") || value.includes("\n")) return "消息必须保持为单行。";
  if (new TextEncoder().encode(value).byteLength > 65_536) return "消息不能超过 65536 UTF-8 字节。";
  return undefined;
}

export async function createWorkbenchPreviewMessageEditor(): Promise<PreviewComposerMessageEditorPort> {
  const contextViewService = await getService(IContextViewService);
  ensureComposerLanguages();
  let active: PreviewComposerMessageEditorSession | undefined;

  return {
    open(anchor, options) {
      active?.close();
      const { promise, resolve } = Promise.withResolvers<PreviewComposerMessageEditorResult | undefined>();
      let settled = false;
      let pendingResult: PreviewComposerMessageEditorResult | undefined;
      let contextView: { close(): void } | undefined;
      let editor: monaco.editor.IStandaloneCodeEditor | undefined;
      let model: monaco.editor.ITextModel | undefined;
      let selectedMode = options.mode;
      let session: PreviewComposerMessageEditorSession;
      const finish = (result: PreviewComposerMessageEditorResult | undefined) => {
        if (settled) return;
        settled = true;
        if (active === session) active = undefined;
        resolve(result);
      };
      session = {
        result: promise,
        close() {
          if (settled) return;
          if (active === session) contextView?.close();
          finish(undefined);
        },
      };
      active = session;
      contextView = contextViewService.showContextView({
        getAnchor: () => contextMenuAnchorInWorkbench(anchor, window),
        render(container) {
          const disposables = new DisposableStore();
          const root = document.createElement("div");
          root.className = "mmt-preview-message-editor";
          root.style.width = `${Math.max(280, Math.min(520, window.innerWidth - 24))}px`;

          const title = document.createElement("div");
          title.className = "mmt-preview-message-editor__title";
          title.textContent = options.title;
          root.append(title);

          const modes = document.createElement("div");
          modes.className = "mmt-preview-message-editor__modes";
          modes.role = "radiogroup";
          modes.ariaLabel = "消息解析模式";
          root.append(modes);

          const modeButtons = new Map<StatementTextMode, HTMLButtonElement>();
          const updateMode = (mode: StatementTextMode): void => {
            selectedMode = mode;
            for (const [candidate, button] of modeButtons) {
              const selected = candidate === mode;
              button.classList.toggle("is-selected", selected);
              button.ariaChecked = String(selected);
            }
            if (model) {
              monaco.editor.setModelLanguage(model, composerLanguage(mode, options.inheritedMode));
            }
          };
          for (const mode of [
            "inherit",
            "textMacro",
            "textRaw",
            "typstMacro",
            "typstRaw",
          ] as const) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "mmt-preview-message-editor__mode";
            button.role = "radio";
            button.textContent = composerModeLabel(mode, options.inheritedMode);
            button.addEventListener("click", () => {
              updateMode(mode);
              editor?.focus();
            });
            modeButtons.set(mode, button);
            modes.append(button);
          }

          const editorHost = document.createElement("div");
          editorHost.className = "mmt-preview-message-editor__editor";
          root.append(editorHost);
          const validation = document.createElement("div");
          validation.className = "mmt-preview-message-editor__validation";
          validation.ariaLive = "polite";
          root.append(validation);
          const hint = document.createElement("div");
          hint.className = "mmt-preview-message-editor__hint";
          hint.textContent = "Enter 应用 · Escape 取消";
          root.append(hint);
          container.append(root);

          // Private language IDs keep this fragment outside workspace LSP routing.
          model = monaco.editor.createModel(
            options.value,
            composerLanguage(selectedMode, options.inheritedMode),
          );
          editor = monaco.editor.create(editorHost, {
            model,
            ariaLabel: `${options.title}。按 Enter 确认，按 Escape 取消。`,
            automaticLayout: true,
            codeLens: false,
            contextmenu: false,
            folding: false,
            glyphMargin: false,
            guides: { indentation: false },
            hover: { enabled: false },
            lineDecorationsWidth: 0,
            lineNumbers: "off",
            lineNumbersMinChars: 0,
            links: false,
            minimap: { enabled: false },
            occurrencesHighlight: "off",
            overviewRulerBorder: false,
            overviewRulerLanes: 0,
            padding: { top: 7, bottom: 7 },
            parameterHints: { enabled: false },
            quickSuggestions: false,
            renderLineHighlight: "none",
            renderValidationDecorations: "off",
            roundedSelection: false,
            scrollbar: {
              horizontal: "hidden",
              vertical: "hidden",
              alwaysConsumeMouseWheel: false,
              handleMouseWheel: false,
            },
            scrollBeyondLastColumn: 0,
            scrollBeyondLastLine: false,
            selectionHighlight: false,
            "semanticHighlighting.enabled": false,
            suggestOnTriggerCharacters: false,
            tabCompletion: "off",
            wordBasedSuggestions: "off",
            wordWrap: "off",
          });
          disposables.add(editor);
          disposables.add(model);
          updateMode(selectedMode);

          const updateValidation = (): string | undefined => {
            const message = statementTextValidationMessage(model?.getValue() ?? "", options.requiredMessage);
            validation.textContent = message ?? "";
            validation.classList.toggle("is-visible", message !== undefined);
            return message;
          };
          const submit = (): void => {
            if (!model || updateValidation() !== undefined) return;
            pendingResult = { value: model.getValue(), mode: selectedMode };
            contextView?.close();
          };
          disposables.add(model.onDidChangeContent(() => {
            updateValidation();
          }));
          let composing = false;
          disposables.add(editor.onDidCompositionStart(() => {
            composing = true;
          }));
          disposables.add(editor.onDidCompositionEnd(() => {
            composing = false;
          }));
          disposables.add(editor.onKeyDown((event) => {
            if (event.keyCode === monaco.KeyCode.Enter && !composing && !event.browserEvent.isComposing) {
              event.preventDefault();
              event.stopPropagation();
              submit();
            } else if (event.keyCode === monaco.KeyCode.Escape) {
              event.preventDefault();
              event.stopPropagation();
              contextView?.close();
            }
          }));
          return disposables;
        },
        focus() {
          editor?.focus();
          editor?.setSelection(editor.getModel()?.getFullModelRange() ?? new monaco.Range(1, 1, 1, 1));
        },
        onHide: () => finish(pendingResult),
      });
      return session;
    },
  };
}


export async function createWorkbenchPreviewAvatarPicker(): Promise<PreviewComposerAvatarPickerPort> {
  const contextViewService = await getService(IContextViewService);
  let active: PreviewComposerAvatarPickerSession | undefined;

  return {
    open(anchor, options) {
      active?.close();
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      let settled = false;
      let pendingError: unknown;
      let selectionPending = false;
      let contextView: { close(): void } | undefined;
      let session: PreviewComposerAvatarPickerSession;
      const controller = createAvatarPickerController(options);
      const finish = () => {
        if (settled) return;
        settled = true;
        controller.dispose();
        if (active === session) active = undefined;
        if (pendingError === undefined) resolve();
        else reject(pendingError);
      };
      session = {
        result: promise,
        close() {
          if (settled) return;
          if (active === session) contextView?.close();
          finish();
        },
      };
      active = session;
      contextView = contextViewService.showContextView({
        getAnchor: () => contextMenuAnchorInWorkbench(anchor, window),
        render(container) {
          const disposables = new DisposableStore();
          const images = new Set<HTMLImageElement>();
          const root = document.createElement("div");
          root.className = "mmt-avatar-picker";
          root.style.width = `${Math.max(160, Math.min(560, window.innerWidth - 24))}px`;

          const title = document.createElement("div");
          title.className = "mmt-avatar-picker__title";
          title.textContent = "从本条起更换人物头像";
          root.append(title);

          const searchHost = document.createElement("div");
          searchHost.className = "mmt-avatar-picker__search";
          root.append(searchHost);
          const input = new InputBox(searchHost, contextViewService, {
            placeholder: "搜索其他人物、别名或头像变体",
            ariaLabel: "搜索其他人物头像。按 Escape 取消。",
            flexibleWidth: true,
            inputBoxStyles: defaultInputBoxStyles,
          });
          input.width = Math.max(128, Math.min(528, window.innerWidth - 56));
          disposables.add(input);

          const currentStatus = document.createElement("div");
          currentStatus.className = "mmt-avatar-picker__current-status";
          root.append(currentStatus);
          const results = document.createElement("div");
          results.className = "mmt-avatar-picker__results";
          root.append(results);
          container.append(root);

          const selectItem = (item: AvatarCatalogItem): void => {
            const selection = controller.select(item);
            if (controller.snapshot().busy) {
              selectionPending = true;
              contextView?.close();
            }
            void selection.then(
              (started) => {
                if (started) finish();
              },
              (error: unknown) => {
                pendingError = error;
                finish();
              },
            );
          };
          const renderSnapshot = (snapshot: AvatarPickerSnapshot): void => {
            currentStatus.dataset.currentStatus = snapshot.currentStatus;
            currentStatus.textContent = avatarCurrentStatusLabel(snapshot);
            for (const image of images) image.removeAttribute("src");
            images.clear();
            results.replaceChildren();
            appendAvatarSection(
              results,
              `当前人物 · ${snapshot.currentActorLabel}`,
              snapshot.currentActorItems,
              snapshot,
              images,
              true,
              selectItem,
            );
            const otherTitle = document.createElement("div");
            otherTitle.className = "mmt-avatar-picker__section-title";
            otherTitle.textContent = snapshot.query.length === 0 ? "其他人物" : "其他人物 · 搜索结果";
            results.append(otherTitle);
            if (snapshot.otherActors.length === 0) {
              const empty = document.createElement("div");
              empty.className = "mmt-avatar-picker__empty";
              empty.textContent = "没有匹配的头像";
              results.append(empty);
            }
            for (const group of snapshot.otherActors) {
              appendAvatarSection(
                results,
                group.label,
                group.items,
                snapshot,
                images,
                false,
                selectItem,
              );
            }
          };
          disposables.add(input.onDidChange((value) => controller.setQuery(value)));
          const unsubscribe = controller.subscribe(renderSnapshot);
          disposables.add(toDisposable(unsubscribe));
          const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            contextView?.close();
          };
          input.inputElement.addEventListener("keydown", onKeyDown);
          disposables.add(toDisposable(() => input.inputElement.removeEventListener("keydown", onKeyDown)));
          disposables.add(toDisposable(() => {
            for (const image of images) image.removeAttribute("src");
            images.clear();
          }));
          renderSnapshot(controller.snapshot());
          return disposables;
        },
        focus() {
          const input = document.querySelector<HTMLInputElement>(".mmt-avatar-picker input");
          input?.focus();
        },
        onHide: () => {
          if (!selectionPending) finish();
        },
      });
      return session;
    },
  };
}

function appendAvatarSection(
  container: HTMLElement,
  label: string,
  items: readonly AvatarCatalogItem[],
  snapshot: AvatarPickerSnapshot,
  images: Set<HTMLImageElement>,
  currentActorSection: boolean,
  select: (item: AvatarCatalogItem) => void,
): void {
  if (items.length === 0) return;
  const title = document.createElement("div");
  title.className = "mmt-avatar-picker__actor-label";
  title.textContent = label;
  container.append(title);
  const grid = document.createElement("div");
  grid.className = "mmt-avatar-picker__grid";
  for (const item of items) {
    const current = avatarItemMatchesCurrent(item, snapshot.current);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "mmt-avatar-picker__item";
    button.dataset.avatarEntity = item.variant.entityId;
    button.dataset.avatarContributor = item.variant.contributionNamespace;
    button.dataset.avatarVariant = item.variant.variantId;
    button.disabled = snapshot.busy || current || !item.selectable;
    button.classList.toggle("is-current", current);
    button.classList.toggle("is-unavailable", !item.selectable);
    const image = document.createElement("img");
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    if (item.thumbnailUrl) image.src = item.thumbnailUrl;
    images.add(image);
    const variant = document.createElement("span");
    variant.className = "mmt-avatar-picker__variant";
    variant.textContent = `${item.variant.variantId}${
      item.variant.contributionNamespace === item.variant.entityId.split("::", 1)[0]
        ? ""
        : ` · ${item.variant.contributionNamespace}`
    }`;
    const detail = document.createElement("span");
    detail.className = "mmt-avatar-picker__detail";
    detail.textContent = current
      ? "当前头像"
      : !item.selectable
        ? "此头像来源暂不可用"
        : currentActorSection
          ? snapshot.currentActorLabel
          : `${snapshot.currentActorLabel}将从本条起使用「${item.variant.entityDisplayName} / ${item.variant.variantId}」头像`;
    button.ariaLabel = `${item.variant.entityDisplayName}，${item.variant.variantId}。${detail.textContent}`;
    button.append(image, variant, detail);
    button.addEventListener("click", () => select(item), { once: true });
    grid.append(button);
  }
  container.append(grid);
}

function avatarCurrentStatusLabel(snapshot: AvatarPickerSnapshot): string {
  if (snapshot.currentStatus === "none") return "当前：无头像";
  if (snapshot.currentStatus === "custom") {
    return snapshot.current?.kind === "asset"
      ? `当前：自定义资源 ${snapshot.current.assetName}`
      : "当前：自定义资源";
  }
  if (snapshot.currentStatus === "unavailable") return "当前头像暂不支持预览";
  return "当前头像已在下方标记";
}

function menuAction(
  item: PreviewComposerContextMenuItem,
  path: string,
  select: (selection: PreviewComposerContextMenuSelection) => void,
): IAction {
  if (item.children) {
    return new SubmenuAction(
      `momoscript.previewComposer.menu.${path}`,
      item.label,
      item.children.map((child, index) => menuAction(child, `${path}.${index}`, select)),
    );
  }
  return toAction({
    id: `momoscript.previewComposer.menu.${path}`,
    label: item.label,
    checked: item.checked,
    enabled: item.enabled,
    run: () => {
      if (item.selection) select(item.selection);
    },
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
