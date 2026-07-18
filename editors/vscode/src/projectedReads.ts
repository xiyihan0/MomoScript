import type {
  DocumentHighlight,
  Location,
  Range,
  SelectionRange,
  SymbolInformation
} from "vscode-languageserver-protocol";

export type ProjectionMappingKind =
  | "authoredIdentity"
  | "workspaceTypst"
  | "packageFile"
  | "generatedProjection"
  | "staleUnknown";

export interface ProjectedReadLocation {
  readonly kind: ProjectionMappingKind;
  readonly uri?: string;
  readonly range?: Range;
}

export type ProjectedReadMethod =
  | "definition"
  | "references"
  | "typeDefinition"
  | "implementation";

export type ProjectedReadResult<T> =
  | { readonly kind: "Mapped"; readonly items: readonly T[]; readonly omitted: number }
  | { readonly kind: "StaleUnknown"; readonly omitted: number }
  | { readonly kind: "CapabilityUnavailable"; readonly method: ProjectedReadMethod };

export interface ProjectedReadPolicy {
  readonly qualified?: boolean;
  readonly packageVisible?: (uri: string) => boolean;
}

const PROJECTION_MAPPING_KINDS: Readonly<Record<ProjectionMappingKind, true>> = Object.freeze({
  authoredIdentity: true,
  workspaceTypst: true,
  packageFile: true,
  generatedProjection: true,
  staleUnknown: true
});

export function parseProjectedReadLocations(value: unknown): readonly ProjectedReadLocation[] {
  if (!Array.isArray(value)) throw new TypeError("Projected read mapping must be an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || !("kind" in item)
      || typeof item.kind !== "string" || !(item.kind in PROJECTION_MAPPING_KINDS)) {
      throw new TypeError("Projected read mapping has an unknown kind");
    }
    const kind = item.kind as ProjectionMappingKind;
    if (kind === "staleUnknown") return { kind };
    if (!("uri" in item) || typeof item.uri !== "string"
      || !("range" in item) || !isWireRange(item.range)) {
      throw new TypeError("Projected read mapping is missing an exact URI/range");
    }
    return { kind, uri: item.uri, range: item.range };
  });
}

/**
 * Applies the partial-result policy shared by navigation methods. Unknown and
 * stale items are omitted individually, but an all-unsafe response remains an
 * explicit result rather than being confused with a legitimate empty answer.
 */
export function mapNavigationLocations(
  method: ProjectedReadMethod,
  locations: readonly ProjectedReadLocation[],
  policy: ProjectedReadPolicy = {}
): ProjectedReadResult<Location> {
  if (
    (method === "typeDefinition" || method === "implementation")
    && policy.qualified === false
  ) return { kind: "CapabilityUnavailable", method };
  const items: Location[] = [];
  let omitted = 0;
  for (const location of locations) {
    const uri = location.uri;
    const generatedVisible = location.kind !== "generatedProjection"
      || (uri !== undefined && uri.startsWith("mmt-projection:"));
    const packageVisible = location.kind !== "packageFile"
      || (uri !== undefined && policy.packageVisible?.(uri) === true);
    if (
      location.kind === "staleUnknown"
      || !uri
      || !location.range
      || !generatedVisible
      || !packageVisible
    ) {
      omitted += 1;
      continue;
    }
    items.push({ uri, range: location.range });
  }
  if (items.length === 0 && omitted > 0) return { kind: "StaleUnknown", omitted };
  return { kind: "Mapped", items, omitted };
}

/** Highlights never navigate away from the authored document. */
export function mapDocumentHighlights(
  sourceUri: string,
  highlights: readonly DocumentHighlight[],
  locations: readonly ProjectedReadLocation[]
): ProjectedReadResult<DocumentHighlight> {
  if (highlights.length !== locations.length) {
    return { kind: "StaleUnknown", omitted: Math.max(highlights.length, locations.length) };
  }
  const items: DocumentHighlight[] = [];
  let omitted = 0;
  for (let index = 0; index < highlights.length; index += 1) {
    const mapped = locations[index];
    if (
      mapped.kind !== "authoredIdentity"
      || mapped.uri !== sourceUri
      || mapped.range === undefined
    ) {
      omitted += 1;
      continue;
    }
    items.push({ ...highlights[index], range: mapped.range });
  }
  if (items.length === 0 && omitted > 0) return { kind: "StaleUnknown", omitted };
  return { kind: "Mapped", items, omitted };
}

