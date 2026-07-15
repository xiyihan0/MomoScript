import type { BaseLanguageClient } from "vscode-languageclient";
import type { LanguageClientOptions } from "vscode-languageclient";
import * as vscode from "vscode";
import { TinymistWorkerClient } from "../../vscode/src/tinymistClient";
import { connectTypstBackend, installTypstMiddleware } from "../../vscode/src/typstFeatures";
import tinymistModuleUrl from "../../vscode/vendor/tinymist-0.15.2/tinymist.js?url";
import tinymistWorkerUrl from "../../vscode/src/tinymistWorker.ts?worker&url";
const tinymistWasmUrl = "https://mms-pack.xiyihan.cn/wasm/tinymist/0.15.2/d9b946a8aa1425eeda71e6fcb603fb85ce30cd79b2a676a5d557971f202af454/tinymist_bg.wasm";

export interface TinymistHandle {
  backend: TinymistWorkerClient;
  activateSemanticTokens(): void;
  refreshSemanticTokens(): void;
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
  const disposables: vscode.Disposable[] = [];
  const semanticTokensChanged = new vscode.EventEmitter<void>();
  disposables.push(semanticTokensChanged);
  const semanticLegend = backend.semanticTokensLegend();
  if (!semanticLegend) throw new Error("Tinymist semantic token legend is unavailable");
  const activateSemanticTokens = () => {
    disposables.push(vscode.languages.registerDocumentSemanticTokensProvider(
      { language: "typst", scheme: "mmtfs" },
      {
        onDidChangeSemanticTokens: semanticTokensChanged.event,
        async provideDocumentSemanticTokens(document, token) {
          const controller = new AbortController();
          const cancellation = token.onCancellationRequested(() => controller.abort());
          try {
            const result = await backend.request<{ data: number[]; resultId?: string } | null>(
              "textDocument/semanticTokens/full",
              { textDocument: { uri: document.uri.toString() } },
              controller.signal
            );
            return result ? new vscode.SemanticTokens(new Uint32Array(result.data), result.resultId) : null;
          } catch (error) {
            if (!controller.signal.aborted) console.warn("Typst semantic tokens unavailable", error);
            return null;
          } finally {
            cancellation.dispose();
          }
        }
      },
      new vscode.SemanticTokensLegend(semanticLegend.tokenTypes, semanticLegend.tokenModifiers)
    ));
  };
  return {
    backend,
    activateSemanticTokens,
    refreshSemanticTokens() {
      semanticTokensChanged.fire();
    },
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
