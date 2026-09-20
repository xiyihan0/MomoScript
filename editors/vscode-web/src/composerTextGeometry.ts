import type { Range } from "vscode-languageserver";
import type { RenderKey } from "../../vscode/src/runtimeIdentity";
import type {
  PreviewRendererAffinity,
  PreviewRendererBox,
  PreviewRendererCaret,
  PreviewRendererPoint,
  PreviewRendererPointUncertainty,
  PreviewRendererPosition,
} from "../../vscode/src/previewRendererProtocol";
import type { ComposerDocumentNode, ComposerDocumentSnapshot, ComposerNodeRef } from "./composerDocument";
import {
  parseComposerTextProjectionResult,
  parseComposerTextSelection,
  parseComposerTextSelectionResult,
  type ComposerEditRejectedReason,
  type ComposerTextEndpoint,
  type ComposerTextProjectionParams,
  type ComposerTextProjectionResult,
  type ComposerTextSelection,
  type ComposerTextSelectionParams,
} from "./composerEdit";
import type { PreviewComposerTargetParams } from "./previewComposer";
import type { PreviewSourceTarget } from "./previewArtifact";
import type { PreviewBackendLocation } from "./previewInteraction";
import type { PreviewRendererCandidate, PreviewRendererSessionOwner } from "./previewRendererSession";

/** Both authored authorization and the displayed, committed frame are part of identity. */
export interface ComposerTextGeometryIdentity extends Omit<PreviewComposerTargetParams, "location"> {
  readonly version: number;
  readonly sourceDigest: string;
  readonly renderKey: RenderKey;
  readonly sessionId: string;
  readonly generation: number;
}

export interface ComposerTextGeometryBinding {
  readonly identity: ComposerTextGeometryIdentity;
  readonly snapshot: ComposerDocumentSnapshot;
  readonly candidate: PreviewRendererCandidate;
  /** The encoding negotiated with this Tinymist session, not the MMT client encoding. */
  readonly rendererEncoding: "utf-8" | "utf-16";
}

export interface ComposerTextGeometryDependencies {
  /** Return one atomic view of the active document and published renderer generation. */
  readonly current: () => ComposerTextGeometryBinding | undefined;
  readonly renderer: Pick<PreviewRendererSessionOwner, "hitTestText" | "locateCaret" | "locateRange">;
  readonly readSelection: (params: ComposerTextSelectionParams, signal: AbortSignal) => PromiseLike<unknown>;
  readonly projectSelection: (params: ComposerTextProjectionParams, signal: AbortSignal) => PromiseLike<unknown>;
  /** The complete parsed mapTypstReadLocations result; never choose a navigation fallback here. */
  readonly mapToAuthored: (
    location: PreviewBackendLocation,
    identity: ComposerTextGeometryIdentity,
    signal: AbortSignal,
  ) => PromiseLike<readonly PreviewSourceTarget[]>;
}

/** A presentation bookmark, never an edit capability or a replacement source position. */
export interface ComposerTextOccurrence extends PreviewRendererPoint {
  readonly renderKey: RenderKey;
  readonly sessionId: string;
  readonly generation: number;
  readonly index: number;
  readonly count: number;
}

export interface ComposerTextGeometryEndpoint extends ComposerTextEndpoint {
  readonly affinity?: PreviewRendererAffinity;
  readonly occurrence?: ComposerTextOccurrence;
}

export interface ComposerTextGeometrySelection extends ComposerTextSelection {
  readonly anchor: ComposerTextGeometryEndpoint;
  readonly focus: ComposerTextGeometryEndpoint;
}

export type ComposerTextGeometryDirection = "left" | "right" | "up" | "down";
export type ComposerTextGeometryGranularity = "grapheme" | "word" | "visualLine" | "document";
export type ComposerTextGeometryUnavailableReason = ComposerEditRejectedReason
  | "stale" | "aborted" | "unmapped" | "ambiguous" | "unavailable";

export interface ComposerTextGeometryUnavailable {
  readonly status: "unavailable";
  readonly reason: ComposerTextGeometryUnavailableReason;
}

export interface ComposerTextCaretGeometry {
  readonly status: "mapped";
  readonly identity: ComposerTextGeometryIdentity;
  readonly endpoint: ComposerTextGeometryEndpoint;
  readonly authored: PreviewBackendLocation;
  readonly carets: readonly PreviewRendererCaret[];
  /** Null means multiple occurrences exist and none has been explicitly chosen. */
  readonly caret: PreviewRendererCaret | null;
}

export interface ComposerTextSelectionGeometry {
  readonly status: "mapped";
  readonly identity: ComposerTextGeometryIdentity;
  readonly selection: ComposerTextGeometrySelection;
  /** Rust's semantic copy text, including LF separators between selected statements. */
  readonly text: string;
  readonly anchorCarets: readonly PreviewRendererCaret[];
  readonly carets: readonly PreviewRendererCaret[];
  readonly anchorCaret: PreviewRendererCaret | null;
  readonly focusCaret: PreviewRendererCaret | null;
  readonly boxes: readonly PreviewRendererBox[];
  readonly preferredX: number | null;
}

