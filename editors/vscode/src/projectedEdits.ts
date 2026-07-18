import * as vscode from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";
import type {
  CodeAction,
  CodeActionParams,
  Command,
  DocumentRangeFormattingParams,
  PrepareRenameParams,
  PrepareRenameResult,
  RenameParams,
  TextEdit,
  WorkspaceEdit
} from "vscode-languageserver-protocol";

import type { TinymistHostBackend } from "./tinymistClient";
import {
  PROJECTED_EDIT_PROTOCOL_VERSION,
  type ProjectedEditFailure,
  type ProjectedEditTransaction,
  type ProjectedEditValidationResult,
  type ProjectedTextEdit,
  type ValidatedProjectedDocumentEdits
} from "./projectedEditProtocol";
import {
  type RoutedProjectedTypstProviderResult,
  TypstFeatureRouter,
  type TypstRouterDocument
} from "./typstFeatureRouter";
import { validateTypstCommandPayload } from "./typstProviderPayload";
import type {
  TypstProviderHost,
  TypstProviderRegistrationContract
} from "./typstProviderDescriptors";

export interface ProjectedEditValidator {
  validate(
    transaction: ProjectedEditTransaction,
    token: vscode.CancellationToken
  ): Promise<ProjectedEditValidationResult>;
}

export class LanguageClientProjectedEditValidator implements ProjectedEditValidator {
  constructor(private readonly client: BaseLanguageClient) {}

  async validate(
    transaction: ProjectedEditTransaction,
    token: vscode.CancellationToken
  ): Promise<ProjectedEditValidationResult> {
    return await this.client.sendRequest<ProjectedEditValidationResult>(
      "mmt/validateProjectedEdit",
      transaction,
      token
    );
  }
}

export type ProjectedEditApplicationResult =
  | { readonly kind: "Applied" }
  | { readonly kind: "ApplyFailed" }
  | ProjectedEditFailure;

export interface MultiDocumentEditApplier {
  apply(
    validated: Extract<ProjectedEditValidationResult, { readonly kind: "Validated" }>,
    token: vscode.CancellationToken
  ): Promise<ProjectedEditApplicationResult>;
}

export class CapabilityUnavailableMultiDocumentEditApplier implements MultiDocumentEditApplier {
  async apply(
    _validated: Extract<ProjectedEditValidationResult, { readonly kind: "Validated" }>,
    _token: vscode.CancellationToken
  ): Promise<ProjectedEditApplicationResult> {
    return Object.freeze({ kind: "CapabilityUnavailable" as const });
  }
}

export interface ProjectedEditWorkspaceHost {
  readonly textDocuments: readonly vscode.TextDocument[];
  applyEdit(edit: vscode.WorkspaceEdit): Thenable<boolean>;
}

export interface PreparedProjectedEdit {
  readonly kind: "Validated";
  readonly transaction: ProjectedEditTransaction;
  readonly protocolEdit: WorkspaceEdit;
  readonly workspaceEdit: vscode.WorkspaceEdit;
  readonly document: vscode.TextDocument;
  readonly textEdits: readonly vscode.TextEdit[];
}

interface ProjectedRouteIdentity {
  readonly entryUri: string;
  readonly encoding: "utf-8" | "utf-16";
  readonly identity: RoutedProjectedTypstProviderResult<"textDocument/rename">["identity"];
}

/**
 * Maps one complete backend edit result through the Rust validator. No mapped
 * edit escapes until every backend range and the current authored version pass.
 */
export class ProjectedEditAdapter {
  constructor(
    private readonly validator: ProjectedEditValidator,
    private readonly workspace: ProjectedEditWorkspaceHost = vscode.workspace,
    private readonly multiDocument: MultiDocumentEditApplier = new CapabilityUnavailableMultiDocumentEditApplier()
  ) {}

  async prepareTextEdits(
    route: ProjectedRouteIdentity,
    edits: readonly TextEdit[],
    token: vscode.CancellationToken
  ): Promise<PreparedProjectedEdit | ProjectedEditFailure> {
    return await this.prepare(route, edits.map((edit) => ({
      virtualUri: route.entryUri,
      range: edit.range,
      newText: edit.newText
    })), token);
  }

  async prepareWorkspaceEdit(
    route: ProjectedRouteIdentity,
    edit: WorkspaceEdit,
    token: vscode.CancellationToken
  ): Promise<PreparedProjectedEdit | ProjectedEditFailure> {
    const backendEdits = collectWorkspaceTextEdits(edit, route);
    if ("kind" in backendEdits) return backendEdits;
    return await this.prepare(route, backendEdits, token);
  }

