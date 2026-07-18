import type { TinymistRequestIdentity } from "./tinymistRequestDispatcher";
import {
  readTypstProviderResolveMetadata,
  type TypstProviderCapabilityContract,
  type TypstProviderMethod
} from "./typstProviderDescriptors";

export type TypstProviderPayloadTargetClass =
  | "StandaloneWritable"
  | "AuthoredMmt"
  | "WorkspaceTypst"
  | "PackageFile"
  | "GeneratedProjection"
  | "UnknownOrStale";

export interface TypstNestedEditPayload {
  readonly uri: unknown;
  readonly version: unknown;
  readonly range: unknown;
  readonly newText: unknown;
}

export interface TypstNestedCommandPayload {
  readonly command: unknown;
  readonly arguments?: unknown;
}

export interface TypstNestedUriPayload {
  readonly kind: "document" | "link-target";
  readonly uri: unknown;
}

export interface TypstProviderPayloadValidationInput {
  readonly method: TypstProviderMethod;
  readonly capability: TypstProviderCapabilityContract;
  readonly request: TinymistRequestIdentity;
  readonly current: TinymistRequestIdentity | undefined;
  readonly targetClass: TypstProviderPayloadTargetClass;
  readonly nestedEdits: readonly TypstNestedEditPayload[];
  readonly nestedCommands: readonly TypstNestedCommandPayload[];
  readonly nestedUris: readonly TypstNestedUriPayload[];
  readonly allowedCommands: readonly string[];
}

export interface ValidatedTypstProviderPayload {
  readonly kind: "Validated";
  readonly edits: readonly ValidatedNestedEdit[];
  readonly commands: readonly ValidatedNestedCommand[];
  readonly uris: readonly ValidatedNestedUri[];
}

export interface UnsafeTypstProviderPayload {
  readonly kind: "UnsafeEdit";
  readonly reason: string;
}

export interface StaleTypstProviderPayload {
  readonly kind: "StaleProjection";
  readonly reason: string;
}

export interface ReadOnlyTypstProviderPayload {
  readonly kind: "ReadOnlyTarget";
  readonly targetClass: "PackageFile" | "GeneratedProjection";
}

export interface UnavailableTypstProviderPayload {
  readonly kind: "CapabilityUnavailable";
  readonly method: TypstProviderMethod;
  readonly reason: string;
}

export type TypstProviderPayloadValidationResult =
  | ValidatedTypstProviderPayload
  | UnsafeTypstProviderPayload
  | StaleTypstProviderPayload
  | ReadOnlyTypstProviderPayload
  | UnavailableTypstProviderPayload;

interface ValidatedNestedEdit {
  readonly uri: string;
  readonly version: number;
  readonly range: ValidatedRange;
  readonly newText: string;
}

interface ValidatedNestedCommand {
  readonly command: string;
  readonly arguments: readonly unknown[];
}

interface ValidatedNestedUri {
  readonly kind: "document" | "link-target";
  readonly uri: string;
}

interface ValidatedPosition {
  readonly line: number;
  readonly character: number;
}

interface ValidatedRange {
  readonly start: ValidatedPosition;
  readonly end: ValidatedPosition;
}

const DOCUMENT_URI_SCHEMES: Readonly<Record<string, true>> = Object.freeze({
  file: true,
  mmtfs: true,
  mmt: true,
  "mmt-projection": true,
  "mmt-package": true
});
const LINK_URI_SCHEMES: Readonly<Record<string, true>> = Object.freeze({
  ...DOCUMENT_URI_SCHEMES,
  http: true,
  https: true,
  mailto: true
});

/**
 * Validates one complete nested provider payload. It never applies or partially
 * returns edits: every field succeeds or one typed refusal is returned.
 */
