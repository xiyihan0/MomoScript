import type {
  CodeAction,
  CodeActionParams,
  CodeLens,
  CodeLensParams,
  ColorInformation,
  ColorPresentation,
  ColorPresentationParams,
  Command,
  Definition,
  DefinitionParams,
  DocumentColorParams,
  DocumentFormattingParams,
  DocumentHighlight,
  DocumentHighlightParams,
  DocumentLink,
  DocumentLinkParams,
  DocumentRangeFormattingParams,
  DocumentSymbol,
  DocumentSymbolParams,
  InlayHint,
  InlayHintParams,
  Location,
  PrepareRenameParams,
  PrepareRenameResult,
  ReferenceParams,
  RenameParams,
  SelectionRange,
  SelectionRangeParams,
  SymbolInformation,
  TextEdit,
  TypeDefinitionParams,
  ImplementationParams,
  WorkspaceEdit,
  WorkspaceSymbol,
  WorkspaceSymbolParams
} from "vscode-languageserver-protocol";

import type {
  TinymistCapabilityDescriptor,
  TinymistCapabilityView
} from "./tinymistCapabilities";
import type {
  TinymistRequestDefinition,
  TinymistRequestIdentity
} from "./tinymistRequestDispatcher";
import {
  LineIndex,
  PositionConversionError,
  convertBackendWireRange,
  validateBackendWireRange,
  type PositionEncoding,
  type WireRange
} from "./typstPosition";

export const TYPST_PROVIDER_METHODS = Object.freeze([
  "textDocument/definition",
  "textDocument/typeDefinition",
  "textDocument/implementation",
  "textDocument/references",
  "textDocument/prepareRename",
  "textDocument/rename",
  "textDocument/formatting",
  "textDocument/rangeFormatting",
  "textDocument/documentSymbol",
  "workspace/symbol",
  "workspaceSymbol/resolve",
  "textDocument/documentHighlight",
  "textDocument/selectionRange",
  "textDocument/documentLink",
  "documentLink/resolve",
  "textDocument/documentColor",
  "textDocument/colorPresentation",
  "textDocument/codeAction",
  "codeAction/resolve",
  "textDocument/inlayHint",
  "inlayHint/resolve",
  "textDocument/codeLens",
  "codeLens/resolve"
] as const);

export type TypstProviderMethod = typeof TYPST_PROVIDER_METHODS[number];
export type TypstProviderHost = "native" | "web";
export type TypstProviderQualification = "core-required" | "host-optional" | "deferred" | "unavailable";
export type TypstProviderFamily =
  | "location"
  | "locations"
  | "workspace-edit"
  | "formatting"
  | "symbols"
  | "workspace-symbols"
  | "highlights"
  | "selection-ranges"
  | "links"
  | "colors"
  | "color-presentations"
  | "code-actions"
  | "inlay-hints"
  | "code-lenses";
export type TypstPartialResultPolicy = "none" | "safe-item-list" | "nested-prefix";

export interface TypstProviderRequests {
  "textDocument/definition": TinymistRequestDefinition<DefinitionParams, Definition | null>;
  "textDocument/typeDefinition": TinymistRequestDefinition<TypeDefinitionParams, Definition | null>;
  "textDocument/implementation": TinymistRequestDefinition<ImplementationParams, Definition | null>;
  "textDocument/references": TinymistRequestDefinition<ReferenceParams, Location[] | null>;
  "textDocument/prepareRename": TinymistRequestDefinition<PrepareRenameParams, PrepareRenameResult | null>;
  "textDocument/rename": TinymistRequestDefinition<RenameParams, WorkspaceEdit | null>;
  "textDocument/formatting": TinymistRequestDefinition<DocumentFormattingParams, TextEdit[] | null>;
  "textDocument/rangeFormatting": TinymistRequestDefinition<DocumentRangeFormattingParams, TextEdit[] | null>;
  "textDocument/documentSymbol": TinymistRequestDefinition<DocumentSymbolParams, (DocumentSymbol | SymbolInformation)[] | null>;
  "workspace/symbol": TinymistRequestDefinition<WorkspaceSymbolParams, (WorkspaceSymbol | SymbolInformation)[] | null>;
  "workspaceSymbol/resolve": TinymistRequestDefinition<WorkspaceSymbol, WorkspaceSymbol>;
  "textDocument/documentHighlight": TinymistRequestDefinition<DocumentHighlightParams, DocumentHighlight[] | null>;
  "textDocument/selectionRange": TinymistRequestDefinition<SelectionRangeParams, SelectionRange[] | null>;
  "textDocument/documentLink": TinymistRequestDefinition<DocumentLinkParams, DocumentLink[] | null>;
  "documentLink/resolve": TinymistRequestDefinition<DocumentLink, DocumentLink>;
  "textDocument/documentColor": TinymistRequestDefinition<DocumentColorParams, ColorInformation[] | null>;
  "textDocument/colorPresentation": TinymistRequestDefinition<ColorPresentationParams, ColorPresentation[] | null>;
  "textDocument/codeAction": TinymistRequestDefinition<CodeActionParams, (Command | CodeAction)[] | null>;
  "codeAction/resolve": TinymistRequestDefinition<CodeAction, CodeAction>;
  "textDocument/inlayHint": TinymistRequestDefinition<InlayHintParams, InlayHint[] | null>;
  "inlayHint/resolve": TinymistRequestDefinition<InlayHint, InlayHint>;
  "textDocument/codeLens": TinymistRequestDefinition<CodeLensParams, CodeLens[] | null>;
  "codeLens/resolve": TinymistRequestDefinition<CodeLens, CodeLens>;
}

