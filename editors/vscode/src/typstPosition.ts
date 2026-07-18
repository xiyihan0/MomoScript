import type { ProjectionKey, SourceContentKey, TypstProjectSnapshotKey } from "./runtimeIdentity";

export type PositionEncoding = "utf-8" | "utf-16";

export interface WirePosition {
  readonly line: number;
  readonly character: number;
}

const mmtClientDomain: unique symbol = Symbol("mmt-client-position");
const utf8ByteDomain: unique symbol = Symbol("utf8-byte-offset");
const tinymistBackendDomain: unique symbol = Symbol("tinymist-backend-position");

export interface MmtClientPosition {
  readonly value: WirePosition;
  readonly encoding: PositionEncoding;
  readonly [mmtClientDomain]: true;
}

export interface Utf8ByteOffset {
  readonly value: number;
  readonly [utf8ByteDomain]: true;
}

export interface TinymistBackendPosition {
  readonly value: WirePosition;
  readonly encoding: PositionEncoding;
  readonly [tinymistBackendDomain]: true;
}

export type PositionFailure =
  | "InvalidLine"
  | "InvalidCharacter"
  | "SplitUtf8CodePoint"
  | "SplitUtf16Surrogate"
  | "AbsentGeneration"
  | "StaleProjection"
  | "ProjectionMismatch"
  | "AmbiguousEncoding";

export class PositionConversionError extends Error {
  constructor(readonly reason: PositionFailure) {
    super(reason);
    this.name = "PositionConversionError";
  }
}

function checkedCoordinate(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PositionConversionError("InvalidCharacter");
  }
  return value as number;
}

export function mmtClientPosition(value: WirePosition, encoding: PositionEncoding): MmtClientPosition {
  return {
    value: { line: checkedCoordinate(value.line), character: checkedCoordinate(value.character) },
    encoding,
    [mmtClientDomain]: true
  };
}

function utf8ByteOffset(value: number): Utf8ByteOffset {
  return { value, [utf8ByteDomain]: true };
}

export function tinymistBackendPosition(
  value: WirePosition,
  encoding: PositionEncoding
): TinymistBackendPosition {
  return {
    value: { line: checkedCoordinate(value.line), character: checkedCoordinate(value.character) },
    encoding,
    [tinymistBackendDomain]: true
  };
}

interface Boundary {
  readonly byte: number;
  readonly utf16: number;
}

interface IndexedLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly boundaries: readonly Boundary[];
}

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

/** Immutable index for one exact retained file generation. */
export class LineIndex {
  private readonly lines: readonly IndexedLine[];
  private readonly textBytes: number;

  constructor(readonly text: string) {
    const sourceLines = text.split("\n");
    const lines: IndexedLine[] = [];
    let start = 0;
    for (let index = 0; index < sourceLines.length; index += 1) {
      const raw = sourceLines[index];
      const content = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      const boundaries: Boundary[] = [{ byte: 0, utf16: 0 }];
      let byte = 0;
      let utf16 = 0;
      for (const scalar of content) {
        byte += byteLength(scalar);
        utf16 += scalar.length;
        boundaries.push({ byte, utf16 });
      }
      lines.push({ start, contentEnd: start + byte, boundaries });
      start += byteLength(raw) + (index + 1 < sourceLines.length ? 1 : 0);
    }
    this.lines = lines;
    this.textBytes = byteLength(text);
  }

  private toByte(position: WirePosition, encoding: PositionEncoding): Utf8ByteOffset {
    const lineNumber = checkedCoordinate(position.line);
    const character = checkedCoordinate(position.character);
    const line = this.lines[lineNumber];
    if (!line) throw new PositionConversionError("InvalidLine");
    const boundary = encoding === "utf-8"
      ? line.boundaries.find((candidate) => candidate.byte === character)
      : line.boundaries.find((candidate) => candidate.utf16 === character);
    if (boundary) return utf8ByteOffset(line.start + boundary.byte);
    const maximum = line.boundaries.at(-1)!;
    if (encoding === "utf-8" && character < maximum.byte) {
      throw new PositionConversionError("SplitUtf8CodePoint");
    }
    if (encoding === "utf-16" && character < maximum.utf16) {
      throw new PositionConversionError("SplitUtf16Surrogate");
    }
    throw new PositionConversionError("InvalidCharacter");
  }