export type ComposerTextCaretGeometryResult = ComposerTextCaretGeometry | ComposerTextGeometryUnavailable;
export type ComposerTextSelectionGeometryResult = ComposerTextSelectionGeometry | ComposerTextGeometryUnavailable;

type TextNode = Extract<ComposerDocumentNode, { kind: "message" | "narration" }>;
type Projection = Extract<ComposerTextProjectionResult, { kind: "Mapped" }>;
interface AuthorizedSelection {
  readonly text: string;
  readonly projection: Projection;
  readonly anchor: PreviewBackendLocation;
  readonly focus: PreviewBackendLocation;
}
interface CaretPresentation {
  readonly endpoint: ComposerTextGeometryEndpoint;
  readonly carets: readonly PreviewRendererCaret[];
  readonly caret: PreviewRendererCaret | null;
}
interface VisualEntry {
  readonly box: PreviewRendererBox;
  readonly endpoint?: ComposerTextGeometryEndpoint;
}
interface VisualLine {
  readonly pageIndex: number;
  top: number;
  bottom: number;
  readonly entries: VisualEntry[];
}

const GRAPHEMES = new Intl.Segmenter("und", { granularity: "grapheme" });
const WORDS = new Intl.Segmenter("und", { granularity: "word" });
const EPSILON = 1e-10;
const ZERO_POINT_UNCERTAINTY: PreviewRendererPointUncertainty = { x: 0, y: 0 };
const NEVER_ABORTED_SIGNAL = new AbortController().signal;

class GeometryUnavailable extends Error {
  constructor(readonly reason: ComposerTextGeometryUnavailableReason) {
    super(`Composer text geometry is ${reason}`);
  }
}

/**
 * Pure read-only adapter. DOM text, statement midpoints and average glyph widths are
 * deliberately absent. Every generated/authored round trip is proved by Rust.
 */
export class ComposerTextGeometry {
  readonly #dependencies: ComposerTextGeometryDependencies;

  constructor(dependencies: ComposerTextGeometryDependencies) {
    this.#dependencies = dependencies;
  }

  hitTest(
    point: PreviewRendererPoint,
    uncertainty: PreviewRendererPointUncertainty,
    identity: ComposerTextGeometryIdentity,
    signal: AbortSignal = NEVER_ABORTED_SIGNAL,
  ): Promise<ComposerTextCaretGeometryResult> {
    return this.#run(identity, signal, (binding) => this.#hitTest(point, uncertainty, binding, signal));
  }

