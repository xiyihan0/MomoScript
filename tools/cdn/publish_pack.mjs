import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_BUCKET,
  DEFAULT_ORIGIN,
  DEFAULT_REGION,
  sha256,
} from "./ossutil-helper.mjs";
import { publishPackObjects } from "./publish-pack-objects.mjs";

const IMMUTABLE = "public,max-age=31536000,immutable";
const MUST_REVALIDATE = "public,max-age=0,must-revalidate";

const CONTENT_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avifs": "application/octet-stream",
  ".json": "application/json",
};

function byExtension(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function fail(message) {
  throw new Error(message);
}

const options = parseArguments(process.argv.slice(2));
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const packDir = path.resolve(options.packDir);
const catalogPath = path.resolve(
  options.catalog ?? path.join(repoRoot, "typst_sandbox/pack-v3/catalog.json"),
);

const manifestBytes = new Uint8Array(readFileSync(path.join(packDir, "manifest.json")));
const manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
if (manifest.schema !== "mmt-pack.v3") fail(`manifest schema ${manifest.schema} is not mmt-pack.v3`);
const pack = manifest.pack ?? {};
const baseUrl = pack.base_url;
if (typeof baseUrl !== "string" || !baseUrl.startsWith("https://") || !baseUrl.endsWith("/")) {
  fail('manifest.pack.base_url must be an HTTPS URL ending in "/"');
}
const parsedBase = new URL(baseUrl);
if (parsedBase.origin !== options.origin) {
  fail(`manifest base_url origin ${parsedBase.origin} != --origin ${options.origin}`);
}
const slug = parsedBase.pathname.replace(/^\/+|\/+$/g, "");
if (!slug || parsedBase.pathname !== `/${slug}/`) {
  fail(`manifest base_url path ${parsedBase.pathname} must be exactly /<slug>/`);
}

const digest = sha256(manifestBytes);

function walkImageDir(base) {
  const root = path.join(packDir, base);
  if (!existsSync(root)) return [];
  const results = [];
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile()) results.push(path.relative(packDir, full).split(path.sep).join("/"));
    }
  }
  return results.sort();
}

const assetRels = [];
const seen = new Set();
for (const [storageId, entry] of Object.entries(manifest.storage ?? {})) {
  if (entry?.kind === "image-sequence") {
    const rel = entry.path;
    if (typeof rel !== "string" || rel.startsWith("/") || rel.split("/").includes("..")) {
      fail(`storage '${storageId}' has unsafe image-sequence path '${rel}'`);
    }
    const localPath = path.join(packDir, rel);
    if (!existsSync(localPath)) fail(`storage '${storageId}' file missing: ${rel}`);
    if (entry.sha256) {
      const fileDigest = sha256(new Uint8Array(readFileSync(localPath)));
      if (fileDigest !== entry.sha256) {
        fail(`storage '${storageId}' sha256 mismatch: file ${fileDigest} != manifest ${entry.sha256}`);
      }
    }
    if (!seen.has(rel)) {
      seen.add(rel);
      assetRels.push(rel);
    }
  } else if (entry?.kind === "image-dir") {
    const base = entry.base;
    if (typeof base !== "string" || base.startsWith("/") || base.split("/").includes("..")) {
      fail(`storage '${storageId}' has unsafe image-dir base '${base}'`);
    }
    for (const rel of walkImageDir(base)) {
      if (!seen.has(rel)) {
        seen.add(rel);
        assetRels.push(rel);
      }
    }
  }
}

function assetObject(rel) {
  const localPath = path.join(packDir, rel);
  const bytes = new Uint8Array(readFileSync(localPath));
  return {
    role: "asset",
    localPath,
    objectName: `${slug}/${rel}`,
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
    contentType: byExtension(rel),
    cacheControl: IMMUTABLE,
  };
}

const objects = assetRels.map(assetObject);

objects.push({
  role: "active-manifest",
  localPath: path.join(packDir, "manifest.json"),
  objectName: `${slug}/manifest.json`,
  bytes: manifestBytes.byteLength,
  sha256: digest,
  contentType: "application/json",
  cacheControl: MUST_REVALIDATE,
});

