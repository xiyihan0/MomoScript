import type { LanguageClientOptions } from "vscode-languageclient";
import { LanguageClientWrapper } from "monaco-languageclient/lcwrapper";
import { clientOptions } from "../../vscode/src/clientOptions";
import mmtWasmUrl from "../../vscode/vendor/mmt-lsp/mmt_lsp_bg.wasm?url";
import MmtWorker from "../../vscode/src/browserWorker.ts?worker";

export interface MmtLanguageClientHandle {
  client: LanguageClientWrapper;
  worker: Worker;
  dispose(): Promise<void>;
}

export async function startMmtLanguageClient(
  typstLanguageFeatures: boolean,
  configureOptions?: (options: LanguageClientOptions) => void
): Promise<MmtLanguageClientHandle> {
  const worker = new MmtWorker();
  try {
    const ready = waitForWorker(worker);
    worker.postMessage({
      method: "mmt/boot",
      params: { wasmUri: new URL(mmtWasmUrl, window.location.href).href }
    });
    await ready;
    const options = clientOptions(typstLanguageFeatures);
    configureOptions?.(options);
    const client = new LanguageClientWrapper({
      languageId: "mmt",
      connection: { options: { $type: "WorkerDirect", worker } },
      clientOptions: options,
      disposeWorker: false
    });
    await client.start();
    return {
      client,
      worker,
      async dispose() {
        await client.dispose(false);
        worker.terminate();
      }
    };
  } catch (error) {
    worker.terminate();
    throw error;
  }
}

function waitForWorker(worker: Worker): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timeout = window.setTimeout(() => finish(new Error("Worker startup timed out")), 15_000);
  const onMessage = (event: MessageEvent) => {
    if (event.data?.method === "mmt/workerReady") finish();
    if (event.data?.method === "mmt/workerFailed") {
      finish(new Error(event.data.params?.message ?? "Worker startup failed"));
    }
  };
  const onError = (event: ErrorEvent) => finish(new Error(event.message || "Worker startup failed"));
  const finish = (error?: Error) => {
    window.clearTimeout(timeout);
    worker.removeEventListener("message", onMessage);
    worker.removeEventListener("error", onError);
    if (error) reject(error);
    else resolve();
  };
  worker.addEventListener("message", onMessage);
  worker.addEventListener("error", onError);
  return promise;
}
