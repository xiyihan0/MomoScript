import { packageSpecKey, type PackageSpec } from "./typstPackageProtocol";
import type { TypstPackageGeneration } from "./typstPackageService";

export interface PreviewPackageAccessModel {
  insertFile(path: string, data: Uint8Array, mtime: Date): void;
  removeFile(path: string): void;
}

interface InstalledPackageGeneration {
  readonly generation: string;
  readonly root: string;
  readonly files: readonly string[];
}

const PACKAGE_MTIME = new Date(0);

export class TypstPreviewPackageRegistry {
  readonly #accessModel: PreviewPackageAccessModel;
  readonly #installed = new Map<string, InstalledPackageGeneration>();

  constructor(accessModel: PreviewPackageAccessModel) {
    this.#accessModel = accessModel;
  }

  install(generation: TypstPackageGeneration): void {
    const key = packageSpecKey(generation.spec);
    const current = this.#installed.get(key);
    if (current?.generation === generation.packageGeneration) return;
    if (current) this.remove(current);
    const root = `/@memory/mmt-packages/${generation.spec.namespace}/${generation.spec.name}/${generation.spec.version}/${generation.packageGeneration}`;
    const files = generation.files.map((file) => `${root}/${file.path}`);
    for (let index = 0; index < generation.files.length; index += 1) {
      this.#accessModel.insertFile(files[index]!, generation.files[index]!.bytes, PACKAGE_MTIME);
    }
    this.#installed.set(key, Object.freeze({
      generation: generation.packageGeneration,
      root,
      files: Object.freeze(files)
    }));
  }

  evict(packageGeneration: string): void {
    for (const [key, installed] of this.#installed) {
      if (installed.generation !== packageGeneration) continue;
      this.remove(installed);
      this.#installed.delete(key);
    }
  }

  resolve(spec: PackageSpec): string | undefined {
    return this.#installed.get(packageSpecKey(spec))?.root;
  }

  private remove(installed: InstalledPackageGeneration): void {
    for (const path of installed.files) this.#accessModel.removeFile(path);
  }
}
