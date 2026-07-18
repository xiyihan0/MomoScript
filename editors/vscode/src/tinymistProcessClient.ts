import type { TinymistCapabilityView } from "./tinymistCapabilities";
import {
  createTinymistProcessTransport,
  type TinymistProcessFactory
} from "./tinymistProcessTransport";
import { TinymistHostSession } from "./tinymistHostSession";
import type { TinymistTransport } from "./tinymistTransport";
import type { TypstPackageService } from "./typstPackageService";
import { DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS } from "./typstProjectState";
import {
  semanticTokensLegendFromCapabilities,
  validateTinymistInitialize,
  type TinymistHostBackend,
  type TypstProjectUpdate
} from "./tinymistClient";

export type { TinymistProcessFactory } from "./tinymistProcessTransport";

export class TinymistProcessClient implements TinymistHostBackend {
  private readonly session: TinymistHostSession;

  private constructor(
    private readonly transport: TinymistTransport,
    closeGraceMs: number,
    packageService?: TypstPackageService
  ) {
    this.session = new TinymistHostSession({
      label: "Tinymist process",
      transport,
      closeGraceMs,
      packageService,
      boot: () => this.bootProcess()
    });
  }

  static async start(
    command: string,
    closeGraceMs = DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS,
    processFactory?: TinymistProcessFactory,
    packageService?: TypstPackageService
  ): Promise<TinymistProcessClient> {
    const transport = createTinymistProcessTransport(command, {
      processFactory
    });
    const client = new TinymistProcessClient(transport, closeGraceMs, packageService);
    try {
      await client.session.start();
      return client;
    } catch (error) {
      await client.stop();
      throw error;
    }
  }

  backendGeneration(): number {
    return this.session.backendGeneration();
  }
  queuedProjectCount(): number {
    return this.session.queuedProjectCount();
  }


  capabilities(): TinymistCapabilityView {
    return this.session.capabilities();
  }

  semanticTokensLegend(): { tokenTypes: string[]; tokenModifiers: string[] } | undefined {
    return semanticTokensLegendFromCapabilities(this.session.capabilities());
  }

  on(method: string, handler: (params: unknown) => void): { dispose(): void } {
    return this.session.on(method, handler);
  }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    return this.session.request<T>(method, params, signal);
  }

  notify(method: string, params: unknown): void {
    this.session.notify(method, params);
  }

  syncProject(update: TypstProjectUpdate): void {
    this.session.syncProject(update);
  }

  projectForEntry(entryUri: string): TypstProjectUpdate | undefined {
    return this.session.projectForEntry(entryUri);
  }

  closeProject(sourceUri: string, entryUri: string): boolean {
    return this.session.closeProject(sourceUri, entryUri);
  }

  restart(): Promise<void> {
    return this.session.restart();
  }

  stop(): Promise<void> {
    return this.session.stop();
  }

  terminate(): void {
    this.session.terminate();
  }

  private async bootProcess() {
    const session = await this.transport.start({
      processId: process.pid,
      rootUri: null,
      capabilities: {
        workspace: { configuration: true },
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          completion: { completionItem: { snippetSupport: true } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          signatureHelp: {},
          publishDiagnostics: { versionSupport: true, relatedInformation: true },
          semanticTokens: {
            requests: { full: true, range: false },
            tokenTypes: ["namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter", "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword", "modifier", "comment", "string", "number", "regexp", "operator", "decorator"],
            tokenModifiers: ["declaration", "definition", "readonly", "static", "deprecated", "abstract", "async", "modification", "documentation", "defaultLibrary"],
            formats: ["relative"]
          }
        }
      },
      clientInfo: { name: "momoscript-vscode", version: "0.1.0" }
    });
    const initialize = session.initializeResult;
    validateTinymistInitialize(initialize);
    return session;
  }
}
