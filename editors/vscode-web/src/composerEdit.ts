import type * as vscode from "vscode";
import type { IModelService } from "@codingame/monaco-vscode-api";
import { URI } from "@codingame/monaco-vscode-api/vscode/vs/base/common/uri";
import { Selection } from "@codingame/monaco-vscode-api/vscode/vs/editor/common/core/selection";
import type { BaseLanguageClient } from "vscode-languageclient";
import type {
  Position as ProtocolPosition,
  Range as ProtocolRange,
  TextDocumentEdit as ProtocolTextDocumentEdit,
  TextEdit as ProtocolTextEdit,
  WorkspaceEdit as ProtocolWorkspaceEdit,
} from "vscode-languageserver";
import type {
  ComposerBoundaryTarget,
  ComposerDocumentSnapshot,
  ComposerMessageSide,
  ComposerNodeRef,
  ComposerTextDocumentLike,
} from "./composerDocument";
import { composerDocumentSourceDigest } from "./composerDocument.ts";
import type { PreviewComposerTargetParams } from "./previewComposer";
import type { PreviewBackendLocation } from "./previewInteraction";


export type StatementContinuedValue = "auto" | "true" | "false";
export type StatementTextMode =
  | "inherit"
  | "textMacro"
  | "textRaw"
  | "typstMacro"
  | "typstRaw";
export type ComposerBodyMode = "textMacro" | "textRaw" | "typstMacro" | "typstRaw";

export interface ComposerAvatarChoice {
  readonly kind: "packAvatar";
  readonly entityId: string;
  readonly contributionNamespace: string;
  readonly variantId: string;
}

export type ComposerAvatarCurrent =
  | ComposerAvatarChoice
  | {
      readonly kind: "asset";
      readonly assetName: string;
    };

export interface ComposerTextDocument {
  readonly uri: string;
  readonly version: number;
}

export interface ComposerStatementTarget {
  readonly kind: "statement";
  readonly range: ProtocolRange;
}

export interface PreviewComposerTargetProperties {
  readonly continued?: StatementContinuedValue;
  readonly actorDisplayName?: {
    readonly current: string;
    readonly scope: "fromStatement";
  };
  readonly actorAvatar?: {
    readonly scope: "fromStatement";
    readonly actorPresetId: string;
    readonly current: ComposerAvatarCurrent | null;
  };
  readonly statementText?: {
    readonly current: string;
    readonly mode: StatementTextMode;
    readonly resolvedMode: ComposerBodyMode;
    readonly inheritedMode: ComposerBodyMode;
  };
}

export type PreviewComposerTargetUnavailableReason =
  | "stalePreview"
  | "nonMmtSource"
  | "unmapped"
  | "ambiguousOrigin"
  | "unsupportedNode"
  | "documentHasErrors"
  | "actorUnavailable";

export type PreviewComposerTargetResult =
  | {
      readonly kind: "Editable";
      readonly textDocument: ComposerTextDocument;
      readonly target: ComposerStatementTarget;
      readonly properties: PreviewComposerTargetProperties;
    }
  | {
      readonly kind: "Unavailable";
      readonly reason: PreviewComposerTargetUnavailableReason;
    };

export type ComposerEditCommand =
  | {
      readonly kind: "setStatementContinued";
      readonly value: StatementContinuedValue;
    }
  | {
      readonly kind: "setActorDisplayNameFromStatement";
      readonly value: string;
    }
  | {
      readonly kind: "setActorAvatarFromStatement";
      readonly avatar: ComposerAvatarChoice;
    }
  | {
      readonly kind: "setStatementBody";
      readonly value: string;
      readonly mode: StatementTextMode;
    };

export interface ComposerEditParams {
  readonly textDocument: ComposerTextDocument;
  readonly target: ComposerStatementTarget;
  readonly command: ComposerEditCommand;
}

export type ComposerStructureTarget =
  | { readonly kind: "node"; readonly node: ComposerNodeRef }
  | ComposerBoundaryTarget;

export type ComposerSpeakerChoice = {
  readonly kind: "actor";
  readonly reference: string;
};

export type ComposerNewStatement =
  | {
      readonly kind: "message";
      readonly side: ComposerMessageSide;
      readonly speaker: ComposerSpeakerChoice;
      readonly body: { readonly value: string; readonly mode: StatementTextMode };
      readonly continued: StatementContinuedValue;
    }
  | {
      readonly kind: "narration";
      readonly body: { readonly value: string; readonly mode: StatementTextMode };
    };

export type ComposerStructureCommand =
  | { readonly kind: "insertStatement"; readonly statement: ComposerNewStatement }
  | { readonly kind: "deleteNode" }
  | { readonly kind: "moveNode"; readonly anchor: ComposerBoundaryTarget }
  | {
      readonly kind: "setStatementSpeaker";
      readonly speaker: ComposerSpeakerChoice;
    };

export interface ComposerStructureEditParams {
  readonly textDocument: ComposerTextDocument;
  readonly sourceDigest: string;
  readonly target: ComposerStructureTarget;
  readonly command: ComposerStructureCommand;
}
export interface ComposerTextEndpoint {
  readonly node: ComposerNodeRef;
  readonly offsetUtf16: number;
}

export interface ComposerTextSelection {
  readonly anchor: ComposerTextEndpoint;
  readonly focus: ComposerTextEndpoint;
}

export interface ComposerTextEditParams {
  readonly textDocument: ComposerTextDocument;
  readonly sourceDigest: string;
  readonly target: { readonly kind: "textSelection"; readonly selection: ComposerTextSelection };
  readonly command: { readonly kind: "replaceTextSelection"; readonly replacement: string };
}

export interface ComposerTextSelectionParams {
  readonly textDocument: ComposerTextDocument;
  readonly sourceDigest: string;
  readonly anchor: ProtocolRange;
  readonly focus: ProtocolRange;
}

