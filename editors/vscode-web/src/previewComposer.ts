import type { CancellationToken, Disposable, WorkspaceEdit } from "vscode";
import {
  applyComposerEdit,
  parseComposerEditResult,
  parsePreviewComposerTargetResult,
  type ApplyComposerEditOptions,
  type ComposerEditApplicationResult,
  type ComposerEditParams,
  type ComposerEditResult,
  type PreviewComposerTargetUnavailableReason,
  type ComposerTextDocument,
  type StatementContinuedValue,
  type ComposerAvatarChoice,
  type ComposerAvatarCurrent,
} from "./composerEdit.ts";
import type { AvatarCatalogItem } from "./galleryPack.ts";
import { avatarItemMatchesCurrent } from "./avatarPicker.ts";
import type {
  LocatedPreviewPoint,
  PreviewBackendLocation,
  PreviewSourceIdentity,
} from "./previewInteraction.ts";
import type {
  PreviewContextMenuAnchor,
  PreviewNavigationPoint,
} from "./previewWebviewProtocol.ts";

export interface PreviewComposerTargetParams {
  readonly sourceUri: PreviewSourceIdentity["sourceUri"];
  readonly revision: PreviewSourceIdentity["revision"];
  readonly sourceContent: PreviewSourceIdentity["sourceContent"];
  readonly projectDigest: PreviewSourceIdentity["projectDigest"];
  readonly projectionKey: NonNullable<PreviewSourceIdentity["projectionKey"]>;
  readonly entryUri: PreviewSourceIdentity["entryUri"];
  readonly backendEncoding: PreviewSourceIdentity["backendEncoding"];
  readonly location: PreviewBackendLocation;
}

export interface PreviewComposerCancellationTokenSource extends Disposable {
  readonly token: CancellationToken;
  cancel(): void;
}

export type PreviewComposerContextMenuSelection =
  | { readonly kind: "continued"; readonly value: StatementContinuedValue }
  | { readonly kind: "displayName" }
  | { readonly kind: "avatar" }
  | { readonly kind: "messageText" }
  | { readonly kind: "navigate" };

export interface PreviewComposerContextMenuItem {
  readonly label: string;
  readonly checked?: boolean;
  readonly selection?: PreviewComposerContextMenuSelection;
  readonly children?: readonly PreviewComposerContextMenuItem[];
}

export interface PreviewComposerContextMenuSession {
  readonly result: Promise<PreviewComposerContextMenuSelection | undefined>;
  close(): void;
}

export interface PreviewComposerContextMenuPort {
  open(
    anchor: PreviewContextMenuAnchor,
    items: readonly PreviewComposerContextMenuItem[],
  ): PreviewComposerContextMenuSession;
}

export interface PreviewComposerContextInputOptions {
  readonly title: string;
  readonly placeholder: string;
  readonly value: string;
  readonly requiredMessage: string;
}

export interface PreviewComposerContextInputSession {
  readonly result: Promise<string | undefined>;
  close(): void;
}

export interface PreviewComposerContextInputPort {
  open(
    anchor: PreviewContextMenuAnchor,
    options: PreviewComposerContextInputOptions,
  ): PreviewComposerContextInputSession;
}

export interface PreviewComposerAvatarPickerOptions {
  readonly actorPresetId: string;
  readonly actorLabel: string;
  readonly current: ComposerAvatarCurrent | null;
  readonly items: readonly AvatarCatalogItem[];
  readonly choose: (choice: ComposerAvatarChoice) => Promise<void>;
}

export interface PreviewComposerAvatarPickerSession {
  readonly result: Promise<void>;
  close(): void;
}

export interface PreviewComposerAvatarPickerPort {
  open(
    anchor: PreviewContextMenuAnchor,
    options: PreviewComposerAvatarPickerOptions,
  ): PreviewComposerAvatarPickerSession;
}

export interface PreviewComposerApplyOptions {
  readonly result: Extract<ComposerEditResult, { kind: "Edit" }>;
  readonly textDocument: ComposerTextDocument;
  readonly signal: AbortSignal;
  /** Called synchronously at the final boundary immediately before the native apply. */
  readonly canApply: () => boolean;
}

