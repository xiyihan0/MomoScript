import type { TinymistHostBackend, TypstProjectUpdate } from "../tinymistClient";
import { canonicalBytesDigest } from "../runtimeIdentity";
import {
  PREVIEW_RENDERER_METHOD,
  PREVIEW_RENDERER_PROTOCOL_VERSION,
  validatePreviewRendererGeometryResponse,
  validatePreviewRendererReady,
  type PreviewRendererBox,
  type PreviewRendererCaret,
  type PreviewRendererGeometryRequest,
  type PreviewRendererGeometryResponse,
  type PreviewRendererPosition,
  type PreviewRendererPointUncertainty,
  type PreviewRendererReady,
} from "../previewRendererProtocol";

const ZERO_POINT_UNCERTAINTY: PreviewRendererPointUncertainty = { x: 0, y: 0 };

/** Exercise the same real compiled glyphs through the process and WASM transports. */
export async function testPreviewRendererGeometry(
  client: TinymistHostBackend,
  fontBytes: readonly Uint8Array[],
): Promise<void> {
  if (!client.capabilities().has(PREVIEW_RENDERER_METHOD)) {
    throw new Error("Renderer must advertise all three exact text geometry actions");
  }
  const fonts = await Promise.all(fontBytes.map(async (bytes) => {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return {
      contentDigest: await canonicalBytesDigest("mmt-project-file-v1", [bytes]),
      dataBase64: btoa(binary),
    };
  }));
  const lines = [
    "#set page(width: 300pt, height: 400pt, margin: 20pt)",
    '#set text(font: ("New Computer Modern Math", "DejaVu Sans Mono", "Noto Sans CJK SC"), size: 14pt)',
    '#text("Wi")',
    "#parbreak()",
    '#text("A😀é中 ASCII")',
    "#parbreak()",
    '#text("first\\nsecond")',
    "#parbreak()",
    "#let repeated = [repeat]",
    "#repeated",
    "#linebreak()",
    "#repeated",
    "#pagebreak()",
    '#text("last page")',
    "#parbreak()",
    '#text("computed" + " text")',
  ];
  const emptyPrefix = '#box(width:0pt,height:14pt)[#text("';
  const emptyLine = lines.length + 1;
  const emptyCharacter = emptyPrefix.length;
  const emptyOffset = new TextEncoder().encode([...lines, "#parbreak()", emptyPrefix].join("\n")).length;
  lines.push("#parbreak()", `${emptyPrefix}")#metadata((mmtTextCaret:${emptyOffset}))]`);
  const text = lines.join("\n");
  const bytes = new TextEncoder().encode(text);
  const digest = await canonicalBytesDigest("mmt-project-file-v1", [bytes]);
  const project: TypstProjectUpdate = {
    sourceUri: "file:///workspace/renderer-geometry.mmt",
    sourceVersion: 1,
    revision: 1,
    entryUri: "untitled:/mmt-projection/renderer-geometry/main.typ",
    files: [{ uri: "untitled:/mmt-projection/renderer-geometry/main.typ", text, digest }],
    full: true,
    sourceContent: digest as TypstProjectUpdate["sourceContent"],
    projectDigest: digest as TypstProjectUpdate["projectDigest"],
    projectionKey: digest as TypstProjectUpdate["projectionKey"],
    mappingDigest: digest,
  };
  const sessionId = "text-geometry-contract";
  const mount = { logicalSourceId: "9".repeat(64), fonts };
  let generation = 1;
  let pageCount = 0;
  let uri = "";
  const query = async (request: PreviewRendererGeometryRequest): Promise<PreviewRendererGeometryResponse> => {
    const response = await client.request<unknown>(PREVIEW_RENDERER_METHOD, request);
    return validatePreviewRendererGeometryResponse(response, { ...request, pageCount });
  };
  const request = (position: PreviewRendererPosition): Extract<PreviewRendererGeometryRequest, { action: "locateCaret" }> => ({
    protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
    action: "locateCaret",
    sessionId,
    generation,
    uri,
    position,
    affinity: "after",
  });
  const caretsAt = async (line: number, character: number): Promise<readonly PreviewRendererCaret[]> => {
    const result = await query(request({ line, character }));
    if (result.status !== "locatedCaret") throw new Error("Committed source caret was unavailable");
    return result.carets;
  };
  const rangeAt = async (line: number, start: number, end: number): Promise<readonly PreviewRendererBox[]> => {
    const result = await query({
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "locateRange",
      sessionId,
      generation,
      uri,
      range: { start: { line, character: start }, end: { line, character: end } },
    });
    if (result.status !== "locatedRange") throw new Error("Committed source range was unavailable");
    return result.boxes;
  };
  const oneCaret = async (line: number, character: number): Promise<PreviewRendererCaret> => {
    const carets = await caretsAt(line, character);
    if (carets.length !== 1) throw new Error(`Expected exactly one rendered caret for ${line}:${character}`);
    return carets[0];
  };
  const expectHit = async (
    left: PreviewRendererCaret,
    right: PreviewRendererCaret,
    fraction: number,
    line: number,
    character: number,
  ): Promise<void> => {
    const result = await query({
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "hitTestText",
      sessionId,
      generation,
      position: {
        pageIndex: left.pageIndex,
        x: left.x + (right.x - left.x) * fraction,
        y: left.y + left.height / 2,
      },
      uncertainty: ZERO_POINT_UNCERTAINTY,
    });
    if (result.status !== "textHit" || result.location?.uri !== uri
      || result.location.range.start.line !== line || result.location.range.start.character !== character) {
      throw new Error(`Rendered glyph hit did not resolve the exact source boundary ${line}:${character}`);
    }
  };
  try {
    const snapshotToken = "8".repeat(64) as PreviewRendererReady["snapshotToken"];
    const first = await client.previewRenderer(project, mount, { sessionId, snapshotToken, forceFull: true });
    if (first.response.status !== "ready") throw new Error("Text geometry fixture did not compile");
    await validatePreviewRendererReady(first.response, { sessionId, snapshotToken, sourceDigest: first.synchronized.sourceDigest });
    generation = first.response.generation;
    pageCount = first.response.pageCount;
    uri = first.synchronized.project.entryUri;
    if (pageCount !== 2) throw new Error("Text geometry fixture must render exactly two pages");
    const unavailableBeforeCommit = await query(request({ line: 2, character: 7 }));
    if (unavailableBeforeCommit.status !== "unavailable") throw new Error("Staged text geometry became queryable before commit");
    const committed = await client.transitionPreviewRenderer({ action: "commit", sessionId, snapshotToken, generation });
    if (committed.status !== "committed") throw new Error("Text geometry fixture did not commit");

    const start = await oneCaret(2, 7);
    const middle = await oneCaret(2, 8);
    const end = await oneCaret(2, 9);
    if (start.pageIndex !== 0 || middle.y !== start.y || end.y !== start.y
      || !(middle.x - start.x > end.x - middle.x) || !(end.x > middle.x)) {
      throw new Error("Proportional Wi carets must use their different glyph advances");
    }
    const before = await query({ ...request({ line: 2, character: 8 }), affinity: "before" });
    if (before.status !== "locatedCaret" || before.carets.length !== 1
      || before.carets[0].affinity !== "before" || Math.abs(before.carets[0].x - middle.x) > 1e-6) {
      throw new Error("Caret affinity changed an unwrapped glyph boundary");
    }
    await expectHit(start, middle, 0.1, 2, 7);
    await expectHit(start, middle, 0.9, 2, 8);
    await expectHit(middle, end, 0.9, 2, 9);
    const outsideDelta = 1 / 300;
    const outsidePosition = {
      pageIndex: start.pageIndex,
      x: start.x - outsideDelta,
      y: start.y + start.height / 2,
    };
    const outsideWithoutUncertainty = await query({
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "hitTestText",
      sessionId,
      generation,
      position: outsidePosition,
      uncertainty: ZERO_POINT_UNCERTAINTY,
    });
    if (outsideWithoutUncertainty.status !== "unavailable"
      && (outsideWithoutUncertainty.status !== "textHit" || outsideWithoutUncertainty.location !== null)) {
      throw new Error("A point outside the glyph cluster must miss without uncertainty");
    }
    const outsideWithInsufficientUncertainty = await query({
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "hitTestText",
      sessionId,
      generation,
      position: outsidePosition,
      uncertainty: { x: outsideDelta / 2, y: 0 },
    });
    if (outsideWithInsufficientUncertainty.status !== "unavailable"
      && (outsideWithInsufficientUncertainty.status !== "textHit"
        || outsideWithInsufficientUncertainty.location !== null)) {
      throw new Error("Uncertainty that does not reach the glyph cluster must still miss");
    }
    const outsideWithUncertainty = await query({
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "hitTestText",
      sessionId,
      generation,
      position: outsidePosition,
      uncertainty: { x: outsideDelta * 2, y: 0 },
    });
    if (outsideWithUncertainty.status !== "textHit"
      || outsideWithUncertainty.location?.uri !== uri
      || outsideWithUncertainty.location.range.start.line !== 2
      || outsideWithUncertainty.location.range.start.character !== 7) {
      throw new Error("Text-hit uncertainty must admit an intersecting glyph without changing its exact source stop");
    }
    const selectedW = await rangeAt(2, 7, 8);
    if (selectedW.length !== 1 || selectedW[0].pageIndex !== start.pageIndex
      || Math.abs(selectedW[0].x - start.x) > 1e-6
      || Math.abs(selectedW[0].x + selectedW[0].width - middle.x) > 1e-6
      || Math.abs(selectedW[0].y - start.y) > 1e-6
      || Math.abs(selectedW[0].height - start.height) > 1e-6) {
      throw new Error("Selection geometry must cover exactly the selected W, not its neighbor");
    }
    const unicodeStart = await oneCaret(4, 7);
    const emojiStart = await oneCaret(4, 8);
    const emojiEnd = await oneCaret(4, 10);
    const combiningEnd = await oneCaret(4, 12);
    const cjkEnd = await oneCaret(4, 13);
    if (!(unicodeStart.x < emojiStart.x && emojiStart.x < emojiEnd.x
      && emojiEnd.x < combiningEnd.x && combiningEnd.x < cjkEnd.x)) {
      throw new Error("Unicode scalar/grapheme boundaries did not preserve visual order");
    }
    await expectHit(emojiStart, emojiEnd, 0.9, 4, 10);
    await expectHit(emojiEnd, combiningEnd, 0.9, 4, 12);
    for (const character of [9, 11]) {
      const invalid = await query(request({ line: 4, character }));
      if (invalid.status !== "unavailable" && (invalid.status !== "locatedCaret" || invalid.carets.length !== 0)) {
        throw new Error("Renderer invented a caret inside a surrogate or combining cluster");
      }
    }
    const beforeNewline = await oneCaret(6, 12);
    const afterNewline = await oneCaret(6, 14);
    if (beforeNewline.pageIndex !== afterNewline.pageIndex || !(afterNewline.y > beforeNewline.y)) {
      throw new Error("Escaped newline endpoints did not resolve to their separate rendered lines");
    }
    const escapeInterior = await query(request({ line: 6, character: 13 }));
    if (escapeInterior.status !== "unavailable"
      && (escapeInterior.status !== "locatedCaret" || escapeInterior.carets.length !== 0)) {
      throw new Error("Renderer invented a caret inside a string escape");
    }
    const newlineSelection = await rangeAt(6, 7, 20);
    if (!newlineSelection.some((box) => Math.abs(box.y - beforeNewline.y) < 1e-6)
      || !newlineSelection.some((box) => Math.abs(box.y - afterNewline.y) < 1e-6)
      || newlineSelection.some((box) => box.y < beforeNewline.y - 1e-6
        || box.y + box.height > afterNewline.y + afterNewline.height + 1e-6)) {
      throw new Error("Escaped multiline selection crossed an unrelated rendered line");
    }
    const repeated = await caretsAt(8, 17);
    const repeatedNext = await caretsAt(8, 18);
    if (repeated.length !== 2 || repeatedNext.length !== 2 || repeated[0].y === repeated[1].y) {
      throw new Error("One source span must retain both distinct rendered occurrences");
    }
    for (const occurrence of repeated) {
      const next = repeatedNext.find((caret) => caret.pageIndex === occurrence.pageIndex && caret.y === occurrence.y);
      if (!next) throw new Error("Repeated rendered caret lost its occurrence");
      await expectHit(occurrence, next, 0.1, 8, 17);
    }
    const repeatedBoxes = await rangeAt(8, 17, 23);
    if (repeated.some((caret) => !repeatedBoxes.some((box) => box.pageIndex === caret.pageIndex && Math.abs(box.y - caret.y) < 1e-6))) {
      throw new Error("Range geometry omitted a repeated source occurrence");
    }
    const lastPage = await oneCaret(13, 7);
    if (lastPage.pageIndex !== 1) throw new Error("Text geometry returned the wrong rendered page");
    const empty = await oneCaret(emptyLine, emptyCharacter);
    const emptyBefore = await query({
      ...request({ line: emptyLine, character: emptyCharacter }),
      affinity: "before",
    });
    const emptyBoxes = await rangeAt(emptyLine, emptyCharacter, emptyCharacter);
    if (empty.pageIndex !== 1 || empty.width !== 0 || Math.abs(empty.height - 14 / 400) > 1e-6
      || emptyBefore.status !== "locatedCaret" || emptyBefore.carets.length !== 1
      || emptyBefore.carets[0].affinity !== "before"
      || emptyBefore.carets[0].x !== empty.x || emptyBefore.carets[0].y !== empty.y
      || emptyBefore.carets[0].height !== empty.height
      || emptyBoxes.length !== 1 || emptyBoxes[0].width !== 0
      || emptyBoxes[0].pageIndex !== empty.pageIndex
      || emptyBoxes[0].x !== empty.x || emptyBoxes[0].y !== empty.y
      || emptyBoxes[0].height !== empty.height) {
      throw new Error("Empty text marker must resolve the actual zero-width hard frame for both caret affinities and collapsed range");
    }
    const computed = await query(request({ line: 15, character: 7 }));
    if (computed.status !== "unavailable"
      && (computed.status !== "locatedCaret" || computed.carets.length !== 0)) {
      throw new Error("Computed text must not acquire an approximate source caret");
    }
    const margin = await query({
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "hitTestText",
      sessionId,
      generation,
      position: { pageIndex: 0, x: 0, y: 0 },
      uncertainty: ZERO_POINT_UNCERTAINTY,
    });
    if (margin.status !== "unavailable" && (margin.status !== "textHit" || margin.location !== null)) {
      throw new Error("Blank page margin must not resolve to an unrelated glyph");
    }

    const valid = request({ line: 2, character: 8 });
    const hit = {
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "hitTestText",
      sessionId,
      generation,
      position: { pageIndex: 0, x: middle.x, y: middle.y + middle.height / 2 },
      uncertainty: ZERO_POINT_UNCERTAINTY,
    } as const;
    const range = {
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "locateRange",
      sessionId,
      generation,
      uri,
      range: { start: { line: 2, character: 7 }, end: { line: 2, character: 8 } },
    } as const;
    for (const queryRequest of [valid, hit, range]) {
      for (const stale of [{ ...queryRequest, generation: generation + 1 }, { ...queryRequest, sessionId: "not-this-session" }]) {
        const response = await query(stale);
        if (response.status !== "unavailable") throw new Error("Stale renderer geometry request did not fail closed");
      }
    }
    const hitWithoutUncertainty = {
      protocolVersion: PREVIEW_RENDERER_PROTOCOL_VERSION,
      action: "hitTestText",
      sessionId,
      generation,
      position: hit.position,
    } as const;
    for (const invalid of [
      hitWithoutUncertainty,
      { ...hit, uncertainty: { x: 0 } },
      { ...hit, uncertainty: { ...hit.uncertainty, radius: 0 } },
      { ...hit, uncertainty: { ...hit.uncertainty, x: Number.NaN } },
      { ...hit, uncertainty: { ...hit.uncertainty, y: Number.NEGATIVE_INFINITY } },
      { ...hit, uncertainty: { ...hit.uncertainty, y: Number.POSITIVE_INFINITY } },
      { ...hit, uncertainty: { ...hit.uncertainty, x: -Number.EPSILON } },
      { ...hit, uncertainty: { ...hit.uncertainty, y: 1 + Number.EPSILON } },
      { ...valid, unexpected: true },
      { ...valid, uncertainty: ZERO_POINT_UNCERTAINTY },
      { ...valid, position: { ...valid.position, offset: 8 } },
      { ...valid, affinity: "nearest" },
      { ...hit, position: { ...hit.position, width: 0 } },
      { ...hit, position: { ...hit.position, x: 1.1 } },
      { ...range, range: { ...range.range, kind: "range" } },
      { ...range, uncertainty: ZERO_POINT_UNCERTAINTY },
      { ...range, range: { start: range.range.end, end: range.range.start } },
    ]) {
      let rejected = false;
      try {
        await client.request(PREVIEW_RENDERER_METHOD, invalid);
      } catch (error) {
        rejected = error instanceof Error;
      }
      if (!rejected) throw new Error("Renderer accepted an unknown or malformed geometry payload");
    }
    await oneCaret(2, 8);
    const nextToken = "7".repeat(64) as PreviewRendererReady["snapshotToken"];
    const replacement = await client.previewRenderer(project, mount, {
      sessionId, snapshotToken: nextToken, baseGeneration: generation,
    });
    if (replacement.response.status !== "ready") throw new Error("Text geometry replacement did not compile");
    await validatePreviewRendererReady(replacement.response, {
      sessionId, snapshotToken: nextToken, sourceDigest: replacement.synchronized.sourceDigest,
    });
    const replacementCommit = await client.transitionPreviewRenderer({
      action: "commit", sessionId, snapshotToken: nextToken, generation: replacement.response.generation,
    });
    if (replacementCommit.status !== "committed") throw new Error("Text geometry replacement did not commit");
    for (const oldRequest of [valid, hit, range]) {
      if ((await query(oldRequest)).status !== "unavailable") throw new Error("Replaced glyph geometry was returned as current");
    }
    generation = replacement.response.generation;
    const restored = await oneCaret(2, 8);
    if (restored.pageIndex !== middle.pageIndex || Math.abs(restored.x - middle.x) > 1e-6
      || Math.abs(restored.y - middle.y) > 1e-6) {
      throw new Error("New committed geometry did not preserve the unchanged source caret");
    }
  } finally {
    await client.closePreviewRenderer(sessionId);
  }
}