export type ComposerTextSelectionResult =
  | {
      readonly kind: "Selection";
      readonly textDocument: ComposerTextDocument;
      readonly sourceDigest: string;
      readonly selection: ComposerTextSelection;
      readonly text: string;
    }
  | { readonly kind: "Rejected"; readonly reason: ComposerEditRejectedReason };

export interface ComposerTextProjectionParams extends Omit<PreviewComposerTargetParams, "location"> {
  readonly selection: ComposerTextSelection;
}

export type ComposerTextProjectionResult =
  | {
      readonly kind: "Mapped";
      readonly anchor: PreviewBackendLocation;
      readonly focus: PreviewBackendLocation;
      readonly segments: readonly PreviewBackendLocation[];
    }
  | { readonly kind: "Rejected"; readonly reason: ComposerEditRejectedReason };

export interface ComposerTextEditEndpointAfter {
  readonly statementRange: ProtocolRange;
  readonly offsetUtf16: number;
}

export interface ComposerTextSelectionAfter {
  readonly anchor: ComposerTextEditEndpointAfter;
  readonly focus: ComposerTextEditEndpointAfter;
}


export type AnyComposerEditParams = ComposerEditParams | ComposerStructureEditParams | ComposerTextEditParams;

export type ComposerEditRejectedReason =
  | "staleDocument"
  | "targetChanged"
  | "documentHasErrors"
  | "invalidValue"
  | "actorUnavailable"
  | "avatarUnavailable"
  | "unsupportedStructure"
  | "speakerUnavailable"
  | "candidateInvalid";

export interface ComposerTextDocumentEdit extends ProtocolTextDocumentEdit {
  readonly textDocument: ComposerTextDocument;
  readonly edits: ProtocolTextEdit[];
}

export interface ComposerWorkspaceEdit extends ProtocolWorkspaceEdit {
  readonly changes?: undefined;
  readonly changeAnnotations?: undefined;
  readonly documentChanges: [ComposerTextDocumentEdit];
}

export type ComposerEditResult =
  | {
      readonly kind: "Edit";
      readonly edit: ComposerWorkspaceEdit;
    }
  | {
      readonly kind: "TextEdit";
      readonly edit: ComposerWorkspaceEdit;
      readonly sourceDigestAfter: string;
      readonly selectionAfter: ComposerTextSelectionAfter;
    }
  | {
      readonly kind: "Rejected";
      readonly reason: ComposerEditRejectedReason;
    };

export type ComposerEditApplicationResult =
  | { readonly kind: "Applied" }
  | { readonly kind: "Stale" }
  | { readonly kind: "ApplyFailed" }
  | { readonly kind: "Cancelled" };

export interface ComposerEditWorkspace {
  readonly textDocuments: readonly {
    readonly uri: { toString(): string };
    readonly version: number;
  }[];
  applyEdit(edit: vscode.WorkspaceEdit): PromiseLike<boolean>;
}

export interface ApplyComposerEditOptions {
  readonly client: Pick<BaseLanguageClient, "protocol2CodeConverter">;
  readonly workspace: ComposerEditWorkspace;
  readonly result: Extract<ComposerEditResult, { kind: "Edit" }>;
  readonly textDocument: ComposerTextDocument;
  readonly signal?: Pick<AbortSignal, "aborted">;
}

export interface ComposerSourceSelection {
  readonly anchor: ProtocolPosition;
  readonly focus: ProtocolPosition;
}

export type ComposerNativeModelService = Pick<IModelService, "getModel">;