objects.push({
  role: "release-manifest",
  localPath: path.join(packDir, "manifest.json"),
  objectName: `${slug}/releases/${digest}/manifest.json`,
  bytes: manifestBytes.byteLength,
  sha256: digest,
  contentType: "application/json",
  cacheControl: IMMUTABLE,
});
const buildReportPath = path.join(packDir, "build_report.json");
if (existsSync(buildReportPath)) {
  const reportBytes = new Uint8Array(readFileSync(buildReportPath));
  objects.push({
    role: "release-report",
    localPath: buildReportPath,
    objectName: `${slug}/releases/${digest}/build_report.json`,
    bytes: reportBytes.byteLength,
    sha256: sha256(reportBytes),
    contentType: "application/json",
    cacheControl: IMMUTABLE,
  });
}

const entityCatalogPath = path.join(packDir, "entity-catalog.json");
let entityCatalogBytes;
let entityCatalogDigest;
if (existsSync(entityCatalogPath)) {
  entityCatalogBytes = new Uint8Array(readFileSync(entityCatalogPath));
  const entityCatalog = JSON.parse(new TextDecoder().decode(entityCatalogBytes));
  if (entityCatalog.schema !== "mmt-pack-entity-catalog.v1") {
    fail(`entity catalog schema ${entityCatalog.schema} is not mmt-pack-entity-catalog.v1`);
  }
  if (entityCatalog.pack?.namespace !== pack.namespace) {
    fail(`entity catalog namespace ${entityCatalog.pack?.namespace} != ${pack.namespace}`);
  }
  if (entityCatalog.pack?.version !== pack.version) {
    fail(`entity catalog version ${entityCatalog.pack?.version} != ${pack.version}`);
  }
  if (entityCatalog.pack?.manifest_sha256 !== digest) {
    fail(`entity catalog manifest digest ${entityCatalog.pack?.manifest_sha256} != ${digest}`);
  }
  entityCatalogDigest = sha256(entityCatalogBytes);
  objects.push({
    role: "active-entity-catalog",
    localPath: entityCatalogPath,
    objectName: `${slug}/entity-catalog.json`,
    bytes: entityCatalogBytes.byteLength,
    sha256: entityCatalogDigest,
    contentType: "application/json",
    cacheControl: MUST_REVALIDATE,
  });
  objects.push({
    role: "release-entity-catalog",
    localPath: entityCatalogPath,
    objectName: `${slug}/releases/${digest}/entity-catalog.json`,
    bytes: entityCatalogBytes.byteLength,
    sha256: entityCatalogDigest,
    contentType: "application/json",
    cacheControl: IMMUTABLE,
  });
}


let catalog;
if (existsSync(catalogPath)) {
  catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  if (catalog.schema !== "mmt-pack-catalog-v1") fail(`catalog ${catalogPath} is not mmt-pack-catalog-v1`);
} else {
  catalog = { schema: "mmt-pack-catalog-v1", generated_at: null, packs: [] };
}

const publishedAt = new Date().toISOString();
const release = {
  digest,
  version: pack.version,
  manifest_url: `${baseUrl}releases/${digest}/manifest.json`,
  published_at: publishedAt,
};
if (entityCatalogDigest) {
  release.entity_catalog_url = `${baseUrl}releases/${digest}/entity-catalog.json`;
  release.entity_catalog_digest = entityCatalogDigest;
}

let entry = (catalog.packs ?? []).find((candidate) => candidate.namespace === pack.namespace);
if (!entry) {
  entry = { namespace: pack.namespace, releases: [] };
  catalog.packs.push(entry);
}
entry.name = pack.name;
entry.type = pack.type;
entry.requires = Array.isArray(pack.requires) ? pack.requires : [];
entry.eula = pack.eula ?? { required: false };
entry.manifest_url = `${baseUrl}manifest.json`;
entry.version = pack.version;
entry.manifest_digest = digest;
entry.published_at = publishedAt;
if (entityCatalogDigest) {
  entry.entity_catalog_url = `${baseUrl}entity-catalog.json`;
  entry.entity_catalog_digest = entityCatalogDigest;
} else {
  delete entry.entity_catalog_url;
  delete entry.entity_catalog_digest;
}