  async apply(
    route: ProjectedRouteIdentity,
    edit: WorkspaceEdit,
    token: vscode.CancellationToken
  ): Promise<ProjectedEditApplicationResult> {
    const backendEdits = collectWorkspaceTextEdits(edit, route);
    if ("kind" in backendEdits) return backendEdits;
    const transaction = this.transaction(route, backendEdits);
    const validated = await this.validator.validate(transaction, token);
    if (validated.kind !== "Validated") return validated;
    if (token.isCancellationRequested) return Object.freeze({ kind: "StaleProjection", reason: "request cancelled" });
    if (validated.documents.length !== 1) return await this.multiDocument.apply(validated, token);
    const prepared = this.convertValidated(transaction, validated.documents[0]);
    if (prepared.kind !== "Validated") return prepared;
    if (prepared.document.version !== prepared.transaction.expectedVersions[0]?.version) {
      return Object.freeze({ kind: "StaleProjection", reason: "document version changed before WorkspaceEdit.applyEdit" });
    }
    return await this.workspace.applyEdit(prepared.workspaceEdit)
      ? Object.freeze({ kind: "Applied" as const })
      : Object.freeze({ kind: "ApplyFailed" as const });
  }

  private async prepare(
    route: ProjectedRouteIdentity,
    edits: readonly ProjectedTextEdit[],
    token: vscode.CancellationToken
  ): Promise<PreparedProjectedEdit | ProjectedEditFailure> {
    if (edits.length === 0) return unsafe("backend edit is empty");
    const transaction = this.transaction(route, edits);
    const validated = await this.validator.validate(transaction, token);
    if (validated.kind !== "Validated") return validated;
    if (token.isCancellationRequested) return Object.freeze({ kind: "StaleProjection", reason: "request cancelled" });
    if (validated.documents.length !== 1) {
      return Object.freeze({ kind: "CapabilityUnavailable" as const });
    }
    return this.convertValidated(transaction, validated.documents[0]);
  }

  private transaction(
    route: ProjectedRouteIdentity,
    edits: readonly ProjectedTextEdit[]
  ): ProjectedEditTransaction {
    const virtualUris = [...new Set(edits.map((edit) => edit.virtualUri))];
    return Object.freeze({
      protocolVersion: PROJECTED_EDIT_PROTOCOL_VERSION,
      documents: Object.freeze(virtualUris.map((virtualUri) => Object.freeze({
        virtualUri,
        sourceContent: route.identity.sourceContent,
        projectionKey: route.identity.projectionKey!,
        encoding: route.encoding
      }))),
      edits: Object.freeze(edits.map((edit) => Object.freeze(edit))),
      expectedVersions: Object.freeze([Object.freeze({
        uri: route.identity.sourceStaleToken.hostUri,
        version: route.identity.sourceStaleToken.documentVersion
      })])
    });
  }

  private convertValidated(
    transaction: ProjectedEditTransaction,
    validated: ValidatedProjectedDocumentEdits
  ): PreparedProjectedEdit | ProjectedEditFailure {
    const expected = transaction.expectedVersions[0];
    if (!expected
      || validated.normalizedUri !== expected.uri
      || validated.expectedVersion !== expected.version) {
      return unsafe("Rust validator returned a different authored target identity");
    }
    const document = this.workspace.textDocuments.find((candidate) =>
      candidate.uri.toString() === validated.normalizedUri
    );
    if (!document || document.version !== validated.expectedVersion) {
      return Object.freeze({ kind: "StaleProjection", reason: "document version changed before edit publication" });
    }
    const offsets = validated.edits.flatMap((edit) => [edit.startByte, edit.endByte]);
    const utf16Offsets = utf8ByteOffsetsToUtf16(document.getText(), offsets);
    if (!utf16Offsets) return unsafe("Rust validator returned a non-boundary byte offset");
    const protocolEdits: TextEdit[] = [];
    const textEdits: vscode.TextEdit[] = [];
    for (let index = 0; index < validated.edits.length; index += 1) {
      const edit = validated.edits[index];
      const start = document.positionAt(utf16Offsets[index * 2]);
      const end = document.positionAt(utf16Offsets[index * 2 + 1]);
      const range = new vscode.Range(start, end);
      textEdits.push(new vscode.TextEdit(range, edit.newText));
      protocolEdits.push({
        range: {
          start: { line: start.line, character: start.character },
          end: { line: end.line, character: end.character }
        },
        newText: edit.newText
      });
    }
    const protocolEdit: WorkspaceEdit = {
      documentChanges: [{
        textDocument: { uri: validated.normalizedUri, version: validated.expectedVersion },
        edits: protocolEdits
      }]
    };
    const workspaceEdit = new vscode.WorkspaceEdit();
    workspaceEdit.set(vscode.Uri.parse(validated.normalizedUri), textEdits);
    return Object.freeze({
      kind: "Validated" as const,
      transaction,
      protocolEdit,
      workspaceEdit,
      document,
      textEdits: Object.freeze(textEdits)
    });
  }
}

