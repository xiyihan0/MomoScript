import type { TypstResourceRequest } from "../../vscode/src/tinymistClient";

export type ImageSequenceResource = Extract<TypstResourceRequest, { kind: "image-sequence" }>;

interface AvifWorkerResponse {
  id: number;
  png?: ArrayBuffer;
  error?: string;
}

export async function decodeAvifSequence(
  bytes: Uint8Array,
  resource: ImageSequenceResource,
  signal: AbortSignal
): Promise<Uint8Array> {
  if (resource.container !== "avifs" || resource.codec !== "av1") {
    throw new Error(`Unsupported image sequence ${resource.container}/${resource.codec}`);
  }
  if (resource.frame < 0 || resource.frame >= resource.frameCount) {
    throw new Error(`AVIFS frame ${resource.frame} is outside frameCount ${resource.frameCount}`);
  }
  const worker = new Worker(new URL("./avifSequenceWorker.ts", import.meta.url), { type: "module" });
  return new Promise<Uint8Array>((resolve, reject) => {
    const abort = () => {
      worker.terminate();
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = (event) => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
      reject(new Error(event.message || "AVIFS decoder Worker failed"));
    };
    worker.onmessage = (event: MessageEvent<AvifWorkerResponse>) => {
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else if (event.data.png instanceof ArrayBuffer) resolve(new Uint8Array(event.data.png));
      else reject(new Error("AVIFS decoder Worker returned no PNG"));
    };
    // postMessage 以 transfer 方式移交 buffer；复制一份，避免 neuter 调用方仍持有的字节
    // （图鉴的序列缓存会被多个帧解码共享）。
    const payload = bytes.slice().buffer;
    worker.postMessage({
      id: resource.id,
      bytes: payload,
      frame: resource.frame,
      sha256: resource.sha256,
      size: resource.size,
      profile: resource.profile
    }, [payload]);
  });
}
