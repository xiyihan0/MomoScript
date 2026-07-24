import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";
import wasmAsset from "../wasm/mmt_lsp_bg.wasm";
import { loadWasmAssetBytes } from "./wasmAsset";

import { clientOptions } from "./clientOptions";
import { TinymistWorkerClient } from "./tinymistClient";
import { syncConfiguredPackManifests } from "./resourcePacks";
import { registerMmtLanguageEditing } from "./languageEditing";
import { connectTypstBackend, installTypstMiddleware } from "./typstFeatures";

let client: LanguageClient | undefined;
let worker: Worker | undefined;
let tinymist: TinymistWorkerClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(registerMmtLanguageEditing());
  if (MMT_TINYMIST_WEB_AVAILABLE) {
    try {
      tinymist = await TinymistWorkerClient.start(
        vscode.Uri.joinPath(context.extensionUri, "dist", "tinymistWorker.js").toString(true),
        vscode.Uri.joinPath(
          context.extensionUri,
          "dist",
          "tinymist",
          "tinymist.js"
        ).toString(true),
        vscode.Uri.joinPath(
          context.extensionUri,
          "dist",
          "tinymist",
          "tinymist_bg.wasm"
        ).toString(true)
      );
      tinymist.on("tinymist/clientFailed", (params) => {
        const message = (params as { message?: string } | undefined)?.message;
        void vscode.window.showWarningMessage(
          `Embedded Typst language service could not recover: ${message ?? "unknown error"}`
        );
      });
    } catch (error) {
      tinymist = undefined;
      void vscode.window.showWarningMessage(
        `Embedded Typst language service is unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const workerUri = vscode.Uri.joinPath(context.extensionUri, "dist", "browserWorker.js");
  worker = new Worker(workerUri.toString(true));
  worker.addEventListener("error", (event) => {
    void vscode.window.showErrorMessage(
      `MomoScript browser language server failed: ${event.message || "Worker initialization error"}`
    );
  });
  const wasmBytes = await loadWasmAssetBytes(wasmAsset as unknown as string);
  const ready = waitForWorker(worker);
  worker.postMessage({ method: "mmt/boot", params: { wasmBytes } }, [wasmBytes]);
  await ready;
  const options = clientOptions(Boolean(tinymist));
  let activeClient: LanguageClient;
  if (tinymist) installTypstMiddleware(options, tinymist, () => activeClient);
  activeClient = new LanguageClient(
    "mmt",
    "MomoScript Language Server",
    options,
    worker
  );
  client = activeClient;
  client.onNotification("mmt/previewRequested", () => {
    // The preview backend will consume this revision-bound event in the next slice.
  });
  client.onNotification("mmt/workerFailed", (params: { message: string }) => {
    void vscode.window.showErrorMessage(
      `MomoScript browser language server failed: ${params.message}`
    );
  });
  if (tinymist) context.subscriptions.push(...connectTypstBackend(activeClient, tinymist, "web"));
  await client.start();
  try {
    await syncConfiguredPackManifests(context, activeClient);
  } catch (error) {
    void vscode.window.showWarningMessage(
      `MomoScript resource packs are unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function waitForWorker(target: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Worker startup timed out")), 15_000);
    const onMessage = (event: MessageEvent) => {
      if (event.data?.method === "mmt/workerReady") finish();
      if (event.data?.method === "mmt/workerFailed") {
        finish(new Error(event.data.params?.message ?? "Worker startup failed"));
      }
    };
    const onError = (event: ErrorEvent) =>
      finish(new Error(event.message || "Worker startup failed"));
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      target.removeEventListener("message", onMessage);
      target.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    target.addEventListener("message", onMessage);
    target.addEventListener("error", onError);
  });
}

export async function deactivate(): Promise<void> {
  try {
    await client?.stop();
  } finally {
    await tinymist?.stop();
    tinymist = undefined;
    worker?.terminate();
    worker = undefined;
    client = undefined;
  }
}
