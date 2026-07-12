interface TinymistModule {
  default(input: { module_or_path: string }): Promise<unknown>;
  TinymistLanguageServer: TinymistServerConstructor;
}

interface TinymistServerConstructor {
  new (transport: TinymistTransport): TinymistServer;
  version(): string;
}

interface TinymistServer {
  on_event(eventId: number): void;
  on_request(method: string, params: unknown): unknown;
  on_notification(method: string, params: unknown): void;
  on_response(response: unknown): void;
  constructor: { version(): string };
}

interface TinymistTransport {
  sendEvent(eventId: number): void;
  sendRequest(request: JsonRpcMessage): void;
  sendNotification(notification: JsonRpcMessage): void;
  resolveFn(): void;
}

interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface BootMessage {
  method: "tinymist/boot";
  params: { moduleUri: string; wasmUri: string };
}

const worker = self as unknown as DedicatedWorkerGlobalScope;
let server: TinymistServer | undefined;
let queuedEvents: number[] = [];

function post(message: JsonRpcMessage): void {
  worker.postMessage({ jsonrpc: "2.0", ...message });
}

function drainEvents(): void {
  if (!server) return;
  while (queuedEvents.length > 0) {
    const events = queuedEvents;
    queuedEvents = [];
    for (const event of events) server.on_event(event);
  }
}

function isResponseError(value: unknown): value is { code: number; message: string; data?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "number" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

async function boot(message: BootMessage): Promise<void> {
  if (server) return;
  post({ method: "tinymist/workerBootProgress", params: { stage: "loading-module" } });
  const module = (await import(message.params.moduleUri)) as TinymistModule;
  post({ method: "tinymist/workerBootProgress", params: { stage: "initializing-wasm" } });
  await module.default({ module_or_path: message.params.wasmUri });
  post({ method: "tinymist/workerBootProgress", params: { stage: "creating-server" } });
  server = new module.TinymistLanguageServer({
    sendEvent: (eventId) => queuedEvents.push(eventId),
    sendRequest: (request) => post(request),
    sendNotification: (notification) => post(notification),
    resolveFn: () => undefined
  });
  post({ method: "tinymist/workerBootProgress", params: { stage: "server-created" } });
  post({
    method: "tinymist/workerReady",
    params: {
      protocolVersion: 1,
      backendName: "tinymist-web",
      backendVersion: module.TinymistLanguageServer.version()
    }
  });
}

worker.addEventListener("message", (event: MessageEvent<JsonRpcMessage | BootMessage>) => {
  void (async () => {
    const message = event.data;
    if (message.method === "tinymist/boot") {
      await boot(message as BootMessage);
      return;
    }
    const rpc = message as JsonRpcMessage;
    if (!server) throw new Error("Tinymist Worker received a message before boot");
    if (rpc.method && rpc.id !== undefined) {
      const result = await server.on_request(rpc.method, rpc.params ?? null);
      drainEvents();
      if (isResponseError(result)) post({ id: rpc.id, error: result });
      else post({ id: rpc.id, result });
      return;
    }
    if (rpc.method) {
      server.on_notification(rpc.method, rpc.params ?? null);
      drainEvents();
      return;
    }
    if (rpc.id !== undefined) {
      server.on_response(rpc);
      drainEvents();
    }
  })().catch((error: unknown) => {
    const request = event.data as JsonRpcMessage;
    if (request.method === "tinymist/boot") {
      post({
        method: "tinymist/workerFailed",
        params: { message: error instanceof Error ? error.message : String(error) }
      });
      return;
    }
    post({
      id: request.id ?? null,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error)
      }
    });
  });
});
