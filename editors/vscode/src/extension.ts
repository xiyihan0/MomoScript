import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions
} from "vscode-languageclient/node";

import { clientOptions } from "./clientOptions";
import { TinymistProcessClient } from "./tinymistProcessClient";
import { syncConfiguredPackManifests } from "./resourcePacks";
import { registerMmtLanguageEditing } from "./languageEditing";
import { connectTypstBackend, installTypstMiddleware } from "./typstFeatures";

let client: LanguageClient | undefined;
let tinymist: TinymistProcessClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  context.subscriptions.push(registerMmtLanguageEditing());
  const configuredPath = vscode.workspace
    .getConfiguration("mmt")
    .get<string>("server.path", "");
  const platform = `${process.platform}-${process.arch}`;
  const executable = process.platform === "win32" ? "mmt-lsp.exe" : "mmt-lsp";
  const command =
    configuredPath || context.asAbsolutePath(path.join("bin", platform, executable));
  const configuredTinymist = vscode.workspace
    .getConfiguration("mmt")
    .get<string>("typst.server.path", "");
  const tinymistExecutable = process.platform === "win32" ? "tinymist.exe" : "tinymist";
  const bundledTinymist = context.asAbsolutePath(
    path.join("bin", platform, tinymistExecutable)
  );
  const tinymistCommand = configuredTinymist || bundledTinymist;
  if (configuredTinymist || fs.existsSync(bundledTinymist)) {
    try {
      tinymist = await TinymistProcessClient.start(tinymistCommand);
    } catch (error) {
      tinymist = undefined;
      void vscode.window.showWarningMessage(
        `Embedded Typst language service is unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const serverOptions: ServerOptions = { command };
  const options: LanguageClientOptions = clientOptions(Boolean(tinymist));
  let activeClient: LanguageClient;
  if (tinymist) installTypstMiddleware(options, tinymist, () => activeClient);
  activeClient = new LanguageClient(
    "mmt",
    "MomoScript Language Server",
    serverOptions,
    options
  );
  client = activeClient;
  client.onNotification("mmt/previewRequested", () => {
    // The preview backend will consume this revision-bound event in the next slice.
  });
  if (tinymist) context.subscriptions.push(...connectTypstBackend(activeClient, tinymist, "native"));
  await client.start();
  try {
    await syncConfiguredPackManifests(context, activeClient);
  } catch (error) {
    void vscode.window.showWarningMessage(
      `MomoScript resource packs are unavailable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function deactivate(): Promise<void> {
  try {
    await client?.stop();
  } finally {
    await tinymist?.stop();
    tinymist = undefined;
  }
}
