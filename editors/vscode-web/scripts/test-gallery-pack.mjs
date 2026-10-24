import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseGalleryEntityCatalog } from "../src/galleryEntityCatalog.ts";
import { buildAvatarCatalog, buildGalleryPersonGroups, GalleryImageCache, projectGalleryPack } from "../src/galleryPack.ts";
import { buildAvatarPickerPersonGroups } from "../src/avatarPicker.ts";

function pack(namespace, manifest, suffix = namespace, baseUrl = `https://packs.example/${suffix}/`) {
  return projectGalleryPack({
    manifestUrl: `https://packs.example/${suffix}/manifest.json`,
    baseUrl,
    json: JSON.stringify({
      schema: "mmt-pack.v3",
      pack: { namespace, name: namespace, version: "1", type: "base" },
      ...manifest,
    }),
  });
}

const imageSequence = {
  kind: "image-sequence",
  path: "blobs/avatars.avifs",
  container: "avifs",
  codec: "av1",
  frame_count: 3,
  size: [512, 512],
  alpha: true,
  sha256: "a".repeat(64),
  profile: {},
};

const base = pack("ba", {
  entities: {
    Hero: {
      display_name: "Beta",
      names: ["Hero", "Beta", "Alias"],
      slots: {
        avatar: {
          default: "default",
          items: {
            smile: { handles: ["happy"], storage: "avatars", path: "smile.webp" },
            default: { handles: ["normal"], storage: "avatars", path: "default.png" },
            pathless: { storage: "avatars" },
            sequence: { storage: "sequence", frame: 2 },
            unsafe: { storage: "avatars", path: "../escape.png" },
          },
        },
      },
    },
    "foreign::Canonical": {
      display_name: "Canonical",
      names: ["Canonical"],
      slots: { avatar: { default: "default", items: {
        default: { storage: "avatars", path: "canonical.jpg" },
      } } },
    },
  },
  storage: {
    avatars: { kind: "image-dir", base: "assets/avatar" },
    sequence: imageSequence,
  },
});

assert.deepEqual(base.entities.find((entity) => entity.key === "Hero")?.avatar, {
  storageKey: "avatars",
  path: "default.png",
});
assert.equal(base.avatarVariants.length, 6);
assert.equal(
  base.avatarVariants.find((avatar) => avatar.variantId === "default")?.entityId,
  "ba::Hero",
);
assert.equal(
  base.avatarVariants.find((avatar) => avatar.entityDisplayName === "Canonical")?.entityId,
  "foreign::Canonical",
);
assert.equal(base.avatarVariants.find((avatar) => avatar.variantId === "sequence")?.frame, 2);

const extension = pack("ext", {
  contributions: [{
    target: "ba::Hero",
    slots: { avatar: { default: "festival", items: {
      alt: { handles: ["extension alt"], storage: "avatars", path: "alt.jpeg" },
      festival: { handles: ["event"], storage: "avatars", path: "festival.png" },
    } } },
  }],
  storage: { avatars: { kind: "image-dir", base: "contrib/avatar" } },
});

const alpha = pack("aa", {
  entities: {
    Alpha: {
      display_name: "Alpha",
      names: ["Alpha"],
      slots: { avatar: { default: "default", items: {
        default: { storage: "avatars", path: "alpha.png" },
      } } },
    },
  },
  storage: { avatars: { kind: "image-dir", base: "avatars" } },
});

const catalog = buildAvatarCatalog([extension, base, alpha]);
assert.equal(catalog[0]?.variant.entityId, "aa::Alpha");
const hero = catalog.filter((item) => item.variant.entityId === "ba::Hero");
assert.deepEqual(hero.map((item) => [
  item.variant.contributionNamespace,
  item.variant.variantId,
]), [
  ["ba", "default"],
  ["ba", "pathless"],
  ["ba", "sequence"],
  ["ba", "smile"],
  ["ba", "unsafe"],
  ["ext", "festival"],
  ["ext", "alt"],
]);
assert.equal(hero.find((item) => item.variant.variantId === "default")?.thumbnailUrl,
  "https://packs.example/ba/assets/avatar/default.png");
