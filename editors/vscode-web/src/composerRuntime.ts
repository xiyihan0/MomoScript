import {
  parseComposerDocumentResult,
  validateComposerSnapshotAgainstDocument,
  type ComposerBoundaryTarget,
  type ComposerDocumentNode,
  type ComposerDocumentSnapshot,
  type ComposerNodeRef,
  type ComposerTextDocumentLike,
} from "./composerDocument.ts";
import {
  parseComposerEditResult,
  type ComposerEditApplicationResult,
  type ComposerEditCommand,
  type ComposerEditParams,
  type ComposerEditResult,
  type ComposerNewStatement,
  type ComposerStructureCommand,
  type ComposerStructureEditParams,
  type ComposerStructureTarget,
  type ComposerTextDocument,
} from "./composerEdit.ts";

export interface ComposerRuntimeDisposable {
  dispose(): void;
}

export interface ComposerRuntimeDocument extends ComposerTextDocumentLike {
  readonly languageId?: string;
}

export interface ComposerRuntimeDocumentChange {
  readonly document: ComposerRuntimeDocument;
  readonly contentChanges: readonly unknown[];
}

export type ComposerRuntimeNotificationKind = "warning" | "error";

export type ComposerRuntimeCapability =
  | {
      readonly kind: "property";
      readonly target: ComposerEditParams["target"];
      readonly command: ComposerEditCommand;
    }
  | {
      readonly kind: "structure";
      readonly target: ComposerStructureTarget;
      readonly command: ComposerStructureCommand;
    };

export interface ComposerRuntimeIdentity {
  readonly generation: number;
  readonly uri: string;
  readonly documentIncarnation: ComposerRuntimeDocument;
  readonly version: number;
  readonly epoch: number;
  readonly catalogEpoch: number;
  readonly sourceDigest: string;
}

export interface ComposerRuntimeState {
  readonly bound: {
    readonly uri: string;
    readonly documentIncarnation: ComposerRuntimeDocument;
    readonly version: number;
  } | null;
  readonly snapshot: ComposerDocumentSnapshot | null;
  readonly selectedNodeKey: string | null;
  readonly expandedNodeKey: string | null;
  readonly pending: boolean;
}

export interface ComposerRuntimeApplyOptions {
  readonly result: Extract<ComposerEditResult, { readonly kind: "Edit" }>;
  readonly textDocument: ComposerTextDocument;
  readonly signal: AbortSignal;
  readonly canApply: () => boolean;
}

export interface ComposerRuntimePorts {
  readonly requestDocument: (
    params: { readonly textDocument: ComposerTextDocument },
    signal: AbortSignal,
  ) => PromiseLike<unknown>;
  readonly requestEdit: (
    params: ComposerEditParams | ComposerStructureEditParams,
    signal: AbortSignal,
  ) => PromiseLike<unknown>;
  readonly applyEdit: (options: ComposerRuntimeApplyOptions) => PromiseLike<ComposerEditApplicationResult>;
  readonly currentDocument: (uri: string) => ComposerRuntimeDocument | undefined;
  readonly isWorkspaceDocument: (document: ComposerRuntimeDocument) => boolean;
  readonly onDidChangeDocument: (
    listener: (event: ComposerRuntimeDocumentChange) => void,
  ) => ComposerRuntimeDisposable;
  readonly getPackSpeakerReferences: () => readonly string[];
  readonly onDidChangeCatalog: (listener: () => void) => ComposerRuntimeDisposable;
  readonly navigateSource: (uri: string, range: ComposerDocumentNode["range"]) => unknown | PromiseLike<unknown>;
  readonly openPreview: (uri: string) => unknown | PromiseLike<unknown>;
  readonly showHistory: (uri: string) => unknown | PromiseLike<unknown>;
  readonly save: (uri: string) => unknown | PromiseLike<unknown>;
  readonly exportExact: (uri: string) => unknown | PromiseLike<unknown>;
  readonly notify: (kind: ComposerRuntimeNotificationKind, message: string) => unknown | PromiseLike<unknown>;
}

export interface ComposerRuntimeTransient {
  readonly identity: ComposerRuntimeIdentity;
  isCurrent(): boolean;
  close(): void;
}

