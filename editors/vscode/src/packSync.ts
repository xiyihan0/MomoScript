export interface PackManifestSource {
  manifestUrl: string;
  baseUrl: string;
  json: string;
}

export interface PackFetchResponse {
  status: number;
  ok: boolean;
  etag: string | undefined;
  text(): Promise<string>;
}

export interface PackCacheStore {
  read(url: string): Promise<string | undefined>;
  stage(url: string, revision: number, json: string): Promise<void>;
  promote(url: string, revision: number): Promise<void>;
  discard(url: string, revision: number): Promise<void>;
  getEtag(url: string): string | undefined;
  setEtag(url: string, etag: string | undefined): Promise<void>;
}

interface StagedSource {
  url: string;
  etag: string | undefined;
}

export async function synchronizePackSources(
  urls: string[],
  revision: number,
  cache: PackCacheStore,
  request: (params: { revision: number; sources: PackManifestSource[] }) => Promise<{
    revision: number;
    updated: boolean;
  }>,
  fetchManifest: (url: string, etag: string | undefined) => Promise<PackFetchResponse>
): Promise<PackManifestSource[]> {
  const sources: PackManifestSource[] = [];
  const staged: StagedSource[] = [];
  try {
    for (const value of urls) {
      const manifestUrl = new URL(value);
      if (manifestUrl.protocol !== "https:") {
        throw new Error(`Remote pack manifest must use HTTPS: ${value}`);
      }
      const currentEtag = cache.getEtag(manifestUrl.href);
      let json: string;
      try {
        const response = await fetchManifest(manifestUrl.href, currentEtag);
        if (response.status === 304) {
          const cached = await cache.read(manifestUrl.href);
          if (cached === undefined) throw new Error("HTTP 304 without a cached manifest");
          json = cached;
        } else {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          json = await response.text();
          await cache.stage(manifestUrl.href, revision, json);
          staged.push({ url: manifestUrl.href, etag: response.etag });
        }
      } catch (error) {
        const cached = await cache.read(manifestUrl.href);
        if (cached === undefined) {
          throw new Error(
            `Unable to load pack manifest ${manifestUrl.href}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
        json = cached;
      }
      sources.push({
        manifestUrl: manifestUrl.href,
        baseUrl: new URL(".", manifestUrl).href,
        json
      });
    }

    const result = await request({ revision, sources });
    if (result.revision !== revision || !result.updated) {
      throw new Error(`Pack registry update ${revision} was not accepted`);
    }
    for (const source of staged) {
      await cache.promote(source.url, revision);
      await cache.setEtag(source.url, source.etag);
    }
    return sources;
  } catch (error) {
    await Promise.all(staged.map((source) => cache.discard(source.url, revision)));
    throw error;
  }
}