assert.equal(hero.find((item) => item.variant.variantId === "festival")?.thumbnailUrl,
  "https://packs.example/ext/contrib/avatar/festival.png");
assert.equal(hero.find((item) => item.variant.variantId === "pathless")?.selectable, false);
assert.equal(hero.find((item) => item.variant.variantId === "sequence")?.selectable, true);
assert.equal(hero.find((item) => item.variant.variantId === "sequence")?.thumbnailUrl, undefined, "supported frame avatars are decoded lazily, not hidden");
assert.equal(hero.find((item) => item.variant.variantId === "unsafe")?.selectable, false);
assert.ok(hero.find((item) => item.variant.variantId === "smile")?.searchTerms.includes("Alias"));
assert.ok(hero.find((item) => item.variant.variantId === "smile")?.searchTerms.includes("happy"));
assert.equal(hero.find((item) => item.variant.variantId === "festival")?.variant.entityDisplayName, "Beta");
assert.equal(hero.find((item) => item.variant.variantId === "festival")?.variant.isEntityDefault, false);
assert.equal(hero.find((item) => item.variant.variantId === "festival")?.variant.isSourceDefault, true);

const exactDuplicate = pack("ext", {
  contributions: [{
    target: "ba::Hero",
    slots: { avatar: { default: "festival", items: {
      festival: { handles: ["event"], storage: "avatars", path: "festival.png" },
    } } },
  }],
  storage: { avatars: { kind: "image-dir", base: "contrib/avatar" } },
}, "ext-copy");
const dedupedForward = buildAvatarCatalog([base, extension, exactDuplicate]);
const dedupedReverse = buildAvatarCatalog([exactDuplicate, extension, base]);
assert.equal(dedupedForward.filter((item) => item.variant.contributionNamespace === "ext").length, 2);
assert.deepEqual(dedupedForward, dedupedReverse);

const conflicting = pack("ext", {
  contributions: [{
    target: "ba::Hero",
    slots: { avatar: { default: "festival", items: {
      festival: { handles: ["different metadata"], storage: "avatars", path: "festival.png" },
    } } },
  }],
  storage: { avatars: { kind: "image-dir", base: "contrib/avatar" } },
}, "ext-conflict");
const conflictCatalog = buildAvatarCatalog([base, extension, exactDuplicate, conflicting]);
assert.equal(conflictCatalog.some((item) => (
  item.variant.entityId === "ba::Hero"
  && item.variant.contributionNamespace === "ext"
  && item.variant.variantId === "festival"
)), false);
assert.equal(conflictCatalog.some((item) => item.variant.variantId === "alt"), true);

const insecure = pack("unsafe", {
  entities: {
    Unsafe: {
      display_name: "Unsafe",
      slots: { avatar: { default: "default", items: {
        default: { storage: "avatars", path: "unsafe.png" },
      } } },
    },
  },
  storage: { avatars: { kind: "image-dir", base: "avatars" } },
}, "unsafe", "http://packs.example/unsafe/");
const insecureItem = buildAvatarCatalog([insecure])[0];
assert.equal(insecureItem?.selectable, false);
assert.equal(insecureItem?.thumbnailUrl, undefined);

