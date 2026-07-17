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

import {
  diagnosticVersionMatchesProjection,
  projectionRevisionIsCurrent,
  type TinymistHostBackend,
  type TypstProjectUpdate
} from "./tinymistClient";
import {
  LineIndex,
  mmtClientPosition,
  parseProjectedPosition,
  retainedBackendPosition,
  wireBackendPosition,
  type RetainedBackendPosition
} from "./typstPosition";

const TINYMIST_POSITION_ENCODING = "utf-16" as const;

function standaloneBackendPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  activeClient: BaseLanguageClient
): { line: number; character: number } {
  const client = mmtClientPosition(
    activeClient.code2ProtocolConverter.asPosition(position),
    "utf-16"
  );
  return wireBackendPosition(
    new LineIndex(document.getText()).convertClient(client, TINYMIST_POSITION_ENCODING)
  );
}

async function projectedBackendPosition(
  document: vscode.TextDocument,
  position: vscode.Position,
  token: vscode.CancellationToken,
  activeClient: BaseLanguageClient,
  backend: TinymistHostBackend
): Promise<RetainedBackendPosition | null> {
  const client = mmtClientPosition(
    activeClient.code2ProtocolConverter.asPosition(position),
    "utf-16"
  );
  const value = await activeClient.sendRequest<unknown>(
    "mmt/typstPosition",
    {
      textDocument: { uri: document.uri.toString() },
      position: client.value,
      backendEncoding: TINYMIST_POSITION_ENCODING
    },
    token
  );
  if (value === null) return null;
  const projected = parseProjectedPosition(value);
  return retainedBackendPosition(projected, backend.projectForEntry(projected.entryUri));
}

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
    didOpen: async (document, next) => {
      if (document.languageId !== "typst") await next(document);
    },
    didChange: async (event, next) => {
      if (event.document.languageId !== "typst") await next(event);
    },
    didClose: async (document, next) => {
      if (document.languageId !== "typst") await next(document);
    },
    provideCompletionItem: async (document, position, completionContext, token, next) => {
      if (document.languageId === "typst") {
        const activeClient = client();
        const result = await requestWithCancellation<ProtocolCompletionItem[] | ProtocolCompletionList | null>(backend, "textDocument/completion", {
          textDocument: { uri: document.uri.toString() },
          position: standaloneBackendPosition(document, position, activeClient),
          context: { triggerKind: completionContext.triggerKind, triggerCharacter: completionContext.triggerCharacter }
        }, token);
        return activeClient.protocol2CodeConverter.asCompletionResult(result, undefined, token);
      }
      const mmt = await next(document, position, completionContext, token);
      if (Array.isArray(mmt) ? mmt.length > 0 : Boolean(mmt?.items.length)) return mmt;
      const activeClient = client();
      try {
        const route = await projectedBackendPosition(
          document,
          position,
          token,
          activeClient,
          backend
        );
        if (!route) return mmt;
        const result = await requestWithCancellation<
          ProtocolCompletionItem[] | ProtocolCompletionList | null
        >(backend, "textDocument/completion", {
          textDocument: { uri: route.entryUri },
          position: wireBackendPosition(route.position),
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
            entryUri: route.entryUri,
            backendEncoding: route.position.encoding,
            items
          },
          token
        );
        return activeClient.protocol2CodeConverter.asCompletionResult(mapped, undefined, token);
      } catch (error) {
        console.error("embedded Typst completion failed", error);
        return mmt;
      }
    },
    provideHover: async (document, position, token, next) => {
      if (document.languageId === "typst") {
        const activeClient = client();
        const hover = await requestWithCancellation<ProtocolHover | null>(backend, "textDocument/hover", {
          textDocument: { uri: document.uri.toString() },
          position: standaloneBackendPosition(document, position, activeClient)
        }, token);
        return hover ? activeClient.protocol2CodeConverter.asHover(hover) : undefined;
      }
      const mmt = await next(document, position, token);
      if (mmt) return mmt;
      const activeClient = client();
      try {
        const route = await projectedBackendPosition(
          document,
          position,
          token,
          activeClient,
          backend
        );
        if (!route) return mmt;
        const hover = await requestWithCancellation<ProtocolHover | null>(backend, "textDocument/hover", {
          textDocument: { uri: route.entryUri },
          position: wireBackendPosition(route.position)
        }, token);
        if (!hover) return undefined;
        const mapped = await activeClient.sendRequest<ProtocolHover | null>(
          "mmt/mapTypstHover",
          {
            sourceUri: document.uri.toString(),
            revision: route.revision,
            entryUri: route.entryUri,
            backendEncoding: route.position.encoding,
            hover
          },
          token
        );
        return activeClient.protocol2CodeConverter.asHover(mapped);
      } catch (error) {
        console.error("embedded Typst hover failed", error);
        return mmt;
      }
    },
    provideSignatureHelp: async (document, position, signatureContext, token, next) => {
      if (document.languageId === "typst") {
        const activeClient = client();
        const signature = await requestWithCancellation<ProtocolSignatureHelp | null>(backend, "textDocument/signatureHelp", {
          textDocument: { uri: document.uri.toString() },
          position: standaloneBackendPosition(document, position, activeClient),
          context: { triggerKind: signatureContext.triggerKind, triggerCharacter: signatureContext.triggerCharacter, isRetrigger: signatureContext.isRetrigger }
        }, token);
        return signature ? activeClient.protocol2CodeConverter.asSignatureHelp(signature, token) : undefined;
      }
      const mmt = await next(document, position, signatureContext, token);
      if (mmt) return mmt;
      const activeClient = client();
      try {
        const route = await projectedBackendPosition(
          document,
          position,
          token,
          activeClient,
          backend
        );
        if (!route) return mmt;
        const signature = await requestWithCancellation<ProtocolSignatureHelp | null>(
          backend,
          "textDocument/signatureHelp",
          {
            textDocument: { uri: route.entryUri },
            // Tinymist 0.15.2 advances the supplied offset by one before
            // classifying the argument context, so point it at the trigger.
            position: wireBackendPosition(route.index.previousScalar(route.position)),
            context: {
              triggerKind: signatureContext.triggerKind,
              triggerCharacter: signatureContext.triggerCharacter,
              isRetrigger: signatureContext.isRetrigger
            }
          },
          token
        );
        if (!signature) return undefined;
        const current = await projectedBackendPosition(
          document,
          position,
          token,
          activeClient,
          backend
        );
        if (!current || current.revision !== route.revision) return undefined;
        if (!projectionRevisionIsCurrent(backend, route.entryUri, route.revision)) return undefined;
        return activeClient.protocol2CodeConverter.asSignatureHelp(signature, token);
      } catch (error) {
        console.error("embedded Typst signature help failed", error);
        return mmt;
      }
    }
  };
}

