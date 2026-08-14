import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PACK_MANIFEST_URL,
  packManifestUrlsOrDefault,
  synchronizePackSources,
} from "../src/packSync.ts";

const MANIFEST_URL = "https://packs.example.test/ba/manifest.json";
const packageJson = JSON.parse(await readFile(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
const configuredDefault =
  packageJson.contributes.configuration.properties["mmt.resourcePacks.manifestUrls"].default;
assert.equal(DEFAULT_PACK_MANIFEST_URL, "https://mms-pack.esa.xiyihan.cn/ba_kivo/manifest.json");
assert.deepEqual(configuredDefault, [DEFAULT_PACK_MANIFEST_URL]);
assert.deepEqual(packManifestUrlsOrDefault([]), [DEFAULT_PACK_MANIFEST_URL]);
const configuredUrls = ["https://packs.example.test/custom/manifest.json"];
assert.equal(packManifestUrlsOrDefault(configuredUrls), configuredUrls);


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

// An explicit pack.base_url wins over URL derivation.
{
  const sources = await synchronizePackSources(
    [MANIFEST_URL],
    9,
    emptyCache(),
    acceptingRequest(9),
    async () => ({
      status: 200,
      ok: true,
      etag: undefined,
      text: async () => JSON.stringify({
        schema: "mmt-pack.v3",
        pack: { base_url: "https://cdn.example.test/ba/" },
      }),
    }),
  );
  assert.equal(sources[0].baseUrl, "https://cdn.example.test/ba/");
}

// An invalid pack.base_url is rejected without retrying the fetch.
{
  let attempts = 0;
  let failure;
  try {
    await synchronizePackSources(
      [MANIFEST_URL],
      10,
      emptyCache(),
      acceptingRequest(10),
      async () => {
        attempts += 1;
        return {
          status: 200,
          ok: true,
          etag: undefined,
          text: async () => JSON.stringify({
            schema: "mmt-pack.v3",
            pack: { base_url: "http://cdn.example.test/ba/" },
          }),
        };
      },
    );
  } catch (error) {
    failure = error;
  }
  assert.equal(attempts, 1);
  assert.ok(failure instanceof Error);
  assert.match(failure.message, /Invalid pack base_url/);
}

// A manifest without pack.base_url keeps URL derivation.
{
  const sources = await synchronizePackSources(
    [MANIFEST_URL],
    11,
    emptyCache(),
    acceptingRequest(11),
    async () => ({
      status: 200,
      ok: true,
      etag: undefined,
      text: async () => JSON.stringify({ schema: "mmt-pack.v3", pack: {} }),
    }),
  );
  assert.equal(sources[0].baseUrl, "https://packs.example.test/ba/");
}

console.log("pack sync retry contracts passed");