export function validateTypstProviderPayload(
  input: TypstProviderPayloadValidationInput
): TypstProviderPayloadValidationResult {
  if (input.capability.kind !== "QualifiedProvider" || input.capability.descriptor.method !== input.method) {
    return Object.freeze({
      kind: "CapabilityUnavailable" as const,
      method: input.method,
      reason: input.capability.kind === "CapabilityUnavailable"
        ? input.capability.reason
        : `qualified capability does not match ${input.method}`
    });
  }
  if (!input.current || !requestIdentitiesEqual(input.request, input.current)) {
    return Object.freeze({ kind: "StaleProjection" as const, reason: "provider request snapshot is no longer current" });
  }
  if (input.targetClass === "UnknownOrStale") {
    return Object.freeze({ kind: "StaleProjection" as const, reason: "provider payload target is unknown or stale" });
  }
  if (input.nestedEdits.length > 0
    && (input.targetClass === "PackageFile" || input.targetClass === "GeneratedProjection")) {
    return Object.freeze({ kind: "ReadOnlyTarget" as const, targetClass: input.targetClass });
  }

  const allowedCommands: Readonly<Record<string, true>> = Object.freeze(Object.fromEntries(
    input.allowedCommands.map((command) => [command, true] as const)
  ));
  const edits: ValidatedNestedEdit[] = [];
  const commands: ValidatedNestedCommand[] = [];
  const uris: ValidatedNestedUri[] = [];
  try {
    for (const value of input.nestedUris) {
      uris.push(Object.freeze({ kind: value.kind, uri: validatedUri(value.uri, value.kind) }));
    }
    for (const value of input.nestedCommands) {
      if (typeof value.command !== "string" || allowedCommands[value.command] !== true) {
        throw new UnsafeProviderPayloadError("provider command is not allowlisted");
      }
      if (value.arguments !== undefined && !Array.isArray(value.arguments)) {
        throw new UnsafeProviderPayloadError("provider command arguments must be an array");
      }
      const args = value.arguments ?? [];
      validateJsonPayload(args);
      commands.push(Object.freeze({ command: value.command, arguments: Object.freeze([...args]) }));
    }
    for (const value of input.nestedEdits) {
      const uri = validatedUri(value.uri, "document");
      if (!Number.isInteger(value.version) || (value.version as number) < 0) {
        throw new UnsafeProviderPayloadError("provider edit is missing a non-negative document version");
      }
      if (uri === input.request.sourceStaleToken.hostUri
        && value.version !== input.request.sourceStaleToken.documentVersion) {
        throw new UnsafeProviderPayloadError("provider edit version does not match its request snapshot");
      }
      if (typeof value.newText !== "string") {
        throw new UnsafeProviderPayloadError("provider edit newText must be a string");
      }
      edits.push(Object.freeze({
        uri,
        version: value.version as number,
        range: validatedRange(value.range),
        newText: value.newText
      }));
    }
    rejectOverlappingEdits(edits);
  } catch (error) {
    if (error instanceof UnsafeProviderPayloadError) {
      return Object.freeze({ kind: "UnsafeEdit" as const, reason: error.message });
    }
    throw error;
  }

  return Object.freeze({
    kind: "Validated" as const,
    edits: Object.freeze(edits),
    commands: Object.freeze(commands),
    uris: Object.freeze(uris)
  });
}

class UnsafeProviderPayloadError extends Error {}

function validatedUri(value: unknown, kind: TypstNestedUriPayload["kind"]): string {
  if (typeof value !== "string"
    || value.length === 0
    || /[\u0000-\u001f\u007f\\]/u.test(value)
    || /%(?:0[0-9a-f]|1[0-9a-f]|5c|7f)/iu.test(value)) {
    throw new UnsafeProviderPayloadError("provider URI is malformed");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new UnsafeProviderPayloadError("provider URI is not absolute");
  }
  const scheme = parsed.protocol.slice(0, -1);
  const allowed = kind === "document" ? DOCUMENT_URI_SCHEMES : LINK_URI_SCHEMES;
  if (allowed[scheme] !== true
    || parsed.username !== ""
    || parsed.password !== ""
    || (kind === "document" && (parsed.search !== "" || parsed.hash !== ""))) {
    throw new UnsafeProviderPayloadError("provider URI uses an unsafe scheme, authority, query, or fragment");
  }
  if (parsed.href !== value) {
    throw new UnsafeProviderPayloadError("provider URI is not normalized");
  }
  return value;
}

