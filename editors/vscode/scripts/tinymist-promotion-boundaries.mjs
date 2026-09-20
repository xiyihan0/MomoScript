import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function trustedTinymistVsix(pin) {
  const version = pin?.upstream?.version;
  const repository = pin?.upstream?.repository;
  const release = pin?.release;
  const asset = release?.universalVsix;
  if (typeof version !== "string" || release?.tag !== `v${version}`) {
    throw new Error("Tinymist universal VSIX release tag does not match the maintained upstream version");
  }
  if (asset?.name !== "tinymist-universal.vsix" || !/^[0-9a-f]{64}$/.test(asset?.sha256 ?? "")) {
    throw new Error("Tinymist universal VSIX has no trusted release asset identity");
  }

  let repositoryUrl;
  try {
    repositoryUrl = new URL(repository);
  } catch {
    throw new Error("Tinymist upstream repository is not a valid URL");
  }
  if (repositoryUrl.protocol !== "https:" || repositoryUrl.hostname !== "github.com"
    || repositoryUrl.search || repositoryUrl.hash) {
    throw new Error("Tinymist universal VSIX must come from the pinned GitHub repository");
  }
  const repositoryPath = repositoryUrl.pathname.replace(/\.git$/, "").replace(/\/$/, "");
  if (!/^\/[^/]+\/[^/]+$/.test(repositoryPath)) {
    throw new Error("Tinymist upstream repository path is invalid");
  }

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
