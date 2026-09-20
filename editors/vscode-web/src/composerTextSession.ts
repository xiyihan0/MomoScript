import type { ComposerDocumentNode, ComposerDocumentSnapshot, ComposerNodeRef } from "./composerDocument.ts";
import {
  parseComposerEditResult,
  parseComposerTextSelection,
  type ApplyComposerTextEditOptions,
  type ComposerEditResult,
  type ComposerNativeHistory,
  type ComposerSourceSelection,
  type ComposerTextEditApplicationResult,
  type ComposerTextEditParams,
  type ComposerTextSelection,
  type ComposerTextSelectionAfter,
} from "./composerEdit.ts";
import type { ComposerRuntimeDisposable, ComposerRuntimeIdentity } from "./composerRuntime.ts";
import type {
  ComposerTextGeometry,
  ComposerTextGeometryEndpoint,
  ComposerTextGeometryIdentity,
  ComposerTextGeometrySelection,
  ComposerTextSelectionGeometry,
} from "./composerTextGeometry.ts";
import {
  isComposerIntentMessage,
  type ComposerIntent,
  type ComposerIntentMessage,
  type ComposerState,
} from "./previewWebviewProtocol.ts";

export type ComposerTextSessionApplyOptions = Omit<ApplyComposerTextEditOptions, "modelService">;

/** Application services only. The parent runtime remains the document/snapshot owner. */
export interface ComposerTextSessionPorts {
  readonly geometry: Pick<ComposerTextGeometry, "hitTest" | "caret" | "selection" | "move">;
  readonly currentGeometryIdentity: () => ComposerTextGeometryIdentity | undefined;
  readonly requestTextEdit: (params: ComposerTextEditParams, signal: AbortSignal) => PromiseLike<unknown>;
  readonly applyTextEdit: (options: ComposerTextSessionApplyOptions) => PromiseLike<ComposerTextEditApplicationResult>;
  readonly nativeHistory: (uri: string) => ComposerNativeHistory | undefined;
  readonly writeClipboard: (text: string) => PromiseLike<void>;
  /** Return only an authorized authored position; unavailable projection must not delay typing. */
  readonly sourceSelection?: (
    selection: ComposerTextSelection,
    snapshot: ComposerDocumentSnapshot,
    signal: AbortSignal,
  ) => PromiseLike<ComposerSourceSelection | undefined>;
  readonly recover: (text: string, reason: string, recoveryId: string) => unknown | PromiseLike<unknown>;
  readonly notify: (kind: "warning" | "error", message: string) => unknown | PromiseLike<unknown>;
}

export interface ComposerTextSessionBinding {
  readonly identity: ComposerRuntimeIdentity;
  readonly snapshot: ComposerDocumentSnapshot;
}

/** Internal ownership boundary used by ComposerRuntime, not a second document service. */
export interface ComposerTextSessionOwner {
  readonly current: () => ComposerTextSessionBinding | undefined;
  readonly selectNode: (nodeKey: string) => void;
  readonly isCurrent: (identity: ComposerRuntimeIdentity) => boolean;
  readonly apply: (
    identity: ComposerRuntimeIdentity,
    result: Extract<ComposerEditResult, { kind: "TextEdit" }>,
    signal: AbortSignal,
    onApplied: () => void,
    apply: (canApply: (candidate: string) => boolean) => PromiseLike<ComposerTextEditApplicationResult>,
  ) => Promise<{ application: ComposerTextEditApplicationResult; snapshot?: ComposerDocumentSnapshot }>;
  readonly history: (
    identity: ComposerRuntimeIdentity,
    direction: "undo" | "redo",
    signal: AbortSignal,
    operation: () => void | Promise<void>,
  ) => Promise<ComposerDocumentSnapshot | undefined>;
}

type TextNode = Extract<ComposerDocumentNode, { kind: "message" | "narration" }>;
type ReplaceIntent = Extract<ComposerIntent, { kind: "replace" }>;
interface QueuedIntent {
  readonly intent: ComposerIntent;
  readonly sessionId: string;
  readonly sequence: number;
  readonly admittedAt: number;
  committed: boolean;
  beforeSelection?: ComposerTextGeometrySelection;
  readonly geometryIdentity?: ComposerTextGeometryIdentity;
}
interface Composition {
  readonly selection: ComposerTextGeometrySelection;
  readonly identity: ComposerRuntimeIdentity;
  text: string;
}
interface Bookmark {
  readonly sourceDigest: string;
  readonly selection: ComposerTextSelectionAfter;
  readonly presentation: ComposerTextGeometrySelection;
  readonly preferredX: number | null;
}
interface TextGroup {
  readonly history: ComposerNativeHistory;
  readonly uri: string;
  readonly sourceDigest: string;
  readonly selection: ComposerTextSelection;
  readonly admittedAt: number;
}
interface IssuedSession {
  readonly keys: Set<string>;
  sequence: number;
  drained: boolean;
  compositionId?: string;
  compositionEnded: boolean;
}


const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });
const WORDS = new Intl.Segmenter("und", { granularity: "word" });
const IDLE_GROUP_MS = 750;
const CONFLICT = "源码或编辑上下文已更改，未提交的文字已保留，请复制后重新选择正文。";