const catalogTemplate = JSON.parse(await readFile(new URL("../e2e/fixtures/entity-catalog.json", import.meta.url), "utf8"));
function catalogPack(namespace, definitions, suffix = namespace) {
  const entities = Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, {
    display_name: value.displayName ?? key,
    names: value.names ?? [value.displayName ?? key],
    slots: {
      avatar: { default: "normal", items: {
        normal: { storage: "avatars", path: `${key}.png` },
        smile: { handles: ["happy"], storage: "avatars", path: `${key}-smile.png` },
      } },
      sticker: { default: "portraits", sets: { portraits: {
        display_name: "立绘",
        storage: "portraits",
        variants: [{ id: "exact-variant", ordinal: 7, frame: 2 }],
      } } },
    },
  }]));
  const json = JSON.stringify({
    schema: "mmt-pack.v3",
    pack: { namespace, version: "1", name: namespace, type: "base" },
    entities,
    storage: { avatars: { kind: "image-dir", base: "avatars" } },
  });
  const manifestSha256 = createHash("sha256").update(json).digest("hex");
  const catalogEntities = Object.fromEntries(Object.entries(definitions).map(([key, value]) => [key, {
    external_ids: value.characterId === undefined ? {} : { character: value.characterId },
    names: {
      display: value.display ?? { "zh-CN": value.displayName ?? key },
      family: value.family ?? {},
      given: value.given ?? {},
      skin: value.skin ?? {},
      aliases: value.aliases ?? {},
    },
    affiliation: { school: "1", main_relation: "10", relations: ["10"] },
    related_entities: (value.related ?? []).map((related) => ({ kind: "alternate_skin", entity: `${namespace}::${related}` })),
  }]));
  const metadata = parseGalleryEntityCatalog(JSON.stringify({
    ...catalogTemplate,
    pack: { namespace, version: "1", manifest_sha256: manifestSha256 },
    entities: catalogEntities,
  }), { namespace, version: "1", manifestSha256, entityKeys: new Set(Object.keys(entities)) });
  return projectGalleryPack({
    manifestUrl: `https://packs.example/${suffix}/manifest.json`,
    baseUrl: `https://packs.example/${suffix}/`,
    json,
  }, metadata);
}

const given = { "en-US": "Airi", "zh-CN": "爱理" };
const definitions = {
  A: {
    characterId: "10", given, displayName: "栗村爱理",
    display: { "zh-CN": "栗村爱理", "ja-JP": "栗村アイリ", "en-US": "Airi Kurimura" },
    family: { "zh-CN": "栗村" },
    skin: { "en-US": "Original", "zh-CN": "原装" },
    aliases: { "zh-CN": ["冰淇淋"], "en-US": ["Mint"] },
    related: ["B"],
  },
  ASummer: { characterId: "10", given, displayName: "爱理夏装", skin: { "zh-CN": "夏装" } },
  Linked: { given, displayName: "爱理活动装", related: ["A"], skin: { "ja-JP": "イベント" } },
  B: { characterId: "20", displayName: "爱理礼装", given, skin: { "zh-CN": "礼装" } },
  Bridge: { displayName: "爱理桥接形态", given, related: ["A", "B", "BridgeTail"] },
  BridgeTail: { displayName: "爱理桥接形态尾部", given },
  NoIdA: { displayName: "无ID原名", given: { "zh-CN": "无ID人物" }, related: ["NoIdB"] },
  NoIdB: { displayName: "无ID另名", given: { "zh-CN": "无ID人物" }, skin: { "en-US": "Event" } },
  SameNameOne: { displayName: "相同名字" },
  SameNameTwo: { displayName: "相同名字" },
  DifferentGivenA: { characterId: "30", given: { "zh-CN": "甲", "en-US": "Common" } },
  DifferentGivenB: { characterId: "30", given: { "zh-CN": "乙", "en-US": "Common" } },
  LocalizedOnly: { displayName: "原始 Manifest 名字", display: { "ja-JP": "元の名前" } },
};
const peoplePack = catalogPack("people", definitions);
const groups = buildGalleryPersonGroups([peoplePack]);
const groupFor = (entityId) => groups.find((group) => group.forms.some((form) => form.entityId === entityId));
const airi = groupFor("people::A");
assert.equal(airi.label, "爱理");
assert.deepEqual(airi.forms.map((form) => form.entityId), [
  "people::A", "people::ASummer", "people::B", "people::Bridge", "people::BridgeTail", "people::Linked",
]);
assert.deepEqual(airi.forms.map((form) => form.label), [
  "原装", "夏装", "礼装", "形态未标注 · 爱理桥接形态", "形态未标注 · 爱理桥接形态尾部", "イベント",
]);
assert.equal(airi.forms[0].displayName, "栗村爱理");
assert.equal(airi.forms[0].entity.characterId, "10");
assert.deepEqual([...airi.forms[0].entity.givenNames], Object.entries(given));
assert.deepEqual([...airi.forms[0].entity.skinNames], Object.entries(definitions.A.skin));
assert.deepEqual(airi.forms[0].entity.stickerSets[0].variants, [{ id: "exact-variant", ordinal: 7, frame: 2 }]);
assert.equal(airi.forms[0].pack, peoplePack);
for (const term of ["栗村アイリ", "Airi Kurimura", "栗村", "Mint", "冰淇淋", "Original", "格黑娜学园", "Gehenna", "便利屋68", "Problem Solver 68"]) {
  assert.ok(airi.searchTerms.includes(term), `group search must retain ${term}`);
}
assert.equal(groupFor("people::B").key, airi.key, "explicit alternate-skin edges group differing form-record IDs");
assert.equal(groupFor("people::Bridge").key, airi.key);
assert.equal(groupFor("people::BridgeTail").key, airi.key, "typed relation components group transitively");
const noId = groupFor("people::NoIdA");
assert.equal(noId.label, "无ID人物");
assert.deepEqual(noId.forms.map((form) => form.entityId), ["people::NoIdA", "people::NoIdB"]);
assert.equal(noId.forms[0].label, "形态未标注 · 无ID原名");
assert.equal(noId.forms[1].label, "Event");
assert.notEqual(groupFor("people::SameNameOne").key, groupFor("people::SameNameTwo").key, "same names do not imply identity");
assert.equal(new Set([groupFor("people::SameNameOne").label, groupFor("people::SameNameTwo").label]).size, 2,
  "independent records sharing a display name must expose distinguishing entity IDs");
