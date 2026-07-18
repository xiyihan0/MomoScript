export type JsonRpcId = number | string;

export interface JsonRpcMessage {
  jsonrpc?: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface TinymistBackendSession {
  generation: number;
  initializeResult: unknown;
}

export interface TinymistTransport {
  readonly generation: number;
  readonly started: boolean;
  start(initializeParams: unknown): Promise<TinymistBackendSession>;
  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T>;
  notify(method: string, params: unknown): void;
  onNotification(handler: (method: string, params: unknown, generation: number) => void): void;
  onServerRequest(handler: TinymistServerRequestHandler): void;
  onFailure(handler: (error: Error, generation: number) => void): void;
  stop(): Promise<void>;
  terminateNow(reason?: Error): void;
}

export interface JsonRpcConnection {
  send(message: JsonRpcMessage): void;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onFailure(handler: (error: Error) => void): void;
  terminate(): void;
}

export type JsonRpcConnectionFactory = () => Promise<JsonRpcConnection>;
export type TinymistServerRequestHandler = (
  message: JsonRpcMessage,
  generation: number,
  signal: AbortSignal
) => JsonRpcMessage | Promise<JsonRpcMessage>;

interface PendingServerRequest {
  readonly generation: number;
  readonly controller: AbortController;
}

interface PendingRequest {
  generation: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
  removeAbortListener(): void;
}

export interface JsonRpcTransportOptions {
  requestTimeoutMs?: number;
  maxPendingRequests?: number;
  serverRequest?: TinymistServerRequestHandler;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_PENDING_REQUESTS = 256;

export class TinymistTransportError extends Error {
  constructor(
    message: string,
    readonly code: "Unavailable" | "Stopped" | "QueueFull" | "Cancelled" | "TimedOut" | "StaleGeneration"
  ) {
    super(message);
    this.name = "TinymistTransportError";
  }
}

export class JsonRpcTinymistTransport implements TinymistTransport {
  private nextId = 1;
  private currentGeneration = 0;
  private connection: JsonRpcConnection | undefined;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<(method: string, params: unknown, generation: number) => void>();
  private readonly failureHandlers = new Set<(error: Error, generation: number) => void>();
  private serverRequestHandler: TinymistServerRequestHandler;
  private permanentlyStopped = false;
  private readonly pendingServerRequests = new Map<JsonRpcId, PendingServerRequest>();
  private starting: Promise<TinymistBackendSession> | undefined;
  private readonly requestTimeoutMs: number;
  private readonly maxPendingRequests: number;

  constructor(
    private readonly connectionFactory: JsonRpcConnectionFactory,
    options: JsonRpcTransportOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
    this.serverRequestHandler = options.serverRequest ?? ((message) => ({
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32601, message: `Unsupported Tinymist server request: ${message.method ?? "unknown"}` }
    }));
  }

  get generation(): number {
    return this.currentGeneration;
  }

  get started(): boolean {
    return this.connection !== undefined;
  }

  start(initializeParams: unknown): Promise<TinymistBackendSession> {
    if (this.permanentlyStopped) {
      return Promise.reject(new TinymistTransportError("Tinymist transport stopped", "Stopped"));
    }
    if (this.starting) return this.starting;
    if (this.connection) {
      return Promise.reject(new TinymistTransportError("Tinymist transport already started", "Unavailable"));
    }
    const generation = this.currentGeneration + 1;
    const starting = (async () => {
      const connection = await this.connectionFactory();
      if (this.permanentlyStopped) {
        connection.terminate();
        throw new TinymistTransportError("Tinymist transport stopped", "Stopped");
      }
      this.currentGeneration = generation;
      this.connection = connection;
      connection.onMessage((message) => {
        if (connection === this.connection) this.handleMessage(message, generation);
      });
      connection.onFailure((error) => {
        if (connection === this.connection) this.handleConnectionFailure(error, generation);
      });
      try {
        const initializeResult = await this.request("initialize", initializeParams);
        this.notify("initialized", {});
        return { generation, initializeResult };
      } catch (error) {
        if (connection === this.connection) {
          this.connection = undefined;
          connection.terminate();
          this.failPending(error instanceof Error ? error : new Error(String(error)), generation);
        }
        throw error;
      }
    })();
    this.starting = starting;
    void starting.finally(() => {
      if (this.starting === starting) this.starting = undefined;
    }).catch(() => {});
    return starting;
  }