export interface PreviewComposerApplyPort {
  apply(options: PreviewComposerApplyOptions): PromiseLike<ComposerEditApplicationResult>;
}

export interface PreviewComposerControllerPorts {
  readonly locatePreviewPoint: (
    point: PreviewNavigationPoint,
    signal: AbortSignal,
  ) => PromiseLike<LocatedPreviewPoint | undefined>;
  readonly request: (
    method: "mmt/previewComposerTarget" | "mmt/composerEdit",
    params: PreviewComposerTargetParams | ComposerEditParams,
    token: CancellationToken,
  ) => PromiseLike<unknown>;
  readonly createCancellationTokenSource: () => PreviewComposerCancellationTokenSource;
  readonly contextMenu: PreviewComposerContextMenuPort;
  readonly contextInput: PreviewComposerContextInputPort;
  readonly apply: PreviewComposerApplyPort;
  readonly acceptingWork: () => boolean;
  readonly avatarPicker: PreviewComposerAvatarPickerPort;
  readonly getAvatarCatalog: () => readonly AvatarCatalogItem[];
  readonly onDidChangeAvatarCatalog: (listener: () => void) => Disposable;
  readonly currentIdentity: () => PreviewSourceIdentity | undefined;
  readonly currentDocument: (uri: string) => ComposerTextDocument | undefined;
  readonly bidirectionalNavigation: () => boolean;
  readonly navigatePreviewPoint: (
    point: PreviewNavigationPoint,
    signal: AbortSignal,
  ) => PromiseLike<unknown>;
  readonly showWarningMessage: (message: string) => unknown | PromiseLike<unknown>;
  readonly showErrorMessage: (message: string) => unknown | PromiseLike<unknown>;
}

interface ActiveTransientUi {
  close(): void;
}

interface ComposerOperation {
  readonly abortController: AbortController;
  readonly cancellation: PreviewComposerCancellationTokenSource;
  transient: ActiveTransientUi | undefined;
  released: boolean;
  applyGateDocument: ComposerTextDocument | undefined;
}

type OperationState = "current" | "cancelled" | "stale";

const EDIT_CONTINUED_LABEL = "编辑连续消息状态…";
const EDIT_DISPLAY_NAME_LABEL = "从本条起修改人物显示名…";
const EDIT_MESSAGE_LABEL = "编辑消息…";
const NAVIGATE_LABEL = "转到源码";
const STALE_MESSAGE = "源码已更改，未应用编辑。";
const UNAVAILABLE_MESSAGE = "无法编辑此预览内容。";
const REJECTED_MESSAGE = "无法应用此预览编辑。";
const APPLY_FAILED_MESSAGE = "无法应用预览编辑。";
const INPUT_REQUIRED_MESSAGE = "显示名不能为空。";
const MESSAGE_INPUT_REQUIRED_MESSAGE = "消息不能为空。";
const EDIT_AVATAR_LABEL = "从本条起更换人物头像…";
const AVATAR_UNAVAILABLE_MESSAGE = "所选头像已不可用，未应用编辑。";

export function isTextContentChangeEvent(
  event: { readonly contentChanges: readonly unknown[] },
): boolean {
  return event.contentChanges.length > 0;
}

/**
 * Creates the production apply adapter while retaining a final synchronous
 * runtime/identity/version gate around vscode.workspace.applyEdit.
 */
export function createPreviewComposerApplyPort(
  boundary: Pick<ApplyComposerEditOptions, "client" | "workspace">,
): PreviewComposerApplyPort {
  return {
    async apply(options) {
      let finalGateRejected = false;
      const guardedWorkspace = {
        get textDocuments() {
          return boundary.workspace.textDocuments;
        },
        async applyEdit(edit: WorkspaceEdit) {
          if (!options.canApply()) {
            finalGateRejected = true;
            return false;
          }
          return boundary.workspace.applyEdit(edit);
        },
      };
      const result = await applyComposerEdit({
        client: boundary.client,
        workspace: guardedWorkspace,
        result: options.result,
        textDocument: options.textDocument,
        signal: options.signal,
      });
      return finalGateRejected ? { kind: "Stale" } : result;
    },
  };
}