assert.equal(groupFor("people::DifferentGivenA").label, "Common", "common given-name fallback must compare the same locale");
assert.equal(groupFor("people::LocalizedOnly").label, "元の名前", "fallback should retain an existing localized Catalog display name");
assert.equal(groupFor("people::LocalizedOnly").forms[0].label, "形态未标注 · 元の名前");
assert.equal(groups.reduce((count, group) => count + group.forms.length, 0), Object.keys(definitions).length);
const qualifiedNamespacePack = catalogPack("qualified", {
  Local: { characterId: "10", given },
  "foreign::Existing": { characterId: "10", given },
});
const qualifiedGroups = buildGalleryPersonGroups([qualifiedNamespacePack]);
assert.equal(qualifiedGroups.length, 2, "qualified legacy IDs retain their own canonical namespace boundary");
assert.deepEqual(new Set(qualifiedGroups.map((group) => group.namespace)), new Set(["qualified", "foreign"]));
assert.deepEqual(new Set(qualifiedGroups.flatMap((group) => group.forms.map((form) => form.entityId))), new Set(["qualified::Local", "foreign::Existing"]));

const reversedPack = { ...peoplePack, entities: [...peoplePack.entities].reverse() };
const groupSummary = (items) => items.map((group) => ({
  key: group.key,
  label: group.label,
  forms: group.forms.map((form) => ({ entityId: form.entityId, label: form.label, displayName: form.displayName })),
}));
assert.deepEqual(groupSummary(buildGalleryPersonGroups([reversedPack])), groupSummary(groups));
const otherNamespace = catalogPack("elsewhere", { Other: { characterId: "10", given } });
const otherCatalog = catalogPack("people", { Other: { characterId: "10", given } }, "different-catalog");
const sameManifestOtherCatalog = catalogPack("people", definitions, "mirror-catalog");
const scoped = buildGalleryPersonGroups([peoplePack, otherNamespace, otherCatalog, sameManifestOtherCatalog]);
assert.equal(scoped.filter((group) => group.forms.some((form) => form.entity.characterId === "10")).length, 4,
  "character IDs are local to a namespace and catalog, including identical manifests at different catalog sources");
