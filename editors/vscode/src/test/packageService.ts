import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  acquireTypstPackage,
  DEFAULT_TYPST_PACKAGE_LIMITS,
  parseTarArchive,
  TypstPackageAcquisitionError,
  validateTypstManifest,
  type PackageDistribution,
  type PackageFetch,
  type PackageRegistryAdapter,
  type ValidatedPackageFile
} from "../typstPackageArchive";
import { parseAuthoredPackageSpec, type PackageSpec, type TypstPackageRequestParams } from "../typstPackageProtocol";
import {
  InMemoryTypstPackageCache,
  TypstPackageService,
  materializePackageGeneration,
  type TypstPackageStatus
} from "../typstPackageService";
import { TypstPreviewPackageRegistry } from "../typstPreviewPackageRegistry";
import type { TypstProjectUpdate } from "../tinymistClient";

const SPEC: PackageSpec = Object.freeze({ namespace: "preview", name: "demo", version: "1.2.3" });
const DISTRIBUTION: PackageDistribution = Object.freeze({
  registryId: "fixture-registry-v1",
  url: "https://packages.test/preview/demo-1.2.3.tar.gz",
  allowedHosts: new Set(["packages.test"]),
  contentTypes: ["application/gzip"]
});
const MANIFEST = `[package]\nnamespace = "preview"\nname = "demo"\nversion = "1.2.3"\nentrypoint = "lib.typ"\n`;

async function main(): Promise<void> {
  assert.deepEqual(parseAuthoredPackageSpec("@preview/demo:1.2.3"), SPEC);
  assert.throws(() => parseAuthoredPackageSpec("@preview/demo"), /fully versioned/);
  assert.throws(() => parseAuthoredPackageSpec("https://evil.test/pkg.tar.gz"), /fully versioned/);

  const validTar = tar([
    { path: "typst.toml", bytes: text(MANIFEST) },
    { path: "lib.typ", bytes: text("#let answer = 42\n") },
    { path: "assets/pixel.png", bytes: new Uint8Array([1, 2, 3]) }
  ]);
  const validGzip = new Uint8Array(gzipSync(validTar));
  const fetchLog: string[] = [];
  const validFetch = streamingFetch(validGzip, fetchLog);
  const validated = await acquireTypstPackage(SPEC, DISTRIBUTION, validFetch, new AbortController().signal);
  assert.equal(validated.entrypoint, "lib.typ");
  assert.equal(validated.files.length, 3);
  assert.match(validated.packageGeneration, /^[0-9a-f]{64}$/);
  assert.deepEqual(fetchLog, [DISTRIBUTION.url]);
  assert.equal(materializePackageGeneration(validated).internalFiles[1]?.uri.startsWith("mmt-package:/preview/demo/1.2.3/"), true);
  const rootedFiles = parseTarArchive(tar([
    { path: ".", bytes: new Uint8Array(), type: "5" },
    { path: "./typst.toml", bytes: text(MANIFEST) },
    { path: "./lib.typ", bytes: text("#let answer = 42\n") }
  ]));
  assert.deepEqual(rootedFiles.map((file) => file.path), ["lib.typ", "typst.toml"]);
  const officialStyleManifest = MANIFEST.replace('namespace = "preview"\n', "")
    + 'authors = [\n  "One",\n  "Two"\n]\n';
  assert.equal(validateTypstManifest(SPEC, [
    { path: "typst.toml", bytes: text(officialStyleManifest) },
    { path: "lib.typ", bytes: text("#let answer = 42\n") }
  ]), "lib.typ");

  await expectAcquisition("UnsafeRegistry", () => acquireTypstPackage(
    SPEC,
    DISTRIBUTION,
    async () => new Response(null, { status: 302, headers: { location: "https://evil.test/pkg.tar.gz" } }),
    new AbortController().signal
  ));
  await expectAcquisition("UnexpectedStatus", () => acquireTypstPackage(
    SPEC,
    DISTRIBUTION,
    async () => new Response("bad", { status: 500, headers: { "content-type": "application/gzip" } }),
    new AbortController().signal
  ));
  await expectAcquisition("UnexpectedContentType", () => acquireTypstPackage(
    SPEC,
    DISTRIBUTION,
    async () => new Response(validGzip, { status: 200, headers: { "content-type": "text/html" } }),
    new AbortController().signal
  ));
  await expectAcquisition("CompressedLimit", () => acquireTypstPackage(
    SPEC,
    DISTRIBUTION,
    streamingFetch(validGzip),
    new AbortController().signal,
    { ...DEFAULT_TYPST_PACKAGE_LIMITS, compressedBytes: validGzip.byteLength - 1 }
  ));
  await expectAcquisition("IntegrityMismatch", () => acquireTypstPackage(
    SPEC,
    { ...DISTRIBUTION, expectedSize: validGzip.byteLength + 1 },
    streamingFetch(validGzip),
    new AbortController().signal
  ));
  await expectAcquisition("IntegrityMismatch", () => acquireTypstPackage(
    SPEC,
    { ...DISTRIBUTION, expectedSha256: "0".repeat(64) },
    streamingFetch(validGzip),
    new AbortController().signal
  ));

  archiveRejectionFixtures();
  manifestRejectionFixtures();
  await serviceFixtures(validGzip);
  await transitivePackageFixture();
  process.stdout.write(`${JSON.stringify({
    protocol: "mmt/typstPackageRequest.v1",
    context: "mmt/typstPackageContext.v1",
    service: "passed",
    secureArchiveBoundaries: "passed",
    cacheAndRaceBoundaries: "passed",
    backendNetworkPolicy: "host-only"
  }, null, 2)}\n`);
}