function validatedRange(value: unknown): ValidatedRange {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnsafeProviderPayloadError("provider edit range is malformed");
  }
  const record = value as Record<string, unknown>;
  const start = validatedPosition(record.start);
  const end = validatedPosition(record.end);
  if (comparePosition(start, end) > 0) {
    throw new UnsafeProviderPayloadError("provider edit range is reversed");
  }
  return Object.freeze({ start, end });
}

function validatedPosition(value: unknown): ValidatedPosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnsafeProviderPayloadError("provider edit position is malformed");
  }
  const record = value as Record<string, unknown>;
  if (!Number.isSafeInteger(record.line) || (record.line as number) < 0
    || !Number.isSafeInteger(record.character) || (record.character as number) < 0) {
    throw new UnsafeProviderPayloadError("provider edit position is invalid");
  }
  return Object.freeze({ line: record.line as number, character: record.character as number });
}

function rejectOverlappingEdits(edits: readonly ValidatedNestedEdit[]): void {
  const sorted = [...edits].sort((left, right) => left.uri.localeCompare(right.uri)
    || comparePosition(left.range.start, right.range.start)
    || comparePosition(left.range.end, right.range.end));
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.uri === current.uri
      && (comparePosition(current.range.start, previous.range.end) < 0
        || comparePosition(current.range.start, previous.range.start) === 0)) {
      throw new UnsafeProviderPayloadError("provider edits overlap");
    }
  }
}

function comparePosition(left: ValidatedPosition, right: ValidatedPosition): number {
  return left.line - right.line || left.character - right.character;
}

function validateJsonPayload(value: unknown): void {
  const active = new Set<object>();
  let visited = 0;
  const visit = (current: unknown): void => {
    visited += 1;
    if (visited > 4096) throw new UnsafeProviderPayloadError("provider command payload is too large");
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new UnsafeProviderPayloadError("provider command payload contains a non-finite number");
      return;
    }
    if (typeof current !== "object") {
      throw new UnsafeProviderPayloadError("provider command payload is not JSON-safe");
    }
    if (active.has(current)) throw new UnsafeProviderPayloadError("provider command payload is cyclic");
    active.add(current);
    if (Array.isArray(current)) {
      for (const child of current) visit(child);
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new UnsafeProviderPayloadError("provider command payload contains a non-plain object");
      }
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          throw new UnsafeProviderPayloadError("provider command payload contains an unsafe key");
        }
        visit(child);
      }
    }
    active.delete(current);
  };
  visit(value);
}

function requestIdentitiesEqual(left: TinymistRequestIdentity, right: TinymistRequestIdentity): boolean {
  return left.backendGeneration === right.backendGeneration
    && left.logicalSource === right.logicalSource
    && left.sourceContent === right.sourceContent
    && left.sourceStaleToken.hostUri === right.sourceStaleToken.hostUri
    && left.sourceStaleToken.documentIncarnation === right.sourceStaleToken.documentIncarnation
    && left.sourceStaleToken.documentVersion === right.sourceStaleToken.documentVersion
    && left.projectSnapshot === right.projectSnapshot
    && left.projectionKey === right.projectionKey;
}


export interface TypstProviderItemPayloadValidationInput
  extends Omit<TypstProviderPayloadValidationInput, "nestedEdits" | "nestedCommands" | "nestedUris"> {
  readonly item: unknown;
}

export interface StrippedTypstProviderPayloadField {
  readonly path: string;
  readonly reason: string;
}

