import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BUCKET,
  DEFAULT_ORIGIN,
  DEFAULT_REGION,
  assertMetadata,
  assertOssutilV2,
  isMissingObjectError,
  objectPropertyArguments,
  ossutilGlobalArguments,
  parseStatJson,
  sha256,
  statMetadata,
} from "./ossutil-helper.mjs";
import { publishPackObjects } from "./publish-pack-objects.mjs";

const exec = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const publishPackScript = path.join(repoRoot, "tools/cdn/publish_pack.mjs");
const immutable = "public,max-age=31536000,immutable";
const mutable = "public,max-age=0,must-revalidate";

function metadata(contentType, cacheControl) {
  return { "Content-Type": contentType, "Cache-Control": cacheControl };
}

function makeFakeOss() {
  const objects = new Map();
  const calls = [];
  const run = async (args) => {
    calls.push([...args]);
    if (args[0] === "version") return { stdout: "ossutil version: 2.3.0", stderr: "", missing: false };
    if (args[0] === "stat") {
      const stored = objects.get(args[1]);
      if (!stored) return { stdout: "", stderr: "", missing: true };
      return {
        stdout: JSON.stringify({
          object: {
            contentType: stored.metadata["Content-Type"],
            cacheControl: stored.metadata["Cache-Control"],
            contentEncoding: stored.metadata["Content-Encoding"],
          },
        }),
        stderr: "",
        missing: false,
      };
    }
    if (args[0] !== "cp") throw new Error(`unexpected fake ossutil command: ${args.join(" ")}`);
    if (args[1].startsWith("oss://")) {
      const stored = objects.get(args[1]);
      if (!stored) throw new Error(`fake object is missing: ${args[1]}`);
      await writeFile(args[2], stored.bytes);
      return { stdout: "", stderr: "", missing: false };
    }
    const target = args[2];
    const property = (flag) => {
      const index = args.indexOf(flag);
      return index < 0 ? undefined : args[index + 1];
    };
    objects.set(target, {
      bytes: new Uint8Array(await readFile(args[1])),
      metadata: {
        "Content-Type": property("--content-type"),
        "Cache-Control": property("--cache-control"),
        "Content-Encoding": property("--content-encoding"),
      },
    });
    return { stdout: "", stderr: "", missing: false };
  };
  return { objects, calls, run };
}

async function localObject(directory, role, objectName, body, properties) {
  const localPath = path.join(directory, `${role}-${sha256(body)}.json`);
  await writeFile(localPath, body);
  return {
    role,
    objectName,
    localPath,
    bytes: body.byteLength,
    sha256: sha256(body),
    contentType: properties["Content-Type"],
    cacheControl: properties["Cache-Control"],
  };
}

test("ossutil 2.3 arguments and JSON stat contracts", async () => {
  assert.equal(DEFAULT_BUCKET, "mms-pack");
  assert.equal(DEFAULT_ORIGIN, "https://mms-pack.esa.xiyihan.cn");
  assert.equal(DEFAULT_REGION, "cn-shanghai");
  assert.deepEqual(ossutilGlobalArguments(), ["--region", "cn-shanghai"]);
  assert.deepEqual(
    ossutilGlobalArguments({
      configFile: "/tmp/isolated-ossutilconfig",
      profile: "publisher",
      region: "cn-hangzhou",
    }),
    [
      "--region",
      "cn-hangzhou",
      "--config-file",
      "/tmp/isolated-ossutilconfig",
      "--profile",
      "publisher",
    ],
  );
  assert.deepEqual(objectPropertyArguments({
    "Content-Type": "application/json",
    "Cache-Control": mutable,
    "Content-Encoding": "br",
  }), [
    "--content-type",
    "application/json",
    "--cache-control",
    mutable,
    "--content-encoding",
    "br",
  ]);

  const stat = JSON.stringify({
    object: { contentType: "application/json", cacheControl: mutable },
  });
  assert.deepEqual(parseStatJson(stat), JSON.parse(stat));
  const timedStat = `${stat}\n0.219717(s) elapsed`;
  assert.deepEqual(parseStatJson(timedStat), JSON.parse(stat));
  assert.deepEqual(statMetadata(timedStat, "packs.json"), {
    "Content-Type": "application/json",
    "Cache-Control": mutable,
    "Content-Encoding": undefined,
  });
  assert.deepEqual(statMetadata(stat, "packs.json"), {
    "Content-Type": "application/json",
    "Cache-Control": mutable,
    "Content-Encoding": undefined,
  });
  assert.doesNotThrow(() => assertMetadata(stat, metadata("application/json", mutable), "packs.json"));
  assert.throws(
    () => assertMetadata(stat, metadata("application/json", immutable), "packs.json"),
    /metadata Cache-Control/,
  );
  assert.equal(isMissingObjectError("Http Status Code: 404\nError Code: NoSuchKey"), true);
  assert.equal(isMissingObjectError("Http Status Code: 403\nError Code: AccessDenied"), false);

  assert.equal(
    await assertOssutilV2(async (args) => {
      assert.deepEqual(args, ["version"]);
      return { stdout: "ossutil version: 2.3.0", stderr: "" };
    }),
    "2.3.0",
  );
  await assert.rejects(
    assertOssutilV2(async () => ({ stdout: "ossutil version: 2.2.0", stderr: "" })),
    /ossutil >= 2\.3\.0 is required/,
  );
  await assert.rejects(
    assertOssutilV2(async () => ({ stdout: "unexpected output", stderr: "" })),
    /ossutil >= 2\.3\.0 is required/,
  );
});

