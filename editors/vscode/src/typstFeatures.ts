import * as vscode from "vscode";
import type { BaseLanguageClient, LanguageClientOptions } from "vscode-languageclient";
import type {
  CompletionItem as ProtocolCompletionItem,
  CompletionList as ProtocolCompletionList,
  CompletionTriggerKind as ProtocolCompletionTriggerKind,
  Diagnostic as ProtocolDiagnostic,
  Hover as ProtocolHover,
  SemanticTokens as ProtocolSemanticTokens,
  SignatureHelp as ProtocolSignatureHelp,
  SignatureHelpTriggerKind as ProtocolSignatureHelpTriggerKind
} from "vscode-languageserver-protocol";

import type { TinymistHostBackend, TypstProjectUpdate } from "./tinymistClient";
import {
  TypstFeatureRouter,
  type TypstCapabilityUnavailableState,
  type TypstRouterDocument
} from "./typstFeatureRouter";

const routersByBackend = new WeakMap<TinymistHostBackend, TypstFeatureRouter>();

export function installTypstMiddleware(
  options: LanguageClientOptions,
  backend: TinymistHostBackend,
  client: () => BaseLanguageClient
): void {
  const unavailableMethods = new Set<string>();
  const router = new TypstFeatureRouter(backend, client, {
    unavailable: (state) => showCapabilityUnavailable(state, unavailableMethods)
  });
  routersByBackend.set(backend, router);

  options.middleware = {
    didOpen: async (document, next) => {
      router.open(routerDocument(document));
      if (document.languageId !== "typst") await next(document);
    },
    didChange: async (event, next) => {
      router.change(routerDocument(event.document));
      if (event.document.languageId !== "typst") await next(event);
    },
    didClose: async (document, next) => {
      router.close(document.uri.toString());
      if (document.languageId !== "typst") await next(document);
    },
    provideCompletionItem: async (document, position, completionContext, token, next) => {
      const mmt = document.languageId === "typst"
        ? undefined
        : await next(document, position, completionContext, token);
      if (Array.isArray(mmt) ? mmt.length > 0 : Boolean(mmt?.items.length)) return mmt;
      try {
        const activeClient = client();
        const result = await router.completion(
          routerDocument(document),
          activeClient.code2ProtocolConverter.asPosition(position),
          {
            triggerKind: completionContext.triggerKind as ProtocolCompletionTriggerKind,
            ...(completionContext.triggerCharacter === undefined
              ? {}
              : { triggerCharacter: completionContext.triggerCharacter })
          },
          token
        );
        return result === undefined
          ? mmt
          : activeClient.protocol2CodeConverter.asCompletionResult(
              result as ProtocolCompletionItem[] | ProtocolCompletionList | null,
              undefined,
              token
            );
      } catch (error) {
        console.error(`${document.languageId === "typst" ? "standalone" : "embedded"} Typst completion failed`, error);
        return mmt;
      }
    },
    provideHover: async (document, position, token, next) => {
      const mmt = document.languageId === "typst"
        ? undefined
        : await next(document, position, token);
      if (mmt) return mmt;
      try {
        const activeClient = client();
        const result = await router.hover(
          routerDocument(document),
          activeClient.code2ProtocolConverter.asPosition(position),
          token
        );
        return result === undefined
          ? mmt
          : activeClient.protocol2CodeConverter.asHover(result as ProtocolHover | null);
      } catch (error) {
        console.error(`${document.languageId === "typst" ? "standalone" : "embedded"} Typst hover failed`, error);
        return mmt;
      }
    },
    provideSignatureHelp: async (document, position, signatureContext, token, next) => {
      const mmt = document.languageId === "typst"
        ? undefined
        : await next(document, position, signatureContext, token);
      if (mmt) return mmt;
      try {
        const activeClient = client();
        const result = await router.signatureHelp(
          routerDocument(document),
          activeClient.code2ProtocolConverter.asPosition(position),
          {
            triggerKind: signatureContext.triggerKind as ProtocolSignatureHelpTriggerKind,
            isRetrigger: signatureContext.isRetrigger,
            ...(signatureContext.triggerCharacter === undefined
              ? {}
              : { triggerCharacter: signatureContext.triggerCharacter })
          },
          token
        );
        return result === undefined
          ? mmt
          : activeClient.protocol2CodeConverter.asSignatureHelp(
              result as ProtocolSignatureHelp | null,
              token
            );
      } catch (error) {
        console.error(`${document.languageId === "typst" ? "standalone" : "embedded"} Typst signature help failed`, error);
        return mmt;
      }
    },
    provideDocumentSemanticTokens: async (document, token, next) => {
      if (document.languageId !== "typst") return await next(document, token);
      try {
        const activeClient = client();
        const result = await router.semanticTokens(routerDocument(document), token);
        return result === undefined
          ? undefined
          : await activeClient.protocol2CodeConverter.asSemanticTokens(
              result as ProtocolSemanticTokens | null,
              token
            );
      } catch (error) {
        console.error("standalone Typst semantic tokens failed", error);
        return undefined;
      }
    }
  };
}