  caret(
    endpoint: ComposerTextGeometryEndpoint,
    identity: ComposerTextGeometryIdentity,
    signal: AbortSignal,
  ): Promise<ComposerTextCaretGeometryResult> {
    return this.#run(identity, signal, async (binding) => {
      const authorized = await this.#authorize({ anchor: endpoint, focus: endpoint }, binding, signal);
      const presentation = await this.#presentCaret(endpoint, authorized.projection.focus, binding, signal);
      return { status: "mapped" as const, identity, authored: authorized.focus, ...presentation };
    });
  }

  selection(
    selection: ComposerTextGeometrySelection,
    identity: ComposerTextGeometryIdentity,
    signal: AbortSignal,
  ): Promise<ComposerTextSelectionGeometryResult> {
    return this.#run(identity, signal, (binding) => this.#selection(selection, binding, signal, null));
  }

  move(
    selection: ComposerTextGeometrySelection,
    direction: ComposerTextGeometryDirection,
    granularity: ComposerTextGeometryGranularity,
    extend: boolean,
    preferredX: number | null,
    identity: ComposerTextGeometryIdentity,
    signal: AbortSignal,
  ): Promise<ComposerTextSelectionGeometryResult> {
    return this.#run(identity, signal, async (binding) => {
      if (!(direction === "left" || direction === "right" || direction === "up" || direction === "down")
        || !(granularity === "grapheme" || granularity === "word" || granularity === "visualLine" || granularity === "document")
        || typeof extend !== "boolean"
        || (preferredX !== null && (!Number.isFinite(preferredX) || preferredX < 0 || preferredX > 1))) {
        throw new GeometryUnavailable("invalidValue");
      }
      const authorized = await this.#authorize(selection, binding, signal);
      const backward = direction === "left" || direction === "up";
      let focus: ComposerTextGeometryEndpoint;
      let nextPreferredX: number | null = null;
      if (granularity === "document") {
        const node = backward ? binding.snapshot.nodes.find(isEditable) : binding.snapshot.nodes.findLast(isEditable);
        if (!node) throw new GeometryUnavailable("unmapped");
        focus = endpointFor(node, backward ? 0 : node.textEditing!.text.length, selection.focus);
      } else if ((direction === "left" || direction === "right") && granularity !== "visualLine") {
        if (!extend && !sameEndpoint(selection.anchor, selection.focus)) {
          const ordered = compareEndpoints(selection.anchor, selection.focus, binding.snapshot) <= 0;
          focus = backward === ordered ? selection.anchor : selection.focus;
        } else {
          focus = this.#logicalMove(selection.focus, backward, granularity, binding);
        }
      } else {
        const current = await this.#presentCaret(selection.focus, authorized.projection.focus, binding, signal);
        if (!current.caret) throw new GeometryUnavailable("ambiguous");
        const x = preferredX ?? current.caret.x;
        focus = await this.#visualMove(current, direction, x, binding, signal);
        if (direction === "up" || direction === "down") nextPreferredX = x;
      }
      return this.#selection({ anchor: extend ? selection.anchor : focus, focus }, binding, signal, nextPreferredX);
    });
  }

  async #run<T>(
    identity: ComposerTextGeometryIdentity,
    signal: AbortSignal,
    operation: (binding: ComposerTextGeometryBinding) => Promise<T>,
  ): Promise<T | ComposerTextGeometryUnavailable> {
    try {
      const binding = this.#dependencies.current();
      if (!binding || !sameIdentity(identity, binding.identity)) throw new GeometryUnavailable("stale");
      this.#assertCurrent(binding, signal);
      const result = await operation(binding);
      this.#assertCurrent(binding, signal);
      return result;
    } catch (error) {
      return {
        status: "unavailable",
        reason: signal.aborted ? "aborted"
          : error instanceof GeometryUnavailable ? error.reason
          : error instanceof TypeError ? "invalidValue" : "unavailable",
      };
    }
  }

  #assertCurrent(binding: ComposerTextGeometryBinding, signal: AbortSignal): void {
    if (signal.aborted) throw new GeometryUnavailable("aborted");
    const current = this.#dependencies.current();
    const { identity, snapshot, candidate } = binding;
    const project = candidate.synchronized.project;
    if (!current || !sameIdentity(identity, current.identity)
      || current.candidate !== candidate || current.snapshot !== snapshot
      || current.rendererEncoding !== binding.rendererEncoding
      || snapshot.textDocument.uri !== identity.sourceUri || snapshot.textDocument.version !== identity.version
      || snapshot.sourceDigest !== identity.sourceDigest
      || candidate.sourceUri !== identity.sourceUri || candidate.sessionId !== identity.sessionId
      || candidate.ready.sessionId !== identity.sessionId || candidate.ready.generation !== identity.generation
      || candidate.ready.snapshotToken !== identity.renderKey
      || candidate.synchronized.compilerEntryUri !== identity.entryUri || project.sourceVersion !== identity.version
      || project.revision !== identity.revision || project.sourceContent !== identity.sourceContent
      || project.projectDigest !== identity.projectDigest || project.projectionKey !== identity.projectionKey
      || (binding.rendererEncoding !== "utf-8" && binding.rendererEncoding !== "utf-16")) {
      throw new GeometryUnavailable("stale");
    }
  }

  async #project(
    selection: ComposerTextSelection,
    binding: ComposerTextGeometryBinding,
    signal: AbortSignal,
  ): Promise<Projection> {
    this.#assertCurrent(binding, signal);
    const semantic = parseComposerTextSelection(wireSelection(selection));
    requireNode(semantic.anchor, binding.snapshot);
    requireNode(semantic.focus, binding.snapshot);
    const { sourceUri, revision, sourceContent, projectDigest, projectionKey, entryUri, backendEncoding } = binding.identity;
    const raw = await this.#dependencies.projectSelection({
      sourceUri, revision, sourceContent, projectDigest, projectionKey, entryUri, backendEncoding, selection: semantic,
    }, signal);
    this.#assertCurrent(binding, signal);
    const result = parseComposerTextProjectionResult(raw, entryUri);
    if (result.kind === "Rejected") throw new GeometryUnavailable(result.reason);
    return result;
  }

  async #authoredLocation(
    location: PreviewBackendLocation,
    binding: ComposerTextGeometryBinding,
    signal: AbortSignal,
  ): Promise<PreviewBackendLocation> {
    if (!collapsed(location.range)) throw new GeometryUnavailable("unmapped");
    const targets = await this.#dependencies.mapToAuthored(location, binding.identity, signal);
    this.#assertCurrent(binding, signal);
    let result: PreviewBackendLocation | undefined;
    for (const target of targets) {
      if (target.kind !== "authoredIdentity") continue;
      if (target.uri !== binding.identity.sourceUri || !target.range || !collapsed(target.range)
        || target.readOnly === true || target.retained === false) throw new GeometryUnavailable("unmapped");
      const candidate = { uri: target.uri, range: target.range };
      if (result && !sameLocation(result, candidate)) throw new GeometryUnavailable("ambiguous");
      result = candidate;
    }
    if (!result) throw new GeometryUnavailable("unmapped");
    return result;
  }

  async #read(
    anchor: PreviewBackendLocation,
    focus: PreviewBackendLocation,
    binding: ComposerTextGeometryBinding,
    signal: AbortSignal,
  ) {
    const expected = { textDocument: binding.snapshot.textDocument, sourceDigest: binding.identity.sourceDigest };
    const raw = await this.#dependencies.readSelection({ ...expected, anchor: anchor.range, focus: focus.range }, signal);
    this.#assertCurrent(binding, signal);
    const result = parseComposerTextSelectionResult(raw, expected, binding.snapshot);
    if (result.kind === "Rejected") throw new GeometryUnavailable(result.reason);
    return result;
  }

  async #authorize(
    selection: ComposerTextSelection,
    binding: ComposerTextGeometryBinding,
    signal: AbortSignal,
  ): Promise<AuthorizedSelection> {
    const projection = await this.#project(selection, binding, signal);
    const anchorRequest = this.#authoredLocation(projection.anchor, binding, signal);
    const [anchor, focus] = await Promise.all([
      anchorRequest,
      sameLocation(projection.anchor, projection.focus) ? anchorRequest : this.#authoredLocation(projection.focus, binding, signal),
    ]);
    const read = await this.#read(anchor, focus, binding, signal);
    if (!sameEndpoint(read.selection.anchor, selection.anchor) || !sameEndpoint(read.selection.focus, selection.focus)) {
      throw new GeometryUnavailable("ambiguous");
    }
    return { text: read.text, projection, anchor, focus };
  }

  async #hitTest(
    point: PreviewRendererPoint,
    uncertainty: PreviewRendererPointUncertainty,
    binding: ComposerTextGeometryBinding,
    signal: AbortSignal,
  ): Promise<ComposerTextCaretGeometry> {
    if (!validPoint(point, binding.candidate.ready.pageCount) || !validUncertainty(uncertainty)) {
      throw new GeometryUnavailable("invalidValue");
    }
    const hit = await this.#dependencies.renderer.hitTestText(binding.candidate, point, uncertainty, signal);
    this.#assertCurrent(binding, signal);
    if (!hit) throw new GeometryUnavailable("unmapped");
    const location = this.#convertLocation(hit, binding.rendererEncoding, binding.identity.backendEncoding, binding);
    const authored = await this.#authoredLocation(location, binding, signal);
    const read = await this.#read(authored, authored, binding, signal);
    if (!sameEndpoint(read.selection.anchor, read.selection.focus)) throw new GeometryUnavailable("ambiguous");
    const projection = await this.#project(read.selection, binding, signal);
    if (!sameLocation(location, projection.anchor) || !sameLocation(location, projection.focus)) {
      throw new GeometryUnavailable("ambiguous");
    }
    const endpoint = { ...read.selection.focus, affinity: hit.affinity };
    const presentation = await this.#presentCaret(endpoint, projection.focus, binding, signal, point);
    return { status: "mapped", identity: binding.identity, authored, ...presentation };
  }

  async #selection(
    selection: ComposerTextGeometrySelection,
    binding: ComposerTextGeometryBinding,
    signal: AbortSignal,
    preferredX: number | null,
  ): Promise<ComposerTextSelectionGeometry> {
    const authorized = await this.#authorize(selection, binding, signal);
    const anchor = await this.#presentCaret(selection.anchor, authorized.projection.anchor, binding, signal);
    const focus = sameEndpoint(selection.anchor, selection.focus) && selection.anchor.affinity === selection.focus.affinity
      && selection.anchor.occurrence === selection.focus.occurrence ? anchor
      : await this.#presentCaret(selection.focus, authorized.projection.focus, binding, signal);
    const boxes = sameEndpoint(selection.anchor, selection.focus) ? []
      : await this.#rangeBoxes(authorized.projection, binding, signal);
    return {
      status: "mapped", identity: binding.identity,
      selection: { anchor: anchor.endpoint, focus: focus.endpoint }, text: authorized.text,
      anchorCarets: anchor.carets, carets: focus.carets,
      anchorCaret: anchor.caret, focusCaret: focus.caret, boxes, preferredX,
    };
  }

  async #presentCaret(
    endpoint: ComposerTextGeometryEndpoint,
    projected: PreviewBackendLocation,
    binding: ComposerTextGeometryBinding,
    signal: AbortSignal,
    point?: PreviewRendererPoint,
  ): Promise<CaretPresentation> {
    const node = requireNode(endpoint, binding.snapshot);
    const affinity = endpoint.affinity ?? (endpoint.offsetUtf16 === node.textEditing!.text.length && endpoint.offsetUtf16 > 0 ? "after" : "before");
    if (affinity !== "before" && affinity !== "after") throw new GeometryUnavailable("invalidValue");
    const location = this.#convertLocation(projected, binding.identity.backendEncoding, binding.rendererEncoding, binding);
    const carets = uniqueBoxes(await this.#dependencies.renderer.locateCaret(
      binding.candidate, location.uri, location.range.start, affinity, signal,
    ));
    this.#assertCurrent(binding, signal);
    if (carets.length === 0) throw new GeometryUnavailable("unavailable");
    if (!carets.every((caret) => validBox(caret, binding.candidate.ready.pageCount) && caret.affinity === affinity)) {
      throw new GeometryUnavailable("invalidValue");
    }
    const index = chooseOccurrence(carets, endpoint.occurrence, point);
    const caret = index === undefined ? null : carets[index];
    return {
      endpoint: {
        node: endpoint.node, offsetUtf16: endpoint.offsetUtf16, affinity,
        ...(caret && index !== undefined ? { occurrence: occurrence(caret, index, carets.length, binding.identity) } : {}),
      },
      carets, caret,
    };
  }

  async #rangeBoxes(
    projection: Projection,
    binding: ComposerTextGeometryBinding,
    signal: AbortSignal,
  ): Promise<readonly PreviewRendererBox[]> {
    const boxes: PreviewRendererBox[] = [];
    for (const segment of projection.segments) {
      const location = this.#convertLocation(segment, binding.identity.backendEncoding, binding.rendererEncoding, binding);
      const located = collapsed(location.range)
        ? await this.#dependencies.renderer.locateCaret(binding.candidate, location.uri, location.range.start, "before", signal)
        : await this.#dependencies.renderer.locateRange(binding.candidate, location.uri, location.range, signal);
      this.#assertCurrent(binding, signal);
      if (located.length === 0) throw new GeometryUnavailable("unavailable");
      for (const box of located) boxes.push(box);
    }
    if (!boxes.every((box) => validBox(box, binding.candidate.ready.pageCount))) throw new GeometryUnavailable("invalidValue");
    const result = uniqueBoxes(boxes);
    for (let index = 0; index < result.length; index += 1) {
      const box = result[index];
      if ("affinity" in box) {
        const { pageIndex, x, y, width, height } = box;
        result[index] = { pageIndex, x, y, width, height };
      }
    }
    return result;
  }

  #logicalMove(
    endpoint: ComposerTextGeometryEndpoint,
    backward: boolean,
    granularity: "grapheme" | "word",
    binding: ComposerTextGeometryBinding,
  ): ComposerTextGeometryEndpoint {
    const node = requireNode(endpoint, binding.snapshot);
    const text = node.textEditing!.text;
    if (backward ? endpoint.offsetUtf16 === 0 : endpoint.offsetUtf16 === text.length) {
      const delta = backward ? -1 : 1;
      for (let index = endpointIndex(endpoint, binding.snapshot) + delta; index >= 0 && index < binding.snapshot.nodes.length; index += delta) {
        const next = binding.snapshot.nodes[index];
        if (next.kind === "opaque" && next.category === "blank") continue;
        if (!isEditable(next) || next.body.resolvedMode !== node.body.resolvedMode) throw new GeometryUnavailable("unsupportedStructure");
        return endpointFor(next, backward ? next.textEditing!.text.length : 0, endpoint);
      }
      return endpoint;
    }
    let offset = backward ? 0 : text.length;
    const segmenter = granularity === "word" ? WORDS : GRAPHEMES;
    for (const segment of segmenter.segment(text)) {
      if (granularity === "word" && /^\s+$/u.test(segment.segment)) continue;
      const boundary = backward ? segment.index : segment.index + segment.segment.length;
      if (backward) {
        if (boundary >= endpoint.offsetUtf16) break;
        offset = boundary;
      } else if (boundary > endpoint.offsetUtf16) {
        offset = boundary;
        break;
      }
    }
    // Word segmentation can differ from grapheme segmentation. Never propose an interior edge.
    if (granularity === "word") {
      let before = 0;
      for (const segment of GRAPHEMES.segment(text)) {
        if (segment.index >= offset) {
          offset = backward && segment.index !== offset ? before : segment.index;
          break;
        }
        before = segment.index;
      }
    }
    return endpointFor(node, offset, endpoint);
  }

  async #visualMove(
    current: CaretPresentation,
    direction: ComposerTextGeometryDirection,
    preferredX: number,
    binding: ComposerTextGeometryBinding,
    signal: AbortSignal,
  ): Promise<ComposerTextGeometryEndpoint> {
    const caret = current.caret!;
    const nodes = editableNeighbors(current.endpoint, binding.snapshot);
    const run = { anchor: endpointFor(nodes[0], 0), focus: endpointFor(nodes.at(-1)!, nodes.at(-1)!.textEditing!.text.length) };
    const projection = await this.#project(run, binding, signal);
    const entries: VisualEntry[] = (await this.#rangeBoxes(projection, binding, signal)).map((box) => ({ box }));
    const unavailable: ComposerTextEndpoint[] = [];
    // Logical newline edges supply real empty-line geometry; range ink alone misses them.
    for (const node of nodes) {
      const offsets = new Set([0, node.textEditing!.text.length]);
      const text = node.textEditing!.text;
      for (let index = text.indexOf("\n"); index >= 0; index = text.indexOf("\n", index + 1)) {
        offsets.add(index);
        offsets.add(index + 1);
      }
      for (const offset of offsets) {
        const endpoint = endpointFor(node, offset);
        const projected = await this.#project({ anchor: endpoint, focus: endpoint }, binding, signal);
        for (const affinity of ["before", "after"] as const) {
          try {
            const presented = await this.#presentCaret({ ...endpoint, affinity }, projected.focus, binding, signal);
            presented.carets.forEach((box, index) => entries.push({
              box,
              endpoint: { ...endpoint, affinity, occurrence: occurrence(box, index, presented.carets.length, binding.identity) },
            }));
          } catch (error) {
            if (!(error instanceof GeometryUnavailable) || error.reason !== "unavailable") throw error;
            unavailable.push(endpoint);
          }
        }
      }
    }
    entries.push({ box: caret, endpoint: current.endpoint });
    const lines = visualLines(entries);
    const lineIndex = currentLineIndex(lines, caret);
    if (lineIndex < 0) throw new GeometryUnavailable("ambiguous");
    const vertical = direction === "up" || direction === "down";
    const targetIndex = vertical ? lineIndex + (direction === "up" ? -1 : 1) : lineIndex;
    const line = lines[targetIndex];
    if (!line) return current.endpoint;
    const edge = direction === "left" ? "start" : direction === "right" ? "end" : undefined;
    const target = chooseVisualEntry(line.entries, preferredX, edge);
    let endpoint: ComposerTextGeometryEndpoint;
    if (target.endpoint) {
      endpoint = target.endpoint;
    } else {
      const box = target.box;
      const point = {
        pageIndex: box.pageIndex,
        x: edge === "start" ? box.x : edge === "end" ? box.x + box.width : Math.max(box.x, Math.min(box.x + box.width, preferredX)),
        y: box.y + box.height / 2,
      };
      const hit = await this.#hitTest(point, ZERO_POINT_UNCERTAINTY, binding, signal);
      if (!hit.caret || !sameVisualLine(hit.caret, line)) throw new GeometryUnavailable("unmapped");
      endpoint = hit.endpoint;
    }
    const index = endpointIndex(endpoint, binding.snapshot);
    if (!nodes.some((node) => node.nodeKey === binding.snapshot.nodes[index].nodeKey)) throw new GeometryUnavailable("unmapped");
    // An unrenderable logical line is not permission to jump over it to the next visible one.
    for (const missing of unavailable) {
      const from = compareEndpoints(missing, current.endpoint, binding.snapshot);
      const to = compareEndpoints(missing, endpoint, binding.snapshot);
      if (from !== 0 && to !== 0 && Math.sign(from) !== Math.sign(to)
        && !entries.some((entry) => entry.endpoint && sameEndpoint(entry.endpoint, missing))) {
        throw new GeometryUnavailable("unavailable");
      }
    }
    return endpoint;
  }

  #convertLocation(
    location: PreviewBackendLocation,
    from: ComposerTextGeometryIdentity["backendEncoding"],
    to: ComposerTextGeometryIdentity["backendEncoding"],
    binding: ComposerTextGeometryBinding,
  ): PreviewBackendLocation {
    if (location.uri !== binding.identity.entryUri) throw new GeometryUnavailable("unmapped");
    const synchronizedUri = binding.candidate.sourceUris.get(location.uri);
    const files = binding.candidate.synchronized.project.files;
    const file = files.find((candidate) => candidate.uri === synchronizedUri || candidate.uri === location.uri);
    if (!file || file.text === undefined) throw new GeometryUnavailable("unmapped");
    return {
      uri: location.uri,
      range: {
        start: convertPosition(file.text, location.range.start, from, to),
        end: convertPosition(file.text, location.range.end, from, to),
      },
    };
  }
}

