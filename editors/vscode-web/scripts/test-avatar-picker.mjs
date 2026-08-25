import assert from "node:assert/strict";
import {
  avatarItemMatchesCurrent,
  createAvatarPickerController,
} from "../src/avatarPicker.ts";

function item(entityId, entityDisplayName, contributionNamespace, variantId, {
  selectable = true,
  searchTerms = [],
} = {}) {
  return {
    variant: {
      entityId,
      entityDisplayName,
      contributionNamespace,
      variantId,
      handles: [],
      storageKey: "avatars",
      path: `${variantId}.png`,
      isEntityDefault: contributionNamespace === entityId.split("::")[0] && variantId === "default",
      isSourceDefault: variantId === "default",
    },
    thumbnailUrl: selectable ? `https://packs.example/${variantId}.png` : undefined,
    selectable,
    searchTerms: [entityId, entityDisplayName, contributionNamespace, variantId, ...searchTerms],
  };
}

const current = item("ba::Hero", "Hero", "ba", "default");
const currentAlternate = item("ba::Hero", "Hero", "ba", "smile", { searchTerms: ["happy"] });
const currentUnavailable = item("ba::Hero", "Hero", "event", "sequence", { selectable: false });
const otherDefault = item("ba::Other", "Other", "ba", "default", { searchTerms: ["Alias"] });
const otherFestival = item("ba::Other", "Other", "event", "festival", { searchTerms: ["celebrate"] });
const third = item("aa::Third", "Third", "aa", "default", { searchTerms: ["third-alias"] });
const items = [current, currentAlternate, currentUnavailable, otherDefault, otherFestival, third];
const currentIdentity = {
  kind: "packAvatar",
  entityId: "ba::Hero",
  contributionNamespace: "ba",
  variantId: "default",
};

let releaseChoose;
const chosen = [];
const controller = createAvatarPickerController({
  actorPresetId: "ba::Hero",
  actorLabel: "Current Hero",
  current: currentIdentity,
  items,
  choose: async (choice) => {
    chosen.push(choice);
    await new Promise((resolve) => { releaseChoose = resolve; });
  },
});

assert.equal(controller.snapshot().currentStatus, "available");
assert.equal(controller.snapshot().currentActorLabel, "Current Hero");
assert.deepEqual(controller.snapshot().currentActorItems, [current, currentAlternate, currentUnavailable]);
assert.deepEqual(controller.snapshot().otherActors.map((group) => group.entityId), ["ba::Other", "aa::Third"]);
assert.equal(avatarItemMatchesCurrent(current, currentIdentity), true);
assert.equal(avatarItemMatchesCurrent(currentAlternate, currentIdentity), false);
assert.equal(await controller.select(current), false);
assert.equal(await controller.select(currentUnavailable), false);

const snapshots = [];
const unsubscribe = controller.subscribe((snapshot) => snapshots.push(snapshot));
controller.setQuery("celebrate");
assert.deepEqual(controller.snapshot().otherActors.map((group) => [
  group.entityId,
  group.items.map((candidate) => candidate.variant.variantId),
]), [["ba::Other", ["festival"]]]);
controller.setQuery("Other");
assert.deepEqual(
  controller.snapshot().otherActors[0]?.items.map((candidate) => candidate.variant.variantId),
  ["default", "festival"],
);
controller.setQuery("third-alias");
assert.deepEqual(controller.snapshot().otherActors.map((group) => group.entityId), ["aa::Third"]);
controller.setQuery("");
assert.ok(snapshots.length >= 4);

const selection = controller.select(otherFestival);
assert.equal(controller.snapshot().busy, true);
assert.equal(await controller.select(third), false);
assert.deepEqual(chosen, [{
  kind: "packAvatar",
  entityId: "ba::Other",
  contributionNamespace: "event",
  variantId: "festival",
}]);
releaseChoose();
assert.equal(await selection, true);
assert.equal(controller.snapshot().busy, false);
assert.equal(await controller.select(third), false);
unsubscribe();
controller.dispose();
controller.setQuery("ignored");
assert.equal(controller.snapshot().query, "");

for (const [source, expected] of [
  [{ kind: "asset", assetName: "portrait" }, "custom"],
  [null, "none"],
  [{ kind: "packAvatar", entityId: "ba::Hero", contributionNamespace: "ba", variantId: "missing" }, "unavailable"],
  [{ kind: "packAvatar", entityId: "ba::Hero", contributionNamespace: "event", variantId: "sequence" }, "unavailable"],
]) {
  const statusController = createAvatarPickerController({
    actorPresetId: "ba::Hero",
    actorLabel: "Hero",
    current: source,
    items,
    choose: () => {},
  });
  assert.equal(statusController.snapshot().currentStatus, expected);
  statusController.dispose();
}

let failingAttempts = 0;
const failing = createAvatarPickerController({
  actorPresetId: "ba::Hero",
  actorLabel: "Hero",
  current: null,
  items,
  choose: () => {
    failingAttempts += 1;
    throw new Error("apply failed");
  },
});
await assert.rejects(failing.select(otherDefault), /apply failed/);
assert.equal(await failing.select(otherFestival), false);
assert.equal(failingAttempts, 1);
failing.dispose();

console.log(JSON.stringify({ snapshots: snapshots.length, chosen: chosen.length, statuses: 4 }));