  request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    const connection = this.connection;
    const generation = this.currentGeneration;
    if (!connection) {
      return Promise.reject(new TinymistTransportError("Tinymist transport unavailable", "Unavailable"));
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason instanceof Error
        ? signal.reason
        : new TinymistTransportError("Tinymist request cancelled", "Cancelled"));
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new TinymistTransportError(
        `Tinymist request queue limit ${this.maxPendingRequests} reached`,
        "QueueFull"
      ));
    }
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      const cancel = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.removeAbortListener();
        if (generation === this.currentGeneration && connection === this.connection) {
          this.notify("$/cancelRequest", { id });
        }
        reject(signal?.reason instanceof Error
          ? signal.reason
          : new TinymistTransportError("Tinymist request cancelled", "Cancelled"));
      };
      const timeout = setTimeout(() => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        pending.removeAbortListener();
        reject(new TinymistTransportError(`Tinymist request timed out: ${method}`, "TimedOut"));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        generation,
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
        removeAbortListener: () => signal?.removeEventListener("abort", cancel)
      });
      signal?.addEventListener("abort", cancel, { once: true });
    });
    connection.send({ jsonrpc: "2.0", id, method, params });
    return response;
  }

  notify(method: string, params: unknown): void {
    const connection = this.connection;
    if (!connection) throw new TinymistTransportError("Tinymist transport unavailable", "Unavailable");
    connection.send({ jsonrpc: "2.0", method, params });
  }

  onNotification(handler: (method: string, params: unknown, generation: number) => void): void {
    this.notificationHandlers.add(handler);
  }

  onServerRequest(handler: TinymistServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  onFailure(handler: (error: Error, generation: number) => void): void {
    this.failureHandlers.add(handler);
  }

  async stop(): Promise<void> {
    this.permanentlyStopped = true;
    const connection = this.connection;
    if (!connection) {
      this.failPending(new TinymistTransportError("Tinymist transport stopped", "Stopped"));
      return;
    }
    try {
      await this.request("shutdown", null);
      if (connection === this.connection) this.notify("exit", null);
    } finally {
      if (connection === this.connection) this.connection = undefined;
      connection.terminate();
      this.failPending(new TinymistTransportError("Tinymist transport stopped", "Stopped"));
    }
  }

  terminateNow(reason: Error = new TinymistTransportError("Tinymist transport terminated", "Stopped")): void {
    const connection = this.connection;
    this.connection = undefined;
    connection?.terminate();
    this.failPending(reason);
  }

  private handleMessage(message: JsonRpcMessage, generation: number): void {
    const connection = this.connection;
    if (!connection || generation !== this.currentGeneration) return;
    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message, generation, connection);
      return;
    }
    if (message.id !== undefined && message.id !== null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      pending.removeAbortListener();
      if (pending.generation !== generation) {
        pending.reject(new TinymistTransportError("Tinymist response belongs to a stale backend generation", "StaleGeneration"));
      } else if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method) {
      if (this.cancelServerRequest(message, generation)) return;
      for (const handler of this.notificationHandlers) handler(message.method, message.params, generation);
    }
  }

  private handleServerRequest(message: JsonRpcMessage, generation: number, connection: JsonRpcConnection): void {
    const id = message.id ?? null;
    if (id === null) return;
    const controller = new AbortController();
    this.pendingServerRequests.set(id, { generation, controller });
    let response: JsonRpcMessage | Promise<JsonRpcMessage>;
    try {
      response = this.serverRequestHandler(message, generation, controller.signal);
    } catch (error) {
      response = serverRequestFailure(id, error);
    }
    void Promise.resolve(response).then(
      (value) => {
        const pending = this.pendingServerRequests.get(id);
        if (!pending || pending.controller !== controller) return;
        this.pendingServerRequests.delete(id);
        if (connection === this.connection && generation === this.currentGeneration && !controller.signal.aborted) {
          connection.send(value);
        }
      },
      (error: unknown) => {
        const pending = this.pendingServerRequests.get(id);
        if (!pending || pending.controller !== controller) return;
        this.pendingServerRequests.delete(id);
        if (connection === this.connection && generation === this.currentGeneration && !controller.signal.aborted) {
          connection.send(serverRequestFailure(id, error));
        }
      }
    );
  }

  private cancelServerRequest(message: JsonRpcMessage, generation: number): boolean {
    if (message.method !== "$/cancelRequest" || typeof message.params !== "object" || message.params === null) return false;
    const id = Reflect.get(message.params, "id") as unknown;
    if (typeof id !== "number" && typeof id !== "string") return false;
    const pending = this.pendingServerRequests.get(id);
    if (!pending || pending.generation !== generation) return false;
    this.pendingServerRequests.delete(id);
    pending.controller.abort(new DOMException("Tinymist server request cancelled", "AbortError"));
    return true;
  }

  private handleConnectionFailure(error: Error, generation: number): void {
    if (generation !== this.currentGeneration || !this.connection) return;
    const connection = this.connection;
    this.connection = undefined;
    connection.terminate();
    this.failPending(error, generation);
    for (const handler of this.failureHandlers) handler(error, generation);
  }

  private failPending(error: Error, generation?: number): void {
    for (const [id, pending] of this.pending) {
      if (generation !== undefined && pending.generation !== generation) continue;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.removeAbortListener();
      pending.reject(error);
    }
    for (const [id, pending] of this.pendingServerRequests) {
      if (generation !== undefined && pending.generation !== generation) continue;
      this.pendingServerRequests.delete(id);
      pending.controller.abort(error);
    }
  }
}
function serverRequestFailure(id: JsonRpcId, error: unknown): JsonRpcMessage {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32603,
      message: error instanceof Error ? error.message : String(error)
    }
  };
}


