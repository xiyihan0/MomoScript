import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants } from "node:zlib";
import {
  DEFAULT_BUCKET,
  DEFAULT_ORIGIN,
  DEFAULT_REGION,
  assertMetadata,
  assertOssutilV2,
  objectPropertyArguments,
  ossutilGlobalArguments,
  runOss,
  sha256,
} from "./ossutil-helper.mjs";

const compress = promisify(brotliCompress);
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const options = parseArguments(process.argv.slice(2));
const pin = JSON.parse(await readFile(path.join(root, "third_party/tinymist/pin.json"), "utf8"));
const version = pin.upstream?.version;
const pinnedWasm = pin.artifacts?.webWasm;
if (typeof version !== "string" || !version) throw new Error("Tinymist pin has no upstream version");
if (!pinnedWasm || typeof pinnedWasm.sha256 !== "string" || typeof pinnedWasm.size !== "number") {
  throw new Error("Tinymist pin has no Web WASM identity");
}

const runtimeSource = await readFile(path.join(root, "editors/vscode-web/src/runtimeArtifacts.ts"), "utf8");
const runtimeVersion = /TINYMIST_VERSION = "([^"]+)"/.exec(runtimeSource)?.[1];
const runtimeDigest = /TINYMIST_WASM_SHA256 = "([0-9a-f]{64})"/.exec(runtimeSource)?.[1];
if (runtimeVersion !== version) throw new Error(`Runtime Tinymist version ${runtimeVersion} != pin ${version}`);
if (runtimeDigest !== pinnedWasm.sha256) {
  throw new Error(`Runtime Tinymist digest ${runtimeDigest} != pin ${pinnedWasm.sha256}`);
}

const source = path.resolve(options.source ?? path.join(
  root,
  `editors/vscode/vendor/tinymist-${version}/tinymist_bg.wasm`,
));
const output = path.resolve(options.output ?? path.join(root, ".tmp/runtime-publication/tinymist"));
const identityPath = path.join(output, "tinymist_bg.wasm");
const brotliPath = `${identityPath}.br`;
const manifestPath = path.join(output, "manifest.json");
const identityBytes = new Uint8Array(await readFile(source));
const identityDigest = sha256(identityBytes);
if (identityBytes.byteLength !== pinnedWasm.size) {
  throw new Error(`Tinymist WASM size ${identityBytes.byteLength} != pin ${pinnedWasm.size}`);
}
if (identityDigest !== pinnedWasm.sha256) {
  throw new Error(`Tinymist WASM digest ${identityDigest} != pin ${pinnedWasm.sha256}`);
}
if (!WebAssembly.validate(identityBytes)) throw new Error("Tinymist WASM is not a valid WebAssembly module");

