import type { PackCacheStore, PackManifestSource } from "../../vscode/src/packSync";

const CATALOG_SCHEMA = "mmt-pack-entity-catalog.v1";
const FETCH_ATTEMPTS = 3;
const LOCALE_KEY = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const TAXONOMY_KEY = /^[1-9][0-9]*$/;
const EXTERNAL_ID_KEY = /^[a-z][a-z0-9_-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface GalleryCatalogTaxonomyTerm {
  readonly id: string;
  readonly displayName: string;
  readonly aliases: readonly string[];
}

export interface GalleryCatalogEntity {
  readonly key: string;
  readonly zhCnDisplayName?: string;
  readonly localizedNames: readonly string[];
  readonly aliases: readonly string[];
  readonly schoolId?: string;
  readonly mainRelationId?: string;
  readonly relationIds: readonly string[];
  readonly alternateSkinKeys: readonly string[];
}

export interface GalleryCatalogProvenance {
  readonly generatedAt: string;
  readonly sourceName: string;
  readonly sourceUrl?: string;
  readonly retrievedAt: string;
  readonly licenseId: string;
  readonly licenseUrl?: string;
  readonly termsUrl?: string;
  readonly attribution: string;
}

export interface GalleryEntityCatalog {
  readonly namespace: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly entities: ReadonlyMap<string, GalleryCatalogEntity>;
  readonly schools: ReadonlyMap<string, GalleryCatalogTaxonomyTerm>;
  readonly relations: ReadonlyMap<string, GalleryCatalogTaxonomyTerm>;
  readonly provenance: GalleryCatalogProvenance;
}

export interface GalleryCatalogManifestBinding {
  readonly namespace: string;
  readonly version: string;
  readonly manifestSha256: string;
  readonly entityKeys: ReadonlySet<string>;
}

export interface GalleryCatalogFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly etag: string | undefined;
  readonly contentType: string | undefined;
  text(): Promise<string>;
}

export type GalleryCatalogFetcher = (
  url: string,
  etag: string | undefined
) => Promise<GalleryCatalogFetchResponse>;

export interface GalleryCatalogLoadResult {
  readonly catalogUrl?: string;
  readonly catalog?: GalleryEntityCatalog;
  readonly warning?: string;
}

export function entityCatalogUrlForManifest(manifestUrl: string): string {
  const manifest = new URL(manifestUrl);
  if (manifest.protocol !== "https:") throw new Error("Pack manifest must use HTTPS");
  const catalog = new URL("entity-catalog.json", manifest);
  if (catalog.protocol !== "https:" || catalog.origin !== manifest.origin) {
    throw new Error("Entity Catalog must share the manifest HTTPS origin");
  }
  return catalog.href;
}

export async function galleryCatalogManifestBinding(
  source: PackManifestSource
): Promise<GalleryCatalogManifestBinding> {
  const manifest = parseJsonObject(source.json, "pack manifest");
  const pack = requiredObject(manifest.pack, "pack manifest.pack");
  const namespace = requiredString(pack.namespace, "pack manifest.pack.namespace");
  const version = requiredString(pack.version, "pack manifest.pack.version");
  const entities = requiredObject(manifest.entities, "pack manifest.entities");
  return Object.freeze({
    namespace,
    version,
    manifestSha256: await sha256Hex(new TextEncoder().encode(source.json)),
    entityKeys: new Set(Object.keys(entities))
  });
}

export function parseGalleryEntityCatalog(
  json: string,
  binding: GalleryCatalogManifestBinding
): GalleryEntityCatalog {
  const root = parseJsonObject(json, "Entity Catalog");
  assertKeys(root, ["schema", "generated_at", "pack", "source", "entities", "taxonomies"], [], "Entity Catalog");
  if (root.schema !== CATALOG_SCHEMA) throw new Error(`Entity Catalog schema must be ${CATALOG_SCHEMA}`);
  const generatedAt = requiredDateTime(root.generated_at, "Entity Catalog.generated_at");

  const pack = requiredObject(root.pack, "Entity Catalog.pack");
  assertKeys(pack, ["namespace", "version", "manifest_sha256"], [], "Entity Catalog.pack");
  const namespace = requiredString(pack.namespace, "Entity Catalog.pack.namespace");
  const version = requiredString(pack.version, "Entity Catalog.pack.version");
  const manifestSha256 = requiredString(pack.manifest_sha256, "Entity Catalog.pack.manifest_sha256");
  if (!SHA256.test(manifestSha256)) throw new Error("Entity Catalog.pack.manifest_sha256 must be lowercase SHA-256");
  if (namespace !== binding.namespace) throw new Error(`Entity Catalog namespace ${namespace} does not match ${binding.namespace}`);
  if (version !== binding.version) throw new Error(`Entity Catalog version ${version} does not match ${binding.version}`);
  if (manifestSha256 !== binding.manifestSha256) throw new Error("Entity Catalog manifest SHA-256 mismatch");

  const source = parseSource(root.source);
  const taxonomies = requiredObject(root.taxonomies, "Entity Catalog.taxonomies");
  assertKeys(taxonomies, ["schools", "relations"], [], "Entity Catalog.taxonomies");
  const schools = parseTaxonomy(taxonomies.schools, "Entity Catalog.taxonomies.schools");
  const relations = parseTaxonomy(taxonomies.relations, "Entity Catalog.taxonomies.relations");
  const entities = parseEntities(root.entities, binding, schools, relations);

  return Object.freeze({
    namespace,
    version,
    manifestSha256,
    entities,
    schools,
    relations,
    provenance: Object.freeze({ generatedAt, ...source })
  });
}

