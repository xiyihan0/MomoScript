import * as vscode from "vscode";
import type { BaseLanguageClient } from "vscode-languageclient";

import { synchronizePackSources, type PackCacheStore, type PackManifestSource } from "./packSync";

const DEFAULT_MANIFEST_URL = "https://mms-pack.xiyihan.cn/ba_kivo/manifest.json";
const REVISION_KEY = "mmt.resourcePacks.revision";

class VsCodePackCache implements PackCacheStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async read(url: string): Promise<string | undefined> {
    const uri = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      `pack-${encodeURIComponent(url)}.json`
    );
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return undefined;
    }
  }

  async stage(url: string, revision: number, json: string): Promise<void> {
    await vscode.workspace.fs.writeFile(
      this.stagingUri(url, revision),
      new TextEncoder().encode(json)
    );
  }

  async promote(url: string, revision: number): Promise<void> {
    const target = vscode.Uri.joinPath(
      this.context.globalStorageUri,
      `pack-${encodeURIComponent(url)}.json`
    );
    await vscode.workspace.fs.rename(this.stagingUri(url, revision), target, {
      overwrite: true
    });
  }

  async discard(url: string, revision: number): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.stagingUri(url, revision));
    } catch {
      // Missing staging files require no cleanup.
    }
  }

  getEtag(url: string): string | undefined {
    return this.context.globalState.get<string>(`mmt.resourcePacks.etag.${url}`);
  }

  async setEtag(url: string, etag: string | undefined): Promise<void> {
    await this.context.globalState.update(`mmt.resourcePacks.etag.${url}`, etag);
  }

  private stagingUri(url: string, revision: number): vscode.Uri {
    return vscode.Uri.joinPath(
      this.context.globalStorageUri,
      `pack-${encodeURIComponent(url)}.json.staging-${revision}`
    );
  }
}

export async function syncConfiguredPackManifests(
  context: vscode.ExtensionContext,
  client: BaseLanguageClient
): Promise<PackManifestSource[]> {
  const configured = vscode.workspace
    .getConfiguration("mmt")
    .get<string[]>("resourcePacks.manifestUrls", [DEFAULT_MANIFEST_URL]);
  const urls = configured.length > 0 ? configured : [DEFAULT_MANIFEST_URL];
  const revision = context.globalState.get<number>(REVISION_KEY, 0) + 1;
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);

  const sources = await synchronizePackSources(
    urls,
    revision,
    new VsCodePackCache(context),
    (params) => client.sendRequest("mmt/updatePackManifests", params),
    async (url, etag) => {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (etag !== undefined) headers["If-None-Match"] = etag;
      const response = await fetch(url, { headers });
      return {
        status: response.status,
        ok: response.ok,
        etag: response.headers.get("etag") ?? undefined,
        text: () => response.text()
      };
    }
  );
  await context.globalState.update(REVISION_KEY, revision);
  for (const url of urls) {
    await context.globalState.update(`mmt.resourcePacks.cache.${new URL(url).href}`, undefined);
  }
  return sources;
}