export interface ValidatedTypstProviderItemPayload extends ValidatedTypstProviderPayload {
  readonly value: unknown;
  readonly strippedFields: readonly StrippedTypstProviderPayloadField[];
}

export type TypstProviderItemPayloadValidationResult =
  | ValidatedTypstProviderItemPayload
  | UnsafeTypstProviderPayload
  | StaleTypstProviderPayload
  | ReadOnlyTypstProviderPayload
  | UnavailableTypstProviderPayload;

interface NestedPayloadCollection {
  readonly edits: TypstNestedEditPayload[];
  readonly commands: TypstNestedCommandPayload[];
  readonly uris: TypstNestedUriPayload[];
}

interface SanitizedProviderItem {
  readonly value: unknown;
  readonly stripped: StrippedTypstProviderPayloadField[];
}

/**
 * Validates and sanitizes one complete protocol item. Nested payloads are first
 * collected with method-specific protocol rules, then committed through the
 * W3-0 atomic snapshot/target/allowlist validator in one operation.
 */
export function validateTypstProviderItemPayload(
  input: TypstProviderItemPayloadValidationInput
): TypstProviderItemPayloadValidationResult {
  const collection: NestedPayloadCollection = { edits: [], commands: [], uris: [] };
  let sanitized: SanitizedProviderItem;
  try {
    sanitized = collectProviderItem(input, collection);
    validateJsonPayload(sanitized.value);
  } catch (error) {
    if (error instanceof UnsafeProviderPayloadError) {
      return Object.freeze({ kind: "UnsafeEdit" as const, reason: error.message });
    }
    throw error;
  }
  const atomic = validateTypstProviderPayload({
    ...input,
    nestedEdits: collection.edits,
    nestedCommands: collection.commands,
    nestedUris: collection.uris
  });
  if (atomic.kind !== "Validated") return atomic;
  return Object.freeze({
    ...atomic,
    value: deepFreezeJson(sanitized.value),
    strippedFields: Object.freeze(sanitized.stripped.map((field) => Object.freeze(field)))
  });
}

function collectProviderItem(
  input: TypstProviderItemPayloadValidationInput,
  collection: NestedPayloadCollection
): SanitizedProviderItem {
  const item = requirePayloadRecord(input.item, "provider item");
  if (isResolveMethod(input.method)) validateResolveData(input, item);
  switch (input.method) {
    case "textDocument/documentLink":
    case "documentLink/resolve":
      return collectDocumentLink(item, input, collection);
    case "textDocument/colorPresentation":
      return collectColorPresentation(item, input, collection);
    case "textDocument/inlayHint":
    case "inlayHint/resolve":
      return collectInlayHint(item, input, collection);
    case "textDocument/codeLens":
    case "codeLens/resolve":
      return collectCodeLens(item, input, collection);
    case "textDocument/codeAction":
    case "codeAction/resolve":
      return collectCodeAction(item, input, collection);
    default:
      throw new UnsafeProviderPayloadError(`${input.method} has no nested provider-payload contract`);
  }
}

function collectDocumentLink(
  item: Record<string, unknown>,
  input: TypstProviderItemPayloadValidationInput,
  collection: NestedPayloadCollection
): SanitizedProviderItem {
  const value = { ...item };
  const stripped: StrippedTypstProviderPayloadField[] = [];
  if (item.target !== undefined) {
    try {
      const uri = validatedUri(item.target, "link-target");
      rejectHostPathOutsideRequest(uri, input);
      if (/^(?:https?|mailto):/iu.test(uri)) {
        throw new UnsafeProviderPayloadError("provider link target would perform network or external-host I/O");
      }
      collection.uris.push({ kind: "link-target", uri });
    } catch (error) {
      if (!(error instanceof UnsafeProviderPayloadError)) throw error;
      delete value.target;
      stripped.push({ path: "target", reason: `optional document-link target stripped: ${error.message}` });
    }
  }
  if (value.target === undefined && value.tooltip === undefined && value.data === undefined) {
    throw new UnsafeProviderPayloadError("document link is meaningless after removing its unsafe target");
  }
  return { value, stripped };
}

