import assert from "node:assert/strict";
import { registerPwaUpdateLifecycle } from "../src/pwaUpdate.ts";

class FakeWorker extends EventTarget {
  state = "installed";
  messages = [];
  postMessage(message) { this.messages.push(message); }
}
class FakeRegistration extends EventTarget {
  constructor(worker) {
    super();
    this.waiting = worker;
    this.installing = null;
  }
  update() { return Promise.resolve(); }
}
class FakeServiceWorkerContainer extends EventTarget {
  controller = {};
  constructor(registration) {
    super();
    this.registration = registration;
  }
  register() { return Promise.resolve(this.registration); }
}

const originalNavigator = globalThis.navigator;
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const installEnvironment = (registration) => {
  const serviceWorker = new FakeServiceWorkerContainer(registration);
  Object.defineProperty(globalThis, "navigator", {
    value: { serviceWorker }, configurable: true
  });
  Object.defineProperty(globalThis, "window", {
    value: new EventTarget(), configurable: true
  });
  globalThis.window.setTimeout = setTimeout;
  globalThis.window.clearTimeout = clearTimeout;
  globalThis.window.location = { reload() {} };
  const documentTarget = new EventTarget();
  documentTarget.visibilityState = "visible";
  Object.defineProperty(globalThis, "document", {
    value: documentTarget, configurable: true
  });
  return serviceWorker;
};

try {
  {
    const worker = new FakeWorker();
    const serviceWorker = installEnvironment(new FakeRegistration(worker));
    let prepared = 0;
    const lifecycle = registerPwaUpdateLifecycle({
      prepareForReload: async () => { prepared += 1; },
      promptForReload: async () => false,
      report() {},
    });
    await flush();
    await flush();
    assert.equal(prepared, 0, "declined updates must not quiesce the editor");
    assert.deepEqual(worker.messages, [], "declined updates must remain waiting");
    lifecycle.dispose();
    assert.equal(serviceWorker.listenerCount, undefined);
  }

  {
    const worker = new FakeWorker();
    const registration = new FakeRegistration(worker);
    const serviceWorker = installEnvironment(registration);
    const prepared = Promise.withResolvers();
    let prepareCalls = 0;
    let reloads = 0;
    const lifecycle = registerPwaUpdateLifecycle({
      prepareForReload: async () => {
        prepareCalls += 1;
        await prepared.promise;
      },
      promptForReload: async () => true,
      reload: () => { reloads += 1; },
      report(message, error) { if (error) throw error; assert.ok(message); },
    });
    await flush();
    assert.equal(prepareCalls, 1);
    assert.deepEqual(worker.messages, [], "waiting worker activated before durable quiescence");
    prepared.resolve();
    await flush();
    assert.deepEqual(worker.messages, [{ type: "SKIP_WAITING" }]);
    serviceWorker.dispatchEvent(new Event("controllerchange"));
    assert.equal(reloads, 1, "accepted update did not reload after controller activation");
    lifecycle.dispose();
  }

  {
    const worker = new FakeWorker();
    installEnvironment(new FakeRegistration(worker));
    const reports = [];
    const lifecycle = registerPwaUpdateLifecycle({
      prepareForReload: async () => {},
      promptForReload: async () => { throw new Error("prompt unavailable"); },
      report(message, error) { reports.push({ message, error }); },
    });
    await flush();
    await flush();
    assert.equal(reports.length, 1, "prompt rejection was not contained and reported");
    assert.match(String(reports[0].error), /prompt unavailable/);
    lifecycle.dispose();
  }
} finally {
  Object.defineProperty(globalThis, "navigator", { value: originalNavigator, configurable: true });
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
  Object.defineProperty(globalThis, "document", { value: originalDocument, configurable: true });
}

console.log(JSON.stringify({ declinedUpdateWaits: true, safeActivationOrdering: true, controllerReload: true, promptFailureContained: true }));