/** Semantic intent queue and presentation only; every mutation is a Rust-authorized native edit. */
export class ComposerTextSession implements ComposerRuntimeDisposable {
  readonly #ports: ComposerTextSessionPorts;
  readonly #owner: ComposerTextSessionOwner;
  readonly #listeners = new Set<(state: ComposerState) => void>();
  readonly #queue: QueuedIntent[] = [];
  readonly #bookmarks = new Map<string, Bookmark>();
  readonly #issuedRenderKeys = new Set<string>();
  readonly #issuedSessions = new Map<string, IssuedSession>();
  readonly #geometryWaiters = new Set<(identity: ComposerTextGeometryIdentity) => void>();
  #sessionId = crypto.randomUUID();
  #sequence = 0;
  #active = false;
  #accepting = true;
  #admitting = true;
  #suspensions = 0;
  #selection: ComposerTextGeometrySelection | null = null;
  #selectionDigest: string | null = null;
  #preferredX: number | null = null;
  #sourceSelection: ComposerSourceSelection | undefined;
  #sourceSelectionDigest: string | null = null;
  #requiresPointerSelection = false;
  #pendingPointerRevocation = false;
  #composition: Composition | null = null;
  #dragAnchor: ComposerTextGeometryEndpoint | null = null;
  #dragWord: ComposerTextGeometrySelection | null = null;
  #operation: AbortController | null = null;
  #geometryAbort: AbortController | null = null;
  #geometryEpoch = 0;
  #draining: Promise<void> | null = null;
  #inFlight: QueuedIntent | null = null;
  #group: TextGroup | null = null;
  #groupTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #recoveryChunks: Array<{ readonly id: string; text: string }> = [];
  #state: ComposerState;

