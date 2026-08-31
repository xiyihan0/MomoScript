import type { Position, Range } from "vscode-languageserver";

import type {
  ComposerAvatarCurrent,
  ComposerBodyMode,
  StatementContinuedValue,
  StatementTextMode,
} from "./composerEdit";

export type ComposerNodeKind = "message" | "narration" | "opaque";
export type ComposerOpaqueCategory =
  | "blank"
  | "comment"
  | "directive"
  | "recoverableError"
  | "unsupported";
export type ComposerMessageSide = "left" | "right";
export type ComposerSpeakerSource = "scriptActor" | "packEntity";

export interface ComposerNodeRef {
  readonly nodeKey: string;
  readonly nodeKind: ComposerNodeKind;
  readonly range: Range;
}

export interface ComposerBoundaryTarget {
  readonly kind: "boundary";
  readonly before: ComposerNodeRef | null;
  readonly after: ComposerNodeRef | null;
}

export interface ComposerStatementBody {
  readonly current: string;
  readonly mode: StatementTextMode;
  readonly resolvedMode: ComposerBodyMode | null;
  readonly inheritedMode: ComposerBodyMode | null;
}

export type ComposerSpeaker =
  | {
      readonly kind: "actor";
      readonly reference: string;
      readonly displayName: string;
      readonly primaryName: string;
      readonly presetId: string;
      readonly avatar: ComposerAvatarCurrent | null;
    }
  | { readonly kind: "builtin"; readonly id: string };

export interface ComposerMessageCapabilities {
  readonly setBody: boolean;
  readonly setContinued: boolean;
  readonly setDisplayName: boolean;
  readonly setAvatar: boolean;
  readonly setSpeaker: boolean;
  readonly delete: boolean;
  readonly moveUp: ComposerBoundaryTarget | null;
  readonly moveDown: ComposerBoundaryTarget | null;
}

export interface ComposerNarrationCapabilities {
  readonly setBody: boolean;
  readonly delete: boolean;
  readonly moveUp: ComposerBoundaryTarget | null;
  readonly moveDown: ComposerBoundaryTarget | null;
}

export type ComposerDocumentNode =
  | {
      readonly kind: "message";
      readonly nodeKey: string;
      readonly range: Range;
      readonly statementRange: Range;
      readonly side: ComposerMessageSide;
      readonly speaker: ComposerSpeaker | null;
      readonly body: ComposerStatementBody;
      readonly continued: StatementContinuedValue | null;
      readonly actorDisplayName: string | null;
      readonly actorAvatar: {
        readonly scope: "fromStatement";
        readonly actorPresetId: string;
        readonly current: ComposerAvatarCurrent | null;
      } | null;
      readonly capabilities: ComposerMessageCapabilities;
    }
  | {
      readonly kind: "narration";
      readonly nodeKey: string;
      readonly range: Range;
      readonly statementRange: Range;
      readonly body: ComposerStatementBody;
      readonly capabilities: ComposerNarrationCapabilities;
    }
  | {
      readonly kind: "opaque";
      readonly nodeKey: string;
      readonly range: Range;
      readonly category: ComposerOpaqueCategory;
      readonly sourcePreview: string;
      readonly sourceTruncated: boolean;
      readonly summary: string;
      readonly canOpenSource: true;
    };

export interface ComposerInsertCapability {
  readonly boundary: ComposerBoundaryTarget;
  readonly messageSides: readonly ComposerMessageSide[];
  readonly statementModes: readonly StatementTextMode[];
  readonly speakerSources: readonly ComposerSpeakerSource[];
  readonly narration: boolean;
}

export interface ComposerBoundary {
  readonly target: ComposerBoundaryTarget;
  readonly insert: ComposerInsertCapability | null;
}

export interface ComposerScriptActorChoice {
  readonly reference: string;
  readonly displayName: string;
  readonly primaryName: string;
  readonly presetId: string;
  readonly avatar: ComposerAvatarCurrent | null;
}