function archiveRejectionFixtures(): void {
  expectArchive("UnsafeArchive", tar([{ path: "../../workspace/main.mmt", bytes: text("owned") }]));
  expectArchive("UnsafeArchive", tar([{ path: "/absolute.typ", bytes: text("owned") }]));
  expectArchive("UnsafeArchive", tar([{ path: "C:/drive.typ", bytes: text("owned") }]));
  expectArchive("UnsafeArchive", tar([{ path: "dir\\alternate.typ", bytes: text("owned") }]));
  expectArchive("UnsafeArchive", tar([
    { path: "same.typ", bytes: text("first") },
    { path: "same.typ", bytes: text("second") }
  ]));
  expectArchive("UnsafeArchive", tar([
    { path: "Case.typ", bytes: text("first") },
    { path: "case.typ", bytes: text("second") }
  ]));
  expectArchive("UnsafeArchive", tar([{ path: "link.typ", bytes: new Uint8Array(), type: "2" }]));
  expectArchive("UnsafeArchive", tar([{ path: "hard.typ", bytes: new Uint8Array(), type: "1" }]));
  expectArchive("UnsafeArchive", tar([{ path: "device", bytes: new Uint8Array(), type: "3" }]));
  expectArchive("UnsafeArchive", tar([{ path: "socket", bytes: new Uint8Array(), type: "7" }]));
  expectArchive("ExpandedLimit", tar([{ path: "large.typ", bytes: new Uint8Array(5) }]), {
    ...DEFAULT_TYPST_PACKAGE_LIMITS,
    perFileBytes: 4
  });
  expectArchive("ExpandedLimit", tar([
    { path: "one.typ", bytes: new Uint8Array(3) },
    { path: "two.typ", bytes: new Uint8Array(3) }
  ]), { ...DEFAULT_TYPST_PACKAGE_LIMITS, expandedBytes: 5 });
  expectArchive("ExpandedLimit", tar([
    { path: "one.typ", bytes: new Uint8Array() },
    { path: "two.typ", bytes: new Uint8Array() }
  ]), { ...DEFAULT_TYPST_PACKAGE_LIMITS, fileCount: 1 });
}

