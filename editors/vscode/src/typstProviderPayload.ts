import type { TinymistRequestIdentity } from "./tinymistRequestDispatcher";
import type {
  TypstProviderCapabilityContract,
  TypstProviderMethod
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
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 4096) throw new UnsafeProviderPayloadError("provider command payload is too large");
    if (current === null || typeof current === "string" || typeof current === "boolean") continue;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new UnsafeProviderPayloadError("provider command payload contains a non-finite number");
      continue;
    }
    if (typeof current !== "object") {
      throw new UnsafeProviderPayloadError("provider command payload is not JSON-safe");
    }
    if (seen.has(current)) throw new UnsafeProviderPayloadError("provider command payload is cyclic");
    seen.add(current);
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new UnsafeProviderPayloadError("provider command payload contains a non-plain object");
    }
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new UnsafeProviderPayloadError("provider command payload contains an unsafe key");
      }
      pending.push(child);
    }
  }
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
