import * as vscode from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";
import type {
  CodeAction,
  CodeActionParams,
  CodeLens,
  CodeLensParams,
  ColorInformation,
  ColorPresentation,
  ColorPresentationParams,
  DocumentColorParams,
  DocumentFormattingParams,
  DocumentLink,
  DocumentLinkParams,
  DocumentRangeFormattingParams,
  InlayHint,
  InlayHintParams,
  PrepareRenameParams,
  PrepareRenameResult,
  RenameParams,
  TextDocumentEdit,
  TextEdit,
  WorkspaceEdit
} from "vscode-languageserver-protocol";

import { canonicalTypstUri, type TinymistHostBackend } from "./tinymistClient";
import type { TinymistRequestIdentity } from "./tinymistRequestDispatcher";
import type {
  RoutedStandaloneTypstProviderResult,
  TypstFeatureRouter,
  TypstRouterDocument
} from "./typstFeatureRouter";
import {
  validateTypstProviderItemPayload,
  type TypstProviderItemPayloadValidationResult,
  type TypstProviderPayloadTargetClass
} from "./typstProviderPayload";
import type {
  TypstProviderHost,
  TypstProviderMethod,
  TypstProviderRegistrationContract,
  TypstProviderRequests
} from "./typstProviderDescriptors";

const RICH_PROVIDER_METHODS = Object.freeze([
  "textDocument/rename",
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/documentLink",
  "textDocument/documentColor",
  "textDocument/codeAction",
  "textDocument/inlayHint",
  "textDocument/codeLens"
] as const);

type RichProviderMethod = typeof RICH_PROVIDER_METHODS[number];

/**
 * Owns the independently negotiated standalone editing/rich provider family.
 * Reconciliation is generation-scoped: changed options dispose the old VS Code
 * provider before the replacement is published.
 */
export class RichTypstProviderRegistrations implements vscode.Disposable {
  private readonly active = new Map<
    RichProviderMethod,
    { readonly fingerprint: string; readonly disposable: vscode.Disposable }
  >();
  private disposed = false;

  constructor(
    private readonly router: TypstFeatureRouter,
    private readonly backend: TinymistHostBackend,
    private readonly client: BaseLanguageClient,
    private readonly host: TypstProviderHost
  ) {}