function manifestRejectionFixtures(): void {
  const file = (path: string, value: string): ValidatedPackageFile => ({ path, bytes: text(value) });
  assert.throws(() => validateTypstManifest(SPEC, [file("lib.typ", "")]), acquisitionCode("InvalidManifest"));
  assert.throws(() => validateTypstManifest(SPEC, [
    file("typst.toml", MANIFEST.replace('name = "demo"', 'name = "other"')),
    file("lib.typ", "")
  ]), acquisitionCode("InvalidManifest"));
  for (const entrypoint of ["/absolute.typ", "../parent.typ", "missing.typ", "dir"]) {
    const manifest = MANIFEST.replace("lib.typ", entrypoint);
    const files = [file("typst.toml", manifest), file("lib.typ", "")];
    assert.throws(() => validateTypstManifest(SPEC, files), acquisitionCode("InvalidManifest"));
  }
  assert.throws(() => validateTypstManifest(SPEC, [
    file("typst.toml", `${MANIFEST}template-path = "missing-template.typ"\n`),
    file("lib.typ", "")
  ]), acquisitionCode("InvalidManifest"));
}

async function serviceFixtures(validGzip: Uint8Array): Promise<void> {
  const cache = new InMemoryTypstPackageCache();
  let fetches = 0;
  let offline = false;
  const statuses: TypstPackageStatus[] = [];
  const registry: PackageRegistryAdapter = {
    identity: "fixture-registry-v1",
    async resolve(spec, signal) {
      if (signal.aborted) throw signal.reason;
      return spec.namespace === "preview" ? DISTRIBUTION : undefined;
    }
  };
  const service = new TypstPackageService({
    cache,
    registries: [registry],
    offline: () => offline,
    status: (status) => statuses.push(status),
    fetchPackage: async (url, init) => {
      fetches += 1;
      return streamingFetch(validGzip)(url, init);
    }
  });
  service.setBackendGeneration(1);
  const project = fixtureProject("snapshot-ready", "file:///workspace/main.typ");
  service.registerProject(project, 1);
  const ready = await service.resolve(request("ready", 1, project.projectDigest), new AbortController().signal);
  assert.equal(ready.status, "Ready");
  assert.equal(fetches, 1);
  assert.equal(service.dependenciesForProject(project.projectDigest).length, 1);
  assert.equal(statuses.at(-1)?.authoredRange?.start.character, 8);
  const generationBeforeFailures = ready.status === "Ready" ? ready.package_generation : "";
  const prepared = await service.prepareProject(project.projectDigest, new AbortController().signal);
  assert.equal(prepared.length, 1);
  assert.equal(prepared[0]?.packageGeneration, generationBeforeFailures);
  assert.equal(fetches, 1);
  const previewFiles = new Map<string, Uint8Array>();
  const previewRegistry = new TypstPreviewPackageRegistry({
    insertFile(path, data) { previewFiles.set(path, data); },
    removeFile(path) { previewFiles.delete(path); }
  });
  previewRegistry.install(prepared[0]!);
  const previewRoot = previewRegistry.resolve(SPEC);
  assert.ok(previewRoot);
  assert.ok(previewRoot.startsWith("/@memory/"));
  assert.deepEqual(previewFiles.get(`${previewRoot}/lib.typ`), text("#let answer = 42\n"));
  previewRegistry.evict(generationBeforeFailures);
  assert.equal(previewRegistry.resolve(SPEC), undefined);
  assert.equal(previewFiles.size, 0);

  offline = true;
  const offlineCached = await service.resolve(request("offline-cached", 1, project.projectDigest), new AbortController().signal);
  assert.equal(offlineCached.status, "Ready");
  assert.equal(fetches, 1);

  const missingProject = fixtureProject("snapshot-offline", "file:///workspace/offline.typ", "@preview/missing:1.2.3");
  service.registerProject(missingProject, 1);
  const unavailable = await service.resolve({
    ...request("offline-missing", 1, missingProject.projectDigest),
    package_spec: { namespace: "preview", name: "missing", version: "1.2.3" }
  }, new AbortController().signal);
  assert.equal(unavailable.status, "Unavailable");
  assert.equal(fetches, 1);
  offline = false;

  const coalescedCache = new InMemoryTypstPackageCache();
  let coalescedFetches = 0;
  let releaseFetch!: () => void;
  const fetchGate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  const coalesced = new TypstPackageService({
    cache: coalescedCache,
    registries: [registry],
    fetchPackage: async (url, init) => {
      coalescedFetches += 1;
      await fetchGate;
      if (init.signal.aborted) throw init.signal.reason;
      return streamingFetch(validGzip)(url, init);
    }
  });
  coalesced.setBackendGeneration(2);
  const firstProject = fixtureProject("snapshot-a", "file:///workspace/a.typ");
  const secondProject = fixtureProject("snapshot-b", "file:///workspace/b.typ");
  coalesced.registerProject(firstProject, 2);
  coalesced.registerProject(secondProject, 2);
  const firstController = new AbortController();
  const first = coalesced.resolve(request("coalesced-a", 2, firstProject.projectDigest), firstController.signal);
  const second = coalesced.resolve(request("coalesced-b", 2, secondProject.projectDigest), new AbortController().signal);
  await Promise.resolve();
  firstController.abort(new DOMException("project A closed", "AbortError"));
  releaseFetch();
  assert.equal((await first).status, "Cancelled");
  assert.equal((await second).status, "Ready");
  assert.equal(coalescedFetches, 1);

  let releaseRace!: () => void;
  const raceGate = new Promise<void>((resolve) => { releaseRace = resolve; });
  let raceFetches = 0;
  const raceCache = new InMemoryTypstPackageCache();
  const raceService = new TypstPackageService({
    cache: raceCache,
    registries: [registry],
    fetchPackage: async (url, init) => {
      raceFetches += 1;
      await raceGate;
      if (init.signal.aborted) throw init.signal.reason;
      return streamingFetch(validGzip)(url, init);
    }
  });
  raceService.setBackendGeneration(3);
  const raceProject = fixtureProject("snapshot-race", "file:///workspace/race.typ");
  raceService.registerProject(raceProject, 3);
  const raced = raceService.resolve(request("stale-race", 3, raceProject.projectDigest), new AbortController().signal);
  await Promise.resolve();
  raceService.setBackendGeneration(4);
  releaseRace();
  assert.equal((await raced).status, "Cancelled");
  assert.equal(await raceCache.active(SPEC), undefined);
  assert.equal(raceFetches, 1);

  const activeAfterFailures = await cache.active(SPEC);
  assert.equal(activeAfterFailures?.packageGeneration, generationBeforeFailures);
  const readOnlyBytes = await cache.read(activeAfterFailures!.internalFiles[1]!.uri);
  assert.deepEqual(readOnlyBytes, activeAfterFailures!.internalFiles[1]!.bytes);
  readOnlyBytes![0] ^= 0xff;
  assert.notDeepEqual(readOnlyBytes, await cache.read(activeAfterFailures!.internalFiles[1]!.uri));
  const replacement = fixtureProject("snapshot-replacement", project.sourceUri);
  service.registerProject(replacement, 1);
  assert.equal(
    (await service.resolve(request("retired-source-snapshot", 1, project.projectDigest), new AbortController().signal)).status,
    "Cancelled"
  );
}