entry.releases = [release, ...(entry.releases ?? []).filter((item) => item.digest !== digest)];
catalog.packs.sort((left, right) => left.namespace.localeCompare(right.namespace));
catalog.generated_at = publishedAt;

const catalogBytes = new TextEncoder().encode(`${JSON.stringify(catalog, null, 2)}\n`);
const catalogStagingPath = path.join(packDir, ".catalog-staged.json");
objects.push({
  role: "catalog",
  localPath: catalogStagingPath,
  objectName: "packs.json",
  bytes: catalogBytes.byteLength,
  sha256: sha256(catalogBytes),
  contentType: "application/json",
  cacheControl: MUST_REVALIDATE,
});

const publication = {
  schema: "mmt-pack-publication.v1",
  namespace: pack.namespace,
  slug,
  packVersion: pack.version,
  manifestDigest: digest,
  generatedAt: publishedAt,
  mode: options.publish ? "published" : "dry-run",
  objects: objects.map(({ localPath: _localPath, ...object }) => object),
  catalog,
};
await mkdir(packDir, { recursive: true });
const publicationPath = path.join(packDir, "publication.json");

if (!options.publish) {
  await writeFile(
    publicationPath,
    `${JSON.stringify(publication, null, 2)}\n`,
    "utf8",
  );
  const counts = {};
  for (const object of objects) counts[object.role] = (counts[object.role] ?? 0) + 1;
  console.log(JSON.stringify({
    mode: "dry-run",
    namespace: pack.namespace,
    slug,
    manifestDigest: digest,
    objectCounts: counts,
    plannedCatalogEntry: entry,
  }, null, 2));
} else {
  await rm(publicationPath, { force: true });
  const configFile = options.ossutilConfig
    ? path.resolve(options.ossutilConfig)
    : undefined;
  await writeFile(catalogStagingPath, catalogBytes);
  const ordered = [
    ...objects.filter((object) => object.role === "asset"),
    ...objects.filter((object) =>
      object.role === "release-manifest"
      || object.role === "release-report"
      || object.role === "release-entity-catalog"
    ),
    ...objects.filter((object) => object.role === "active-manifest"),
    ...objects.filter((object) => object.role === "active-entity-catalog"),
    ...objects.filter((object) => object.role === "catalog"),
  ];
  try {
    const outcomes = await publishPackObjects(ordered, {
      bucket: options.bucket,
      configFile,
      profile: options.ossutilProfile,
      region: options.region,
      temporaryDirectory: packDir,
    });
    await verifyPublicDelivery();
    await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    publication.outcomes = outcomes;
    await writeFile(
      publicationPath,
      `${JSON.stringify(publication, null, 2)}\n`,
      "utf8",
    );
    console.log(JSON.stringify({ mode: "published", outcomes }, null, 2));
  } finally {
    await rm(catalogStagingPath, { force: true });
  }
}