assert.deepEqual(groupSummary(scoped), groupSummary(buildGalleryPersonGroups([sameManifestOtherCatalog, otherCatalog, otherNamespace, reversedPack])));

const oldManifest = pack("old", { entities: {
  Hero: { display_name: "原始名字", names: ["角色_普通"] },
  Hero_Summer: { display_name: "原始名字", names: ["角色（泳装）"] },
  "自定义": { display_name: "自定义角色", slots: {} },
} });
const oldGroups = buildGalleryPersonGroups([oldManifest]);
assert.equal(oldGroups.length, 3, "no Catalog means independent manifest entities, not name/underscore/parenthesis guesses");
assert.equal(oldGroups.filter((group) => group.label.startsWith("原始名字 · old::")).length, 2);
assert.equal(new Set(oldGroups.map((group) => group.label)).size, 3, "manifest-only cards retain explicit identity when display names collide");
assert.ok(oldGroups.every((group) => group.forms[0].label.startsWith("形态未标注 · ")));
assert.ok(oldGroups.every((group) => group.forms[0].entity.characterId === undefined));
assert.ok(oldGroups.some((group) => group.forms[0].entityId === "old::自定义"), "entities without avatar/sticker metadata remain visible");

const peopleExtension = pack("events", { contributions: [{
  target: "people::ASummer",
  slots: { avatar: { default: "event-exact", items: {
    "event-exact": { handles: ["庆典"], storage: "avatars", path: "event.png" },
  } } },
}], storage: { avatars: { kind: "image-dir", base: "avatars" } } });
const peopleAvatars = buildAvatarCatalog([peopleExtension, peoplePack]);
const eventAvatar = peopleAvatars.find((item) => item.variant.contributionNamespace === "events");
assert.equal(eventAvatar.person.key, airi.key);
assert.equal(eventAvatar.person.label, "爱理");
assert.equal(eventAvatar.person.formLabel, "夏装");
assert.equal(eventAvatar.person.formDisplayName, "爱理夏装");
assert.deepEqual([
  eventAvatar.variant.entityId, eventAvatar.variant.contributionNamespace, eventAvatar.variant.variantId,
], ["people::ASummer", "events", "event-exact"]);
assert.ok(eventAvatar.searchTerms.includes("庆典"));
assert.ok(eventAvatar.searchTerms.includes("Gehenna"));
assert.deepEqual(peopleAvatars, buildAvatarCatalog([peoplePack, peopleExtension]));
assert.equal(catalog.filter((item) => item.variant.variantId === "pathless")[0].selectable, false, "genuinely unavailable old-manifest variants remain represented");