async function transitivePackageFixture(): Promise<void> {
  const dependency: PackageSpec = Object.freeze({ namespace: "preview", name: "child", version: "2.0.0" });
  const urlFor = (spec: PackageSpec) => `https://packages.test/${spec.namespace}/${spec.name}-${spec.version}.tar.gz`;
  const archiveFor = (spec: PackageSpec, source: string) => new Uint8Array(gzipSync(tar([
    {
      path: "typst.toml",
      bytes: text(`[package]\nnamespace = "${spec.namespace}"\nname = "${spec.name}"\nversion = "${spec.version}"\nentrypoint = "lib.typ"\n`)
    },
    { path: "lib.typ", bytes: text(source) }
  ])));
  const archives = new Map([
    [urlFor(SPEC), archiveFor(SPEC, '#import "@preview/child:2.0.0": value\n#let answer = value\n')],
    [urlFor(dependency), archiveFor(dependency, "#let value = 42\n")]
  ]);
  const fetches: string[] = [];
  const service = new TypstPackageService({
    cache: new InMemoryTypstPackageCache(),
    registries: [{
      identity: "transitive-fixture-registry-v1",
      async resolve(spec, signal) {
        if (signal.aborted) throw signal.reason;
        const url = urlFor(spec);
        return archives.has(url) ? {
          registryId: "transitive-fixture-registry-v1",
          url,
          allowedHosts: new Set(["packages.test"]),
          contentTypes: ["application/gzip"]
        } : undefined;
      }
    }],
    fetchPackage: async (url, init) => {
      const archive = archives.get(url);
      if (!archive) return new Response(null, { status: 404 });
      fetches.push(url);
      return streamingFetch(archive)(url, init);
    }
  });
  service.setBackendGeneration(1);
  const project = fixtureProject("snapshot-transitive", "file:///workspace/transitive.typ");
  service.registerProject(project, 1);
  const prepared = await service.prepareProject(project.projectDigest, new AbortController().signal);
  assert.deepEqual(prepared.map((generation) => generation.spec.name), ["demo", "child"]);
  assert.deepEqual(fetches, [urlFor(SPEC), urlFor(dependency)]);
  assert.equal(service.dependenciesForProject(project.projectDigest).length, 2);
}