/** Runtime-owned, single-operation native context-menu orchestration. */
export class PreviewComposerController implements Disposable {
  readonly #ports: PreviewComposerControllerPorts;
  #operation: ComposerOperation | undefined;
  readonly #avatarCatalogSubscription: Disposable;
  #disposed = false;

  constructor(ports: PreviewComposerControllerPorts) {
    this.#ports = ports;
    this.#avatarCatalogSubscription = ports.onDidChangeAvatarCatalog(() => this.invalidate());
  }

  /** Starts a new context operation and cancels every resource from the prior one. */
  async handleContextPoint(
    point: PreviewNavigationPoint,
    anchor: PreviewContextMenuAnchor,
  ): Promise<void> {
    this.invalidate();
    if (this.#disposed || !this.#ports.acceptingWork()) return;

    const operation: ComposerOperation = {
      abortController: new AbortController(),
      cancellation: this.#ports.createCancellationTokenSource(),
      transient: undefined,
      released: false,
      applyGateDocument: undefined,
    };
    this.#operation = operation;
    try {
      await this.runOperation(operation, point, anchor);
    } catch {
      if (this.operationState(operation) === "current") {
        await this.notify(operation, "error", UNAVAILABLE_MESSAGE);
      }
    } finally {
      if (this.#operation === operation) {
        this.#operation = undefined;
        this.releaseOperation(operation, false);
      }
    }
  }

  /** Cancels provider/LSP work and disposes the active transient UI. */
  invalidate(reason: "silent" | "stale" = "silent"): void {
    const operation = this.#operation;
    if (!operation) return;
    this.#operation = undefined;
    this.releaseOperation(operation, true);
    if (reason === "stale") {
      try {
        void Promise.resolve(this.#ports.showWarningMessage(STALE_MESSAGE)).catch(() => {});
      } catch {
        // A failed native notification must not revive the cancelled operation.
      }
    }
  }

  /**
   * Invalidates on an external source advance, but consumes the single version
   * advance emitted synchronously by this controller's accepted WorkspaceEdit.
   */
  sourceDocumentChanged(document: ComposerTextDocument): void {
    const operation = this.#operation;
    const expected = operation?.applyGateDocument;
    if (
      expected
      && document.uri === expected.uri
      && document.version === expected.version + 1
    ) {
      operation.applyGateDocument = undefined;
      return;
    }
    this.invalidate("stale");
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.invalidate();
    this.#avatarCatalogSubscription.dispose();
  }

  private async runOperation(
    operation: ComposerOperation,
    point: PreviewNavigationPoint,
    anchor: PreviewContextMenuAnchor,
  ): Promise<void> {
    const located = await this.#ports.locatePreviewPoint(point, operation.abortController.signal);
    let state = this.operationState(operation, located?.identity);
    if (state !== "current") {
      await this.notifyStaleState(operation, state);
      return;
    }
    if (!located) return;

    const targetParams = previewComposerTargetParams(located);
    if (!targetParams) {
      await this.notify(operation, "warning", UNAVAILABLE_MESSAGE);
      return;
    }

    const rawTarget = await this.#ports.request(
      "mmt/previewComposerTarget",
      targetParams,
      operation.cancellation.token,
    );
    state = this.operationState(operation, located.identity);
    if (state !== "current") {
      await this.notifyStaleState(operation, state);
      return;
    }

    const targetResult = parsePreviewComposerTargetResult(rawTarget);
    if (targetResult.kind === "Unavailable") {
      if (
        this.#ports.bidirectionalNavigation()
        && previewUnavailableTargetCanNavigate(targetResult.reason)
      ) {
        const selection = await this.selectMenu(operation, anchor, [{
          label: NAVIGATE_LABEL,
          selection: { kind: "navigate" },
        }]);
        state = this.operationState(operation, located.identity);
        if (state !== "current") {
          await this.notifyStaleState(operation, state);
          return;
        }
        if (selection?.kind === "navigate") {
          await this.#ports.navigatePreviewPoint(point, operation.abortController.signal);
        }
        return;
      }
      await this.notify(
        operation,
        "warning",
        targetResult.reason === "stalePreview" ? STALE_MESSAGE : UNAVAILABLE_MESSAGE,
      );
      return;
    }

    state = this.targetState(operation, located.identity, targetResult.textDocument);
    if (state !== "current") {
      await this.notifyStaleState(operation, state);
      return;
    }

    const avatarCatalog = this.#ports.getAvatarCatalog();
    const actorAvatar = targetResult.properties.actorAvatar;
    const avatarAvailable = actorAvatar !== undefined && avatarCatalog.some((item) => (
      item.selectable && !avatarItemMatchesCurrent(item, actorAvatar.current)
    ));
    const selection = await this.selectContextAction(
      operation,
      anchor,
      targetResult.properties.continued,
      targetResult.properties.statementText !== undefined,
      targetResult.properties.actorDisplayName !== undefined,
      avatarAvailable,
    );
    if (!selection) return;
    state = this.targetState(operation, located.identity, targetResult.textDocument);
    if (state !== "current") {
      await this.notifyStaleState(operation, state);
      return;
    }

    if (selection.kind === "navigate") {
      if (!this.#ports.bidirectionalNavigation()) return;
      await this.#ports.navigatePreviewPoint(point, operation.abortController.signal);
      return;
    }

    if (selection.kind === "avatar") {
      if (!actorAvatar || !avatarAvailable) return;
      await this.pickAvatar(
        operation,
        anchor,
        located.identity,
        targetResult.textDocument,
        targetResult.target,
        actorAvatar.actorPresetId,
        targetResult.properties.actorDisplayName?.current ?? actorAvatar.actorPresetId,
        actorAvatar.current,
        avatarCatalog,
      );
      return;
    }

    let command: ComposerEditParams["command"];
    if (selection.kind === "messageText") {
      const statementText = targetResult.properties.statementText;
      if (!statementText) return;
      const value = await this.inputStatementText(operation, anchor, statementText.current);
      if (value === undefined || value === statementText.current) return;
      state = this.targetState(operation, located.identity, targetResult.textDocument);
      if (state !== "current") {
        await this.notifyStaleState(operation, state);
        return;
      }
      command = { kind: "setStatementText", value };
    } else if (selection.kind === "continued") {
      command = { kind: "setStatementContinued", value: selection.value };
    } else {
      const actorDisplayName = targetResult.properties.actorDisplayName;
      if (!actorDisplayName) return;
      const value = await this.inputDisplayName(operation, anchor, actorDisplayName.current);
      if (value === undefined) return;
      state = this.targetState(operation, located.identity, targetResult.textDocument);
      if (state !== "current") {
        await this.notifyStaleState(operation, state);
        return;
      }
      command = { kind: "setActorDisplayNameFromStatement", value };
    }
    await this.applyComposerCommand(
      operation,
      located.identity,
      targetResult.textDocument,
      targetResult.target,
      command,
    );
  }

  private async pickAvatar(
    operation: ComposerOperation,
    anchor: PreviewContextMenuAnchor,
    identity: PreviewSourceIdentity,
    textDocument: ComposerTextDocument,
    target: ComposerEditParams["target"],
    actorPresetId: string,
    actorLabel: string,
    current: ComposerAvatarCurrent | null,
    items: readonly AvatarCatalogItem[],
  ): Promise<void> {
    const session = this.#ports.avatarPicker.open(anchor, {
      actorPresetId,
      actorLabel,
      current,
      items,
      choose: async (avatar) => {
        const state = this.targetState(operation, identity, textDocument);
        if (state !== "current") {
          await this.notifyStaleState(operation, state);
          return;
        }
        await this.applyComposerCommand(operation, identity, textDocument, target, {
          kind: "setActorAvatarFromStatement",
          avatar,
        });
      },
    });
    const active: ActiveTransientUi = { close: () => session.close() };
    operation.transient?.close();
    operation.transient = active;
    await session.result;
    if (operation.transient === active) operation.transient = undefined;
  }

