import type { Location, Position, Range } from "vscode-languageserver-protocol";

import {
  parseProjectedReadLocations,
  type ProjectedReadLocation
} from "./projectedReads";
import type { RetainedVirtualDocumentStore } from "./retainedVirtualDocuments";
import type { TinymistRequestIdentity } from "./tinymistRequestDispatcher";
import type {
  TypstProviderCapabilityContract,
  TypstProviderMethod
} from "./typstProviderDescriptors";
import {
  validateTypstProviderItemPayload,
  type StrippedTypstProviderPayloadField,
  type TypstProviderItemPayloadValidationResult
} from "./typstProviderPayload";

export type ProjectedProviderPayloadMethod =
  | "textDocument/documentLink"
  | "documentLink/resolve"
  | "textDocument/documentColor"
  | "textDocument/colorPresentation"
  | "textDocument/inlayHint"
  | "inlayHint/resolve"
  | "textDocument/codeLens"
  | "codeLens/resolve";

export interface ProjectedProviderPayloadOmission {
  readonly index: number;
  readonly reason: string;
}

export interface ProjectedProviderPayloadStrippedField extends StrippedTypstProviderPayloadField {
  readonly index: number;
}

export interface MappedProjectedProviderPayload {
  readonly kind: "Mapped";
  readonly items: readonly unknown[];
  readonly omitted: readonly ProjectedProviderPayloadOmission[];
  readonly strippedFields: readonly ProjectedProviderPayloadStrippedField[];
}

export type ProjectedProviderPayloadFailure = Exclude<
  TypstProviderItemPayloadValidationResult,
  { readonly kind: "Validated" }
>;

export type ProjectedProviderPayloadResult =
  | MappedProjectedProviderPayload
  | ProjectedProviderPayloadFailure;

export type ProjectedPayloadLocationClassifier = (
  locations: readonly Location[],
  request: TinymistRequestIdentity,
  signal?: AbortSignal
) => Promise<unknown> | unknown;

export interface MapProjectedProviderPayloadInput {
  readonly method: ProjectedProviderPayloadMethod;
  readonly capability: TypstProviderCapabilityContract;
  readonly request: TinymistRequestIdentity;
  /** Read after classification, immediately before atomic payload validation. */
  readonly current: () => TinymistRequestIdentity | undefined;
  readonly projectedDocumentUri: string;
  readonly items: readonly unknown[];
  readonly classifyLocations: ProjectedPayloadLocationClassifier;
  readonly retainedDocuments: Pick<
    RetainedVirtualDocumentStore,
    "packageContent" | "projectionContent"
  >;
  readonly workspaceTypstVisible?: (uri: string) => boolean;
  readonly allowedCommands: readonly string[];
  readonly signal?: AbortSignal;
}

/** Cancellation is a control-flow result and is never publishable as a stale/empty item list. */
export class ProjectedProviderPayloadCancelledError extends Error {
  constructor() {
    super("Projected provider payload mapping was cancelled");
    this.name = "ProjectedProviderPayloadCancelledError";
  }
}

type PayloadFailure = ProjectedProviderPayloadFailure;

type MappingRequirement = "authored-range" | "authored-point" | "read-location";

interface MappingSlot {
  readonly location: Location;
  readonly path: string;
  readonly requirement: MappingRequirement;
  readonly optionalGroup?: string;
  readonly apply: (mapped: ProjectedReadLocation) => void;
}

interface OptionalMappingGroup {
  readonly path: string;
  readonly strip: () => void;
  readonly reason: string;
}

interface CollectedItem {
  readonly value: Record<string, unknown>;
  readonly slots: MappingSlot[];
  readonly optionalGroups: ReadonlyMap<string, OptionalMappingGroup>;
  readonly stripped: StrippedTypstProviderPayloadField[];
}

interface CollectedEntry {
  readonly index: number;
  readonly item?: CollectedItem;
  readonly failure?: PayloadFailure;
}

const SAFE_ITEM_LIST_METHODS: Readonly<Record<string, true>> = Object.freeze({
  "textDocument/documentLink": true,
  "textDocument/documentColor": true,
  "textDocument/inlayHint": true,
  "textDocument/codeLens": true
});