export async function loadGalleryEntityCatalog(
  source: PackManifestSource,
  revision: number,
  cache: PackCacheStore,
  fetchCatalog: GalleryCatalogFetcher
): Promise<GalleryCatalogLoadResult> {
  let catalogUrl: string | undefined;
  try {
    catalogUrl = entityCatalogUrlForManifest(source.manifestUrl);
    const binding = await galleryCatalogManifestBinding(source);
    const etag = cache.getEtag(catalogUrl);
    try {
      const response = await fetchWithRetry(catalogUrl, etag, fetchCatalog);
      if (response.status === 304) {
        return await cachedCatalog(catalogUrl, binding, cache, "HTTP 304 without a valid cached Entity Catalog");
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!isJsonContentType(response.contentType)) {
        throw new Error(`unexpected Content-Type ${response.contentType ?? "<missing>"}`);
      }
      const json = await response.text();
      const catalog = parseGalleryEntityCatalog(json, binding);
      let staged = false;
      try {
        await cache.stage(catalogUrl, revision, json);
        staged = true;
        await cache.promote(catalogUrl, revision);
        staged = false;
        await cache.setEtag(catalogUrl, response.etag);
        return { catalogUrl, catalog };
      } catch (error) {
        if (staged) await cache.discard(catalogUrl, revision);
        return {
          catalogUrl,
          catalog,
          warning: `Entity Catalog loaded but cache promotion failed: ${errorMessage(error)}`
        };
      }
    } catch (error) {
      return await cachedCatalog(catalogUrl, binding, cache, errorMessage(error));
    }
  } catch (error) {
    return { catalogUrl, warning: errorMessage(error) };
  }
}

