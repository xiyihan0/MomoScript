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
      await Promise.race([
        drain(),
        new Promise<void>((resolve) => setTimeout(resolve, deadlineMs))
      ]);
      this.#state = "disposed";
    })();
    return this.#disposePromise;
  }
}

export async function disposeWithFallback(dispose: () => Promise<void>, terminate: () => void, deadlineMs = 750): Promise<void> {
  let timedOut = false;
  let failed = false;
  await Promise.race([
    dispose().catch(() => { failed = true; }),
    new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, deadlineMs))
  ]);
  if (timedOut || failed) terminate();
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