export interface ComposerNativeHistory {
  readonly uri: string;
  getVersionId(): number;
  getAlternativeVersionId(): number;
  pushStackElement(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void | Promise<void>;
  redo(): void | Promise<void>;
}

export interface ApplyComposerTextEditOptions {
  readonly modelService: ComposerNativeModelService;
  readonly document: ComposerTextDocumentLike;
  readonly textDocument: ComposerTextDocument;
  readonly sourceDigest: string;
  readonly modelVersion: number;
  readonly result: Extract<ComposerEditResult, { kind: "TextEdit" }>;
  readonly canApply: (candidate: string) => boolean;
  readonly beforeSelection: ComposerSourceSelection;
  /** If omitted, the source editor is restored to the authoritative statement end.
   * GUI presentation uses selectionAfter, not this source-editor bookmark. */
  readonly afterSelection?: ComposerSourceSelection;
  readonly undoStopBefore?: boolean;
  readonly undoStopAfter?: boolean;
  readonly signal?: Pick<AbortSignal, "aborted">;
}

export type ComposerTextEditApplicationResult =
  | Exclude<ComposerEditApplicationResult, { kind: "Applied" }>
  | {
      readonly kind: "Applied";
      readonly modelVersion: number;
      readonly alternativeVersionId: number;
    };

const PREVIEW_UNAVAILABLE_REASONS = [
  "stalePreview",
  "nonMmtSource",
  "unmapped",
  "ambiguousOrigin",
  "unsupportedNode",
  "documentHasErrors",
  "actorUnavailable",
] as const;

const COMPOSER_REJECTED_REASONS = [
  "staleDocument",
  "targetChanged",
  "documentHasErrors",
  "invalidValue",
  "actorUnavailable",
  "candidateInvalid",
  "avatarUnavailable",
  "unsupportedStructure",
  "speakerUnavailable",
] as const;

const CONTINUED_VALUES = ["auto", "true", "false"] as const;
const MAX_COMPOSER_AVATAR_COMPONENT_BYTES = 1024;
const MAX_COMPOSER_STATEMENT_TEXT_BYTES = 64 * 1024;
const UTF8_ENCODER = new TextEncoder();
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_COMPOSER_NODES = 100_000;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const STATEMENT_TEXT_MODES = [
  "inherit",
  "textMacro",
  "textRaw",
  "typstMacro",
  "typstRaw",
] as const;
const COMPOSER_BODY_MODES = ["textMacro", "textRaw", "typstMacro", "typstRaw"] as const;
const APPLIED = Object.freeze({ kind: "Applied" } as const);
const STALE = Object.freeze({ kind: "Stale" } as const);
const APPLY_FAILED = Object.freeze({ kind: "ApplyFailed" } as const);
const CANCELLED = Object.freeze({ kind: "Cancelled" } as const);

export function parsePreviewComposerTargetResult(value: unknown): PreviewComposerTargetResult {
  const result = requireRecord(value, "Preview Composer target result");
  if (result.kind === "Unavailable") {
    requireExactKeys(result, ["kind", "reason"], "Unavailable Preview Composer target result");
    if (!isAllowedString(result.reason, PREVIEW_UNAVAILABLE_REASONS)) {
      throw new TypeError("Unavailable Preview Composer target result has an unknown reason");
    }
    return { kind: "Unavailable", reason: result.reason };
  }
  if (result.kind !== "Editable") {
    throw new TypeError("Preview Composer target result has an unknown kind");
  }

  requireExactKeys(
    result,
    ["kind", "textDocument", "target", "properties"],
    "Editable Preview Composer target result",
  );
  return {
    kind: "Editable",
    textDocument: parseTextDocument(result.textDocument, "Editable Preview Composer text document"),
    target: parseStatementTarget(result.target, "Editable Preview Composer target"),
    properties: parseTargetProperties(result.properties),
  };
}

export function parseComposerEditResult(
  value: unknown,
  expectedTextDocument: ComposerTextDocument,
  expectedKind?: "Edit",
): Extract<ComposerEditResult, { kind: "Edit" | "Rejected" }>;
export function parseComposerEditResult(
  value: unknown,
  expectedTextDocument: ComposerTextDocument,
  expectedKind: "TextEdit",
): Extract<ComposerEditResult, { kind: "TextEdit" | "Rejected" }>;
export function parseComposerEditResult(
  value: unknown,
  expectedTextDocument: ComposerTextDocument,
  expectedKind: "Edit" | "TextEdit" = "Edit",
): ComposerEditResult {
  const expected = parseTextDocument(expectedTextDocument, "Expected Composer text document");
  const result = requireRecord(value, "Composer edit result");
  if (result.kind === "Rejected") {
    requireExactKeys(result, ["kind", "reason"], "Rejected Composer edit result");
    if (!isAllowedString(result.reason, COMPOSER_REJECTED_REASONS)) {
      throw new TypeError("Rejected Composer edit result has an unknown reason");
    }
    return { kind: "Rejected", reason: result.reason };
  }
  if (result.kind !== expectedKind) {
    throw new TypeError(`Composer edit result must be ${expectedKind}`);
  }
  if (result.kind === "TextEdit") {
    requireExactKeys(
      result,
      ["kind", "edit", "sourceDigestAfter", "selectionAfter"],
      "Composer TextEdit result",
    );
    const selectionAfter = requireRecord(result.selectionAfter, "Composer selectionAfter");
    requireExactKeys(selectionAfter, ["anchor", "focus"], "Composer selectionAfter");
    const anchor = parseTextEndpointAfter(selectionAfter.anchor);
    const focus = parseTextEndpointAfter(selectionAfter.focus);
    if (anchor.offsetUtf16 !== focus.offsetUtf16 || !sameRange(anchor.statementRange, focus.statementRange)) {
      throw new TypeError("Composer selectionAfter must be a collapsed caret");
    }
    return {
      kind: "TextEdit",
      edit: parseComposerWorkspaceEdit(result.edit, expected),
      sourceDigestAfter: parseDigest(result.sourceDigestAfter, "Composer sourceDigestAfter"),
      selectionAfter: { anchor, focus },
    };
  }

  requireExactKeys(result, ["kind", "edit"], "Composer Edit result");
  return {
    kind: "Edit",
    edit: parseComposerWorkspaceEdit(result.edit, expected),
  };
}

export function parseComposerTextEndpoint(
  value: unknown,
  snapshot?: ComposerDocumentSnapshot,
): ComposerTextEndpoint {
  const endpoint = requireRecord(value, "Composer text endpoint");
  requireExactKeys(endpoint, ["node", "offsetUtf16"], "Composer text endpoint");
  const node = requireRecord(endpoint.node, "Composer text endpoint node");
  requireExactKeys(node, ["nodeKey", "nodeKind", "range"], "Composer text endpoint node");
  if (node.nodeKind !== "message" && node.nodeKind !== "narration") {
    throw new TypeError("Composer text endpoint must identify a message or narration");
  }
  const range = parseRange(node.range, "Composer text endpoint node range");
  if (samePosition(range.start, range.end)) {
    throw new TypeError("Composer text endpoint node range must be nonempty");
  }
  const parsed: ComposerTextEndpoint = {
    node: {
      nodeKey: parseDigest(node.nodeKey, "Composer text endpoint nodeKey"),
      nodeKind: node.nodeKind,
      range,
    },
    offsetUtf16: parseTextOffset(endpoint.offsetUtf16),
  };
  if (snapshot) {
    const current = textEndpointNode(parsed, snapshot);
    requireGraphemeBoundary(current.textEditing!.text, parsed.offsetUtf16);
  }
  return parsed;
}

export function parseComposerTextSelection(
  value: unknown,
  snapshot?: ComposerDocumentSnapshot,
): ComposerTextSelection {
  const selection = requireRecord(value, "Composer text selection");
  requireExactKeys(selection, ["anchor", "focus"], "Composer text selection");
  const parsed = {
    anchor: parseComposerTextEndpoint(selection.anchor, snapshot),
    focus: parseComposerTextEndpoint(selection.focus, snapshot),
  };
  if (snapshot) textSelectionExtent(parsed, snapshot);
  return parsed;
}

export function parseComposerTextEditParams(
  value: unknown,
  snapshot?: ComposerDocumentSnapshot,
): ComposerTextEditParams {
  const params = requireRecord(value, "Composer text edit params");
  requireExactKeys(params, ["textDocument", "sourceDigest", "target", "command"], "Composer text edit params");
  const target = requireRecord(params.target, "Composer text edit target");
  requireExactKeys(target, ["kind", "selection"], "Composer text edit target");
  const command = requireRecord(params.command, "Composer text edit command");
  requireExactKeys(command, ["kind", "replacement"], "Composer text edit command");
  if (target.kind !== "textSelection" || command.kind !== "replaceTextSelection") {
    throw new TypeError("Composer text edit target or command is invalid");
  }
  const textDocument = parseTextDocument(params.textDocument, "Composer text edit document");
  const sourceDigest = parseDigest(params.sourceDigest, "Composer text edit sourceDigest");
  if (snapshot) requireSnapshotIdentity(snapshot, { textDocument, sourceDigest });
  const replacement = requireText(command.replacement, MAX_COMPOSER_STATEMENT_TEXT_BYTES * 2, false);
  requireText(replacement.replace(/\r\n?/gu, "\n"), MAX_COMPOSER_STATEMENT_TEXT_BYTES, true);
  return {
    textDocument,
    sourceDigest,
    target: { kind: "textSelection", selection: parseComposerTextSelection(target.selection, snapshot) },
    command: { kind: "replaceTextSelection", replacement },
  };
}

export function parseComposerTextSelectionParams(value: unknown): ComposerTextSelectionParams {
  const params = requireRecord(value, "Composer text selection params");
  requireExactKeys(params, ["textDocument", "sourceDigest", "anchor", "focus"], "Composer text selection params");
  return {
    textDocument: parseTextDocument(params.textDocument, "Composer text selection document"),
    sourceDigest: parseDigest(params.sourceDigest, "Composer text selection sourceDigest"),
    anchor: parseCollapsedRange(params.anchor, "Composer text selection anchor"),
    focus: parseCollapsedRange(params.focus, "Composer text selection focus"),
  };
}

export function parseComposerTextSelectionResult(
  value: unknown,
  expected: Pick<ComposerTextSelectionParams, "textDocument" | "sourceDigest">,
  snapshot?: ComposerDocumentSnapshot,
): ComposerTextSelectionResult {
  const expectedDocument = parseTextDocument(expected.textDocument, "Expected Composer selection document");
  const expectedDigest = parseDigest(expected.sourceDigest, "Expected Composer selection sourceDigest");
  const result = requireRecord(value, "Composer text selection result");
  if (result.kind === "Rejected") return parseTextRejection(result);
  if (result.kind !== "Selection") throw new TypeError("Composer text selection result kind is invalid");
  requireExactKeys(result, ["kind", "textDocument", "sourceDigest", "selection", "text"], "Composer Selection result");
  const textDocument = parseTextDocument(result.textDocument, "Composer Selection document");
  const sourceDigest = parseDigest(result.sourceDigest, "Composer Selection sourceDigest");
  if (
    textDocument.uri !== expectedDocument.uri
    || textDocument.version !== expectedDocument.version
    || sourceDigest !== expectedDigest
  ) {
    throw new TypeError("Composer Selection result document identity is stale");
  }
  if (snapshot) requireSnapshotIdentity(snapshot, { textDocument, sourceDigest });
  const selection = parseComposerTextSelection(result.selection, snapshot);
  const text = requireText(
    result.text,
    MAX_COMPOSER_NODES * (MAX_COMPOSER_STATEMENT_TEXT_BYTES + 1),
    true,
  );
  if (snapshot && text !== textSelectionContent(selection, snapshot)) {
    throw new TypeError("Composer Selection text does not match the authorized semantic selection");
  }
  return { kind: "Selection", textDocument, sourceDigest, selection, text };
}

export function parseComposerTextProjectionParams(
  value: unknown,
  snapshot?: ComposerDocumentSnapshot,
): ComposerTextProjectionParams {
  const params = requireRecord(value, "Composer text projection params");
  requireExactKeys(
    params,
    ["sourceUri", "revision", "sourceContent", "projectDigest", "projectionKey", "entryUri", "backendEncoding", "selection"],
    "Composer text projection params",
  );
  const sourceUri = parseUri(params.sourceUri, "Composer projection sourceUri");
  if (!isNonNegativeSafeInteger(params.revision)) throw new TypeError("Composer projection revision is invalid");
  if (snapshot && snapshot.textDocument.uri !== sourceUri) throw new TypeError("Composer projection snapshot URI is stale");
  if (!isAllowedString(params.backendEncoding, ["utf-8", "utf-16", "utf-32"] as const)) {
    throw new TypeError("Composer projection backendEncoding is invalid");
  }
  return {
    sourceUri,
    revision: params.revision,
    sourceContent: parseDigest(params.sourceContent, "Composer projection sourceContent") as ComposerTextProjectionParams["sourceContent"],
    projectDigest: parseDigest(params.projectDigest, "Composer projection projectDigest") as ComposerTextProjectionParams["projectDigest"],
    projectionKey: parseDigest(params.projectionKey, "Composer projection projectionKey") as ComposerTextProjectionParams["projectionKey"],
    entryUri: parseUri(params.entryUri, "Composer projection entryUri"),
    backendEncoding: params.backendEncoding,
    selection: parseComposerTextSelection(params.selection, snapshot),
  };
}

export function parseComposerTextProjectionResult(
  value: unknown,
  expectedEntryUri: string,
): ComposerTextProjectionResult {
  const entryUri = parseUri(expectedEntryUri, "Expected Composer projection entryUri");
  const result = requireRecord(value, "Composer text projection result");
  if (result.kind === "Rejected") return parseTextRejection(result);
  if (result.kind !== "Mapped") throw new TypeError("Composer text projection result kind is invalid");
  requireExactKeys(result, ["kind", "anchor", "focus", "segments"], "Composer Mapped result");
  if (!Array.isArray(result.segments)
    || result.segments.length > MAX_COMPOSER_NODES * MAX_COMPOSER_STATEMENT_TEXT_BYTES) {
    throw new TypeError("Composer projection segments are invalid");
  }
  const location = (value: unknown, collapsed: boolean): PreviewBackendLocation => {
    const item = requireRecord(value, "Composer projection location");
    requireExactKeys(item, ["uri", "range"], "Composer projection location");
    if (parseUri(item.uri, "Composer projection location URI") !== entryUri) {
      throw new TypeError("Composer projection location URI does not match the generated entry");
    }
    return {
      uri: entryUri,
      range: collapsed
        ? parseCollapsedRange(item.range, "Composer projection caret")
        : parseRange(item.range, "Composer projection segment"),
    };
  };
  return {
    kind: "Mapped",
    anchor: location(result.anchor, true),
    focus: location(result.focus, true),
    segments: result.segments.map((segment) => location(segment, false)),
  };
}

/** Returns the existing model's native history, never creating or retaining a second model. */
export function getComposerNativeHistory(
  modelService: ComposerNativeModelService,
  uri: string,
): ComposerNativeHistory | undefined {
  const resource = URI.parse(parseUri(uri, "Composer history URI"));
  const model = modelService.getModel(resource);
  if (!model || model.isDisposed()) return undefined;
  const current = () => {
    if (model.isDisposed() || modelService.getModel(resource) !== model) {
      throw new Error("Composer history model is no longer current");
    }
    return model;
  };
  return {
    uri,
    getVersionId: () => current().getVersionId(),
    getAlternativeVersionId: () => current().getAlternativeVersionId(),
    pushStackElement: () => current().pushStackElement(),
    canUndo: () => current().canUndo(),
    canRedo: () => current().canRedo(),
    undo: () => current().undo(),
    redo: () => current().redo(),
  };
}

export async function applyComposerTextEdit(
  options: ApplyComposerTextEditOptions,
): Promise<ComposerTextEditApplicationResult> {
  const { document, modelService, signal } = options;
  if (signal?.aborted) return CANCELLED;
  try {
    const expected = parseTextDocument(options.textDocument, "Expected Composer text document");
    const digest = parseDigest(options.sourceDigest, "Expected Composer sourceDigest");
    const result = parseComposerEditResult(options.result, expected, "TextEdit");
    if (result.kind !== "TextEdit") return APPLY_FAILED;
    if (!isNonNegativeSafeInteger(options.modelVersion)) return STALE;
    const resource = URI.parse(expected.uri);
    const model = modelService.getModel(resource);
    const current = (): boolean =>
      !!model
      && !model.isDisposed()
      && modelService.getModel(resource) === model
      && model.uri.toString() === expected.uri
      && model.getVersionId() === options.modelVersion
      && document.uri.toString() === expected.uri
      && document.version === expected.version;
    if (!model || !current()) return STALE;
    const source = document.getText();
    if (model.getValue(undefined, true) !== source) return STALE;
    const sourceDigest = await composerDocumentSourceDigest(source);
    if (signal?.aborted) return CANCELLED;
    if (sourceDigest !== digest) return STALE;
    if (!current()) return STALE;

    const changes = result.edit.documentChanges[0].edits;
    if (changes.length === 0) return APPLY_FAILED;
    const sourceOffset = sourceOffsetLookup(source);
    const offsets = changes.map((change) => ({
      change,
      start: sourceOffset(change.range.start),
      end: sourceOffset(change.range.end),
    })).sort((left, right) => left.start - right.start || left.end - right.end);
    const pieces: string[] = [];
    let cursor = 0;
    for (let index = 0; index < offsets.length; index += 1) {
      const { change, start, end } = offsets[index]!;
      if (start < cursor || (index > 0 && start === offsets[index - 1]!.start) || !change.newText.isWellFormed()) {
        return APPLY_FAILED;
      }
      pieces.push(source.slice(cursor, start), change.newText);
      cursor = end;
    }
    pieces.push(source.slice(cursor));
    const candidate = pieces.join("");
    const candidateDigest = await composerDocumentSourceDigest(candidate);
    if (signal?.aborted) return CANCELLED;
    if (candidateDigest !== result.sourceDigestAfter) return APPLY_FAILED;
    const candidateOffset = sourceOffsetLookup(candidate);
    const before = nativeSourceSelection(options.beforeSelection, sourceOffset);
    const after = nativeSourceSelection(
      options.afterSelection ?? {
        anchor: result.selectionAfter.anchor.statementRange.end,
        focus: result.selectionAfter.focus.statementRange.end,
      },
      candidateOffset,
    );
    for (const endpoint of [result.selectionAfter.anchor, result.selectionAfter.focus]) {
      candidateOffset(endpoint.statementRange.start);
      candidateOffset(endpoint.statementRange.end);
    }
    const edits = offsets.map(({ change }) => ({
      range: {
        startLineNumber: change.range.start.line + 1,
        startColumn: change.range.start.character + 1,
        endLineNumber: change.range.end.line + 1,
        endColumn: change.range.end.character + 1,
      },
      text: change.newText,
    }));
    if (signal?.aborted) return CANCELLED;
    if (!current()) return STALE;
    if (options.canApply(candidate) !== true) return CANCELLED;
    // The permission gate is synchronous. Recheck its possible side effects immediately
    // before the sole mutation; no promise or source conversion may cross this boundary.
    if (signal?.aborted) return CANCELLED;
    if (!current()) return STALE;
    if (options.undoStopBefore) model.pushStackElement();
    const priorTrimAutoWhitespace = model.getOptions().trimAutoWhitespace;
    try {
      if (priorTrimAutoWhitespace) model.updateOptions({ trimAutoWhitespace: false });
      model.pushEditOperations([before], edits, () => [after]);
    } finally {
      if (priorTrimAutoWhitespace) model.updateOptions({ trimAutoWhitespace: priorTrimAutoWhitespace });
    }
    if (options.undoStopAfter) model.pushStackElement();
    return {
      kind: "Applied",
      modelVersion: model.getVersionId(),
      alternativeVersionId: model.getAlternativeVersionId(),
    };
  } catch {
    return signal?.aborted ? CANCELLED : APPLY_FAILED;
  }
}

function parseTextRejection(result: Record<string, unknown>): { kind: "Rejected"; reason: ComposerEditRejectedReason } {
  requireExactKeys(result, ["kind", "reason"], "Composer text rejection");
  if (!isAllowedString(result.reason, COMPOSER_REJECTED_REASONS)) throw new TypeError("Composer text rejection reason is invalid");
  return { kind: "Rejected", reason: result.reason };
}

function parseTextEndpointAfter(value: unknown): ComposerTextEditEndpointAfter {
  const endpoint = requireRecord(value, "Composer post-edit endpoint");
  requireExactKeys(endpoint, ["statementRange", "offsetUtf16"], "Composer post-edit endpoint");
  const statementRange = parseRange(endpoint.statementRange, "Composer post-edit statementRange");
  if (samePosition(statementRange.start, statementRange.end)) throw new TypeError("Composer post-edit statementRange is empty");
  return { statementRange, offsetUtf16: parseTextOffset(endpoint.offsetUtf16) };
}

function parseTextOffset(value: unknown): number {
  if (!isNonNegativeSafeInteger(value) || value > MAX_COMPOSER_STATEMENT_TEXT_BYTES) {
    throw new TypeError("Composer text offsetUtf16 is invalid");
  }
  return value;
}

function requireText(value: unknown, maxBytes: number, normalized: boolean): string {
  if (typeof value !== "string" || value.length > maxBytes || !value.isWellFormed()
    || (normalized && value.includes("\r")) || UTF8_ENCODER.encode(value).length > maxBytes) {
    throw new TypeError("Composer text must be bounded, well-formed Unicode with semantic LF line endings");
  }
  return value;
}

function requireGraphemeBoundary(text: string, offset: number): void {
  if (offset === text.length || offset === 0) return;
  if (offset < text.length) {
    const segment = GRAPHEME_SEGMENTER.segment(text).containing(offset);
    if (segment?.index === offset) return;
  }
  throw new TypeError("Composer text offset is outside the body or inside a grapheme");
}

function textEndpointNode(endpoint: ComposerTextEndpoint, snapshot: ComposerDocumentSnapshot) {
  const node = snapshot.nodes.find((node) =>
    node.nodeKey === endpoint.node.nodeKey
    && node.kind === endpoint.node.nodeKind
    && sameRange(node.range, endpoint.node.range),
  );
  if (!node || node.kind === "opaque" || node.textEditing === null) {
    throw new TypeError("Composer text endpoint is stale or not editable");
  }
  return node;
}

function textSelectionExtent(selection: ComposerTextSelection, snapshot: ComposerDocumentSnapshot) {
  const anchor = textEndpointNode(selection.anchor, snapshot);
  const focus = textEndpointNode(selection.focus, snapshot);
  const anchorIndex = snapshot.nodes.indexOf(anchor);
  const focusIndex = snapshot.nodes.indexOf(focus);
  const forward = anchorIndex < focusIndex
    || (anchorIndex === focusIndex && selection.anchor.offsetUtf16 <= selection.focus.offsetUtf16);
  const first = forward ? selection.anchor : selection.focus;
  const last = forward ? selection.focus : selection.anchor;
  const start = Math.min(anchorIndex, focusIndex);
  const end = Math.max(anchorIndex, focusIndex);
  for (let index = start; index <= end; index += 1) {
    const node = snapshot.nodes[index]!;
    if (node.kind === "opaque") {
      if (node.category !== "blank") throw new TypeError("Composer text selection crosses an opaque barrier");
    } else if (node.textEditing === null || node.body.resolvedMode !== anchor.body.resolvedMode) {
      throw new TypeError("Composer text selection crosses an incompatible body");
    }
  }
  return { first, last, start, end };
}

function textSelectionContent(selection: ComposerTextSelection, snapshot: ComposerDocumentSnapshot): string {
  const { first, last, start, end } = textSelectionExtent(selection, snapshot);
  const parts: string[] = [];
  for (let index = start; index <= end; index += 1) {
    const node = snapshot.nodes[index]!;
    if (node.kind === "opaque") continue;
    const text = node.textEditing!.text;
    parts.push(text.slice(index === start ? first.offsetUtf16 : 0, index === end ? last.offsetUtf16 : text.length));
  }
  return parts.join("\n");
}

function requireSnapshotIdentity(
  snapshot: ComposerDocumentSnapshot,
  expected: Pick<ComposerTextSelectionParams, "textDocument" | "sourceDigest">,
): void {
  if (snapshot.textDocument.uri !== expected.textDocument.uri
    || snapshot.textDocument.version !== expected.textDocument.version
    || snapshot.sourceDigest !== expected.sourceDigest) {
    throw new TypeError("Composer text snapshot identity is stale");
  }
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new TypeError(`${label} must be lowercase SHA-256`);
  return value;
}

function parseUri(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 16384 || !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f]*$/u.test(value)) {
    throw new TypeError(`${label} must be an absolute URI`);
  }
  return value;
}