function fixtureProject(snapshot: string, sourceUri: string, source = "#import @preview/demo:1.2.3: answer\n"): TypstProjectUpdate {
  return {
    sourceUri,
    sourceVersion: 1,
    revision: 1,
    entryUri: sourceUri,
    files: [{ uri: sourceUri, text: source }],
    full: true,
    sourceContent: `content-${snapshot}` as TypstProjectUpdate["sourceContent"],
    projectDigest: snapshot as TypstProjectUpdate["projectDigest"],
    projectionKey: `projection-${snapshot}` as TypstProjectUpdate["projectionKey"],
    mappingDigest: `mapping-${snapshot}`
  };
}

function request(id: string, generation: number, snapshot: string): TypstPackageRequestParams {
  return {
    request_id: id,
    backend_generation: generation,
    typst_project_snapshot_key: snapshot,
    package_spec: SPEC
  };
}

function streamingFetch(bytes: Uint8Array, log: string[] = []): PackageFetch {
  return async (url, init) => {
    log.push(url);
    const midpoint = Math.max(1, Math.floor(bytes.byteLength / 2));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        if (init.signal.aborted) {
          controller.error(init.signal.reason);
          return;
        }
        controller.enqueue(bytes.slice(0, midpoint));
        controller.enqueue(bytes.slice(midpoint));
        controller.close();
      }
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/gzip",
        "content-length": String(bytes.byteLength)
      }
    });
  };
}

function expectArchive(code: TypstPackageAcquisitionError["code"], bytes: Uint8Array, limits = DEFAULT_TYPST_PACKAGE_LIMITS): void {
  assert.throws(() => parseTarArchive(bytes, limits), acquisitionCode(code));
}

async function expectAcquisition(code: TypstPackageAcquisitionError["code"], operation: () => Promise<unknown>): Promise<void> {
  await assert.rejects(operation, acquisitionCode(code));
}

function acquisitionCode(code: TypstPackageAcquisitionError["code"]): (error: unknown) => boolean {
  return (error) => error instanceof TypstPackageAcquisitionError && error.code === code;
}

interface TarEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly type?: string;
}

function tar(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    writeAscii(header, 0, 100, entry.path);
    writeOctal(header, 100, 8, 0o644);
    writeOctal(header, 108, 8, 0);
    writeOctal(header, 116, 8, 0);
    writeOctal(header, 124, 12, entry.bytes.byteLength);
    writeOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = (entry.type ?? "0").charCodeAt(0);
    writeAscii(header, 257, 6, "ustar");
    writeAscii(header, 263, 2, "00");
    const checksum = header.reduce((total, value) => total + value, 0);
    writeOctal(header, 148, 8, checksum);
    blocks.push(header, entry.bytes);
    const padding = (512 - entry.bytes.byteLength % 512) % 512;
    if (padding > 0) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024));
  const length = blocks.reduce((total, block) => total + block.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.byteLength;
  }
  return output;
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = text(value);
  if (bytes.byteLength > length) throw new Error("Tar fixture field is too long");
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 2, "0");
  writeAscii(target, offset, length - 1, encoded);
  target[offset + length - 1] = 0;
}

function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
