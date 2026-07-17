import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  JsonRpcTinymistTransport,
  type JsonRpcConnection,
  type JsonRpcMessage,
  type JsonRpcTransportOptions,
  type TinymistTransport
} from "./tinymistTransport";

export type TinymistProcessFactory = (command: string) => ChildProcessWithoutNullStreams;

export function spawnTinymistProcess(command: string): ChildProcessWithoutNullStreams {
  return spawn(command, ["lsp"], { stdio: ["pipe", "pipe", "pipe"] });
}

class TinymistProcessConnection implements JsonRpcConnection {
  private buffer = Buffer.alloc(0);
  private messageHandler: (message: JsonRpcMessage) => void = () => {};
  private failureHandler: (error: Error) => void = () => {};
  private terminated = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.terminated) return;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        this.drainMessages();
      } catch (error) {
        this.failureHandler(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trimEnd();
      if (/\b(?:ERROR|WARN)\b/.test(text)) console.error(`[tinymist] ${text}`);
    });
    child.once("error", (error) => {
      if (!this.terminated) this.failureHandler(error);
    });
    child.once("exit", (code, signal) => {
      if (!this.terminated) this.failureHandler(new Error(`Tinymist exited with ${code ?? signal}`));
    });
  }

  send(message: JsonRpcMessage): void {
    if (this.terminated) throw new Error("Tinymist process unavailable");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler;
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    this.buffer = Buffer.alloc(0);
    if (this.child.exitCode === null) this.child.kill();
  }

  private drainMessages(): void {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengthText = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)?.[1];
      if (!lengthText) throw new Error("Tinymist response omitted Content-Length");
      const length = Number(lengthText);
      if (!Number.isSafeInteger(length) || length < 0) throw new Error("Tinymist response had invalid Content-Length");
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const message = JSON.parse(this.buffer.subarray(bodyStart, bodyEnd).toString("utf8")) as JsonRpcMessage;
      this.buffer = this.buffer.subarray(bodyEnd);
      this.messageHandler(message);
    }
  }
}

export interface TinymistProcessTransportOptions extends JsonRpcTransportOptions {
  processFactory?: TinymistProcessFactory;
}

export function createTinymistProcessTransport(
  command: string,
  options: TinymistProcessTransportOptions = {}
): TinymistTransport {
  const processFactory = options.processFactory ?? spawnTinymistProcess;
  return new JsonRpcTinymistTransport(
    async () => new TinymistProcessConnection(processFactory(command)),
    options
  );
}
