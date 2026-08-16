import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_BUCKET,
  DEFAULT_REGION,
  assertMetadata,
  assertOssutilV2,
  objectPropertyArguments,
  ossutilGlobalArguments,
  runOss,
  sha256,
} from "./ossutil-helper.mjs";

const MUTABLE_ROLES = new Set(["active-manifest", "active-entity-catalog", "catalog"]);
const IMMUTABLE_ROLES = new Set([
  "asset",
  "release-manifest",
  "release-report",
  "release-entity-catalog",
]);

export async function publishPackObjects(objects, {
  bucket = DEFAULT_BUCKET,
  configFile,
  profile,
  region = DEFAULT_REGION,
  temporaryDirectory,
  concurrency = 1,
  onProgress,
  runOssCommand = runOss,
}) {
  if (!temporaryDirectory) throw new Error("temporaryDirectory is required");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }
  await mkdir(temporaryDirectory, { recursive: true });
  await assertOssutilV2(runOssCommand);
  const globalArguments = ossutilGlobalArguments({ configFile, profile, region });
  const outcomes = new Array(objects.length);
  let completed = 0;
  const entries = objects.map((object, index) => {
    if (!IMMUTABLE_ROLES.has(object.role) && !MUTABLE_ROLES.has(object.role)) {
      throw new Error(`Unsupported Pack object role: ${object.role}`);
    }
    return { object, index };
  });

  const publishEntry = async ({ object, index }) => {
    const target = `oss://${bucket}/${object.objectName}`;
    const metadata = object.metadata ?? {
      "Content-Type": object.contentType,
      "Cache-Control": object.cacheControl,
    };
    const stat = await runOssCommand([
      "stat",
      target,
      ...globalArguments,
      "--output-format",
      "json",
    ], true);
    let outcome;

    if (MUTABLE_ROLES.has(object.role)) {
      await uploadObject(object.localPath, target, metadata, globalArguments, runOssCommand);
      outcome = {
        role: object.role,
        objectName: object.objectName,
        outcome: stat.missing ? "published" : "updated",
      };
    } else if (stat.missing) {
      await uploadObject(object.localPath, target, metadata, globalArguments, runOssCommand);
      outcome = { role: object.role, objectName: object.objectName, outcome: "published" };
    } else {
      assertMetadata(stat.stdout, metadata, target);
      const downloaded = path.join(
        temporaryDirectory,
        `.remote-${index}-${object.role}-${object.sha256}`,
      );
      try {
        await runOssCommand(["cp", target, downloaded, "--force", ...globalArguments]);
        const remoteDigest = sha256(new Uint8Array(await readFile(downloaded)));
        if (remoteDigest !== object.sha256) {
          throw new Error(`${target} already exists with digest ${remoteDigest}, expected ${object.sha256}`);
        }
      } finally {
        await rm(downloaded, { force: true });
      }
      outcome = { role: object.role, objectName: object.objectName, outcome: "reused" };
    }

    outcomes[index] = outcome;
    completed += 1;
    onProgress?.({ completed, total: objects.length, ...outcome });
  };

  const assets = entries.filter(({ object }) => object.role === "asset");
  const releases = entries.filter(({ object }) =>
    IMMUTABLE_ROLES.has(object.role) && object.role !== "asset"
  );
  const mutable = entries.filter(({ object }) => MUTABLE_ROLES.has(object.role));
  await runConcurrent(assets, concurrency, publishEntry);
  await runConcurrent(releases, concurrency, publishEntry);
  for (const entry of mutable) await publishEntry(entry);
  return outcomes;
}

async function runConcurrent(entries, concurrency, worker) {
  let cursor = 0;
  let firstError;
  const workers = Array.from(
    { length: Math.min(concurrency, entries.length) },
    async () => {
      while (firstError === undefined) {
        const index = cursor;
        cursor += 1;
        if (index >= entries.length) return;
        try {
          await worker(entries[index]);
        } catch (error) {
          firstError ??= error;
        }
      }
    },
  );
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
}

async function uploadObject(localPath, target, metadata, globalArguments, runOssCommand) {
  await runOssCommand([
    "cp",
    localPath,
    target,
    "--force",
    ...objectPropertyArguments(metadata),
    ...globalArguments,
  ]);
}