export interface ClassifiedSelectionRange {
  /** Inner range first, followed by each parent. */
  readonly chain: readonly ProjectedReadLocation[];
}

/** Keeps the already-safe child chain and stops at the first unsafe parent. */
export function mapSelectionRanges(
  selections: readonly ClassifiedSelectionRange[],
  sourceUri: string
): ProjectedReadResult<SelectionRange> {
  const items: SelectionRange[] = [];
  let omitted = 0;
  for (const selection of selections) {
    const safe: Range[] = [];
    for (const mapped of selection.chain) {
      if (
        mapped.kind !== "authoredIdentity"
        || mapped.uri !== sourceUri
        || mapped.range === undefined
      ) {
        omitted += 1;
        break;
      }
      safe.push(mapped.range);
    }
    if (safe.length === 0) continue;
    let node: SelectionRange | undefined;
    for (let index = safe.length - 1; index >= 0; index -= 1) {
      node = node === undefined ? { range: safe[index] } : { range: safe[index], parent: node };
    }
    items.push(node!);
  }
  if (items.length === 0 && omitted > 0) return { kind: "StaleUnknown", omitted };
  return { kind: "Mapped", items, omitted };
}

export interface ClassifiedWorkspaceSymbol {
  readonly symbol: SymbolInformation;
  readonly location: ProjectedReadLocation;
}

/** Hides generated symbols and deduplicates by authored identity. */
export function mergeWorkspaceSymbols(
  authoredMmt: readonly SymbolInformation[],
  typst: readonly ClassifiedWorkspaceSymbol[],
  packageVisible?: (uri: string) => boolean
): readonly SymbolInformation[] {
  const merged: SymbolInformation[] = [...authoredMmt];
  for (const candidate of typst) {
    const mapped = candidate.location;
    if (
      mapped.kind === "generatedProjection"
      || mapped.kind === "staleUnknown"
      || !mapped.uri
      || !mapped.range
      || (mapped.kind === "packageFile" && packageVisible?.(mapped.uri) !== true)
    ) continue;
    merged.push({
      ...candidate.symbol,
      location: { uri: mapped.uri, range: mapped.range }
    });
  }
  const unique = new Map<string, SymbolInformation>();
  for (const symbol of merged) {
    const range = symbol.location.range;
    const key = [
      normalizeUri(symbol.location.uri),
      range.start.line,
      range.start.character,
      range.end.line,
      range.end.character,
      symbol.kind,
      symbol.name
    ].join("\0");
    if (!unique.has(key)) unique.set(key, symbol);
  }
  return [...unique.values()];
}

/** MMT-native results have strict precedence; fallback is not even invoked. */
export async function mmtNativeFirst<T>(
  native: T | null | undefined,
  projected: () => Promise<T | null | undefined>,
  definitive?: (value: T) => boolean
): Promise<T | null | undefined> {
  if (
    native !== null
    && native !== undefined
    && (definitive ? definitive(native) : !Array.isArray(native) || native.length > 0)
  ) return native;
  return await projected();
}

function isWireRange(value: unknown): value is Range {
  if (!value || typeof value !== "object" || !("start" in value) || !("end" in value)) {
    return false;
  }
  for (const position of [value.start, value.end]) {
    if (!position || typeof position !== "object"
      || !("line" in position) || !Number.isSafeInteger(position.line) || Number(position.line) < 0
      || !("character" in position) || !Number.isSafeInteger(position.character) || Number(position.character) < 0) {
      return false;
    }
  }
  return true;
}

function normalizeUri(uri: string): string {
  try {
    return new URL(uri).toString();
  } catch {
    return uri;
  }
}