function collectColorPresentation(
  item: Record<string, unknown>,
  input: TypstProviderItemPayloadValidationInput,
  collection: NestedPayloadCollection
): SanitizedProviderItem {
  requireNonEmptyString(item.label, "color presentation label");
  if (item.textEdit !== undefined) collectImplicitTextEdit(item.textEdit, input, collection, "textEdit");
  if (item.additionalTextEdits !== undefined) {
    for (const [index, edit] of requirePayloadArray(item.additionalTextEdits, "additionalTextEdits").entries()) {
      collectImplicitTextEdit(edit, input, collection, `additionalTextEdits[${index}]`);
    }
  }
  return { value: { ...item }, stripped: [] };
}

function collectInlayHint(
  item: Record<string, unknown>,
  input: TypstProviderItemPayloadValidationInput,
  collection: NestedPayloadCollection
): SanitizedProviderItem {
  const value = { ...item };
  const stripped: StrippedTypstProviderPayloadField[] = [];
  if (typeof item.label !== "string" && !Array.isArray(item.label)) {
    throw new UnsafeProviderPayloadError("inlay hint label is malformed");
  }
  if (Array.isArray(item.label)) {
    value.label = item.label.map((partValue, index) => {
      const part = requirePayloadRecord(partValue, `label[${index}]`);
      requireNonEmptyString(part.value, `label[${index}].value`);
      const safePart = { ...part };
      if (part.location !== undefined) {
        try {
          const location = requirePayloadRecord(part.location, `label[${index}].location`);
          const uri = requireNonEmptyString(location.uri, `label[${index}].location.uri`);
          validatedUri(uri, "document");
          rejectHostPathOutsideRequest(uri, input);
          collection.uris.push({ kind: "document", uri });
          validatedRange(location.range);
        } catch (error) {
          if (!(error instanceof UnsafeProviderPayloadError)) throw error;
          delete safePart.location;
          stripped.push({ path: `label[${index}].location`, reason: `optional inlay-hint location stripped: ${error.message}` });
        }
      }
      if (part.command !== undefined) {
        if (commandIsIndividuallySafe(part.command, input)) {
          collection.commands.push(commandPayload(part.command, `label[${index}].command`));
        } else {
          delete safePart.command;
          stripped.push({ path: `label[${index}].command`, reason: "optional inlay-hint command stripped: command is unsafe or unavailable" });
        }
      }
      return safePart;
    });
  }
  if (item.textEdits !== undefined) {
    const pending: TypstNestedEditPayload[] = [];
    try {
      for (const [index, edit] of requirePayloadArray(item.textEdits, "textEdits").entries()) {
        collectImplicitTextEdit(edit, input, { ...collection, edits: pending }, `textEdits[${index}]`);
      }
      const optionalValidation = validateTypstProviderPayload({
        ...input,
        nestedEdits: pending,
        nestedCommands: [],
        nestedUris: []
      });
      if (optionalValidation.kind !== "Validated") {
        throw new UnsafeProviderPayloadError(`nested edit validation returned ${optionalValidation.kind}`);
      }
      collection.edits.push(...pending);
    } catch (error) {
      if (!(error instanceof UnsafeProviderPayloadError)) throw error;
      delete value.textEdits;
      stripped.push({ path: "textEdits", reason: `optional inlay-hint text edits stripped: ${error.message}` });
    }
  }
  return { value, stripped };
}

