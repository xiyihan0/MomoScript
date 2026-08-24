import type { CancellationToken, Disposable, WorkspaceEdit } from "vscode";
import {
  applyComposerEdit,
  parseComposerEditResult,
  parsePreviewComposerTargetResult,
  type ApplyComposerEditOptions,
  type ComposerEditApplicationResult,
  type ComposerEditParams,
  type ComposerEditResult,
  type ComposerTextDocument,
  type StatementContinuedValue,
} from "./composerEdit.ts";
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

export interface PreviewComposerInputBox extends Disposable {
  title: string | undefined;
  prompt: string | undefined;
  value: string;
  validationMessage: string | undefined;
  onDidAccept(listener: () => void): Disposable;
  onDidHide(listener: () => void): Disposable;
  onDidChangeValue(listener: (value: string) => void): Disposable;
  show(): void;
  hide(): void;
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
  readonly createInputBox: () => PreviewComposerInputBox;
  readonly apply: PreviewComposerApplyPort;
  readonly acceptingWork: () => boolean;
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
const NAVIGATE_LABEL = "转到源码";
const STALE_MESSAGE = "源码已更改，未应用编辑。";
const UNAVAILABLE_MESSAGE = "无法编辑此预览内容。";
const REJECTED_MESSAGE = "无法应用此预览编辑。";
const APPLY_FAILED_MESSAGE = "无法应用预览编辑。";
const INPUT_REQUIRED_MESSAGE = "显示名不能为空。";

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
  #disposed = false;

  constructor(ports: PreviewComposerControllerPorts) {
    this.#ports = ports;
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

    const selection = await this.selectContextAction(
      operation,
      anchor,
      targetResult.properties.continued,
      targetResult.properties.actorDisplayName !== undefined,
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

    let command: ComposerEditParams["command"] | undefined;
    if (selection.kind === "continued") {
      command = { kind: "setStatementContinued", value: selection.value };
    } else {
      const actorDisplayName = targetResult.properties.actorDisplayName;
      if (!actorDisplayName) return;
      const value = await this.inputDisplayName(operation, actorDisplayName.current);
      if (value === undefined) return;
      state = this.targetState(operation, located.identity, targetResult.textDocument);
      if (state !== "current") {
        await this.notifyStaleState(operation, state);
        return;
      }
      command = { kind: "setActorDisplayNameFromStatement", value };
    }

    const editParams: ComposerEditParams = {
      textDocument: targetResult.textDocument,
      target: targetResult.target,
      command,
    };
    const rawEdit = await this.#ports.request(
      "mmt/composerEdit",
      editParams,
      operation.cancellation.token,
    );
    state = this.targetState(operation, located.identity, targetResult.textDocument);
    if (state !== "current") {
      await this.notifyStaleState(operation, state);
      return;
    }

    const editResult = parseComposerEditResult(rawEdit, targetResult.textDocument);
    if (editResult.kind === "Rejected") {
      const message = editResult.reason === "staleDocument" || editResult.reason === "targetChanged"
        ? STALE_MESSAGE
        : REJECTED_MESSAGE;
      await this.notify(operation, "warning", message);
      return;
    }

    state = this.targetState(operation, located.identity, targetResult.textDocument);
    if (state !== "current") {
      await this.notifyStaleState(operation, state);
      return;
    }
    const application = await this.#ports.apply.apply({
      result: editResult,
      textDocument: targetResult.textDocument,
      signal: operation.abortController.signal,
      canApply: () => {
        if (this.targetState(operation, located.identity, targetResult.textDocument) !== "current") {
          return false;
        }
        operation.applyGateDocument = targetResult.textDocument;
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
    actorAvailable: boolean,
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
    if (actorAvailable) {
      items.push({
        label: EDIT_DISPLAY_NAME_LABEL,
        selection: { kind: "displayName" },
      });
    }
    if (this.#ports.bidirectionalNavigation()) {
      items.push({
        label: NAVIGATE_LABEL,
        selection: { kind: "navigate" },
      });
    }

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

  private inputDisplayName(operation: ComposerOperation, current: string): Promise<string | undefined> {
    const input = this.#ports.createInputBox();
    input.title = "从本条起修改人物显示名";
    input.prompt = "输入新的显示名";
    input.value = current;
    input.validationMessage = undefined;

    const { promise, resolve } = Promise.withResolvers<string | undefined>();
    let settled = false;
    let closed = false;
    const subscriptions: Disposable[] = [];
    let active: ActiveTransientUi;
    const close = () => {
      if (closed) return;
      closed = true;
      if (operation.transient === active) operation.transient = undefined;
      for (const subscription of subscriptions.splice(0)) subscription.dispose();
      input.hide();
      input.dispose();
    };
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      close();
      resolve(value);
    };
    active = {
      close() {
        finish(undefined);
        close();
      },
    };
    operation.transient?.close();
    operation.transient = active;
    subscriptions.push(
      input.onDidAccept(() => {
        if (input.value.length === 0) {
          input.validationMessage = INPUT_REQUIRED_MESSAGE;
          return;
        }
        finish(input.value);
      }),
      input.onDidHide(() => finish(undefined)),
      input.onDidChangeValue((value) => {
        if (value.length > 0 && input.validationMessage !== undefined) {
          input.validationMessage = undefined;
        }
      }),
    );
    input.show();
    return promise;
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
