import type { WorkspaceEntry } from "./workspace";

export interface WebDavProfile { readonly id: string; readonly rootUrl: string }
export interface WebDavCredentials { readonly username: string; readonly password: string }
export interface WebDavRemoteEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly etag?: string;
  readonly size?: number;
  readonly modified?: string;
  readonly bytes?: Uint8Array;
}
export interface SyncBaselineEntry { readonly localDigest?: string; readonly remoteValidator?: string }
export interface SyncPlanItem {
  readonly path: string;
  readonly action: "upload" | "download" | "delete-local" | "delete-remote" | "conflict" | "unchanged";
  readonly local?: WorkspaceEntry;
  readonly remote?: WebDavRemoteEntry;
  readonly baseline?: SyncBaselineEntry;
  readonly unsafe: boolean;
}

export class WebDavConnector {
  readonly root: URL;
  readonly authorization: string;

  constructor(readonly profile: WebDavProfile, credentials: WebDavCredentials) {
    this.root = validateRoot(profile.rootUrl);
    this.authorization = `Basic ${btoa(`${credentials.username}:${credentials.password}`)}`;
  }

  async probe(signal?: AbortSignal): Promise<void> {
    const response = await this.request("", { method: "OPTIONS", signal });
    if (!response.ok) throw new Error(`WebDAV probe failed: HTTP ${response.status}`);
    const dav = response.headers.get("dav") ?? "";
    if (!dav) throw new Error("Server did not advertise WebDAV capability");
  }

  async list(signal?: AbortSignal): Promise<readonly WebDavRemoteEntry[]> {
    const response = await this.request("", {
      method: "PROPFIND",
      headers: { Depth: "infinity", "Content-Type": "application/xml; charset=utf-8" },
      body: "<?xml version=\"1.0\"?><d:propfind xmlns:d=\"DAV:\"><d:prop><d:resourcetype/><d:getetag/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>",
      signal
    });
    if (response.status !== 207) throw new Error(`WebDAV listing failed: HTTP ${response.status}`);
    const xml = new DOMParser().parseFromString(await response.text(), "application/xml");
    if (xml.querySelector("parsererror")) throw new Error("WebDAV listing returned malformed XML");
    const entries: WebDavRemoteEntry[] = [];
    for (const node of xml.getElementsByTagNameNS("DAV:", "response")) {
      const href = node.getElementsByTagNameNS("DAV:", "href")[0]?.textContent;
      if (!href) continue;
      const url = new URL(href, this.root);
      assertWithinRoot(this.root, url);
      const relative = url.pathname.slice(this.root.pathname.length).replace(/^\/+/, "");
      if (!relative) continue;
      const path = decodeRemoteHrefPath(relative);
      const collection = node.getElementsByTagNameNS("DAV:", "collection").length > 0;
      entries.push({
        path,
        kind: collection ? "directory" : "file",
        etag: text(node, "getetag"),
        size: number(text(node, "getcontentlength")),
        modified: text(node, "getlastmodified")
      });
    }
    return entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  }

  async download(path: string, expectedEtag?: string, signal?: AbortSignal): Promise<WebDavRemoteEntry> {
    const response = await this.request(path, {
      method: "GET",
      headers: expectedEtag ? { "If-Match": expectedEtag } : undefined,
      signal
    });
    if (response.status === 412) throw new WebDavConflict(path, "Remote validator changed");
    if (!response.ok) throw new Error(`WebDAV download failed: HTTP ${response.status}`);
    return {
      path: normalizeRemotePath(path), kind: "file", etag: response.headers.get("etag") ?? undefined,
      size: Number(response.headers.get("content-length")) || undefined,
      modified: response.headers.get("last-modified") ?? undefined,
      bytes: new Uint8Array(await response.arrayBuffer())
    };
  }

  async upload(path: string, bytes: Uint8Array, validator: string | undefined, create: boolean, signal?: AbortSignal): Promise<string | undefined> {
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (create) headers["If-None-Match"] = "*";
    else if (validator) headers["If-Match"] = validator;
    const response = await this.request(path, { method: "PUT", headers, body: bytes.slice().buffer as ArrayBuffer, signal });
    if (response.status === 409 || response.status === 412) throw new WebDavConflict(path, `Remote write conflict: HTTP ${response.status}`);
    if (!response.ok) throw new Error(`WebDAV upload failed: HTTP ${response.status}`);
    return response.headers.get("etag") ?? undefined;
  }

