import assert from "node:assert/strict";
import {
  avatarItemMatchesCurrent,
  buildAvatarPickerPersonGroups,
  createAvatarPickerController,
} from "../src/avatarPicker.ts";

function item(entityId, entityDisplayName, contributionNamespace, variantId, {
  selectable = true,
  searchTerms = [],
  person,
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
    ...(person === undefined ? {} : { person }),
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

const personMetadata = (key, label, formLabel, formDisplayName) => ({
  key, label, formLabel, formDisplayName,
});
const airiNormal = item("people::Airi", "栗村爱理", "people", "default", {
  person: personMetadata("catalog:people:character:10", "爱理", "原装", "栗村爱理"),
  searchTerms: ["Airi Kurimura", "栗村アイリ", "冰淇淋", "格黑娜学园", "Gehenna", "便利屋68"],
});
const airiHappy = item("people::Airi", "栗村爱理", "people", "happy", {
  person: airiNormal.person,
  searchTerms: ["Airi Kurimura", "栗村アイリ", "冰淇淋", "格黑娜学园", "Gehenna", "便利屋68", "unique-happy"],
});
const airiUnavailable = item("people::Airi", "栗村爱理", "animated", "motion-exact", {
  person: airiNormal.person,
  selectable: false,
});
const summer = item("people::AiriSummer", "爱理夏装", "events", "exact-contribution-expression", {
  person: personMetadata("catalog:people:character:10", "爱理", "夏装", "爱理夏装"),
  searchTerms: ["Airi Summer", "夏日", "千年科学学园", "Millennium", "活动组织"],
});
const sameNameElsewhere = item("other::Airi", "爱理", "other", "default", {
  person: personMetadata("catalog:other:character:10", "爱理", "形态未标注 · 爱理", "爱理"),
});
const sameNameLegacy = item("legacy::Airi_夏装", "爱理", "legacy", "default");
const hierarchicalItems = [summer, sameNameLegacy, airiUnavailable, airiHappy, sameNameElsewhere, airiNormal];
const people = buildAvatarPickerPersonGroups(hierarchicalItems);
assert.equal(people.length, 3, "identical names/character IDs from other catalogs and legacy names must remain separate");
const airiPerson = people.find((person) => person.key === "catalog:people:character:10");
assert.deepEqual(airiPerson.forms.map((form) => [form.entityId, form.label]), [
  ["people::Airi", "原装"],
  ["people::AiriSummer", "夏装"],
]);
assert.equal(airiPerson.forms[0].displayName, "栗村爱理");
assert.deepEqual(airiPerson.forms[0].items.map((candidate) => [
  candidate.variant.contributionNamespace, candidate.variant.variantId,
]), [["people", "default"], ["people", "happy"], ["animated", "motion-exact"]]);
assert.equal(airiPerson.forms[0].items[2].selectable, false, "unavailable variants remain visible without becoming selectable");
assert.deepEqual(people, buildAvatarPickerPersonGroups([...hierarchicalItems].reverse()), "person/form/expression order is input-order independent");
const legacyPerson = people.find((person) => person.forms[0]?.entityId === "legacy::Airi_夏装");
assert.equal(legacyPerson.forms[0].label, "形态未标注 · 爱理", "old names must not invent a clothing or ordinary-form label");
assert.equal(buildAvatarPickerPersonGroups(hierarchicalItems, "爱理").find((person) => person.key === airiPerson.key).forms.length, 2);
for (const query of [" Airi Kurimura ", "栗村アイリ", "冰淇淋", "格黑娜学园", "GEHENNA", "便利屋68"]) {
  const result = buildAvatarPickerPersonGroups(hierarchicalItems, query);
  assert.equal(result.length, 1, `search must match ${query}`);
  assert.equal(result[0].forms[0].entityId, "people::Airi");
  assert.deepEqual(result[0].forms[0].items, [airiNormal, airiHappy]);
}
for (const query of ["夏日", "Millennium", "活动组织", "exact-contribution-expression", "events"]) {
  const result = buildAvatarPickerPersonGroups(hierarchicalItems, query);
  assert.equal(result.length, 1, `form/organization/contribution search must match ${query}`);
  assert.deepEqual(result[0].forms.map((form) => form.entityId), ["people::AiriSummer"]);
  assert.deepEqual(result[0].forms[0].items, [summer]);
}
assert.deepEqual(
  buildAvatarPickerPersonGroups(hierarchicalItems, "unique-happy")[0].forms[0].items,
  [airiHappy],
  "expression-only search should not expand all expressions",
);
assert.deepEqual(buildAvatarPickerPersonGroups(hierarchicalItems, "missing entirely"), []);
assert.deepEqual(buildAvatarPickerPersonGroups([]), []);
assert.ok(airiPerson.searchTerms.includes("冰淇淋"));
assert.ok(airiPerson.searchTerms.includes("Millennium"));
assert.ok(airiPerson.forms[1].searchTerms.includes("events"));

const hierarchicalChoices = [];
const groupedSelection = createAvatarPickerController({
  actorPresetId: "people::Airi",
  actorLabel: "原说话人",
  current: { kind: "asset", assetName: "custom-avatar" },
  items: hierarchicalItems,
  choose: (choice) => { hierarchicalChoices.push(choice); },
});
assert.equal(groupedSelection.snapshot().currentStatus, "custom");
assert.equal(await groupedSelection.select(airiUnavailable), false);
assert.equal(await groupedSelection.select(airiPerson.forms[1].items[0]), true);
assert.deepEqual(hierarchicalChoices, [{
  kind: "packAvatar",
  entityId: "people::AiriSummer",
  contributionNamespace: "events",
  variantId: "exact-contribution-expression",
}], "cross-form selection retains exact media identity without rewriting the speaker");
assert.equal(groupedSelection.snapshot().currentActorLabel, "原说话人");
groupedSelection.dispose();

console.log(JSON.stringify({ snapshots: snapshots.length, chosen: chosen.length, statuses: 4 }));
