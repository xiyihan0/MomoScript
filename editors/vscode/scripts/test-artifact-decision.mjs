import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const fixtureRoot = new URL("../src/test/fixtures/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("tinymist-capability-manifest.json", fixtureRoot), "utf8"));
const decision = JSON.parse(await readFile(new URL("tinymist-artifact-decision.json", fixtureRoot), "utf8"));

assert.equal(decision.schema, "mmt-tinymist-artifact-decision.v1");
assert.equal(decision.artifacts.nativeDigest, manifest.artifacts.native.digest);
assert.equal(decision.artifacts.webDigest, manifest.artifacts.web.digest);
assert.equal(decision.artifacts.backendVersion, manifest.artifacts.native.backendVersion);
assert.equal(decision.artifacts.backendVersion, manifest.artifacts.web.backendVersion);
assert.equal(decision.decision, "retain-pinned-artifacts");
assert.equal(decision.wave0Exit.patchRequired, manifest.qualification.patchRequired);
assert.deepEqual(
  decision.blockedUntilMaintainedPatchAndTranscripts.p0Providers,
  manifest.qualification.patchRequiredProviders,
);
assert.equal(manifest.packageCallback.classification, "unavailable");
assert.equal(decision.blockedUntilMaintainedPatchAndTranscripts.packageCallback, true);
assert.equal(decision.fallbacks.packageResolution, "disabled");
assert.equal(manifest.previewLocation.coordinateVersion, null);
assert.equal(decision.blockedUntilMaintainedPatchAndTranscripts.versionedPreviewLocation, true);
assert.equal(decision.fallbacks.previewLocation, manifest.previewLocation.fallback);
assert.equal(decision.wave0Exit.baselineProvidersMayProceed, true);
assert.equal(decision.wave0Exit.blockedCapabilitiesMayProceed, false);

console.log(JSON.stringify({
  checked: true,
  decision: decision.decision,
  patchRequired: decision.wave0Exit.patchRequired,
  blockedP0Providers: decision.blockedUntilMaintainedPatchAndTranscripts.p0Providers,
  packageResolution: decision.fallbacks.packageResolution,
  previewLocation: decision.fallbacks.previewLocation,
}));