/**
 * Composition hook for projected provider installers. The caller sends the
 * returned Location batch through `mmt/mapTypstReadLocations`; this adapter then
 * applies those positional classifications and runs the shared W3-C payload
 * validator before any item can be published.
 */
export async function mapProjectedProviderPayloadItems(
  input: MapProjectedProviderPayloadInput
): Promise<ProjectedProviderPayloadResult> {
  throwIfCancelled(input.signal);
  const unavailable = capabilityFailure(input.method, input.capability);
  if (unavailable) return unavailable;
  if (input.request.projectionKey === undefined) {
    return stale("projected provider request has no projection identity");
  }

  const entries: CollectedEntry[] = [];
  const slots: MappingSlot[] = [];
  for (const [index, value] of input.items.entries()) {
    try {
      const item = collectItem(input.method, value, input.projectedDocumentUri);
      entries.push({ index, item });
      slots.push(...item.slots);
    } catch (error) {
      const failure = unsafe(error instanceof Error ? error.message : "projected provider item is malformed");
      if (!allowsPartialItems(input.method)) return failure;
      entries.push({ index, failure });
    }
  }

  let mappedLocations: readonly ProjectedReadLocation[];
  try {
    const raw = slots.length === 0
      ? []
      : await input.classifyLocations(slots.map((slot) => slot.location), input.request, input.signal);
    throwIfCancelled(input.signal);
    mappedLocations = parseProjectedReadLocations(raw);
  } catch (error) {
    if (error instanceof ProjectedProviderPayloadCancelledError || input.signal?.aborted) {
      throw new ProjectedProviderPayloadCancelledError();
    }
    return stale("projected provider location classification failed");
  }
  if (mappedLocations.length !== slots.length) {
    return stale("projected provider location classification count changed");
  }

  const current = input.current();
  if (!current || !identitiesEqual(input.request, current)) {
    return stale("projected provider request snapshot is no longer current");
  }

  const slotMappings = new Map<MappingSlot, ProjectedReadLocation>();
  for (let index = 0; index < slots.length; index += 1) {
    slotMappings.set(slots[index], mappedLocations[index]);
  }

  const values: unknown[] = [];
  const omissions: ProjectedProviderPayloadOmission[] = [];
  const strippedFields: ProjectedProviderPayloadStrippedField[] = [];
  for (const entry of entries) {
    if (entry.failure) {
      omissions.push(Object.freeze({ index: entry.index, reason: describeFailure(entry.failure) }));
      continue;
    }
    const collected = entry.item!;
    const mappingFailure = applyMappings(collected, slotMappings, input);
    if (mappingFailure) {
      if (!allowsPartialItems(input.method)) return mappingFailure;
      omissions.push(Object.freeze({ index: entry.index, reason: describeFailure(mappingFailure) }));
      continue;
    }

    const targetFailure = sanitizeReadOnlyTargets(collected, input);
    if (targetFailure) {
      if (!allowsPartialItems(input.method)) return targetFailure;
      omissions.push(Object.freeze({ index: entry.index, reason: describeFailure(targetFailure) }));
      continue;
    }

    if (input.method === "textDocument/documentColor") {
      const colorFailure = validateDocumentColor(collected.value);
      if (colorFailure) {
        omissions.push(Object.freeze({ index: entry.index, reason: describeFailure(colorFailure) }));
        continue;
      }
      values.push(deepFreezeJson(collected.value));
      continue;
    }

    const validated = validateTypstProviderItemPayload({
      method: input.method,
      capability: input.capability,
      request: input.request,
      current,
      targetClass: "AuthoredMmt",
      allowedCommands: input.allowedCommands,
      item: collected.value
    });
    if (validated.kind !== "Validated") {
      if (!allowsPartialItems(input.method) || validated.kind === "CapabilityUnavailable") return validated;
      omissions.push(Object.freeze({ index: entry.index, reason: describeFailure(validated) }));
      continue;
    }
    values.push(validated.value);
    for (const field of [...collected.stripped, ...validated.strippedFields]) {
      strippedFields.push(Object.freeze({ index: entry.index, path: field.path, reason: field.reason }));
    }
  }

  if (values.length === 0 && omissions.length > 0) {
    return stale("every projected provider item was unsafe or stale");
  }
  return Object.freeze({
    kind: "Mapped" as const,
    items: Object.freeze(values),
    omitted: Object.freeze(omissions),
    strippedFields: Object.freeze(strippedFields)
  });
}

