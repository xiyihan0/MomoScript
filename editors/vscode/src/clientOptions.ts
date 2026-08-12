import * as vscode from "vscode";
import type { LanguageClientOptions } from "vscode-languageclient";

export function clientOptions(typstLanguageFeatures = false): LanguageClientOptions {
  return {
    documentSelector: [{ language: "mmt" }, { language: "typst" }],
    middleware: {
      provideInlayHints: async (document, viewPort, token, next) => {
        if (!vscode.workspace.getConfiguration("mmt.inlayHints").get("resolvedSpeaker", true)) return [];
        return await next(document, viewPort, token);
      }
    },
    initializationOptions: {
      typstLanguageFeatures,
      previewOnChange: vscode.workspace
        .getConfiguration("mmt")
        .get("preview.onChange", true)
    }
  };
}