function isEditable(node: ComposerDocumentNode): node is TextNode {
  return node.kind !== "opaque" && node.textEditing !== null;
}

function nodeRef(node: TextNode): ComposerNodeRef {
  return { nodeKey: node.nodeKey, nodeKind: node.kind, range: node.range };
}

function endpointFor(node: TextNode, offsetUtf16: number, presentation?: ComposerTextGeometryEndpoint): ComposerTextGeometryEndpoint {
  return {
    node: nodeRef(node), offsetUtf16,
    affinity: offsetUtf16 === node.textEditing!.text.length && offsetUtf16 > 0 ? "after" : "before",
    ...(presentation?.occurrence ? { occurrence: presentation.occurrence } : {}),
  };
}

function endpointIndex(endpoint: ComposerTextEndpoint, snapshot: ComposerDocumentSnapshot): number {
  const index = snapshot.nodes.findIndex((node) => node.nodeKey === endpoint.node.nodeKey);
  if (index < 0) throw new GeometryUnavailable("targetChanged");
  return index;
}

function requireNode(endpoint: ComposerTextEndpoint, snapshot: ComposerDocumentSnapshot): TextNode {
  const node = snapshot.nodes[endpointIndex(endpoint, snapshot)];
  if (node.kind !== endpoint.node.nodeKind || !sameRange(node.range, endpoint.node.range)) {
    throw new GeometryUnavailable("targetChanged");
  }
  if (!isEditable(node)) throw new GeometryUnavailable("unsupportedStructure");
  return node;
}