  constructor(owner: ComposerTextSessionOwner, ports: ComposerTextSessionPorts) {
    this.#owner = owner;
    this.#ports = ports;
    this.#state = {
      type: "composer-state", sessionId: this.#sessionId, sequence: 0,
      renderKey: `composer-unbound:${this.#sessionId}` as ComposerState["renderKey"], status: "blocked", carets: [], boxes: [],
    };
  }

  get state(): ComposerState { return this.#state; }
  get selection(): ComposerTextSelection | null { return this.#selection && wireSelection(this.#selection); }
  get recoveryText(): string { return this.#recoveryChunks.map((chunk) => chunk.text).join(""); }
  get isActive(): boolean { return this.#active; }
  get pendingIntentCount(): number { return this.#queue.length + (this.#inFlight ? 1 : 0); }
  get hasUnsubmittedInput(): boolean {
    return this.#recoveryChunks.length > 0 || !!this.#composition?.text
      || !!(this.#inFlight && isUnsubmittedText(this.#inFlight)) || this.#queue.some(isUnsubmittedText);
  }

  resolveRecovery(recoveryId: string, text: string): boolean {
    if (this.#recoveryChunks[0]?.id !== recoveryId || this.#recoveryChunks[0]?.text !== text) return false;
    this.#recoveryChunks.shift();
    return true;
  }

  /** FIFO drain recovery has no document, selection, or mutation authorization. */
  recoverRetiredIntent(message: ComposerIntentMessage): boolean {
    if (!isComposerIntentMessage(message) || message.intent.kind === "pointer") return false;
    const issued = this.#issuedSessions.get(message.sessionId);
    if (!issued || !issued.keys.has(message.renderKey) || message.sequence <= issued.sequence) return false;
    issued.sequence = message.sequence;
    if (message.sessionId === this.#sessionId) this.#sequence = Math.max(this.#sequence, message.sequence);
    this.#recoverRejected(message.intent, issued);
    return true;
  }

  acknowledgeDrained(sessionId: string): void {
    if (this.#active && sessionId === this.#sessionId) {
      const issued = this.#issuedSessions.get(sessionId);
      if (issued) issued.drained = true;
      return;
    }
    this.#issuedSessions.delete(sessionId);
  }

  onDidChangeState(listener: (state: ComposerState) => void): ComposerRuntimeDisposable {
    if (!this.#accepting) return { dispose() {} };
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  setActive(active: boolean): void {
    if (!this.#accepting || this.#active === active) return;
    if (!active) {
      this.invalidate("编辑焦点已切换，未提交的文字已保留。");
      this.#active = false;
      this.#admitting = false;
      this.#publish("blocked", [], []);
      return;
    }
    this.#active = true;
    this.#admitting = true;
    this.#publish("pending", [], []);
    this.snapshotChanged();
  }

  handleIntent(message: ComposerIntentMessage, admitted: boolean): boolean {
    if (!isComposerIntentMessage(message) || message.sessionId !== this.#sessionId || message.sequence <= this.#sequence) return false;
    const pointer = message.intent.kind === "pointer";
    const validKey = pointer ? message.renderKey === this.#state.renderKey : this.#issuedRenderKeys.has(message.renderKey);
    if (!admitted || !this.#accepting || !this.#active || !this.#admitting || this.#state.status === "blocked"
      || !validKey || (!pointer && this.#requiresPointerSelection)) {
      return this.#rejectIntent(message);
    }
    const geometryIdentity = pointer ? this.#currentGeometry() : undefined;
    if (pointer && (this.#state.status !== "ready" || !geometryIdentity || geometryIdentity.renderKey !== message.renderKey)) {
      return this.#rejectIntent(message);
    }
    this.#sequence = message.sequence;
    const issued = this.#issuedSessions.get(message.sessionId);
    if (issued) issued.sequence = message.sequence;
    for (const key of this.#issuedRenderKeys) {
      if (key === message.renderKey) break;
      this.#issuedRenderKeys.delete(key);
      issued?.keys.delete(key);
    }
    const entry = { intent: message.intent, sessionId: message.sessionId, sequence: message.sequence,
      admittedAt: performance.now(), committed: false, ...(geometryIdentity ? { geometryIdentity } : {}) };
    const last = this.#queue.at(-1);
    if (entry.intent.kind === "pointer" && entry.intent.phase === "move"
      && last?.intent.kind === "pointer" && last.intent.phase === "move") this.#queue[this.#queue.length - 1] = entry;
    else this.#queue.push(entry);
    this.#publish(this.#state.status);
    this.#startDrain();
    return true;
  }

  #rejectIntent(message: ComposerIntentMessage): false {
    this.#sequence = message.sequence;
    const issued = this.#issuedSessions.get(message.sessionId);
    if (issued) issued.sequence = message.sequence;
    this.#recoverRejected(message.intent, issued);
    if (message.intent.kind !== "pointer") {
      this.#publish(this.#state.status);
      return false;
    }
    // Earlier accepted intents still need their private FIFO selection. Block the
    // transport now, then discard that selection only after the accepted prefix drains.
    this.#requiresPointerSelection = true;
    this.#pendingPointerRevocation = true;
    this.#dragAnchor = null;
    this.#dragWord = null;
    this.#geometryAbort?.abort();
    this.#geometryEpoch += 1;
    this.#publish("blocked", [], []);
    if (!this.#draining && !this.#inFlight && this.#queue.length === 0) {
      this.#settlePointerRevocation();
      void this.refreshGeometry();
    }
    return false;
  }

  #settlePointerRevocation(): void {
    if (!this.#pendingPointerRevocation) return;
    this.#pendingPointerRevocation = false;
    this.closeTextGroup();
    this.#selection = null;
    this.#selectionDigest = null;
    this.#sourceSelection = undefined;
    this.#sourceSelectionDigest = null;
    this.#preferredX = null;
  }

  async enter(node: ComposerNodeRef, offsetUtf16: number): Promise<boolean> {
    if (!this.#accepting || !this.#active || !this.#admitting) return false;
    await this.#draining;
    const current = this.#owner.current();
    if (!current || !this.#active || !this.#admitting) return false;
    try {
      const endpoint = parseComposerTextSelection({ anchor: { node, offsetUtf16 }, focus: { node, offsetUtf16 } }, current.snapshot).focus;
      this.#cancelComposition("正文选择已更改，未提交的输入法文字已保留。");
      this.closeTextGroup();
      this.#requiresPointerSelection = false;
      this.#pendingPointerRevocation = false;
      this.#assignSelection({ anchor: endpoint, focus: endpoint }, current.snapshot);
      this.#remember(current.snapshot);
      await this.refreshGeometry();
      return true;
    } catch {
      return false;
    }
  }

  /** Called by the parent for a proved own edit. It deliberately retains the bridge and queue. */
  documentPending(): void {
    this.#geometryAbort?.abort();
    this.#geometryEpoch += 1;
    this.#publish("pending");
  }

  /** Sheets and discrete commands share admission suspension, not a second transaction queue. */
  pauseInput(): ComposerRuntimeDisposable {
    this.#suspensions += 1;
    this.#admitting = false;
    this.#publish("blocked", [], []);
    let disposed = false;
    return { dispose: () => {
      if (disposed) return;
      disposed = true;
      this.#suspensions -= 1;
      if (this.#suspensions === 0 && this.#active && this.#accepting) {
        this.#admitting = true;
        void this.refreshGeometry();
      }
    } };
  }

  async drainAccepted(): Promise<void> {
    await this.#draining;
    this.#cancelComposition("输入法文字尚未提交，已保留以便复制。");
    this.closeTextGroup();
  }

  /** Called after snapshot publication, independently of renderer publication. */
  snapshotChanged(): void {
    if (!this.#active || this.#inFlight) return;
    const current = this.#owner.current();
    if (!this.#selection && current && !this.#requiresPointerSelection) {
      const history = this.#ports.nativeHistory(current.snapshot.textDocument.uri);
      const bookmark = history && this.#bookmarks.get(`${history.uri}:${history.getAlternativeVersionId()}`);
      if (bookmark?.sourceDigest === current.snapshot.sourceDigest) {
        try {
          this.#assignSelection(rebind(bookmark.selection, current.snapshot, bookmark.presentation), current.snapshot);
          this.#preferredX = bookmark.preferredX;
        } catch { /* A bookmark is presentation, never permission to guess a new target. */ }
      }
    }
    void this.refreshGeometry();
  }

  async refreshGeometry(): Promise<void> {
    if (!this.#accepting || !this.#active) return;
    const identity = this.#currentGeometry();
    if (identity) {
      for (const wake of this.#geometryWaiters) wake(identity);
      this.#geometryWaiters.clear();
    }
    if (this.#suspensions > 0) return;
    this.#geometryAbort?.abort();
    const epoch = ++this.#geometryEpoch;
    if (!identity) {
      this.#publish("pending");
      return;
    }
    if (!this.#selection) {
      this.#publish("ready", [], [], identity.renderKey);
      return;
    }
    const selection = this.#selection;
    const controller = new AbortController();
    this.#geometryAbort = controller;
    this.#publish("pending");
    const result = await this.#ports.geometry.selection(selection, identity, controller.signal);
    if (controller.signal.aborted || epoch !== this.#geometryEpoch || this.#selection !== selection || !this.#sameGeometry(identity)) return;
    if (result.status !== "mapped" || !result.focusCaret || !result.anchorCaret) {
      this.#publish(result.status === "unavailable" && result.reason === "stale" ? "pending" : "blocked", [], []);
      return;
    }
    this.#present(result);
  }

  /** Focus/Sheet transition stops admission first, then drains already accepted user text. */
  async prepareToLeave(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return;
    const activation = this.#sessionId;
    this.#admitting = false;
    if (signal) await abortable(this.#draining ?? Promise.resolve(), signal);
    else await this.#draining;
    if (signal?.aborted || this.#sessionId !== activation || !this.#accepting || !this.#active) return;
    this.#cancelComposition("输入法文字尚未提交，已保留以便复制。");
    this.closeTextGroup();
    this.#active = false;
    this.#geometryAbort?.abort();
    this.#publish("blocked", [], []);
  }

  closeTextGroup(): void {
    clearTimeout(this.#groupTimer);
    this.#groupTimer = undefined;
    const group = this.#group;
    this.#group = null;
    if (group) {
      try { group.history.pushStackElement(); } catch { /* A disposed source model has no open history to close. */ }
    }
  }

  /** External source/catalog changes revoke all capabilities, never retarget pending text. */
  invalidate(reason = CONFLICT): void {
    this.#recoverUnsubmitted(reason);
    const interrupted = this.#inFlight !== null;
    this.#queue.length = 0;
    this.#composition = null;
    this.#inFlight = null;
    this.#operation?.abort();
    this.#geometryAbort?.abort();
    this.#geometryEpoch += 1;
    this.#selection = null;
    this.#selectionDigest = null;
    this.#sourceSelection = undefined;
    this.#requiresPointerSelection = false;
    this.#pendingPointerRevocation = false;
    this.#sourceSelectionDigest = null;
    this.#dragAnchor = null;
    this.#dragWord = null;
    this.closeTextGroup();
    if (interrupted) this.#notify("warning", reason);
    this.#publish("blocked", [], []);
  }

  quiesce(): void {
    if (!this.#accepting) return;
    this.invalidate("编辑器已关闭，未提交的文字已保留。");
    this.#admitting = false;
    this.#active = false;
    this.#accepting = false;
    this.#listeners.clear();
    this.#bookmarks.clear();
  }

  dispose(): void { this.quiesce(); }

  #startDrain(): void {
    if (this.#draining) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
      if (this.#queue.length && this.#accepting && this.#active) this.#startDrain();
      else {
        this.#settlePointerRevocation();
        if (this.#active) {
          // Pointer/navigation results already contain current geometry. Re-querying
          // them closes pointer admission between otherwise valid gestures.
          if (this.#state.status === "ready") this.#publish("ready");
          else void this.refreshGeometry();
        }
      }
    });
  }

  async #drain(): Promise<void> {
    while (this.#queue.length && this.#accepting && this.#active) {
      const entry = this.#queue.shift()!;
      const controller = new AbortController();
      this.#operation = controller;
      this.#inFlight = entry;
      try {
        await this.#process(entry, controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) this.invalidate(error instanceof Error ? error.message : "无法提交正文，未提交的文字已保留。");
      } finally {
        if (this.#operation === controller) this.#operation = null;
        if (this.#inFlight === entry) this.#inFlight = null;
      }
    }
  }

  async #process(entry: QueuedIntent, signal: AbortSignal): Promise<void> {
    const intent = entry.intent;
    if (intent.kind === "pointer" && intent.phase !== "start" && !this.#dragAnchor) return;
    if (intent.kind !== "pointer") { this.#dragAnchor = null; this.#dragWord = null; }
    if (intent.kind === "composition") {
      if (intent.phase === "cancel") {
        this.#recoverRejected(intent, this.#issuedSessions.get(entry.sessionId));
        this.#composition = null;
        this.closeTextGroup();
        return;
      }
      if (intent.phase === "start") {
        this.closeTextGroup();
        const current = this.#requireSelection();
        this.#composition = { selection: this.#selection!, identity: current.identity, text: intent.text };
        const issued = this.#issuedSessions.get(entry.sessionId);
        if (issued) { issued.compositionId = undefined; issued.compositionEnded = false; }
        return;
      }
      if (!this.#composition) return;
      if (intent.phase === "update") { this.#composition.text = intent.text; return; }
      const composition = this.#composition;
      if (!this.#owner.isCurrent(composition.identity)) throw new Error(CONFLICT);
      this.#selection = composition.selection;
      this.#composition = null;
      await this.#replace(entry, intent.text, "composition", signal);
      return;
    }
    if (intent.kind === "replace") {
      if (this.#composition) throw new Error("输入法组合仍在进行，尚未提交的文字已保留。");
      if (intent.origin === "cut") {
        this.closeTextGroup();
        if (!await this.#copy(signal)) return;
      }
      if (intent.origin === "delete" && this.#selection && collapsed(this.#selection)) {
        const current = this.#requireSelection();
        const endpoint = this.#selection.focus;
        const node = requireNode(endpoint, current.snapshot);
        const next = deleteBoundary(node.textEditing!.text, endpoint.offsetUtf16, intent.direction === "backward", intent.granularity);
        if (next === endpoint.offsetUtf16) { this.closeTextGroup(); return; }
        entry.beforeSelection = this.#selection;
        this.#selection = { anchor: endpoint, focus: { ...endpoint, offsetUtf16: next } };
      }
      await this.#replace(entry, intent.text, intent.origin, signal);
      return;
    }
    this.closeTextGroup();
    if (intent.kind === "copy") { await this.#copy(signal); return; }
    if (intent.kind === "history") { await this.#history(intent.direction, signal); return; }
    if (this.#composition) return;
    if (intent.kind === "pointer") {
      if (!entry.geometryIdentity) throw new Error("指针位置没有有效的排版授权。");
      await this.#pointer(intent, entry.geometryIdentity, signal);
      return;
    }
    if (intent.kind === "move") {
      this.#requireSelection();
      const identity = await this.#awaitGeometry(signal);
      const result = await abortable(this.#ports.geometry.move(this.#selection!, intent.direction, intent.granularity, intent.extend,
        this.#preferredX, identity, signal), signal);
      if (signal.aborted) return;
      if (!this.#sameGeometry(identity)) throw new Error("排版位置已更改，请重新选择正文；后续输入已保留。");
      if (result.status !== "mapped") throw new Error("无法授权光标移动，后续未提交的文字已保留。");
      this.#assignSelection(result.selection, this.#requireSelection().snapshot);
      this.#preferredX = result.preferredX;
      this.#present(result);
      this.#remember(this.#requireSelection().snapshot);
    }
  }

  async #replace(entry: QueuedIntent, text: string, origin: ReplaceIntent["origin"] | "composition", signal: AbortSignal): Promise<void> {
    const current = this.#requireSelection();
    const selection = wireSelection(this.#selection!);
    const history = this.#ports.nativeHistory(current.snapshot.textDocument.uri);
    if (!history) throw new Error("当前源码模型不可用，未提交的文字已保留。");
    const modelVersion = history.getVersionId();
    this.#remember(current.snapshot, history, undefined, entry.beforeSelection);
    const typing = origin === "typing" && !/[\r\n]/u.test(text) && collapsed(selection);
    const continuing = typing && this.#group?.uri === history.uri && this.#group.sourceDigest === current.snapshot.sourceDigest
      && sameSelection(this.#group.selection, selection) && entry.admittedAt - this.#group.admittedAt < IDLE_GROUP_MS;
    if (!continuing) this.closeTextGroup();
    clearTimeout(this.#groupTimer);
    this.#groupTimer = undefined;
    let beforeSelection = this.#sourceSelectionDigest === current.snapshot.sourceDigest ? this.#sourceSelection : undefined;
    if (!beforeSelection && this.#ports.sourceSelection) beforeSelection = await abortable(
      this.#ports.sourceSelection(wireSelection(entry.beforeSelection ?? selection), current.snapshot, signal), signal);
    this.#assertCurrent(current, signal);
    // These are Rust-authorized statement boundaries, not guessed body offsets. Exact
    // projection positions win when available; renderer lag never blocks the edit FIFO.
    const nativeBefore = beforeSelection ?? {
      anchor: requireNode(selection.anchor, current.snapshot).statementRange.end,
      focus: requireNode(selection.focus, current.snapshot).statementRange.end,
    };
    this.#publish("pending");
    const raw = await abortable(this.#ports.requestTextEdit({
      textDocument: current.snapshot.textDocument, sourceDigest: current.snapshot.sourceDigest,
      target: { kind: "textSelection", selection }, command: { kind: "replaceTextSelection", replacement: text },
    }, signal), signal);
    this.#assertCurrent(current, signal);
    const result = parseComposerEditResult(raw, current.snapshot.textDocument, "TextEdit");
    if (result.kind === "Rejected") throw new Error(`正文编辑被拒绝（${result.reason}），未提交的文字已保留。`);
    const committed = await abortable(this.#owner.apply(current.identity, result, signal, () => {
      entry.committed = true;
      if (entry.intent.kind === "composition") {
        const issued = this.#issuedSessions.get(entry.sessionId);
        if (issued) issued.compositionEnded = true;
      }
    }, (canApply) =>
      this.#ports.applyTextEdit({
        document: current.identity.documentIncarnation, textDocument: current.snapshot.textDocument,
        sourceDigest: current.snapshot.sourceDigest, modelVersion, result, canApply, beforeSelection: nativeBefore,
        undoStopBefore: !continuing, undoStopAfter: !typing, signal,
      })), signal);
    if (committed.application.kind !== "Applied") throw new Error(`正文未提交（${committed.application.kind}），输入已保留。`);
    entry.committed = true;
    if (!committed.snapshot || signal.aborted) {
      if (!signal.aborted) throw new Error(CONFLICT);
      return;
    }
    if (committed.snapshot.sourceDigest !== result.sourceDigestAfter) throw new Error(CONFLICT);
    const rebound = rebind(result.selectionAfter, committed.snapshot, this.#selection!);
    this.#assignSelection(rebound, committed.snapshot);
    this.#remember(committed.snapshot, history, committed.application.alternativeVersionId);
    if (typing) {
      this.#group = { history, uri: history.uri, sourceDigest: committed.snapshot.sourceDigest,
        selection: wireSelection(rebound), admittedAt: entry.admittedAt };
      this.#groupTimer = setTimeout(() => this.closeTextGroup(), IDLE_GROUP_MS);
    }
    // No geometry/compile await: the next intent uses the new authorized snapshot now.
    void this.refreshGeometry();
  }

  async #copy(signal: AbortSignal): Promise<boolean> {
    const current = this.#requireSelection();
    if (collapsed(this.#selection!)) return false;
    const identity = await this.#awaitGeometry(signal);
    const result = await abortable(this.#ports.geometry.selection(this.#selection!, identity, signal), signal);
    this.#assertCurrent(current, signal);
    if (result.status !== "mapped" || !this.#sameGeometry(identity)) throw new Error("无法授权整个选区，未复制或剪切任何片段。");
    try { await abortable(this.#ports.writeClipboard(result.text), signal); }
    catch { this.#notify("warning", "无法写入剪贴板，未删除任何文字。"); return false; }
    this.#assertCurrent(current, signal);
    return true;
  }

  async #pointer(
    intent: Extract<ComposerIntent, { kind: "pointer" }>,
    identity: ComposerTextGeometryIdentity,
    signal: AbortSignal,
  ): Promise<void> {
    if (intent.phase === "cancel") { this.#dragAnchor = null; this.#dragWord = null; return; }
    const current = this.#owner.current();
    if (!current || !this.#sameGeometry(identity)) throw new Error("指针排版已过期，请重新选择正文；后续输入已保留。");
    const hit = await abortable(this.#ports.geometry.hitTest(intent.point, intent.uncertainty, identity, signal), signal);
    if (signal.aborted) return;
    if (!this.#sameGeometry(identity) || !this.#owner.isCurrent(current.identity)) throw new Error(CONFLICT);
    if (hit.status !== "mapped" || !hit.caret) {
      if (intent.phase === "start") { this.#selection = null; this.#publish("blocked", [], []); }
      return;
    }
    let anchor: ComposerTextGeometryEndpoint;
    let focus = hit.endpoint;
    if (intent.phase === "start") {
      anchor = intent.extend && this.#selection ? this.#selection.anchor : focus;
      this.#dragWord = null;
      if (intent.clickCount === 2) {
        const node = requireNode(focus, current.snapshot);
        const word = wordExtent(node.textEditing!.text, focus.offsetUtf16, focus.affinity === "after");
        anchor = { ...focus, offsetUtf16: word[0] };
        focus = { ...focus, offsetUtf16: word[1] };
        this.#dragWord = { anchor, focus };
      }
      this.#dragAnchor = anchor;
    } else {
      if (!this.#dragAnchor) return;
      anchor = this.#dragAnchor;
      if (this.#dragWord) {
        const backward = compareEndpoints(focus, this.#dragWord.anchor, current.snapshot) < 0;
        const word = wordExtent(requireNode(focus, current.snapshot).textEditing!.text, focus.offsetUtf16, focus.affinity === "after");
        anchor = backward ? this.#dragWord.focus : this.#dragWord.anchor;
        focus = { ...focus, offsetUtf16: word[backward ? 0 : 1] };
      }
    }
    const candidate = { anchor, focus };
    const geometry = await abortable(this.#ports.geometry.selection(candidate, identity, signal), signal);
    if (signal.aborted) return;
    if (!this.#sameGeometry(identity) || !this.#owner.isCurrent(current.identity)) throw new Error(CONFLICT);
    if (geometry.status !== "mapped") {
      // Do not leave an apparently successful truncated selection across an opaque barrier.
      this.#selection = null;
      this.#selectionDigest = null;
      this.#publish("blocked", [], []);
      this.#notify("warning", "无法跨越此内容选择正文，请使用源码入口。");
      return;
    }
    if (intent.phase === "start" && !this.#pendingPointerRevocation) {
      this.#requiresPointerSelection = false;
    }
    this.#assignSelection(geometry.selection, current.snapshot);
    if (collapsed(candidate)) {
      this.#sourceSelection = { anchor: hit.authored.range.start, focus: hit.authored.range.start };
      this.#sourceSelectionDigest = current.snapshot.sourceDigest;
    }
    this.#present(geometry);
    this.#remember(current.snapshot);
    if (intent.phase === "end") { this.#dragAnchor = null; this.#dragWord = null; }
  }

  async #history(direction: "undo" | "redo", signal: AbortSignal): Promise<void> {
    this.#cancelComposition("撤销前的输入法草稿已保留。");
    const current = this.#owner.current();
    if (!current) return;
    const history = this.#ports.nativeHistory(current.snapshot.textDocument.uri);
    if (!history || !(direction === "undo" ? history.canUndo() : history.canRedo())) return;
    this.#remember(current.snapshot, history);
    this.#publish("pending");
    const snapshot = await abortable(this.#owner.history(current.identity, direction, signal, () => history[direction]()), signal);
    if (signal.aborted) return;
    if (!snapshot) throw new Error("原生历史已更改，请重新选择正文。");
    const bookmark = this.#bookmarks.get(`${history.uri}:${history.getAlternativeVersionId()}`);
    if (!bookmark || bookmark.sourceDigest !== snapshot.sourceDigest) {
      this.#selection = null;
      this.#selectionDigest = null;
      this.#publish("pending", [], []);
      return;
    }
    this.#assignSelection(rebind(bookmark.selection, snapshot, bookmark.presentation), snapshot);
    this.#preferredX = bookmark.preferredX;
    void this.refreshGeometry();
  }

  #requireSelection(): ComposerTextSessionBinding {
    const current = this.#owner.current();
    if (!current || !this.#selection || current.snapshot.sourceDigest !== this.#selectionDigest) throw new Error(CONFLICT);
    parseComposerTextSelection(wireSelection(this.#selection), current.snapshot);
    return current;
  }

  #assertCurrent(current: ComposerTextSessionBinding, signal: AbortSignal): void {
    if (signal.aborted || !this.#owner.isCurrent(current.identity)) throw new Error(CONFLICT);
  }

  #assignSelection(selection: ComposerTextGeometrySelection, snapshot: ComposerDocumentSnapshot): void {
    parseComposerTextSelection(wireSelection(selection), snapshot);
    this.#selection = selection;
    this.#selectionDigest = snapshot.sourceDigest;
    this.#sourceSelection = undefined;
    this.#sourceSelectionDigest = null;
    this.#owner.selectNode(selection.focus.node.nodeKey);
    this.#preferredX = null;
  }

  #currentGeometry(): ComposerTextGeometryIdentity | undefined {
    const current = this.#owner.current();
    const identity = this.#ports.currentGeometryIdentity();
    return current && identity && identity.sourceUri === current.snapshot.textDocument.uri
      && identity.version === current.snapshot.textDocument.version && identity.sourceDigest === current.snapshot.sourceDigest
      ? identity : undefined;
  }

  #sameGeometry(identity: ComposerTextGeometryIdentity): boolean {
    const current = this.#currentGeometry();
    return !!current && current.renderKey === identity.renderKey && current.sessionId === identity.sessionId
      && current.generation === identity.generation && current.sourceDigest === identity.sourceDigest
      && current.version === identity.version && current.projectionKey === identity.projectionKey
      && current.sourceUri === identity.sourceUri && current.sourceContent === identity.sourceContent
      && current.revision === identity.revision && current.projectDigest === identity.projectDigest
      && current.entryUri === identity.entryUri && current.backendEncoding === identity.backendEncoding;
  }

  #present(result: ComposerTextSelectionGeometry): void {
    if (!result.focusCaret || !result.anchorCaret) { this.#publish("blocked", [], []); return; }
    this.#selection = result.selection;
    const carets = collapsed(result.selection) ? [result.focusCaret] : [result.anchorCaret, result.focusCaret];
    this.#publish("ready", carets, result.boxes, result.identity.renderKey);
  }

  #publish(
    status: ComposerState["status"],
    carets: ComposerState["carets"] = this.#state.carets,
    boxes: ComposerState["boxes"] = this.#state.boxes,
    renderKey: ComposerState["renderKey"] = this.#state.renderKey,
  ): void {
    if (this.#suspensions > 0 || !this.#active || this.#pendingPointerRevocation) {
      status = "blocked"; carets = []; boxes = [];
    }
    if (status === "blocked") this.#issuedRenderKeys.clear();
    else {
      if (this.#state.status === "blocked") {
        if (this.#issuedSessions.get(this.#sessionId)?.drained) this.#issuedSessions.delete(this.#sessionId);
        this.#sessionId = crypto.randomUUID();
        this.#sequence = 0;
        this.#issuedRenderKeys.clear();
      }
      this.#issuedRenderKeys.add(renderKey);
      let issued = this.#issuedSessions.get(this.#sessionId);
      if (!issued) {
        issued = { keys: new Set(), sequence: this.#sequence, compositionEnded: false, drained: false };
        this.#issuedSessions.set(this.#sessionId, issued);
      }
      issued.keys.add(renderKey);
    }
    this.#state = { type: "composer-state", sessionId: this.#sessionId, sequence: this.#sequence, renderKey, status, carets, boxes };
    for (const listener of this.#listeners) listener(this.#state);
  }

  #remember(
    snapshot: ComposerDocumentSnapshot,
    history = this.#ports.nativeHistory(snapshot.textDocument.uri),
    alternative?: number,
    selection = this.#selection,
  ): void {
    if (!history || !selection || this.#selectionDigest !== snapshot.sourceDigest) return;
    this.#bookmarks.set(`${history.uri}:${alternative ?? history.getAlternativeVersionId()}`, {
      sourceDigest: snapshot.sourceDigest,
      selection: { anchor: endpointAfter(selection.anchor, snapshot), focus: endpointAfter(selection.focus, snapshot) },
      presentation: selection, preferredX: this.#preferredX,
    });
  }

  #awaitGeometry(signal: AbortSignal): Promise<ComposerTextGeometryIdentity> {
    const current = this.#currentGeometry();
    if (current) return Promise.resolve(current);
    this.#publish("pending");
    const { promise, resolve, reject } = Promise.withResolvers<ComposerTextGeometryIdentity>();
    const wake = (identity: ComposerTextGeometryIdentity) => {
      signal.removeEventListener("abort", abort);
      resolve(identity);
    };
    const abort = () => {
      this.#geometryWaiters.delete(wake);
      reject(new Error(CONFLICT));
    };
    if (signal.aborted) abort();
    else {
      this.#geometryWaiters.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    }
    return promise;
  }

  #recoverUnsubmitted(reason: string): void {
    const issued = this.#issuedSessions.get(this.#sessionId);
    let composition: string | null = this.#composition?.text ?? null;
    let text = "";
    const flushText = () => { if (text) this.#recover(text, reason); text = ""; };
    const flushComposition = (ended: boolean) => {
      if (composition !== null && issued) {
        if (composition) issued.compositionId = this.#recover(composition, reason, issued.compositionId);
        issued.compositionEnded = ended;
      }
      composition = null;
    };
    const entries = this.#inFlight ? [this.#inFlight, ...this.#queue] : this.#queue;
    for (const entry of entries) {
      if (entry.committed) continue;
      const intent = entry.intent;
      if (intent.kind === "replace") { flushComposition(false); text += intent.text; }
      if (intent.kind === "composition") {
        if (intent.phase === "start") {
          flushText();
          if (issued) { issued.compositionId = undefined; issued.compositionEnded = false; }
          composition = intent.text;
        }
        if (intent.phase === "update") composition = intent.text;
        if (intent.phase === "cancel") composition = intent.text || null;
        if (intent.phase === "end") { flushText(); composition = intent.text; flushComposition(true); }
      }
    }
    flushText();
    flushComposition(false);
  }

  #recoverRejected(intent: ComposerIntent, issued: IssuedSession | undefined): void {
    const reason = "输入到达时编辑授权已更改，文字已保留，未应用到其他正文。";
    if (intent.kind === "replace" && intent.text) this.#recover(intent.text, reason);
    if (intent.kind !== "composition") return;
    if (!issued) { if (intent.text) this.#recover(intent.text, reason); return; }
    if (intent.phase === "start") { issued.compositionId = undefined; issued.compositionEnded = false; }
    if (issued.compositionEnded) return;
    if (intent.text || issued.compositionId) issued.compositionId = this.#recover(intent.text, reason, issued.compositionId);
    if (intent.phase === "end" || intent.phase === "cancel") issued.compositionEnded = true;
  }

  #cancelComposition(reason: string): void {
    const composition = this.#composition;
    this.#composition = null;
    if (composition?.text) {
      const issued = this.#issuedSessions.get(this.#sessionId);
      const id = this.#recover(composition.text, reason, issued?.compositionId);
      if (issued) issued.compositionId = id;
    }
  }

  #recover(text: string, reason: string, id: string = crypto.randomUUID()): string {
    const existing = this.#recoveryChunks.find((chunk) => chunk.id === id);
    if (existing?.text === text) return id;
    if (existing) existing.text = text;
    else this.#recoveryChunks.push({ id, text });
    void Promise.resolve().then(() => this.#ports.recover(text, reason, id)).catch(() => {
      this.#notify("error", "无法显示恢复窗口；未提交文字仍保留在当前编辑会话中。");
    });
    return id;
  }

  #notify(kind: "warning" | "error", message: string): void {
    void Promise.resolve().then(() => this.#ports.notify(kind, message)).catch(() => undefined);
  }
}

function wireSelection(selection: ComposerTextSelection): ComposerTextSelection {
  return {
    anchor: { node: selection.anchor.node, offsetUtf16: selection.anchor.offsetUtf16 },
    focus: { node: selection.focus.node, offsetUtf16: selection.focus.offsetUtf16 },
  };
}
function sameEndpoint(left: ComposerTextSelection["anchor"], right: ComposerTextSelection["anchor"]): boolean {
  return left.node.nodeKey === right.node.nodeKey && left.node.nodeKind === right.node.nodeKind
    && sameRange(left.node.range, right.node.range) && left.offsetUtf16 === right.offsetUtf16;
}
function sameSelection(left: ComposerTextSelection, right: ComposerTextSelection): boolean {
  return sameEndpoint(left.anchor, right.anchor) && sameEndpoint(left.focus, right.focus);
}
function collapsed(selection: ComposerTextSelection): boolean { return sameEndpoint(selection.anchor, selection.focus); }
function sameRange(left: ComposerNodeRef["range"], right: ComposerNodeRef["range"]): boolean {
  return left.start.line === right.start.line && left.start.character === right.start.character
    && left.end.line === right.end.line && left.end.character === right.end.character;
}
function requireNode(endpoint: ComposerTextSelection["anchor"], snapshot: ComposerDocumentSnapshot): TextNode {
  const node = snapshot.nodes.find((node) => node.nodeKey === endpoint.node.nodeKey
    && node.kind === endpoint.node.nodeKind && sameRange(node.range, endpoint.node.range));
  if (!node || node.kind === "opaque" || !node.textEditing) throw new Error(CONFLICT);
  return node;
}
function endpointAfter(endpoint: ComposerTextSelection["anchor"], snapshot: ComposerDocumentSnapshot) {
  return { statementRange: requireNode(endpoint, snapshot).statementRange, offsetUtf16: endpoint.offsetUtf16 };
}
function rebind(after: ComposerTextSelectionAfter, snapshot: ComposerDocumentSnapshot, presentation: ComposerTextGeometrySelection): ComposerTextGeometrySelection {
  const endpoint = (value: ComposerTextSelectionAfter["anchor"], prior: ComposerTextGeometryEndpoint): ComposerTextGeometryEndpoint => {
    const matches = snapshot.nodes.filter((node): node is TextNode => node.kind !== "opaque"
      && !!node.textEditing && sameRange(node.statementRange, value.statementRange));
    if (matches.length !== 1) throw new Error(CONFLICT);
    const node = matches[0]!;
    return { node: { nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range }, offsetUtf16: value.offsetUtf16,
      ...(prior.affinity ? { affinity: prior.affinity } : {}), ...(prior.occurrence ? { occurrence: prior.occurrence } : {}) };
  };
  const selection = { anchor: endpoint(after.anchor, presentation.anchor), focus: endpoint(after.focus, presentation.focus) };
  parseComposerTextSelection(wireSelection(selection), snapshot);
  return selection;
}
function compareEndpoints(left: ComposerTextSelection["anchor"], right: ComposerTextSelection["anchor"], snapshot: ComposerDocumentSnapshot): number {
  return snapshot.nodes.indexOf(requireNode(left, snapshot)) - snapshot.nodes.indexOf(requireNode(right, snapshot))
    || left.offsetUtf16 - right.offsetUtf16;
}
function deleteBoundary(text: string, offset: number, backward: boolean, granularity: "grapheme" | "word"): number {
  if ((backward && offset === 0) || (!backward && offset === text.length)) return offset;
  let boundary = backward ? 0 : text.length;
  for (const part of (granularity === "word" ? WORDS : GRAPHEMES).segment(text)) {
    if (granularity === "word" && /^\s+$/u.test(part.segment)) continue;
    const edge = backward ? part.index : part.index + part.segment.length;
    if (backward) {
      if (edge >= offset) break;
      boundary = edge;
    } else if (edge > offset) { boundary = edge; break; }
  }
  if (granularity === "word") {
    for (const part of GRAPHEMES.segment(text)) {
      const end = part.index + part.segment.length;
      if (boundary > part.index && boundary < end) return backward ? part.index : end;
    }
  }
  return boundary;
}
function wordExtent(text: string, offset: number, after: boolean): readonly [number, number] {
  let last: readonly [number, number] = [offset, offset];
  for (const part of WORDS.segment(text)) {
    const end = part.index + part.segment.length;
    last = [part.index, end];
    if (end > offset || (after && end === offset)) return last;
  }
  return last;
}

function abortable<T>(value: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const abort = () => reject(new Error(CONFLICT));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  return promise;
}

function isUnsubmittedText(entry: QueuedIntent): boolean {
  return !entry.committed && (entry.intent.kind === "replace"
    || (entry.intent.kind === "composition" && entry.intent.phase !== "cancel"
      && (entry.intent.phase === "end" || entry.intent.text.length > 0)));
}
