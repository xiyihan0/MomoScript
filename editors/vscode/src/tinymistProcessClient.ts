import type { TinymistCapabilityView } from "./tinymistCapabilities";
import {
  createTinymistProcessTransport,
  type TinymistProcessFactory
} from "./tinymistProcessTransport";
import { TinymistHostSession } from "./tinymistHostSession";
import type { TinymistTransport } from "./tinymistTransport";
import { DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS } from "./typstProjectState";
import {
  validateTinymistInitialize,
  type TinymistHostBackend,
  type TinymistInitializeResult,
  type TypstProjectUpdate
} from "./tinymistClient";

export type { TinymistProcessFactory } from "./tinymistProcessTransport";

export class TinymistProcessClient implements TinymistHostBackend {
  private readonly session: TinymistHostSession;

  private constructor(private readonly transport: TinymistTransport, closeGraceMs: number) {
    this.session = new TinymistHostSession({
      label: "Tinymist process",
      transport,
      closeGraceMs,
      boot: () => this.bootProcess()
    });
  }

  static async start(
    command: string,
    closeGraceMs = DEFAULT_PROJECT_FILE_CLOSE_GRACE_MS,
    processFactory?: TinymistProcessFactory
  ): Promise<TinymistProcessClient> {
    const transport = createTinymistProcessTransport(command, {
      processFactory
    });
    const client = new TinymistProcessClient(transport, closeGraceMs);
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

  capabilities(): TinymistCapabilityView {
    return this.session.capabilities();
  }

  on(method: string, handler: (params: unknown) => void): void {
    this.session.on(method, handler);
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
          publishDiagnostics: { versionSupport: true, relatedInformation: true }
        }
      },
      clientInfo: { name: "momoscript-vscode", version: "0.1.0" }
    });
    validateTinymistInitialize(session.initializeResult as TinymistInitializeResult);
    return session;
  }
}