/** Capability-qualified edit providers for MMT-authored Identity projections. */
export class ProjectedTypstEditProviders implements vscode.Disposable {
  private readonly active = new Map<string, { readonly fingerprint: string; readonly disposable: vscode.Disposable }>();
  private disposed = false;

  constructor(
    private readonly router: TypstFeatureRouter,
    private readonly backend: TinymistHostBackend,
    private readonly client: BaseLanguageClient,
    private readonly host: TypstProviderHost,
    private readonly adapter: ProjectedEditAdapter = new ProjectedEditAdapter(
      new LanguageClientProjectedEditValidator(client)
    )
  ) {}

  reconcile(): void {
    if (this.disposed) return;
    const desired = new Map<string, TypstProviderRegistrationContract>();
    for (const method of ["textDocument/rename", "textDocument/rangeFormatting", "textDocument/codeAction"] as const) {
      const capability = this.router.providerCapability(this.host, method);
      if (capability.kind === "QualifiedProvider") desired.set(method, capability);
    }
    for (const [method, active] of this.active) {
      const registration = desired.get(method);
      const fingerprint = registration ? this.fingerprint(registration) : undefined;
      if (fingerprint === active.fingerprint) continue;
      active.disposable.dispose();
      this.active.delete(method);
    }
    for (const [method, registration] of desired) {
      if (this.active.has(method)) continue;
      this.active.set(method, {
        fingerprint: this.fingerprint(registration),
        disposable: this.register(method, registration)
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const active of this.active.values()) active.disposable.dispose();
    this.active.clear();
  }

  private fingerprint(registration: TypstProviderRegistrationContract): string {
    return JSON.stringify({ generation: this.backend.capabilities().generation, registration });
  }

  private register(method: string, registration: TypstProviderRegistrationContract): vscode.Disposable {
    const selector: vscode.DocumentSelector = [{ language: "mmt" }];
    if (method === "textDocument/rename") {
      return vscode.languages.registerRenameProvider(selector, {
        prepareRename: async (document, position, token) => {
          const prepare = this.router.providerCapability(this.host, "textDocument/prepareRename");
          if (prepare.kind !== "QualifiedProvider") return undefined;
          const routed = await this.router.projectedProviderAtPosition(
            this.host,
            "textDocument/prepareRename",
            routerDocument(document),
            this.client.code2ProtocolConverter.asPosition(position),
            {
              textDocument: { uri: document.uri.toString() },
              position: this.client.code2ProtocolConverter.asPosition(position)
            } satisfies PrepareRenameParams,
            token
          );
          if (!routed || routed.value === null || token.isCancellationRequested) return undefined;
          const prepared = routed.value as PrepareRenameResult;
          if ("defaultBehavior" in prepared) return undefined;
          const backendRange = "start" in prepared ? prepared : prepared.range;
          const mapped = await this.adapter.prepareTextEdits(
            routed,
            [{ range: backendRange, newText: "" }],
            token
          );
          if (mapped.kind !== "Validated" || !this.router.providerIdentityIsCurrent(routed.identity)) return undefined;
          const range = mapped.textEdits[0]?.range;
          if (!range) return undefined;
          const placeholder = "start" in prepared ? document.getText(range) : prepared.placeholder;
          return placeholder.length > 0 && document.getText(range) === placeholder
            ? { range, placeholder }
            : undefined;
        },
        provideRenameEdits: async (document, position, newName, token) => {
          const routed = await this.router.projectedProviderAtPosition(
            this.host,
            "textDocument/rename",
            routerDocument(document),
            this.client.code2ProtocolConverter.asPosition(position),
            {
              textDocument: { uri: document.uri.toString() },
              position: this.client.code2ProtocolConverter.asPosition(position),
              newName
            } satisfies RenameParams,
            token
          );
          if (!routed || routed.value === null || token.isCancellationRequested) return undefined;
          const mapped = await this.adapter.prepareWorkspaceEdit(routed, routed.value as WorkspaceEdit, token);
          return mapped.kind === "Validated" && this.router.providerIdentityIsCurrent(routed.identity)
            ? mapped.workspaceEdit
            : undefined;
        }
      });
    }
    if (method === "textDocument/rangeFormatting") {
      return vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
        provideDocumentRangeFormattingEdits: async (document, range, options, token) => {
          const fullRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
          if (range.isEqual(fullRange)
            || vscode.workspace.getConfiguration("editor", document.uri).get<boolean>("formatOnSave") === true) {
            return undefined;
          }
          const protocolRange = this.client.code2ProtocolConverter.asRange(range);
          const routed = await this.router.projectedProviderAtRange(
            this.host,
            "textDocument/rangeFormatting",
            routerDocument(document),
            protocolRange,
            {
              textDocument: { uri: document.uri.toString() },
              range: protocolRange,
              options: {
                tabSize: options.tabSize,
                insertSpaces: options.insertSpaces,
                ...(typeof options.trimTrailingWhitespace === "boolean" ? { trimTrailingWhitespace: options.trimTrailingWhitespace } : {}),
                ...(typeof options.insertFinalNewline === "boolean" ? { insertFinalNewline: options.insertFinalNewline } : {}),
                ...(typeof options.trimFinalNewlines === "boolean" ? { trimFinalNewlines: options.trimFinalNewlines } : {})
              }
            } satisfies DocumentRangeFormattingParams,
            token
          );
          if (!routed || routed.value === null || token.isCancellationRequested) return undefined;
          const mapped = await this.adapter.prepareTextEdits(routed, routed.value as TextEdit[], token);
          return mapped.kind === "Validated" && this.router.providerIdentityIsCurrent(routed.identity)
            ? [...mapped.textEdits]
            : undefined;
        }
      });
    }
    if (method === "textDocument/codeAction") {
      const provider: vscode.CodeActionProvider = {
        provideCodeActions: async (document, range, context, token) => {
          const protocolRange = this.client.code2ProtocolConverter.asRange(range);
          const routed = await this.router.projectedProviderAtRange(
            this.host,
            "textDocument/codeAction",
            routerDocument(document),
            protocolRange,
            {
              textDocument: { uri: document.uri.toString() },
              range: protocolRange,
              context: this.client.code2ProtocolConverter.asCodeActionContextSync(context)
            } satisfies CodeActionParams,
            token
          );
          if (!routed || routed.value === null || token.isCancellationRequested) return undefined;
          const mapped = await this.mapCodeActions(routed, routed.value as (Command | CodeAction)[], token, registration.resolveProvider);
          return mapped && this.router.providerIdentityIsCurrent(routed.identity)
            ? await this.client.protocol2CodeConverter.asCodeActionResult(mapped, token)
            : undefined;
        }
      };
      if (registration.resolveProvider) {
        provider.resolveCodeAction = async (action, token) => {
          const routed = await this.router.projectedProviderResolve(
            this.host,
            "codeAction/resolve",
            this.client.code2ProtocolConverter.asCodeActionSync(action),
            token
          );
          if (!routed || token.isCancellationRequested) return undefined;
          const mapped = await this.mapCodeActions(routed, [routed.value], token, false);
          if (!mapped || mapped.length !== 1 || !this.router.providerIdentityIsCurrent(routed.identity)) return undefined;
          return await this.client.protocol2CodeConverter.asCodeAction(mapped[0] as CodeAction, token);
        };
      }
      const kinds = this.client.protocol2CodeConverter.asCodeActionKinds([...registration.codeActionKinds]);
      return vscode.languages.registerCodeActionsProvider(
        selector,
        provider,
        kinds === undefined ? undefined : { providedCodeActionKinds: kinds }
      );
    }
    throw new Error(`Unsupported projected edit provider: ${method}`);
  }