function collectCodeLens(
  item: Record<string, unknown>,
  input: TypstProviderItemPayloadValidationInput,
  collection: NestedPayloadCollection
): SanitizedProviderItem {
  const value = { ...item };
  const stripped: StrippedTypstProviderPayloadField[] = [];
  if (item.command !== undefined) {
    if (commandIsIndividuallySafe(item.command, input)) {
      collection.commands.push(commandPayload(item.command, "command"));
    } else if (item.data !== undefined && !isResolveMethod(input.method)) {
      delete value.command;
      stripped.push({ path: "command", reason: "optional unresolved code-lens command stripped: command is unsafe or unavailable" });
    } else {
      throw new UnsafeProviderPayloadError("code lens is meaningless without a safe command or resolvable data");
    }
  }
  if (value.command === undefined && value.data === undefined) {
    throw new UnsafeProviderPayloadError("code lens is meaningless without a command or resolvable data");
  }
  return { value, stripped };
}

function collectCodeAction(
  item: Record<string, unknown>,
  input: TypstProviderItemPayloadValidationInput,
  collection: NestedPayloadCollection
): SanitizedProviderItem {
  requireNonEmptyString(item.title, "code action title");
  const value = { ...item };
  const stripped: StrippedTypstProviderPayloadField[] = [];
  if (item.diagnostics !== undefined) {
    for (const [index, diagnosticValue] of requirePayloadArray(item.diagnostics, "diagnostics").entries()) {
      const diagnostic = requirePayloadRecord(diagnosticValue, `diagnostics[${index}]`);
      validatedRange(diagnostic.range);
      requireNonEmptyString(diagnostic.message, `diagnostics[${index}].message`);
      if (diagnostic.data !== undefined) validateJsonPayload(diagnostic.data);
    }
  }
  if (item.edit !== undefined) collectWorkspaceEdit(item.edit, input, collection);
  if (item.command !== undefined) {
    if (commandIsIndividuallySafe(item.command, input)) {
      collection.commands.push(commandPayload(item.command, "command"));
    } else if (item.edit !== undefined || item.disabled !== undefined) {
      delete value.command;
      stripped.push({ path: "command", reason: "optional code-action command stripped: command is unsafe or unavailable" });
    } else {
      throw new UnsafeProviderPayloadError("command-only code action carries an unsafe command");
    }
  }
  if (item.edit === undefined && value.command === undefined && item.disabled === undefined) {
    throw new UnsafeProviderPayloadError("code action has no safe edit, command, or disabled reason");
  }
  return { value, stripped };
}

function collectWorkspaceEdit(
  value: unknown,
  input: TypstProviderItemPayloadValidationInput,
  collection: NestedPayloadCollection
): void {
  const workspaceEdit = requirePayloadRecord(value, "workspace edit");
  if (workspaceEdit.changes !== undefined) {
    throw new UnsafeProviderPayloadError("unversioned WorkspaceEdit.changes cannot be bound to the request snapshot");
  }
  const changes = requirePayloadArray(workspaceEdit.documentChanges, "WorkspaceEdit.documentChanges");
  if (changes.length === 0) throw new UnsafeProviderPayloadError("workspace edit is empty");
  for (const [changeIndex, changeValue] of changes.entries()) {
    const change = requirePayloadRecord(changeValue, `documentChanges[${changeIndex}]`);
    if (change.kind === "create" || change.kind === "rename" || change.kind === "delete") {
      throw new UnsafeProviderPayloadError("workspace resource operations are host-path effects and are not publishable");
    }
    const document = requirePayloadRecord(change.textDocument, `documentChanges[${changeIndex}].textDocument`);
    const uri = requireNonEmptyString(document.uri, `documentChanges[${changeIndex}].textDocument.uri`);
    if (uri !== input.request.sourceStaleToken.hostUri) {
      throw new UnsafeProviderPayloadError("workspace edit targets a document outside the captured request identity");
    }
    const edits = requirePayloadArray(change.edits, `documentChanges[${changeIndex}].edits`);
    if (edits.length === 0) throw new UnsafeProviderPayloadError("text document edit is empty");
    for (const edit of edits) {
      const textEdit = requirePayloadRecord(edit, "workspace text edit");
      collection.edits.push({ uri, version: document.version, range: textEdit.range, newText: textEdit.newText });
    }
  }
}