function collectItem(
  method: ProjectedProviderPayloadMethod,
  itemValue: unknown,
  projectedDocumentUri: string
): CollectedItem {
  const item = requireRecord(itemValue, "projected provider item");
  const value = { ...item };
  const slots: MappingSlot[] = [];
  const optionalGroups = new Map<string, OptionalMappingGroup>();
  const stripped: StrippedTypstProviderPayloadField[] = [];

  if (method === "textDocument/documentLink" || method === "documentLink/resolve") {
    const range = requireRange(item.range, "document-link range");
    slots.push(authoredRangeSlot(projectedDocumentUri, range, "range", (mapped) => {
      value.range = mapped.range;
    }));
  } else if (method === "textDocument/documentColor") {
    const range = requireRange(item.range, "document-color range");
    slots.push(authoredRangeSlot(projectedDocumentUri, range, "range", (mapped) => {
      value.range = mapped.range;
    }));
  } else if (method === "textDocument/colorPresentation") {
    if (item.textEdit !== undefined) {
      value.textEdit = collectTextEdit(item.textEdit, "textEdit", projectedDocumentUri, slots);
    }
    if (item.additionalTextEdits !== undefined) {
      const edits = requireArray(item.additionalTextEdits, "additionalTextEdits");
      value.additionalTextEdits = edits.map((edit, index) =>
        collectTextEdit(edit, `additionalTextEdits[${index}]`, projectedDocumentUri, slots));
    }
  } else if (method === "textDocument/inlayHint" || method === "inlayHint/resolve") {
    const position = requirePosition(item.position, "inlay-hint position");
    slots.push(authoredPointSlot(projectedDocumentUri, position, "position", (mapped) => {
      value.position = mapped.range!.start;
    }));
    if (Array.isArray(item.label)) {
      value.label = item.label.map((partValue, index) => {
        const part = requireRecord(partValue, `label[${index}]`);
        const safePart = { ...part };
        if (part.location !== undefined) {
          try {
            const location = requireLocation(part.location, `label[${index}].location`);
            safePart.location = { ...location };
            const group = `label-location-${index}`;
            slots.push({
              location,
              path: `label[${index}].location`,
              requirement: "read-location",
              optionalGroup: group,
              apply(mapped) {
                safePart.location = { uri: mapped.uri, range: mapped.range };
              }
            });
            optionalGroups.set(group, {
              path: `label[${index}].location`,
              strip() { delete safePart.location; },
              reason: "optional inlay-hint location stripped: projected target is unsafe, stale, or unavailable"
            });
          } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            // W3-C owns meaningful-remainder stripping for malformed optional locations.
          }
        }
        return safePart;
      });
    }
    if (item.textEdits !== undefined) {
      const pendingSlots: MappingSlot[] = [];
      try {
        const edits = requireArray(item.textEdits, "textEdits");
        const mappedEdits = edits.map((editValue, index) => {
          const edit = requireRecord(editValue, `textEdits[${index}]`);
          const range = requireRange(edit.range, `textEdits[${index}].range`);
          const mappedEdit = { ...edit };
          pendingSlots.push({
            ...authoredRangeSlot(projectedDocumentUri, range, `textEdits[${index}].range`, (mapped) => {
              mappedEdit.range = mapped.range;
            }),
            optionalGroup: "textEdits"
          });
          return mappedEdit;
        });
        value.textEdits = mappedEdits;
        slots.push(...pendingSlots);
        optionalGroups.set("textEdits", {
          path: "textEdits",
          strip() { delete value.textEdits; },
          reason: "optional inlay-hint text edits stripped: one or more edits are outside a current Identity segment"
        });
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        // W3-C owns meaningful-remainder stripping for malformed optional edits.
      }
    }
  } else {
    const range = requireRange(item.range, "code-lens range");
    slots.push(authoredRangeSlot(projectedDocumentUri, range, "range", (mapped) => {
      value.range = mapped.range;
    }));
  }

  return { value, slots, optionalGroups, stripped };
}

function collectTextEdit(
  editValue: unknown,
  path: string,
  projectedDocumentUri: string,
  slots: MappingSlot[]
): Record<string, unknown> {
  const edit = requireRecord(editValue, path);
  const range = requireRange(edit.range, `${path}.range`);
  const mappedEdit = { ...edit };
  slots.push(authoredRangeSlot(projectedDocumentUri, range, `${path}.range`, (mapped) => {
    mappedEdit.range = mapped.range;
  }));
  return mappedEdit;
}

