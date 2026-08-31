import { expect, invokeMmtE2E, test } from "./fixtures";

const NAME = "composer-characterization.mmt";

test("a pinned native GUI editor restores through its URI serializer", {
  tag: ["@editor-runtime", "@gui-composer-characterization"],
}, async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  const validSerialized = JSON.stringify({ version: 1, uri: `mmtfs://workspace/${NAME}` });
  expect(await invokeMmtE2E(page, "composer", "deserializeEditor", validSerialized)).toBe(`mmtfs://workspace/${NAME}`);
  for (const serialized of [
    "{",
    JSON.stringify({ version: 1, uri: "https://example.com/story.mmt" }),
    JSON.stringify({ version: 1, uri: "mmtfs://other/story.mmt" }),
    JSON.stringify({ version: 1, uri: "mmtfs://workspace/../story.mmt" }),
    JSON.stringify({ version: 1, uri: "mmtfs://workspace/story.typ" }),
    JSON.stringify({ version: 1, uri: "mmtfs://workspace/story.mmt?query=1" }),
    JSON.stringify({ version: 1, uri: "mmtfs://workspace/story.mmt", extra: true }),
  ]) {
    expect(await invokeMmtE2E(page, "composer", "deserializeEditor", serialized)).toBeNull();
  }
  await expect(invokeMmtE2E(page, "composer", "openResource", "https://example.com/story.mmt"))
    .resolves.toBe("GUI 创作只支持工作区 MMT 文档");
  await invokeMmtE2E(page, "workspace", "openDocument", NAME, "- GUI characterization\n");

  await invokeMmtE2E(page, "composer", "openGui", NAME);
  await expect(page.locator(`.mmt-composer-surface[data-resource$="/${NAME}"]`)).toBeVisible();
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", NAME)).toMatchObject({
    guiVisible: true,
    textDocumentCount: 1,
    modelCount: 1,
  });

  const pinned = await invokeMmtE2E(page, "composer", "keepEditor", NAME);
  expect(pinned.isPreview).toBe(false);
  expect(pinned.isPinned).toBe(true);
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", NAME)).toMatchObject({
    isPreview: false,
    isPinned: true,
  });

  await invokeMmtE2E(page, "composer", "openSource", NAME);
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", NAME)).toMatchObject({
    sourceVisible: true,
    textDocumentCount: 1,
    modelCount: 1,
  });
  await invokeMmtE2E(page, "composer", "openGui", NAME);
  await invokeMmtE2E(page, "composer", "keepEditor", NAME);
  await page.waitForTimeout(6_000);

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await expect(page.locator(`.mmt-composer-surface[data-resource$="/${NAME}"]`)).toBeVisible({ timeout: 90_000 });
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", NAME)).toMatchObject({
    guiVisible: true,
    textDocumentCount: 1,
    modelCount: 1,
    isPreview: false,
    isPinned: true,
  });
});