  private async applyComposerCommand(
    operation: ComposerOperation,
    identity: PreviewSourceIdentity,
    textDocument: ComposerTextDocument,
    target: ComposerEditParams["target"],
    command: ComposerEditParams["command"],
  ): Promise<void> {
    const rawEdit = await this.#ports.request(
      "mmt/composerEdit",
      { textDocument, target, command },
      operation.cancellation.token,
    );
    let state = this.targetState(operation, identity, textDocument);
    if (state !== "current") {
      await this.notifyStaleState(operation, state);
      return;
    }
    const editResult = parseComposerEditResult(rawEdit, textDocument);
    if (editResult.kind === "Rejected") {
      const message = editResult.reason === "staleDocument" || editResult.reason === "targetChanged"
        ? STALE_MESSAGE
        : editResult.reason === "avatarUnavailable"
          ? AVATAR_UNAVAILABLE_MESSAGE
          : REJECTED_MESSAGE;
      await this.notify(operation, "warning", message);
      return;
    }
    state = this.targetState(operation, identity, textDocument);
    if (state !== "current") {
      await this.notifyStaleState(operation, state);
      return;
    }
    const application = await this.#ports.apply.apply({
      result: editResult,
      textDocument,
      signal: operation.abortController.signal,
      canApply: () => {
        if (this.targetState(operation, identity, textDocument) !== "current") return false;
        operation.applyGateDocument = textDocument;
        return true;
      },
    });
    if (application.kind === "Stale") {
      await this.notify(operation, "warning", STALE_MESSAGE);
    } else if (application.kind === "ApplyFailed") {
      await this.notify(operation, "error", APPLY_FAILED_MESSAGE);
    }
  }

  private operationState(
    operation: ComposerOperation,
    identity?: PreviewSourceIdentity,
  ): OperationState {
    if (
      this.#disposed
      || this.#operation !== operation
      || operation.released
      || operation.abortController.signal.aborted
      || operation.cancellation.token.isCancellationRequested
      || !this.#ports.acceptingWork()
    ) {
      return "cancelled";
    }
    if (identity && !previewComposerIdentityMatches(identity, this.#ports.currentIdentity())) {
      return "stale";
    }
    return "current";
  }

  private targetState(
    operation: ComposerOperation,
    identity: PreviewSourceIdentity,
    textDocument: ComposerTextDocument,
  ): OperationState {
    const state = this.operationState(operation, identity);
    if (state !== "current") return state;
    if (textDocument.uri !== identity.sourceUri) return "stale";
    const currentDocument = this.#ports.currentDocument(textDocument.uri);
    return currentDocument
      && currentDocument.uri === textDocument.uri
      && currentDocument.version === textDocument.version
      ? "current"
      : "stale";
  }

  private async selectContextAction(
    operation: ComposerOperation,
    anchor: PreviewContextMenuAnchor,
    current: StatementContinuedValue,
    statementTextAvailable: boolean,
    actorAvailable: boolean,
    avatarAvailable: boolean,
  ): Promise<PreviewComposerContextMenuSelection | undefined> {
    const continuedChoices: ReadonlyArray<{
      readonly label: string;
      readonly value: StatementContinuedValue;
    }> = [
      { label: "自动", value: "auto" },
      { label: "强制连续", value: "true" },
      { label: "强制新消息", value: "false" },
    ];
    const items: PreviewComposerContextMenuItem[] = [{
      label: EDIT_CONTINUED_LABEL,
      children: continuedChoices.map(({ label, value }) => ({
        label,
        checked: value === current,
        selection: { kind: "continued", value },
      })),
    }];
    if (statementTextAvailable) {
      items.push({
        label: EDIT_MESSAGE_LABEL,
        selection: { kind: "messageText" },
      });
    }
    if (actorAvailable) {
      items.push({
        label: EDIT_DISPLAY_NAME_LABEL,
        selection: { kind: "displayName" },
      });
    }
    if (avatarAvailable) {
      items.push({
        label: EDIT_AVATAR_LABEL,
        selection: { kind: "avatar" },
      });
    }
    if (this.#ports.bidirectionalNavigation()) {
      items.push({
        label: NAVIGATE_LABEL,
        selection: { kind: "navigate" },
      });
    }

    return this.selectMenu(operation, anchor, items);
  }

  private async selectMenu(
    operation: ComposerOperation,
    anchor: PreviewContextMenuAnchor,
    items: readonly PreviewComposerContextMenuItem[],
  ): Promise<PreviewComposerContextMenuSelection | undefined> {
    const session = this.#ports.contextMenu.open(anchor, items);
    const active: ActiveTransientUi = {
      close: () => session.close(),
    };
    operation.transient?.close();
    operation.transient = active;
    const selection = await session.result;
    if (operation.transient === active) operation.transient = undefined;
    return selection;
  }

  private async inputStatementText(
    operation: ComposerOperation,
    anchor: PreviewContextMenuAnchor,
    current: string,
  ): Promise<string | undefined> {
    const session = this.#ports.contextInput.open(anchor, {
      title: "编辑消息",
      placeholder: "输入新的消息正文",
      value: current,
      requiredMessage: MESSAGE_INPUT_REQUIRED_MESSAGE,
    });
    const active: ActiveTransientUi = {
      close: () => session.close(),
    };
    operation.transient?.close();
    operation.transient = active;
    const value = await session.result;
    if (operation.transient === active) operation.transient = undefined;
    return value && value.length > 0 && !value.includes("\r") && !value.includes("\n")
      ? value
      : undefined;
  }

  private async inputDisplayName(
    operation: ComposerOperation,
    anchor: PreviewContextMenuAnchor,
    current: string,
  ): Promise<string | undefined> {
    const session = this.#ports.contextInput.open(anchor, {
      title: "从本条起修改人物显示名",
      placeholder: "输入新的显示名",
      value: current,
      requiredMessage: INPUT_REQUIRED_MESSAGE,
    });
    const active: ActiveTransientUi = {
      close: () => session.close(),
    };
    operation.transient?.close();
    operation.transient = active;
    const value = await session.result;
    if (operation.transient === active) operation.transient = undefined;
    return value && value.length > 0 ? value : undefined;
  }

  private async notifyStaleState(operation: ComposerOperation, state: OperationState): Promise<void> {
    if (state === "stale") await this.notify(operation, "warning", STALE_MESSAGE);
  }

  private async notify(
    operation: ComposerOperation,
    severity: "warning" | "error",
    message: string,
  ): Promise<void> {
    if (this.#operation !== operation || operation.released || operation.abortController.signal.aborted) return;
    try {
      if (severity === "warning") await this.#ports.showWarningMessage(message);
      else await this.#ports.showErrorMessage(message);
    } catch {
      // A dismissed or failed native notification must not revive an edit operation.
    }
  }

  private releaseOperation(operation: ComposerOperation, cancel: boolean): void {
    if (operation.released) return;
    operation.released = true;
    if (cancel) {
      operation.abortController.abort();
      operation.cancellation.cancel();
    }
    operation.transient?.close();
    operation.transient = undefined;
    operation.cancellation.dispose();
  }
}

