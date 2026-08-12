import assert from "node:assert/strict";
import { synchronizePackSources } from "../src/packSync.ts";

const MANIFEST_URL = "https://packs.example.test/ba/manifest.json";

function emptyCache() {
  return {
    read: async () => undefined,
    stage: async () => {},
    promote: async () => {},
    discard: async () => {},
    getEtag: () => undefined,
    setEtag: async () => {},
  };
}

function acceptingRequest(revision) {
  return async (params) => {
    assert.equal(params.revision, revision);
    return { revision: params.revision, updated: true };
  };
}

// Transient fetch failures are retried before giving up.
{
  let attempts = 0;
  const sources = await synchronizePackSources(
    [MANIFEST_URL],
    7,
    emptyCache(),
    acceptingRequest(7),
    async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("Failed to fetch");
      return { status: 200, ok: true, etag: undefined, text: async () => "{}" };
    },
  );
  assert.equal(attempts, 3);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].json, "{}");
}

// Persistent failures still fall back to the cache, then fail with the
// original diagnostic when no cached manifest exists.
{
  let attempts = 0;
  let failure;
  try {
    await synchronizePackSources(
      [MANIFEST_URL],
      8,
      emptyCache(),
      acceptingRequest(8),
      async () => {
        attempts += 1;
        throw new TypeError("Failed to fetch");
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(attempts, 3);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /Unable to load pack manifest/);
  assert.match(failure.message, /Failed to fetch/);
}

console.log("pack sync retry contracts passed");