  private async mapCodeActions(
    routed: RoutedProjectedTypstProviderResult<"textDocument/codeAction" | "codeAction/resolve">,
    actions: readonly (Command | CodeAction)[],
    token: vscode.CancellationToken,
    bindResolve: boolean
  ): Promise<(Command | CodeAction)[] | undefined> {
    const mapped: (Command | CodeAction)[] = [];
    const allowedCommands = this.allowedCommands();
    for (const action of actions) {
      if (token.isCancellationRequested) return undefined;
      let command: Command | undefined;
      if ("command" in action) {
        const candidate = action.command;
        if (typeof candidate === "string") command = action as Command;
        else if (candidate !== undefined) command = candidate as Command;
      }
      if (command && validateTypstCommandPayload(command, allowedCommands).kind !== "Validated") {
        return undefined;
      }
      let protocolEdit: WorkspaceEdit | undefined;
      if ("edit" in action && action.edit !== undefined) {
        const prepared = await this.adapter.prepareWorkspaceEdit(routed, action.edit, token);
        if (prepared.kind !== "Validated") return undefined;
        protocolEdit = prepared.protocolEdit;
      }
      if (!protocolEdit && !command && !("disabled" in action && action.disabled !== undefined)) return undefined;
      const safe = {
        ...action,
        ...(protocolEdit ? { edit: protocolEdit } : {})
      } as Command | CodeAction;
      mapped.push(bindResolve && "data" in safe
        ? this.router.bindProviderResolveItem("textDocument/codeAction", safe, routed.identity)
        : safe);
    }
    return mapped;
  }