function parseCollapsedRange(value: unknown, label: string): ProtocolRange {
  const range = parseRange(value, label);
  if (!samePosition(range.start, range.end)) throw new TypeError(`${label} must be collapsed`);
  return range;
}

function samePosition(left: ProtocolPosition, right: ProtocolPosition): boolean {
  return left.line === right.line && left.character === right.character;
}

function sameRange(left: ProtocolRange, right: ProtocolRange): boolean {
  return samePosition(left.start, right.start) && samePosition(left.end, right.end);
}

function sourceOffsetLookup(source: string): (position: ProtocolPosition) => number {
  const starts = [0];
  for (let offset = source.indexOf("\n"); offset >= 0; offset = source.indexOf("\n", offset + 1)) {
    starts.push(offset + 1);
  }
  return (position) => {
    const start = starts[position.line];
    if (start === undefined) throw new TypeError("Composer source position is past the document");
    const next = starts[position.line + 1];
    const newline = next === undefined ? source.length : next - 1;
    const lineEnd = next !== undefined && newline > start && source[newline - 1] === "\r" ? newline - 1 : newline;
    const offset = start + position.character;
    const previousUnit = source.charCodeAt(offset - 1);
    const currentUnit = source.charCodeAt(offset);
    if (offset > lineEnd || (previousUnit >= 0xd800 && previousUnit <= 0xdbff && currentUnit >= 0xdc00 && currentUnit <= 0xdfff)) {
      throw new TypeError("Composer source position is outside a line or inside a surrogate pair");
    }
    return offset;
  };
}