  private fromByte(offset: Utf8ByteOffset, encoding: PositionEncoding): WirePosition {
    if (!Number.isSafeInteger(offset.value) || offset.value < 0 || offset.value > this.textBytes) {
      throw new PositionConversionError("InvalidCharacter");
    }
    let lineNumber = this.lines.findIndex((line, index) => {
      const next = this.lines[index + 1];
      return offset.value >= line.start && (!next || offset.value < next.start);
    });
    if (lineNumber < 0) lineNumber = this.lines.length - 1;
    const line = this.lines[lineNumber];
    if (offset.value > line.contentEnd) throw new PositionConversionError("InvalidCharacter");
    const relative = offset.value - line.start;
    const boundary = line.boundaries.find((candidate) => candidate.byte === relative);
    if (!boundary) throw new PositionConversionError("SplitUtf8CodePoint");
    return {
      line: lineNumber,
      character: encoding === "utf-8" ? boundary.byte : boundary.utf16
    };
  }

  clientToByte(position: MmtClientPosition): Utf8ByteOffset {
    return this.toByte(position.value, position.encoding);
  }

  backendToByte(position: TinymistBackendPosition): Utf8ByteOffset {
    return this.toByte(position.value, position.encoding);
  }

  byteToClient(offset: Utf8ByteOffset, encoding: PositionEncoding): MmtClientPosition {
    return mmtClientPosition(this.fromByte(offset, encoding), encoding);
  }

  byteToBackend(offset: Utf8ByteOffset, encoding: PositionEncoding): TinymistBackendPosition {
    return tinymistBackendPosition(this.fromByte(offset, encoding), encoding);
  }

  convertClient(position: MmtClientPosition, backendEncoding: PositionEncoding): TinymistBackendPosition {
    return this.byteToBackend(this.clientToByte(position), backendEncoding);
  }

  previousScalar(position: TinymistBackendPosition): TinymistBackendPosition {
    const offset = this.backendToByte(position).value;
    if (offset === 0) throw new PositionConversionError("InvalidCharacter");
    const bytes = encoder.encode(this.text);
    let previous = offset - 1;
    while (previous > 0 && (bytes[previous] & 0xc0) === 0x80) previous -= 1;
    return this.byteToBackend(utf8ByteOffset(previous), position.encoding);
  }
}

export interface RetainedTypstFile {
  readonly uri: string;
  readonly text?: string;
}

export interface RetainedTypstGeneration {
  readonly entryUri: string;
  readonly revision: number;
  readonly files: readonly RetainedTypstFile[];
  readonly sourceContent: SourceContentKey;
  readonly projectDigest: TypstProjectSnapshotKey;
  readonly projectionKey: ProjectionKey;
}

export interface ProjectedPositionRequestWire {
  readonly textDocument: { readonly uri: string };
  readonly position: WirePosition;
  readonly backendEncoding: PositionEncoding;
}

export interface ProjectedPositionWire {
  readonly entryUri: string;
  readonly revision: number;
  readonly position: WirePosition;
  readonly positionEncoding: PositionEncoding;
  readonly sourceContent: SourceContentKey;
  readonly projectDigest: TypstProjectSnapshotKey;
  readonly projectionKey: ProjectionKey;
}

export interface RetainedBackendPosition {
  readonly entryUri: string;
  readonly revision: number;
  readonly index: LineIndex;
  readonly position: TinymistBackendPosition;
  readonly sourceContent: SourceContentKey;
  readonly projectDigest: TypstProjectSnapshotKey;
  readonly projectionKey: ProjectionKey;
}