export interface TypstProviderMethodDescriptor<Method extends TypstProviderMethod = TypstProviderMethod> {
  readonly method: Method;
  readonly capabilityKey: TypstProviderCapabilityKey;
  readonly family: TypstProviderFamily;
  readonly cancellation: "required";
  readonly partialResults: TypstPartialResultPolicy;
  readonly resolveMethod?: TypstProviderMethod;
  readonly requestMethod?: TypstProviderMethod;
}

type TypstProviderCapabilityKey =
  | "definitionProvider"
  | "typeDefinitionProvider"
  | "implementationProvider"
  | "referencesProvider"
  | "renameProvider"
  | "documentFormattingProvider"
  | "documentRangeFormattingProvider"
  | "documentSymbolProvider"
  | "workspaceSymbolProvider"
  | "documentHighlightProvider"
  | "selectionRangeProvider"
  | "documentLinkProvider"
  | "colorProvider"
  | "codeActionProvider"
  | "inlayHintProvider"
  | "codeLensProvider";

interface FixedProviderQualification {
  readonly classification: TypstProviderQualification;
  readonly native: boolean;
  readonly web: boolean;
  readonly sameOptions: boolean;
  readonly reason: string;
}

export const FIXED_TINYMIST_PROVIDER_ARTIFACTS = Object.freeze({
  native: Object.freeze({
    backendVersion: "0.15.2",
    digest: "b96ce119a2ef789978350c26ccc89113435cf010e8f1f8eb2c883fb2ec631611"
  }),
  web: Object.freeze({
    backendVersion: "0.15.2",
    digest: "c9ff9b1d8197656e89e2ee4cc3fc74923ddfecaec3fbc4022f82d150fa995db4"
  })
});

const ADVERTISED_UNQUALIFIED = Object.freeze({
  classification: "deferred" as const,
  native: true,
  web: true,
  sameOptions: true,
  reason: "advertised by both fixed artifacts; method transcript not yet qualified"
});
const CORE_NAVIGATION = Object.freeze({
  classification: "core-required" as const,
  native: true,
  web: true,
  sameOptions: true,
  reason: "compatible advertisement plus checked native/Web navigation transcript"
});
const P0_UNAVAILABLE = Object.freeze({
  classification: "unavailable" as const,
  native: true,
  web: true,
  sameOptions: true,
  reason: "P0 is advertised but lacks shared positive/negative method transcripts"
});
const NOT_ADVERTISED = Object.freeze({
  classification: "unavailable" as const,
  native: false,
  web: false,
  sameOptions: true,
  reason: "not advertised by either fixed artifact"
});

export const FIXED_TINYMIST_PROVIDER_QUALIFICATION: Readonly<Record<TypstProviderCapabilityKey, FixedProviderQualification>> = Object.freeze({
  definitionProvider: CORE_NAVIGATION,
  typeDefinitionProvider: NOT_ADVERTISED,
  implementationProvider: NOT_ADVERTISED,
  referencesProvider: CORE_NAVIGATION,
  renameProvider: P0_UNAVAILABLE,
  documentFormattingProvider: P0_UNAVAILABLE,
  documentRangeFormattingProvider: P0_UNAVAILABLE,
  documentSymbolProvider: CORE_NAVIGATION,
  workspaceSymbolProvider: CORE_NAVIGATION,
  documentHighlightProvider: CORE_NAVIGATION,
  selectionRangeProvider: ADVERTISED_UNQUALIFIED,
  documentLinkProvider: P0_UNAVAILABLE,
  colorProvider: ADVERTISED_UNQUALIFIED,
  codeActionProvider: ADVERTISED_UNQUALIFIED,
  inlayHintProvider: ADVERTISED_UNQUALIFIED,
  codeLensProvider: ADVERTISED_UNQUALIFIED
});