function nativeSourceSelection(value: ComposerSourceSelection, offsetAt: (position: ProtocolPosition) => number): Selection {
  const selection = requireRecord(value, "Composer source selection");
  requireExactKeys(selection, ["anchor", "focus"], "Composer source selection");
  const anchor = parsePosition(selection.anchor, "Composer source selection anchor");
  const focus = parsePosition(selection.focus, "Composer source selection focus");
  offsetAt(anchor);
  offsetAt(focus);
  return new Selection(anchor.line + 1, anchor.character + 1, focus.line + 1, focus.character + 1);
}

export async function applyComposerEdit(
  options: ApplyComposerEditOptions,
): Promise<ComposerEditApplicationResult> {
  const { client, workspace, result, signal } = options;
  const expected = parseTextDocument(options.textDocument, "Expected Composer text document");
  if (signal?.aborted) return CANCELLED;

  let converted: vscode.WorkspaceEdit;
  try {
    converted = await client.protocol2CodeConverter.asWorkspaceEdit(result.edit);
  } catch {
    return signal?.aborted ? CANCELLED : APPLY_FAILED;
  }
  if (signal?.aborted) return CANCELLED;

  const document = workspace.textDocuments.find(
    (candidate) => candidate.uri.toString() === expected.uri,
  );
  if (!document || document.version !== expected.version) return STALE;
  if (signal?.aborted) return CANCELLED;

  try {
    return await workspace.applyEdit(converted) ? APPLIED : APPLY_FAILED;
  } catch {
    return APPLY_FAILED;
  }
}