export function parseProjectedPosition(value: unknown): ProjectedPositionWire {
  if (typeof value !== "object" || value === null) {
    throw new PositionConversionError("AbsentGeneration");
  }
  const candidate = value as Partial<ProjectedPositionWire>;
  if (
    typeof candidate.entryUri !== "string"
    || !Number.isSafeInteger(candidate.revision)
    || (candidate.revision as number) < 0
    || typeof candidate.position !== "object"
    || candidate.position === null
    || (candidate.positionEncoding !== "utf-8" && candidate.positionEncoding !== "utf-16")
    || typeof candidate.sourceContent !== "string"
    || typeof candidate.projectDigest !== "string"
    || typeof candidate.projectionKey !== "string"
  ) {
    throw new PositionConversionError("AmbiguousEncoding");
  }
  const position = candidate.position as WirePosition;
  return {
    entryUri: candidate.entryUri,
    revision: candidate.revision as number,
    position: {
      line: checkedCoordinate(position.line),
      character: checkedCoordinate(position.character)
    },
    positionEncoding: candidate.positionEncoding,
    sourceContent: candidate.sourceContent,
    projectDigest: candidate.projectDigest,
    projectionKey: candidate.projectionKey
  };
}

export function retainedBackendPosition(
  value: ProjectedPositionWire,
  generation: RetainedTypstGeneration | undefined
): RetainedBackendPosition {
  if (!generation) throw new PositionConversionError("AbsentGeneration");
  if (generation.entryUri !== value.entryUri) {
    throw new PositionConversionError("ProjectionMismatch");
  }
  if (generation.revision !== value.revision) {
    throw new PositionConversionError("StaleProjection");
  }
  if (
    generation.sourceContent !== value.sourceContent
    || generation.projectDigest !== value.projectDigest
    || generation.projectionKey !== value.projectionKey
  ) {
    throw new PositionConversionError("ProjectionMismatch");
  }
  const file = generation.files.find((candidate) => candidate.uri === value.entryUri);
  if (typeof file?.text !== "string") throw new PositionConversionError("AbsentGeneration");
  const index = new LineIndex(file.text);
  const position = tinymistBackendPosition(value.position, value.positionEncoding);
  index.backendToByte(position);
  return {
    entryUri: value.entryUri,
    revision: value.revision,
    sourceContent: value.sourceContent,
    projectDigest: value.projectDigest,
    projectionKey: value.projectionKey,
    index,
    position
  };
}

export interface ProjectedRangeRequestWire {
  readonly textDocument: { readonly uri: string };
  readonly range: WireRange;
  readonly backendEncoding: PositionEncoding;
}

export interface ProjectedRangeWire {
  readonly entryUri: string;
  readonly revision: number;
  readonly range: WireRange;
  readonly positionEncoding: PositionEncoding;
  readonly sourceContent: SourceContentKey;
  readonly projectDigest: TypstProjectSnapshotKey;
  readonly projectionKey: ProjectionKey;
}

export interface RetainedBackendRange {
  readonly entryUri: string;
  readonly revision: number;
  readonly index: LineIndex;
  readonly range: WireRange;
  readonly encoding: PositionEncoding;
  readonly sourceContent: SourceContentKey;
  readonly projectDigest: TypstProjectSnapshotKey;
  readonly projectionKey: ProjectionKey;
}

export function parseProjectedRange(value: unknown): ProjectedRangeWire {
  if (typeof value !== "object" || value === null) {
    throw new PositionConversionError("AbsentGeneration");
  }
  const candidate = value as Partial<ProjectedRangeWire>;
  if (
    typeof candidate.entryUri !== "string"
    || !Number.isSafeInteger(candidate.revision)
    || (candidate.revision as number) < 0
    || typeof candidate.range !== "object"
    || candidate.range === null
    || (candidate.positionEncoding !== "utf-8" && candidate.positionEncoding !== "utf-16")
    || typeof candidate.sourceContent !== "string"
    || typeof candidate.projectDigest !== "string"
    || typeof candidate.projectionKey !== "string"
  ) {
    throw new PositionConversionError("AmbiguousEncoding");
  }
  const range = candidate.range as WireRange;
  return {
    entryUri: candidate.entryUri,
    revision: candidate.revision as number,
    range: {
      start: { line: checkedCoordinate(range.start?.line), character: checkedCoordinate(range.start?.character) },
      end: { line: checkedCoordinate(range.end?.line), character: checkedCoordinate(range.end?.character) }
    },
    positionEncoding: candidate.positionEncoding,
    sourceContent: candidate.sourceContent,
    projectDigest: candidate.projectDigest,
    projectionKey: candidate.projectionKey
  };
}