function previewUnavailableTargetCanNavigate(
  reason: PreviewComposerTargetUnavailableReason,
): boolean {
  return reason !== "stalePreview" && reason !== "unmapped" && reason !== "ambiguousOrigin";
}

function previewComposerTargetParams(located: LocatedPreviewPoint): PreviewComposerTargetParams | undefined {
  const { identity } = located;
  if (identity.languageId !== "mmt" || identity.projectionKey === undefined) return undefined;
  return {
    sourceUri: identity.sourceUri,
    revision: identity.revision,
    sourceContent: identity.sourceContent,
    projectDigest: identity.projectDigest,
    projectionKey: identity.projectionKey,
    entryUri: identity.entryUri,
    backendEncoding: identity.backendEncoding,
    location: located.location,
  };
}

function previewComposerIdentityMatches(
  expected: PreviewSourceIdentity,
  current: PreviewSourceIdentity | undefined,
): boolean {
  return current !== undefined
    && expected.workspaceId === current.workspaceId
    && expected.sourceUri === current.sourceUri
    && expected.sourceContent === current.sourceContent
    && expected.sourceStaleToken.hostUri === current.sourceStaleToken.hostUri
    && expected.sourceStaleToken.documentIncarnation === current.sourceStaleToken.documentIncarnation
    && expected.sourceStaleToken.documentVersion === current.sourceStaleToken.documentVersion
    && expected.projectDigest === current.projectDigest
    && expected.projectionKey === current.projectionKey
    && expected.revision === current.revision
    && expected.entryUri === current.entryUri
    && expected.languageId === current.languageId
    && expected.backendEncoding === current.backendEncoding;
}
