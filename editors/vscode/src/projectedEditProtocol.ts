import type { ProjectionKey, SourceContentKey } from "./runtimeIdentity";
import type { PositionEncoding, WirePosition } from "./typstPosition";

export const PROJECTED_EDIT_PROTOCOL_VERSION = 1 as const;

export interface ProjectedEditRange {
  readonly start: WirePosition;
  readonly end: WirePosition;
}

export interface ProjectedEditDocumentIdentity {
  readonly virtualUri: string;
  readonly sourceContent: SourceContentKey;
  readonly projectionKey: ProjectionKey;
  readonly encoding: PositionEncoding;
}

export interface ProjectedTextEdit {
  readonly virtualUri: string;
  readonly range: ProjectedEditRange;
  readonly newText: string;
}

export interface ProjectedTargetVersion {
  readonly uri: string;
  readonly version: number;
}

/** Wire request validated atomically by the Rust projected-edit validator. */
export interface ProjectedEditTransaction {
  readonly protocolVersion: typeof PROJECTED_EDIT_PROTOCOL_VERSION;
  readonly documents: readonly ProjectedEditDocumentIdentity[];
  readonly edits: readonly ProjectedTextEdit[];
  readonly expectedVersions: readonly ProjectedTargetVersion[];
}

export type ProjectedEditFailure =
  | { readonly kind: "UnsafeEdit"; readonly reason: string }
  | { readonly kind: "StaleProjection"; readonly reason: string }
  | { readonly kind: "ReadOnlyTarget"; readonly uri: string }
  | { readonly kind: "CapabilityUnavailable" };

export interface ValidatedProjectedEdit {
  readonly startByte: number;
  readonly endByte: number;
  readonly newText: string;
}

export interface ValidatedProjectedDocumentEdits {
  readonly normalizedUri: string;
  readonly expectedVersion: number;
  readonly edits: readonly ValidatedProjectedEdit[];
}

export type ProjectedEditValidationResult =
  | { readonly kind: "Validated"; readonly documents: readonly ValidatedProjectedDocumentEdits[] }
  | ProjectedEditFailure;