export interface ComposerDocumentSnapshot {
  readonly kind: "Snapshot";
  readonly textDocument: { readonly uri: string; readonly version: number };
  readonly sourceDigest: string;
  readonly nodes: readonly ComposerDocumentNode[];
  readonly boundaries: readonly ComposerBoundary[];
  readonly scriptActorChoices: readonly ComposerScriptActorChoice[];
}

export type ComposerDocumentResult =
  | ComposerDocumentSnapshot
  | {
      readonly kind: "Rejected";
      readonly reason: "staleDocument" | "documentUnavailable";
    };

export interface ComposerTextDocumentLike {
  readonly uri: { toString(): string };
  readonly version: number;
  getText(): string;
  offsetAt(position: Position): number;
  positionAt(offset: number): Position;
}

const NODE_KINDS = ["message", "narration", "opaque"] as const;
const OPAQUE_CATEGORIES = [
  "blank",
  "comment",
  "directive",
  "recoverableError",
  "unsupported",
] as const;
const MESSAGE_SIDES = ["left", "right"] as const;
const SPEAKER_SOURCES = ["scriptActor", "packEntity"] as const;
const TEXT_MODES = ["inherit", "textMacro", "textRaw", "typstMacro", "typstRaw"] as const;
const BODY_MODES = ["textMacro", "textRaw", "typstMacro", "typstRaw"] as const;
const CONTINUED_VALUES = ["auto", "true", "false"] as const;
const REJECTED_REASONS = ["staleDocument", "documentUnavailable"] as const;
const MAX_NODE_COUNT = 100_000;
const MAX_ACTOR_CHOICES = 10_000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_PRODUCT_STRING_BYTES = 4096;
const MAX_OPAQUE_PREVIEW_BYTES = 4096;
const MAX_OPAQUE_SUMMARY_SCALARS = 160;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const UTF8 = new TextEncoder();

export function parseComposerDocumentResult(value: unknown): ComposerDocumentResult {
  const record = requireRecord(value, "Composer document result");
  if (record.kind === "Rejected") {
    requireExactKeys(record, ["kind", "reason"], "Composer document rejection");
    if (!isAllowedString(record.reason, REJECTED_REASONS)) {
      throw new Error("Composer document rejection reason is invalid");
    }
    return Object.freeze({ kind: "Rejected", reason: record.reason });
  }
  if (record.kind !== "Snapshot") {
    throw new Error("Composer document result kind is invalid");
  }
  requireExactKeys(
    record,
    ["kind", "textDocument", "sourceDigest", "nodes", "boundaries", "scriptActorChoices"],
    "Composer document snapshot",
  );
  const textDocument = parseTextDocument(record.textDocument);
  if (typeof record.sourceDigest !== "string" || !DIGEST_PATTERN.test(record.sourceDigest)) {
    throw new Error("Composer sourceDigest must be lowercase SHA-256");
  }
  const rawNodes = requireBoundedArray(record.nodes, MAX_NODE_COUNT, "Composer nodes");
  const nodes = rawNodes.map((node, index) => parseNode(node, `Composer nodes[${index}]`));
  const keys = new Set(nodes.map((node) => node.nodeKey));
  if (keys.size !== nodes.length) throw new Error("Composer nodeKey values must be unique");
  const rawBoundaries = requireBoundedArray(
    record.boundaries,
    MAX_NODE_COUNT + 1,
    "Composer boundaries",
  );
  if (rawBoundaries.length !== nodes.length + 1) {
    throw new Error("Composer boundaries must contain exactly nodes.length + 1 entries");
  }
  const boundaries = rawBoundaries.map((boundary, index) =>
    parseBoundary(boundary, `Composer boundaries[${index}]`),
  );
  const rawChoices = requireBoundedArray(
    record.scriptActorChoices,
    MAX_ACTOR_CHOICES,
    "Composer scriptActorChoices",
  );
  const scriptActorChoices = rawChoices.map((choice, index) =>
    parseScriptActorChoice(choice, `Composer scriptActorChoices[${index}]`),
  );
  const references = new Set(scriptActorChoices.map((choice) => choice.reference));
  if (references.size !== scriptActorChoices.length) {
    throw new Error("Composer script actor references must be unique");
  }
  return deepFreeze({
    kind: "Snapshot" as const,
    textDocument,
    sourceDigest: record.sourceDigest,
    nodes,
    boundaries,
    scriptActorChoices,
  });
}