const descriptors = defineDescriptors([
  descriptor("textDocument/definition", "definitionProvider", "location", "safe-item-list"),
  descriptor("textDocument/typeDefinition", "typeDefinitionProvider", "location", "safe-item-list"),
  descriptor("textDocument/implementation", "implementationProvider", "location", "safe-item-list"),
  descriptor("textDocument/references", "referencesProvider", "locations", "safe-item-list"),
  descriptor("textDocument/prepareRename", "renameProvider", "workspace-edit", "none"),
  descriptor("textDocument/rename", "renameProvider", "workspace-edit", "none"),
  descriptor("textDocument/formatting", "documentFormattingProvider", "formatting", "none"),
  descriptor("textDocument/rangeFormatting", "documentRangeFormattingProvider", "formatting", "none"),
  descriptor("textDocument/documentSymbol", "documentSymbolProvider", "symbols", "safe-item-list"),
  descriptor("workspace/symbol", "workspaceSymbolProvider", "workspace-symbols", "safe-item-list", "workspaceSymbol/resolve"),
  resolveDescriptor("workspaceSymbol/resolve", "workspaceSymbolProvider", "workspace-symbols", "workspace/symbol"),
  descriptor("textDocument/documentHighlight", "documentHighlightProvider", "highlights", "safe-item-list"),
  descriptor("textDocument/selectionRange", "selectionRangeProvider", "selection-ranges", "nested-prefix"),
  descriptor("textDocument/documentLink", "documentLinkProvider", "links", "safe-item-list", "documentLink/resolve"),
  resolveDescriptor("documentLink/resolve", "documentLinkProvider", "links", "textDocument/documentLink"),
  descriptor("textDocument/documentColor", "colorProvider", "colors", "safe-item-list"),
  descriptor("textDocument/colorPresentation", "colorProvider", "color-presentations", "none"),
  descriptor("textDocument/codeAction", "codeActionProvider", "code-actions", "none", "codeAction/resolve"),
  resolveDescriptor("codeAction/resolve", "codeActionProvider", "code-actions", "textDocument/codeAction"),
  descriptor("textDocument/inlayHint", "inlayHintProvider", "inlay-hints", "safe-item-list", "inlayHint/resolve"),
  resolveDescriptor("inlayHint/resolve", "inlayHintProvider", "inlay-hints", "textDocument/inlayHint"),
  descriptor("textDocument/codeLens", "codeLensProvider", "code-lenses", "safe-item-list", "codeLens/resolve"),
  resolveDescriptor("codeLens/resolve", "codeLensProvider", "code-lenses", "textDocument/codeLens")
]);

export const TYPST_PROVIDER_DESCRIPTORS: Readonly<Record<TypstProviderMethod, TypstProviderMethodDescriptor>> = descriptors;

export interface TypstProviderIdentityContract {
  readonly backendGeneration: true;
  readonly logicalSource: true;
  readonly sourceContent: true;
  readonly sourceStaleToken: true;
  readonly projectSnapshot: true;
  readonly projectionKey: true;
  readonly requestSequence: true;
}

export interface TypstProviderRegistrationContract {
  readonly kind: "QualifiedProvider";
  readonly descriptor: TypstProviderMethodDescriptor;
  readonly runtime: TinymistCapabilityDescriptor;
  readonly host: TypstProviderHost;
  readonly qualification: "core-required" | "host-optional";
  readonly resolveProvider: boolean;
  readonly codeActionKinds: readonly string[];
  readonly identity: TypstProviderIdentityContract;
}

export interface TypstProviderUnavailableContract {
  readonly kind: "CapabilityUnavailable";
  readonly method: TypstProviderMethod;
  readonly host: TypstProviderHost;
  readonly backendGeneration: number;
  readonly classification: TypstProviderQualification;
  readonly reason: string;
}

