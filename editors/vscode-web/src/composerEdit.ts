import type * as vscode from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";
import type {
  Position as ProtocolPosition,
  Range as ProtocolRange,
  TextDocumentEdit as ProtocolTextDocumentEdit,
  TextEdit as ProtocolTextEdit,
  WorkspaceEdit as ProtocolWorkspaceEdit,
} from "vscode-languageserver";

export type StatementContinuedValue = "auto" | "true" | "false";

export interface ComposerTextDocument {
  readonly uri: string;
  readonly version: number;
}

export interface ComposerStatementTarget {
  readonly kind: "statement";
  readonly range: ProtocolRange;
}

export interface PreviewComposerTargetProperties {
  readonly continued: StatementContinuedValue;
  readonly actorDisplayName?: {
    readonly current: string;
    readonly scope: "fromStatement";
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
    };

export interface ComposerEditParams {
  readonly textDocument: ComposerTextDocument;
  readonly target: ComposerStatementTarget;
  readonly command: ComposerEditCommand;
}

export type ComposerEditRejectedReason =
  | "staleDocument"
  | "targetChanged"
  | "documentHasErrors"
  | "invalidValue"
  | "actorUnavailable"
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
] as const;

const CONTINUED_VALUES = ["auto", "true", "false"] as const;
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
  if (result.kind !== "Edit") {
    throw new TypeError("Composer edit result has an unknown kind");
  }

  requireExactKeys(result, ["kind", "edit"], "Composer Edit result");
  return {
    kind: "Edit",
    edit: parseComposerWorkspaceEdit(result.edit, expected),
  };
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
  return { uri: textDocument.uri, version: textDocument.version };
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
    ["continued"],
    "Editable Preview Composer properties",
    ["actorDisplayName"],
  );
  if (!isAllowedString(properties.continued, CONTINUED_VALUES)) {
    throw new TypeError("Editable Preview Composer properties has an invalid continued value");
  }
  if (!Object.hasOwn(properties, "actorDisplayName")) {
    return { continued: properties.continued };
  }

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
  return {
    continued: properties.continued,
    actorDisplayName: {
      current: actorDisplayName.current,
      scope: "fromStatement",
    },
  };
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
