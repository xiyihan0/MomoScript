import type { Disposable, TextDocumentContentProvider, Uri } from "vscode";

export interface RetainedProjectionFile {
  readonly uri: string;
  readonly text?: string | null;
}

export interface RetainedProjectionGeneration {
  readonly sourceUri: string;
  readonly revision: number;
  readonly projectionKey: string;
  readonly files: readonly RetainedProjectionFile[];
}

export interface RetainedPackageGeneration {
  readonly generationDigest: string;
  readonly files: readonly { readonly uri: string; readonly text: string }[];
}

interface ProjectionGenerationRecord {
  readonly key: string;
  readonly uris: readonly string[];
}

interface ImmutableTextRecord {
  readonly text: string;
  readonly generations: Set<string>;
}

const MAX_PROJECTION_GENERATIONS = 3;

/**
 * Immutable retained bytes behind mmt-projection: and mmt-package: URIs.
 * Projection generations keep current plus two predecessors; package bytes are
 * visible only while at least one active project names their generation.
 */
export class RetainedVirtualDocumentStore {
  private readonly projectionText = new Map<string, ImmutableTextRecord>();
  private readonly projectionsBySource = new Map<string, ProjectionGenerationRecord[]>();
  private readonly packageText = new Map<string, { readonly text: string; readonly generation: string }>();
  private readonly packageUrisByGeneration = new Map<string, Set<string>>();
  private readonly packageDependenciesByProject = new Map<string, Set<string>>();

  retainProjection(generation: RetainedProjectionGeneration): void {
    if (!Number.isSafeInteger(generation.revision) || generation.revision < 0) {
      throw new Error("Invalid projection revision");
    }
    const key = `${generation.projectionKey}\0${generation.revision}`;
    const records = this.projectionsBySource.get(generation.sourceUri) ?? [];
    if (records.some((record) => record.key === key)) return;
    const files = generation.files
      .filter((file): file is RetainedProjectionFile & { readonly text: string } =>
        typeof file.text === "string")
      .map((file) => ({ uri: projectionReadUri(file.uri), text: file.text }));
    for (const file of files) {
      const existing = this.projectionText.get(file.uri);
      if (existing && existing.text !== file.text) {
        throw new Error(`Immutable projection URI changed content: ${file.uri}`);
      }
    }
    const uris: string[] = [];
    for (const file of files) {
      const existing = this.projectionText.get(file.uri);
      if (existing) existing.generations.add(key);
      else this.projectionText.set(file.uri, { text: file.text, generations: new Set([key]) });
      uris.push(file.uri);
    }
    records.push({ key, uris });
    while (records.length > MAX_PROJECTION_GENERATIONS) {
      this.releaseProjectionGeneration(records.shift()!);
    }
    this.projectionsBySource.set(generation.sourceUri, records);
  }

  closeProjectionSource(sourceUri: string): void {
    const records = this.projectionsBySource.get(sourceUri);
    if (!records) return;
    for (const record of records) this.releaseProjectionGeneration(record);
    this.projectionsBySource.delete(sourceUri);
  }

  projectionContent(uri: string): string | undefined {
    return this.projectionText.get(uri)?.text;
  }

  retainPackage(generation: RetainedPackageGeneration): void {
    if (!generation.generationDigest) throw new Error("Package generation digest is required");
    const uris = this.packageUrisByGeneration.get(generation.generationDigest) ?? new Set<string>();
    const files = generation.files.map((file) => {
      const parsed = new URL(file.uri);
      if (parsed.protocol !== "mmt-package:") throw new Error(`Not a package URI: ${file.uri}`);
      if (parsed.searchParams.get("digest") !== generation.generationDigest) {
        throw new Error(`Package URI does not bind generation digest: ${file.uri}`);
      }
      return { uri: parsed.toString(), text: file.text };
    });
    for (const file of files) {
      const existing = this.packageText.get(file.uri);
      if (existing && (existing.text !== file.text || existing.generation !== generation.generationDigest)) {
        throw new Error(`Immutable package URI changed content: ${file.uri}`);
      }
    }
    for (const file of files) {
      this.packageText.set(file.uri, { text: file.text, generation: generation.generationDigest });
      uris.add(file.uri);
    }
    this.packageUrisByGeneration.set(generation.generationDigest, uris);
  }

  setActivePackageDependencies(projectSnapshot: string, generationDigests: Iterable<string>): void {
    this.packageDependenciesByProject.set(projectSnapshot, new Set(generationDigests));
  }

  closeProject(projectSnapshot: string): void {
    this.packageDependenciesByProject.delete(projectSnapshot);
  }

  retirePackageGeneration(generationDigest: string): void {
    const uris = this.packageUrisByGeneration.get(generationDigest);
    if (uris) for (const uri of uris) this.packageText.delete(uri);
    this.packageUrisByGeneration.delete(generationDigest);
    for (const dependencies of this.packageDependenciesByProject.values()) {
      dependencies.delete(generationDigest);
    }
  }

  packageContent(uri: string): string | undefined {
    let normalized: string;
    try {
      normalized = new URL(uri).toString();
    } catch {
      return undefined;
    }
    const record = this.packageText.get(normalized);
    if (!record) return undefined;
    for (const dependencies of this.packageDependenciesByProject.values()) {
      if (dependencies.has(record.generation)) return record.text;
    }
    return undefined;
  }

  private releaseProjectionGeneration(record: ProjectionGenerationRecord): void {
    for (const uri of record.uris) {
      const content = this.projectionText.get(uri);
      if (!content) continue;
      content.generations.delete(record.key);
      if (content.generations.size === 0) this.projectionText.delete(uri);
    }
  }
}

export class ProjectionTextDocumentContentProvider implements TextDocumentContentProvider {
  constructor(private readonly store: RetainedVirtualDocumentStore) {}

  provideTextDocumentContent(uri: Uri): string {
    const content = this.store.projectionContent(uri.toString(true));
    if (content === undefined) throw new Error(`Projection generation is not retained: ${uri.toString(true)}`);
    return content;
  }
}

export class PackageTextDocumentContentProvider implements TextDocumentContentProvider {
  constructor(private readonly store: RetainedVirtualDocumentStore) {}

  provideTextDocumentContent(uri: Uri): string {
    const content = this.store.packageContent(uri.toString(true));
    if (content === undefined) throw new Error(`Package is not an active dependency: ${uri.toString(true)}`);
    return content;
  }
}

export interface TextDocumentContentProviderRegistry {
  registerTextDocumentContentProvider(scheme: string, provider: TextDocumentContentProvider): Disposable;
}

export function registerVirtualTypstContentProviders(
  registry: TextDocumentContentProviderRegistry,
  store: RetainedVirtualDocumentStore
): readonly Disposable[] {
  return [
    registry.registerTextDocumentContentProvider(
      "mmt-projection",
      new ProjectionTextDocumentContentProvider(store)
    ),
    registry.registerTextDocumentContentProvider(
      "mmt-package",
      new PackageTextDocumentContentProvider(store)
    )
  ];
}

export function projectionReadUri(backendUri: string): string {
  const parsed = new URL(backendUri);
  parsed.protocol = "mmt-projection:";
  return parsed.toString();
}