function parseComposerWorkspaceEdit(
  value: unknown,
  expected: ComposerTextDocument,
): ComposerWorkspaceEdit {
  const edit = requireRecord(value, "Composer WorkspaceEdit");
  requireExactKeys(edit, ["documentChanges"], "Composer WorkspaceEdit");
  if ("changes" in edit || "changeAnnotations" in edit || !Array.isArray(edit.documentChanges)
    || edit.documentChanges.length !== 1) {
    throw new TypeError("Composer WorkspaceEdit must contain exactly one documentChanges entry and no changes map");
  }

  const documentChange = requireRecord(edit.documentChanges[0], "Composer TextDocumentEdit");
  requireExactKeys(documentChange, ["textDocument", "edits"], "Composer TextDocumentEdit");
  const textDocument = parseTextDocument(documentChange.textDocument, "Composer TextDocumentEdit identifier");
  if (textDocument.uri !== expected.uri || textDocument.version !== expected.version) {
    throw new TypeError("Composer TextDocumentEdit does not match the requested document URI and version");
  }
  if (!Array.isArray(documentChange.edits)) {
    throw new TypeError("Composer TextDocumentEdit edits must be an array");
  }

  const edits = documentChange.edits.map((item, index): ProtocolTextEdit => {
    const textEdit = requireRecord(item, `Composer TextEdit ${index}`);
    requireExactKeys(textEdit, ["range", "newText"], `Composer TextEdit ${index}`);
    if (typeof textEdit.newText !== "string") {
      throw new TypeError(`Composer TextEdit ${index} newText must be a string`);
    }
    return {
      range: parseRange(textEdit.range, `Composer TextEdit ${index} range`),
      newText: textEdit.newText,
    };
  });

  return {
    documentChanges: [{ textDocument, edits }],
  };
}