// Field subset from the published 2026.10.20 Kivo Catalog; character values are form records, not person identities.
// https://mms-pack.esa.xiyihan.cn/ba_kivo/entity-catalog.json
const productionFamilies = [
  { given: "艾米", forms: [
    { key: "艾米", characterId: "10001", displayName: "艾米" },
    { key: "艾米_武装", characterId: "10136", displayName: "艾米（武装）", skin: "武装" },
    { key: "艾米_泳装", characterId: "20032", displayName: "艾米（泳装）", skin: "泳装" },
  ] },
  { given: "爱露", forms: [
    { key: "爱露", characterId: "10000", displayName: "爱露" },
    { key: "爱露_新年", characterId: "10031", displayName: "爱露（新年）", skin: "新年" },
    { key: "爱露_礼服", characterId: "10089", displayName: "爱露（礼服）", skin: "礼服" },
  ] },
  { given: "佳代子", forms: [
    { key: "佳代子", characterId: "13005", displayName: "佳代子" },
    { key: "佳代子_新年", characterId: "10064", displayName: "佳代子（新年）", skin: "新年" },
    { key: "佳代子_礼服", characterId: "10088", displayName: "佳代子（礼服）", skin: "礼服" },
  ] },
];
const productionDefinitions = Object.fromEntries(productionFamilies.flatMap((family) => family.forms.map((form) => [form.key, {
  characterId: form.characterId,
  displayName: family.given,
  display: { "zh-CN": form.displayName },
  given: { "zh-CN": family.given },
  skin: form.skin === undefined ? {} : { "zh-CN": form.skin },
  related: family.forms.filter((candidate) => candidate.key !== form.key).map((candidate) => candidate.key),
}])));
const productionPack = catalogPack("ba", productionDefinitions, "kivo-person-regression");
const productionPeople = buildGalleryPersonGroups([productionPack]);
assert.equal(productionPeople.length, 3, "published alternate-skin families must not become nine indistinguishable person cards");
for (const family of productionFamilies) {
  const person = productionPeople.find((candidate) => candidate.label === family.given);
  assert.equal(person.forms.length, 3);
  for (const expected of family.forms) {
    const form = person.forms.find((candidate) => candidate.entityId === `ba::${expected.key}`);
    assert.equal(form.entity.characterId, expected.characterId, "grouping preserves every original form-record ID");
    assert.equal(form.displayName, expected.displayName);
    assert.equal(form.label, expected.skin ?? `形态未标注 · ${expected.displayName}`);
  }
}
const productionAvatarPeople = buildAvatarPickerPersonGroups(buildAvatarCatalog([productionPack]));
assert.equal(productionAvatarPeople.length, 3);
assert.ok(productionAvatarPeople.every((person) => person.forms.length === 3));

const unlinkedProductionPack = catalogPack("ba", Object.fromEntries(Object.entries(productionDefinitions).map(
  ([key, value]) => [key, { ...value, related: [] }],
)), "kivo-unlinked-regression");
const unlinkedPeople = buildGalleryPersonGroups([unlinkedProductionPack]);
assert.equal(unlinkedPeople.length, 9, "given names alone never infer person membership");
assert.equal(new Set(unlinkedPeople.map((person) => person.label)).size, 9);
assert.ok(unlinkedPeople.every((person) => person.label === person.forms[0].displayName),
  "singleton titles use full original display names, not repeated given names");

const manifestOnlyEimi = pack("ba", {
  entities: Object.fromEntries(productionFamilies[0].forms.map((form) => [form.key, {
    display_name: "艾米",
    names: [form.key],
    slots: { avatar: { default: "default", items: {
      default: { storage: "avatars", path: `${form.characterId}.png` },
    } } },
  }])),
  storage: { avatars: { kind: "image-dir", base: "assets/avatar" } },
}, "kivo-missing-catalog-regression");
const manifestOnlyPeople = buildAvatarPickerPersonGroups(buildAvatarCatalog([manifestOnlyEimi]));
assert.equal(manifestOnlyPeople.length, 3);
assert.equal(new Set(manifestOnlyPeople.map((person) => person.label)).size, 3);
assert.ok(manifestOnlyPeople.every((person) => person.label.includes(person.forms[0].entityId)),
  "missing-Catalog fallback exposes exact entity IDs instead of guessing clothes or merging same names");