export async function validateComposerSnapshotAgainstDocument(
  snapshot: ComposerDocumentSnapshot,
  document: ComposerTextDocumentLike,
): Promise<void> {
  const text = document.getText();
  if (snapshot.textDocument.uri !== document.uri.toString() || snapshot.textDocument.version !== document.version) {
    throw new Error("Composer snapshot document identity is stale");
  }
  const digest = await composerDocumentSourceDigest(text);
  if (snapshot.sourceDigest !== digest) throw new Error("Composer snapshot sourceDigest does not match");

  const offsets = snapshot.nodes.map((node, index) => ({
    node,
    start: reversibleOffset(document, node.range.start, `Composer nodes[${index}].range.start`),
    end: reversibleOffset(document, node.range.end, `Composer nodes[${index}].range.end`),
  }));
  if (text.length === 0) {
    if (offsets.length !== 0) throw new Error("Empty Composer document must have zero nodes");
  } else {
    if (offsets.length === 0 || offsets[0]?.start !== 0) {
      throw new Error("Composer nodes must start at document offset zero");
    }
    if (offsets[offsets.length - 1]?.end !== text.length) {
      throw new Error("Composer nodes must end at the current document length");
    }
  }
  for (let index = 0; index < offsets.length; index += 1) {
    const current = offsets[index]!;
    if (current.start >= current.end) throw new Error("Composer node ranges must be nonempty");
    if (index > 0 && offsets[index - 1]!.end !== current.start) {
      throw new Error("Composer node ranges must be ordered and adjacent");
    }
    if (current.node.kind !== "opaque") {
      const statementStart = reversibleOffset(
        document,
        current.node.statementRange.start,
        `Composer nodes[${index}].statementRange.start`,
      );
      const statementEnd = reversibleOffset(
        document,
        current.node.statementRange.end,
        `Composer nodes[${index}].statementRange.end`,
      );
      if (statementStart < current.start || statementStart >= current.end || statementStart >= statementEnd || statementEnd > text.length) {
        throw new Error("Composer statementRange is outside the authored document");
      }
      if (statementEnd > current.end) {
        let covered = current.end;
        let following = index + 1;
        while (covered < statementEnd) {
          const blank = offsets[following];
          if (
            !blank
            || blank.node.kind !== "opaque"
            || blank.node.category !== "blank"
            || blank.start !== covered
          ) {
            throw new Error("Composer statementRange may extend only across adjacent blank nodes");
          }
          if (blank.end <= statementEnd) {
            if (text.slice(blank.start, blank.end).trim() !== "") {
              throw new Error("Composer blank node contains non-whitespace content");
            }
            covered = blank.end;
          } else {
            const ownedPrefix = text.slice(blank.start, statementEnd);
            const remainingTerminator = text.slice(statementEnd, blank.end);
            if (ownedPrefix.trim() !== "" || !/^(?:\r\n|\n)$/u.test(remainingTerminator)) {
              throw new Error("Composer statementRange splits a non-blank physical line");
            }
            covered = statementEnd;
          }
          following += 1;
        }
      }
    } else {
      const authored = text.slice(current.start, current.end);
      const expectedPreview = truncateUtf8(authored, MAX_OPAQUE_PREVIEW_BYTES);
      if (
        current.node.sourcePreview !== expectedPreview.value ||
        current.node.sourceTruncated !== expectedPreview.truncated ||
        current.node.summary !== [...authored].slice(0, MAX_OPAQUE_SUMMARY_SCALARS).join("")
      ) {
        throw new Error("Composer opaque preview does not match the current TextDocument range");
      }
    }
  }

  const refs = offsets.map(({ node }) => nodeRef(node));
  for (let index = 0; index < snapshot.boundaries.length; index += 1) {
    const expected: ComposerBoundaryTarget = {
      kind: "boundary",
      before: index > 0 ? refs[index - 1]! : null,
      after: index < refs.length ? refs[index]! : null,
    };
    if (!sameBoundary(snapshot.boundaries[index]!.target, expected)) {
      throw new Error("Composer boundary does not match adjacent nodes");
    }
    if (
      snapshot.boundaries[index]!.insert !== null &&
      !sameBoundary(snapshot.boundaries[index]!.insert!.boundary, expected)
    ) {
      throw new Error("Composer insert capability boundary is not authoritative");
    }
  }

  const validBoundary = (target: ComposerBoundaryTarget | null): boolean =>
    target === null || snapshot.boundaries.some((boundary) => sameBoundary(boundary.target, target));
  for (const node of snapshot.nodes) {
    if (node.kind === "message" || node.kind === "narration") {
      if (!validBoundary(node.capabilities.moveUp) || !validBoundary(node.capabilities.moveDown)) {
        throw new Error("Composer move capability references an unknown boundary");
      }
    }
  }
}

