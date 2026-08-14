import BrotliDecompressStream, { Result } from "tiny-brotli-dec-wasm";
import type {
  RuntimeArtifactDecodeRequest,
  RuntimeArtifactDecodeStartRequest,
} from "./runtimeArtifactDecodeProtocol";

const OUTPUT_CHUNK_BYTES = 256 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

interface BrotliDecoder {
  dec(input: Uint8Array, outputSize: number): Uint8Array;
  result(): number;
  lastInputOffset(): number;
  free(): void;
}

interface DecodeJob {
  readonly request: RuntimeArtifactDecodeStartRequest;
  readonly encodedChunks: Uint8Array[];
  readonly decodedChunks: Uint8Array[];
  encodedBytes: number;
  decodedBytes: number;
  completed: boolean;
  queue: Promise<BrotliDecoder>;
}

const jobs = new Map<number, DecodeJob>();
const decoderModuleReady = BrotliDecompressStream.init();

self.onmessage = (event: MessageEvent<RuntimeArtifactDecodeRequest>) => {
  const request = event.data;
  if (!request || typeof request !== "object" || !Number.isSafeInteger(request.id) || request.id <= 0) return;
  switch (request.type) {
    case "start":
      start(request);
      return;
    case "chunk":
      enqueueChunk(request.id, request.bytes);
      return;
    case "finish":
      finish(request.id);
      return;
    case "cancel":
      cancel(request.id);
  }
};

function start(request: RuntimeArtifactDecodeStartRequest): void {
  if (jobs.has(request.id)) return fail(request.id, "Duplicate runtime artifact decode job");
  if (!SHA256_PATTERN.test(request.expectedEncodedSha256) || !SHA256_PATTERN.test(request.expectedRawSha256)) {
    return fail(request.id, "Runtime artifact digest is invalid");
  }
  if (!validLimit(request.maxEncodedBytes) || !validLimit(request.maxDecodedBytes)) {
    return fail(request.id, "Runtime artifact size limit is invalid");
  }
  jobs.set(request.id, {
    request,
    encodedChunks: [],
    decodedChunks: [],
    encodedBytes: 0,
    decodedBytes: 0,
    completed: false,
    queue: decoderModuleReady.then(() => BrotliDecompressStream.create()),
  });
}

function enqueueChunk(id: number, buffer: ArrayBuffer): void {
  const job = jobs.get(id);
  if (!job || !(buffer instanceof ArrayBuffer)) return fail(id, "Runtime artifact decode chunk is invalid");
  const bytes = new Uint8Array(buffer);
  job.encodedBytes += bytes.byteLength;
  if (job.encodedBytes > job.request.maxEncodedBytes) return fail(id, "Runtime artifact exceeds encoded size limit");
  job.encodedChunks.push(bytes);
  job.queue = job.queue.then((decoder) => {
    decodeChunk(job, decoder, bytes);
    return decoder;
  });
  void job.queue.catch((error: unknown) => fail(id, message(error)));
}

function decodeChunk(job: DecodeJob, decoder: BrotliDecoder, bytes: Uint8Array): void {
  if (job.completed) throw new Error("Runtime artifact contains trailing Brotli bytes");
  let offset = 0;
  while (true) {
    const output = decoder.dec(bytes.subarray(offset), OUTPUT_CHUNK_BYTES);
    const consumed = decoder.lastInputOffset();
    if (!Number.isSafeInteger(consumed) || consumed < 0 || consumed > bytes.byteLength - offset) {
      throw new Error("Brotli decoder returned an invalid input offset");
    }
    appendOutput(job, output);
    offset += consumed;
    const result = decoder.result();
    if (result === Result.Success) {
      if (offset !== bytes.byteLength) throw new Error("Runtime artifact contains trailing Brotli bytes");
      job.completed = true;
      return;
    }
    if (result === Result.Error) throw new Error("Brotli decoder rejected the runtime artifact");
    if (result === Result.NeedsMoreInput) {
      if (offset !== bytes.byteLength) throw new Error("Brotli decoder left unconsumed input");
      return;
    }
    if (result !== Result.NeedsMoreOutput) throw new Error(`Brotli decoder returned unknown result ${result}`);
    if (consumed === 0 && output.byteLength === 0) throw new Error("Brotli decoder made no progress");
  }
}

function appendOutput(job: DecodeJob, output: Uint8Array): void {
  if (output.byteLength === 0) return;
  job.decodedBytes += output.byteLength;
  if (job.decodedBytes > job.request.maxDecodedBytes) throw new Error("Runtime artifact exceeds decoded size limit");
  job.decodedChunks.push(output);
}

function finish(id: number): void {
  const job = jobs.get(id);
  if (!job) return fail(id, "Unknown runtime artifact decode job");
  void job.queue.then(async (decoder) => {
    try {
      if (!job.completed) throw new Error("Runtime artifact Brotli stream is truncated");
      if (job.encodedBytes !== job.request.maxEncodedBytes) {
        throw new Error(`Runtime artifact encoded size ${job.encodedBytes} does not match ${job.request.maxEncodedBytes}`);
      }
      if (job.decodedBytes !== job.request.maxDecodedBytes) {
        throw new Error(`Runtime artifact decoded size ${job.decodedBytes} does not match ${job.request.maxDecodedBytes}`);
      }
      const encoded = concatenate(job.encodedChunks, job.encodedBytes);
      const decoded = concatenate(job.decodedChunks, job.decodedBytes);
      if (await sha256(encoded) !== job.request.expectedEncodedSha256) throw new Error("Runtime artifact encoded SHA-256 mismatch");
      if (await sha256(decoded) !== job.request.expectedRawSha256) throw new Error("Runtime artifact decoded SHA-256 mismatch");
      jobs.delete(id);
      decoder.free();
      self.postMessage({ type: "success", id, bytes: decoded.buffer }, { transfer: [decoded.buffer] });
    } catch (error) {
      jobs.delete(id);
      decoder.free();
      self.postMessage({ type: "error", id, error: message(error) });
    }
  }, (error: unknown) => fail(id, message(error)));
}

function cancel(id: number): void {
  const job = jobs.get(id);
  if (!job) return;
  jobs.delete(id);
  void job.queue.then((decoder) => decoder.free(), () => {});
}

function fail(id: number, error: string): void {
  const job = jobs.get(id);
  if (job) {
    jobs.delete(id);
    void job.queue.then((decoder) => decoder.free(), () => {});
  }
  self.postMessage({ type: "error", id, error });
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
