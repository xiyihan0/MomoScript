import * as vscode from "vscode";
import type { LanguageClientOptions } from "vscode-languageclient";

export function clientOptions(typstLanguageFeatures = false): LanguageClientOptions {
  return {
    documentSelector: [{ language: "mmt" }],
    initializationOptions: {
      typstLanguageFeatures,
      previewOnChange: vscode.workspace
        .getConfiguration("mmt")
        .get("preview.onChange", true)
    }
  };
}