export function connectTypstBackend(
  client: BaseLanguageClient,
  backend: TinymistHostBackend
): vscode.Disposable[] {
  const router = routersByBackend.get(backend);
  if (!router) throw new Error("Typst middleware must own the feature router before backend connection");
  let warnedAboutUnversionedDiagnostics = false;
  const diagnostics = vscode.languages.createDiagnosticCollection("mmt-typst");
  const projectUpdated = client.onNotification(
    "mmt/typstProjectUpdated",
    (update: TypstProjectUpdate) => {
      backend.syncProject(update);
      const current = backend.projectForEntry(update.entryUri);
      if (current?.sourceUri === update.sourceUri && current.revision === update.revision) {
        diagnostics.delete(vscode.Uri.parse(update.sourceUri));
      }
    }
  );
  const projectClosed = client.onNotification(
    "mmt/typstProjectClosed",
    (params: { sourceUri: string; entryUri: string }) => {
      if (backend.closeProject(params.sourceUri, params.entryUri)) {
        diagnostics.delete(vscode.Uri.parse(params.sourceUri));
      }
    }
  );
  backend.on("textDocument/publishDiagnostics", (value) => {
    void (async () => {
      const params = value as {
        uri: string;
        version?: number | null;
        diagnostics: ProtocolDiagnostic[];
      };
      if (params.version == null && !warnedAboutUnversionedDiagnostics) {
        warnedAboutUnversionedDiagnostics = true;
        console.warn(
          "Tinymist sent unversioned diagnostics; using revision-scoped virtual entry URI isolation"
        );
      }
      const routed = await router.diagnostics(params);
      if (!routed) return;
      const converted = await client.protocol2CodeConverter.asDiagnostics(
        routed.diagnostics as ProtocolDiagnostic[]
      );
      diagnostics.set(vscode.Uri.parse(routed.uri), converted);
    })().catch((error: unknown) => {
      console.error("Typst diagnostics failed", error);
    });
  });
  return [diagnostics, projectUpdated, projectClosed];
}

function routerDocument(document: vscode.TextDocument): TypstRouterDocument {
  return {
    languageId: document.languageId,
    uri: document.uri.toString(),
    version: document.version,
    text: document.getText()
  };
}

function showCapabilityUnavailable(
  state: TypstCapabilityUnavailableState,
  reported: Set<string>
): void {
  const key = `${state.backendGeneration}\0${state.method}`;
  if (reported.has(key)) return;
  reported.add(key);
  const label = state.method.slice(state.method.lastIndexOf("/") + 1);
  vscode.window?.setStatusBarMessage?.(
    `Typst ${label} unavailable for the active backend`,
    5_000
  );
}
