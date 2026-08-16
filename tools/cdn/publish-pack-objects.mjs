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
  runOssCommand = runOss,
}) {
  if (!temporaryDirectory) throw new Error("temporaryDirectory is required");
  await mkdir(temporaryDirectory, { recursive: true });
  await assertOssutilV2(runOssCommand);
  const globalArguments = ossutilGlobalArguments({ configFile, profile, region });
  const outcomes = [];

  for (const [index, object] of objects.entries()) {
    if (!IMMUTABLE_ROLES.has(object.role) && !MUTABLE_ROLES.has(object.role)) {
      throw new Error(`Unsupported Pack object role: ${object.role}`);
    }
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

    if (MUTABLE_ROLES.has(object.role)) {
      await uploadObject(object.localPath, target, metadata, globalArguments, runOssCommand);
      outcomes.push({
        role: object.role,
        objectName: object.objectName,
        outcome: stat.missing ? "published" : "updated",
      });
      continue;
    }

    if (stat.missing) {
      await uploadObject(object.localPath, target, metadata, globalArguments, runOssCommand);
      outcomes.push({ role: object.role, objectName: object.objectName, outcome: "published" });
      continue;
    }

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
    outcomes.push({ role: object.role, objectName: object.objectName, outcome: "reused" });
  }

  return outcomes;
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