  private allowedCommands(): readonly string[] {
    const descriptor = this.backend.capabilities().get("workspace/executeCommand");
    if (!descriptor) return [];
    const commands = new Set<string>();
    for (const options of [
      descriptor.initializeOptions,
      ...descriptor.dynamicRegistrations.map((registration) => registration.registerOptions)
    ]) {
      if (!options || typeof options !== "object" || !("commands" in options) || !Array.isArray(options.commands)) continue;
      for (const command of options.commands) if (typeof command === "string") commands.add(command);
    }
    return [...commands];
  }
}

function collectWorkspaceTextEdits(
  edit: WorkspaceEdit,
  route: ProjectedRouteIdentity
): ProjectedTextEdit[] | ProjectedEditFailure {
  const collected: ProjectedTextEdit[] = [];
  if (edit.changes !== undefined) {
    for (const [virtualUri, edits] of Object.entries(edit.changes)) {
      for (const item of edits) collected.push({ virtualUri, range: item.range, newText: item.newText });
    }
  }
  if (edit.documentChanges !== undefined) {
    for (const change of edit.documentChanges) {
      if (!("textDocument" in change)) return unsafe("workspace resource operations are not projected text edits");
      if (change.textDocument.version !== null
        && change.textDocument.version !== undefined
        && change.textDocument.version !== route.identity.sourceStaleToken.documentVersion
        && change.textDocument.version !== (route as Partial<{ revision: number }>).revision) {
        return Object.freeze({ kind: "StaleProjection", reason: "backend edit version does not match the request projection" });
      }
      for (const item of change.edits) {
        collected.push({ virtualUri: change.textDocument.uri, range: item.range, newText: item.newText });
      }
    }
  }
  return collected.length > 0 ? collected : unsafe("workspace edit has no text edits");
}

function utf8ByteOffsetsToUtf16(text: string, offsets: readonly number[]): number[] | undefined {
  if (offsets.some((offset) => !Number.isSafeInteger(offset) || offset < 0)) return undefined;
  const wanted = [...new Set(offsets)].sort((left, right) => left - right);
  const mapped = new Map<number, number>();
  let bytes = 0;
  let utf16 = 0;
  let wantedIndex = 0;
  while (wantedIndex < wanted.length && wanted[wantedIndex] === 0) {
    mapped.set(0, 0);
    wantedIndex += 1;
  }
  for (const scalar of text) {
    const codePoint = scalar.codePointAt(0) as number;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    utf16 += scalar.length;
    while (wantedIndex < wanted.length && wanted[wantedIndex] === bytes) {
      mapped.set(bytes, utf16);
      wantedIndex += 1;
    }
    if (wantedIndex < wanted.length && wanted[wantedIndex] < bytes) return undefined;
  }
  if (wantedIndex !== wanted.length) return undefined;
  return offsets.map((offset) => mapped.get(offset) as number);
}

function routerDocument(document: vscode.TextDocument): TypstRouterDocument {
  return {
    languageId: document.languageId,
    uri: document.uri.toString(),
    version: document.version,
    text: document.getText()
  };
}

function unsafe(reason: string): ProjectedEditFailure {
  return Object.freeze({ kind: "UnsafeEdit" as const, reason });
}