test("immutable A/B releases coexist while mutable active and catalog objects advance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mmt-pack-objects-"));
  const fake = makeFakeOss();
  const json = metadata("application/json", immutable);
  const currentJson = metadata("application/json", mutable);
  const assetMetadata = metadata("image/png", immutable);
  const assetABytes = new TextEncoder().encode("asset A");
  const assetBBytes = new TextEncoder().encode("asset B");
  const manifestABytes = new TextEncoder().encode('{"release":"A"}\n');
  const manifestBBytes = new TextEncoder().encode('{"release":"B"}\n');
  const reportABytes = new TextEncoder().encode('{"report":"A"}\n');
  const reportBBytes = new TextEncoder().encode('{"report":"B"}\n');
  const catalogABytes = new TextEncoder().encode('{"active":"A"}\n');
  const catalogBBytes = new TextEncoder().encode('{"active":"B"}\n');
  const digestA = sha256(manifestABytes);
  const digestB = sha256(manifestBBytes);

  const assetA = await localObject(directory, "asset", `ba/blobs/${sha256(assetABytes)}.png`, assetABytes, assetMetadata);
  const releaseA = await localObject(directory, "release-manifest", `ba/releases/${digestA}/manifest.json`, manifestABytes, json);
  const reportA = await localObject(directory, "release-report", `ba/releases/${digestA}/build_report.json`, reportABytes, json);
  const activeA = await localObject(directory, "active-manifest", "ba/manifest.json", manifestABytes, currentJson);
  const catalogA = await localObject(directory, "catalog", "packs.json", catalogABytes, currentJson);
  const outcomesA = await publishPackObjects([assetA, releaseA, reportA, activeA, catalogA], {
    temporaryDirectory: directory,
    runOssCommand: fake.run,
  });
  assert.deepEqual(
    outcomesA.map((item) => item.outcome),
    ["published", "published", "published", "published", "published"],
  );
  assert.deepEqual(
    fake.calls
      .filter((args) => args[0] === "cp" && !args[1].startsWith("oss://"))
      .map((args) => args[2]),
    [
      `oss://mms-pack/${assetA.objectName}`,
      `oss://mms-pack/${releaseA.objectName}`,
      `oss://mms-pack/${reportA.objectName}`,
      "oss://mms-pack/ba/manifest.json",
      "oss://mms-pack/packs.json",
    ],
  );

  const assetB = await localObject(directory, "asset", `ba/blobs/${sha256(assetBBytes)}.png`, assetBBytes, assetMetadata);
  const releaseB = await localObject(directory, "release-manifest", `ba/releases/${digestB}/manifest.json`, manifestBBytes, json);
  const reportB = await localObject(directory, "release-report", `ba/releases/${digestB}/build_report.json`, reportBBytes, json);
  const activeB = await localObject(directory, "active-manifest", "ba/manifest.json", manifestBBytes, currentJson);
  const catalogB = await localObject(directory, "catalog", "packs.json", catalogBBytes, currentJson);
  const outcomesB = await publishPackObjects([assetB, releaseB, reportB, activeB, catalogB], {
    configFile: "/tmp/isolated-ossutilconfig",
    profile: "default",
    temporaryDirectory: directory,
    runOssCommand: fake.run,
  });
  assert.deepEqual(
    outcomesB.map((item) => item.outcome),
    ["published", "published", "published", "updated", "updated"],
  );

  assert.equal(new TextDecoder().decode(fake.objects.get(`oss://mms-pack/ba/releases/${digestA}/manifest.json`).bytes), '{"release":"A"}\n');
  assert.equal(new TextDecoder().decode(fake.objects.get(`oss://mms-pack/ba/releases/${digestB}/manifest.json`).bytes), '{"release":"B"}\n');
  assert.equal(new TextDecoder().decode(fake.objects.get(`oss://mms-pack/ba/releases/${digestA}/build_report.json`).bytes), '{"report":"A"}\n');
  assert.equal(new TextDecoder().decode(fake.objects.get(`oss://mms-pack/ba/releases/${digestB}/build_report.json`).bytes), '{"report":"B"}\n');
  assert.equal(new TextDecoder().decode(fake.objects.get("oss://mms-pack/ba/manifest.json").bytes), '{"release":"B"}\n');
  assert.equal(new TextDecoder().decode(fake.objects.get("oss://mms-pack/packs.json").bytes), '{"active":"B"}\n');

  const repeated = await publishPackObjects([assetB, releaseB, reportB, activeB, catalogB], {
    temporaryDirectory: directory,
    runOssCommand: fake.run,
  });
  assert.deepEqual(
    repeated.map((item) => item.outcome),
    ["reused", "reused", "reused", "updated", "updated"],
  );
  assert.ok(fake.calls.some((args) => args[0] === "stat" && args.includes("--output-format") && args.includes("json")));
  assert.ok(fake.calls.some((args) => args.includes("--config-file") && args.includes("--profile")));
  assert.ok(fake.calls.some((args) => args[0] === "stat" && !args.includes("--config-file")));

  const conflictingBytes = new TextEncoder().encode("different immutable bytes");
  const conflictingRelease = await localObject(
    directory,
    "release-manifest",
    `ba/releases/${digestA}/manifest.json`,
    conflictingBytes,
    json,
  );
  await assert.rejects(
    publishPackObjects([conflictingRelease], {
      temporaryDirectory: directory,
      runOssCommand: fake.run,
    }),
    /already exists with digest/,
  );

  fake.objects.get(`oss://mms-pack/ba/releases/${digestB}/manifest.json`).metadata["Cache-Control"] = mutable;
  await assert.rejects(
    publishPackObjects([releaseB], {
      temporaryDirectory: directory,
      runOssCommand: fake.run,
    }),
    /metadata Cache-Control/,
  );
});