function stickerSlot(displayName, variants) {
  return { default: "shared", sets: { shared: { display_name: displayName, storage: "shared", variants } } };
}
const mediaBase = pack("media", {
  entities: { Hero: {
    display_name: "媒体角色",
    slots: { sticker: stickerSlot("基础套组", [{ id: "base-id", ordinal: 1, frame: 0 }]) },
  } },
  storage: { shared: { ...imageSequence, path: "resources/base.avifs" } },
});
const addonA = pack("addon_a", {
  contributions: [{
    target: "media::Hero",
    slots: { sticker: stickerSlot("活动套组", [
      { id: "exact-thirty-one", ordinal: 31, frame: 2 },
      { id: "exact-nine", ordinal: 9, frame: 0 },
    ]) },
  }, {
    target: "missing::Only",
    slots: { sticker: stickerSlot("仅增补包资源", [{ id: "orphan-id", ordinal: 14, frame: 1 }]) },
  }],
  storage: { shared: { ...imageSequence, path: "resources/addon-a.avifs" } },
});
const addonB = pack("addon_b", {
  contributions: [{
    target: "media::Hero",
    slots: { sticker: stickerSlot("另一个同名套组", [{ id: "another-id", ordinal: 31, frame: 1 }]) },
  }],
  storage: { shared: { ...imageSequence, path: "resources/addon-b.avifs" } },
});
assert.equal(addonA.stickerContributions.length, 2);
assert.equal(addonA.stickerContributions[0].entityId, "media::Hero");
assert.equal(addonA.stickerContributions[0].sets[0].key, "shared");
assert.equal(addonA.stickerContributions[0].sets[0].contributionNamespace, "addon_a");
assert.equal(addonA.stickerContributions[0].sets[0].selectorId, "addon_a::shared");
assert.deepEqual(addonA.stickerContributions[0].sets[0].variants, [
  { id: "exact-nine", ordinal: 9, frame: 0 },
  { id: "exact-thirty-one", ordinal: 31, frame: 2 },
], "ordinal sorting must not rewrite IDs or substitute ordinal for physical frame");
assert.equal(addonA.stickerContributions[0].sets[0].origin.namespace, "addon_a");
assert.equal(addonA.stickerContributions[0].sets[0].origin.storage, addonA.storage);

const contributedPeople = buildGalleryPersonGroups([addonB, mediaBase, addonA]);
const mediaForm = contributedPeople.flatMap((person) => person.forms).find((form) => form.entityId === "media::Hero");
assert.deepEqual(mediaForm.stickerSets.map((set) => [set.key, set.contributionNamespace, set.selectorId]), [
  ["shared", "media", "media::shared"],
  ["shared", "addon_a", "addon_a::shared"],
  ["shared", "addon_b", "addon_b::shared"],
], "same raw set IDs from distinct contributors must remain independently selectable");
assert.equal(mediaForm.pack.namespace, "media");
assert.equal(mediaForm.entity.stickerSets.length, 1, "Source gallery keeps its base entity's raw sets");
assert.equal(mediaForm.entity.stickerSets[0].key, "shared");
assert.equal(mediaForm.entity.stickerDefault, "shared", "Source inline default-set semantics remain unchanged");
assert.equal(addonA.entities.length, 0, "GUI contribution merging must not add synthetic entities to the Source gallery");
assert.ok(mediaForm.searchTerms.includes("addon_a"));
assert.ok(mediaForm.searchTerms.includes("活动套组"));
assert.ok(mediaForm.searchTerms.includes("exact-thirty-one"));
assert.ok(contributedPeople.find((person) => person.forms.includes(mediaForm)).searchTerms.includes("addon_b"));
const orphanForm = contributedPeople.flatMap((person) => person.forms).find((form) => form.entityId === "missing::Only");
assert.equal(orphanForm.displayName, "missing::Only");
assert.equal(orphanForm.label, "形态未标注 · missing::Only");
assert.deepEqual(orphanForm.stickerSets.map((set) => set.selectorId), ["addon_a::shared"]);
assert.equal(orphanForm.entity.characterId, undefined);
assert.deepEqual(contributedPeople, buildGalleryPersonGroups([addonA, mediaBase, addonB]),
  "contributed set order and fallback groups must be independent of pack input order");