const STALE_MESSAGE = "源码已更改，未应用编辑。";
const REJECTED_MESSAGE = "无法应用此编辑。";
const APPLY_FAILED_MESSAGE = "无法应用编辑。";
const DOCUMENT_UNAVAILABLE_MESSAGE = "无法读取当前 MMT 文档。";

export class ComposerRuntime implements ComposerRuntimeDisposable {
  readonly #ports: ComposerRuntimePorts;
  readonly #listeners = new Set<(state: ComposerRuntimeState) => void>();
  readonly #subscriptions: ComposerRuntimeDisposable[];
  #generation = 0;
  #epoch = 0;
  #catalogEpoch = 0;
  #bound: ComposerRuntimeState["bound"] = null;
  #snapshot: ComposerDocumentSnapshot | null = null;
  #selectedNodeKey: string | null = null;
  #expandedNodeKey: string | null = null;
  #pending = false;
  #accepting = true;
  #requestAbort: AbortController | null = null;
  #operationAbort: AbortController | null = null;
  #transient: { close: () => void; identity: ComposerRuntimeIdentity } | null = null;

  constructor(ports: ComposerRuntimePorts) {
    this.#ports = ports;
    this.#subscriptions = [
      ports.onDidChangeDocument((event) => this.#documentChanged(event)),
      ports.onDidChangeCatalog(() => this.#catalogChanged()),
    ];
  }

  get state(): ComposerRuntimeState {
    return Object.freeze({
      bound: this.#bound,
      snapshot: this.#snapshot,
      selectedNodeKey: this.#selectedNodeKey,
      expandedNodeKey: this.#expandedNodeKey,
      pending: this.#pending,
    });
  }

  onDidChangeState(listener: (state: ComposerRuntimeState) => void): ComposerRuntimeDisposable {
    if (!this.#accepting) return { dispose() {} };
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  bindDocument(document: ComposerRuntimeDocument): boolean {
    if (!this.#accepting || !this.#isEligibleDocument(document)) return false;
    this.#generation += 1;
    this.#cancelAll();
    this.#bound = Object.freeze({
      uri: document.uri.toString(),
      documentIncarnation: document,
      version: document.version,
    });
    this.#snapshot = null;
    this.#selectedNodeKey = null;
    this.#expandedNodeKey = null;
    this.#pending = false;
    this.#emit();
    this.#requestCurrentSnapshot();
    return true;
  }

  selectNode(nodeKey: string | null): void {
    if (!this.#accepting || (nodeKey !== null && !this.#snapshot?.nodes.some((node) => node.nodeKey === nodeKey))) {
      return;
    }
    this.#selectedNodeKey = nodeKey;
    this.#emit();
  }

  expandNode(nodeKey: string | null): void {
    if (!this.#accepting || (nodeKey !== null && !this.#snapshot?.nodes.some((node) => node.nodeKey === nodeKey))) {
      return;
    }
    this.#expandedNodeKey = nodeKey;
    this.#emit();
  }

  beginTransient(close: () => void): ComposerRuntimeTransient | undefined {
    const identity = this.captureIdentity();
    if (!identity) return undefined;
    this.#closeTransient();
    const entry = { close, identity };
    this.#transient = entry;
    return {
      identity,
      isCurrent: () => this.#transient === entry && this.#isIdentityCurrent(identity, true),
      close: () => {
        if (this.#transient === entry) this.#transient = null;
        close();
      },
    };
  }

  captureIdentity(): ComposerRuntimeIdentity | undefined {
    const bound = this.#bound;
    const snapshot = this.#snapshot;
    if (!this.#accepting || !bound || !snapshot) return undefined;
    return Object.freeze({
      generation: this.#generation,
      uri: bound.uri,
      documentIncarnation: bound.documentIncarnation,
      version: bound.version,
      epoch: this.#epoch,
      catalogEpoch: this.#catalogEpoch,
      sourceDigest: snapshot.sourceDigest,
    });
  }

  async execute(
    capability: ComposerRuntimeCapability,
    expectedIdentity: ComposerRuntimeIdentity | undefined = this.captureIdentity(),
  ): Promise<void> {
    const snapshot = this.#snapshot;
    if (!expectedIdentity || !snapshot || !this.#isIdentityCurrent(expectedIdentity, true)) {
      await this.#notify("warning", STALE_MESSAGE);
      return;
    }
    if (!this.#isAuthorized(snapshot, capability)) return;

    this.#operationAbort?.abort();
    const operation = new AbortController();
    this.#operationAbort = operation;
    this.#pending = true;
    this.#emit();
    const textDocument = snapshot.textDocument;
    const params = capability.kind === "property"
      ? { textDocument, target: capability.target, command: capability.command }
      : {
          textDocument,
          sourceDigest: snapshot.sourceDigest,
          target: capability.target,
          command: capability.command,
        };
    try {
      const raw = await this.#ports.requestEdit(params, operation.signal);
      if (!this.#isOperationCurrent(operation, expectedIdentity)) {
        if (!operation.signal.aborted) await this.#notify("warning", STALE_MESSAGE);
        return;
      }
      const result = parseComposerEditResult(raw, textDocument);
      if (result.kind === "Rejected") {
        await this.#notify(
          "warning",
          result.reason === "staleDocument" || result.reason === "targetChanged"
            ? STALE_MESSAGE
            : REJECTED_MESSAGE,
        );
        return;
      }
      if (!this.#isOperationCurrent(operation, expectedIdentity)) {
        await this.#notify("warning", STALE_MESSAGE);
        return;
      }
      const application = await this.#ports.applyEdit({
        result,
        textDocument,
        signal: operation.signal,
        canApply: () => this.#isOperationCurrent(operation, expectedIdentity),
      });
      if (application.kind === "Stale") await this.#notify("warning", STALE_MESSAGE);
      if (application.kind === "ApplyFailed") await this.#notify("error", APPLY_FAILED_MESSAGE);
    } catch (error) {
      if (!operation.signal.aborted && this.#isIdentityCurrent(expectedIdentity, true)) {
        await this.#notify("error", error instanceof Error ? error.message : REJECTED_MESSAGE);
      }
    } finally {
      if (this.#operationAbort === operation) {
        this.#operationAbort = null;
        this.#pending = false;
        this.#emit();
      }
    }
  }

  navigateSource(range: ComposerDocumentNode["range"]): Promise<unknown> | undefined {
    return this.#bound ? Promise.resolve(this.#ports.navigateSource(this.#bound.uri, range)) : undefined;
  }

  openPreview(): Promise<unknown> | undefined {
    return this.#bound ? Promise.resolve(this.#ports.openPreview(this.#bound.uri)) : undefined;
  }

  showHistory(): Promise<unknown> | undefined {
    return this.#bound ? Promise.resolve(this.#ports.showHistory(this.#bound.uri)) : undefined;
  }

  save(): Promise<unknown> | undefined {
    return this.#bound ? Promise.resolve(this.#ports.save(this.#bound.uri)) : undefined;
  }

  exportExact(): Promise<unknown> | undefined {
    return this.#bound ? Promise.resolve(this.#ports.exportExact(this.#bound.uri)) : undefined;
  }

  quiesce(): void {
    if (!this.#accepting) return;
    this.#accepting = false;
    this.#generation += 1;
    this.#cancelAll();
    this.#snapshot = null;
    this.#bound = null;
    this.#pending = false;
    this.#listeners.clear();
    while (this.#subscriptions.length > 0) this.#subscriptions.pop()!.dispose();
  }

  dispose(): void {
    this.quiesce();
  }

  #isEligibleDocument(document: ComposerRuntimeDocument): boolean {
    const uri = document.uri.toString();
    const path = uri.split(/[?#]/u, 1)[0]!.toLowerCase();
    return (path.endsWith(".mmt") || path.endsWith(".mmt.txt")) && this.#ports.isWorkspaceDocument(document);
  }

  #documentChanged(event: ComposerRuntimeDocumentChange): void {
    if (!this.#accepting || event.contentChanges.length === 0 || !this.#bound) return;
    if (event.document !== this.#bound.documentIncarnation || event.document.uri.toString() !== this.#bound.uri) return;
    this.#epoch += 1;
    this.#requestAbort?.abort();
    this.#operationAbort?.abort();
    this.#closeTransient();
    this.#bound = Object.freeze({ ...this.#bound, version: event.document.version });
    this.#snapshot = null;
    this.#selectedNodeKey = null;
    this.#expandedNodeKey = null;
    this.#pending = false;
    this.#emit();
    this.#requestCurrentSnapshot();
  }

  #catalogChanged(): void {
    if (!this.#accepting) return;
    this.#catalogEpoch += 1;
    this.#closeTransient();
    this.#emit();
  }

  #requestCurrentSnapshot(): void {
    const bound = this.#bound;
    if (!bound || !this.#accepting) return;
    this.#epoch += 1;
    const epoch = this.#epoch;
    const generation = this.#generation;
    const controller = new AbortController();
    this.#requestAbort = controller;
    void this.#loadSnapshot(bound, generation, epoch, controller);
  }

  async #loadSnapshot(
    bound: NonNullable<ComposerRuntimeState["bound"]>,
    generation: number,
    epoch: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      const raw = await this.#ports.requestDocument(
        { textDocument: { uri: bound.uri, version: bound.version } },
        controller.signal,
      );
      if (!this.#isRequestCurrent(bound, generation, epoch, controller)) return;
      const result = parseComposerDocumentResult(raw);
      if (result.kind === "Rejected") {
        await this.#notify("warning", DOCUMENT_UNAVAILABLE_MESSAGE);
        return;
      }
      await validateComposerSnapshotAgainstDocument(result, bound.documentIncarnation);
      if (!this.#isRequestCurrent(bound, generation, epoch, controller)) return;
      this.#snapshot = result;
      this.#emit();
    } catch (error) {
      if (!controller.signal.aborted && this.#isRequestCurrent(bound, generation, epoch, controller)) {
        await this.#notify("error", error instanceof Error ? error.message : DOCUMENT_UNAVAILABLE_MESSAGE);
      }
    }
  }

  #isRequestCurrent(
    bound: NonNullable<ComposerRuntimeState["bound"]>,
    generation: number,
    epoch: number,
    controller: AbortController,
  ): boolean {
    return !controller.signal.aborted
      && this.#requestAbort === controller
      && this.#generation === generation
      && this.#epoch === epoch
      && this.#bound === bound
      && this.#ports.currentDocument(bound.uri) === bound.documentIncarnation
      && bound.documentIncarnation.version === bound.version;
  }

  #isIdentityCurrent(identity: ComposerRuntimeIdentity, includeCatalog: boolean): boolean {
    const bound = this.#bound;
    return this.#accepting
      && !!bound
      && this.#snapshot?.sourceDigest === identity.sourceDigest
      && this.#generation === identity.generation
      && this.#epoch === identity.epoch
      && (!includeCatalog || this.#catalogEpoch === identity.catalogEpoch)
      && bound.uri === identity.uri
      && bound.documentIncarnation === identity.documentIncarnation
      && bound.version === identity.version
      && identity.documentIncarnation.version === identity.version
      && this.#ports.currentDocument(identity.uri) === identity.documentIncarnation;
  }

  #isOperationCurrent(operation: AbortController, identity: ComposerRuntimeIdentity): boolean {
    return this.#operationAbort === operation && !operation.signal.aborted && this.#isIdentityCurrent(identity, true);
  }

  #isAuthorized(snapshot: ComposerDocumentSnapshot, capability: ComposerRuntimeCapability): boolean {
    if (capability.kind === "property") return authorizeProperty(snapshot, capability.target, capability.command);
    return authorizeStructure(snapshot, capability.target, capability.command, this.#speakerReferences(snapshot));
  }

  #speakerReferences(snapshot: ComposerDocumentSnapshot): ComposerRuntimeSpeakerReferences {
    return {
      script: new Set(snapshot.scriptActorChoices.map((choice) => choice.reference)),
      pack: new Set(this.#ports.getPackSpeakerReferences()),
    };
  }

  #cancelAll(): void {
    this.#requestAbort?.abort();
    this.#requestAbort = null;
    this.#operationAbort?.abort();
    this.#operationAbort = null;
    this.#closeTransient();
  }

  #closeTransient(): void {
    const transient = this.#transient;
    this.#transient = null;
    transient?.close();
  }

  #emit(): void {
    if (!this.#accepting) return;
    const state = this.state;
    for (const listener of this.#listeners) listener(state);
  }

  async #notify(kind: ComposerRuntimeNotificationKind, message: string): Promise<void> {
    if (this.#accepting) await this.#ports.notify(kind, message);
  }
}

interface ComposerRuntimeSpeakerReferences {
  readonly script: ReadonlySet<string>;
  readonly pack: ReadonlySet<string>;
}

function authorizeProperty(
  snapshot: ComposerDocumentSnapshot,
  target: ComposerEditParams["target"],
  command: ComposerEditCommand,
): boolean {
  const node = snapshot.nodes.find((candidate) =>
    candidate.kind !== "opaque" && sameRange(candidate.statementRange, target.range)
  );
  if (!node || node.kind === "opaque") return false;
  if (command.kind === "setStatementBody") return node.capabilities.setBody;
  if (node.kind !== "message") return false;
  if (command.kind === "setStatementContinued") return node.capabilities.setContinued;
  if (command.kind === "setActorDisplayNameFromStatement") return node.capabilities.setDisplayName;
  return node.capabilities.setAvatar;
}

function authorizeStructure(
  snapshot: ComposerDocumentSnapshot,
  target: ComposerStructureTarget,
  command: ComposerStructureCommand,
  speakerReferences: ComposerRuntimeSpeakerReferences,
): boolean {
  if (command.kind === "insertStatement") {
    if (target.kind !== "boundary") return false;
    const insert = snapshot.boundaries.find((boundary) => sameBoundary(boundary.target, target))?.insert;
    return !!insert && authorizeInsertion(insert, command.statement, speakerReferences);
  }
  if (target.kind !== "node") return false;
  const node = snapshot.nodes.find((candidate) => sameNodeRef(nodeRef(candidate), target.node));
  if (!node || node.kind === "opaque") return false;
  if (command.kind === "deleteNode") return node.capabilities.delete;
  if (command.kind === "moveNode") {
    return sameOptionalBoundary(node.capabilities.moveUp, command.anchor)
      || sameOptionalBoundary(node.capabilities.moveDown, command.anchor);
  }
  return node.kind === "message"
    && node.capabilities.setSpeaker
    && command.speaker.kind === "actor"
    && (speakerReferences.script.has(command.speaker.reference)
      || speakerReferences.pack.has(command.speaker.reference));
}

function authorizeInsertion(
  insert: NonNullable<ComposerDocumentSnapshot["boundaries"][number]["insert"]>,
  statement: ComposerNewStatement,
  speakerReferences: ComposerRuntimeSpeakerReferences,
): boolean {
  if (!insert.statementModes.includes(statement.body.mode)) return false;
  if (statement.kind === "narration") return insert.narration;
  const speakerSource = speakerReferences.script.has(statement.speaker.reference)
    ? "scriptActor"
    : speakerReferences.pack.has(statement.speaker.reference)
      ? "packEntity"
      : null;
  return insert.messageSides.includes(statement.side)
    && statement.speaker.kind === "actor"
    && speakerSource !== null
    && insert.speakerSources.includes(speakerSource);
}

function nodeRef(node: ComposerDocumentNode): ComposerNodeRef {
  return { nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range };
}

function sameNodeRef(left: ComposerNodeRef | null, right: ComposerNodeRef | null): boolean {
  return left === right || (!!left
    && !!right
    && left.nodeKey === right.nodeKey
    && left.nodeKind === right.nodeKind
    && sameRange(left.range, right.range));
}

function sameBoundary(left: ComposerBoundaryTarget, right: ComposerBoundaryTarget): boolean {
  return left.kind === "boundary"
    && right.kind === "boundary"
    && sameNodeRef(left.before, right.before)
    && sameNodeRef(left.after, right.after);
}

function sameOptionalBoundary(left: ComposerBoundaryTarget | null, right: ComposerBoundaryTarget): boolean {
  return left !== null && sameBoundary(left, right);
}

function sameRange(left: ComposerDocumentNode["range"], right: ComposerDocumentNode["range"]): boolean {
  return left.start.line === right.start.line
    && left.start.character === right.start.character
    && left.end.line === right.end.line
    && left.end.character === right.end.character;
}