test("bounded concurrency preserves immutable and mutable publication barriers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mmt-pack-concurrency-"));
  const fake = makeFakeOss();
  const json = metadata("application/json", immutable);
  const currentJson = metadata("application/json", mutable);
  const image = metadata("image/png", immutable);
  const assetA = await localObject(
    directory,
    "asset",
    "ba/blobs/a.png",
    new TextEncoder().encode("asset A"),
    image,
  );
  const assetB = await localObject(
    directory,
    "asset",
    "ba/blobs/b.png",
    new TextEncoder().encode("asset B"),
    image,
  );
  const release = await localObject(
    directory,
    "release-manifest",
    "ba/releases/release/manifest.json",
    new TextEncoder().encode('{"release":true}\n'),
    json,
  );
  const active = await localObject(
    directory,
    "active-manifest",
    "ba/manifest.json",
    new TextEncoder().encode('{"active":true}\n'),
    currentJson,
  );
  const catalog = await localObject(
    directory,
    "catalog",
    "packs.json",
    new TextEncoder().encode('{"catalog":true}\n'),
    currentJson,
  );
  let activeUploads = 0;
  let maxActiveUploads = 0;
  const completedUploads = [];
  const progress = [];
  const run = async (args) => {
    const isUpload = args[0] === "cp" && !args[1].startsWith("oss://");
    if (!isUpload) return fake.run(args);
    activeUploads += 1;
    maxActiveUploads = Math.max(maxActiveUploads, activeUploads);
    await new Promise((resolve) => setTimeout(resolve, 10));
    try {
      const result = await fake.run(args);
      completedUploads.push(args[2]);
      return result;
    } finally {
      activeUploads -= 1;
    }
  };

  const outcomes = await publishPackObjects(
    [assetA, assetB, release, active, catalog],
    {
      concurrency: 2,
      onProgress: (item) => progress.push(item),
      runOssCommand: run,
      temporaryDirectory: directory,
    },
  );

  assert.equal(maxActiveUploads, 2);
  assert.deepEqual(
    outcomes.map(({ role }) => role),
    ["asset", "asset", "release-manifest", "active-manifest", "catalog"],
  );
  const assetIndexes = [
    completedUploads.indexOf(`oss://mms-pack/${assetA.objectName}`),
    completedUploads.indexOf(`oss://mms-pack/${assetB.objectName}`),
  ];
  const releaseIndex = completedUploads.indexOf(`oss://mms-pack/${release.objectName}`);
  const activeIndex = completedUploads.indexOf(`oss://mms-pack/${active.objectName}`);
  const catalogIndex = completedUploads.indexOf(`oss://mms-pack/${catalog.objectName}`);
  assert.ok(assetIndexes.every((index) => index >= 0 && index < releaseIndex));
  assert.ok(releaseIndex < activeIndex);
  assert.ok(activeIndex < catalogIndex);
  assert.equal(progress.length, 5);
  assert.deepEqual(
    progress.map(({ completed, total }) => [completed, total]),
    [[1, 5], [2, 5], [3, 5], [4, 5], [5, 5]],
  );
  await assert.rejects(
    publishPackObjects([], {
      concurrency: 0,
      runOssCommand: run,
      temporaryDirectory: directory,
    }),
    /concurrency must be a positive integer/,
  );
});

