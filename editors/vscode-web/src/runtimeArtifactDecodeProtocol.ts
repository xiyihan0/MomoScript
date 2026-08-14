export interface RuntimeArtifactDecodeStartRequest {
  readonly type: "start";
  readonly id: number;
  readonly expectedEncodedSha256: string;
  readonly expectedRawSha256: string;
  readonly maxEncodedBytes: number;
  readonly maxDecodedBytes: number;
}

export interface RuntimeArtifactDecodeChunkRequest {
  readonly type: "chunk";
  readonly id: number;
  readonly bytes: ArrayBuffer;
}

export interface RuntimeArtifactDecodeFinishRequest {
  readonly type: "finish";
  readonly id: number;
}

export interface RuntimeArtifactDecodeCancelRequest {
  readonly type: "cancel";
  readonly id: number;
}

export type RuntimeArtifactDecodeRequest =
  | RuntimeArtifactDecodeStartRequest
  | RuntimeArtifactDecodeChunkRequest
  | RuntimeArtifactDecodeFinishRequest
  | RuntimeArtifactDecodeCancelRequest;

export interface RuntimeArtifactDecodeSuccessResponse {
  readonly type: "success";
  readonly id: number;
  readonly bytes: ArrayBuffer;
}

export interface RuntimeArtifactDecodeErrorResponse {
  readonly type: "error";
  readonly id: number;
  readonly error: string;
}

export type RuntimeArtifactDecodeResponse =
  | RuntimeArtifactDecodeSuccessResponse
  | RuntimeArtifactDecodeErrorResponse;

export function isRuntimeArtifactDecodeResponse(value: unknown): value is RuntimeArtifactDecodeResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<RuntimeArtifactDecodeResponse>;
  if (!Number.isSafeInteger(candidate.id) || (candidate.id ?? 0) <= 0) return false;
  if (candidate.type === "success") return candidate.bytes instanceof ArrayBuffer;
  if (candidate.type === "error") return typeof candidate.error === "string" && candidate.error.length > 0;
  return false;
}