export async function composerDocumentSourceDigest(source: string): Promise<string> {
  const bytes = canonicalFrame("mmt-composer-document-v1", [UTF8.encode(source)]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseNode(value: unknown, label: string): ComposerDocumentNode {
  const record = requireRecord(value, label);
  if (!isAllowedString(record.kind, NODE_KINDS)) throw new Error(`${label}.kind is invalid`);
  if (record.kind === "message") {
    requireExactKeys(
      record,
      [
        "kind",
        "nodeKey",
        "range",
        "statementRange",
        "side",
        "speaker",
        "body",
        "continued",
        "actorDisplayName",
        "actorAvatar",
        "capabilities",
      ],
      label,
    );
    if (!isAllowedString(record.side, MESSAGE_SIDES)) throw new Error(`${label}.side is invalid`);
    if (record.continued !== null && !isAllowedString(record.continued, CONTINUED_VALUES)) {
      throw new Error(`${label}.continued is invalid`);
    }
    if (record.actorDisplayName !== null) {
      requireBoundedString(record.actorDisplayName, MAX_PRODUCT_STRING_BYTES, `${label}.actorDisplayName`);
    }
    return {
      kind: "message",
      nodeKey: parseDigest(record.nodeKey, `${label}.nodeKey`),
      range: parseRange(record.range, `${label}.range`),
      statementRange: parseRange(record.statementRange, `${label}.statementRange`),
      side: record.side,
      speaker: record.speaker === null ? null : parseSpeaker(record.speaker, `${label}.speaker`),
      body: parseBody(record.body, `${label}.body`),
      continued: record.continued,
      actorDisplayName: record.actorDisplayName as string | null,
      actorAvatar:
        record.actorAvatar === null ? null : parseActorAvatar(record.actorAvatar, `${label}.actorAvatar`),
      capabilities: parseMessageCapabilities(record.capabilities, `${label}.capabilities`),
    };
  }
  if (record.kind === "narration") {
    requireExactKeys(record, ["kind", "nodeKey", "range", "statementRange", "body", "capabilities"], label);
    return {
      kind: "narration",
      nodeKey: parseDigest(record.nodeKey, `${label}.nodeKey`),
      range: parseRange(record.range, `${label}.range`),
      statementRange: parseRange(record.statementRange, `${label}.statementRange`),
      body: parseBody(record.body, `${label}.body`),
      capabilities: parseNarrationCapabilities(record.capabilities, `${label}.capabilities`),
    };
  }
  requireExactKeys(
    record,
    ["kind", "nodeKey", "range", "category", "sourcePreview", "sourceTruncated", "summary", "canOpenSource"],
    label,
  );
  if (!isAllowedString(record.category, OPAQUE_CATEGORIES)) throw new Error(`${label}.category is invalid`);
  if (typeof record.sourceTruncated !== "boolean" || record.canOpenSource !== true) {
    throw new Error(`${label} opaque flags are invalid`);
  }
  const sourcePreview = requireBoundedString(
    record.sourcePreview,
    MAX_OPAQUE_PREVIEW_BYTES,
    `${label}.sourcePreview`,
  );
  if ([...sourcePreview].length > MAX_OPAQUE_PREVIEW_BYTES) throw new Error(`${label}.sourcePreview is invalid`);
  const summary = requireString(record.summary, `${label}.summary`);
  if ([...summary].length > MAX_OPAQUE_SUMMARY_SCALARS) throw new Error(`${label}.summary is too long`);
  return {
    kind: "opaque",
    nodeKey: parseDigest(record.nodeKey, `${label}.nodeKey`),
    range: parseRange(record.range, `${label}.range`),
    category: record.category,
    sourcePreview,
    sourceTruncated: record.sourceTruncated,
    summary,
    canOpenSource: true,
  };
}

function parseBody(value: unknown, label: string): ComposerStatementBody {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["current", "mode", "resolvedMode", "inheritedMode"], label);
  const current = requireBoundedString(record.current, MAX_BODY_BYTES, `${label}.current`);
  if (!isAllowedString(record.mode, TEXT_MODES)) throw new Error(`${label}.mode is invalid`);
  for (const field of ["resolvedMode", "inheritedMode"] as const) {
    if (record[field] !== null && !isAllowedString(record[field], BODY_MODES)) {
      throw new Error(`${label}.${field} is invalid`);
    }
  }
  return {
    current,
    mode: record.mode,
    resolvedMode: record.resolvedMode as ComposerBodyMode | null,
    inheritedMode: record.inheritedMode as ComposerBodyMode | null,
  };
}

function parseSpeaker(value: unknown, label: string): ComposerSpeaker {
  const record = requireRecord(value, label);
  if (record.kind === "builtin") {
    requireExactKeys(record, ["kind", "id"], label);
    return { kind: "builtin", id: requireBoundedString(record.id, MAX_PRODUCT_STRING_BYTES, `${label}.id`) };
  }
  if (record.kind !== "actor") throw new Error(`${label}.kind is invalid`);
  requireExactKeys(record, ["kind", "reference", "displayName", "primaryName", "presetId", "avatar"], label);
  return {
    kind: "actor",
    reference: requireBoundedString(record.reference, MAX_PRODUCT_STRING_BYTES, `${label}.reference`),
    displayName: requireBoundedString(record.displayName, MAX_PRODUCT_STRING_BYTES, `${label}.displayName`),
    primaryName: requireBoundedString(record.primaryName, MAX_PRODUCT_STRING_BYTES, `${label}.primaryName`),
    presetId: requireBoundedString(record.presetId, MAX_PRODUCT_STRING_BYTES, `${label}.presetId`),
    avatar: record.avatar === null ? null : parseAvatarCurrent(record.avatar, `${label}.avatar`),
  };
}

function parseActorAvatar(value: unknown, label: string): NonNullable<Extract<ComposerDocumentNode, {kind: "message"}>["actorAvatar"]> {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["scope", "actorPresetId", "current"], label);
  if (record.scope !== "fromStatement") throw new Error(`${label}.scope is invalid`);
  return {
    scope: "fromStatement",
    actorPresetId: requireBoundedString(record.actorPresetId, MAX_PRODUCT_STRING_BYTES, `${label}.actorPresetId`),
    current: record.current === null ? null : parseAvatarCurrent(record.current, `${label}.current`),
  };
}