async function fetchWithRetry(
  url: string,
  etag: string | undefined,
  fetchCatalog: GalleryCatalogFetcher
): Promise<GalleryCatalogFetchResponse> {
  let lastError: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetchCatalog(url, etag);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function cachedCatalog(
  catalogUrl: string,
  binding: GalleryCatalogManifestBinding,
  cache: PackCacheStore,
  failure: string
): Promise<GalleryCatalogLoadResult> {
  try {
    const cached = await cache.read(catalogUrl);
    if (cached === undefined) return { catalogUrl, warning: failure };
    return {
      catalogUrl,
      catalog: parseGalleryEntityCatalog(cached, binding),
      warning: failure
    };
  } catch (error) {
    return {
      catalogUrl,
      warning: `${failure}; cached Entity Catalog rejected: ${errorMessage(error)}`
    };
  }
}

function parseSource(value: unknown): Omit<GalleryCatalogProvenance, "generatedAt"> {
  const source = requiredObject(value, "Entity Catalog.source");
  assertKeys(
    source,
    ["id", "name", "url", "retrieved_at", "transformed", "license"],
    ["api_versions", "api_time_range"],
    "Entity Catalog.source"
  );
  requiredString(source.id, "Entity Catalog.source.id");
  const sourceName = requiredString(source.name, "Entity Catalog.source.name");
  const sourceUri = requiredUri(source.url, "Entity Catalog.source.url");
  const retrievedAt = requiredDateTime(source.retrieved_at, "Entity Catalog.source.retrieved_at");
  if (source.transformed !== true) throw new Error("Entity Catalog.source.transformed must be true");
  if (source.api_versions !== undefined) {
    uniqueStringArray(source.api_versions, "Entity Catalog.source.api_versions", false);
  }
  if (source.api_time_range !== undefined) {
    const range = requiredObject(source.api_time_range, "Entity Catalog.source.api_time_range");
    assertKeys(range, ["first", "last"], [], "Entity Catalog.source.api_time_range");
    requiredNonNegativeInteger(range.first, "Entity Catalog.source.api_time_range.first");
    requiredNonNegativeInteger(range.last, "Entity Catalog.source.api_time_range.last");
  }

  const license = requiredObject(source.license, "Entity Catalog.source.license");
  assertKeys(license, ["id", "url", "terms_url", "attribution"], [], "Entity Catalog.source.license");
  const licenseId = requiredString(license.id, "Entity Catalog.source.license.id");
  const licenseUri = requiredUri(license.url, "Entity Catalog.source.license.url");
  const termsUri = requiredUri(license.terms_url, "Entity Catalog.source.license.terms_url");
  const attribution = requiredString(license.attribution, "Entity Catalog.source.license.attribution");
  return Object.freeze({
    sourceName,
    sourceUrl: httpsHref(sourceUri),
    retrievedAt,
    licenseId,
    licenseUrl: httpsHref(licenseUri),
    termsUrl: httpsHref(termsUri),
    attribution
  });
}

function parseTaxonomy(value: unknown, label: string): ReadonlyMap<string, GalleryCatalogTaxonomyTerm> {
  const record = requiredObject(value, label);
  const output = new Map<string, GalleryCatalogTaxonomyTerm>();
  for (const [id, candidate] of Object.entries(record)) {
    if (!TAXONOMY_KEY.test(id)) throw new Error(`${label} key ${id} must be a positive integer string`);
    const term = requiredObject(candidate, `${label}.${id}`);
    assertKeys(term, ["display_name", "aliases"], [], `${label}.${id}`);
    output.set(id, Object.freeze({
      id,
      displayName: requiredString(term.display_name, `${label}.${id}.display_name`),
      aliases: uniqueStringArray(term.aliases, `${label}.${id}.aliases`, false)
    }));
  }
  return output;
}

function parseEntities(
  value: unknown,
  binding: GalleryCatalogManifestBinding,
  schools: ReadonlyMap<string, GalleryCatalogTaxonomyTerm>,
  relations: ReadonlyMap<string, GalleryCatalogTaxonomyTerm>
): ReadonlyMap<string, GalleryCatalogEntity> {
  const record = requiredObject(value, "Entity Catalog.entities");
  const output = new Map<string, GalleryCatalogEntity>();
  for (const [key, candidate] of Object.entries(record)) {
    if (!binding.entityKeys.has(key)) throw new Error(`Entity Catalog entity ${key} is absent from the manifest`);
    const entity = requiredObject(candidate, `Entity Catalog.entities.${key}`);
    assertKeys(entity, ["external_ids", "names", "affiliation", "related_entities"], [], `Entity Catalog.entities.${key}`);
    parseExternalIds(entity.external_ids, key);
    const names = parseNames(entity.names, key);
    const affiliation = parseAffiliation(entity.affiliation, key, schools, relations);
    const alternateSkinKeys = parseRelatedEntities(entity.related_entities, key, binding);
    output.set(key, Object.freeze({
      key,
      zhCnDisplayName: names.display.get("zh-CN"),
      localizedNames: names.localizedNames,
      aliases: names.aliases,
      ...affiliation,
      alternateSkinKeys
    }));
  }
  return output;
}

function parseExternalIds(value: unknown, entityKey: string): void {
  const record = requiredObject(value, `Entity Catalog.entities.${entityKey}.external_ids`);
  for (const [key, candidate] of Object.entries(record)) {
    if (!EXTERNAL_ID_KEY.test(key)) throw new Error(`Invalid external id key ${key}`);
    requiredString(candidate, `Entity Catalog.entities.${entityKey}.external_ids.${key}`);
  }
}

function parseNames(value: unknown, entityKey: string): {
  readonly display: ReadonlyMap<string, string>;
  readonly localizedNames: readonly string[];
  readonly aliases: readonly string[];
} {
  const label = `Entity Catalog.entities.${entityKey}.names`;
  const names = requiredObject(value, label);
  assertKeys(names, ["display", "family", "given", "skin", "aliases"], [], label);
  const display = localeStrings(names.display, `${label}.display`);
  const family = localeStrings(names.family, `${label}.family`);
  const given = localeStrings(names.given, `${label}.given`);
  const skin = localeStrings(names.skin, `${label}.skin`);
  const aliases = localeStringLists(names.aliases, `${label}.aliases`);
  return {
    display,
    localizedNames: uniqueStrings([...display.values(), ...family.values(), ...given.values(), ...skin.values()]),
    aliases: uniqueStrings([...aliases.values()].flat())
  };
}

function parseAffiliation(
  value: unknown,
  entityKey: string,
  schools: ReadonlyMap<string, GalleryCatalogTaxonomyTerm>,
  relations: ReadonlyMap<string, GalleryCatalogTaxonomyTerm>
): Pick<GalleryCatalogEntity, "schoolId" | "mainRelationId" | "relationIds"> {
  const label = `Entity Catalog.entities.${entityKey}.affiliation`;
  const affiliation = requiredObject(value, label);
  assertKeys(affiliation, ["relations"], ["school", "main_relation"], label);
  const schoolId = optionalString(affiliation.school, `${label}.school`);
  const mainRelationId = optionalString(affiliation.main_relation, `${label}.main_relation`);
  const relationIds = uniqueStringArray(affiliation.relations, `${label}.relations`, false);
  if (schoolId !== undefined && !schools.has(schoolId)) throw new Error(`${label}.school references unknown taxonomy ${schoolId}`);
  if (mainRelationId !== undefined && !relations.has(mainRelationId)) {
    throw new Error(`${label}.main_relation references unknown taxonomy ${mainRelationId}`);
  }
  for (const relationId of relationIds) {
    if (!relations.has(relationId)) throw new Error(`${label}.relations references unknown taxonomy ${relationId}`);
  }
  return { schoolId, mainRelationId, relationIds };
}

function parseRelatedEntities(
  value: unknown,
  entityKey: string,
  binding: GalleryCatalogManifestBinding
): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`Entity Catalog.entities.${entityKey}.related_entities must be an array`);
  const keys: string[] = [];
  for (const [index, candidate] of value.entries()) {
    const label = `Entity Catalog.entities.${entityKey}.related_entities[${index}]`;
    const related = requiredObject(candidate, label);
    assertKeys(related, ["kind", "entity"], [], label);
    if (related.kind !== "alternate_skin") throw new Error(`${label}.kind must be alternate_skin`);
    const qualified = requiredString(related.entity, `${label}.entity`);
    const prefix = `${binding.namespace}::`;
    if (!qualified.startsWith(prefix)) throw new Error(`${label}.entity must use namespace ${binding.namespace}`);
    const localKey = qualified.slice(prefix.length);
    if (!binding.entityKeys.has(localKey)) throw new Error(`${label}.entity references unknown manifest entity ${localKey}`);
    keys.push(localKey);
  }
  return uniqueStrings(keys);
}

