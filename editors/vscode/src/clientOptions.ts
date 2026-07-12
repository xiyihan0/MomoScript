import * as vscode from "vscode";
import type { LanguageClientOptions } from "vscode-languageclient";

export function clientOptions(typstLanguageFeatures = false): LanguageClientOptions {
  return {
    documentSelector: [
      { language: "mmt", scheme: "file" },
      { language: "mmt", scheme: "untitled" },
      { language: "mmt", scheme: "vscode-vfs" }
    ],
    initializationOptions: {
      typstLanguageFeatures,
      previewOnChange: vscode.workspace
        .getConfiguration("mmt")
        .get("preview.onChange", true)
    }
  };
}