export type TypstProviderCapabilityContract = TypstProviderRegistrationContract | TypstProviderUnavailableContract;

const PROVIDER_IDENTITY_CONTRACT: TypstProviderIdentityContract = Object.freeze({
  backendGeneration: true,
  logicalSource: true,
  sourceContent: true,
  sourceStaleToken: true,
  projectSnapshot: true,
  projectionKey: true,
  requestSequence: true
});

export class TypstProviderQualificationRegistry {
  constructor(
    private readonly runtime: TinymistCapabilityView,
    private readonly host: TypstProviderHost,
    private readonly qualification: Readonly<Record<TypstProviderCapabilityKey, FixedProviderQualification>> = FIXED_TINYMIST_PROVIDER_QUALIFICATION
  ) {}

  capability(method: TypstProviderMethod): TypstProviderCapabilityContract {
    const provider = descriptors[method];
    const evidence = this.qualification[provider.capabilityKey];
    const runtime = this.runtime.get(method);
    const eligible = evidence.classification === "core-required"
      || (evidence.classification === "host-optional" && evidence[this.host]);
    if (!eligible || !runtime) {
      return Object.freeze({
        kind: "CapabilityUnavailable" as const,
        method,
        host: this.host,
        backendGeneration: this.runtime.generation,
        classification: evidence.classification,
        reason: !eligible
          ? evidence.reason
          : `${method} is not advertised by the active ${this.host} backend generation`
      });
    }
    const resolveProvider = provider.resolveMethod !== undefined && this.runtime.has(provider.resolveMethod);
    return Object.freeze({
      kind: "QualifiedProvider" as const,
      descriptor: provider,
      runtime,
      host: this.host,
      qualification: evidence.classification,
      resolveProvider,
      codeActionKinds: Object.freeze(optionStrings(runtime, "codeActionKinds")),
      identity: PROVIDER_IDENTITY_CONTRACT
    });
  }

  registrations(): readonly TypstProviderRegistrationContract[] {
    const registrations: TypstProviderRegistrationContract[] = [];
    for (const method of TYPST_PROVIDER_METHODS) {
      if (descriptors[method].requestMethod !== undefined) continue;
      const capability = this.capability(method);
      if (capability.kind === "QualifiedProvider") registrations.push(capability);
    }
    return Object.freeze(registrations);
  }
}

export interface TypstProviderPositionContext {
  readonly sourceUri: string;
  readonly sourceIndex: LineIndex;
  readonly encoding: PositionEncoding;
  readonly retainedIndex?: (uri: string) => LineIndex | undefined;
}

/** Validates all position-bearing fields owned by one provider method before publication. */
export function validateTypstProviderPositions<T>(
  method: TypstProviderMethod,
  value: T,
  context: TypstProviderPositionContext
): T {
  if (value == null) return value;
  const family = descriptors[method].family;
  if (family === "location") validateDefinition(value, context);
  else if (family === "locations") validateLocationList(value, context);
  else if (family === "workspace-edit") validateRenamePayload(method, value, context);
  else if (family === "formatting") validateTextEdits(value, context.sourceUri, context);
  else if (family === "symbols") validateDocumentSymbols(value, context);
  else if (family === "workspace-symbols") validateWorkspaceSymbols(value, context);
  else if (family === "highlights") validateRanges(value, context.sourceUri, context);
  else if (family === "selection-ranges") validateSelectionRanges(value, context);
  else if (family === "links") validateLinks(value, context);
  else if (family === "colors") validateRanges(value, context.sourceUri, context);
  else if (family === "color-presentations") validateColorPresentations(value, context);
  else if (family === "code-actions") validateCodeActions(value, context);
  else if (family === "inlay-hints") validateInlayHints(value, context);
  else validateCodeLenses(value, context);
  return value;
}

export type TypstNavigationProviderMethod =
  | "textDocument/definition"
  | "textDocument/typeDefinition"
  | "textDocument/implementation"
  | "textDocument/references"
  | "textDocument/documentSymbol"
  | "workspace/symbol"
  | "workspaceSymbol/resolve"
  | "textDocument/documentHighlight"
  | "textDocument/selectionRange";

/**
 * Converts every range carried by a read-only navigation response through the
 * exact retained file bytes captured for the request. Unknown target URIs are
 * rejected instead of being published with an ambiguous coordinate domain.
 */