test("entity Catalog release is immutable while active metadata advances", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mmt-entity-catalog-"));
  const fake = makeFakeOss();
  const json = metadata("application/json", immutable);
  const currentJson = metadata("application/json", mutable);
  const entityABytes = new TextEncoder().encode('{\"release\":\"A\"}\\n');
  const entityBBytes = new TextEncoder().encode('{\"release\":\"B\"}\\n');
  const releaseA = await localObject(
    directory,
    "release-entity-catalog",
    "ba/releases/A/entity-catalog.json",
    entityABytes,
    json,
  );
  const activeA = await localObject(
    directory,
    "active-entity-catalog",
    "ba/entity-catalog.json",
    entityABytes,
    currentJson,
  );
  const first = await publishPackObjects([releaseA, activeA], {
    temporaryDirectory: directory,
    runOssCommand: fake.run,
  });
  assert.deepEqual(first.map((item) => item.outcome), ["published", "published"]);

  const releaseB = await localObject(
    directory,
    "release-entity-catalog",
    "ba/releases/B/entity-catalog.json",
    entityBBytes,
    json,
  );
  const activeB = await localObject(
    directory,
    "active-entity-catalog",
    "ba/entity-catalog.json",
    entityBBytes,
    currentJson,
  );
  const second = await publishPackObjects([releaseB, activeB], {
    temporaryDirectory: directory,
    runOssCommand: fake.run,
  });
  assert.deepEqual(second.map((item) => item.outcome), ["published", "updated"]);

  const repeated = await publishPackObjects([releaseB, activeB], {
    temporaryDirectory: directory,
    runOssCommand: fake.run,
  });
  assert.deepEqual(repeated.map((item) => item.outcome), ["reused", "updated"]);
  assert.equal(
    new TextDecoder().decode(fake.objects.get("oss://mms-pack/ba/entity-catalog.json").bytes),
    '{\"release\":\"B\"}\\n',
  );
});