function editableNeighbors(endpoint: ComposerTextEndpoint, snapshot: ComposerDocumentSnapshot): TextNode[] {
  const node = requireNode(endpoint, snapshot);
  const index = endpointIndex(endpoint, snapshot);
  const nodes = [node];
  // A single visual-line step only needs this body and its immediate neighbors.
  for (const delta of [-1, 1]) {
    for (let cursor = index + delta; cursor >= 0 && cursor < snapshot.nodes.length; cursor += delta) {
      const next = snapshot.nodes[cursor];
      if (next.kind === "opaque" && next.category === "blank") continue;
      if (!isEditable(next) || next.body.resolvedMode !== node.body.resolvedMode) break;
      if (delta < 0) nodes.unshift(next);
      else nodes.push(next);
      break;
    }
  }
  return nodes;
}

function wireSelection(selection: ComposerTextSelection): ComposerTextSelection {
  const endpoint = (value: ComposerTextEndpoint): ComposerTextEndpoint => ({
    node: { nodeKey: value.node.nodeKey, nodeKind: value.node.nodeKind, range: value.node.range }, offsetUtf16: value.offsetUtf16,
  });
  return { anchor: endpoint(selection.anchor), focus: endpoint(selection.focus) };
}

function sameIdentity(left: ComposerTextGeometryIdentity, right: ComposerTextGeometryIdentity): boolean {
  return left.sourceUri === right.sourceUri && left.version === right.version && left.sourceDigest === right.sourceDigest
    && left.renderKey === right.renderKey && left.sessionId === right.sessionId && left.generation === right.generation
    && left.revision === right.revision && left.sourceContent === right.sourceContent && left.projectDigest === right.projectDigest
    && left.projectionKey === right.projectionKey && left.entryUri === right.entryUri && left.backendEncoding === right.backendEncoding;
}