function collectImplicitTextEdit(
  value: unknown,
  input: TypstProviderItemPayloadValidationInput,
  collection: NestedPayloadCollection,
  path: string
): void {
  const edit = requirePayloadRecord(value, path);
  collection.edits.push({
    uri: input.request.sourceStaleToken.hostUri,
    version: input.request.sourceStaleToken.documentVersion,
    range: edit.range,
    newText: edit.newText
  });
}

function commandIsIndividuallySafe(value: unknown, input: TypstProviderItemPayloadValidationInput): boolean {
  try {
    const command = commandPayload(value, "command");
    if (!input.allowedCommands.includes(command.command as string) || commandHasForbiddenEffect(command.command as string)) return false;
    validateJsonPayload(command.arguments ?? []);
    rejectEffectfulArguments(command.arguments ?? []);
    return true;
  } catch (error) {
    if (error instanceof UnsafeProviderPayloadError) return false;
    throw error;
  }
}

function commandPayload(value: unknown, path: string): TypstNestedCommandPayload {
  const command = requirePayloadRecord(value, path);
  return {
    command: requireNonEmptyString(command.command, `${path}.command`),
    ...(command.arguments === undefined ? {} : { arguments: command.arguments })
  };
}

function commandHasForbiddenEffect(command: string): boolean {
  // Even an accidentally configured allowlist must not authorize host I/O.
  return /(?:shell|terminal|process|execute|clipboard|openexternal|openurl|download|upload)/iu.test(command);
}

function rejectHostPathOutsideRequest(uri: string, input: TypstProviderItemPayloadValidationInput): void {
  if (uri.startsWith("file:") && uri !== input.request.sourceStaleToken.hostUri) {
    throw new UnsafeProviderPayloadError("provider URI exposes a host path outside the captured request identity");
  }
}

function rejectEffectfulArguments(value: unknown): void {
  const pending = [value];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string") {
      if (/^(?:https?|ftp|file|vscode|command|clipboard|data|javascript):/iu.test(current)
        || /^(?:\.{1,2}[/\\]|~[/\\]|[/\\]{1,2})/u.test(current)
        || /^[a-z]:[\\/]/iu.test(current)) {
        throw new UnsafeProviderPayloadError("provider command argument carries a host-path or external-I/O effect");
      }
      continue;
    }
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
    } else {
      for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
        if (typeof child === "string"
          && /(?:path|uri|url|shell|terminal|clipboard|process|executable|command)/iu.test(key)) {
          throw new UnsafeProviderPayloadError("provider command argument declares a host-I/O effect");
        }
        pending.push(child);
      }
    }
  }
}

function validateResolveData(input: TypstProviderItemPayloadValidationInput, item: Record<string, unknown>): void {
  const metadata = readTypstProviderResolveMetadata(input.method, item);
  if (!metadata) throw new UnsafeProviderPayloadError("resolve item is missing authenticated request metadata");
  if (!requestIdentitiesEqual(metadata.identity, input.request)) {
    throw new UnsafeProviderPayloadError("resolve metadata does not match its captured request identity");
  }
  validateJsonPayload(metadata.backendData);
}

function isResolveMethod(method: TypstProviderMethod): boolean {
  return method === "documentLink/resolve"
    || method === "codeAction/resolve"
    || method === "inlayHint/resolve"
    || method === "codeLens/resolve";
}

function requirePayloadRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnsafeProviderPayloadError(`${path} is malformed`);
  }
  return value as Record<string, unknown>;
}

function requirePayloadArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new UnsafeProviderPayloadError(`${path} must be an array`);
  return value;
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new UnsafeProviderPayloadError(`${path} must be a non-empty string`);
  }
  return value;
}

function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return value;
}