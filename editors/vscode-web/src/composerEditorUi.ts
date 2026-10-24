import type { AvatarCatalogItem, GalleryPersonGroup, GalleryPersonForm, GalleryStickerSet, GalleryVariant } from "./galleryPack.ts";
import { avatarItemMatchesCurrent, buildAvatarPickerPersonGroups, type AvatarPickerPersonGroup, type AvatarPickerPersonForm } from "./avatarPicker.ts";
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
  ComposerAvatarChoice,
  ComposerMediaChoice,
  ComposerStructureCommand,
  StatementContinuedValue,
  StatementTextMode,
} from "./composerEdit.ts";
import {
  ComposerRuntime,
  type ComposerRuntimeDisposable,
  type ComposerBoundaryBookmark,
  type ComposerRuntimeIdentity,
  type ComposerRuntimeState,
  type ComposerRuntimeTransient,
} from "./composerRuntime.ts";
import type {
  PreviewComposerContextMenuItem,
  PreviewComposerContextMenuPort,
  PreviewComposerContextMenuSelection,
  PreviewComposerMessageEditorPort,
} from "./previewComposer.ts";
import type { PreviewContextMenuAnchor } from "./previewWebviewProtocol.ts";
import type { ExactExportFormat, ExactExportRequest } from "./exactExport.ts";
import type { ExactExportUiState } from "./exactExportUi.ts";

const COMPOSER_ICON_PATHS = {
  export: "M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5",
  chevron: "m8 10 4 4 4-4",
  send: "m3 4 18 8-18 8 3-8-3-8Zm3 8h15",
  person: "M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0Zm-4 14v-3a8 8 0 0 1 16 0v3M10 15l2 3 2-3",
  library: "M5 7a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM2 20v-2a6 6 0 0 1 12 0v2m4-13v8m-4-4h8",
} satisfies Record<"export" | "chevron" | "send" | "person" | "library", string>;

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
  avatarChoice: ComposerAvatarChoice | null;
  insertTarget: { readonly kind: "append" } | { readonly kind: "insert"; readonly bookmark: ComposerBoundaryBookmark; readonly summary: string };
  statementKind: "message" | "narration";
  continued: StatementContinuedValue;
}

export interface ComposerImportedImage {
  readonly media: Extract<ComposerMediaChoice, { kind: "workspaceImage" }>;
  readonly finish: (accepted: boolean) => Promise<void>;
}

export interface ComposerTextRecoveryConfirmation {
  readonly targetSummary: string;
}