function parseTextDocument(value: unknown, label: string): ComposerTextDocument {
  const textDocument = requireRecord(value, label);
  requireExactKeys(textDocument, ["uri", "version"], label);
  if (typeof textDocument.uri !== "string" || !isNonNegativeSafeInteger(textDocument.version)) {
    throw new TypeError(`${label} must contain a string URI and a non-negative integer version`);
  }
  return { uri: parseUri(textDocument.uri, `${label} URI`), version: textDocument.version };
}

function parseStatementTarget(value: unknown, label: string): ComposerStatementTarget {
  const target = requireRecord(value, label);
  requireExactKeys(target, ["kind", "range"], label);
  if (target.kind !== "statement") {
    throw new TypeError(`${label} must identify a statement`);
  }
  return { kind: "statement", range: parseRange(target.range, `${label} range`) };
}

function parseTargetProperties(value: unknown): PreviewComposerTargetProperties {
  const properties = requireRecord(value, "Editable Preview Composer properties");
  requireExactKeys(
    properties,
    [],
    "Editable Preview Composer properties",
    ["continued", "actorDisplayName", "actorAvatar", "statementText"],
  );
  const result: {
    continued?: StatementContinuedValue;
    actorDisplayName?: PreviewComposerTargetProperties["actorDisplayName"];
    actorAvatar?: PreviewComposerTargetProperties["actorAvatar"];
    statementText?: PreviewComposerTargetProperties["statementText"];
  } = {};
  if (Object.hasOwn(properties, "continued")) {
    if (!isAllowedString(properties.continued, CONTINUED_VALUES)) {
      throw new TypeError("Editable Preview Composer properties has an invalid continued value");
    }
    result.continued = properties.continued;
  }
  if (Object.hasOwn(properties, "actorDisplayName")) {
    const actorDisplayName = requireRecord(
      properties.actorDisplayName,
      "Editable Preview Composer actor display name",
    );
    requireExactKeys(
      actorDisplayName,
      ["current", "scope"],
      "Editable Preview Composer actor display name",
    );
    if (typeof actorDisplayName.current !== "string" || actorDisplayName.scope !== "fromStatement") {
      throw new TypeError("Editable Preview Composer actor display name is malformed");
    }
    result.actorDisplayName = {
      current: actorDisplayName.current,
      scope: "fromStatement",
    };
  }
  if (Object.hasOwn(properties, "actorAvatar")) {
    const actorAvatar = requireRecord(
      properties.actorAvatar,
      "Editable Preview Composer actor avatar",
    );
    requireExactKeys(
      actorAvatar,
      ["scope", "actorPresetId", "current"],
      "Editable Preview Composer actor avatar",
    );
    if (
      actorAvatar.scope !== "fromStatement"
      || !isCanonicalEntityId(actorAvatar.actorPresetId)
    ) {
      throw new TypeError("Editable Preview Composer actor avatar is malformed");
    }
    result.actorAvatar = {
      scope: "fromStatement",
      actorPresetId: actorAvatar.actorPresetId,
      current: actorAvatar.current === null
        ? null
        : parseComposerAvatarCurrent(actorAvatar.current),
    };
  }
  if (Object.hasOwn(properties, "statementText")) {
    const statementText = requireRecord(
      properties.statementText,
      "Editable Preview Composer statement text",
    );
    requireExactKeys(
      statementText,
      ["current", "mode", "resolvedMode", "inheritedMode"],
      "Editable Preview Composer statement text",
    );
    if (
      typeof statementText.current !== "string"
      || statementText.current.length === 0
      || UTF8_ENCODER.encode(statementText.current).length > MAX_COMPOSER_STATEMENT_TEXT_BYTES
      || statementText.current.includes("\r")
      || statementText.current.includes("\n")
      || !isAllowedString(statementText.mode, STATEMENT_TEXT_MODES)
      || !isAllowedString(statementText.resolvedMode, COMPOSER_BODY_MODES)
      || !isAllowedString(statementText.inheritedMode, COMPOSER_BODY_MODES)
    ) {
      throw new TypeError("Editable Preview Composer statement text is malformed");
    }
    const expectedResolvedMode = statementText.mode === "inherit"
      ? statementText.inheritedMode
      : statementText.mode;
    if (statementText.resolvedMode !== expectedResolvedMode) {
      throw new TypeError("Editable Preview Composer statement text modes are inconsistent");
    }
    result.statementText = {
      current: statementText.current,
      mode: statementText.mode,
      resolvedMode: statementText.resolvedMode,
      inheritedMode: statementText.inheritedMode,
    };
  }
  return result;
}