export function connectTypstBackend(
  client: BaseLanguageClient,
  backend: TinymistHostBackend
): vscode.Disposable[] {
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
      const project = backend.projectForEntry(params.uri);
      if (!project || !diagnosticVersionMatchesProjection(project.revision, params.version)) {
        return;
      }
      if (project.sourceUri === project.entryUri) {
        const converted = await client.protocol2CodeConverter.asDiagnostics(params.diagnostics);
        if (!projectionRevisionIsCurrent(backend, params.uri, project.revision)) return;
        diagnostics.set(vscode.Uri.parse(project.sourceUri), converted);
        return;
      }
      const mapped = await client.sendRequest<ProtocolDiagnostic[] | null>(
        "mmt/mapTypstDiagnostics",
        {
          sourceUri: project.sourceUri,
          revision: project.revision,
          entryUri: project.entryUri,
          backendEncoding: TINYMIST_POSITION_ENCODING,
          diagnostics: params.diagnostics
        }
      );
      if (!mapped) return;
      const converted = await client.protocol2CodeConverter.asDiagnostics(mapped);
      if (!projectionRevisionIsCurrent(backend, params.uri, project.revision)) return;
      diagnostics.set(vscode.Uri.parse(project.sourceUri), converted);
    })().catch((error: unknown) => {
      console.error("embedded Typst diagnostics failed", error);
    });
  });
  return [diagnostics, projectUpdated, projectClosed];
}
