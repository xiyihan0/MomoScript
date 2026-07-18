import type { PackageDistribution, PackageFetch, PackageRegistryAdapter } from "../typstPackageArchive";
import type { TypstProjectUpdate } from "../tinymistClient";
import { InMemoryTypstPackageCache, TypstPackageService } from "../typstPackageService";
import type { TypstPackageRequestParams, TypstPackageResponse } from "../typstPackageProtocol";

const REGISTRY_HOST = "packages.transcript.test";

export class PackageTranscriptHost {
  readonly #service: TypstPackageService;

  constructor() {
    const registry: PackageRegistryAdapter = {
      identity: "transcript-registry-v1",
      async resolve(spec, signal): Promise<PackageDistribution | undefined> {
        if (signal.aborted) throw signal.reason;
        if (spec.namespace !== "preview") return undefined;
        return {
          registryId: "transcript-registry-v1",
          url: `https://${REGISTRY_HOST}/${spec.name}-${spec.version}.tar`,
          allowedHosts: new Set([REGISTRY_HOST]),
          contentTypes: ["application/x-tar"]
        };
      }
    };
    const fetchPackage: PackageFetch = async (url, init) => {
      const name = /\/([^/]+)-1\.0\.0\.tar$/.exec(new URL(url).pathname)?.[1] ?? "invalid";
      if (name === "mmt-callback-cancel") {
        return await new Promise<Response>((_resolve, reject) => {
          const abort = () => reject(init.signal.reason ?? new DOMException("cancelled", "AbortError"));
          if (init.signal.aborted) abort();
          else init.signal.addEventListener("abort", abort, { once: true });
        });
      }
      if (name === "mmt-callback-unavailable") {
        return new Response(null, { status: 404, headers: { "content-type": "application/x-tar" } });
      }
      const manifestName = name === "mmt-callback-error" ? "different-package" : name;
      const manifest = `[package]\nnamespace = "preview"\nname = "${manifestName}"\nversion = "1.0.0"\nentrypoint = "lib.typ"\nauthors = ["MMT"]\n`;
      const bytes = tar([
        { path: "typst.toml", bytes: new TextEncoder().encode(manifest) },
        { path: "lib.typ", bytes: new TextEncoder().encode("#let value = [host-ready]\n") }
      ]);
      return new Response(bytes.slice().buffer as ArrayBuffer, {
        status: 200,
        headers: {
          "content-type": "application/x-tar",
          "content-length": String(bytes.byteLength)
        }
      });
    };
    this.#service = new TypstPackageService({
      cache: new InMemoryTypstPackageCache(),
      registries: [registry],
      fetchPackage,
      offline: () => false
    });
  }

  setContext(backendGeneration: number, snapshot: string, packageName: string): void {
    this.#service.setBackendGeneration(backendGeneration);
    const sourceUri = `file:///transcript/${packageName}.typ`;
    const project: TypstProjectUpdate = {
      sourceUri,
      sourceVersion: backendGeneration,
      revision: backendGeneration,
      entryUri: sourceUri,
      files: [{ uri: sourceUri, text: `#import "@preview/${packageName}:1.0.0": value\n#value` }],
      full: true,
      sourceContent: `content-${snapshot}` as TypstProjectUpdate["sourceContent"],
      projectDigest: snapshot as TypstProjectUpdate["projectDigest"],
      projectionKey: `projection-${snapshot}` as TypstProjectUpdate["projectionKey"],
      mappingDigest: `mapping-${snapshot}`
    };
    this.#service.registerProject(project, backendGeneration);
  }

  resolve(params: TypstPackageRequestParams, signal: AbortSignal): Promise<TypstPackageResponse> {
    return this.#service.resolve(params, signal);
  }
}

interface TarEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
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
    header[156] = "0".charCodeAt(0);
    writeAscii(header, 257, 6, "ustar");
    writeAscii(header, 263, 2, "00");
    writeOctal(header, 148, 8, header.reduce((total, value) => total + value, 0));
    blocks.push(header, entry.bytes);
    const padding = (512 - entry.bytes.byteLength % 512) % 512;
    if (padding > 0) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024));
  const output = new Uint8Array(blocks.reduce((total, block) => total + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    output.set(block, offset);
    offset += block.byteLength;
  }
  return output;
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > length) throw new Error("Transcript tar field is too long");
  target.set(bytes, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  writeAscii(target, offset, length - 1, value.toString(8).padStart(length - 2, "0"));
  target[offset + length - 1] = 0;
}