function sameRange(left: Range, right: Range): boolean {
  return left.start.line === right.start.line && left.start.character === right.start.character
    && left.end.line === right.end.line && left.end.character === right.end.character;
}

function collapsed(range: Range): boolean {
  return range.start.line === range.end.line && range.start.character === range.end.character;
}

function sameLocation(left: PreviewBackendLocation, right: PreviewBackendLocation): boolean {
  return left.uri === right.uri && sameRange(left.range, right.range);
}

function sameEndpoint(left: ComposerTextEndpoint, right: ComposerTextEndpoint): boolean {
  return left.node.nodeKey === right.node.nodeKey && left.node.nodeKind === right.node.nodeKind
    && sameRange(left.node.range, right.node.range) && left.offsetUtf16 === right.offsetUtf16;
}

function compareEndpoints(left: ComposerTextEndpoint, right: ComposerTextEndpoint, snapshot: ComposerDocumentSnapshot): number {
  return endpointIndex(left, snapshot) - endpointIndex(right, snapshot) || left.offsetUtf16 - right.offsetUtf16;
}

function validPoint(point: PreviewRendererPoint, pageCount: number): boolean {
  return Number.isSafeInteger(point.pageIndex) && point.pageIndex >= 0 && point.pageIndex < pageCount
    && Number.isFinite(point.x) && point.x >= 0 && point.x <= 1 && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1;
}