async function verifyPublicDelivery() {
  const catalogResponse = await fetch(`${options.origin}/packs.json`, { cache: "no-store" });
  if (!catalogResponse.ok) fail(`catalog fetch returned HTTP ${catalogResponse.status}`);
  if (catalogResponse.headers.get("access-control-allow-origin") !== "*") {
    fail("catalog must return Access-Control-Allow-Origin: *");
  }
  const remoteCatalog = await catalogResponse.json();
  const remoteEntry = (remoteCatalog.packs ?? []).find((candidate) => candidate.namespace === pack.namespace);
  if (!remoteEntry || remoteEntry.manifest_digest !== digest) {
    fail(`catalog entry for ${pack.namespace} does not match digest ${digest}`);
  }

  const manifestResponse = await fetch(`${baseUrl}manifest.json`, { cache: "no-store" });
  if (!manifestResponse.ok) fail(`manifest fetch returned HTTP ${manifestResponse.status}`);
  if (manifestResponse.headers.get("access-control-allow-origin") !== "*") {
    fail("manifest must return Access-Control-Allow-Origin: *");
  }
  const cacheControl = manifestResponse.headers.get("cache-control") ?? "";
  if (!cacheControl.includes("must-revalidate")) {
    fail(`manifest cache-control ${cacheControl} must include must-revalidate`);
  }
  const remoteDigest = sha256(new Uint8Array(await manifestResponse.arrayBuffer()));
  if (remoteDigest !== digest) fail(`manifest digest ${remoteDigest} != ${digest}`);

  if (entityCatalogDigest) {
    if (
      remoteEntry.entity_catalog_digest !== entityCatalogDigest
      || remoteEntry.entity_catalog_url !== `${baseUrl}entity-catalog.json`
    ) {
      fail(`catalog entity metadata for ${pack.namespace} does not match ${entityCatalogDigest}`);
    }
    const entityCatalogResponse = await fetch(`${baseUrl}entity-catalog.json`, {
      cache: "no-store",
    });
    if (!entityCatalogResponse.ok) {
      fail(`entity catalog fetch returned HTTP ${entityCatalogResponse.status}`);
    }
    if (entityCatalogResponse.headers.get("access-control-allow-origin") !== "*") {
      fail("entity catalog must return Access-Control-Allow-Origin: *");
    }
    const entityCatalogCache = entityCatalogResponse.headers.get("cache-control") ?? "";
    if (!entityCatalogCache.includes("must-revalidate")) {
      fail(`entity catalog cache-control ${entityCatalogCache} must include must-revalidate`);
    }
    const remoteEntityCatalogBytes = new Uint8Array(
      await entityCatalogResponse.arrayBuffer(),
    );
    const remoteEntityCatalogDigest = sha256(remoteEntityCatalogBytes);
    if (remoteEntityCatalogDigest !== entityCatalogDigest) {
      fail(`entity catalog digest ${remoteEntityCatalogDigest} != ${entityCatalogDigest}`);
    }
    const remoteEntityCatalog = JSON.parse(
      new TextDecoder().decode(remoteEntityCatalogBytes),
    );
    if (remoteEntityCatalog.pack?.manifest_sha256 !== digest) {
      fail(`entity catalog manifest digest ${remoteEntityCatalog.pack?.manifest_sha256} != ${digest}`);
    }
  }

  const asset = objects.find((object) => object.role === "asset");
  if (asset) {
    const assetUrl = `${baseUrl}${asset.objectName.slice(slug.length + 1)}`;
    const assetResponse = await fetch(assetUrl, { cache: "no-store" });
    if (!assetResponse.ok) fail(`asset fetch returned HTTP ${assetResponse.status}`);
    const assetCacheControl = assetResponse.headers.get("cache-control") ?? "";
    if (!assetCacheControl.includes("immutable")) {
      fail(`asset cache-control ${assetCacheControl} must include immutable`);
    }
  }
}

function parseArguments(args) {
  const parsed = {
    packDir: undefined,
    catalog: undefined,
    publish: false,
    ossutilConfig: undefined,
    ossutilProfile: undefined,
    bucket: DEFAULT_BUCKET,
    origin: DEFAULT_ORIGIN,
    region: DEFAULT_REGION,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--publish") parsed.publish = true;
    else if (argument === "--pack-dir") parsed.packDir = requiredValue(args, ++index, argument);
    else if (argument === "--catalog") parsed.catalog = requiredValue(args, ++index, argument);
    else if (argument === "--ossutil-config") parsed.ossutilConfig = requiredValue(args, ++index, argument);
    else if (argument === "--ossutil-profile") parsed.ossutilProfile = requiredValue(args, ++index, argument);
    else if (argument === "--bucket") parsed.bucket = requiredValue(args, ++index, argument);
    else if (argument === "--origin") parsed.origin = requiredValue(args, ++index, argument);
    else if (argument === "--region") parsed.region = requiredValue(args, ++index, argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!parsed.packDir) throw new Error("--pack-dir is required");
  return parsed;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
