import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  entityCatalogUrlForManifest,
  galleryCatalogManifestBinding,
  loadGalleryEntityCatalog,
  parseGalleryEntityCatalog,
} from "../src/galleryEntityCatalog.ts";

const manifestJson = await readFile(
  fileURLToPath(new URL("../e2e/fixtures/manifest.json", import.meta.url)),
  "utf8",
);
const catalogJson = await readFile(
  fileURLToPath(new URL("../e2e/fixtures/entity-catalog.json", import.meta.url)),
  "utf8",
);
const manifestUrl = "https://packs.example.test/ba/manifest.json";
const source = {
  manifestUrl,
  baseUrl: "https://packs.example.test/ba/",
  json: manifestJson,
};
const binding = await galleryCatalogManifestBinding(source);
const fixture = JSON.parse(catalogJson);

assert.equal(binding.manifestSha256, createHash("sha256").update(manifestJson).digest("hex"));
assert.equal(fixture.pack.manifest_sha256, binding.manifestSha256);
assert.equal(entityCatalogUrlForManifest(manifestUrl), "https://packs.example.test/ba/entity-catalog.json");
assert.equal(
  entityCatalogUrlForManifest("https://packs.example.test/ba/releases/abc/manifest.json"),
  "https://packs.example.test/ba/releases/abc/entity-catalog.json",
);
assert.throws(() => entityCatalogUrlForManifest("http://packs.example.test/ba/manifest.json"), /HTTPS/);

const catalog = parseGalleryEntityCatalog(catalogJson, binding);
const kayoko = catalog.entities.get("佳代子");
const campHare = catalog.entities.get("晴_露营");
assert.equal(catalog.namespace, "ba");
assert.equal(kayoko?.zhCnDisplayName, "鬼方佳代子");
assert.equal(campHare?.zhCnDisplayName, undefined);
assert.ok(kayoko?.localizedNames.includes("Kayoko Onikata"));
assert.ok(kayoko?.aliases.includes("黑猫"));
assert.deepEqual(kayoko?.alternateSkinKeys, ["晴_露营"]);
assert.equal(kayoko?.schoolId, "1");
assert.equal(kayoko?.mainRelationId, "10");
assert.equal(catalog.schools.get("1")?.displayName, "格黑娜学园");
const mika = catalog.entities.get("透明测试");
assert.equal(mika?.zhCnDisplayName, "未花");
assert.ok(mika?.localizedNames.includes("Mika Misono"));
assert.ok(mika?.aliases.includes("Mika"));

function rejected(mutator, pattern) {
  const candidate = structuredClone(fixture);
  mutator(candidate);
  assert.throws(() => parseGalleryEntityCatalog(JSON.stringify(candidate), binding), pattern);
}

rejected((value) => { value.unknown = true; }, /unknown property unknown/);
rejected((value) => { delete value.source.license; }, /missing required property license/);
rejected((value) => { value.entities["佳代子"].names.display["zh_CN"] = "bad"; }, /invalid locale zh_CN/);
rejected((value) => {
  value.taxonomies.schools.bad = value.taxonomies.schools["1"];
}, /positive integer string/);
rejected((value) => {
  value.entities["佳代子"].names.aliases["zh-CN"] = ["重复", "重复"];
}, /unique values/);
rejected((value) => {
  value.entities["佳代子"].related_entities[0].kind = "same_character";
}, /alternate_skin/);
rejected((value) => {
  value.entities["佳代子"].related_entities[0].entity = "ba::不存在";
}, /unknown manifest entity/);
rejected((value) => { value.entities["佳代子"].affiliation.school = "999"; }, /unknown taxonomy/);
rejected((value) => { value.pack.namespace = "other"; }, /does not match/);
rejected((value) => { value.pack.version = "2.0.0"; }, /does not match/);
rejected((value) => { value.pack.manifest_sha256 = "0".repeat(64); }, /SHA-256 mismatch/);

function memoryCache(initial) {
  const active = new Map(initial);
  const staging = new Map();
  const etags = new Map();
  const operations = [];
  return {
    active,
    operations,
    async read(url) { return active.get(url); },
    async stage(url, revision, json) {
      operations.push(["stage", url, revision]);
      staging.set(`${url}:${revision}`, json);
    },
    async promote(url, revision) {
      operations.push(["promote", url, revision]);
      const key = `${url}:${revision}`;
      assert.ok(staging.has(key));
      active.set(url, staging.get(key));
      staging.delete(key);
    },
    async discard(url, revision) {
      operations.push(["discard", url, revision]);
      staging.delete(`${url}:${revision}`);
    },
    getEtag(url) { return etags.get(url); },
    async setEtag(url, etag) {
      operations.push(["etag", url, etag]);
      if (etag === undefined) etags.delete(url);
      else etags.set(url, etag);
    },
  };
}

const catalogUrl = entityCatalogUrlForManifest(manifestUrl);
{
  const cache = memoryCache();
  let attempts = 0;
  const result = await loadGalleryEntityCatalog(source, 1, cache, async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError("network down");
    return jsonResponse(200, catalogJson, '"catalog-v1"');
  });
  assert.equal(attempts, 3);
  assert.equal(result.catalog?.namespace, "ba");
  assert.equal(result.warning, undefined);
  assert.equal(cache.active.get(catalogUrl), catalogJson);
  assert.deepEqual(cache.operations.map(([operation]) => operation), ["stage", "promote", "etag"]);
}

{
  const cache = memoryCache([[catalogUrl, catalogJson]]);
  const result = await loadGalleryEntityCatalog(source, 2, cache, async () => ({
    status: 304,
    ok: false,
    etag: '"catalog-v1"',
    contentType: undefined,
    text: async () => "",
  }));
  assert.equal(result.catalog?.entities.get("佳代子")?.zhCnDisplayName, "鬼方佳代子");
}

{
  const cache = memoryCache([[catalogUrl, catalogJson]]);
  const invalid = JSON.stringify({ ...fixture, unknown: true });
  const result = await loadGalleryEntityCatalog(source, 3, cache, async () => jsonResponse(200, invalid, '"bad"'));
  assert.ok(result.catalog);
  assert.match(result.warning ?? "", /unknown property unknown/);
  assert.equal(cache.active.get(catalogUrl), catalogJson);
  assert.equal(cache.operations.length, 0);
}

{
  const staleSource = { ...source, json: `${manifestJson}\n` };
  const cache = memoryCache([[catalogUrl, catalogJson]]);
  const result = await loadGalleryEntityCatalog(staleSource, 4, cache, async () => jsonResponse(404, "", undefined));
  assert.equal(result.catalog, undefined);
  assert.match(result.warning ?? "", /cached Entity Catalog rejected.*SHA-256 mismatch/);
}

{
  const cache = memoryCache();
  const result = await loadGalleryEntityCatalog(source, 5, cache, async () => ({
    ...jsonResponse(200, catalogJson, undefined),
    contentType: "text/html",
  }));
  assert.equal(result.catalog, undefined);
  assert.match(result.warning ?? "", /unexpected Content-Type text\/html/);
}

function jsonResponse(status, text, etag) {
  return {
    status,
    ok: status >= 200 && status < 300,
    etag,
    contentType: "application/json; charset=utf-8",
    text: async () => text,
  };
}

console.log("gallery Entity Catalog contracts passed");