function validUncertainty(value: unknown): value is PreviewRendererPointUncertainty {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return keys.length === 2 && Object.hasOwn(record, "x") && Object.hasOwn(record, "y")
    && typeof record.x === "number" && Number.isFinite(record.x) && record.x >= 0 && record.x <= 1
    && typeof record.y === "number" && Number.isFinite(record.y) && record.y >= 0 && record.y <= 1;
}

function validBox(box: PreviewRendererBox, pageCount: number): boolean {
  return validPoint(box, pageCount) && Number.isFinite(box.width) && box.width >= 0
    && Number.isFinite(box.height) && box.height > 0 && box.x + box.width <= 1 + EPSILON && box.y + box.height <= 1 + EPSILON;
}


function uniqueBoxes<T extends PreviewRendererBox>(boxes: readonly T[]): T[] {
  const sorted = [...boxes].sort((left, right) => left.pageIndex - right.pageIndex || left.y - right.y || left.x - right.x
    || left.height - right.height || left.width - right.width);
  return sorted.filter((box, index) => index === 0 || box.pageIndex !== sorted[index - 1].pageIndex
    || box.x !== sorted[index - 1].x || box.y !== sorted[index - 1].y || box.width !== sorted[index - 1].width || box.height !== sorted[index - 1].height);
}

function chooseOccurrence(
  carets: readonly PreviewRendererCaret[],
  hint: ComposerTextOccurrence | undefined,
  point: PreviewRendererPoint | undefined,
): number | undefined {
  if (point) {
    let best: number | undefined;
    let distance = Infinity;
    let ambiguous = false;
    carets.forEach((caret, index) => {
      if (caret.pageIndex !== point.pageIndex) return;
      const dx = Math.max(caret.x - point.x, 0, point.x - caret.x - caret.width);
      const dy = Math.max(caret.y - point.y, 0, point.y - caret.y - caret.height);
      const next = dx * dx + dy * dy;
      if (next < distance - EPSILON) { best = index; distance = next; ambiguous = false; }
      else if (Math.abs(next - distance) <= EPSILON) ambiguous = true;
    });
    if (best === undefined) throw new GeometryUnavailable("unmapped");
    if (ambiguous) throw new GeometryUnavailable("ambiguous");
    return best;
  }
  if (carets.length === 1) return 0;
  if (!hint) return undefined;
  if (!Number.isSafeInteger(hint.index) || hint.count !== carets.length || hint.index < 0 || hint.index >= carets.length) {
    throw new GeometryUnavailable("ambiguous");
  }
  return hint.index;
}