export function convertTypstNavigationProviderPositions<T>(
  method: TypstNavigationProviderMethod,
  value: T,
  context: TypstProviderPositionContext,
  targetEncoding: PositionEncoding = "utf-16"
): T {
  validateTypstProviderPositions(method, value, context);
  if (value == null) return value;
  if (method === "textDocument/definition"
    || method === "textDocument/typeDefinition"
    || method === "textDocument/implementation") {
    const converted = Array.isArray(value)
      ? value.map((item) => convertNavigationLocationOrLink(item, context, targetEncoding))
      : convertNavigationLocationOrLink(value, context, targetEncoding);
    return converted as T;
  }
  if (method === "textDocument/references") {
    return requireArray(value).map((item) => convertNavigationLocation(item, context, targetEncoding)) as T;
  }
  if (method === "textDocument/documentSymbol") {
    return convertNavigationDocumentSymbols(value, context, targetEncoding) as T;
  }
  if (method === "workspace/symbol" || method === "workspaceSymbol/resolve") {
    const values = Array.isArray(value) ? value : [value];
    const converted = values.map((item) => convertNavigationWorkspaceSymbol(item, context, targetEncoding));
    return (Array.isArray(value) ? converted : converted[0]) as T;
  }
  if (method === "textDocument/documentHighlight") {
    return requireArray(value).map((item) => {
      const record = requireRecord(item);
      return { ...record, range: convertNavigationRange(record.range, context.sourceUri, context, targetEncoding) };
    }) as T;
  }
  return requireArray(value).map((item) => convertNavigationSelectionRange(item, context, targetEncoding)) as T;
}

function convertNavigationLocationOrLink(
  value: unknown,
  context: TypstProviderPositionContext,
  targetEncoding: PositionEncoding
): Record<string, unknown> {
  const item = requireRecord(value);
  if (item.uri !== undefined) return convertNavigationLocation(item, context, targetEncoding);
  const targetUri = requireString(item.targetUri);
  return {
    ...item,
    targetUri,
    targetRange: convertNavigationRange(item.targetRange, targetUri, context, targetEncoding),
    targetSelectionRange: convertNavigationRange(item.targetSelectionRange, targetUri, context, targetEncoding),
    ...(item.originSelectionRange === undefined ? {} : {
      originSelectionRange: convertNavigationRange(item.originSelectionRange, context.sourceUri, context, targetEncoding)
    })
  };
}

function convertNavigationLocation(
  value: unknown,
  context: TypstProviderPositionContext,
  targetEncoding: PositionEncoding
): Record<string, unknown> {
  const item = requireRecord(value);
  const uri = requireString(item.uri);
  return { ...item, uri, range: convertNavigationRange(item.range, uri, context, targetEncoding) };
}

function convertNavigationDocumentSymbols(
  value: unknown,
  context: TypstProviderPositionContext,
  targetEncoding: PositionEncoding
): readonly Record<string, unknown>[] {
  return requireArray(value).map((symbolValue) => {
    const symbol = requireRecord(symbolValue);
    if (symbol.location !== undefined) {
      return { ...symbol, location: convertNavigationLocation(symbol.location, context, targetEncoding) };
    }
    return {
      ...symbol,
      range: convertNavigationRange(symbol.range, context.sourceUri, context, targetEncoding),
      selectionRange: convertNavigationRange(symbol.selectionRange, context.sourceUri, context, targetEncoding),
      ...(symbol.children === undefined ? {} : {
        children: convertNavigationDocumentSymbols(symbol.children, context, targetEncoding)
      })
    };
  });
}

function convertNavigationWorkspaceSymbol(
  value: unknown,
  context: TypstProviderPositionContext,
  targetEncoding: PositionEncoding
): Record<string, unknown> {
  const symbol = requireRecord(value);
  const location = requireRecord(symbol.location);
  const uri = requireString(location.uri);
  return {
    ...symbol,
    location: {
      ...location,
      uri,
      ...(location.range === undefined ? {} : {
        range: convertNavigationRange(location.range, uri, context, targetEncoding)
      })
    }
  };
}

function convertNavigationSelectionRange(
  value: unknown,
  context: TypstProviderPositionContext,
  targetEncoding: PositionEncoding
): Record<string, unknown> {
  const item = requireRecord(value);
  return {
    ...item,
    range: convertNavigationRange(item.range, context.sourceUri, context, targetEncoding),
    ...(item.parent === undefined ? {} : {
      parent: convertNavigationSelectionRange(item.parent, context, targetEncoding)
    })
  };
}

