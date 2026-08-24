const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const textCallPrefix = Uint8Array.of(0x23, 0x74, 0x65, 0x78, 0x74, 0x28, 0x22); // #text("

export interface ProjectedTextCall {
  readonly text: string;
  readonly contentStart: number;
  readonly fragmentStart: number;
}

interface ProjectedLiteralContent {
  readonly end: number;
  readonly hasEscape: boolean;
  readonly spans: readonly { readonly start: number; readonly end: number }[];
}

function projectedLiteralContent(
  bytes: Uint8Array,
  contentStart: number,
): ProjectedLiteralContent | undefined {
  const spans: { start: number; end: number }[] = [];
  let spanStart = contentStart;
  let cursor = contentStart;
  let hasEscape = false;
  while (cursor < bytes.byteLength) {
    if (bytes[cursor] === 0x22) {
      if (cursor > spanStart) spans.push({ start: spanStart, end: cursor });
      return Object.freeze({ end: cursor, hasEscape, spans: Object.freeze(spans) });
    }
    if (bytes[cursor] !== 0x5c) {
      cursor += 1;
      continue;
    }
    hasEscape = true;
    if (cursor > spanStart) spans.push({ start: spanStart, end: cursor });
    const escapeMarker = cursor + 1;
    if (escapeMarker >= bytes.byteLength) return undefined;
    if (bytes[escapeMarker] === 0x75 && bytes[escapeMarker + 1] === 0x7b) {
      cursor = escapeMarker + 2;
      while (cursor < bytes.byteLength && bytes[cursor] !== 0x7d) cursor += 1;
      if (cursor >= bytes.byteLength) return undefined;
      cursor += 1;
    } else {
      cursor = escapeMarker + 1;
    }
    spanStart = cursor;
  }
  return undefined;
}

function matchProjectedLiteral(
  bytes: Uint8Array,
  content: ProjectedLiteralContent,
  expectedText: string | undefined,
): ProjectedTextCall | undefined {
  if (expectedText === undefined) {
    if (content.hasEscape || content.spans.length !== 1) return undefined;
    const span = content.spans[0]!;
    const text = decoder.decode(bytes.subarray(span.start, span.end));
    return Object.freeze({ text, contentStart: span.start, fragmentStart: 0 });
  }
  if (expectedText.length === 0) return undefined;
  let match: ProjectedTextCall | undefined;
  for (const span of content.spans) {
    const text = decoder.decode(bytes.subarray(span.start, span.end));
    let fragmentStart = text.indexOf(expectedText);
    while (fragmentStart >= 0) {
      if (match) return undefined;
      match = Object.freeze({ text, contentStart: span.start, fragmentStart });
      fragmentStart = text.indexOf(expectedText, fragmentStart + 1);
    }
  }
  return match;
}

export function findProjectedTextCall(
  source: string,
  locationStart: number,
  locationEnd: number,
  expectedText?: string,
): ProjectedTextCall | undefined {
  const bytes = encoder.encode(source);
  let searchStart = Math.min(locationStart, bytes.byteLength);
  while (searchStart > 0 && bytes[searchStart - 1] !== 0x0a) searchStart -= 1;
  const searchEnd = Math.min(bytes.byteLength - textCallPrefix.byteLength, locationEnd + textCallPrefix.byteLength);
  for (let markerStart = searchStart; markerStart <= searchEnd; markerStart += 1) {
    if (!textCallPrefix.every((byte, index) => bytes[markerStart + index] === byte)) continue;
    const identifierEnd = markerStart + 5;
    const contentStart = markerStart + textCallPrefix.byteLength;
    const content = projectedLiteralContent(bytes, contentStart);
    if (!content) return undefined;
    const overlapsIdentifier = locationEnd >= markerStart && locationStart <= identifierEnd;
    const liesInsideContent = contentStart <= locationStart && locationEnd <= content.end;
    if (!overlapsIdentifier && !liesInsideContent) continue;
    try {
      return matchProjectedLiteral(bytes, content, expectedText);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function projectedTextCharacterByteOffset(
  call: ProjectedTextCall,
  fragmentTextOffset: number,
): number | undefined {
  const textOffset = call.fragmentStart + fragmentTextOffset;
  if (!Number.isSafeInteger(fragmentTextOffset) || fragmentTextOffset < 0 || textOffset >= call.text.length) {
    return undefined;
  }
  let validBoundary = false;
  let offset = 0;
  for (const character of call.text) {
    if (offset === textOffset) {
      validBoundary = true;
      break;
    }
    offset += character.length;
  }
  if (!validBoundary) return undefined;
  return call.contentStart + encoder.encode(call.text.slice(0, textOffset)).byteLength;
}