function parseAvatarCurrent(value: unknown, label: string): ComposerAvatarCurrent {
  const record = requireRecord(value, label);
  if (record.kind === "asset") {
    requireExactKeys(record, ["kind", "assetName"], label);
    return { kind: "asset", assetName: requireBoundedString(record.assetName, MAX_PRODUCT_STRING_BYTES, `${label}.assetName`) };
  }
  if (record.kind !== "packAvatar") throw new Error(`${label}.kind is invalid`);
  requireExactKeys(record, ["kind", "entityId", "contributionNamespace", "variantId"], label);
  return {
    kind: "packAvatar",
    entityId: requireBoundedString(record.entityId, MAX_PRODUCT_STRING_BYTES, `${label}.entityId`),
    contributionNamespace: requireBoundedString(record.contributionNamespace, MAX_PRODUCT_STRING_BYTES, `${label}.contributionNamespace`),
    variantId: requireBoundedString(record.variantId, MAX_PRODUCT_STRING_BYTES, `${label}.variantId`),
  };
}

function parseMessageCapabilities(value: unknown, label: string): ComposerMessageCapabilities {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["setBody", "setContinued", "setDisplayName", "setAvatar", "setSpeaker", "delete", "moveUp", "moveDown"], label);
  for (const field of ["setBody", "setContinued", "setDisplayName", "setAvatar", "setSpeaker", "delete"] as const) {
    if (typeof record[field] !== "boolean") throw new Error(`${label}.${field} must be boolean`);
  }
  return {
    setBody: record.setBody as boolean,
    setContinued: record.setContinued as boolean,
    setDisplayName: record.setDisplayName as boolean,
    setAvatar: record.setAvatar as boolean,
    setSpeaker: record.setSpeaker as boolean,
    delete: record.delete as boolean,
    moveUp: record.moveUp === null ? null : parseBoundaryTarget(record.moveUp, `${label}.moveUp`),
    moveDown: record.moveDown === null ? null : parseBoundaryTarget(record.moveDown, `${label}.moveDown`),
  };
}