export function parseComposerAvatarChoice(value: unknown): ComposerAvatarChoice {
  const choice = requireRecord(value, "Composer pack avatar choice");
  requireExactKeys(
    choice,
    ["kind", "entityId", "contributionNamespace", "variantId"],
    "Composer pack avatar choice",
  );
  if (
    choice.kind !== "packAvatar"
    || !isCanonicalEntityId(choice.entityId)
    || !isAvatarComponent(choice.contributionNamespace)
    || choice.contributionNamespace.includes("::")
    || !isAvatarComponent(choice.variantId)
  ) {
    throw new TypeError("Composer pack avatar choice is malformed");
  }
  return {
    kind: "packAvatar",
    entityId: choice.entityId,
    contributionNamespace: choice.contributionNamespace,
    variantId: choice.variantId,
  };
}

function parseComposerAvatarCurrent(value: unknown): ComposerAvatarCurrent {
  const current = requireRecord(value, "Composer current avatar");
  if (current.kind === "packAvatar") return parseComposerAvatarChoice(current);
  requireExactKeys(current, ["kind", "assetName"], "Composer current avatar asset");
  if (current.kind !== "asset" || typeof current.assetName !== "string" || current.assetName.length === 0) {
    throw new TypeError("Composer current avatar asset is malformed");
  }
  return { kind: "asset", assetName: current.assetName };
}

function isCanonicalEntityId(value: unknown): value is string {
  if (!isAvatarComponent(value)) return false;
  const parts = value.split("::");
  return parts.length === 2 && parts.every((part) => part.length > 0);
}

function isAvatarComponent(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const byteLength = UTF8_ENCODER.encode(value).byteLength;
  return byteLength > 0
    && byteLength <= MAX_COMPOSER_AVATAR_COMPONENT_BYTES
    && !/[\p{White_Space}\p{Cc}]/u.test(value)
    && !value.includes("/")
    && !value.includes("\\");
}

function parseRange(value: unknown, label: string): ProtocolRange {
  const range = requireRecord(value, label);
  requireExactKeys(range, ["start", "end"], label);
  const start = parsePosition(range.start, `${label} start`);
  const end = parsePosition(range.end, `${label} end`);
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
    throw new TypeError(`${label} end precedes its start`);
  }
  return { start, end };
}

function parsePosition(value: unknown, label: string): ProtocolPosition {
  const position = requireRecord(value, label);
  requireExactKeys(position, ["line", "character"], label);
  if (!isNonNegativeSafeInteger(position.line) || !isNonNegativeSafeInteger(position.character)) {
    throw new TypeError(`${label} must contain non-negative integer coordinates`);
  }
  return { line: position.line, character: position.character };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const keys = Object.keys(value);
  if (!required.every((key) => Object.hasOwn(value, key))
    || keys.some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError(`${label} has missing or unknown properties`);
  }
}

function isAllowedString<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
): value is Values[number] {
  return typeof value === "string" && allowed.some((candidate) => candidate === value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