function localeStrings(value: unknown, label: string): ReadonlyMap<string, string> {
  const record = requiredObject(value, label);
  const output = new Map<string, string>();
  for (const [locale, candidate] of Object.entries(record)) {
    if (!LOCALE_KEY.test(locale)) throw new Error(`${label} has invalid locale ${locale}`);
    output.set(locale, requiredString(candidate, `${label}.${locale}`));
  }
  return output;
}

function localeStringLists(value: unknown, label: string): ReadonlyMap<string, readonly string[]> {
  const record = requiredObject(value, label);
  const output = new Map<string, readonly string[]>();
  for (const [locale, candidate] of Object.entries(record)) {
    if (!LOCALE_KEY.test(locale)) throw new Error(`${label} has invalid locale ${locale}`);
    output.set(locale, uniqueStringArray(candidate, `${label}.${locale}`, false));
  }
  return output;
}

function parseJsonObject(json: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
  return requiredObject(parsed, label);
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown property ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(record, key)) throw new Error(`${label} is missing required property ${key}`);
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label);
}

function uniqueStringArray(value: unknown, label: string, requireNonEmpty: boolean): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const output = value.map((candidate, index) => requiredString(candidate, `${label}[${index}]`));
  if (requireNonEmpty && output.length === 0) throw new Error(`${label} must not be empty`);
  if (new Set(output).size !== output.length) throw new Error(`${label} must contain unique values`);
  return Object.freeze(output);
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)]);
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function requiredDateTime(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || Number.isNaN(Date.parse(text))) {
    throw new Error(`${label} must be an RFC 3339 date-time`);
  }
  return text;
}

function requiredUri(value: unknown, label: string): URL {
  const text = requiredString(value, label);
  try {
    return new URL(text);
  } catch {
    throw new Error(`${label} must be an absolute URI`);
  }
}

function httpsHref(url: URL): string | undefined {
  return url.protocol === "https:" ? url.href : undefined;
}

function isJsonContentType(value: string | undefined): boolean {
  if (value === undefined) return false;
  return value.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const source = Uint8Array.from(bytes).buffer;
  const digest = await crypto.subtle.digest("SHA-256", source);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
