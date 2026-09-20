import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  beginDistTransaction,
  commitDistTransaction,
  pinnedTinymistUpstream,
  readTrustedTinymistVsix,
  requirePinnedTinymistCheckout,
  requireTrustedTinymistGrammarNotice,
  restoreDistTransaction
} from "./tinymist-promotion-boundaries.mjs";

const pin = JSON.parse(await readFile(
  fileURLToPath(new URL("../../../third_party/tinymist/pin.json", import.meta.url)),
  "utf8"
));

test("upstream provenance is normalized and rejects malformed or missing identity", () => {
  const normalized = pinnedTinymistUpstream({
    ...pin,
    upstream: { ...pin.upstream, ignored: "not provenance" }
  });
  assert.deepEqual(normalized, pin.upstream);
  assert.equal(Object.isFrozen(normalized), true);
  assert.throws(
    () => pinnedTinymistUpstream({ ...pin, upstream: { ...pin.upstream, revision: undefined } }),
    /full lowercase Git commit SHA/
  );
  assert.throws(
    () => pinnedTinymistUpstream({ ...pin, upstream: { ...pin.upstream, revision: pin.upstream.revision.slice(1) } }),
    /full lowercase Git commit SHA/
  );
  assert.throws(
    () => pinnedTinymistUpstream({ ...pin, upstream: { ...pin.upstream, revision: "A".repeat(40) } }),
    /full lowercase Git commit SHA/
  );
  assert.throws(
    () => pinnedTinymistUpstream({ ...pin, upstream: { ...pin.upstream, repository: "https://example.com/tinymist.git" } }),
    /HTTPS GitHub repository URL/
  );
  assert.throws(
    () => pinnedTinymistUpstream({ ...pin, upstream: { ...pin.upstream, version: "" } }),
    /valid release version/
  );
});

test("source checkout boundary rejects the wrong revision and tracked changes", () => {
  assert.throws(
    () => requirePinnedTinymistCheckout(pin, "0".repeat(40), ""),
    /does not match source revision/
  );
  assert.throws(
    () => requirePinnedTinymistCheckout(pin, pin.source.revision, " M crates/tinymist/src/lib.rs\n"),
    /tracked source changes/
  );
  assert.deepEqual(
    requirePinnedTinymistCheckout(pin, `${pin.source.revision}\n`, ""),
    pin.source
  );
});

test("source pin boundary rejects legacy patch metadata", () => {
  assert.throws(
    () => requirePinnedTinymistCheckout({ ...pin, patches: [] }, pin.source.revision, ""),
    /patch-free mmt-tinymist-pin\.v2/
  );
});

async function absent(filename) {
  try {
    await stat(filename);
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

test("forged VSIX bytes are rejected before any archive member is extracted", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mmt-forged-vsix-"));
  try {
    const filename = path.join(temp, "tinymist-universal.vsix");
    await writeFile(filename, "self-declared Tinymist archive");
    let extractionCalls = 0;
    await assert.rejects(
      readTrustedTinymistVsix(filename, pin, async () => {
        extractionCalls += 1;
        throw new Error("extractor must not run for unauthenticated bytes");
      }),
      /does not match trusted tinymist-universal\.vsix .* refusing extraction/
    );
    assert.equal(extractionCalls, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("vendor provenance rejects a self-attested VSIX digest", async () => {
  const notice = await readFile(
    fileURLToPath(new URL(`../vendor/tinymist-${pin.upstream.version}/GRAMMAR-NOTICE.txt`, import.meta.url)),
    "utf8"
  );
  assert.doesNotThrow(() => requireTrustedTinymistGrammarNotice(notice, pin));
  const forged = notice.replace(pin.release.universalVsix.sha256, "0".repeat(64));
  assert.throws(
    () => requireTrustedTinymistGrammarNotice(forged, pin),
    /does not match the trusted universal VSIX pin/
  );
});

test("all members are extracted from the authenticated immutable byte snapshot", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "mmt-vsix-snapshot-"));
  try {
    const filename = path.join(temp, "tinymist-universal.vsix");
    const reviewedBytes = Buffer.from("reviewed release asset bytes");
    await writeFile(filename, reviewedBytes);
    const fixturePin = structuredClone(pin);
    fixturePin.release.universalVsix.sha256 = createHash("sha256").update(reviewedBytes).digest("hex");
    const members = new Map([
      ["extension/package.json", JSON.stringify({ name: "tinymist", version: pin.upstream.version })],
      ["extension/out/typst.tmLanguage.json", JSON.stringify({ scopeName: "source.typst" })],
      ["extension/LICENSE.txt", "Apache-2.0"]
    ]);
    let extractionCalls = 0;
    const result = await readTrustedTinymistVsix(filename, fixturePin, async (snapshot, member) => {
      extractionCalls += 1;
      if (extractionCalls === 1) await writeFile(filename, "replacement archive bytes");
      assert.deepEqual(await readFile(snapshot), reviewedBytes);
      return members.get(member);
    });
    assert.equal(extractionCalls, 3);
    assert.equal(result.sha256, fixturePin.release.universalVsix.sha256);
    assert.equal(result.grammar.toString(), members.get("extension/out/typst.tmLanguage.json"));
    assert.equal(result.license.toString(), members.get("extension/LICENSE.txt"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("qualification rollback restores a pre-existing dist tree", async () => {
  const extensionRoot = await mkdtemp(path.join(os.tmpdir(), "mmt-dist-existing-"));
  try {
    const dist = path.join(extensionRoot, "dist");
    await mkdir(dist);
    await writeFile(path.join(dist, "extension.js"), "pre-existing executable");
    const transaction = await beginDistTransaction(extensionRoot);
    await mkdir(dist);
    await writeFile(path.join(dist, "extension.js"), "candidate executable");
    await restoreDistTransaction(transaction);
    assert.equal(await readFile(path.join(dist, "extension.js"), "utf8"), "pre-existing executable");
    assert.equal(await absent(transaction.transactionRoot), true);
  } finally {
    await rm(extensionRoot, { recursive: true, force: true });
  }
});

test("qualification rollback removes only a candidate-created dist tree", async () => {
  const extensionRoot = await mkdtemp(path.join(os.tmpdir(), "mmt-dist-created-"));
  try {
    const dist = path.join(extensionRoot, "dist");
    const transaction = await beginDistTransaction(extensionRoot);
    await mkdir(dist);
    await writeFile(path.join(dist, "extension.js"), "candidate executable");
    await restoreDistTransaction(transaction);
    assert.equal(await absent(dist), true);
    assert.equal(await absent(transaction.transactionRoot), true);
  } finally {
    await rm(extensionRoot, { recursive: true, force: true });
  }
});

test("successful repin keeps only the newly qualified dist tree", async () => {
  const extensionRoot = await mkdtemp(path.join(os.tmpdir(), "mmt-dist-commit-"));
  try {
    const dist = path.join(extensionRoot, "dist");
    await mkdir(dist);
    await writeFile(path.join(dist, "extension.js"), "pre-existing executable");
    const transaction = await beginDistTransaction(extensionRoot);
    await mkdir(dist);
    await writeFile(path.join(dist, "extension.js"), "qualified executable");
    await commitDistTransaction(transaction);
    assert.equal(await readFile(path.join(dist, "extension.js"), "utf8"), "qualified executable");
    assert.equal(await absent(transaction.transactionRoot), true);
  } finally {
    await rm(extensionRoot, { recursive: true, force: true });
  }
});