function convertNavigationRange(
  value: unknown,
  uri: string,
  context: TypstProviderPositionContext,
  targetEncoding: PositionEncoding
): WireRange {
  const index = uri === context.sourceUri ? context.sourceIndex : context.retainedIndex?.(uri);
  if (!index) throw new PositionConversionError("AbsentGeneration");
  const range = requireRecord(value);
  return convertBackendWireRange({
    start: wirePosition(range.start),
    end: wirePosition(range.end)
  }, index, context.encoding, targetEncoding);
}

export interface TypstProviderResolveMetadata {
  readonly schemaVersion: 1;
  readonly requestMethod: TypstProviderMethod;
  readonly resolveMethod: TypstProviderMethod;
  readonly identity: TinymistRequestIdentity;
  readonly backendData: unknown;
}

const RESOLVE_DATA_FIELD = "$mmtTypstProvider";

/** Adds host resolve identity without losing the opaque backend `data` field. */
export function bindTypstProviderResolveMetadata<T>(
  requestMethod: TypstProviderMethod,
  item: T,
  identity: TinymistRequestIdentity
): T {
  const provider = descriptors[requestMethod];
  if (!provider.resolveMethod) throw new Error(`${requestMethod} has no resolve method`);
  const record = requireRecord(item);
  const metadata: TypstProviderResolveMetadata = Object.freeze({
    schemaVersion: 1,
    requestMethod,
    resolveMethod: provider.resolveMethod,
    identity: freezeIdentity(identity),
    backendData: record.data
  });
  return { ...record, data: { [RESOLVE_DATA_FIELD]: metadata } } as T;
}

export function readTypstProviderResolveMetadata(
  resolveMethod: TypstProviderMethod,
  item: unknown
): TypstProviderResolveMetadata | undefined {
  if (!isRecord(item) || !isRecord(item.data)) return undefined;
  const metadata = item.data[RESOLVE_DATA_FIELD];
  if (!isRecord(metadata)
    || metadata.schemaVersion !== 1
    || metadata.resolveMethod !== resolveMethod
    || typeof metadata.requestMethod !== "string") return undefined;
  const requestMethod = metadata.requestMethod as TypstProviderMethod;
  const identity = parseRequestIdentity(metadata.identity);
  if (!identity || descriptors[requestMethod]?.resolveMethod !== resolveMethod) return undefined;
  return {
    schemaVersion: 1,
    requestMethod,
    resolveMethod,
    identity,
    backendData: metadata.backendData
  };
}

/** Restores the exact opaque backend item before issuing its resolve request. */
export function unwrapTypstProviderResolveItem<T>(item: T, metadata: TypstProviderResolveMetadata): T {
  return { ...requireRecord(item), data: metadata.backendData } as T;
}

export function typstProviderResolveIdentityIsCurrent(
  metadata: TypstProviderResolveMetadata,
  current: TinymistRequestIdentity | undefined
): boolean {
  return current !== undefined && identitiesEqual(metadata.identity, current);
}

function descriptor<Method extends TypstProviderMethod>(
  method: Method,
  capabilityKey: TypstProviderCapabilityKey,
  family: TypstProviderFamily,
  partialResults: TypstPartialResultPolicy,
  resolveMethod?: TypstProviderMethod
): TypstProviderMethodDescriptor<Method> {
  return Object.freeze({ method, capabilityKey, family, cancellation: "required", partialResults, ...(resolveMethod ? { resolveMethod } : {}) });
}

function resolveDescriptor<Method extends TypstProviderMethod>(
  method: Method,
  capabilityKey: TypstProviderCapabilityKey,
  family: TypstProviderFamily,
  requestMethod: TypstProviderMethod
): TypstProviderMethodDescriptor<Method> {
  return Object.freeze({ method, capabilityKey, family, cancellation: "required", partialResults: "none", requestMethod });
}

function defineDescriptors(
  values: readonly TypstProviderMethodDescriptor[]
): Readonly<Record<TypstProviderMethod, TypstProviderMethodDescriptor>> {
  const entries = values.map((value) => [value.method, value] as const);
  if (entries.length !== TYPST_PROVIDER_METHODS.length) throw new Error("Incomplete Typst provider descriptor table");
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<TypstProviderMethod, TypstProviderMethodDescriptor>>;
}