export function retainedBackendRange(
  value: ProjectedRangeWire,
  generation: RetainedTypstGeneration | undefined
): RetainedBackendRange {
  if (!generation) throw new PositionConversionError("AbsentGeneration");
  if (generation.entryUri !== value.entryUri) throw new PositionConversionError("ProjectionMismatch");
  if (generation.revision !== value.revision) throw new PositionConversionError("StaleProjection");
  if (generation.sourceContent !== value.sourceContent
    || generation.projectDigest !== value.projectDigest
    || generation.projectionKey !== value.projectionKey) {
    throw new PositionConversionError("ProjectionMismatch");
  }
  const file = generation.files.find((candidate) => candidate.uri === value.entryUri);
  if (typeof file?.text !== "string") throw new PositionConversionError("AbsentGeneration");
  const index = new LineIndex(file.text);
  index.backendToByte(tinymistBackendPosition(value.range.start, value.positionEncoding));
  index.backendToByte(tinymistBackendPosition(value.range.end, value.positionEncoding));
  return {
    entryUri: value.entryUri,
    revision: value.revision,
    sourceContent: value.sourceContent,
    projectDigest: value.projectDigest,
    projectionKey: value.projectionKey,
    index,
    range: value.range,
    encoding: value.positionEncoding
  };
}

export interface WireRange {
  readonly start: WirePosition;
  readonly end: WirePosition;
}

export type PositionBearingFamily = "completion" | "hover" | "diagnostics" | "semanticTokens" | "symbols";

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PositionConversionError("InvalidCharacter");
  }
  return value as Record<string, unknown>;
}

function validateBackendWirePosition(
  value: unknown,
  index: LineIndex,
  encoding: PositionEncoding
): void {
  const candidate = requireObject(value);
  index.backendToByte(tinymistBackendPosition({
    line: checkedCoordinate(candidate.line),
    character: checkedCoordinate(candidate.character)
  }, encoding));
}

export function validateBackendWireRange(
  value: unknown,
  index: LineIndex,
  encoding: PositionEncoding
): void {
  const candidate = requireObject(value);
  validateBackendWirePosition(candidate.start, index, encoding);
  validateBackendWirePosition(candidate.end, index, encoding);
  const start = index.backendToByte(tinymistBackendPosition(requireObject(candidate.start) as unknown as WirePosition, encoding));
  const end = index.backendToByte(tinymistBackendPosition(requireObject(candidate.end) as unknown as WirePosition, encoding));
  if (start.value > end.value) throw new PositionConversionError("InvalidCharacter");
}

/** Converts one backend coordinate through an exact retained file generation. */
export function convertBackendWirePosition(
  value: WirePosition,
  index: LineIndex,
  backendEncoding: PositionEncoding,
  clientEncoding: PositionEncoding = "utf-16"
): WirePosition {
  const backend = tinymistBackendPosition(value, backendEncoding);
  return index.byteToClient(index.backendToByte(backend), clientEncoding).value;
}

/** Converts and validates an ordered backend range without clamping. */
export function convertBackendWireRange(
  value: WireRange,
  index: LineIndex,
  backendEncoding: PositionEncoding,
  clientEncoding: PositionEncoding = "utf-16"
): WireRange {
  validateBackendWireRange(value, index, backendEncoding);
  return {
    start: convertBackendWirePosition(value.start, index, backendEncoding, clientEncoding),
    end: convertBackendWirePosition(value.end, index, backendEncoding, clientEncoding)
  };
}

function validateCompletionItem(value: unknown, index: LineIndex, encoding: PositionEncoding): void {
  const item = requireObject(value);
  if (item.textEdit !== undefined) {
    const edit = requireObject(item.textEdit);
    if (edit.range !== undefined) validateBackendWireRange(edit.range, index, encoding);
    if (edit.insert !== undefined) validateBackendWireRange(edit.insert, index, encoding);
    if (edit.replace !== undefined) validateBackendWireRange(edit.replace, index, encoding);
  }
  if (item.additionalTextEdits !== undefined) {
    if (!Array.isArray(item.additionalTextEdits)) throw new PositionConversionError("InvalidCharacter");
    for (const editValue of item.additionalTextEdits) {
      const edit = requireObject(editValue);
      validateBackendWireRange(edit.range, index, encoding);
    }
  }
}