await mkdir(output, { recursive: true });
await copyFile(source, identityPath);
const brotliBytes = new Uint8Array(await compress(identityBytes, {
  params: {
    [zlibConstants.BROTLI_PARAM_MODE]: zlibConstants.BROTLI_MODE_GENERIC,
    [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
    [zlibConstants.BROTLI_PARAM_SIZE_HINT]: identityBytes.byteLength,
  },
}));
await writeFile(brotliPath, brotliBytes);

const objectPrefix = `wasm/tinymist/${version}/${identityDigest}`;
const immutableCacheControl = "public,max-age=31536000,immutable";
const manifest = {
  schema: "mmt-runtime-publication.v1",
  runtime: "tinymist",
  version,
  decodedSha256: identityDigest,
  decodedBytes: identityBytes.byteLength,
  objectPrefix,
  objects: [
    {
      delivery: "identity",
      localPath: identityPath,
      objectName: `${objectPrefix}/tinymist_bg.wasm`,
      sha256: identityDigest,
      bytes: identityBytes.byteLength,
      metadata: {
        "Content-Type": "application/wasm",
        "Cache-Control": immutableCacheControl,
      },
    },
    {
      delivery: "br-v1",
      localPath: brotliPath,
      objectName: `${objectPrefix}/tinymist_bg.wasm.br`,
      sha256: sha256(brotliBytes),
      bytes: brotliBytes.byteLength,
      metadata: {
        "Content-Type": "application/wasm",
        "Content-Encoding": "br",
        "Cache-Control": immutableCacheControl,
      },
    },
  ],
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const publication = options.publish
  ? await publishObjects(manifest, options)
  : manifest.objects.map(({ delivery, objectName }) => ({ delivery, objectName, outcome: "prepared" }));
const result = { ...manifest, manifestPath, publication };
console.log(JSON.stringify(result));
if (process.env.GITHUB_OUTPUT) {
  await writeFile(process.env.GITHUB_OUTPUT, [
    `version=${version}`,
    `digest=${identityDigest}`,
    `object_prefix=${objectPrefix}`,
    `manifest=${manifestPath}`,
    "",
  ].join("\n"), { flag: "a" });
}

async function publishObjects(prepared, settings) {
  const configFile = settings.ossutilConfig
    ? path.resolve(settings.ossutilConfig)
    : undefined;
  const globalArguments = ossutilGlobalArguments({
    configFile,
    profile: settings.ossutilProfile,
    region: settings.region,
  });
  await assertOssutilV2();
  const outcomes = [];
  for (const object of prepared.objects) {
    const target = `oss://${settings.bucket}/${object.objectName}`;
    const stat = await runOss([
      "stat",
      target,
      ...globalArguments,
      "--output-format",
      "json",
    ], true);
    if (stat.missing) {
      await runOss([
        "cp",
        object.localPath,
        target,
        "--force",
        ...objectPropertyArguments(object.metadata),
        ...globalArguments,
      ]);
      outcomes.push({ delivery: object.delivery, objectName: object.objectName, outcome: "published" });
    } else {
      assertMetadata(stat.stdout, object.metadata, target);
      const downloaded = path.join(output, `.remote-${object.delivery}`);
      try {
        await runOss(["cp", target, downloaded, "--force", ...globalArguments]);
        const remoteDigest = sha256(new Uint8Array(await readFile(downloaded)));
        if (remoteDigest !== object.sha256) {
          throw new Error(`${target} already exists with digest ${remoteDigest}, expected ${object.sha256}`);
        }
      } finally {
        await rm(downloaded, { force: true });
      }
      outcomes.push({ delivery: object.delivery, objectName: object.objectName, outcome: "reused" });
    }
  }
  await verifyPublicDelivery(prepared, settings.origin);
  return outcomes;
}

async function verifyPublicDelivery(prepared, origin) {
  for (const object of prepared.objects) {
    const suffix = object.delivery === "br-v1" ? "?delivery=br-v1" : "";
    const url = `${origin.replace(/\/$/, "")}/${object.objectName}${suffix}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
    if (response.headers.get("access-control-allow-origin") !== "*") {
      throw new Error(`${url} must return Access-Control-Allow-Origin: *`);
    }
    if (response.headers.get("content-type") !== "application/wasm") {
      throw new Error(`${url} must return Content-Type: application/wasm`);
    }
    if (object.delivery === "br-v1" && response.headers.get("content-encoding") !== "br") {
      throw new Error(`${url} must return Content-Encoding: br`);
    }
    const decoded = new Uint8Array(await response.arrayBuffer());
    const digest = sha256(decoded);
    if (digest !== prepared.decodedSha256) {
      throw new Error(`${url} decoded digest ${digest} != ${prepared.decodedSha256}`);
    }
    if (!WebAssembly.validate(decoded)) throw new Error(`${url} did not decode to valid WebAssembly`);
  }
}



function parseArguments(args) {
  const parsed = {
    source: undefined,
    output: undefined,
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
    else if (argument === "--source") parsed.source = requiredValue(args, ++index, argument);
    else if (argument === "--output") parsed.output = requiredValue(args, ++index, argument);
    else if (argument === "--ossutil-config") parsed.ossutilConfig = requiredValue(args, ++index, argument);
    else if (argument === "--ossutil-profile") parsed.ossutilProfile = requiredValue(args, ++index, argument);
    else if (argument === "--bucket") parsed.bucket = requiredValue(args, ++index, argument);
    else if (argument === "--origin") parsed.origin = requiredValue(args, ++index, argument);
    else if (argument === "--region") parsed.region = requiredValue(args, ++index, argument);
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return parsed;
}

function requiredValue(args, index, option) {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}
