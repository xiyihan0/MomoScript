import type { BundledRuntimeArtifact } from "./runtimeArtifacts";
import {
  isRuntimeArtifactDecodeResponse,
  type RuntimeArtifactDecodeRequest,
} from "./runtimeArtifactDecodeProtocol";
export type RuntimeArtifactProgress =
  | {
      readonly phase: "download";
      readonly state: "started" | "progress" | "complete";
      readonly receivedBytes: number;
      readonly totalBytes: number;
    }
  | {
      readonly phase: "decode";
      readonly state: "started";
      readonly encodedBytes: number;
    }
  | {
      readonly phase: "decode";
      readonly state: "complete";
      readonly encodedBytes: number;
      readonly decodedBytes: number;
    };


export interface FetchDecodedRuntimeArtifactOptions {
  readonly artifact: BundledRuntimeArtifact;
  readonly label: string;
  readonly timeoutMs: number;
  readonly report?: (message: string) => void;
  readonly onProgress?: (progress: RuntimeArtifactProgress) => void;
}

let nextDecodeId = 1;

export async function fetchDecodedRuntimeArtifact(
  options: FetchDecodedRuntimeArtifactOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  const { artifact, label, timeoutMs, report = () => {}, onProgress = () => {} } = options;
  const url = new URL(artifact.url, window.location.href);
  if (url.origin !== window.location.origin) throw new Error(`${label}不是同源运行时制品`);
  if (artifact.encoding !== "brotli") throw new Error(`${label}使用了不支持的压缩格式`);

  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(new DOMException(`${label}下载超时`, "TimeoutError")), timeoutMs);
  try {
    onProgress({
      phase: "download",
      state: "started",
      receivedBytes: 0,
      totalBytes: artifact.encodedBytes,
    });
    report(`${label} 开始下载…`);
    const response = await fetch(url, {
      cache: "force-cache",
      credentials: "same-origin",
      redirect: "error",
      signal: controller.signal,
    });
    validateResponse(response, artifact, label);
    return await decodeResponse(response, artifact, label, report, onProgress, controller.signal);
  } finally {
    window.clearTimeout(timer);
  }
}

function validateResponse(response: Response, artifact: BundledRuntimeArtifact, label: string): void {
  if (!response.ok) throw new Error(`${label}下载失败：HTTP ${response.status}`);
  if (response.redirected) throw new Error(`${label}下载发生了意外重定向`);
  if (response.headers.get("content-encoding")) {
    throw new Error(`${label}的 Brotli 制品响应被 HTTP 层解压，无法执行固定压缩字节校验`);
  }
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength !== artifact.encodedBytes) {
      throw new Error(`${label}压缩长度 ${contentLengthHeader} 与固定值 ${artifact.encodedBytes} 不一致`);
    }
  }
  if (response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
    throw new Error(`${label}下载返回了 HTML，而不是运行时制品`);
  }
}

async function decodeResponse(
  response: Response,
  artifact: BundledRuntimeArtifact,
  label: string,
  report: (message: string) => void,
  onProgress: (progress: RuntimeArtifactProgress) => void,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  const worker = new Worker(new URL("./runtimeArtifactDecodeWorker.ts", import.meta.url), {
    type: "module",
    name: `MMT ${artifact.id} Brotli decoder`,
  });
  const id = nextDecodeId++;
  let rejectResult: (reason?: unknown) => void = () => {};
  const result = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    rejectResult = reject;
    worker.onerror = (event) => reject(new Error(event.message || `${label}解压 Worker 失败`));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (!isRuntimeArtifactDecodeResponse(event.data) || event.data.id !== id) {
        reject(new Error(`${label}解压 Worker 返回了无效消息`));
        return;
      }
      if (event.data.type === "error") reject(new Error(`${label}解压失败：${event.data.error}`));
      else resolve(new Uint8Array(event.data.bytes));
    };
  });
  // Fetch can fail before the Worker result is awaited; keep that rejection observed.
  void result.catch(() => {});
  const abort = () => {
    rejectResult(signal.reason ?? new DOMException("Aborted", "AbortError"));
    post(worker, { type: "cancel", id });
    worker.terminate();
  };
  signal.addEventListener("abort", abort, { once: true });
  post(worker, {
    type: "start",
    id,
    expectedEncodedSha256: artifact.expectedEncodedSha256,
    expectedRawSha256: artifact.expectedRawSha256,
    maxEncodedBytes: artifact.encodedBytes,
    maxDecodedBytes: artifact.rawBytes,
  });

  try {
    let received = 0;
    let lastReportedPercent = -5;
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        received += value.byteLength;
        if (received > artifact.encodedBytes) throw new Error(`${label}压缩数据超过固定长度`);
        onProgress({
          phase: "download",
          state: "progress",
          receivedBytes: received,
          totalBytes: artifact.encodedBytes,
        });
        const percent = Math.min(99, Math.floor(received / artifact.encodedBytes * 100));
        if (percent >= lastReportedPercent + 5) {
          lastReportedPercent = percent;
          report(`${label} ${percent}% (${(received / 1048576).toFixed(1)} / ${(artifact.encodedBytes / 1048576).toFixed(1)} MiB)`);
        }
        const bytes = transferableBuffer(value);
        post(worker, { type: "chunk", id, bytes }, [bytes]);
      }
    } else {
      const bytes = await response.arrayBuffer();
      received = bytes.byteLength;
      if (received > artifact.encodedBytes) throw new Error(`${label}压缩数据超过固定长度`);
      onProgress({
        phase: "download",
        state: "progress",
        receivedBytes: received,
        totalBytes: artifact.encodedBytes,
      });
      post(worker, { type: "chunk", id, bytes }, [bytes]);
    }
    if (received !== artifact.encodedBytes) {
      throw new Error(`${label}压缩长度 ${received} 与固定值 ${artifact.encodedBytes} 不一致`);
    }
    onProgress({
      phase: "download",
      state: "complete",
      receivedBytes: received,
      totalBytes: artifact.encodedBytes,
    });
    onProgress({
      phase: "decode",
      state: "started",
      encodedBytes: received,
    });
    post(worker, { type: "finish", id });
    const decoded = await result;
    report(`${label} 已验证并解压 ${(decoded.byteLength / 1048576).toFixed(1)} MiB`);
    onProgress({
      phase: "decode",
      state: "complete",
      encodedBytes: received,
      decodedBytes: decoded.byteLength,
    });
    return decoded;
  } catch (error) {
    post(worker, { type: "cancel", id });
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    worker.terminate();
  }
}

function transferableBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

function post(worker: Worker, request: RuntimeArtifactDecodeRequest, transfer: Transferable[] = []): void {
  worker.postMessage(request, transfer);
}
