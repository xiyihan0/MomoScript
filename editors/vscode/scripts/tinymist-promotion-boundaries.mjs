import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function pinnedTinymistSource(pin) {
  if (pin?.schema !== "mmt-tinymist-pin.v2" || Object.hasOwn(pin, "patches")) {
    throw new Error("Tinymist source requires a patch-free mmt-tinymist-pin.v2 pin");
  }
  const repository = pin?.source?.repository;
  const revision = pin?.source?.revision;
  let repositoryUrl;
  try {
    repositoryUrl = new URL(repository);
  } catch {
    throw new Error("Tinymist source repository is not a valid URL");
  }
  if (repositoryUrl.protocol !== "https:" || repositoryUrl.hostname !== "github.com"
    || repositoryUrl.search || repositoryUrl.hash || !repositoryUrl.pathname.endsWith(".git")
    || !/^\/[^/]+\/[^/]+\.git$/.test(repositoryUrl.pathname)) {
    throw new Error("Tinymist source repository must be an HTTPS GitHub clone URL");
  }
  if (!/^[0-9a-f]{40}$/.test(revision ?? "")) {
    throw new Error("Tinymist source revision must be a full Git commit SHA");
  }
  return Object.freeze({ repository, revision });
}

export function requirePinnedTinymistCheckout(pin, actualHead, trackedStatus) {
  const source = pinnedTinymistSource(pin);
  if (actualHead.trim() !== source.revision) {
    throw new Error(`Tinymist HEAD ${actualHead.trim()} does not match source revision ${source.revision}`);
  }
  if (trackedStatus.trim()) {
    throw new Error("Tinymist checkout has tracked source changes");
  }
  return source;
}

export function pinnedTinymistUpstream(pin) {
  const repository = pin?.upstream?.repository;
  const revision = pin?.upstream?.revision;
  const version = pin?.upstream?.version;
  let repositoryUrl;
  try {
    repositoryUrl = new URL(repository);
  } catch {
    throw new Error("Tinymist upstream repository is not a valid URL");
  }
  const repositoryPath = repositoryUrl.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  if (repositoryUrl.protocol !== "https:" || repositoryUrl.hostname !== "github.com"
    || repositoryUrl.username || repositoryUrl.password || repositoryUrl.port
    || repositoryUrl.search || repositoryUrl.hash
    || !/^\/[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repositoryPath)) {
    throw new Error("Tinymist upstream repository must be an HTTPS GitHub repository URL");
  }
  if (!/^[0-9a-f]{40}$/.test(revision ?? "")) {
    throw new Error("Tinymist upstream revision must be a full lowercase Git commit SHA");
  }
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version ?? "")) {
    throw new Error("Tinymist upstream version must be a valid release version");
  }
  return Object.freeze({ repository, revision, version });
}

export function trustedTinymistVsix(pin) {
  const { repository, version } = pinnedTinymistUpstream(pin);
  const release = pin?.release;
  const asset = release?.universalVsix;
  if (release?.tag !== `v${version}`) {
    throw new Error("Tinymist universal VSIX release tag does not match the maintained upstream version");
  }
  if (asset?.name !== "tinymist-universal.vsix" || !/^[0-9a-f]{64}$/.test(asset?.sha256 ?? "")) {
    throw new Error("Tinymist universal VSIX has no trusted release asset identity");
  }

  const repositoryUrl = new URL(repository);
  const repositoryPath = repositoryUrl.pathname.replace(/\/$/, "").replace(/\.git$/, "");
  return Object.freeze({
    version,
    tag: release.tag,
    assetName: asset.name,
    sha256: asset.sha256,
    releaseUrl: `${repositoryUrl.origin}${repositoryPath}/releases/download/${release.tag}/${asset.name}`
  });
}

export function tinymistGrammarNotice(provenance) {
  return [
    `typst.tmLanguage.json was extracted from the Tinymist v${provenance.version} universal VSIX:`,
    provenance.releaseUrl,
    `VSIX SHA-256: ${provenance.sha256}`,
    "",
    "Tinymist is licensed under Apache-2.0. See LICENSE in this directory.",
    ""
  ].join("\n");
}

export function requireTrustedTinymistGrammarNotice(notice, pin) {
  const expected = tinymistGrammarNotice(trustedTinymistVsix(pin));
  if (notice !== expected) {
    throw new Error("Tinymist grammar notice does not match the trusted universal VSIX pin");
  }
}

export async function readTrustedTinymistVsix(filename, pin, extractMember) {
  if (typeof extractMember !== "function") throw new TypeError("extractMember must be a function");
  const provenance = trustedTinymistVsix(pin);
  const resolved = path.resolve(filename);
  const bytes = await readFile(resolved);
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== provenance.sha256) {
    throw new Error(
      `${resolved}: sha256 ${actualSha256} does not match trusted ${provenance.assetName} ${provenance.sha256}; refusing extraction`
    );
  }

  const snapshotDirectory = await mkdtemp(path.join(tmpdir(), "mmt-tinymist-vsix-"));
  const snapshot = path.join(snapshotDirectory, provenance.assetName);
  try {
    await writeFile(snapshot, bytes, { flag: "wx", mode: 0o600 });
    await chmod(snapshot, 0o400);
    const member = async (name) => {
      const value = await extractMember(snapshot, name);
      const extracted = Buffer.isBuffer(value) ? value : Buffer.from(value ?? "");
      if (extracted.byteLength === 0) throw new Error(`${resolved}: missing or empty ${name}`);
      return extracted;
    };

    const packageMetadata = JSON.parse(await member("extension/package.json"));
    if (packageMetadata.name !== "tinymist" || packageMetadata.version !== provenance.version) {
      throw new Error(`${resolved}: Tinymist VSIX version does not match ${provenance.version}`);
    }
    const grammar = await member("extension/out/typst.tmLanguage.json");
    if (JSON.parse(grammar).scopeName !== "source.typst") {
      throw new Error(`${resolved}: invalid Typst TextMate grammar`);
    }
    const license = await member("extension/LICENSE.txt");
    return { filename: resolved, ...provenance, grammar, license };
  } finally {
    await rm(snapshotDirectory, { recursive: true, force: true });
  }
}

export async function beginDistTransaction(extensionRoot) {
  const distPath = path.join(extensionRoot, "dist");
  const transactionRoot = await mkdtemp(path.join(extensionRoot, ".tinymist-dist-"));
  const originalPath = path.join(transactionRoot, "original");
  let hadOriginal = false;
  try {
    try {
      await rename(distPath, originalPath);
      hadOriginal = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { distPath, transactionRoot, originalPath, hadOriginal, open: true };
  } catch (error) {
    if (hadOriginal) {
      try {
        await rename(originalPath, distPath);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "Tinymist dist transaction could not restore its preimage");
      }
    }
    await rm(transactionRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function restoreDistTransaction(transaction) {
  requireOpenTransaction(transaction);
  const candidatePath = path.join(transaction.transactionRoot, "candidate");
  try {
    await rename(transaction.distPath, candidatePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (transaction.hadOriginal) await rename(transaction.originalPath, transaction.distPath);
  transaction.open = false;
  await rm(transaction.transactionRoot, { recursive: true, force: true });
}

export async function commitDistTransaction(transaction) {
  requireOpenTransaction(transaction);
  await rm(transaction.transactionRoot, { recursive: true, force: true });
  transaction.open = false;
}

function requireOpenTransaction(transaction) {
  if (!transaction?.open) throw new Error("Tinymist dist transaction is not open");
}
