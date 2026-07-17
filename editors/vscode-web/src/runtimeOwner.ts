export interface RuntimeOwnedResource { dispose(): void | Promise<void> }

export class RuntimeOwner {
  #resources: RuntimeOwnedResource[] = [];
  #state: "starting" | "ready" | "quiescing" | "disposed" = "starting";
  #disposePromise: Promise<void> | undefined;

  get state(): "starting" | "ready" | "quiescing" | "disposed" { return this.#state; }
  add<T extends RuntimeOwnedResource>(resource: T): T {
    if (this.#state === "quiescing" || this.#state === "disposed") throw new Error(`Cannot own a resource while runtime is ${this.#state}`);
    this.#resources.push(resource);
    return resource;
  }
  ready(): void {
    if (this.#state !== "starting") throw new Error(`Invalid runtime transition: ${this.#state} -> ready`);
    this.#state = "ready";
  }
  async quiesce(): Promise<void> {
    if (this.#state === "disposed") return;
    if (this.#state === "starting") throw new Error("Cannot quiesce a runtime that has not started");
    this.#state = "quiescing";
  }
  dispose(deadlineMs = 1_000): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = (async () => {
      this.#state = "quiescing";
      const resources = this.#resources.splice(0).reverse();
      const drain = async () => {
        for (const resource of resources) {
          try { await resource.dispose(); } catch { /* continue rollback */ }
        }
      };
      if (deadlineMs === Number.POSITIVE_INFINITY) {
        await drain();
      } else {
        await Promise.race([
          drain(),
          new Promise<void>((resolve) => setTimeout(resolve, deadlineMs))
        ]);
      }
      this.#state = "disposed";
    })();
    return this.#disposePromise;
  }
}
export interface RuntimeEventTarget {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean): void;
}

export function ownEventListener(
  target: RuntimeEventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: AddEventListenerOptions | boolean
): RuntimeOwnedResource {
  target.addEventListener(type, listener, options);
  return {
    dispose: () => target.removeEventListener(type, listener, options)
  };
}

export async function disposeWithFallback(
  dispose: () => Promise<void>,
  terminate: () => void,
  deadlineMs = 750
): Promise<"graceful" | "terminated"> {
  let timer: number | NodeJS.Timeout | undefined;
  let timedOut = false;
  let failed = false;
  await Promise.race([
    dispose().catch(() => { failed = true; }),
    new Promise<void>((resolve) => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, deadlineMs);
    })
  ]);
  clearTimeout(timer);
  if (timedOut || failed) {
    terminate();
    return "terminated";
  }
  return "graceful";
}

export function terminateOnUnload(worker: { terminate(): void }, dispose: () => Promise<void>): () => void {
  let invoked = false;
  return () => {
    if (invoked) return;
    invoked = true;
    void dispose().catch(() => {});
    worker.terminate();
  };
}
