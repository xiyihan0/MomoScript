import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

const fixtureRoot = new URL("../src/test/fixtures/", import.meta.url);
const nativeEvidence = JSON.parse(await readFile(new URL("tinymist-native-evidence.json", fixtureRoot), "utf8"));
const webEvidence = JSON.parse(await readFile(new URL("tinymist-web-evidence.json", fixtureRoot), "utf8"));

const capabilityKeys = [...new Set([
  ...Object.keys(nativeEvidence.initialize.capabilities),
  ...Object.keys(webEvidence.initialize.capabilities),
])].sort();
const baselineQualified = new Set([
  "completionProvider",
  "hoverProvider",
  "semanticTokensProvider",
  "signatureHelpProvider",
]);
const p0 = new Set([
  "definitionProvider",
  "documentLinkProvider",
  "referencesProvider",
  "renameProvider",
  "documentFormattingProvider",
  "documentRangeFormattingProvider",
  "documentSymbolProvider",
]);

function advertised(evidence, key) {
  if (key === "semanticTokensProvider") {
    return Boolean(evidence.initialize.capabilities[key])
      || evidence.dynamicRegistrations.register.some((entry) => entry.method === "textDocument/semanticTokens");
  }
  return Boolean(evidence.initialize.capabilities[key]);
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, stable(child)]));
  }
  return value;
}

const providers = capabilityKeys.map((key) => {
  const native = advertised(nativeEvidence, key);
  const web = advertised(webEvidence, key);
  const sameOptions = JSON.stringify(stable(nativeEvidence.initialize.capabilities[key] ?? null))
    === JSON.stringify(stable(webEvidence.initialize.capabilities[key] ?? null))
    || key === "semanticTokensProvider";
  let classification = "unavailable";
  let reason = "not advertised by either fixed artifact";
  if (native && web && sameOptions && baselineQualified.has(key)) {
    classification = "core-required";
    reason = "compatible advertisement plus checked native/Web baseline transcript";
  } else if (native && web && p0.has(key)) {
    classification = "unavailable";
    reason = "P0 is advertised but lacks shared positive/negative method transcripts; W0-H patch blocker";
  } else if (native && web) {
    classification = "deferred";
    reason = sameOptions
      ? "advertised by both artifacts; method transcript not yet qualified"
      : "artifact provider options differ";
  } else if (native || web) {
    classification = "host-optional";
    reason = `advertised only by ${native ? "native" : "web"}`;
  }
  return { classification, key, native, reason, sameOptions, web };
});
const patchRequiredProviders = providers.filter((item) => p0.has(item.key) && item.classification === "unavailable").map((item) => item.key);
const patchRequired = patchRequiredProviders.length > 0;

const manifest = stable({
  schemaVersion: 1,
  artifacts: {
    native: {
      backendVersion: nativeEvidence.artifact.backendVersion,
      digest: nativeEvidence.artifact.digests.tinymist,
      positionEncoding: nativeEvidence.initialize.capabilities.positionEncoding,
      checksumReference: nativeEvidence.artifact.checksumManifest.reference,
    },
    web: {
      backendVersion: webEvidence.artifact.backendVersion,
      digest: webEvidence.artifact.digests["tinymist_bg.wasm"],
      positionEncoding: webEvidence.initialize.capabilities.positionEncoding,
      checksumReference: webEvidence.artifact.checksumManifest.path,
    },
  },
  experimentalMethods: {
    native: Object.keys(nativeEvidence.initialize.capabilities.experimental ?? {}).sort(),
    web: [...webEvidence.experimentalMethods].sort(),
  },
  packageCallback: {
    classification: "core-required",
    native: nativeEvidence.packageCallback.availability,
    web: webEvidence.packageCallback.availability,
    cancellationQualified: nativeEvidence.packageCallback.cancellation.observed
      && webEvidence.packageCallback.cancellation.notificationObserved,
  },
  previewLocation: {
    classification: "host-optional",
    nativeQualifiedMethod: nativeEvidence.previewLocation.qualifiedMethod,
    webQualifiedMethod: webEvidence.previewLocation.qualifiedMethod,
    coordinateVersion: null,
    fallback: "immutable-location-map",
  },
  providers,
  qualification: {
    baselineEvidence: "typst-language-baseline.json",
    p0Keys: [...p0].sort(),
    patchRequired,
    patchRequiredProviders,
    rule: "core-required requires compatible native/Web advertisement and shared positive/negative method transcript; advertised P0 without that evidence is unavailable and blocks W0-H",
  },
});

assert.equal(manifest.artifacts.native.digest, nativeEvidence.artifact.checksumManifest.expectedSha256);
assert.equal(manifest.artifacts.web.digest, webEvidence.artifact.digests["tinymist_bg.wasm"]);
assert.equal(manifest.artifacts.native.positionEncoding, "utf-16");
assert.equal(manifest.artifacts.web.positionEncoding, "utf-16");
for (const provider of manifest.providers) {
  if (provider.classification === "core-required") {
    assert(provider.native && provider.web && provider.sameOptions && baselineQualified.has(provider.key));
  }
  if (p0.has(provider.key)) {
    assert.equal(provider.classification, "unavailable", `${provider.key} lacks shared method transcript and must block W0-H`);
  }
}
assert.equal(manifest.packageCallback.classification, "core-required");
assert.equal(manifest.packageCallback.cancellationQualified, true);
assert.equal(manifest.previewLocation.fallback, "immutable-location-map");

const checkedPath = new URL("tinymist-capability-manifest.json", fixtureRoot);
const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
if (process.env.UPDATE_TINYMIST_CAPABILITY_MANIFEST === "1") {
  await writeFile(checkedPath, rendered);
} else {
  assert.equal(await readFile(checkedPath, "utf8"), rendered, "checked capability manifest is stale");
}
console.log(JSON.stringify({
  checked: true,
  coreRequired: manifest.providers.filter((item) => item.classification === "core-required").map((item) => item.key),
  patchRequired: manifest.qualification.patchRequired,
  patchRequiredProviders: manifest.qualification.patchRequiredProviders,
  packageCallback: manifest.packageCallback.classification,
  locationFallback: manifest.previewLocation.fallback,
}));