function optionStrings(descriptor: TinymistCapabilityDescriptor, field: string): string[] {
  const values = new Set<string>();
  for (const option of [descriptor.initializeOptions, ...descriptor.dynamicRegistrations.map((item) => item.registerOptions)]) {
    if (!isRecord(option) || !Array.isArray(option[field])) continue;
    for (const value of option[field]) if (typeof value === "string") values.add(value);
  }
  return [...values];
}

function validateDefinition(value: unknown, context: TypstProviderPositionContext): void {
  if (Array.isArray(value)) {
    for (const item of value) validateLocationOrLink(item, context);
  } else {
    validateLocationOrLink(value, context);
  }
}

function validateLocationList(value: unknown, context: TypstProviderPositionContext): void {
  for (const item of requireArray(value)) validateLocation(item, context);
}

function validateLocationOrLink(value: unknown, context: TypstProviderPositionContext): void {
  const item = requireRecord(value);
  if (item.uri !== undefined) validateLocation(item, context);
  else {
    const targetUri = requireString(item.targetUri);
    validateRange(item.targetRange, targetUri, context);
    validateRange(item.targetSelectionRange, targetUri, context);
    if (item.originSelectionRange !== undefined) validateRange(item.originSelectionRange, context.sourceUri, context);
  }
}

function validateLocation(value: unknown, context: TypstProviderPositionContext): void {
  const item = requireRecord(value);
  validateRange(item.range, requireString(item.uri), context);
}

function validateRenamePayload(method: TypstProviderMethod, value: unknown, context: TypstProviderPositionContext): void {
  if (method === "textDocument/prepareRename") {
    const result = requireRecord(value);
    if (result.defaultBehavior === true) return;
    validateRange(result.range ?? result, context.sourceUri, context);
    if (result.placeholder !== undefined) requireString(result.placeholder);
    return;
  }
  validateWorkspaceEdit(value, context);
}

function validateWorkspaceEdit(value: unknown, context: TypstProviderPositionContext): void {
  const edit = requireRecord(value);
  if (edit.changes !== undefined) {
    const changes = requireRecord(edit.changes);
    for (const [uri, edits] of Object.entries(changes)) validateTextEdits(edits, uri, context);
  }
  if (edit.documentChanges !== undefined) {
    for (const changeValue of requireArray(edit.documentChanges)) {
      const change = requireRecord(changeValue);
      if (change.edits === undefined) continue;
      const textDocument = requireRecord(change.textDocument);
      validateTextEdits(change.edits, requireString(textDocument.uri), context);
    }
  }
}

function validateTextEdits(value: unknown, uri: string, context: TypstProviderPositionContext): void {
  for (const editValue of requireArray(value)) validateRange(requireRecord(editValue).range, uri, context);
}

function validateDocumentSymbols(value: unknown, context: TypstProviderPositionContext): void {
  for (const symbolValue of requireArray(value)) {
    const symbol = requireRecord(symbolValue);
    if (symbol.location !== undefined) validateLocation(symbol.location, context);
    else {
      validateRange(symbol.range, context.sourceUri, context);
      validateRange(symbol.selectionRange, context.sourceUri, context);
      if (symbol.children !== undefined) validateDocumentSymbols(symbol.children, context);
    }
  }
}

function validateWorkspaceSymbols(value: unknown, context: TypstProviderPositionContext): void {
  const values = Array.isArray(value) ? value : [value];
  for (const symbolValue of values) {
    const symbol = requireRecord(symbolValue);
    const location = requireRecord(symbol.location);
    const uri = requireString(location.uri);
    if (location.range !== undefined) validateRange(location.range, uri, context);
  }
}

function validateRanges(value: unknown, uri: string, context: TypstProviderPositionContext): void {
  for (const itemValue of requireArray(value)) validateRange(requireRecord(itemValue).range, uri, context);
}

function validateSelectionRanges(value: unknown, context: TypstProviderPositionContext): void {
  for (const itemValue of requireArray(value)) {
    let item: unknown = itemValue;
    const seen = new Set<unknown>();
    while (item !== undefined) {
      if (seen.has(item)) throw invalidPayload();
      seen.add(item);
      const selection = requireRecord(item);
      validateRange(selection.range, context.sourceUri, context);
      item = selection.parent;
    }
  }
}

function validateLinks(value: unknown, context: TypstProviderPositionContext): void {
  const values = Array.isArray(value) ? value : [value];
  for (const itemValue of values) validateRange(requireRecord(itemValue).range, context.sourceUri, context);
}