function authoredRangeSlot(
  uri: string,
  range: Range,
  path: string,
  apply: (mapped: ProjectedReadLocation) => void
): MappingSlot {
  return { location: { uri, range }, path, requirement: "authored-range", apply };
}

function authoredPointSlot(
  uri: string,
  position: Position,
  path: string,
  apply: (mapped: ProjectedReadLocation) => void
): MappingSlot {
  return {
    location: { uri, range: { start: position, end: position } },
    path,
    requirement: "authored-point",
    apply
  };
}

function applyMappings(
  item: CollectedItem,
  mappings: ReadonlyMap<MappingSlot, ProjectedReadLocation>,
  input: MapProjectedProviderPayloadInput
): PayloadFailure | undefined {
  const grouped = new Map<string, MappingSlot[]>();
  for (const slot of item.slots) {
    if (slot.optionalGroup) {
      const members = grouped.get(slot.optionalGroup) ?? [];
      members.push(slot);
      grouped.set(slot.optionalGroup, members);
      continue;
    }
    const mapped = mappings.get(slot)!;
    const failure = validateMappedSlot(slot, mapped, input);
    if (failure) return failure;
    slot.apply(mapped);
  }
  for (const [groupName, slots] of grouped) {
    let failure: PayloadFailure | undefined;
    for (const slot of slots) {
      failure = validateMappedSlot(slot, mappings.get(slot)!, input);
      if (failure) break;
    }
    if (failure) {
      const group = item.optionalGroups.get(groupName)!;
      group.strip();
      item.stripped.push({ path: group.path, reason: group.reason });
      continue;
    }
    for (const slot of slots) slot.apply(mappings.get(slot)!);
  }
  return undefined;
}

function validateMappedSlot(
  slot: MappingSlot,
  mapped: ProjectedReadLocation,
  input: MapProjectedProviderPayloadInput
): PayloadFailure | undefined {
  if (mapped.kind === "staleUnknown" || !mapped.uri || !mapped.range) {
    return stale(`${slot.path} is stale or has no exact mapping`);
  }
  if (slot.requirement === "authored-range" || slot.requirement === "authored-point") {
    if (mapped.kind === "packageFile") return readOnly("PackageFile");
    if (mapped.kind === "generatedProjection") return readOnly("GeneratedProjection");
    if (mapped.kind !== "authoredIdentity" || mapped.uri !== input.request.sourceStaleToken.hostUri) {
      return unsafe(`${slot.path} is not one current authored Identity segment`);
    }
    if (slot.requirement === "authored-point"
      && comparePosition(mapped.range.start, mapped.range.end) !== 0) {
      return unsafe(`${slot.path} point mapping is ambiguous`);
    }
    return undefined;
  }
  if (mapped.kind === "authoredIdentity") {
    return mapped.uri === input.request.sourceStaleToken.hostUri
      ? undefined
      : stale(`${slot.path} authored mapping targets another source identity`);
  }
  if (mapped.kind === "workspaceTypst") {
    return input.workspaceTypstVisible?.(mapped.uri) === true
      ? undefined
      : stale(`${slot.path} workspace Typst target is not explicitly visible`);
  }
  if (mapped.kind === "packageFile") {
    return input.retainedDocuments.packageContent(mapped.uri) === undefined
      ? stale(`${slot.path} package generation is inactive or retired`)
      : undefined;
  }
  return input.retainedDocuments.projectionContent(mapped.uri) === undefined
    ? stale(`${slot.path} projection generation is not retained`)
    : undefined;
}