  async delete(path: string, validator?: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(path, { method: "DELETE", headers: validator ? { "If-Match": validator } : undefined, signal });
    if (response.status === 409 || response.status === 412) throw new WebDavConflict(path, `Remote delete conflict: HTTP ${response.status}`);
    if (!response.ok && response.status !== 404) throw new Error(`WebDAV delete failed: HTTP ${response.status}`);
  }

  async move(from: string, to: string, validator?: string, signal?: AbortSignal): Promise<void> {
    const destination = remoteUrl(this.root, to);
    assertWithinRoot(this.root, destination);
    const headers: Record<string, string> = { Destination: destination.href, Overwrite: "F" };
    if (validator) headers["If-Match"] = validator;
    const response = await this.request(from, { method: "MOVE", headers, signal });
    if (response.status === 409 || response.status === 412) throw new WebDavConflict(from, `Remote move conflict: HTTP ${response.status}`);
    if (!response.ok) throw new Error(`WebDAV move failed: HTTP ${response.status}`);
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = remoteUrl(this.root, path);
    assertWithinRoot(this.root, url);
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      credentials: "omit",
      headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: this.authorization }
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw new Error("WebDAV redirects are not allowed");
    if (response.url) assertWithinRoot(this.root, new URL(response.url));
    return response;
  }
}

export async function planWebDavSync(
  localEntries: readonly WorkspaceEntry[],
  remoteEntries: readonly WebDavRemoteEntry[],
  baseline: ReadonlyMap<string, SyncBaselineEntry>
): Promise<readonly SyncPlanItem[]> {
  const local = new Map(localEntries.filter((entry) => entry.type === 1).map((entry) => [entry.path.replace(/^\//, ""), entry]));
  const remote = new Map(remoteEntries.filter((entry) => entry.kind === "file").map((entry) => [entry.path, entry]));
  const paths = [...new Set([...local.keys(), ...remote.keys(), ...baseline.keys()])].sort();
  const plan: SyncPlanItem[] = [];
  for (const path of paths) {
    const localEntry = local.get(path);
    const remoteEntry = remote.get(path);
    const base = baseline.get(path);
    const localDigest = localEntry ? await digest(localEntry.data) : undefined;
    const localChanged = localDigest !== base?.localDigest;
    const remoteChanged = remoteEntry?.etag !== base?.remoteValidator;
    const unsafe = !!remoteEntry && !remoteEntry.etag;
    let action: SyncPlanItem["action"];
    if (localChanged && remoteChanged) action = "conflict";
    else if (localChanged) action = localEntry ? "upload" : "delete-remote";
    else if (remoteChanged) action = remoteEntry ? "download" : "delete-local";
    else action = "unchanged";
    plan.push({ path, action, local: localEntry, remote: remoteEntry, baseline: base, unsafe });
  }
  return plan;
}

export class WebDavConflict extends Error {
  constructor(readonly path: string, message: string) { super(message); this.name = "WebDavConflict"; }
}

function validateRoot(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) throw new Error("WebDAV requires HTTPS except on loopback");
  url.hash = ""; url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
function assertWithinRoot(root: URL, candidate: URL): void {
  if (candidate.origin !== root.origin || !candidate.pathname.startsWith(root.pathname)) throw new Error("WebDAV URL escaped configured root");
}
function normalizeRemotePath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"))) throw new Error(`Unsafe WebDAV path: ${path}`);
  return segments.join("/");
}
function remoteUrl(root: URL, path: string): URL {
  const logical = normalizeRemotePath(path);
  return new URL(logical.split("/").map(encodeURIComponent).join("/"), root);
}
function decodeRemoteHrefPath(path: string): string {
  const decoded = path.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  if (decoded.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("/") || segment.includes("\\") || segment.includes("\0"))) {
    throw new Error(`Unsafe encoded WebDAV path: ${path}`);
  }
  return decoded.join("/");
}
function text(node: Element, name: string): string | undefined { return node.getElementsByTagNameNS("DAV:", name)[0]?.textContent ?? undefined; }
function number(value: string | undefined): number | undefined { const result = Number(value); return Number.isFinite(result) ? result : undefined; }
async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer);
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