function validateColorPresentations(value: unknown, context: TypstProviderPositionContext): void {
  const values = Array.isArray(value) ? value : [value];
  for (const itemValue of values) {
    const item = requireRecord(itemValue);
    if (item.textEdit !== undefined) validateRange(requireRecord(item.textEdit).range, context.sourceUri, context);
    if (item.additionalTextEdits !== undefined) validateTextEdits(item.additionalTextEdits, context.sourceUri, context);
  }
}

function validateCodeActions(value: unknown, context: TypstProviderPositionContext): void {
  const values = Array.isArray(value) ? value : [value];
  for (const itemValue of values) {
    const item = requireRecord(itemValue);
    if (item.edit !== undefined) validateWorkspaceEdit(item.edit, context);
    if (item.diagnostics !== undefined) validateRanges(item.diagnostics, context.sourceUri, context);
  }
}

function validateInlayHints(value: unknown, context: TypstProviderPositionContext): void {
  const values = Array.isArray(value) ? value : [value];
  for (const itemValue of values) {
    const item = requireRecord(itemValue);
    validatePosition(item.position, context.sourceUri, context);
    if (item.textEdits !== undefined) validateTextEdits(item.textEdits, context.sourceUri, context);
    if (Array.isArray(item.label)) {
      for (const partValue of item.label) {
        const part = requireRecord(partValue);
        if (part.location !== undefined) validateLocation(part.location, context);
      }
    }
  }
}

function validateCodeLenses(value: unknown, context: TypstProviderPositionContext): void {
  const values = Array.isArray(value) ? value : [value];
  for (const itemValue of values) validateRange(requireRecord(itemValue).range, context.sourceUri, context);
}

function validateRange(value: unknown, uri: string, context: TypstProviderPositionContext): void {
  const index = uri === context.sourceUri ? context.sourceIndex : context.retainedIndex?.(uri);
  if (index) {
    validateBackendWireRange(value, index, context.encoding);
    return;
  }
  const range = requireRecord(value);
  const start = wirePosition(range.start);
  const end = wirePosition(range.end);
  if (start.line > end.line || (start.line === end.line && start.character > end.character)) throw invalidPayload();
}

function validatePosition(value: unknown, uri: string, context: TypstProviderPositionContext): void {
  const position = wirePosition(value);
  validateRange({ start: position, end: position }, uri, context);
}

function wirePosition(value: unknown): { readonly line: number; readonly character: number } {
  const position = requireRecord(value);
  if (!Number.isSafeInteger(position.line) || (position.line as number) < 0
    || !Number.isSafeInteger(position.character) || (position.character as number) < 0) throw invalidPayload();
  return { line: position.line as number, character: position.character as number };
}

function requireArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw invalidPayload();
  return value;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw invalidPayload();
  return value;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw invalidPayload();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidPayload(): PositionConversionError {
  return new PositionConversionError("InvalidCharacter");
}

function freezeIdentity(identity: TinymistRequestIdentity): TinymistRequestIdentity {
  return Object.freeze({
    ...identity,
    sourceStaleToken: Object.freeze({ ...identity.sourceStaleToken })
  });
}

function parseRequestIdentity(value: unknown): TinymistRequestIdentity | undefined {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.backendGeneration)
    || (value.backendGeneration as number) <= 0
    || typeof value.logicalSource !== "string"
    || typeof value.sourceContent !== "string"
    || typeof value.projectSnapshot !== "string"
    || (value.projectionKey !== undefined && typeof value.projectionKey !== "string")
    || !isRecord(value.sourceStaleToken)
    || typeof value.sourceStaleToken.hostUri !== "string"
    || typeof value.sourceStaleToken.documentIncarnation !== "string"
    || !Number.isInteger(value.sourceStaleToken.documentVersion)) return undefined;
  return value as unknown as TinymistRequestIdentity;
}

function identitiesEqual(left: TinymistRequestIdentity, right: TinymistRequestIdentity): boolean {
  return left.backendGeneration === right.backendGeneration
    && left.logicalSource === right.logicalSource
    && left.sourceContent === right.sourceContent
    && left.sourceStaleToken.hostUri === right.sourceStaleToken.hostUri
    && left.sourceStaleToken.documentIncarnation === right.sourceStaleToken.documentIncarnation
    && left.sourceStaleToken.documentVersion === right.sourceStaleToken.documentVersion
    && left.projectSnapshot === right.projectSnapshot
    && left.projectionKey === right.projectionKey;
}