function sanitizeReadOnlyTargets(
  item: CollectedItem,
  input: MapProjectedProviderPayloadInput
): PayloadFailure | undefined {
  if (input.method !== "textDocument/documentLink" && input.method !== "documentLink/resolve") {
    return undefined;
  }
  const target = item.value.target;
  if (typeof target !== "string") return undefined;
  let reason: string | undefined;
  if (target.startsWith("mmt-package:")
    && input.retainedDocuments.packageContent(target) === undefined) {
    reason = "package generation is inactive or retired";
  } else if (target.startsWith("mmt-projection:")
    && input.retainedDocuments.projectionContent(target) === undefined) {
    reason = "projection generation is not retained";
  } else if (/^(?:mmtfs|mmt):/u.test(target)
    && input.workspaceTypstVisible?.(target) !== true) {
    reason = "workspace Typst target is not explicitly visible";
  }
  if (!reason) return undefined;
  if (item.value.tooltip === undefined && item.value.data === undefined) {
    return stale(`document-link target ${reason}`);
  }
  delete item.value.target;
  item.stripped.push({
    path: "target",
    reason: `optional document-link target stripped: ${reason}`
  });
  return undefined;
}

function validateDocumentColor(item: Record<string, unknown>): PayloadFailure | undefined {
  const color = item.color;
  if (!color || typeof color !== "object" || Array.isArray(color)) {
    return unsafe("document color is malformed");
  }
  const colorRecord = color as Record<string, unknown>;
  for (const component of ["red", "green", "blue", "alpha"] as const) {
    const value = colorRecord[component];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      return unsafe(`document color ${component} is outside [0, 1]`);
    }
  }
  return undefined;
}

function capabilityFailure(
  method: ProjectedProviderPayloadMethod,
  capability: TypstProviderCapabilityContract
): PayloadFailure | undefined {
  if (capability.kind === "QualifiedProvider" && capability.descriptor.method === method) return undefined;
  return Object.freeze({
    kind: "CapabilityUnavailable" as const,
    method: method as TypstProviderMethod,
    reason: capability.kind === "CapabilityUnavailable"
      ? capability.reason
      : `qualified capability does not match ${method}`
  });
}

function allowsPartialItems(method: ProjectedProviderPayloadMethod): boolean {
  return SAFE_ITEM_LIST_METHODS[method] === true;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} is malformed`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

function requireLocation(value: unknown, path: string): Location {
  const location = requireRecord(value, path);
  if (typeof location.uri !== "string" || location.uri.length === 0) {
    throw new TypeError(`${path}.uri is malformed`);
  }
  return { uri: location.uri, range: requireRange(location.range, `${path}.range`) };
}

function requireRange(value: unknown, path: string): Range {
  const range = requireRecord(value, path);
  const start = requirePosition(range.start, `${path}.start`);
  const end = requirePosition(range.end, `${path}.end`);
  if (comparePosition(start, end) > 0) throw new TypeError(`${path} is reversed`);
  return { start, end };
}

function requirePosition(value: unknown, path: string): Position {
  const position = requireRecord(value, path);
  if (!Number.isInteger(position.line) || (position.line as number) < 0
    || !Number.isInteger(position.character) || (position.character as number) < 0) {
    throw new TypeError(`${path} is malformed`);
  }
  return { line: position.line as number, character: position.character as number };
}

function comparePosition(left: Position, right: Position): number {
  return left.line - right.line || left.character - right.character;
}

function identitiesEqual(left: TinymistRequestIdentity, right: TinymistRequestIdentity): boolean {
  return left.backendGeneration === right.backendGeneration
    && left.logicalSource === right.logicalSource
    && left.sourceContent === right.sourceContent
    && left.projectSnapshot === right.projectSnapshot
    && left.projectionKey === right.projectionKey
    && left.sourceStaleToken.hostUri === right.sourceStaleToken.hostUri
    && left.sourceStaleToken.documentIncarnation === right.sourceStaleToken.documentIncarnation
    && left.sourceStaleToken.documentVersion === right.sourceStaleToken.documentVersion;
}

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ProjectedProviderPayloadCancelledError();
}

function unsafe(reason: string): PayloadFailure {
  return Object.freeze({ kind: "UnsafeEdit" as const, reason });
}

function stale(reason: string): PayloadFailure {
  return Object.freeze({ kind: "StaleProjection" as const, reason });
}

function readOnly(targetClass: "PackageFile" | "GeneratedProjection"): PayloadFailure {
  return Object.freeze({ kind: "ReadOnlyTarget" as const, targetClass });
}

function describeFailure(failure: PayloadFailure): string {
  if (failure.kind === "ReadOnlyTarget") return `read-only ${failure.targetClass}`;
  if (failure.kind === "CapabilityUnavailable") return failure.reason;
  return failure.reason;
}

function deepFreezeJson<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return value;
}