export interface ComposerEditorUiPorts {
  readonly runtime: ComposerRuntime;
  readonly draft: ComposerEditorDraft;
  readonly contextMenu: PreviewComposerContextMenuPort;
  readonly messageEditor: PreviewComposerMessageEditorPort;
  readonly focus: () => unknown | PromiseLike<unknown>;
  readonly editText: (node: ComposerNodeRef, offsetUtf16: number) => unknown | PromiseLike<unknown>;
  readonly newDocument: () => unknown | PromiseLike<unknown>;
  readonly openDocument: () => unknown | PromiseLike<unknown>;
  readonly packSpeakers: () => readonly ComposerSpeakerOption[];
  readonly avatarCatalog: () => readonly AvatarCatalogItem[];
  readonly avatarThumbnail: (item: AvatarCatalogItem, signal: AbortSignal) => Promise<string>;
  readonly personThumbnail: (form: GalleryPersonForm, signal: AbortSignal) => Promise<string | undefined>;
  readonly stickerPeople: () => readonly GalleryPersonGroup[];
  readonly stickerThumbnail: (form: GalleryPersonForm, set: GalleryStickerSet, variant: GalleryVariant, signal: AbortSignal) => Promise<string>;
  readonly importLocalImage: () => Promise<ComposerImportedImage | null>;
  readonly textRecoveries: () => readonly { readonly id: string; readonly text: string; readonly reason: string; readonly requiresTargetConfirmation: true }[];
  readonly prepareTextRecovery: (id: string) => ComposerTextRecoveryConfirmation | undefined;
  readonly copyTextRecovery: (id: string) => Promise<void>;
  readonly retryTextRecovery: (id: string, confirmation: ComposerTextRecoveryConfirmation) => Promise<boolean>;
  readonly discardTextRecovery: (id: string) => void;
  readonly diagnosticsCount: () => number;
  readonly documentLabel: () => string;
  readonly isDirty: () => boolean;
  readonly saveState?: () => { readonly kind: "saved" | "unsaved" | "saving" | "error"; readonly message?: string };
  readonly mode: () => "chat" | "layout";
  readonly switchMode: (mode: "chat" | "layout" | "source") => Promise<void>;
  readonly canvasResize: (width: number) => void;
  readonly downloadSource: () => Promise<void>;
  readonly defaultExportFormat: () => ExactExportFormat;
  readonly exportDetails: () => {
    readonly state: ExactExportUiState;
    readonly pages: readonly { readonly index: number; readonly width: number; readonly height: number }[];
    readonly fontNames: readonly string[];
    readonly draftPending: boolean;
  };
  readonly exportDocument: (format: ExactExportFormat, options?: Pick<ExactExportRequest, "staleChoice" | "pageIndex">) => Promise<void>;
  readonly cancelExport: () => void;
  readonly openDocumentSettings: () => Promise<void>;
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
    readonly documentMenu: HTMLButtonElement;
    readonly saveState: HTMLButtonElement;
    readonly mode: HTMLButtonElement;
    readonly export: HTMLButtonElement;
  };
  readonly #layoutHeader = document.createElement("div");
  readonly #layoutSettings: HTMLButtonElement;
  readonly #layoutSummary = document.createElement("span");
  readonly #content = document.createElement("div");
  readonly #placeholder = document.createElement("div");
  readonly #empty = document.createElement("div");
  readonly #canvasStatus = document.createElement("div");
  readonly #context = document.createElement("div");
  readonly #nodeMenuButton: HTMLButtonElement;
  readonly #recovery = document.createElement("div");
  readonly #draftHeader = document.createElement("div");
  readonly #insertStatus = document.createElement("div");
  readonly #add: HTMLButtonElement;
  readonly #expression: HTMLButtonElement;
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
  readonly #compositionWaiters = new Set<() => void>();
  #sheetFocusReturn: HTMLElement | undefined;
  #wideLayout = false;
  #sheetPresentation: "properties" | undefined;
  #sheetModal = true;
  #canvasWidth: number | undefined;
  #switchingMode = false;
  #active = false;
  #disposed = false;
  #arranging = false;
  #composing = false;
  #sending = false;
  #localEditor: { readonly dirty: boolean; close(): void } | undefined;
  #portraitCatalog: readonly AvatarCatalogItem[] = [];
  #portraitCatalogEpoch: number | undefined;
  #sheetAbort: AbortController | undefined;
  #sheetBack: (() => void) | undefined;
  #sheetForm: HTMLFormElement | undefined;
  #refreshPanel: (() => void) | undefined;
  #sheetImageObserver: IntersectionObserver | undefined;
  readonly #sheetImages = new Map<HTMLElement, {
    readonly load: (signal: AbortSignal) => Promise<string | undefined>;
    readonly unavailable?: () => void;
  }>();
  #draftError = "";

  constructor(container: HTMLElement, ports: ComposerEditorUiPorts) {
    this.clippingContainer = container;
    this.#ports = ports;
    this.#root.className = "mmt-composer-surface";
    this.#root.setAttribute("aria-label", "MomoScript GUI 创作");
    this.#toolbar.className = "mmt-composer-toolbar";
    const identity = document.createElement("div");
    identity.className = "mmt-composer-document-identity";
    const title = document.createElement("span");
    title.className = "mmt-composer-document-title";
    const documentMenu = this.#button("作品菜单", async () => {
      await this.prepareModeSwitch();
      this.#openDocumentMenu();
    });
    documentMenu.className = "mmt-composer-document-menu";
    documentMenu.setAttribute("aria-haspopup", "dialog");
    documentMenu.replaceChildren(title, composerIcon("chevron"));
    const saveState = this.#button("保存", () => this.#saveDocument());
    saveState.className = "mmt-composer-save-state";
    saveState.setAttribute("aria-live", "polite");
    identity.append(documentMenu, saveState);
    const actions = document.createElement("div");
    actions.className = "mmt-composer-toolbar-actions";
    const mode = this.#button("", async () => {
      await this.prepareModeSwitch();
      this.#openAuthoringModeMenu();
    });
    mode.className = "mmt-composer-mode-switch";
    mode.setAttribute("aria-haspopup", "dialog");
    const exportButton = this.#button("导出作品", async () => {
      await this.prepareModeSwitch();
      await this.#ports.runtime.exportExact();
    }, "primary");
    exportButton.className = "mmt-composer-export";
    const exportLabel = document.createElement("span");
    exportLabel.className = "mmt-composer-export-label";
    exportLabel.textContent = "导出作品";
    const shortExportLabel = document.createElement("span");
    shortExportLabel.className = "mmt-composer-export-short-label";
    shortExportLabel.textContent = "导出";
    shortExportLabel.setAttribute("aria-hidden", "true");
    exportButton.setAttribute("aria-label", "导出作品");
    exportButton.replaceChildren(composerIcon("export"), exportLabel, shortExportLabel);
    for (const button of [documentMenu, mode, exportButton]) {
      button.addEventListener("pointerdown", (event) => event.preventDefault());
    }
    this.#toolbarControls = { title, documentMenu, saveState, mode, export: exportButton };
    actions.append(mode, exportButton);
    this.#toolbar.append(identity, actions);
    this.#layoutHeader.className = "mmt-composer-layout-header";
    this.#layoutHeader.setAttribute("role", "group");
    this.#layoutHeader.setAttribute("aria-label", "排版工具");
    this.#layoutSettings = this.#button("排版设置", async () => {
      await this.prepareModeSwitch();
      this.#openLayoutSettings();
    });
    this.#layoutSettings.setAttribute("aria-haspopup", "dialog");
    this.#layoutSettings.addEventListener("pointerdown", (event) => event.preventDefault());
    this.#layoutSummary.className = "mmt-composer-layout-summary";
    this.#layoutHeader.append(this.#layoutSettings, this.#layoutSummary);
    this.#layoutHeader.hidden = true;
    this.#content.className = "mmt-composer-content";
    this.typesetContainer.className = "mmt-composer-typeset";
    this.typesetContainer.tabIndex = -1;
    this.typesetContainer.setAttribute("aria-label", "聊天创作画布");
    this.#placeholder.className = "mmt-composer-inactive";
    this.#placeholder.append(this.#status("此作品的画布当前未激活。"), this.#button("在此继续创作", () => ports.focus(), "primary"));
    this.#empty.className = "mmt-composer-empty";
    const emptyTitle = document.createElement("h2");
    emptyTitle.textContent = "开始第一段对话";
    const emptyActions = document.createElement("div");
    emptyActions.className = "mmt-composer-empty-actions";
    emptyActions.append(
      this.#button("选择角色", () => this.#openSpeakerLibrary(), "primary"),
      this.#button("以老师开始", () => {
        ports.draft.speaker = { kind: "builtin" };
        ports.draft.side = "right";
        ports.draft.avatarChoice = null;
        ports.draft.statementKind = "message";
        this.#render(ports.runtime.state);
        this.#draftInput.focus();
      }),
    );
    this.#empty.append(emptyTitle, emptyActions);
    this.#empty.hidden = true;
    this.#canvasStatus.className = "mmt-composer-canvas-status";
    this.#canvasStatus.setAttribute("role", "status");
    this.#canvasStatus.setAttribute("aria-live", "polite");
    this.#canvasStatus.hidden = true;
    this.#context.className = "mmt-composer-context-actions";
    this.#context.setAttribute("aria-label", "选中内容操作");
    this.#context.hidden = true;
    this.#nodeMenuButton = this.#button("更多", () => {
      const state = this.#ports.runtime.state;
      const node = state.snapshot?.nodes.find((candidate) => candidate.nodeKey === state.selectedNodeKey);
      if (node) this.#openProperties(node);
    });
    this.#nodeMenuButton.classList.add("mmt-composer-context-menu");
    this.#nodeMenuButton.dataset.action = "properties";
    this.#nodeMenuButton.setAttribute("aria-haspopup", "dialog");
    this.#bottom.className = "mmt-composer-bottom";
    this.#bottom.setAttribute("aria-label", "连续创作");
    this.#roles.className = "mmt-composer-role-tray";
    this.#roles.setAttribute("aria-label", "最近使用的角色");
    this.#draftHeader.className = "mmt-composer-draft-header";
    this.#insertStatus.className = "mmt-composer-insert-status";
    this.#recovery.className = "mmt-composer-recovery";
    this.#recovery.hidden = true;
    this.#recovery.setAttribute("aria-label", "未提交文字恢复");
    this.#add = this.#button("+ 添加", () => this.#openAddMenu());
    this.#add.className = "mmt-composer-add";
    this.#expression = this.#button("形态 / 表情", () => this.#openSpeakerLibrary(true));
    this.#expression.className = "mmt-composer-expression";
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
    this.#draftInput.addEventListener("compositionend", () => {
      this.#composing = false;
      queueMicrotask(() => {
        ports.draft.body = this.#draftInput.value;
        for (const resolve of this.#compositionWaiters) resolve();
        this.#compositionWaiters.clear();
      });
    });
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
    this.#draftHeader.append(this.#currentRole, this.#expression, this.#insertStatus);
    inputRow.append(this.#add, this.#draftInput, this.#send);
    this.#draftStatus.className = "mmt-composer-draft-status";
    this.#draftStatus.setAttribute("role", "status");
    this.#bottom.append(this.#draftHeader, inputRow, this.#roles, this.#draftStatus);
    this.#sheet.className = "mmt-composer-sheet";
    this.#sheet.hidden = true;
    this.#sheet.addEventListener("click", (event) => {
      if (event.target === this.#sheet && this.#sheetModal) this.#closeSheet();
    });
    this.#content.append(this.typesetContainer, this.#placeholder, this.#empty, this.#canvasStatus, this.#context);
    this.#root.append(this.#toolbar, this.#layoutHeader, this.#content, this.#recovery, this.#bottom, this.#sheet);
    container.replaceChildren(this.#root);
    this.#layoutObserver = new ResizeObserver(() => {
      this.#syncResponsiveLayout();
      this.#reportCanvasWidth();
    });
    this.#layoutObserver.observe(container);
    this.#layoutObserver.observe(this.typesetContainer);
    this.#layoutObserver.observe(this.#content);
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
    this.#reportCanvasWidth();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#closeSheet();
    this.prepareToLeave();
    this.#layoutObserver.disconnect();
    this.#composing = false;
    for (const resolve of this.#compositionWaiters) resolve();
    this.#compositionWaiters.clear();
    this.#subscription.dispose();
    this.#viewportChanged?.();
    this.#root.remove();
  }
  refresh(): void {
    if (!this.#composing && this.#draftInput.value !== this.#ports.draft.body) {
      this.#draftInput.value = this.#ports.draft.body;
      this.#resizeDraft();
    }
    this.#render(this.#ports.runtime.state);
  }

  /** The host drains accepted input and selects output presentation before opening this panel. */
  openExportPanel(): void {
    this.#openPanel("导出作品", (form) => {
      form.classList.add("mmt-composer-export-form");
      const format = selectField("导出格式", [["pdf", "PDF"], ["png", "PNG"], ["jpg", "JPG"], ["svg", "SVG"]], this.#ports.defaultExportFormat());
      const page = selectField("输出页", []);
      const scope = this.#status("");
      scope.classList.add("mmt-composer-output-scope");
      const dimensions = this.#status("");
      const draft = this.#status("未发送的草稿不包含在本次导出中。");
      const status = this.#status("");
      status.classList.add("mmt-composer-export-status");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.setAttribute("aria-atomic", "true");
      const actions = document.createElement("div");
      actions.className = "mmt-composer-output-actions";
      const signal = this.#sheetAbort!.signal;
      let pageSignature: string | undefined;
      let selectedPageIndex: number | undefined = this.#ports.exportDetails().pages[0]?.index;
      const start = async (staleChoice?: ExactExportRequest["staleChoice"]): Promise<void> => {
        const details = this.#ports.exportDetails();
        if (!details.state.canSelectFormat) return;
        const selectedFormat = format.control.value as ExactExportFormat;
        const selectedPage = details.pages.find((candidate) => String(candidate.index) === page.control.value);
        if (selectedFormat !== "pdf" && !selectedPage) return;
        try {
          await this.#ports.exportDocument(selectedFormat, {
            ...(staleChoice ? { staleChoice } : {}),
            ...(selectedFormat === "pdf" ? {} : { pageIndex: selectedPage!.index }),
          });
        } finally {
          if (!signal.aborted) update();
        }
      };
      const download = this.#button("下载 PDF", () => start(this.#ports.exportDetails().state.availability === "stale" ? "wait-for-latest" : undefined), "primary");
      const displayed = this.#button("导出当前排版快照", () => start("export-displayed"));
      const cancel = this.#button("取消导出", () => this.#ports.cancelExport());
      const usePdf = this.#button("改为 PDF", () => { format.control.value = "pdf"; update(); format.control.focus(); });
      const viewLayout = this.#button("查看排版", () => this.#closeSheet());
      actions.append(download, displayed, cancel);
      form.append(format.label, page.label, scope, dimensions, draft, actions, status, usePdf, viewLayout);
      const update = (): void => {
        const details = this.#ports.exportDetails();
        const state = details.state;
        const busy = state.phase === "waiting" || state.phase === "exporting";
        const selectedFormat = format.control.value as ExactExportFormat;
        const wasCancelFocused = document.activeElement === cancel;
        const wasDownloadFocused = document.activeElement === download || document.activeElement === displayed;
        const signature = details.pages.map((candidate) => `${candidate.index}:${candidate.width}:${candidate.height}`).join("|");
        if (signature !== pageSignature) {
          pageSignature = signature;
          selectedPageIndex ??= details.pages[0]?.index;
          page.control.replaceChildren();
          if (selectedPageIndex !== undefined && !details.pages.some((candidate) => candidate.index === selectedPageIndex)) {
            const unavailable = document.createElement("option");
            unavailable.value = String(selectedPageIndex);
            unavailable.textContent = `第 ${selectedPageIndex + 1} 页（当前排版中已不存在）`;
            unavailable.disabled = true;
            page.control.append(unavailable);
          }
          for (const candidate of details.pages) {
            const option = document.createElement("option");
            option.value = String(candidate.index);
            option.textContent = `第 ${candidate.index + 1} 页 · ${outputPageSize(candidate)}`;
            page.control.append(option);
          }
          if (details.pages.length === 0 && selectedPageIndex === undefined) {
            const unavailable = document.createElement("option");
            unavailable.value = "";
            unavailable.textContent = "暂无已接受的输出页";
            page.control.append(unavailable);
          }
          page.control.value = selectedPageIndex === undefined ? "" : String(selectedPageIndex);
        }
        const selectedPage = details.pages.find((candidate) => String(candidate.index) === page.control.value);
        format.control.disabled = !state.canSelectFormat;
        page.label.hidden = selectedFormat === "pdf";
        page.control.disabled = !state.canSelectFormat || details.pages.length === 0;
        scope.textContent = selectedFormat === "pdf"
          ? details.pages.length ? `整份文档 · 全部 ${details.pages.length} 页` : "等待输出页面。"
          : selectedPage ? `仅第 ${selectedPage.index + 1} 页 · 共 ${details.pages.length} 页`
            : "请选择当前排版中存在的输出页。";
        dimensions.hidden = selectedFormat === "pdf" || !selectedPage;
        if (selectedPage) dimensions.textContent = selectedFormat === "svg"
          ? `矢量页面：${outputPageSize(selectedPage)}（SVG 页面单位）`
          : `图片尺寸：${Math.ceil(selectedPage.width * 2)} × ${Math.ceil(selectedPage.height * 2)} px（2×）`;
        draft.hidden = !details.draftPending;
        download.textContent = `下载 ${selectedFormat.toUpperCase()}`;
        const validPage = selectedFormat === "pdf" || !!selectedPage;
        download.disabled = !validPage || !(state.availability === "stale" ? state.canWaitForLatest : state.canExportDisplayed);
        displayed.hidden = state.availability !== "stale" || busy;
        displayed.disabled = !state.canExportDisplayed || !validPage;
        cancel.hidden = !state.canCancel;
        form.setAttribute("aria-busy", String(busy));
        status.dataset.phase = state.phase;
        status.setAttribute("role", state.phase === "error" ? "alert" : "status");
        status.setAttribute("aria-live", state.phase === "error" ? "assertive" : "polite");
        const message = state.phase === "complete" && state.completedFileName && state.completedFormat
          ? `已生成 ${state.completedFileName} · ${state.completedFormat.toUpperCase()} · ${state.completedPageIndex === undefined ? `整份文档${state.completedPageCount === undefined ? "" : ` · ${state.completedPageCount} 页`}` : `第 ${state.completedPageIndex + 1} 页`}（下载已发起）`
          : state.phase === "waiting" ? "正在等待最新排版…"
            : state.phase === "exporting" ? "正在生成成品…"
              : state.phase === "cancelled" ? "导出已取消。作品与草稿已保留。"
                : state.phase === "idle" && state.availability === "ready" ? "成品已就绪。"
                  : state.phase === "idle" && state.availability === "stale" ? "排版正在更新，下载将等待最新成品。"
                    : state.message;
        if (status.textContent !== message) status.textContent = message;
        usePdf.hidden = state.phase !== "error" || selectedFormat === "pdf";
        usePdf.disabled = !state.canSelectFormat;
        viewLayout.hidden = state.phase !== "error";
        if (busy && state.canCancel && wasDownloadFocused) cancel.focus();
        else if (!busy && wasCancelFocused) download.focus();
      };
      format.control.addEventListener("change", update);
      page.control.addEventListener("change", () => {
        selectedPageIndex = page.control.value === "" ? undefined : Number(page.control.value);
        update();
      });
      this.#refreshPanel = update;
      update();
    }, this.#toolbarControls.export);
  }

  #openLayoutSettings(): void {
    this.#openPanel("排版设置", (form) => {
      const documentSettings = this.#button("文档设置（标题 / 作者 / 页眉 / 时间）", () => {
        this.#closeSheet();
        return this.#ports.openDocumentSettings();
      }, "primary");
      const pagesHeading = document.createElement("h3");
      pagesHeading.textContent = "已接受的输出页面";
      const pages = document.createElement("ol");
      pages.className = "mmt-composer-output-pages";
      pages.setAttribute("aria-label", "输出页面尺寸");
      const unavailable = this.#status("尚无已接受的输出页面。");
      const fontsHeading = document.createElement("h3");
      fontsHeading.textContent = "已加载字体资源";
      const fonts = this.#status("");
      const fontNote = this.#status("这是运行时已加载的资源，不是本文使用字体清单。");
      const templateNote = this.#status("页面大小与字体由当前模板决定，高级调整请进入源码。");
      const source = this.#button("高级排版（源码）", () => {
        this.#closeSheet();
        return this.#ports.switchMode("source");
      });
      form.append(documentSettings, pagesHeading, pages, unavailable, fontsHeading, fonts, fontNote, templateNote, source);
      let pageSignature: string | undefined;
      const update = (): void => {
        const details = this.#ports.exportDetails();
        const signature = details.pages.map((page) => `${page.index}:${page.width}:${page.height}`).join("|");
        if (signature !== pageSignature) {
          pageSignature = signature;
          pages.replaceChildren();
          for (const page of details.pages) {
            const item = document.createElement("li");
            item.textContent = `第 ${page.index + 1} 页：${outputPageSize(page)}（SVG 页面单位）`;
            pages.append(item);
          }
        }
        pages.hidden = details.pages.length === 0;
        unavailable.hidden = details.pages.length > 0;
        const fontNames = details.fontNames.length ? details.fontNames.join("、") : "字体资源尚未加载。";
        if (fonts.textContent !== fontNames) fonts.textContent = fontNames;
      };
      this.#refreshPanel = update;
      update();
    }, this.#layoutSettings);
  }

  /** Wait without blurring either input bridge or discarding an IME candidate. */
  async prepareModeSwitch(): Promise<void> {
    if (this.#composing) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.#compositionWaiters.add(resolve);
      await promise;
    }
    if (!this.#disposed) await this.#ports.runtime.textSession?.waitForCompositionEnd();
  }

  focusFromCanvas(backward: boolean): void {
    if (!this.#active) return;
    if (backward || this.#ports.mode() === "layout") [...this.#toolbar.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")].at(-1)?.focus();
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
    const visibleTop = Math.max(bounds.top, top);
    const height = Math.max(0, Math.min(bounds.bottom, top + (viewport?.height ?? globalThis.innerHeight)) - visibleTop);
    const laidOut = bounds.width > 0 && bounds.height > 0 && height > 0;
    this.#root.dataset.compactLayout = String(laidOut && height <= 420);
    if (laidOut) {
      this.#root.style.setProperty("--mmt-composer-viewport-height", `${height}px`);
      this.#root.style.setProperty("--mmt-composer-viewport-offset", `${visibleTop - bounds.top}px`);
    } else {
      this.#root.style.removeProperty("--mmt-composer-viewport-height");
      this.#root.style.removeProperty("--mmt-composer-viewport-offset");
    }
    const wideLayout = bounds.width >= 960;
    if (this.#wideLayout !== wideLayout) {
      this.#wideLayout = wideLayout;
      this.#syncSheetPresentation();
    }
    this.#resizeDraft();
  }

  #syncSheetPresentation(): void {
    const open = !this.#sheet.hidden;
    const sidePanel = open && this.#sheetPresentation === "properties" && this.#wideLayout;
    const wasModal = this.#sheetModal;
    this.#sheetModal = !sidePanel;
    this.#root.dataset.propertiesPanel = String(sidePanel);
    const panel = this.#sheet.querySelector<HTMLElement>('[role="dialog"]');
    panel?.setAttribute("aria-modal", String(this.#sheetModal));
    this.#content.inert = open && this.#sheetModal;
    this.typesetContainer.hidden = !this.#active || (open && this.#sheetModal) || !this.#empty.hidden;
    this.typesetContainer.tabIndex = sidePanel ? 0 : -1;
    if (open && this.#sheetModal && !wasModal && !this.#sheet.contains(document.activeElement)) {
      (this.#sheetForm?.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)")
        ?? panel?.querySelector<HTMLElement>(".mmt-composer-sheet-close"))?.focus();
    }
  }

  #reportCanvasWidth(): void {
    if (this.#disposed || !this.#active || this.#ports.mode() !== "chat") return;
    let measured = this.typesetContainer.getBoundingClientRect().width;
    if (this.typesetContainer.hidden) {
      const styles = getComputedStyle(this.#content);
      measured = this.#content.clientWidth - Number.parseFloat(styles.paddingLeft) - Number.parseFloat(styles.paddingRight);
    }
    if (measured <= 0) return;
    const width = Math.max(240, Math.min(720, Math.round(measured)));
    if (width === this.#canvasWidth) return;
    this.#canvasWidth = width;
    this.#ports.canvasResize(width);
  }

  #render(state: ComposerRuntimeState): void {
    if (this.#disposed) return;
    const mode = this.#ports.mode();
    this.#root.dataset.mode = mode;
    this.#renderToolbar(state);
    this.#root.dataset.active = String(this.#active);
    this.#root.dataset.arranging = String(this.#arranging);
    this.typesetContainer.setAttribute("aria-label", mode === "chat" ? "聊天创作画布" : "排版预览编辑画布");
    this.#layoutHeader.hidden = mode !== "layout";
    this.#layoutHeader.inert = !this.#active || !this.#sheet.hidden;
    this.#layoutSettings.disabled = !this.#active || !state.bound || this.#switchingMode;
    if (mode === "layout") {
      const pages = this.#ports.exportDetails().pages;
      const summary = pages.length ? `已接受排版 · ${pages.length} 页` : "等待输出排版";
      if (this.#layoutSummary.textContent !== summary) this.#layoutSummary.textContent = summary;
    }
    this.#placeholder.hidden = this.#active;
    this.#bottom.hidden = mode !== "chat";
    this.#bottom.inert = !this.#active || !this.#sheet.hidden || mode !== "chat";
    this.#empty.hidden = !this.#active || mode !== "chat" || !state.snapshot
      || state.snapshot.nodes.some((node) => node.kind !== "opaque" || (node.category !== "blank" && node.category !== "comment"));
    this.#syncSheetPresentation();
    const emptyTeacher = this.#empty.querySelector<HTMLButtonElement>("button:last-child");
    if (emptyTeacher) emptyTeacher.disabled = !state.snapshot?.boundaries.at(-1)?.insert?.builtinMessageSides.includes("right");
    const status = state.pending ? "正在应用修改…" : state.bound && !state.snapshot ? "正在读取作品…" : "";
    if (this.#canvasStatus.textContent !== status) this.#canvasStatus.textContent = status;
    this.#canvasStatus.hidden = !this.#active || !status;
    this.#renderRoles(state);
    this.#syncDraft(state);
    this.#renderContext(state);
    this.#renderRecoveries(state);
    this.#refreshPanel?.();
  }

  #renderToolbar(state: ComposerRuntimeState): void {
    const { title, documentMenu, saveState, mode, export: exportButton } = this.#toolbarControls;
    const label = this.#ports.documentLabel();
    if (title.textContent !== label) title.textContent = label;
    documentMenu.title = label;
    documentMenu.setAttribute("aria-label", `${label} · 作品菜单`);
    const persistence = this.#ports.saveState?.() ?? { kind: this.#ports.isDirty() ? "unsaved" : "saved" };
    const status = persistence.kind === "saving" ? "保存中…" : persistence.kind === "error" ? "保存失败 · 重试" : persistence.kind === "unsaved" ? "未保存" : "已保存";
    if (saveState.textContent !== status) saveState.textContent = status;
    saveState.dataset.state = persistence.kind;
    saveState.title = persistence.message ?? (persistence.kind === "unsaved" ? "保存当前作品" : status);
    saveState.setAttribute("aria-label", persistence.kind === "unsaved" ? "未保存 · 点击保存" : persistence.kind === "error" ? `保存失败 · 点击重试${persistence.message ? `：${persistence.message}` : ""}` : status);
    saveState.setAttribute("aria-busy", String(persistence.kind === "saving"));
    saveState.disabled = !this.#active || !state.bound || persistence.kind === "saved" || persistence.kind === "saving";
    const modeLabel = this.#ports.mode() === "chat" ? "聊天创作" : "排版预览";
    if (mode.dataset.mode !== this.#ports.mode()) {
      mode.dataset.mode = this.#ports.mode();
      const caption = document.createElement("span");
      caption.textContent = modeLabel;
      mode.replaceChildren(caption, composerIcon("chevron"));
    }
    mode.setAttribute("aria-label", `切换模式 · 当前为${modeLabel}`);
    mode.disabled = !this.#active || this.#switchingMode;
    mode.setAttribute("aria-busy", String(this.#switchingMode));
    documentMenu.disabled = !this.#active;
    exportButton.disabled = !this.#active || !state.bound || state.pending || this.#switchingMode;
  }

  async #saveDocument(): Promise<void> {
    try { await this.#ports.runtime.save(); }
    finally { this.refresh(); }
  }

  #openDocumentMenu(): void {
    const runtime = this.#ports.runtime;
    const state = runtime.state;
    const available = !!state.bound && !state.pending;
    const history = runtime.textSession?.contextActions;
    this.#openPanel("作品菜单", (form) => {
      const group = (label: string): HTMLElement => {
        const section = document.createElement("section");
        section.className = "mmt-composer-menu-group";
        const heading = document.createElement("h3");
        heading.textContent = label;
        section.append(heading);
        form.append(section);
        return section;
      };
      const action = (section: HTMLElement, label: string, run: () => unknown | PromiseLike<unknown>, enabled = true): HTMLButtonElement => {
        const button = this.#button(label, () => { this.#closeSheet(); return run(); });
        button.disabled = !enabled;
        section.append(button);
        return button;
      };
      const work = group("作品");
      action(work, "新建作品", () => this.#ports.newDocument());
      action(work, "打开作品", () => this.#ports.openDocument());
      action(work, "保存", () => this.#saveDocument(), !!state.bound && this.#ports.saveState?.().kind !== "saving");
      action(work, "下载源文件", () => this.#ports.downloadSource(), !!state.bound);
      const editing = group("编辑与历史");
      action(editing, "撤销", () => runtime.textSession?.runContextAction("undo"), available && !!history?.some((item) => item.id === "undo" && item.enabled));
      action(editing, "重做", () => runtime.textSession?.runContextAction("redo"), available && !!history?.some((item) => item.id === "redo" && item.enabled));
      action(editing, "本地历史", () => runtime.showHistory(), available);
      const advanced = group("高级");
      const arrange = action(advanced, this.#arranging ? "完成整理" : "整理内容", () => {
        this.#arranging = !this.#arranging;
        this.#render(runtime.state);
      }, available && !!state.snapshot);
      arrange.setAttribute("aria-pressed", String(this.#arranging));
      action(advanced, "源码与高级工作区", () => this.#ports.switchMode("source"), !!state.bound);
      action(advanced, `问题 (${this.#ports.diagnosticsCount()})`, () => this.#ports.openProblems(), !!state.bound);
      action(advanced, "打开预览分屏", () => runtime.openPreview(), available);
    }, this.#toolbarControls.documentMenu);
  }

  #openAuthoringModeMenu(): void {
    this.#openPanel("切换模式", (form) => {
      form.classList.add("mmt-composer-mode-options");
      for (const [mode, label, description] of [
        ["chat", "聊天创作", "连续写新消息，点击画布修改"],
        ["layout", "排版预览", "查看最终页面，直接编辑已有内容"],
        ["source", "源码", "打开源码与原生高级工作区"],
      ] as const) {
        const button = this.#button("", async () => {
          this.#closeSheet();
          if (mode === this.#ports.mode()) return;
          this.#switchingMode = true;
          this.#renderToolbar(this.#ports.runtime.state);
          try { await this.#ports.switchMode(mode); }
          finally {
            this.#switchingMode = false;
            if (!this.#disposed) this.refresh();
          }
        });
        button.className = "mmt-composer-mode-option";
        button.setAttribute("aria-pressed", String(mode === this.#ports.mode()));
        const caption = document.createElement("strong");
        caption.textContent = label;
        const detail = document.createElement("span");
        detail.textContent = description;
        button.append(caption, detail);
        form.append(button);
      }
    }, this.#toolbarControls.mode);
  }

  #renderContext(state: ComposerRuntimeState): void {
    const focusedAction = this.#context.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined;
    this.#context.replaceChildren();
    const snapshot = state.snapshot;
    const node = snapshot?.nodes.find((candidate) => candidate.nodeKey === state.selectedNodeKey);
    this.#context.hidden = !this.#active || (!node && !this.#arranging);
    this.#context.inert = state.pending || !this.#sheet.hidden;
    if (!snapshot) return;
    if (this.#arranging) {
      this.#context.append(this.#button("完成整理", () => { this.#arranging = false; this.refresh(); }));
      const chosen = selectField("整理内容", [["", "选择内容"], ...snapshot.nodes.map((item) => [item.nodeKey, nodeLabel(item)] as const)], node?.nodeKey ?? "");
      chosen.control.addEventListener("change", () => this.#ports.runtime.selectNode(chosen.control.value || null));
      this.#context.append(chosen.label);
    }
    if (!node) return;
    const title = document.createElement("span");
    title.className = "mmt-composer-selected-label";
    const session = this.#ports.runtime.textSession;
    const editing = node.kind !== "opaque" && session?.selection?.focus.node.nodeKey === node.nodeKey;
    const statementNumber = snapshot.nodes.slice(0, snapshot.nodes.indexOf(node) + 1).filter((item) => item.kind !== "opaque").length;
    title.textContent = editing ? `正在修改第 ${statementNumber} 条` : nodeLabel(node);
    this.#context.append(title);
    const action = (label: string, key: string, run: () => unknown | PromiseLike<unknown>, enabled = true) => {
      const button = this.#button(label, run);
      button.dataset.action = key;
      button.disabled = !enabled;
      this.#context.append(button);
      if (focusedAction === key && !state.pending && this.#sheet.hidden) button.focus();
      return button;
    };
    if (editing) action("完成编辑", "done", async () => {
      await session?.drainAccepted();
      session?.invalidate();
      await session?.refreshGeometry();
      const current = this.#ports.runtime.state.snapshot;
      if (current?.nodes.includes(node)) this.#ports.runtime.selectNode(node.nodeKey);
      if (this.#ports.mode() === "chat") this.#draftInput.focus();
    });
    else if (node.kind !== "opaque" && node.textEditing) action("编辑", "edit", () => this.#ports.editText(nodeRef(node), 0));
    else action("局部源码", "source", () => node.capabilities.replaceSource
      ? this.#openLocalEditor(node, elementAnchor(this.#nodeMenuButton), true) : this.#ports.runtime.navigateSource(node.range));
    const index = snapshot.nodes.indexOf(node);
    const insertAllowed = !!snapshot.boundaries[index]?.insert || !!snapshot.boundaries[index + 1]?.insert;
    action("插入", "insert", () => this.#openInsertPosition(node), insertAllowed);
    if (node.kind !== "opaque") {
      const move = action("移动", "move", () => this.#openMove(node), node.capabilities.moveTargets.length > 0);
      if (!node.capabilities.moveTargets.length) move.title = "无法越过高级内容或此处没有可移动的位置";
      action("删除", "delete", () => this.#executeStructure(node, { kind: "deleteNode" }), node.capabilities.delete);
    }
    this.#context.append(this.#nodeMenuButton);
    if (focusedAction === this.#nodeMenuButton.dataset.action && !state.pending && this.#sheet.hidden) this.#nodeMenuButton.focus();
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
      draft.avatarChoice = null;
      draft.statementKind = "message";
      this.#renderRoles(this.#ports.runtime.state);
      this.#syncDraft(this.#ports.runtime.state);
      this.#draftInput.focus();
    });
    teacher.ariaPressed = String(draft.speaker.kind === "builtin");
    teacher.className = "mmt-composer-role-chip mmt-composer-role-teacher";
    const teacherLabel = document.createElement("span");
    teacherLabel.textContent = "老师";
    teacher.replaceChildren(this.#portrait("teacher"), teacherLabel);
    const builtinAllowed = this.#draftBoundary()?.insert?.builtinMessageSides.includes("right") ?? false;
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
    const currentLabel = document.createElement("span");
    currentLabel.textContent = draft.statementKind === "narration" ? "旁白" : currentName;
    this.#currentRole.replaceChildren(this.#portrait(current ?? (draft.speaker.kind === "builtin" ? "teacher" : "person")), currentLabel);
    this.#currentRole.title = `切换角色 · ${currentName}`;
    this.#currentRole.setAttribute("aria-label", `切换角色 · ${currentName}`);
    this.#expression.hidden = draft.statementKind === "narration" || draft.speaker.kind === "builtin";
    const selectedItem = draft.avatarChoice && this.#ports.avatarCatalog().find((item) => avatarItemMatchesCurrent(item, draft.avatarChoice));
    this.#expression.textContent = selectedItem ? `形态 / 表情 · ${selectedItem.variant.variantId}` : "形态 / 表情";
    this.#expression.disabled = !this.#active || !snapshot;
    this.#draftInput.placeholder = draft.statementKind === "narration" ? "写下一段旁白…" : `${currentName}的下一条消息…`;
  }

  #portrait(option: ComposerSpeakerOption | "teacher" | "library" | "person"): HTMLSpanElement {
    const portrait = document.createElement("span");
    portrait.className = "mmt-composer-avatar";
    portrait.setAttribute("aria-hidden", "true");
    portrait.dataset.kind = typeof option === "string" ? option : "actor";
    if (typeof option === "string") portrait.append(composerIcon(option === "library" ? "library" : "person"));
    else {
      const initials = document.createElement("span");
      initials.className = "mmt-composer-avatar-initials";
      initials.textContent = [...option.label.trim()].slice(0, 2).join("");
      portrait.append(initials);
      portrait.title = option.label;
    }
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
    if (this.#ports.draft.speaker.kind === "actor" && this.#ports.draft.speaker.reference === option.reference && this.#ports.draft.avatarChoice) {
      current = this.#ports.draft.avatarChoice;
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

  #draftBoundary(): ComposerBoundary | undefined {
    const draft = this.#ports.draft;
    return draft.insertTarget.kind === "append" ? this.#ports.runtime.state.snapshot?.boundaries.at(-1)
      : this.#ports.runtime.resolveBoundary(draft.insertTarget.bookmark);
  }

  #syncDraft(state: ComposerRuntimeState): void {
    const boundary = this.#draftBoundary();
    const draft = this.#ports.draft;
    const insert = boundary?.insert;
    const speakerAllowed = draft.statementKind === "narration" ? !!insert?.narration : draft.speaker.kind === "builtin"
      ? insert?.builtinMessageSides.includes("right")
      : this.#speakerOptions().some((option) => option.reference === (draft.speaker.kind === "actor" ? draft.speaker.reference : "")
        && insert?.speakerSources.includes(option.source) && insert.messageSides.includes(draft.side));
    this.#send.disabled = !this.#active || this.#ports.mode() !== "chat" || this.#sending || state.pending || !insert || !speakerAllowed
      || !insert.statementModes.includes(draft.mode) || draft.body.length === 0;
    this.#add.disabled = !this.#active || state.pending || this.#sending || !insert;
    this.#draftInput.disabled = !this.#active || this.#ports.mode() !== "chat";
    const caption = this.#sending ? "提交中…" : draft.insertTarget.kind === "insert" ? "插入" : "发送";
    this.#send.querySelector("span")!.textContent = caption;
    this.#send.setAttribute("aria-label", caption);
    this.#send.title = caption;
    this.#send.setAttribute("aria-busy", String(this.#sending));
    this.#insertStatus.replaceChildren();
    const targetLabel = document.createElement("span");
    targetLabel.textContent = draft.insertTarget.kind === "append" ? "追加到末尾"
      : boundary ? this.#boundaryLabel(boundary) : !state.snapshot ? `等待确认位置 · ${draft.insertTarget.summary}` : "插入位置已失效 · 请重新选择";
    this.#insertStatus.append(targetLabel);
    if (draft.insertTarget.kind === "insert") this.#insertStatus.append(this.#button("返回末尾", () => {
      if (draft.insertTarget.kind === "insert") this.#ports.runtime.releaseBoundary(draft.insertTarget.bookmark);
      draft.insertTarget = { kind: "append" };
      this.#draftError = "";
      this.refresh();
    }));
    this.#draftStatus.textContent = this.#draftError || (!state.bound ? "没有打开 MomoScript 文档" : !state.snapshot ? "正在读取文档…"
      : !insert ? "此处不能插入，请重新选择位置或返回末尾" : !speakerAllowed ? "请选择可在此处使用的角色" : "");
    this.#draftStatus.dataset.error = String(!!this.#draftError);
    this.#draftStatus.hidden = this.#draftStatus.textContent.length === 0;
  }

  #selectSpeaker(option: ComposerSpeakerOption, avatar?: ComposerAvatarChoice | null): void {
    const draft = this.#ports.draft;
    const sameSpeaker = draft.speaker.kind === "actor" && draft.speaker.reference === option.reference;
    const snapshot = this.#ports.runtime.state.snapshot;
    const actor = snapshot?.scriptActorChoices.find((choice) => choice.reference === option.reference);
    const lastMessage = snapshot?.nodes.findLast((node) => node.kind === "message" && node.speaker?.kind === "actor" && node.speaker.reference === option.reference);
    const current = actor?.avatar ?? (lastMessage?.kind === "message" && lastMessage.speaker?.kind === "actor" ? lastMessage.speaker.avatar : null);
    draft.avatarChoice = avatar !== undefined ? avatar : sameSpeaker ? draft.avatarChoice : current?.kind === "packAvatar" ? current : null;
    draft.speaker = { kind: "actor", reference: option.reference };
    draft.side = "left";
    draft.statementKind = "message";
    if (!draft.recentSpeakers.includes(option.reference)) draft.recentSpeakers.push(option.reference);
    this.#draftError = "";
    this.#renderRoles(this.#ports.runtime.state);
    this.#syncDraft(this.#ports.runtime.state);
  }

  async #sendDraft(): Promise<void> {
    if (this.#send.disabled || this.#sending || this.#composing) return;
    const draft = this.#ports.draft;
    const body = draft.body;
    const statement: ComposerNewStatement = draft.statementKind === "narration"
      ? { kind: "narration", body: { value: body, mode: draft.mode } }
      : { kind: "message", side: draft.speaker.kind === "builtin" ? "right" : draft.side, speaker: draft.speaker,
          avatar: draft.speaker.kind === "builtin" ? null : draft.avatarChoice,
          body: { value: body, mode: draft.mode }, continued: draft.continued };
    const applied = await this.#insertStatement(statement);
    if (applied && draft.body === body) {
      draft.body = "";
      this.#draftInput.value = "";
      this.#resizeDraft();
    }
    this.#syncDraft(this.#ports.runtime.state);
    if (this.#active) this.#draftInput.focus();
  }

  async #insertStatement(statement: ComposerNewStatement, identity = this.#ports.runtime.captureIdentity(), boundary = this.#draftBoundary()): Promise<boolean> {
    if (!boundary?.insert || !identity || this.#sending) return false;
    this.#sending = true;
    this.#draftError = "";
    this.#syncDraft(this.#ports.runtime.state);
    try {
      const applied = await this.#ports.runtime.execute({
        kind: "structure", target: boundary.target, command: { kind: "insertStatement", statement },
      }, identity);
      if (!applied) this.#draftError = "未能插入，草稿已保留。请检查角色、资源与插入位置后重试。";
      return applied;
    } finally {
      this.#sending = false;
      this.#syncDraft(this.#ports.runtime.state);
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
      if (node.textEditing) canvas("编辑正文", "edit");
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
    if (selection.kind === "displayName") this.#openProperties(node);
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

  #openSpeakerLibrary(expressionsOnly = false): void {
    this.#openSheet(expressionsOnly ? "选择形态与表情" : "选择角色", () => {
      const speaker = this.#ports.draft.speaker;
      const locked = expressionsOnly && speaker.kind === "actor"
        ? this.#speakerOptions().find((option) => option.reference === speaker.reference) : undefined;
      this.#showAvatarLibrary((item) => {
        const option = locked ?? this.#speakerOptions().find((candidate) => candidate.reference === item.variant.entityId);
        if (!option) return;
        this.#selectSpeaker(option, avatarChoice(item));
        this.#closeSheet();
        this.#draftInput.focus();
      }, undefined, locked);
    });
  }

  #showAvatarLibrary(choose: (item: AvatarCatalogItem) => unknown | PromiseLike<unknown>, back?: () => void, locked?: ComposerSpeakerOption): void {
    const catalog = this.#ports.avatarCatalog();
    const allPeople = buildAvatarPickerPersonGroups(catalog);
    const knownEntities = new Set(allPeople.flatMap((person) => person.forms.map((form) => form.entityId)));
    const recent = new Set(this.#ports.draft.recentSpeakers);
    const formSources = new Map<string, GalleryPersonForm>();
    const unambiguousForms = new Map<string, GalleryPersonForm | null>();
    for (const person of this.#ports.stickerPeople()) {
      for (const form of person.forms) {
        formSources.set(`${person.key}\u0000${form.entityId}`, form);
        unambiguousForms.set(form.entityId, unambiguousForms.has(form.entityId) ? null : form);
      }
    }
    const root = () => this.#setSheetPage(locked ? `为${locked.label}选择头像` : "选择角色", (form) => {
      if (locked) form.append(this.#status("更换头像不会改变说话人；人物库支持跨人物选择。"));
      const search = textField("搜索姓名、别名、学校或组织", "input");
      const choices = document.createElement("div");
      choices.className = "mmt-composer-person-list";
      const render = () => {
        const query = search.control.value;
        this.#resetSheetImages();
        choices.replaceChildren();
        const groups = query.trim() ? buildAvatarPickerPersonGroups(catalog, query) : allPeople;
        if (!locked) {
          const preferred = this.#speakerOptions().filter((option) => option.source === "scriptActor" || this.#ports.draft.recentSpeakers.includes(option.reference));
          const matching = preferred.filter((option) => !query || `${option.label} ${option.reference}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
          if (matching.length) {
            const heading = document.createElement("h3");
            heading.textContent = "本作 / 最近";
            choices.append(heading);
            for (const option of matching) {
              const currentActor = this.#ports.runtime.state.snapshot?.scriptActorChoices.find((actor) => actor.reference === option.reference);
              const presetId = currentActor?.presetId ?? option.reference;
              const group = allPeople.find((person) => person.forms.some((item) => item.entityId === presetId));
              const role = this.#choiceRow(option.label, option.source === "scriptActor"
                ? currentActor?.avatar?.kind === "asset" ? `自定义头像 · ${currentActor.avatar.assetName}` : "脚本角色" : "最近使用",
              () => {
                if (currentActor?.avatar?.kind === "asset") {
                  this.#selectSpeaker(option, null);
                  this.#closeSheet();
                  this.#draftInput.focus();
                  return;
                }
                const form = group?.forms.find((item) => item.entityId === presetId);
                if (group && form) this.#showExpressions(group, form, (item) => {
                  this.#selectSpeaker(option, avatarChoice(item));
                  this.#closeSheet();
                  this.#draftInput.focus();
                }, root);
                else { this.#selectSpeaker(option); this.#closeSheet(); this.#draftInput.focus(); }
              });
              role.dataset.speaker = option.reference;
              const current = currentActor?.avatar;
              const item = current?.kind === "packAvatar" ? catalog.find((entry) => avatarItemMatchesCurrent(entry, current))
                : current?.kind === "asset" ? undefined : group?.forms.find((entry) => entry.entityId === presetId)?.items.find((entry) => entry.variant.isEntityDefault && entry.selectable);
              const source = current?.kind === "asset" || !group ? undefined : formSources.get(`${group.key}\u0000${presetId}`);
              role.prepend(this.#identityPreview(option.label, item, source));
              choices.append(role);
            }
          }
        }
        const heading = document.createElement("h3");
        heading.textContent = "完整角色库";
        choices.append(heading);
        const ordered = [...groups].sort((left, right) => Number(right.forms.some((form) => recent.has(form.entityId))) - Number(left.forms.some((form) => recent.has(form.entityId))));
        for (const person of ordered) {
          const row = this.#choiceRow(person.label, `${person.forms.length} 种形态`, () => this.#showPersonForms(person, choose, root));
          row.dataset.person = person.key;
          const previewForm = person.forms.find((form) => form.items.some((item) => item.selectable)) ?? person.forms[0]!;
          const preview = previewForm.items.find((item) => item.variant.isEntityDefault && item.selectable)
            ?? previewForm.items.find((item) => item.selectable);
          row.prepend(this.#identityPreview(person.label, preview, formSources.get(`${person.key}\u0000${previewForm.entityId}`)));
          choices.append(row);
        }
        if (!locked) {
          for (const option of this.#speakerOptions()) {
            if (option.source !== "packEntity" || knownEntities.has(option.reference)
              || (query && !`${option.label} ${option.reference}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))) continue;
            const role = this.#choiceRow(option.label, "可用角色 · 未提供头像目录", () => {
              this.#selectSpeaker(option, null);
              this.#closeSheet();
              this.#draftInput.focus();
            });
            role.prepend(this.#identityPreview(option.label, undefined, unambiguousForms.get(option.reference) ?? undefined));
            choices.append(role);
          }
        }
        if (groups.length === 0) choices.append(this.#status("没有匹配的角色。离线或旧资源包仍可使用本作角色。"));
      };
      search.control.addEventListener("input", render);
      form.append(search.label, choices, this.#button("自定义角色与资源", () => this.#customSource()));
      render();
    }, back);
    root();
  }


  #showPersonForms(person: AvatarPickerPersonGroup, choose: (item: AvatarCatalogItem) => unknown | PromiseLike<unknown>, back: () => void): void {
    if (person.forms.length === 1) { this.#showExpressions(person, person.forms[0]!, choose, back); return; }
    const sources = this.#ports.stickerPeople().find((candidate) => candidate.key === person.key)?.forms;
    const forms = () => this.#setSheetPage(person.label, (container) => {
      for (const form of person.forms) {
        const detail = person.forms.some((candidate) => candidate !== form && candidate.displayName === form.displayName)
          ? `${form.displayName} · ${form.entityId}` : form.displayName;
        const row = this.#choiceRow(form.label, detail, () => this.#showExpressions(person, form, choose, forms));
        row.dataset.entity = form.entityId;
        const preview = form.items.find((item) => item.variant.isEntityDefault && item.selectable) ?? form.items.find((item) => item.selectable);
        const source = sources?.find((candidate) => candidate.entityId === form.entityId);
        row.prepend(this.#identityPreview(form.displayName, preview, source));
        container.append(row);
      }
    }, back);
    forms();
  }

  #showExpressions(person: AvatarPickerPersonGroup, form: AvatarPickerPersonForm, choose: (item: AvatarCatalogItem) => unknown | PromiseLike<unknown>, back: () => void): void {
    const available = form.items.filter((item) => item.selectable);
    if (available.length === 1) { void Promise.resolve(choose(available[0]!)); return; }
    this.#setSheetPage(`${person.label} · ${form.label}`, (container) => {
      const grid = document.createElement("div");
      grid.className = "mmt-composer-expression-grid";
      for (const item of form.items) {
        const label = item.variant.isEntityDefault ? `默认 · ${item.variant.variantId}` : item.variant.variantId;
        const button = this.#button(label, () => choose(item));
        button.className = "mmt-composer-expression-card";
        button.disabled = !item.selectable;
        button.title = item.selectable ? label : `${label} · 资源当前不可用`;
        button.dataset.variant = item.variant.variantId;
        button.dataset.entity = item.variant.entityId;
        button.setAttribute("aria-label", `${form.displayName} · ${label}`);
        button.setAttribute("aria-pressed", String(avatarItemMatchesCurrent(item, this.#ports.draft.avatarChoice)));
        const caption = document.createElement("span");
        caption.textContent = label;
        button.replaceChildren(this.#identityPreview(form.displayName, item), caption);
        grid.append(button);
      }
      container.append(grid);
      if (!available.length) container.append(this.#status("此形态的头像暂不可用；可返回选择其他形态或人物。"));
    }, back);
  }

  #identityPreview(label: string, item?: AvatarCatalogItem, form?: GalleryPersonForm): HTMLElement {
    const preview = document.createElement("span");
    preview.className = "mmt-composer-avatar mmt-composer-identity-preview";
    preview.setAttribute("aria-hidden", "true");
    preview.title = label;
    const initials = document.createElement("span");
    initials.className = "mmt-composer-avatar-initials";
    initials.textContent = [...label.trim()].slice(0, 2).join("");
    preview.append(initials);
    if (item || form) this.#queueSheetImage(preview, (signal) => item
      ? this.#ports.avatarThumbnail(item, signal) : this.#ports.personThumbnail(form!, signal));
    return preview;
  }

  #queueSheetImage(preview: HTMLElement, load: (signal: AbortSignal) => Promise<string | undefined>, unavailable?: () => void): void {
    this.#sheetImages.set(preview, { load, unavailable });
    this.#sheetImageObserver!.observe(preview);
  }

  #resetSheetImages(): void {
    this.#sheetImageObserver?.disconnect();
    this.#sheetImages.clear();
  }

  async #loadSheetImage(preview: HTMLElement, request: { readonly load: (signal: AbortSignal) => Promise<string | undefined>; readonly unavailable?: () => void }): Promise<void> {
    const signal = this.#sheetAbort!.signal;
    const failed = () => {
      preview.dataset.imageState = "unavailable";
      preview.title = `${preview.title} · 图片暂不可用`;
      request.unavailable?.();
    };
    try {
      const url = await request.load(signal);
      if (signal.aborted || !preview.isConnected) return;
      if (!url) { failed(); return; }
      const image = document.createElement("img");
      image.alt = "";
      image.decoding = "async";
      const cancel = () => { image.removeAttribute("src"); image.remove(); };
      signal.addEventListener("abort", cancel, { once: true });
      image.addEventListener("load", () => {
        signal.removeEventListener("abort", cancel);
        preview.dataset.imageState = "loaded";
      }, { once: true });
      image.addEventListener("error", () => {
        signal.removeEventListener("abort", cancel);
        image.remove();
        if (!signal.aborted) failed();
      }, { once: true });
      image.src = url;
      preview.append(image);
    } catch {
      if (!signal.aborted && preview.isConnected) failed();
    }
  }

  #choiceRow(label: string, detail: string, run: () => unknown | PromiseLike<unknown>): HTMLButtonElement {
    const row = this.#button("", run);
    row.className = "mmt-composer-choice-row";
    const copy = document.createElement("span");
    const caption = document.createElement("strong");
    caption.textContent = label;
    const description = document.createElement("span");
    description.textContent = detail;
    copy.append(caption, description);
    row.append(copy);
    return row;
  }

  #customSource(): void {
    const state = this.#ports.runtime.state;
    const selected = state.snapshot?.nodes.find((node) => node.nodeKey === state.selectedNodeKey);
    this.#closeSheet();
    if (selected?.capabilities.replaceSource) void this.#openLocalEditor(selected, elementAnchor(this.#nodeMenuButton), true);
    else void this.#ports.switchMode("source");
  }

  #boundaryLabel(boundary: ComposerBoundary): string {
    const snapshot = this.#ports.runtime.state.snapshot;
    if (!snapshot) return "等待插入位置";
    const index = snapshot.boundaries.indexOf(boundary);
    const before = snapshot.nodes[index - 1];
    const after = snapshot.nodes[index];
    return after ? `${before ? nodeLabel(before) : "开头"} → ${nodeLabel(after)}` : "追加到末尾";
  }

  #openInsert(boundary: ComposerBoundary): void {
    const bookmark = this.#ports.runtime.captureBoundary(boundary);
    if (!bookmark) return;
    const draft = this.#ports.draft;
    if (draft.insertTarget.kind === "insert") this.#ports.runtime.releaseBoundary(draft.insertTarget.bookmark);
    draft.insertTarget = { kind: "insert", bookmark, summary: this.#boundaryLabel(boundary) };
    this.#draftError = "";
    this.#closeSheet();
    this.refresh();
    if (this.#ports.mode() === "chat") this.#draftInput.focus();
    else this.#openAddMenu();
  }

  #openInsertPosition(node: ComposerDocumentNode): void {
    const snapshot = this.#ports.runtime.state.snapshot;
    if (!snapshot?.nodes.includes(node)) return;
    const index = snapshot.nodes.indexOf(node);
    this.#openSheet("选择插入位置", (form) => {
      form.append(this.#status(nodeLabel(node)));
      for (const [offset, label] of [[0, "在这条前面插入"], [1, "在这条后面插入"]] as const) {
        const boundary = snapshot.boundaries[index + offset];
        if (boundary?.insert) form.append(this.#choiceRow(label, this.#boundaryLabel(boundary), () => this.#openInsert(boundary)));
      }
    });
  }

  #openMove(node: Exclude<ComposerDocumentNode, { kind: "opaque" }>): void {
    this.#openSheet("移动内容", (form, identity) => {
      form.append(this.#status(nodeLabel(node)));
      const run = async (anchor: ComposerDocumentSnapshot["boundaries"][number]["target"]) => {
        if (await this.#executeStructure(node, { kind: "moveNode", anchor }, identity)) this.#closeSheet();
      };
      if (node.capabilities.moveUp) form.append(this.#button("上移", () => run(node.capabilities.moveUp!)));
      if (node.capabilities.moveDown) form.append(this.#button("下移", () => run(node.capabilities.moveDown!)));
      const snapshot = this.#ports.runtime.state.snapshot!;
      const targets = node.capabilities.moveTargets.map((target) => snapshot.boundaries.find((boundary) => sameBoundary(boundary.target, target))!);
      if (targets.length) {
        const position = selectField("移到指定位置", targets.map((boundary, index) => [String(index), this.#boundaryLabel(boundary)]));
        form.append(position.label, this.#submitButton("移动到这里", () => run(targets[Number(position.control.value)]!.target)));
      }
      form.append(this.#status("只列出当前源码授权的位置；不能跨越不透明高级内容。"));
    });
  }

  #openAddMenu(): void {
    const boundary = this.#draftBoundary();
    if (!boundary?.insert) return;
    const insert = boundary.insert;
    this.#openSheet("添加内容", () => {
      const root = () => this.#setSheetPage("添加内容", (form) => {
        form.append(this.#status(this.#boundaryLabel(boundary)));
        if (insert.messageSides.length || insert.builtinMessageSides.length) form.append(this.#choiceRow("文字消息", "在底部继续写下一条消息", () => {
          this.#ports.draft.statementKind = "message";
          this.#closeSheet();
          this.refresh();
          this.#draftInput.focus();
        }));
        if (insert.narration) form.append(this.#choiceRow("旁白", "在底部输入旁白，不改变已选角色", () => {
          this.#ports.draft.statementKind = "narration";
          this.#closeSheet();
          this.refresh();
          this.#draftInput.focus();
        }));
        const mediaAllowed = this.#mediaAllowed(boundary);
        const image = this.#choiceRow("图片", "选择已声明图片或导入本地 PNG / JPEG", () => this.#showImages(root));
        image.disabled = !mediaAllowed;
        const sticker = this.#choiceRow("角色差分", "人物 → 形态 → 套组与差分", () => this.#showStickerPeople(root));
        sticker.disabled = !mediaAllowed;
        form.append(image, sticker);
        if (!mediaAllowed) form.append(this.#status("请先选择可在此位置发言的角色，再添加图片或差分。"));
        form.append(this.#choiceRow("新消息高级设置", "左右、连续状态与文本模式", () => this.#showDraftAdvanced(root)));
      });
      root();
    });
  }

  #mediaAllowed(boundary: ComposerBoundary): boolean {
    const insert = boundary.insert;
    const draft = this.#ports.draft;
    if (!insert) return false;
    if (draft.speaker.kind === "builtin") return insert.builtinMessageSides.includes("right");
    const reference = draft.speaker.reference;
    const option = this.#speakerOptions().find((item) => item.reference === reference);
    return !!option && insert.speakerSources.includes(option.source) && insert.messageSides.includes(draft.side);
  }

  #showDraftAdvanced(back: () => void): void {
    this.#setSheetPage("新消息高级设置", (form) => {
      const draft = this.#ports.draft;
      const insert = this.#draftBoundary()?.insert;
      if (!insert) return;
      const sides = draft.speaker.kind === "builtin" ? insert.builtinMessageSides : insert.messageSides;
      const side = selectField("左右", sides.map((value) => [value, value === "left" ? "左侧" : "右侧"]), draft.side);
      const continued = selectField("连续消息", [["auto", "自动"], ["true", "强制连续"], ["false", "强制新消息"]], draft.continued);
      const mode = modeField(insert.statementModes, draft.mode);
      if (draft.statementKind === "message") form.append(side.label, continued.label);
      form.append(mode.label, this.#submitButton("应用到下一条", () => {
        if (draft.statementKind === "message") {
          draft.side = side.control.value as ComposerMessageSide;
          draft.continued = continued.control.value as StatementContinuedValue;
        }
        draft.mode = mode.control.value as StatementTextMode;
        this.#closeSheet();
        this.refresh();
      }));
    }, back);
  }

  #showImages(back: () => void): void {
    this.#setSheetPage("添加图片", (form) => {
      form.append(this.#button("导入本地 PNG / JPEG", async () => {
        const identity = this.#ports.runtime.captureIdentity();
        const boundary = this.#draftBoundary();
        const signal = this.#sheetAbort!.signal;
        if (!identity || !boundary?.insert) return;
        let imported: ComposerImportedImage | null = null;
        let accepted = false;
        try {
          imported = await this.#ports.importLocalImage();
          if (!imported || signal.aborted) return;
          accepted = await this.#submitMedia(imported.media, identity, boundary);
        } catch (error) {
          this.#showMediaError(error instanceof Error ? error.message : "无法导入图片，未改动作品。");
        } finally {
          if (imported) {
            try { await imported.finish(accepted); }
            catch (error) { this.#showMediaError(error instanceof Error ? error.message : "无法清理此次未使用的图片。"); }
          }
        }
      }));
      const assets = this.#ports.runtime.state.snapshot?.assetChoices ?? [];
      if (assets.length) {
        const heading = document.createElement("h3");
        heading.textContent = "作品中的图片";
        form.append(heading);
        for (const asset of assets) form.append(this.#choiceRow(asset.assetName, "已声明的图片资源", () => this.#submitMedia({ kind: "asset", assetName: asset.assetName })));
      } else form.append(this.#status("作品尚未声明图片，可从本地导入。"));
    }, back);
  }

  async #submitMedia(media: ComposerMediaChoice, identity = this.#ports.runtime.captureIdentity(), boundary = this.#draftBoundary()): Promise<boolean> {
    if (!identity || !boundary?.insert || !this.#mediaAllowed(boundary) || this.#sending) return false;
    const draft = this.#ports.draft;
    const accepted = await this.#insertStatement({
      kind: "media", side: draft.speaker.kind === "builtin" ? "right" : draft.side, speaker: draft.speaker,
      avatar: draft.speaker.kind === "builtin" ? null : draft.avatarChoice, continued: draft.continued, media,
    }, identity, boundary);
    if (accepted) this.#closeSheet();
    else this.#showMediaError("未能插入图片或差分，正文草稿已保留。请检查资源或重新选择插入位置。");
    return accepted;
  }

  #showMediaError(message: string): void {
    this.#draftError = message;
    this.#syncDraft(this.#ports.runtime.state);
    if (this.#sheetForm) {
      const status = this.#sheetForm.querySelector<HTMLElement>("[data-media-error]") ?? this.#status(message);
      status.dataset.mediaError = "";
      status.setAttribute("role", "alert");
      status.textContent = message;
      if (!status.isConnected) this.#sheetForm.append(status);
    }
  }

  #showStickerPeople(back: () => void): void {
    const root = () => this.#setSheetPage("选择差分人物", (form) => {
      const search = textField("搜索姓名、别名、学校或组织", "input");
      const choices = document.createElement("div");
      choices.className = "mmt-composer-person-list";
      const render = () => {
        const query = search.control.value.trim().toLocaleLowerCase();
        this.#resetSheetImages();
        choices.replaceChildren();
        const people = this.#ports.stickerPeople().filter((person) => person.forms.some((form) => form.stickerSets.length)
          && (!query || [person.label, ...person.searchTerms, ...person.forms.flatMap((form) => [form.label, form.displayName, ...form.searchTerms])]
            .some((term) => term.toLocaleLowerCase().includes(query))));
        for (const person of people) {
          const row = this.#choiceRow(person.label, `${person.forms.length} 种形态`, () => this.#showStickerForms(person, root));
          row.dataset.person = person.key;
          row.prepend(this.#identityPreview(person.label, undefined, person.forms.find((candidate) => candidate.stickerSets.length)));
          choices.append(row);
        }
        if (!people.length) choices.append(this.#status("没有可用差分。离线时请确认资源包已加载。"));
      };
      search.control.addEventListener("input", render);
      form.append(search.label, choices);
      render();
    }, back);
    root();
  }

  #showStickerForms(person: GalleryPersonGroup, back: () => void): void {
    const forms = person.forms.filter((form) => form.stickerSets.length);
    if (forms.length === 1) { this.#showStickerSets(forms[0]!, back); return; }
    const page = () => this.#setSheetPage(person.label, (container) => {
      for (const form of forms) {
        const detail = forms.some((candidate) => candidate !== form && candidate.displayName === form.displayName)
          ? `${form.displayName} · ${form.entityId}` : form.displayName;
        const row = this.#choiceRow(form.label, detail, () => this.#showStickerSets(form, page));
        row.dataset.entity = form.entityId;
        row.prepend(this.#identityPreview(form.displayName, undefined, form));
        container.append(row);
      }
    }, back);
    page();
  }

  #showStickerSets(form: GalleryPersonForm, back: () => void): void {
    if (form.stickerSets.length === 1) { this.#showStickerVariants(form, form.stickerSets[0]!, back); return; }
    const page = () => this.#setSheetPage(form.label, (container) => {
      for (const set of form.stickerSets) container.append(this.#choiceRow(set.displayName, `${set.contributionNamespace} · ${set.variants.length} 个差分`, () => this.#showStickerVariants(form, set, page)));
    }, back);
    page();
  }

  #showStickerVariants(form: GalleryPersonForm, set: GalleryStickerSet, back: () => void): void {
    this.#setSheetPage(`${form.displayName} · ${set.displayName} · ${set.contributionNamespace}`, (container) => {
      const grid = document.createElement("div");
      grid.className = "mmt-composer-sticker-grid";
      for (const variant of set.variants) {
        const button = this.#button("", () => this.#submitMedia({ kind: "sticker", entityId: form.entityId, setId: set.selectorId, ordinal: variant.ordinal }));
        button.className = "mmt-composer-sticker-card";
        button.dataset.ordinal = String(variant.ordinal);
        button.setAttribute("aria-label", `${form.displayName} · ${set.displayName} · ${variant.ordinal}`);
        const preview = document.createElement("span");
        preview.className = "mmt-composer-sticker-preview";
        preview.title = `${form.displayName} · ${set.displayName} · ${variant.id || variant.ordinal}`;
        preview.textContent = variant.id || String(variant.ordinal);
        const caption = document.createElement("span");
        caption.textContent = variant.id || String(variant.ordinal);
        button.append(preview, caption);
        grid.append(button);
        this.#queueSheetImage(preview, (signal) => this.#ports.stickerThumbnail(form, set, variant, signal), () => {
          button.disabled = true;
          preview.textContent = "资源不可用";
          button.title = "无法加载此差分；可返回选择其他资源。";
        });
      }
      container.append(grid);
    }, back);
  }

  #openProperties(node: ComposerDocumentNode): void {
    this.#openSheet("内容属性", (_form, identity) => {
      const root = () => this.#setSheetPage("内容属性", (form) => {
        form.append(this.#status(nodeLabel(node)));
        if (node.kind === "message") {
          if (node.capabilities.setSpeaker) {
            const speaker = selectField("说话人", this.#speakerOptions().map((option) => [option.reference, option.label]), node.speaker?.kind === "actor" ? node.speaker.reference : undefined);
            form.append(speaker.label, this.#button("应用说话人", async () => {
              if (await this.#executeStructure(node, { kind: "setStatementSpeaker", speaker: { kind: "actor", reference: speaker.control.value } }, identity)) this.#closeSheet();
            }));
          }
          if (node.capabilities.setSide.length) {
            const side = selectField("左右", node.capabilities.setSide.map((value) => [value, value === "left" ? "左侧" : "右侧"]), node.side);
            form.append(side.label, this.#button("应用左右", async () => {
              if (await this.#executeStructure(node, { kind: "setStatementSide", side: side.control.value as ComposerMessageSide }, identity)) this.#closeSheet();
            }));
          }
          if (node.capabilities.setDisplayName) {
            const name = textField("显示名", "input", node.actorDisplayName ?? "");
            const apply = this.#button("从本条起应用显示名", async () => {
              if (await this.#ports.runtime.execute({ kind: "property", target: { kind: "statement", range: node.statementRange }, command: { kind: "setActorDisplayNameFromStatement", value: name.control.value } }, identity)) this.#closeSheet();
            });
            apply.disabled = !name.control.value.trim();
            name.control.addEventListener("input", () => { apply.disabled = !name.control.value.trim(); });
            form.append(name.label, apply);
          }
          if (node.actorAvatar) {
            const current = node.actorAvatar.current;
            form.append(this.#status(current?.kind === "asset" ? `自定义头像：${current.assetName}` : current?.kind === "packAvatar" ? `当前头像：${current.entityId} · ${current.variantId}` : "当前使用角色默认头像"));
            if (node.capabilities.setAvatar) form.append(this.#button("从本条起更换头像", () => this.#showAvatarLibrary(async (item) => {
              if (await this.#ports.runtime.execute({ kind: "property", target: { kind: "statement", range: node.statementRange }, command: { kind: "setActorAvatarFromStatement", avatar: avatarChoice(item) } }, identity)) this.#closeSheet();
            }, root, node.speaker?.kind === "actor" ? { reference: node.speaker.reference, label: node.speaker.displayName, source: "scriptActor" } : undefined)));
          }
          if (node.capabilities.setAvatar || node.capabilities.setDisplayName) form.append(this.#status("名字和头像从本条起，对后续同角色生效；更换头像不会更改说话人。"));
        }
        form.append(this.#button("高级 / 局部源码", () => this.#setSheetPage("高级", (advanced) => {
          if (node.kind !== "opaque") {
            if (node.kind === "message" && node.capabilities.setContinued) {
              const continued = selectField("连续消息", [["auto", "自动"], ["true", "强制连续"], ["false", "强制新消息"]], node.continued ?? "auto");
              advanced.append(continued.label, this.#button("应用连续状态", async () => {
                if (await this.#ports.runtime.execute({ kind: "property", target: { kind: "statement", range: node.statementRange }, command: { kind: "setStatementContinued", value: continued.control.value as StatementContinuedValue } }, identity)) this.#closeSheet();
              }));
            }
            if (node.capabilities.setBody) {
              const mode = modeField(["inherit", "textMacro", "textRaw", "typstMacro", "typstRaw"], node.body.mode);
              advanced.append(mode.label, this.#button("应用文本模式", async () => {
                if (await this.#ports.runtime.execute({ kind: "property", target: { kind: "statement", range: node.statementRange }, command: { kind: "setStatementBody", value: node.body.current, mode: mode.control.value as StatementTextMode } }, identity)) this.#closeSheet();
              }));
              if (!node.textEditing) advanced.append(this.#button("编辑高级正文", () => {
                this.#closeSheet();
                return this.#openLocalEditor(node, elementAnchor(this.#nodeMenuButton), false);
              }));
            }
          }
          if (node.capabilities.replaceSource) advanced.append(this.#button("编辑局部源码", () => {
            this.#closeSheet();
            return this.#openLocalEditor(node, elementAnchor(this.#nodeMenuButton), true);
          }));
          advanced.append(this.#button("转到源码", () => { this.#closeSheet(); return this.#ports.runtime.navigateSource(node.range); }));
        }, root)));
      });
      root();
    }, this.#nodeMenuButton, "properties");
  }

  #renderRecoveries(state: ComposerRuntimeState): void {
    const recoveries = this.#ports.textRecoveries();
    this.#recovery.hidden = !this.#active || !recoveries.length;
    this.#recovery.inert = !this.#sheet.hidden;
    this.#recovery.replaceChildren();
    if (!recoveries.length) return;
    const message = document.createElement("span");
    message.textContent = `${recoveries.length} 段未提交文字已保留`;
    message.setAttribute("role", "status");
    const retry = this.#button("确认目标后重试", () => this.#confirmRecovery(recoveries[0]!.id));
    retry.disabled = state.pending || !this.#ports.runtime.textSession?.captureRecoveryTarget();
    retry.title = retry.disabled ? "先在画布重新选择正确的正文或文字范围" : "确认当前目标后重新授权提交";
    this.#recovery.append(message, this.#button("查看 / 复制", () => {
      // Retained text remains readable even when its authoring snapshot has been invalidated.
      this.#openPanel("未提交文字", (form) => {
        for (const recovery of recoveries) {
          const text = textField(recovery.reason, "textarea", recovery.text);
          text.control.readOnly = true;
          form.append(text.label, this.#button("复制这段文字", () => this.#ports.copyTextRecovery(recovery.id)),
            this.#button("放弃这段文字", () => {
              this.#ports.discardTextRecovery(recovery.id);
              this.#closeSheet();
              this.refresh();
            }));
        }
        form.append(this.#status("关闭后在画布重新选择目标，再点击“确认目标后重试”。"), this.#button("返回画布选择目标", () => this.#closeSheet()));
      });
    }), retry);
  }

  async #confirmRecovery(id: string): Promise<void> {
    this.#closeSheet();
    await this.#ports.runtime.textSession?.refreshGeometry();
    const prepared = this.#ports.prepareTextRecovery(id);
    const record = this.#ports.textRecoveries().find((item) => item.id === id);
    if (!prepared || !record) { this.refresh(); return; }
    this.#openSheet("确认恢复目标", (form) => {
      const transient = this.#transient;
      form.append(this.#status(`将恢复文字替换到：${prepared.targetSummary}`));
      const text = textField("保留的文字", "textarea", record.text);
      text.control.readOnly = true;
      form.append(text.label, this.#submitButton("确认此目标并重试", async () => {
        if (this.#transient !== transient || !transient?.isCurrent() || this.#sheetForm !== form) return;
        this.#closeSheet();
        const accepted = await this.#ports.retryTextRecovery(id, prepared);
        if (!accepted) this.#draftError = "恢复未应用，文字仍保留。请重新选择正确目标后重试。";
        this.refresh();
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


  async #openAvatar(node: Extract<ComposerDocumentNode, { readonly kind: "message" }>, _anchor: PreviewContextMenuAnchor): Promise<void> {
    if (!node.actorAvatar) return;
    this.#openSheet("从本条起更换头像", (_form, identity) => {
      this.#showAvatarLibrary(async (item) => {
        if (await this.#ports.runtime.execute({ kind: "property", target: { kind: "statement", range: node.statementRange }, command: { kind: "setActorAvatarFromStatement", avatar: avatarChoice(item) } }, identity)) this.#closeSheet();
      }, undefined, { reference: node.speaker?.kind === "actor" ? node.speaker.reference : node.actorAvatar!.actorPresetId,
        label: node.speaker?.kind === "actor" ? node.speaker.displayName : node.actorAvatar!.actorPresetId, source: "scriptActor" });
    });
  }

  #executeStructure(node: ComposerDocumentNode, command: ComposerStructureCommand, identity?: ComposerRuntimeIdentity): Promise<boolean> {
    return this.#ports.runtime.execute({ kind: "structure", target: { kind: "node", node: nodeRef(node) }, command }, identity);
  }

  #speakerOptions(): readonly ComposerSpeakerOption[] {
    const snapshot = this.#ports.runtime.state.snapshot;
    return snapshot ? mergeSpeakers(snapshot.scriptActorChoices, this.#ports.packSpeakers()) : [];
  }

  #setSheetPage(title: string, render: (form: HTMLFormElement) => void, back?: () => void): void {
    const form = this.#sheetForm;
    if (!form || this.#sheet.hidden) return;
    this.#resetSheetImages();
    this.#sheetBack = back;
    const heading = this.#sheet.querySelector("h2")!;
    heading.textContent = title;
    const backButton = this.#sheet.querySelector<HTMLButtonElement>(".mmt-composer-sheet-back")!;
    backButton.hidden = !back;
    form.replaceChildren();
    form.scrollTop = 0;
    render(form);
    form.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)")?.focus();
  }

  #openSheet(title: string, render: (form: HTMLFormElement, identity: ComposerRuntimeIdentity) => void, trigger?: HTMLElement, presentation?: "properties"): void {
    const identity = this.#ports.runtime.captureIdentity();
    if (!identity) return;
    this.#openPanel(title, (form) => {
      this.#transient = this.#ports.runtime.beginTransient(() => this.#closeSheet(false));
      if (!this.#transient) { this.#closeSheet(); return; }
      render(form, identity);
    }, trigger, presentation);
  }

  #openPanel(title: string, render: (form: HTMLFormElement) => void, trigger?: HTMLElement, presentation?: "properties"): void {
    if (!this.#active || this.#disposed) return;
    const focused = trigger ?? document.activeElement;
    const focusReturn = focused instanceof HTMLElement && this.#root.contains(focused)
      ? focused : this.#toolbarControls.documentMenu;
    this.#closeSheet(true, false);
    this.#sheetFocusReturn = focusReturn;
    this.#sheetPresentation = presentation;
    this.#sheetAbort = new AbortController();
    this.#sheet.hidden = false;
    this.#sheet.replaceChildren();
    this.#toolbar.inert = true;
    this.#layoutHeader.inert = true;
    this.#bottom.inert = true;
    this.#recovery.inert = true;
    const panel = document.createElement("div");
    panel.className = "mmt-composer-sheet-panel";
    panel.tabIndex = -1;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", title);
    const heading = document.createElement("h2");
    heading.id = `mmt-composer-sheet-${crypto.randomUUID()}`;
    heading.textContent = title;
    panel.setAttribute("aria-labelledby", heading.id);
    const header = document.createElement("div");
    header.className = "mmt-composer-sheet-header";
    const close = this.#button("关闭", () => this.#closeSheet());
    close.className = "mmt-composer-sheet-close";
    const back = this.#button("返回", () => this.#sheetBack?.());
    back.className = "mmt-composer-sheet-back";
    back.hidden = true;
    header.append(back, heading, close);
    const form = document.createElement("form");
    this.#sheetForm = form;
    form.addEventListener("submit", (event) => event.preventDefault());
    panel.append(header, form);
    this.#sheet.append(panel);
    this.#syncSheetPresentation();
    this.#sheetImageObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const preview = entry.target as HTMLElement;
        const request = this.#sheetImages.get(preview);
        if (!request) continue;
        this.#sheetImageObserver!.unobserve(preview);
        this.#sheetImages.delete(preview);
        void this.#loadSheetImage(preview, request);
      }
    }, { root: form, rootMargin: "80px 0px" });
    panel.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.#closeSheet(); return; }
      if (event.key !== "Tab" || !this.#sheetModal) return;
      const controls = [...panel.querySelectorAll<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)")]
        .filter((control) => control.getClientRects().length > 0);
      const next = event.shiftKey ? controls.at(-1) : controls[0];
      const edge = event.shiftKey ? controls[0] : controls.at(-1);
      if ((document.activeElement === edge || document.activeElement === panel) && next) {
        event.preventDefault();
        next.focus();
      }
    });
    render(form);
    if (this.#sheet.hidden) return;
    (form.querySelector<HTMLElement>("input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)") ?? close).focus();
  }

  #closeSheet(closeTransient = true, restoreFocus = true): void {
    const wasOpen = !this.#sheet.hidden;
    const transient = this.#transient;
    const focusReturn = this.#sheetFocusReturn;
    this.#transient = undefined;
    this.#sheetFocusReturn = undefined;
    this.#sheetPresentation = undefined;
    this.#resetSheetImages();
    this.#sheetImageObserver = undefined;
    this.#sheetAbort?.abort();
    this.#sheetAbort = undefined;
    this.#sheetBack = undefined;
    this.#refreshPanel = undefined;
    this.#sheetForm = undefined;
    this.#sheet.hidden = true;
    this.#sheet.replaceChildren();
    this.#syncSheetPresentation();
    this.#context.inert = this.#ports.runtime.state.pending;
    this.#toolbar.inert = false;
    this.#layoutHeader.inert = !this.#active;
    this.#bottom.inert = !this.#active || this.#ports.mode() !== "chat";
    this.#recovery.inert = false;
    if (closeTransient) transient?.close();
    if (wasOpen && restoreFocus && this.#active && !this.#disposed) {
      (focusReturn?.isConnected && !focusReturn.closest("[inert], [hidden]") ? focusReturn : this.#toolbarControls.documentMenu).focus();
    }
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

function outputPageSize(page: { readonly width: number; readonly height: number }): string {
  return `${page.width} × ${page.height}`;
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
  if (node.kind === "opaque") {
    return node.category === "blank" ? "空行" : node.category === "comment" ? "注释"
      : node.category === "recoverableError" ? "待修复内容" : "高级内容";
  }
  const kind = node.kind === "message" ? node.speaker?.kind === "actor" ? node.speaker.displayName : "老师" : "旁白";
  if (!node.textEditing) return `${kind} · ${node.kind === "message" ? "非文本消息" : "媒体或高级内容"}`;
  const summary = node.textEditing.text.replace(/\s+/g, " ").slice(0, 36);
  return summary ? `${kind} · ${summary}` : `${kind} · 空正文`;
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

function avatarChoice(item: AvatarCatalogItem): ComposerAvatarChoice {
  return { kind: "packAvatar", entityId: item.variant.entityId, contributionNamespace: item.variant.contributionNamespace, variantId: item.variant.variantId };
}

function sameBoundary(left: ComposerBoundary["target"], right: ComposerBoundary["target"]): boolean {
  const sameNode = (a: ComposerNodeRef | null, b: ComposerNodeRef | null) => a === null || b === null
    ? a === b : a.nodeKey === b.nodeKey && a.nodeKind === b.nodeKind;
  return sameNode(left.before, right.before) && sameNode(left.after, right.after);
}
