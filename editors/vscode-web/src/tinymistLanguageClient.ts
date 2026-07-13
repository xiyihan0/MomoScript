import type { BaseLanguageClient } from "vscode-languageclient";
import type { LanguageClientOptions } from "vscode-languageclient";
import type { Disposable } from "vscode";
import { TinymistWorkerClient } from "../../vscode/src/tinymistClient";
import { connectTypstBackend, installTypstMiddleware } from "../../vscode/src/typstFeatures";
import tinymistModuleUrl from "../../vscode/vendor/tinymist-0.15.2/tinymist.js?url";
import tinymistWasmUrl from "../../vscode/vendor/tinymist-0.15.2/tinymist_bg.wasm?url";
import tinymistWorkerUrl from "../../vscode/src/tinymistWorker.ts?worker&url";

export interface TinymistHandle {
  backend: TinymistWorkerClient;
  installMiddleware(options: LanguageClientOptions, getClient: () => BaseLanguageClient): void;
  connect(client: BaseLanguageClient): void;
  dispose(): Promise<void>;
}

export async function startTinymistLanguageClient(): Promise<TinymistHandle> {
  const backend = await TinymistWorkerClient.start(
    new URL(tinymistWorkerUrl, window.location.href).href,
    new URL(tinymistModuleUrl, window.location.href).href,
    new URL(tinymistWasmUrl, window.location.href).href,
    (uri) => new Worker(uri, { type: "module", name: "Tinymist LS" })
  );
  const disposables: Disposable[] = [];
  return {
    backend,
    installMiddleware(options, getClient) {
      installTypstMiddleware(options, backend, getClient);
    },
    connect(client) {
      disposables.push(...connectTypstBackend(client, backend));
    },
    async dispose() {
      for (const disposable of disposables.splice(0)) disposable.dispose();
      await backend.stop();
    }
  };
}