function parseNarrationCapabilities(value: unknown, label: string): ComposerNarrationCapabilities {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["setBody", "delete", "moveUp", "moveDown"], label);
  if (typeof record.setBody !== "boolean" || typeof record.delete !== "boolean") {
    throw new Error(`${label} booleans are invalid`);
  }
  return {
    setBody: record.setBody,
    delete: record.delete,
    moveUp: record.moveUp === null ? null : parseBoundaryTarget(record.moveUp, `${label}.moveUp`),
    moveDown: record.moveDown === null ? null : parseBoundaryTarget(record.moveDown, `${label}.moveDown`),
  };
}

function parseBoundary(value: unknown, label: string): ComposerBoundary {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["target", "insert"], label);
  return {
    target: parseBoundaryTarget(record.target, `${label}.target`),
    insert: record.insert === null ? null : parseInsertCapability(record.insert, `${label}.insert`),
  };
}

function parseBoundaryTarget(value: unknown, label: string): ComposerBoundaryTarget {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["kind", "before", "after"], label);
  if (record.kind !== "boundary") throw new Error(`${label}.kind is invalid`);
  return {
    kind: "boundary",
    before: record.before === null ? null : parseNodeRef(record.before, `${label}.before`),
    after: record.after === null ? null : parseNodeRef(record.after, `${label}.after`),
  };
}

function parseNodeRef(value: unknown, label: string): ComposerNodeRef {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["nodeKey", "nodeKind", "range"], label);
  if (!isAllowedString(record.nodeKind, NODE_KINDS)) throw new Error(`${label}.nodeKind is invalid`);
  return {
    nodeKey: parseDigest(record.nodeKey, `${label}.nodeKey`),
    nodeKind: record.nodeKind,
    range: parseRange(record.range, `${label}.range`),
  };
}

function parseInsertCapability(value: unknown, label: string): ComposerInsertCapability {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["boundary", "messageSides", "statementModes", "speakerSources", "narration"], label);
  const messageSides = parseAllowedArray(record.messageSides, MESSAGE_SIDES, `${label}.messageSides`);
  const statementModes = parseAllowedArray(record.statementModes, TEXT_MODES, `${label}.statementModes`);
  const speakerSources = parseAllowedArray(record.speakerSources, SPEAKER_SOURCES, `${label}.speakerSources`);
  if (typeof record.narration !== "boolean") {
    throw new Error(`${label} insertion fields are invalid`);
  }
  return {
    boundary: parseBoundaryTarget(record.boundary, `${label}.boundary`),
    messageSides,
    statementModes,
    speakerSources,
    narration: record.narration,
  };
}

function parseScriptActorChoice(value: unknown, label: string): ComposerScriptActorChoice {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["reference", "displayName", "primaryName", "presetId", "avatar"], label);
  return {
    reference: requireBoundedString(record.reference, MAX_PRODUCT_STRING_BYTES, `${label}.reference`),
    displayName: requireBoundedString(record.displayName, MAX_PRODUCT_STRING_BYTES, `${label}.displayName`),
    primaryName: requireBoundedString(record.primaryName, MAX_PRODUCT_STRING_BYTES, `${label}.primaryName`),
    presetId: requireBoundedString(record.presetId, MAX_PRODUCT_STRING_BYTES, `${label}.presetId`),
    avatar: record.avatar === null ? null : parseAvatarCurrent(record.avatar, `${label}.avatar`),
  };
}