  reconcile(): void {
    if (this.disposed) return;
    const desired = new Map<RichProviderMethod, TypstProviderRegistrationContract>();
    for (const registration of this.router.providerRegistrations(this.host)) {
      const method = registration.descriptor.method;
      if ((RICH_PROVIDER_METHODS as readonly string[]).includes(method)) {
        desired.set(method as RichProviderMethod, registration);
      }
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
        disposable: this.register(registration)
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
    const method = registration.descriptor.method;
    const related = method === "textDocument/rename"
      ? this.router.providerCapability(this.host, "textDocument/prepareRename")
      : method === "textDocument/documentColor"
        ? this.router.providerCapability(this.host, "textDocument/colorPresentation")
        : undefined;
    return JSON.stringify({ generation: this.backend.capabilities().generation, registration, related });
  }

  private register(registration: TypstProviderRegistrationContract): vscode.Disposable {
    const selector: vscode.DocumentSelector = [{ language: "typst" }];
    switch (registration.descriptor.method) {
      case "textDocument/rename":
        return vscode.languages.registerRenameProvider(selector, {
          prepareRename: async (document, position, token) => {
            const capability = this.router.providerCapability(this.host, "textDocument/prepareRename");
            if (capability.kind !== "QualifiedProvider" || readOnlyTarget(document) !== "StandaloneWritable") {
              return undefined;
            }
            try {
              const result = await this.router.standaloneProvider(
                this.host,
                "textDocument/prepareRename",
                routerDocument(document),
                {
                  textDocument: { uri: document.uri.toString() },
                  position: this.client.code2ProtocolConverter.asPosition(position)
                } satisfies PrepareRenameParams,
                token
              );
              if (!result || result.value === null || token.isCancellationRequested) return undefined;
              const prepared = result.value as PrepareRenameResult;
              if ("defaultBehavior" in prepared) return undefined;
              const converted = "start" in prepared
                ? this.client.protocol2CodeConverter.asRange(prepared)
                : {
                    range: this.client.protocol2CodeConverter.asRange(prepared.range),
                    placeholder: prepared.placeholder
                  };
              return this.router.providerIdentityIsCurrent(result.identity) ? converted : undefined;
            } catch (error) {
              console.error("standalone Typst prepare rename failed", error);
              return undefined;
            }
          },
          provideRenameEdits: async (document, position, newName, token) => {
            if (readOnlyTarget(document) !== "StandaloneWritable") return undefined;
            try {
              const result = await this.router.standaloneProvider(
                this.host,
                "textDocument/rename",
                routerDocument(document),
                {
                  textDocument: { uri: document.uri.toString() },
                  position: this.client.code2ProtocolConverter.asPosition(position),
                  newName
                } satisfies RenameParams,
                token
              );
              if (!result || result.value === null || token.isCancellationRequested) return undefined;
              const normalized = normalizedVersionedWorkspaceEdit(result.value, result.identity);
              if (!normalized || !this.validateWorkspaceEdit(result, normalized, "textDocument/rename")) {
                return undefined;
              }
              const converted = await this.client.protocol2CodeConverter.asWorkspaceEdit(normalized, token);
              return !token.isCancellationRequested && this.router.providerIdentityIsCurrent(result.identity)
                ? converted
                : undefined;
            } catch (error) {
              console.error("standalone Typst rename failed", error);
              return undefined;
            }
          }
        });
      case "textDocument/formatting":
        return vscode.languages.registerDocumentFormattingEditProvider(selector, {
          provideDocumentFormattingEdits: async (document, options, token) => {
            if (readOnlyTarget(document) !== "StandaloneWritable") return undefined;
            try {
              const result = await this.router.standaloneProvider(
                this.host,
                "textDocument/formatting",
                routerDocument(document),
                {
                  textDocument: { uri: document.uri.toString() },
                  options: formattingOptions(options)
                } satisfies DocumentFormattingParams,
                token
              );
              return await this.convertFormatting(result, document, token);
            } catch (error) {
              console.error("standalone Typst formatting failed", error);
              return undefined;
            }
          }
        });
      case "textDocument/rangeFormatting":
        return vscode.languages.registerDocumentRangeFormattingEditProvider(selector, {
          provideDocumentRangeFormattingEdits: async (document, range, options, token) => {
            if (readOnlyTarget(document) !== "StandaloneWritable") return undefined;
            try {
              const result = await this.router.standaloneProvider(
                this.host,
                "textDocument/rangeFormatting",
                routerDocument(document),
                {
                  textDocument: { uri: document.uri.toString() },
                  range: this.client.code2ProtocolConverter.asRange(range),
                  options: formattingOptions(options)
                } satisfies DocumentRangeFormattingParams,
                token
              );
              return await this.convertFormatting(result, document, token);
            } catch (error) {
              console.error("standalone Typst range formatting failed", error);
              return undefined;
            }
          }
        });
      case "textDocument/documentLink": {
        const provider: vscode.DocumentLinkProvider = {
          provideDocumentLinks: async (document, token) => {
            try {
              const result = await this.router.standaloneProvider(
                this.host,
                "textDocument/documentLink",
                routerDocument(document),
                { textDocument: { uri: document.uri.toString() } } satisfies DocumentLinkParams,
                token
              );
              if (!result || result.value === null || token.isCancellationRequested) return undefined;
              const safe = this.safeItems(result, result.value, document, registration.resolveProvider);
              if (!safe || !this.router.providerIdentityIsCurrent(result.identity)) return undefined;
              return await this.client.protocol2CodeConverter.asDocumentLinks(safe as DocumentLink[], token);
            } catch (error) {
              console.error("standalone Typst document links failed", error);
              return undefined;
            }
          }
        };
        if (registration.resolveProvider) {
          provider.resolveDocumentLink = async (link, token) => {
            try {
              const result = await this.router.standaloneProviderResolve(
                this.host,
                "documentLink/resolve",
                this.client.code2ProtocolConverter.asDocumentLink(link),
                token
              );
              return await this.convertResolvedItem("textDocument/documentLink", result, link, token);
            } catch (error) {
              console.error("standalone Typst document-link resolve failed", error);
              return undefined;
            }
          };
        }
        return vscode.languages.registerDocumentLinkProvider(selector, provider);
      }
      case "textDocument/documentColor":
        return vscode.languages.registerColorProvider(selector, {
          provideDocumentColors: async (document, token) => {
            try {
              const result = await this.router.standaloneProvider(
                this.host,
                "textDocument/documentColor",
                routerDocument(document),
                { textDocument: { uri: document.uri.toString() } } satisfies DocumentColorParams,
                token
              );
              if (!result || result.value === null || token.isCancellationRequested) return undefined;
              const converted = await this.client.protocol2CodeConverter.asColorInformations(
                result.value as ColorInformation[],
                token
              );
              return this.router.providerIdentityIsCurrent(result.identity) ? converted : undefined;
            } catch (error) {
              console.error("standalone Typst document colors failed", error);
              return undefined;
            }
          },
          provideColorPresentations: async (color, context, token) => {
            try {
              const result = await this.router.standaloneProvider(
                this.host,
                "textDocument/colorPresentation",
                routerDocument(context.document),
                {
                  textDocument: { uri: context.document.uri.toString() },
                  color: { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha },
                  range: this.client.code2ProtocolConverter.asRange(context.range)
                } satisfies ColorPresentationParams,
                token
              );
              if (!result || result.value === null || token.isCancellationRequested) return undefined;
              const safe = this.safeItems(result, result.value, context.document, false);
              if (!safe || !this.router.providerIdentityIsCurrent(result.identity)) return undefined;
              return await this.client.protocol2CodeConverter.asColorPresentations(
                safe as ColorPresentation[],
                token
              );
            } catch (error) {
              console.error("standalone Typst color presentations failed", error);
              return undefined;
            }
          }
        });
      case "textDocument/codeAction": {
        const provider: vscode.CodeActionProvider = {
          provideCodeActions: async (document, range, context, token) => {
            try {
              const result = await this.router.standaloneProvider(
                this.host,
                "textDocument/codeAction",
                routerDocument(document),
                {
                  textDocument: { uri: document.uri.toString() },
                  range: this.client.code2ProtocolConverter.asRange(range),
                  context: this.client.code2ProtocolConverter.asCodeActionContextSync(context)
                } satisfies CodeActionParams,
                token
              );
              if (!result || result.value === null || token.isCancellationRequested) return undefined;
              const safe = this.safeItems(result, result.value, document, registration.resolveProvider);
              if (!safe || !this.router.providerIdentityIsCurrent(result.identity)) return undefined;
              return await this.client.protocol2CodeConverter.asCodeActionResult(safe as CodeAction[], token);
            } catch (error) {
              console.error("standalone Typst code actions failed", error);
              return undefined;
            }
          }
        };
        if (registration.resolveProvider) {
          provider.resolveCodeAction = async (action, token) => {
            try {
              const result = await this.router.standaloneProviderResolve(
                this.host,
                "codeAction/resolve",
                this.client.code2ProtocolConverter.asCodeActionSync(action),
                token
              );
              return await this.convertResolvedItem("textDocument/codeAction", result, action, token);
            } catch (error) {
              console.error("standalone Typst code-action resolve failed", error);
              return undefined;
            }
          };
        }
        const convertedKinds = this.client.protocol2CodeConverter.asCodeActionKinds(
          [...registration.codeActionKinds]
        );
        const kinds = convertedKinds === undefined ? undefined : { providedCodeActionKinds: convertedKinds };
        return vscode.languages.registerCodeActionsProvider(selector, provider, kinds);
      }
      case "textDocument/inlayHint": {
        const provider: vscode.InlayHintsProvider = {
          provideInlayHints: async (document, range, token) => {
            try {
              const result = await this.router.standaloneProvider(
                this.host,
                "textDocument/inlayHint",
                routerDocument(document),
                {
                  textDocument: { uri: document.uri.toString() },
                  range: this.client.code2ProtocolConverter.asRange(range)
                } satisfies InlayHintParams,
                token
              );
              if (!result || result.value === null || token.isCancellationRequested) return undefined;
              const safe = this.safeItems(result, result.value, document, registration.resolveProvider);
              if (!safe || !this.router.providerIdentityIsCurrent(result.identity)) return undefined;
              return await this.client.protocol2CodeConverter.asInlayHints(safe as InlayHint[], token);
            } catch (error) {
              console.error("standalone Typst inlay hints failed", error);
              return undefined;
            }
          }
        };
        if (registration.resolveProvider) {
          provider.resolveInlayHint = async (hint, token) => {
            try {
              const result = await this.router.standaloneProviderResolve(
                this.host,
                "inlayHint/resolve",
                this.client.code2ProtocolConverter.asInlayHint(hint),
                token
              );
              return await this.convertResolvedItem("textDocument/inlayHint", result, hint, token);
            } catch (error) {
              console.error("standalone Typst inlay-hint resolve failed", error);
              return undefined;
            }
          };
        }
        return vscode.languages.registerInlayHintsProvider(selector, provider);
      }
      case "textDocument/codeLens": {
        const provider: vscode.CodeLensProvider = {
          provideCodeLenses: async (document, token) => {
            try {
              const result = await this.router.standaloneProvider(
                this.host,
                "textDocument/codeLens",
                routerDocument(document),
                { textDocument: { uri: document.uri.toString() } } satisfies CodeLensParams,
                token
              );
              if (!result || result.value === null || token.isCancellationRequested) return undefined;
              const safe = this.safeItems(result, result.value, document, registration.resolveProvider);
              if (!safe || !this.router.providerIdentityIsCurrent(result.identity)) return undefined;
              return await this.client.protocol2CodeConverter.asCodeLenses(safe as CodeLens[], token);
            } catch (error) {
              console.error("standalone Typst code lenses failed", error);
              return undefined;
            }
          }
        };
        if (registration.resolveProvider) {
          provider.resolveCodeLens = async (lens, token) => {
            try {
              const result = await this.router.standaloneProviderResolve(
                this.host,
                "codeLens/resolve",
                this.client.code2ProtocolConverter.asCodeLens(lens),
                token
              );
              return await this.convertResolvedItem("textDocument/codeLens", result, lens, token);
            } catch (error) {
              console.error("standalone Typst code-lens resolve failed", error);
              return undefined;
            }
          };
        }
        return vscode.languages.registerCodeLensProvider(selector, provider);
      }
      default:
        throw new Error(`Unsupported rich Typst provider: ${registration.descriptor.method}`);
    }
  }

  private async convertFormatting(
    result: RoutedStandaloneTypstProviderResult<"textDocument/formatting" | "textDocument/rangeFormatting"> | undefined,
    document: vscode.TextDocument,
    token: vscode.CancellationToken
  ): Promise<vscode.TextEdit[] | undefined> {
    if (!result || result.value === null || token.isCancellationRequested) return undefined;
    const edits = result.value as TextEdit[];
    const validation = this.router.validateProviderPayload(this.host, {
      method: result.method,
      request: result.identity,
      current: this.router.providerIdentityIsCurrent(result.identity) ? result.identity : undefined,
      targetClass: readOnlyTarget(document),
      nestedEdits: edits.map((edit) => ({
        uri: result.identity.sourceStaleToken.hostUri,
        version: result.identity.sourceStaleToken.documentVersion,
        range: edit.range,
        newText: edit.newText
      })),
      nestedCommands: [],
      nestedUris: [],
      allowedCommands: this.allowedCommands()
    });
    if (validation.kind !== "Validated") return undefined;
    const converted = await this.client.protocol2CodeConverter.asTextEdits(edits, token);
    return !token.isCancellationRequested && this.router.providerIdentityIsCurrent(result.identity)
      ? converted
      : undefined;
  }

  private validateWorkspaceEdit(
    result: RoutedStandaloneTypstProviderResult<"textDocument/rename">,
    edit: WorkspaceEdit,
    method: "textDocument/rename"
  ): boolean {
    const changes = edit.documentChanges as TextDocumentEdit[];
    const nestedEdits = changes.flatMap((change) => change.edits.map((item) => ({
      uri: change.textDocument.uri,
      version: change.textDocument.version,
      range: item.range,
      newText: item.newText
    })));
    return this.router.validateProviderPayload(this.host, {
      method,
      request: result.identity,
      current: this.router.providerIdentityIsCurrent(result.identity) ? result.identity : undefined,
      targetClass: "StandaloneWritable",
      nestedEdits,
      nestedCommands: [],
      nestedUris: [],
      allowedCommands: this.allowedCommands()
    }).kind === "Validated";
  }

  private safeItems<Method extends TypstProviderMethod>(
    result: RoutedStandaloneTypstProviderResult<Method>,
    items: readonly unknown[],
    document: vscode.TextDocument,
    bindResolve: boolean
  ): unknown[] | undefined {
    const safe: unknown[] = [];
    for (const item of items) {
      const validation = validateTypstProviderItemPayload({
        method: result.method,
        capability: result.capability,
        request: result.identity,
        current: this.router.providerIdentityIsCurrent(result.identity) ? result.identity : undefined,
        targetClass: readOnlyTarget(document),
        allowedCommands: this.allowedCommands(),
        item
      });
      if (validation.kind === "StaleProjection" || validation.kind === "CapabilityUnavailable") return undefined;
      if (validation.kind !== "Validated") {
        if (result.capability.descriptor.partialResults === "none") return undefined;
        continue;
      }
      safe.push(bindResolve
        ? this.router.bindProviderResolveItem(result.method, validation.value, result.identity)
        : validation.value);
    }
    return safe;
  }

  private async convertResolvedItem<Method extends
    | "textDocument/documentLink"
    | "textDocument/codeAction"
    | "textDocument/inlayHint"
    | "textDocument/codeLens"
  >(
    requestMethod: Method,
    result: RoutedStandaloneTypstProviderResult<ResolveMethod<Method>> | undefined,
    fallback: ResolvedCodeValue<Method>,
    token: vscode.CancellationToken
  ): Promise<ResolvedCodeValue<Method> | undefined> {
    if (!result || token.isCancellationRequested) return undefined;
    const rebound = this.router.bindProviderResolveItem(requestMethod, result.value, result.identity);
    const validation: TypstProviderItemPayloadValidationResult = validateTypstProviderItemPayload({
      method: result.method,
      capability: result.capability,
      request: result.identity,
      current: this.router.providerIdentityIsCurrent(result.identity) ? result.identity : undefined,
      targetClass: targetClassForUri(result.identity.sourceStaleToken.hostUri),
      allowedCommands: this.allowedCommands(),
      item: rebound
    });
    if (validation.kind !== "Validated") return undefined;
    let converted: vscode.DocumentLink | vscode.CodeAction | vscode.InlayHint | vscode.CodeLens | undefined;
    if (requestMethod === "textDocument/documentLink") {
      converted = this.client.protocol2CodeConverter.asDocumentLink(validation.value as DocumentLink);
    } else if (requestMethod === "textDocument/codeAction") {
      converted = await this.client.protocol2CodeConverter.asCodeAction(validation.value as CodeAction, token);
    } else if (requestMethod === "textDocument/inlayHint") {
      converted = await this.client.protocol2CodeConverter.asInlayHint(validation.value as InlayHint, token);
    } else {
      converted = this.client.protocol2CodeConverter.asCodeLens(validation.value as CodeLens);
    }
    if (!converted || token.isCancellationRequested || !this.router.providerIdentityIsCurrent(result.identity)) {
      return undefined;
    }
    return converted as ResolvedCodeValue<Method> ?? fallback;
  }

  private allowedCommands(): readonly string[] {
    const descriptor = this.backend.capabilities().get("workspace/executeCommand");
    if (!descriptor) return [];
    const commands = new Set<string>();
    for (const options of [
      descriptor.initializeOptions,
      ...descriptor.dynamicRegistrations.map((registration) => registration.registerOptions)
    ]) {
      if (!options || typeof options !== "object" || !("commands" in options) || !Array.isArray(options.commands)) {
        continue;
      }
      for (const command of options.commands) if (typeof command === "string") commands.add(command);
    }
    return [...commands];
  }
}

type ResolveMethod<Method extends TypstProviderMethod> =
  Method extends "textDocument/documentLink" ? "documentLink/resolve"
    : Method extends "textDocument/codeAction" ? "codeAction/resolve"
      : Method extends "textDocument/inlayHint" ? "inlayHint/resolve"
        : Method extends "textDocument/codeLens" ? "codeLens/resolve"
          : never;

type ResolvedCodeValue<Method extends TypstProviderMethod> =
  Method extends "textDocument/documentLink" ? vscode.DocumentLink
    : Method extends "textDocument/codeAction" ? vscode.CodeAction
      : Method extends "textDocument/inlayHint" ? vscode.InlayHint
        : Method extends "textDocument/codeLens" ? vscode.CodeLens
          : never;

function normalizedVersionedWorkspaceEdit(
  value: WorkspaceEdit,
  identity: TinymistRequestIdentity
): WorkspaceEdit | undefined {
  const uri = canonicalTypstUri(identity.sourceStaleToken.hostUri);
  const version = identity.sourceStaleToken.documentVersion;
  const edits: TextEdit[] = [];
  if (value.changes !== undefined) {
    const targets = Object.keys(value.changes);
    if (targets.length !== 1 || canonicalTypstUri(targets[0]) !== uri) return undefined;
    edits.push(...(value.changes[targets[0]] ?? []));
  }
  if (value.documentChanges !== undefined) {
    for (const change of value.documentChanges) {
      if (!("textDocument" in change)
        || canonicalTypstUri(change.textDocument.uri) !== uri
        || change.textDocument.version !== version) {
        return undefined;
      }
      edits.push(...change.edits);
    }
  }
  if (edits.length === 0) return undefined;
  return {
    documentChanges: [{
      textDocument: { uri, version },
      edits
    }]
  };
}

function formattingOptions(options: vscode.FormattingOptions): DocumentFormattingParams["options"] {
  return {
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
    ...(typeof options.trimTrailingWhitespace === "boolean"
      ? { trimTrailingWhitespace: options.trimTrailingWhitespace }
      : {}),
    ...(typeof options.insertFinalNewline === "boolean"
      ? { insertFinalNewline: options.insertFinalNewline }
      : {}),
    ...(typeof options.trimFinalNewlines === "boolean"
      ? { trimFinalNewlines: options.trimFinalNewlines }
      : {})
  };
}

function routerDocument(document: vscode.TextDocument): TypstRouterDocument {
  return {
    languageId: document.languageId,
    uri: document.uri.toString(),
    version: document.version,
    text: document.getText()
  };
}

function readOnlyTarget(document: vscode.TextDocument): TypstProviderPayloadTargetClass {
  return targetClassForUri(document.uri.toString());
}

function targetClassForUri(uri: string): TypstProviderPayloadTargetClass {
  const scheme = uri.slice(0, uri.indexOf(":"));
  if (scheme === "mmt-package") return "PackageFile";
  if (scheme === "mmt-projection" || scheme === "mmt") return "GeneratedProjection";
  if (scheme === "file" || scheme === "untitled" || scheme === "mmtfs") return "StandaloneWritable";
  return "UnknownOrStale";
}
