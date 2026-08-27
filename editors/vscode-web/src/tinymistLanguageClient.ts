import type { BaseLanguageClient } from "vscode-languageclient";
import type { LanguageClientOptions } from "vscode-languageclient";
import type * as vscode from "vscode";
import { TinymistWorkerClient } from "../../vscode/src/tinymistClient";
import type { TypstPackageService } from "../../vscode/src/typstPackageService";
import {
  connectTypstBackend,
  installTypstMiddleware,
  typstProblemsPublisher,
  type TypstProblemsPublisher
} from "../../vscode/src/typstFeatures";
import tinymistModuleUrl from "../../vscode/vendor/tinymist-0.15.4-rc3/tinymist.js?url";
import tinymistWorkerUrl from "../../vscode/src/tinymistWorker.ts?worker&url";
import { TINYMIST_WASM_ARTIFACT, TINYMIST_WASM_SHA256 } from "./runtimeArtifacts";
import {
  fetchDecodedRuntimeArtifact,
  type RuntimeArtifactProgress,
} from "./runtimeArtifactDecoder";

export interface TinymistHandle {
  backend: TinymistWorkerClient;
  installMiddleware(options: LanguageClientOptions, getClient: () => BaseLanguageClient): void;
  connect(client: BaseLanguageClient): TypstProblemsPublisher;
  dispose(): Promise<void>;
  terminate(): void;
}

export async function startTinymistLanguageClient(
  report: (message: string) => void = () => {},
  packageService?: TypstPackageService,
  onArtifactProgress: (progress: RuntimeArtifactProgress) => void = () => {},
): Promise<TinymistHandle> {
  const wasmBytes = await downloadTinymistWasm(report, onArtifactProgress);
  const { backend, wasmUrl, moduleUrl } = await startTinymistBackend(wasmBytes, packageService);
  const disposables: vscode.Disposable[] = [];
  return {
    backend,
    installMiddleware(options, getClient) {
      installTypstMiddleware(options, backend, getClient);
    },
    connect(client) {
      disposables.push(...connectTypstBackend(client, backend, "web"));
      const problems = typstProblemsPublisher(backend);
      if (!problems) {
        for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
        throw new Error("Tinymist Problems publisher was not installed");
      }
      return problems;
    },
    terminate() {
      backend.terminate();
    },
    async dispose() {
      for (const disposable of disposables.splice(0).reverse()) disposable.dispose();
      await backend.stop();
      URL.revokeObjectURL(wasmUrl);
      URL.revokeObjectURL(moduleUrl);
    }
  };
}

async function startTinymistBackend(
  wasmBytes: Uint8Array,
  packageService?: TypstPackageService
): Promise<{ backend: TinymistWorkerClient; wasmUrl: string; moduleUrl: string }> {
  const moduleResponse = await fetch(new URL(tinymistModuleUrl, window.location.href));
  if (!moduleResponse.ok) throw new Error(`Tinymist module download failed: HTTP ${moduleResponse.status}`);
  const moduleUrl = URL.createObjectURL(await moduleResponse.blob());
  const wasmUrl = URL.createObjectURL(new Blob([wasmBytes.buffer as ArrayBuffer], { type: "application/wasm" }));
  try {
    const backend = await TinymistWorkerClient.start(
      new URL(tinymistWorkerUrl, window.location.href).href,
      moduleUrl,
      wasmUrl,
      (uri) => new Worker(uri, { type: "module", name: "Tinymist LS" }),
      undefined,
      packageService
    );
    return { backend, wasmUrl, moduleUrl };
  } catch (error) {
    URL.revokeObjectURL(wasmUrl);
    URL.revokeObjectURL(moduleUrl);
    throw error;
  }
}

async function downloadTinymistWasm(
  report: (message: string) => void,
  onProgress: (progress: RuntimeArtifactProgress) => void,
): Promise<Uint8Array> {
  report(`Tinymist WASM ${TINYMIST_WASM_SHA256.slice(0, 12)} 使用同源固定资源…`);
  const bytes = await fetchDecodedRuntimeArtifact({
    artifact: TINYMIST_WASM_ARTIFACT,
    label: "Tinymist WASM",
    timeoutMs: 30_000,
    report,
    onProgress,
  });
  if (!WebAssembly.validate(bytes)) throw new Error("Tinymist WASM 不是有效的 WebAssembly 模块");
  return bytes;
}
