import assert from "node:assert/strict";
import { buildAvatarCatalog, projectGalleryPack } from "../src/galleryPack.ts";

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
assert.equal(hero.find((item) => item.variant.variantId === "sequence")?.selectable, false);
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

console.log(JSON.stringify({
  avatarVariants: base.avatarVariants.length + extension.avatarVariants.length,
  catalogItems: catalog.length,
  selectableItems: catalog.filter((item) => item.selectable).length,
}));