function parseTextDocument(value: unknown): ComposerDocumentSnapshot["textDocument"] {
  const record = requireRecord(value, "Composer textDocument");
  requireExactKeys(record, ["uri", "version"], "Composer textDocument");
  if (typeof record.uri !== "string" || record.uri.length === 0 || !Number.isSafeInteger(record.version)) {
    throw new Error("Composer textDocument identity is invalid");
  }
  return { uri: record.uri, version: record.version as number };
}

function parseRange(value: unknown, label: string): Range {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["start", "end"], label);
  return { start: parsePosition(record.start, `${label}.start`), end: parsePosition(record.end, `${label}.end`) };
}

function parsePosition(value: unknown, label: string): Position {
  const record = requireRecord(value, label);
  requireExactKeys(record, ["line", "character"], label);
  if (!isNonNegativeSafeInteger(record.line) || !isNonNegativeSafeInteger(record.character)) {
    throw new Error(`${label} is invalid`);
  }
  return { line: record.line, character: record.character };
}

function reversibleOffset(document: ComposerTextDocumentLike, position: Position, label: string): number {
  const offset = document.offsetAt(position);
  const roundTrip = document.positionAt(offset);
  if (roundTrip.line !== position.line || roundTrip.character !== position.character) {
    throw new Error(`${label} is not reversible in the current TextDocument`);
  }
  return offset;
}

function nodeRef(node: ComposerDocumentNode): ComposerNodeRef {
  return { nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range };
}

function sameBoundary(left: ComposerBoundaryTarget, right: ComposerBoundaryTarget): boolean {
  return sameNodeRef(left.before, right.before) && sameNodeRef(left.after, right.after);
}

function sameNodeRef(left: ComposerNodeRef | null, right: ComposerNodeRef | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.nodeKey === right.nodeKey &&
    left.nodeKind === right.nodeKind &&
    sameRange(left.range, right.range)
  );
}

function sameRange(left: Range, right: Range): boolean {
  return (
    left.start.line === right.start.line &&
    left.start.character === right.start.character &&
    left.end.line === right.end.line &&
    left.end.character === right.end.character
  );
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (UTF8.encode(value).length <= maxBytes) return { value, truncated: false };
  let result = "";
  let bytes = 0;
  for (const scalar of value) {
    const size = UTF8.encode(scalar).length;
    if (bytes + size > maxBytes) break;
    result += scalar;
    bytes += size;
  }
  return { value: result, truncated: true };
}

function canonicalFrame(
  domain: string,
  fields: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
  const all = [UTF8.encode(domain), ...fields];
  const size = all.reduce((total, field) => total + 8 + field.length, 0);
  const result = new Uint8Array(new ArrayBuffer(size));
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const field of all) {
    view.setBigUint64(offset, BigInt(field.length), false);
    offset += 8;
    result.set(field, offset);
    offset += field.length;
  }
  return result;
}

function parseDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw new Error(`${label} must be lowercase SHA-256`);
  return value;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, required: readonly string[], label: string): void {
  const expected = new Set(required);
  const keys = Object.keys(record);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function requireBoundedArray(value: unknown, max: number, label: string): readonly unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${label} is invalid or too large`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function requireBoundedString(value: unknown, maxBytes: number, label: string): string {
  const string = requireString(value, label);
  if (UTF8.encode(string).length > maxBytes) throw new Error(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  return string;
}

function parseAllowedArray<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values,
  label: string,
): Values[number][] {
  if (!Array.isArray(value) || value.length > allowed.length) throw new Error(`${label} is invalid`);
  const result = value.map((item) => {
    if (!isAllowedString(item, allowed)) throw new Error(`${label} contains an invalid value`);
    return item;
  });
  if (new Set(result).size !== result.length) throw new Error(`${label} contains duplicates`);
  return result;
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