test("dry-run Catalog merge prepends releases, deduplicates digests, preserves Packs, and sorts namespaces", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mmt-pack-dry-run-"));
  const packA = path.join(directory, "ba-a");
  const packB = path.join(directory, "ba-b");
  const catalogPath = path.join(directory, "catalog.json");
  await Promise.all([mkdir(packA), mkdir(packB)]);
  const manifest = (version, marker) => ({
    schema: "mmt-pack.v3",
    pack: {
      namespace: "ba",
      name: "Test Pack",
      version,
      type: "base",
      base_url: "https://mms-pack.esa.xiyihan.cn/ba/",
      requires: [],
      eula: { required: false },
      marker,
    },
    storage: {},
  });
  await writeFile(path.join(packA, "manifest.json"), `${JSON.stringify(manifest("A", "A"), null, 2)}\n`);
  await writeFile(path.join(packB, "manifest.json"), `${JSON.stringify(manifest("B", "B"), null, 2)}\n`);
  const manifestBBytes = new Uint8Array(await readFile(path.join(packB, "manifest.json")));
  const manifestBDigest = sha256(manifestBBytes);
  const entityCatalogBytes = new TextEncoder().encode(`${JSON.stringify({
    schema: "mmt-pack-entity-catalog.v1",
    generated_at: "2026-08-16T00:00:00Z",
    pack: {
      namespace: "ba",
      version: "B",
      manifest_sha256: manifestBDigest,
    },
    source: {
      id: "fixture",
      name: "Fixture",
      url: "https://example.invalid/",
      retrieved_at: "2026-08-16T00:00:00Z",
      transformed: true,
      license: {
        id: "CC-BY-SA-4.0",
        url: "https://creativecommons.org/licenses/by-sa/4.0/",
        terms_url: "https://example.invalid/license",
        attribution: "Fixture",
      },
    },
    entities: {},
    taxonomies: { schools: {}, relations: {} },
  }, null, 2)}\n`);
  await writeFile(path.join(packB, "entity-catalog.json"), entityCatalogBytes);

  await writeFile(catalogPath, `${JSON.stringify({
    schema: "mmt-pack-catalog-v1",
    generated_at: null,
    packs: [{
      namespace: "z-pack",
      name: "Existing Pack",
      type: "extension",
      requires: [],
      eula: { required: false },
      releases: [],
    }],
  }, null, 2)}\n`);

  await exec(process.execPath, [publishPackScript, "--pack-dir", packA, "--catalog", catalogPath], { cwd: repoRoot });
  const first = JSON.parse(await readFile(path.join(packA, "publication.json"), "utf8"));
  await writeFile(catalogPath, `${JSON.stringify(first.catalog, null, 2)}\n`);
  await exec(process.execPath, [publishPackScript, "--pack-dir", packB, "--catalog", catalogPath], { cwd: repoRoot });
  const second = JSON.parse(await readFile(path.join(packB, "publication.json"), "utf8"));
  const namespaces = second.catalog.packs.map((entry) => entry.namespace);
  assert.deepEqual(namespaces, ["ba", "z-pack"]);
  const ba = second.catalog.packs.find((entry) => entry.namespace === "ba");
  assert.equal(ba.releases.length, 2);
  assert.equal(ba.releases[0].digest, second.manifestDigest);
  assert.equal(ba.releases[1].digest, first.manifestDigest);
  assert.equal(new Set(ba.releases.map((release) => release.digest)).size, ba.releases.length);
  assert.equal(ba.manifest_digest, second.manifestDigest);
  assert.equal(ba.manifest_url, "https://mms-pack.esa.xiyihan.cn/ba/manifest.json");
  assert.equal(ba.entity_catalog_digest, sha256(entityCatalogBytes));
  assert.equal(
    ba.entity_catalog_url,
    "https://mms-pack.esa.xiyihan.cn/ba/entity-catalog.json",
  );
  assert.equal(ba.releases[0].entity_catalog_digest, sha256(entityCatalogBytes));
  assert.equal(
    ba.releases[0].entity_catalog_url,
    `https://mms-pack.esa.xiyihan.cn/ba/releases/${second.manifestDigest}/entity-catalog.json`,
  );
  assert.deepEqual(
    second.objects
      .filter((object) => object.role.includes("entity-catalog"))
      .map((object) => object.role)
      .sort(),
    ["active-entity-catalog", "release-entity-catalog"],
  );
  await writeFile(catalogPath, `${JSON.stringify(second.catalog, null, 2)}\n`);
  await exec(
    process.execPath,
    [publishPackScript, "--pack-dir", packB, "--catalog", catalogPath],
    { cwd: repoRoot },
  );
  const repeated = JSON.parse(await readFile(path.join(packB, "publication.json"), "utf8"));
  const repeatedBa = repeated.catalog.packs.find((entry) => entry.namespace === "ba");
  assert.equal(repeatedBa.releases.length, 2);
  assert.equal(
    repeatedBa.releases.filter((release) => release.digest === second.manifestDigest).length,
    1,
  );
});

test("controlled Catalog current release is self-consistent", async () => {
  const catalog = JSON.parse(await readFile(path.join(repoRoot, "typst_sandbox/pack-v3/catalog.json"), "utf8"));
  const pack = catalog.packs.find((entry) => entry.namespace === "ba");
  assert(pack, "Catalog must contain the controlled ba Pack");
  const current = pack.releases.find((release) => release.digest === pack.manifest_digest);
  assert(current, "Catalog must retain its current immutable release");
  assert.equal(current.version, pack.version);
  assert.equal(current.published_at, pack.published_at);
  assert.equal(pack.manifest_url, "https://mms-pack.esa.xiyihan.cn/ba_kivo/manifest.json");
  assert.equal(
    current.manifest_url,
    `https://mms-pack.esa.xiyihan.cn/ba_kivo/releases/${pack.manifest_digest}/manifest.json`,
  );
});
