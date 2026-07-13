import * as vscode from "vscode";
import type { LanguageClientOptions } from "vscode-languageclient";
import type { BaseLanguageClient } from "vscode-languageclient";
import type {
  CompletionItem as ProtocolCompletionItem,
  CompletionList as ProtocolCompletionList,
  Diagnostic as ProtocolDiagnostic,
  Hover as ProtocolHover,
  SignatureHelp as ProtocolSignatureHelp
} from "vscode-languageserver-protocol";

import type {
  ProjectedPosition,
  TinymistHostBackend,
  TypstProjectUpdate
} from "./tinymistClient";

async function requestWithCancellation<T>(
  backend: TinymistHostBackend,
  method: string,
  params: unknown,
  token: vscode.CancellationToken
): Promise<T> {
  const controller = new AbortController();
  const subscription = token.onCancellationRequested(() => controller.abort());
  try {
    return await backend.request<T>(method, params, controller.signal);
  } finally {
    subscription.dispose();
  }
}

export function installTypstMiddleware(
  options: LanguageClientOptions,
  backend: TinymistHostBackend,
  client: () => BaseLanguageClient
): void {
  options.middleware = {
    provideCompletionItem: async (document, position, completionContext, token, next) => {
      const activeClient = client();
      try {
        const route = await activeClient.sendRequest<ProjectedPosition | null>(
          "mmt/typstPosition",
          {
            textDocument: { uri: document.uri.toString() },
            position: activeClient.code2ProtocolConverter.asPosition(position)
          },
          token
        );
        if (!route) return next(document, position, completionContext, token);
        const result = await requestWithCancellation<
          ProtocolCompletionItem[] | ProtocolCompletionList | null
        >(backend, "textDocument/completion", {
          textDocument: { uri: route.entryUri },
          position: route.position,
          context: {
            triggerKind: completionContext.triggerKind,
            triggerCharacter: completionContext.triggerCharacter
          }
        }, token);
        const items = Array.isArray(result) ? result : (result?.items ?? []);
        const mapped = await activeClient.sendRequest<ProtocolCompletionItem[] | null>(
          "mmt/mapTypstCompletion",
          {
            sourceUri: document.uri.toString(),
            revision: route.revision,
            items
          },
          token
        );
        return activeClient.protocol2CodeConverter.asCompletionResult(mapped, undefined, token);
      } catch (error) {
        console.error("embedded Typst completion failed", error);
        return next(document, position, completionContext, token);
      }
    },
    provideHover: async (document, position, token, next) => {
      const activeClient = client();
      try {
        const route = await activeClient.sendRequest<ProjectedPosition | null>(
          "mmt/typstPosition",
          {
            textDocument: { uri: document.uri.toString() },
            position: activeClient.code2ProtocolConverter.asPosition(position)
          },
          token
        );
        if (!route) return next(document, position, token);
        const hover = await requestWithCancellation<ProtocolHover | null>(backend, "textDocument/hover", {
          textDocument: { uri: route.entryUri },
          position: route.position
        }, token);
        if (!hover) return undefined;
        const mapped = await activeClient.sendRequest<ProtocolHover | null>(
          "mmt/mapTypstHover",
          {
            sourceUri: document.uri.toString(),
            revision: route.revision,
            hover
          },
          token
        );
        return activeClient.protocol2CodeConverter.asHover(mapped);
      } catch (error) {
        console.error("embedded Typst hover failed", error);
        return next(document, position, token);
      }
    },
    provideSignatureHelp: async (document, position, signatureContext, token, next) => {
      const activeClient = client();
      try {
        const params = {
          textDocument: { uri: document.uri.toString() },
          position: activeClient.code2ProtocolConverter.asPosition(position)
        };
        const route = await activeClient.sendRequest<ProjectedPosition | null>(
          "mmt/typstPosition",
          params,
          token
        );
        if (!route) return next(document, position, signatureContext, token);
        const signature = await requestWithCancellation<ProtocolSignatureHelp | null>(
          backend,
          "textDocument/signatureHelp",
          {
            textDocument: { uri: route.entryUri },
            // Tinymist 0.15.2 advances the supplied offset by one before
            // classifying the argument context, so point it at the trigger.
            position: {
              line: route.position.line,
              character: Math.max(0, route.position.character - 1)
            },
            context: {
              triggerKind: signatureContext.triggerKind,
              triggerCharacter: signatureContext.triggerCharacter,
              isRetrigger: signatureContext.isRetrigger
            }
          },
          token
        );
        if (!signature) return undefined;
        const current = await activeClient.sendRequest<ProjectedPosition | null>(
          "mmt/typstPosition",
          params,
          token
        );
        if (!current || current.revision !== route.revision) return undefined;
        return activeClient.protocol2CodeConverter.asSignatureHelp(signature, token);
      } catch (error) {
        console.error("embedded Typst signature help failed", error);
        return next(document, position, signatureContext, token);
      }
    }
  };
}

export function connectTypstBackend(
  client: BaseLanguageClient,
  backend: TinymistHostBackend
): vscode.Disposable[] {
  const diagnostics = vscode.languages.createDiagnosticCollection("mmt-typst");
  const projectUpdated = client.onNotification(
    "mmt/typstProjectUpdated",
    (update: TypstProjectUpdate) => {
      backend.syncProject(update);
    }
  );
  const projectClosed = client.onNotification(
    "mmt/typstProjectClosed",
    (params: { sourceUri: string }) => {
      backend.closeProject(params.sourceUri);
      diagnostics.delete(vscode.Uri.parse(params.sourceUri));
    }
  );
  backend.on("textDocument/publishDiagnostics", (value) => {
    void (async () => {
      const params = value as {
        uri: string;
        version?: number;
        diagnostics: ProtocolDiagnostic[];
      };
      const project = backend.projectForEntry(params.uri);
      if (!project || (params.version !== undefined && params.version !== project.sourceVersion)) {
        return;
      }
      const mapped = await client.sendRequest<ProtocolDiagnostic[] | null>(
        "mmt/mapTypstDiagnostics",
        {
          sourceUri: project.sourceUri,
          revision: project.revision,
          diagnostics: params.diagnostics
        }
      );
      if (!mapped) return;
      const converted = await client.protocol2CodeConverter.asDiagnostics(mapped);
      diagnostics.set(vscode.Uri.parse(project.sourceUri), converted);
    })().catch((error: unknown) => {
      console.error("embedded Typst diagnostics failed", error);
    });
  });
  return [diagnostics, projectUpdated, projectClosed];
}
