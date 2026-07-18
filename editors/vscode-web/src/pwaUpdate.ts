export interface PwaUpdateLifecycleOptions {
  readonly serviceWorkerUrl?: string;
  readonly prepareForReload: () => Promise<void>;
  readonly promptForReload: () => Promise<boolean>;
  readonly reload?: () => void;
  readonly report: (message: string, error?: unknown) => void;
}

/**
 * Owns registration and explicit activation for the production service worker.
 * A waiting worker never activates over live editor state until the user accepts
 * and the durable safe-restart boundary has completed.
 */
export function registerPwaUpdateLifecycle(
  options: PwaUpdateLifecycleOptions
): { dispose(): void } {
  if (!("serviceWorker" in navigator)) return { dispose() {} };

  let disposed = false;
  let registration: ServiceWorkerRegistration | undefined;
  let installing: ServiceWorker | undefined;
  let activating = false;
  let activationTimer: number | undefined;
  const prompted = new WeakSet<ServiceWorker>();

  const reportFailure = (message: string, error: unknown) => {
    if (!disposed) options.report(message, error);
  };
  const activate = async (worker: ServiceWorker) => {
    if (disposed || activating || worker.state !== "installed") return;
    prompted.add(worker);
    try {
      if (!(await options.promptForReload()) || disposed) return;
      activating = true;
      await options.prepareForReload();
      if (disposed) return;
      const waiting = registration?.waiting;
      if (!waiting || waiting !== worker) {
        throw new Error("The prepared service worker update is no longer waiting");
      }
      waiting.postMessage({ type: "SKIP_WAITING" });
      activationTimer = window.setTimeout(() => {
        activationTimer = undefined;
        if (disposed || !activating) return;
        options.report("Service worker activation timed out; reloading the safely quiesced editor");
        (options.reload ?? (() => window.location.reload()))();
      }, 15_000);
    } catch (error) {
      activating = false;
      if (activationTimer !== undefined) window.clearTimeout(activationTimer);
      activationTimer = undefined;
      prompted.delete(worker);
      reportFailure("MomoScript update could not reach a safe reload boundary", error);
    }
  };
  const offer = (worker: ServiceWorker | null | undefined) => {
    if (!worker || !navigator.serviceWorker.controller || prompted.has(worker)) return;
    if (worker.state === "installed") void activate(worker);
  };
  const onInstallingStateChange = () => offer(installing);
  const bindInstalling = (worker: ServiceWorker | null | undefined) => {
    if (!worker || worker === installing) return;
    installing?.removeEventListener("statechange", onInstallingStateChange);
    installing = worker;
    installing.addEventListener("statechange", onInstallingStateChange);
    offer(installing);
  };
  const onUpdateFound = () => bindInstalling(registration?.installing);
  const onControllerChange = () => {
    if (!activating || disposed) return;
    activating = false;
    if (activationTimer !== undefined) window.clearTimeout(activationTimer);
    activationTimer = undefined;
    (options.reload ?? (() => window.location.reload()))();
  };
  const checkForUpdate = () => {
    if (!disposed) void registration?.update().catch((error: unknown) => {
      reportFailure("MomoScript update check failed", error);
    });
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") checkForUpdate();
  };

  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  window.addEventListener("online", checkForUpdate);
  document.addEventListener("visibilitychange", onVisibilityChange);
  void navigator.serviceWorker.register(options.serviceWorkerUrl ?? "/sw.js", { scope: "/" }).then((value) => {
    if (disposed) return;
    registration = value;
    registration.addEventListener("updatefound", onUpdateFound);
    bindInstalling(registration.installing);
    offer(registration.waiting);
  }).catch((error: unknown) => {
    reportFailure("MomoScript offline support could not be installed", error);
  });

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      installing?.removeEventListener("statechange", onInstallingStateChange);
      registration?.removeEventListener("updatefound", onUpdateFound);
      if (activationTimer !== undefined) window.clearTimeout(activationTimer);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("online", checkForUpdate);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}