function validateCompletionDefaultEditRange(
  value: unknown,
  index: LineIndex,
  encoding: PositionEncoding
): void {
  const range = requireObject(value);
  if (range.start !== undefined && range.end !== undefined) {
    if (range.insert !== undefined || range.replace !== undefined) {
      throw new PositionConversionError("InvalidCharacter");
    }
    validateBackendWireRange(range, index, encoding);
    return;
  }
  if (range.start !== undefined || range.end !== undefined || range.insert === undefined || range.replace === undefined) {
    throw new PositionConversionError("InvalidCharacter");
  }
  validateBackendWireRange(range.insert, index, encoding);
  validateBackendWireRange(range.replace, index, encoding);
}

function validateSemanticTokens(value: unknown, index: LineIndex, encoding: PositionEncoding): void {
  const response = requireObject(value);
  if (!Array.isArray(response.data) || response.data.length % 5 !== 0) {
    throw new PositionConversionError("InvalidCharacter");
  }
  let line = 0;
  let character = 0;
  for (let offset = 0; offset < response.data.length; offset += 5) {
    const deltaLine = checkedCoordinate(response.data[offset]);
    const deltaStart = checkedCoordinate(response.data[offset + 1]);
    const length = checkedCoordinate(response.data[offset + 2]);
    checkedCoordinate(response.data[offset + 3]);
    checkedCoordinate(response.data[offset + 4]);
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;
    validateBackendWirePosition({ line, character }, index, encoding);
    validateBackendWirePosition({ line, character: character + length }, index, encoding);
  }
}

/** Validates an entire response before any part of it can be published or mapped. */
function validateSymbol(value: unknown, index: LineIndex, encoding: PositionEncoding): void {
  const symbol = requireObject(value);
  if (symbol.range !== undefined) validateBackendWireRange(symbol.range, index, encoding);
  if (symbol.selectionRange !== undefined) {
    validateBackendWireRange(symbol.selectionRange, index, encoding);
  }
  if (symbol.location !== undefined) {
    validateBackendWireRange(requireObject(symbol.location).range, index, encoding);
  }
  if (symbol.children !== undefined) {
    if (!Array.isArray(symbol.children)) throw new PositionConversionError("InvalidCharacter");
    for (const child of symbol.children) validateSymbol(child, index, encoding);
  }
}

export function validatePositionBearingPayload<T>(
  family: PositionBearingFamily,
  value: T,
  index: LineIndex,
  encoding: PositionEncoding
): T {
  if (value == null) return value;
  if (family === "completion") {
    const list = Array.isArray(value) ? undefined : requireObject(value);
    if (list?.itemDefaults !== undefined) {
      const defaults = requireObject(list.itemDefaults);
      if (defaults.editRange !== undefined) {
        validateCompletionDefaultEditRange(defaults.editRange, index, encoding);
      }
    }
    const items = Array.isArray(value) ? value : list?.items;
    if (!Array.isArray(items)) throw new PositionConversionError("InvalidCharacter");
    for (const item of items) validateCompletionItem(item, index, encoding);
  } else if (family === "hover") {
    const hover = requireObject(value);
    if (hover.range !== undefined) validateBackendWireRange(hover.range, index, encoding);
  } else if (family === "diagnostics") {
    if (!Array.isArray(value)) throw new PositionConversionError("InvalidCharacter");
    for (const diagnosticValue of value) {
      const diagnostic = requireObject(diagnosticValue);
      validateBackendWireRange(diagnostic.range, index, encoding);
      if (diagnostic.relatedInformation !== undefined) {
        if (!Array.isArray(diagnostic.relatedInformation)) throw new PositionConversionError("InvalidCharacter");
        for (const relatedValue of diagnostic.relatedInformation) {
          const related = requireObject(relatedValue);
          const location = requireObject(related.location);
          validateBackendWireRange(location.range, index, encoding);
        }
      }
    }
  } else if (family === "symbols") {
    if (!Array.isArray(value)) throw new PositionConversionError("InvalidCharacter");
    for (const symbol of value) validateSymbol(symbol, index, encoding);
  } else {
    validateSemanticTokens(value, index, encoding);
  }
  return value;
}
export function wireBackendPosition(position: TinymistBackendPosition): WirePosition {
  return position.value;
}
