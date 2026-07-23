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
import tinymistModuleUrl from "../../vscode/vendor/tinymist-0.15.2/tinymist.js?url";
import tinymistWorkerUrl from "../../vscode/src/tinymistWorker.ts?worker&url";
import { TINYMIST_WASM_URL, runtimeIdentityUrl } from "./runtimeArtifacts";

export interface TinymistHandle {
  backend: TinymistWorkerClient;
  installMiddleware(options: LanguageClientOptions, getClient: () => BaseLanguageClient): void;
  connect(client: BaseLanguageClient): TypstProblemsPublisher;
  dispose(): Promise<void>;
  terminate(): void;
}

export async function startTinymistLanguageClient(
  report: (message: string) => void = () => {},
  packageService?: TypstPackageService
): Promise<TinymistHandle> {
  const wasmBytes = await downloadTinymistWasm(report);
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

async function downloadTinymistWasm(report: (message: string) => void): Promise<Uint8Array> {
  try {
    return await downloadValidatedWasm(TINYMIST_WASM_URL, "Tinymist WASM", report);
  } catch {
    report("Tinymist WASM 压缩传输失败，回退未压缩版本…");
    return downloadValidatedWasm(runtimeIdentityUrl(TINYMIST_WASM_URL), "Tinymist WASM", report);
  }
}

async function downloadValidatedWasm(
  url: string,
  label: string,
  report: (message: string) => void,
): Promise<Uint8Array> {
  const bytes = await downloadWasm(url, label, report);
  if (!WebAssembly.validate(bytes.buffer as ArrayBuffer)) throw new Error(`${label}不是有效的 WebAssembly 模块`);
  return bytes;
}

async function downloadWasm(url: string, label: string, report: (message: string) => void): Promise<Uint8Array> {
  report(`${label} 开始下载…`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}下载失败：HTTP ${response.status}`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    report(`${label} 已下载 ${(bytes.byteLength / 1048576).toFixed(1)} MiB`);
    return bytes;
  }
  const encodedTransfer = new URL(url).searchParams.get("delivery") === "zstd-v1";
  let total = encodedTransfer ? 0 : Number(response.headers.get("content-length")) || 0;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let lastReported = -5;
  let lastReportedBytes = 0;
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    if (total > 0 && received > total) total = 0;
    const percent = total > 0 ? Math.min(99, Math.floor(received / total * 100)) : 0;
    const shouldReport = total > 0
      ? percent >= lastReported + 5
      : received - lastReportedBytes >= 1048576;
    if (shouldReport) {
      lastReported = total > 0 ? percent : lastReported;
      lastReportedBytes = received;
      report(total > 0
        ? `${label} ${percent}% (${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MiB)`
        : `${label} 已下载 ${(received / 1048576).toFixed(1)} MiB`);
    }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  report(`${label} 下载完成 ${(received / 1048576).toFixed(1)} MiB`);
  return bytes;
}