function occurrence(caret: PreviewRendererCaret, index: number, count: number, identity: ComposerTextGeometryIdentity): ComposerTextOccurrence {
  return { pageIndex: caret.pageIndex, x: caret.x, y: caret.y, renderKey: identity.renderKey,
    sessionId: identity.sessionId, generation: identity.generation, index, count };
}

function visualLines(entries: readonly VisualEntry[]): VisualLine[] {
  const lines: VisualLine[] = [];
  let active: VisualLine[] = [];
  for (const entry of [...entries].sort((left, right) => left.box.pageIndex - right.box.pageIndex || left.box.y - right.box.y || left.box.x - right.box.x)) {
    const box = entry.box;
    active = active.filter((line) => line.pageIndex === box.pageIndex && line.bottom > box.y + EPSILON);
    const matching = active.filter((line) => Math.min(line.bottom, box.y + box.height) - Math.max(line.top, box.y) > EPSILON);
    if (matching.length > 1) throw new GeometryUnavailable("ambiguous");
    const line = matching[0];
    if (line) {
      line.top = Math.max(line.top, box.y);
      line.bottom = Math.min(line.bottom, box.y + box.height);
      line.entries.push(entry);
    } else {
      const created = { pageIndex: box.pageIndex, top: box.y, bottom: box.y + box.height, entries: [entry] };
      lines.push(created);
      active.push(created);
    }
  }
  return lines.sort((left, right) => left.pageIndex - right.pageIndex || left.top - right.top);
}

function sameVisualLine(box: PreviewRendererBox, line: VisualLine): boolean {
  return line.pageIndex === box.pageIndex && Math.min(line.bottom, box.y + box.height) - Math.max(line.top, box.y) > EPSILON;
}

function currentLineIndex(lines: readonly VisualLine[], caret: PreviewRendererCaret): number {
  const matches = lines.flatMap((line, index) => sameVisualLine(caret, line) ? [index] : []);
  return matches.length === 1 ? matches[0] : -1;
}

function chooseVisualEntry(entries: readonly VisualEntry[], preferredX: number, edge?: "start" | "end"): VisualEntry {
  let selected: VisualEntry | undefined;
  let best = Infinity;
  for (const entry of entries) {
    const box = entry.box;
    const distance = edge === "start" ? box.x : edge === "end" ? -(box.x + box.width)
      : Math.max(box.x - preferredX, 0, preferredX - box.x - box.width);
    if (distance < best - EPSILON || (Math.abs(distance - best) <= EPSILON && entry.endpoint && !selected?.endpoint)) {
      selected = entry;
      best = distance;
    } else if (Math.abs(distance - best) <= EPSILON && selected?.endpoint && entry.endpoint
      && !sameEndpoint(selected.endpoint, entry.endpoint)) {
      throw new GeometryUnavailable("ambiguous");
    }
  }
  if (!selected) throw new GeometryUnavailable("unavailable");
  return selected;
}

/** Convert line characters at scalar boundaries, without slicing/decoding an escape or a surrogate. */
function convertPosition(
  text: string,
  position: PreviewRendererPosition,
  from: ComposerTextGeometryIdentity["backendEncoding"],
  to: ComposerTextGeometryIdentity["backendEncoding"],
): PreviewRendererPosition {
  if (!Number.isSafeInteger(position.line) || position.line < 0 || !Number.isSafeInteger(position.character) || position.character < 0) {
    throw new GeometryUnavailable("invalidValue");
  }
  let start = 0;
  for (let line = 0; line < position.line; line += 1) {
    const next = text.indexOf("\n", start);
    if (next < 0) throw new GeometryUnavailable("invalidValue");
    start = next + 1;
  }
  let sourceUnits = 0;
  let targetUnits = 0;
  for (let index = start; index < text.length && text[index] !== "\n" && text[index] !== "\r";) {
    if (sourceUnits === position.character) return { line: position.line, character: targetUnits };
    const scalar = text.codePointAt(index)!;
    if (scalar >= 0xd800 && scalar <= 0xdfff) throw new GeometryUnavailable("invalidValue");
    const utf16 = scalar > 0xffff ? 2 : 1;
    const utf8 = scalar <= 0x7f ? 1 : scalar <= 0x7ff ? 2 : scalar <= 0xffff ? 3 : 4;
    sourceUnits += from === "utf-16" ? utf16 : from === "utf-8" ? utf8 : 1;
    targetUnits += to === "utf-16" ? utf16 : to === "utf-8" ? utf8 : 1;
    if (sourceUnits > position.character) throw new GeometryUnavailable("invalidValue");
    index += utf16;
  }
  if (sourceUnits !== position.character) throw new GeometryUnavailable("invalidValue");
  return { line: position.line, character: targetUnits };
}