export type TinymistWorkerFactory = (uri: string) => Worker;

export interface TinymistWorkerConnectionOptions {
  workerUri: string;
  moduleUri: string;
  wasmUri: string;
  workerFactory?: TinymistWorkerFactory;
  startupTimeoutMs?: number;
}

export class TinymistWorkerConnection implements JsonRpcConnection {
  private messageHandler: (message: JsonRpcMessage) => void = () => {};
  private failureHandler: (error: Error) => void = () => {};

  private constructor(private readonly worker: Worker) {
    worker.addEventListener("message", (event) => this.messageHandler(event.data));
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.failureHandler(new Error(event.message || "Tinymist Worker failed"));
    });
    worker.addEventListener("messageerror", () => {
      this.failureHandler(new Error("Tinymist Worker message could not be deserialized"));
    });
  }

  static async create(options: TinymistWorkerConnectionOptions): Promise<TinymistWorkerConnection> {
    const workerFactory = options.workerFactory ?? ((uri: string) => new Worker(uri));
    const worker = workerFactory(options.workerUri);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error("Tinymist Worker startup timed out")),
        options.startupTimeoutMs ?? 60_000
      );
      const onError = (event: ErrorEvent) => finish(new Error(event.message || "Tinymist Worker failed to load"));
      const onMessage = (event: MessageEvent<JsonRpcMessage>) => {
        if (event.data.method === "tinymist/workerReady") {
          const params = event.data.params;
          const record = typeof params === "object" && params !== null ? params as Record<string, unknown> : undefined;
          if (record?.protocolVersion !== 1 || record.backendVersion !== "0.15.2") {
            finish(new Error("Incompatible Tinymist Worker backend"));
          } else {
            finish();
          }
        } else if (event.data.method === "tinymist/workerFailed") {
          const params = event.data.params;
          const record = typeof params === "object" && params !== null ? params as Record<string, unknown> : undefined;
          finish(new Error(typeof record?.message === "string" ? record.message : "Tinymist Worker failed"));
        }
      };
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        if (error) {
          worker.terminate();
          reject(error);
        } else {
          resolve();
        }
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage({
        method: "tinymist/boot",
        params: { moduleUri: options.moduleUri, wasmUri: options.wasmUri }
      });
    });
    return new TinymistWorkerConnection(worker);
  }

  send(message: JsonRpcMessage): void {
    this.worker.postMessage(message);
  }

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.messageHandler = handler;
  }

  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler;
  }

  terminate(): void {
    this.worker.terminate();
  }
}
