import { serverRequestResponse, validateTinymistInitialize } from "../tinymistClient";
import { TinymistProcessClient } from "../tinymistProcessClient";
import {
  synchronizePackSources,
  type PackCacheStore,
  type PackFetchResponse
} from "../packSync";

class MemoryPackCache implements PackCacheStore {
  readonly committed = new Map<string, string>();
  readonly staged = new Map<string, string>();
  readonly etags = new Map<string, string>();

  async read(url: string): Promise<string | undefined> {
    return this.committed.get(url);
  }

  async stage(url: string, revision: number, json: string): Promise<void> {
    this.staged.set(`${url}@${revision}`, json);
  }

  async promote(url: string, revision: number): Promise<void> {
    const key = `${url}@${revision}`;
    const json = this.staged.get(key);
    if (json === undefined) throw new Error("missing staged manifest");
    this.committed.set(url, json);
    this.staged.delete(key);
  }

  async discard(url: string, revision: number): Promise<void> {
    this.staged.delete(`${url}@${revision}`);
  }

  getEtag(url: string): string | undefined {
    return this.etags.get(url);
  }

  async setEtag(url: string, etag: string | undefined): Promise<void> {
    if (etag === undefined) this.etags.delete(url);
    else this.etags.set(url, etag);
  }
}

async function testRejectedManifestPreservesCache(): Promise<void> {
  const url = "https://example.test/manifest.json";
  const valid = '{"schema":"mmt-pack.v3","pack":{"namespace":"ba"}}';
  const malformed = "{";
  const cache = new MemoryPackCache();
  cache.committed.set(url, valid);
  cache.etags.set(url, '"valid"');
  const malformedResponse: PackFetchResponse = {
    status: 200,
    ok: true,
    etag: '"malformed"',
    async text() { return malformed; }
  };
  let rejected = false;
  try {
    await synchronizePackSources(
      [url],
      1,
      cache,
      async () => { throw new Error("Rust rejected malformed manifest"); },
      async () => malformedResponse
    );
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("malformed manifest update was accepted");
  if (cache.committed.get(url) !== valid) throw new Error("malformed manifest replaced valid cache bytes");
  if (cache.etags.get(url) !== '"valid"') throw new Error("malformed manifest replaced valid ETag");
  if (cache.staged.size !== 0) throw new Error("rejected manifest left staging data");

  let offlineJson: string | undefined;
  await synchronizePackSources(
    [url],
    2,
    cache,
    async (params) => {
      offlineJson = params.sources[0]?.json;
      return { revision: params.revision, updated: true };
    },
    async () => { throw new Error("offline"); }
  );
  if (offlineJson !== valid) throw new Error("offline sync did not reuse the last valid manifest");
}

interface CompletionList {
  items: Array<{ label: string }>;
}

async function main(): Promise<void> {
  await testRejectedManifestPreservesCache();
  const command = process.env.TINYMIST_BIN;
  if (!command) throw new Error("TINYMIST_BIN is required");
  const configuration = serverRequestResponse({
    jsonrpc: "2.0",
    id: 1,
    method: "workspace/configuration",
    params: { items: [{ section: "typst" }] }
  });
  if (!Array.isArray(configuration.result) || configuration.result.length !== 1) {
    throw new Error("workspace/configuration response shape is invalid");
  }
  const unsupported = serverRequestResponse({ jsonrpc: "2.0", id: 2, method: "workspace/unknown" });
  if (unsupported.error?.code !== -32601) throw new Error("unknown server request was not rejected");
  let incompatibleRejected = false;
  try {
    validateTinymistInitialize({ serverInfo: { version: "0.15.1" }, capabilities: {} });
  } catch {
    incompatibleRejected = true;
  }
  if (!incompatibleRejected) throw new Error("incompatible Tinymist version was accepted");
  const client = await TinymistProcessClient.start(command);
  const cancelled = new AbortController();
  cancelled.abort();
  let cancellationObserved = false;
  try {
    await client.request("textDocument/hover", {}, cancelled.signal);
  } catch (error) {
    cancellationObserved = error instanceof Error && error.message.includes("cancelled");
  }
  if (!cancellationObserved) throw new Error("cancelled Tinymist request was not rejected");
  const uri = "untitled:/mmt-projection/process-test/main.typ";
  try {
    client.syncProject({
      sourceUri: "file:///workspace/process-test.mmt",
      sourceVersion: 1,
      revision: 1,
      entryUri: uri,
      full: true,
      files: [
        {
          uri,
          text: "#let greet(name) = [Hello #name]\n#greet(\"MMT\")\n#gre"
        }
      ]
    });
    const completion = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 4 }
    });
    if (!completion.items.some((item) => item.label === "greet")) {
      throw new Error("native process completion omitted greet");
    }
    const hover = await client.request<unknown>("textDocument/hover", {
      textDocument: { uri },
      position: { line: 1, character: 3 }
    });
    if (!hover) throw new Error("native process hover was empty");
    const signature = await client.request<{ signatures: Array<{ label: string }> }>(
      "textDocument/signatureHelp",
      {
        textDocument: { uri },
        position: { line: 1, character: 6 },
        context: { triggerKind: 1, isRetrigger: false }
      }
    );
    if (!signature.signatures.some((item) => item.label.includes("greet"))) {
      throw new Error("native process signature help omitted greet");
    }
    await client.restart();
    const replayed = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 4 }
    });
    if (!replayed.items.some((item) => item.label === "greet")) {
      throw new Error("native process restart did not replay the virtual project");
    }
    console.log(JSON.stringify({ completion: true, hover: true, signature: true, restarted: true }));
  } finally {
    await client.stop();
  }
}

void main();