const frameAvatarsPack = pack("animated", {
  contributions: [{ target: "media::Hero", slots: { avatar: { default: "frame-exact", items: {
    "frame-exact": { storage: "frames", frame: 2 },
    outside: { storage: "frames", frame: 3 },
    unsupported: { storage: "unsupported", frame: 1 },
    unsafe: { storage: "unsafe", frame: 1 },
  } } } }],
  storage: {
    frames: { ...imageSequence, path: "frames/avatars.avifs" },
    unsupported: { ...imageSequence, path: "frames/unsupported.avifs", codec: "other" },
    unsafe: { ...imageSequence, path: "../escape.avifs" },
  },
});
const frameAvatars = buildAvatarCatalog([mediaBase, frameAvatarsPack]);
const availableFrame = frameAvatars.find((item) => item.variant.variantId === "frame-exact");
assert.equal(availableFrame.selectable, true);
assert.equal(availableFrame.thumbnailUrl, undefined);
assert.deepEqual([
  availableFrame.variant.entityId, availableFrame.variant.contributionNamespace,
  availableFrame.variant.variantId, availableFrame.variant.frame,
], ["media::Hero", "animated", "frame-exact", 2]);
assert.equal(availableFrame.origin.manifestUrl, frameAvatarsPack.manifestUrl);
for (const variantId of ["outside", "unsupported", "unsafe"]) {
  assert.equal(frameAvatars.find((item) => item.variant.variantId === variantId).selectable, false,
    `${variantId} frame resources must remain visible but unavailable`);
}

const originalFetch = globalThis.fetch;
const resourceRequests = [];
const images = new GalleryImageCache();
globalThis.fetch = async (url) => {
  resourceRequests.push(String(url));
  return { ok: false, status: 418 };
};
try {
  for (const namespace of ["addon_a", "addon_b", "media"]) {
    const set = mediaForm.stickerSets.find((candidate) => candidate.contributionNamespace === namespace);
    await assert.rejects(images.thumbnail(
      mediaForm.pack, mediaForm.entity, set, set.variants[0], new AbortController().signal,
    ), /HTTP 418/);
  }
  assert.deepEqual(resourceRequests, [
    "https://packs.example/addon_a/resources/addon-a.avifs",
    "https://packs.example/addon_b/resources/addon-b.avifs",
    "https://packs.example/media/resources/base.avifs",
  ], "each set must use its own resource authority even when storage and raw set keys collide");

  const unsafeContribution = pack("unsafe_addon", {
    contributions: [{
      target: "media::Hero",
      slots: { sticker: stickerSlot("不安全路径", [{ id: "unchanged", ordinal: 8, frame: 2 }]) },
    }],
    storage: { shared: { ...imageSequence, path: "../escape.avifs" } },
  });
  const unsafeSet = unsafeContribution.stickerContributions[0].sets[0];
  await assert.rejects(images.thumbnail(
    mediaForm.pack, mediaForm.entity, unsafeSet, unsafeSet.variants[0], new AbortController().signal,
  ), /relative segments/);
  assert.equal(resourceRequests.length, 3, "contributed paths must pass the same sanitizer before any request");

  const directAvatar = hero.find((item) => item.variant.variantId === "default");
  assert.equal(await images.avatarThumbnail(directAvatar, new AbortController().signal), directAvatar.thumbnailUrl);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(images.avatarThumbnail(directAvatar, cancelled.signal), { name: "AbortError" });
  for (const variantId of ["outside", "unsupported"]) {
    await assert.rejects(images.avatarThumbnail(
      frameAvatars.find((item) => item.variant.variantId === variantId), new AbortController().signal,
    ), /no supported image resource/);
  }
  await assert.rejects(images.avatarThumbnail(
    frameAvatars.find((item) => item.variant.variantId === "unsafe"), new AbortController().signal,
  ), /relative segments/);
  assert.equal(resourceRequests.length, 3, "direct image URLs, cancellation, and invalid frame metadata must not fetch sequences");
  await assert.rejects(images.avatarThumbnail(availableFrame, new AbortController().signal), /HTTP 418/);
  assert.equal(resourceRequests.at(-1), "https://packs.example/animated/frames/avatars.avifs",
    "contributed avatar frames use the contributor's exact resource origin and existing decoder path");
} finally {
  globalThis.fetch = originalFetch;
  images.dispose();
}

console.log(JSON.stringify({
  avatarVariants: base.avatarVariants.length + extension.avatarVariants.length,
  catalogItems: catalog.length,
  selectableItems: catalog.filter((item) => item.selectable).length,
}));
