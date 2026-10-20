import {
  clickComposerBoundary,
  composerGlyphBoundary,
  composerText,
  expect,
  invokeMmtE2E,
  test,
  type Download,
  type Frame,
  type Page,
  waitForComposerFrame,
  waitForPreviewFrame,
} from "./fixtures";

const tags = ["@editor-runtime", "@gui-composer"];
const guiSurface = (page: Page) => page.getByRole("region", { name: "MomoScript GUI 创作" });
const inputBridge = (frame: Frame) => frame.locator("textarea.composer-input-bridge");
const textState = (page: Page) => invokeMmtE2E(page, "gui", "textState");
const authored = (page: Page, name: string) => invokeMmtE2E(page, "workspace", "readDocument", name);

async function openComposer(page: Page, name: string, source: string): Promise<Frame> {
  await invokeMmtE2E(page, "workspace", "openDocument", name, source);
  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  return await waitForComposerFrame(page, name);
}

async function expectBodies(page: Page, texts: readonly (string | null)[]): Promise<void> {
  await expect.poll(async () => (await textState(page)).bodies.map((body) => body.text)).toEqual(texts);
}

async function expectSelection(
  page: Page,
  anchor: readonly [bodyIndex: number, offsetUtf16: number],
  focus = anchor,
): Promise<void> {
  await expect.poll(async () => (await textState(page)).selection).toEqual({
    anchor: { bodyIndex: anchor[0], offsetUtf16: anchor[1] },
    focus: { bodyIndex: focus[0], offsetUtf16: focus[1] },
  });
}

async function framePoint(frame: Frame, point: { x: number; y: number }) {
  const iframe = await frame.frameElement();
  const bounds = await iframe.boundingBox();
  if (!bounds) throw new Error("The Composer overlay is not visible");
  return { x: bounds.x + point.x, y: bounds.y + point.y };
}

async function dragBodies(
  page: Page,
  frame: Frame,
  anchor: readonly [fragment: string | RegExp, glyphBoundary: number, occurrence?: number],
  focus: readonly [fragment: string | RegExp, glyphBoundary: number, occurrence?: number],
): Promise<void> {
  const start = await framePoint(frame, await composerGlyphBoundary(frame, ...anchor));
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  // Scroll the real viewport while retaining the real pointer capture, including across pages.
  const end = await framePoint(frame, await composerGlyphBoundary(frame, ...focus));
  await page.mouse.move(end.x, end.y, { steps: 12 });
  await page.mouse.up();
}

async function copySelection(page: Page, expected: string): Promise<void> {
  await page.evaluate(() => navigator.clipboard.writeText("MMT copy has not completed"));
  await page.keyboard.press("Control+c");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
}

async function pasteText(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("Control+v");
}

async function resolveRecovery(page: Page, action: "copy" | "discard", expectedText?: string): Promise<void> {
  await page.getByRole("status").getByRole("button", { name: /未提交输入/u }).click();
  await page.getByText(action === "copy" ? "复制未提交文字" : "丢弃未提交文字", { exact: true }).click();
  if (action === "copy") {
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedText);
  }
}

async function replaceWholeBody(page: Page, frame: Frame, fragment: string, replacement: string): Promise<void> {
  await clickComposerBoundary(page, frame, fragment, 0);
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.insertText(replacement);
}

async function composition(frame: Frame, phase: "start" | "update" | "end", text: string): Promise<void> {
  await inputBridge(frame).evaluate((element, event) => {
    const input = element as HTMLTextAreaElement;
    if (event.phase !== "start") input.value = event.text;
    input.dispatchEvent(new CompositionEvent(`composition${event.phase}`, { bubbles: true, data: event.text }));
    if (event.phase === "update") {
      input.dispatchEvent(new InputEvent("input", {
        bubbles: true, inputType: "insertCompositionText", data: event.text, isComposing: true,
      }));
    }
  }, { phase, text });
}

async function expectCaretAtGlyph(frame: Frame, fragment: string, boundary: number, occurrence = 0): Promise<void> {
  const point = await composerGlyphBoundary(frame, fragment, boundary, occurrence);
  await expect.poll(async () => {
    const caret = frame.locator(".composer-caret");
    if (await caret.count() !== 1) return Number.POSITIVE_INFINITY;
    return await caret.evaluate((element, expected) => {
      const rect = element.getBoundingClientRect();
      if (Number((element as HTMLElement).dataset.pageIndex) !== expected.pageIndex
        || rect.bottom <= expected.top || rect.top >= expected.bottom) return Number.POSITIVE_INFINITY;
      return Math.max(Math.abs(rect.left - expected.x), Math.abs(rect.top - expected.lineTop));
    }, point);
  }, { message: "caret must follow both SVG glyph advance and line origin within one CSS pixel" }).toBeLessThanOrEqual(1);
}


async function downloadBytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function nativeMenuItem(page: Page, label: string) {
  return page.locator('[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]').filter({ hasText: label }).last();
}

async function canvasAction(page: Page, label: string): Promise<void> {
  await guiSurface(page).getByRole("button", { name: "内容操作", exact: true }).click();
  const action = nativeMenuItem(page, label);
  await expect(action).toBeVisible();
  await action.click();
}

async function documentAction(page: Page, label: string): Promise<void> {
  await guiSurface(page).getByRole("button", { name: "更多操作", exact: true }).click();
  const action = nativeMenuItem(page, label);
  await expect(action).toBeVisible();
  await action.click();
}

async function expectHeaderActionsInViewport(page: Page): Promise<void> {
  const header = guiSurface(page).locator("header");
  for (const label of ["撤销", "重做", "保存", "导出", "更多操作"]) {
    await expect(header.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  await expect.poll(() => header.getByRole("button").evaluateAll((buttons) => buttons.length === 5 && buttons.every((button) => {
    const bounds = button.getBoundingClientRect();
    return bounds.width >= 44 && bounds.height >= 44 && bounds.left >= 0 && bounds.top >= 0
      && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  }))).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  // Exercise the production immutable renderer exporter, not synthetic fixture PDF ports.
  await page.goto("/?mmtExportMode=current-preview");
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
});

test("SVG glyph edges edit Unicode graphemes without splitting emoji or combining clusters", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-graphemes.mmt";
  const original = "- A😀é中\n- 第二条\n";
  const frame = await openComposer(page, name, original);
  await clickComposerBoundary(page, frame, /^A/u, 0);
  await expectSelection(page, [0, 0]);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expectSelection(page, [0, 3]);
  await page.keyboard.insertText("X");
  await expect.poll(() => authored(page, name)).toBe("- A😀Xé中\n- 第二条\n");
  await page.keyboard.press("Backspace");
  await expect.poll(() => authored(page, name)).toBe(original);
  await page.keyboard.press("Backspace");
  await expect.poll(() => authored(page, name)).toBe("- Aé中\n- 第二条\n");
  await page.keyboard.press("ArrowRight");
  await expectSelection(page, [0, 3]);
  await page.keyboard.press("Backspace");
  await expect.poll(() => authored(page, name)).toBe("- A中\n- 第二条\n");

  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, /^A/u, 0);
  await page.keyboard.press("Backspace");
  await expectSelection(page, [0, 0]);
  expect(await authored(page, name)).toBe("- A中\n- 第二条\n");
  await page.keyboard.insertText("start");
  await expectBodies(page, ["startA中", "第二条"]);
  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, /中$/u, "end");
  await expectSelection(page, [0, 7]);
  await page.keyboard.press("Delete");
  await expectSelection(page, [0, 7]);
  expect(await authored(page, name)).toBe("- startA中\n- 第二条\n");
  await page.keyboard.insertText("end");
  await expect.poll(() => authored(page, name)).toBe("- startA中end\n- 第二条\n");
  await expectBodies(page, ["startA中end", "第二条"]);
  await expect(inputBridge(frame)).toHaveValue("");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
    guiVisible: true, sourceVisible: false, modelCount: 1, textDocumentCount: 1,
  });
  await waitForComposerFrame(page, name);
  await testInfo.attach("unicode-svg-caret", { body: await page.screenshot(), contentType: "image/png" });
});

test("multiline, quote fences and empty bodies preserve semantic LF and authored EOL bytes", { tag: tags }, async ({ page }) => {
  const name = "gui-fenced-body.mmt";
  let frame = await openComposer(page, name, "- seed");
  await replaceWholeBody(page, frame, "seed", "first");
  await expectBodies(page, ["first"]);
  await page.keyboard.press("Enter");
  await page.keyboard.insertText('> @不是语法 """');
  await expectBodies(page, ['first\n> @不是语法 """']);
  expect((await authored(page, name)).endsWith("\n")).toBe(false);
  await page.keyboard.press("Shift+Enter");
  await expectBodies(page, ['first\n> @不是语法 """\n']);
  expect((await authored(page, name)).endsWith("\n")).toBe(false);

  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Shift+End");
  await page.keyboard.press("Backspace");
  await expectBodies(page, [""]);
  expect((await authored(page, name)).endsWith("\n")).toBe(false);
  await waitForComposerFrame(page, name);
  await expect(frame.locator(".composer-caret")).toHaveCount(1);
  const emptyCaret = await frame.locator(".composer-caret").boundingBox();
  if (!emptyCaret) throw new Error("The native empty-body caret is unavailable");
  await page.mouse.click(emptyCaret.x, emptyCaret.y + emptyCaret.height / 2);
  await expectSelection(page, [0, 0]);
  await page.keyboard.insertText("restored");
  await expectBodies(page, ["restored"]);
  expect(await authored(page, name)).not.toMatch(/[\u200b\ufeff]/u);
  expect((await authored(page, name)).endsWith("\n")).toBe(false);

  const crlfName = "gui-crlf-body.mmt";
  const original = '- rt"""\r\n\r\nstart\r\n"""\r\n\r\n@reply: A | B\r\n@bond: bond';
  frame = await openComposer(page, crlfName, original);
  await clickComposerBoundary(page, frame, "start", 0);
  await expectSelection(page, [0, 1]);
  await page.keyboard.press("Shift+End");
  await pasteText(page, "中\r\nnew\rline");
  await expectBodies(page, ["\n中\nnew\nline\n"]);
  await expect.poll(async () => (await textState(page)).bodies[0]?.resolvedMode).toBe("textRaw");
  const afterPaste = await authored(page, crlfName);
  expect(afterPaste.replace(/\r\n/gu, "")).not.toMatch(/[\r\n]/u);
  expect(afterPaste.endsWith("\r\n\r\n@reply: A | B\r\n@bond: bond")).toBe(true);
  await waitForComposerFrame(page, crlfName);
  await clickComposerBoundary(page, frame, "中", 0);
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("Control+Shift+End");
  await copySelection(page, "\n中\nnew\nline\n");
  await inputBridge(frame).press("Control+z");
  await expect.poll(() => authored(page, crlfName)).toBe(original);
});

test("GUI text edits preserve pending Monaco auto-indent outside the authorized edit", { tag: tags }, async ({ page }) => {
  const name = "gui-native-auto-indent.mmt";
  const source = "@typ\n  #let untouched = 1\n@end\n- editable body\n";
  const frame = await openComposer(page, name, source);
  await documentAction(page, "高级源码");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
    sourceVisible: true, guiVisible: false, modelCount: 1,
  });
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const pendingAutoIndent = "@typ\n  #let untouched = 1\n  \n@end\n- editable body\n";
  await expect.poll(() => authored(page, name)).toBe(pendingAutoIndent);

  await invokeMmtE2E(page, "composer", "openGui", name);
  const guiFrame = await waitForComposerFrame(page, name);
  expect(guiFrame).toBe(frame);
  await clickComposerBoundary(page, guiFrame, "editable body", 8);
  await page.keyboard.insertText("X");
  await expect.poll(() => authored(page, name)).toBe(
    "@typ\n  #let untouched = 1\n  \n@end\n- editableX body\n",
  );
});


test("directional cross-message selection copies semantic text and merges atomically on the native undo stack", { tag: tags }, async ({ page, context }) => {
  const name = "gui-cross-messages.mmt";
  const original = "- abc\n- def\n";
  let frame = await openComposer(page, name, original);
  await dragBodies(page, frame, ["abc", 1], ["def", 2]);
  await expectSelection(page, [0, 1], [1, 2]);
  await copySelection(page, "bc\nde");
  const before = await textState(page);
  await page.keyboard.insertText("X");
  await expect.poll(() => authored(page, name)).toBe("- aXf\n");
  await expectBodies(page, ["aXf"]);
  await expectSelection(page, [0, 2]);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(original);
  await expectSelection(page, [0, 1], [1, 2]);
  expect((await textState(page)).alternativeVersionId).toBe(before.alternativeVersionId);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => authored(page, name)).toBe("- aXf\n");
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(original);
  await waitForComposerFrame(page, name);
  await dragBodies(page, frame, ["def", 2], ["abc", 1]);
  await expectSelection(page, [1, 2], [0, 1]);
  await copySelection(page, "bc\nde");
  const clipboard = await context.newCDPSession(page);
  const target = await clipboard.send("Target.getTargetInfo");
  const permission = {
    permission: { name: "clipboard-write" },
    origin: new URL(page.url()).origin,
    browserContextId: target.targetInfo.browserContextId,
  };
  try {
    await clipboard.send("Browser.setPermission", { ...permission, setting: "denied" });
    await expect.poll(() => page.evaluate(async () => (
      await navigator.permissions.query({ name: "clipboard-write" as PermissionName })
    ).state)).toBe("denied");
    const selectedPoint = await framePoint(frame, await composerGlyphBoundary(frame, "abc", 1));
    await page.mouse.click(selectedPoint.x, selectedPoint.y, { button: "right" });
    await nativeMenuItem(page, "剪切").click();
    await expect.poll(async () => (await invokeMmtE2E(page, "gui", "state")).lastNotification).not.toBeNull();
    expect(await authored(page, name)).toBe(original);
  } finally {
    await clipboard.detach();
    // Detaching this CDP session resets its browser permission overrides.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  await waitForComposerFrame(page, name);
  await dragBodies(page, frame, ["def", 2], ["abc", 1]);
  await expectSelection(page, [1, 2], [0, 1]);
  await page.keyboard.press("Control+x");
  await expect.poll(() => authored(page, name)).toBe("- af\n");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("bc\nde");
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(original);

  const envelopesName = "gui-cross-envelopes.mmt";
  const envelopes = ">(fill: green, continued: true) 佳代子: abc\r\n \t\r\n\r\n< 阿洛娜: def\r\n> 佳代子: tail";
  frame = await openComposer(page, envelopesName, envelopes);
  await dragBodies(page, frame, ["def", 2], ["abc", 1]);
  await expectSelection(page, [1, 2], [0, 1]);
  await copySelection(page, "bc\nde");
  await pasteText(page, "X");
  await expect.poll(() => authored(page, envelopesName)).toBe(
    ">(fill: green, continued: true) 佳代子: aXf\r\n \t\r\n\r\n> 佳代子: tail",
  );
  await expectBodies(page, ["aXf", "tail"]);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, envelopesName)).toBe(envelopes);
});

test("opaque, Typst and mode barriers reject the whole range, and failed candidates retain recoverable input", { tag: tags }, async ({ page }) => {
  const name = "gui-text-barriers.mmt";
  const source = '- abc\n@mode: text\n- def\n- T"""#strong[Typst barrier]"""\n- ghi\n- rt"""raw body"""\n';
  let frame = await openComposer(page, name, source);
  await page.evaluate(() => navigator.clipboard.writeText("unchanged clipboard"));
  await dragBodies(page, frame, ["abc", 1], ["def", 2]);
  await page.keyboard.press("Control+c");
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await textState(page)).selection).toBeNull();
  expect(await authored(page, name)).toBe(source);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("unchanged clipboard");

  await clickComposerBoundary(page, frame, "def", 0);
  await dragBodies(page, frame, ["def", 1], ["ghi", 2]);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await textState(page)).selection).toBeNull();
  expect(await authored(page, name)).toBe(source);
  await clickComposerBoundary(page, frame, "ghi", 0);
  await dragBodies(page, frame, ["ghi", 1], ["raw body", 2]);
  await page.keyboard.press("Delete");
  await expect.poll(async () => (await textState(page)).selection).toBeNull();
  expect(await authored(page, name)).toBe(source);

  const inheritedName = "gui-candidate-inheritance.mmt";
  const inherited = "> 佳代子: abc\n> 阿洛娜: def\n> _0: tail\n";
  frame = await openComposer(page, inheritedName, inherited);
  await dragBodies(page, frame, ["abc", 1], ["def", 2]);
  await expectSelection(page, [0, 1], [1, 2]);
  await page.keyboard.insertText("INHERITANCE-REJECTED");
  await expect.poll(async () => (await textState(page)).recoveryText).toContain("INHERITANCE-REJECTED");
  expect(await authored(page, inheritedName)).toBe(inherited);
  await resolveRecovery(page, "copy", "INHERITANCE-REJECTED");

  // A recoverable parse error has no fresh render authorization: an old visible SVG is not editable.
  const errored = `// error-looking\n${inherited}`;
  await invokeMmtE2E(page, "workspace", "replaceDocument", inheritedName, errored);
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({
    nodeKinds: ["opaque", "message", "message", "message"],
  });
  await expect.poll(async () => (await textState(page)).status).not.toBe("ready");
  await expect.poll(() => authored(page, inheritedName)).toBe(errored);
  await documentAction(page, "高级源码");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", inheritedName)).toMatchObject({
    sourceVisible: true, guiVisible: false, modelCount: 1,
  });
});

test("typing drains without compile, stale pointers cannot redirect it, and synthetic IME is a single native transaction", { tag: tags }, async ({ page }) => {
  test.info().annotations.push({
    type: "IME limitation",
    description: "Synthetic composition events only; this does not exercise an OS input method or candidate window. Real Chrome Chinese IME remains a manual acceptance item.",
  });
  const name = "gui-input-queue.mmt";
  const frame = await openComposer(page, name, "- base\n- other\n");
  await clickComposerBoundary(page, frame, "base", "end");
  const bridge = await inputBridge(frame).elementHandle();
  if (!bridge) throw new Error("The native input bridge is unavailable");
  const initial = await textState(page);
  await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 100, compileMs: 10_000 });
  try {
    await page.keyboard.type("0123456789", { delay: 0 });
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("快速😀");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("last");
    await expect.poll(async () => (await textState(page)).pendingIntentCount).toBeGreaterThan(0);
    // The old geometry is still visible. Its second message cannot steal the accepted typing selection.
    const stale = await framePoint(frame, await composerGlyphBoundary(frame, "other", 0));
    await page.mouse.click(stale.x, stale.y);
    await page.keyboard.insertText("!");
    await expectBodies(page, ["base0123456789\n快速😀\nlast!", "other"]);
    expect((await textState(page)).renderKey).toBe(initial.renderKey);
    expect((await textState(page)).rendererGeneration).toBe(initial.rendererGeneration);
    await expect.poll(async () => (await textState(page)).pendingIntentCount).toBe(0);
    await expect(inputBridge(frame)).toBeFocused();
  } finally {
    await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 0, compileMs: 0 });
  }
  await waitForComposerFrame(page, name);
  expect(await bridge.evaluate((element) => element === document.querySelector("textarea.composer-input-bridge"))).toBe(true);
  const beforeIme = '- """\nbase0123456789\n快速😀\nlast!"""\n- other\n';
  await expect.poll(() => authored(page, name)).toBe(beforeIme);
  await composition(frame, "start", "");
  await composition(frame, "update", "中");
  await expect(frame.locator(".composer-composition")).toHaveText("中");
  expect(await authored(page, name)).toBe(beforeIme);
  await invokeMmtE2E(page, "preview", "interactionFixture", { action: "resync-renderer" });
  await waitForPreviewFrame(page, `mmtfs://workspace/${name}`);
  await expect(frame.locator(".composer-composition")).toHaveText("中");
  expect(await bridge.evaluate((element) => element.isConnected && element === document.activeElement)).toBe(true);
  await composition(frame, "update", "中文");
  await composition(frame, "end", "中文");
  await inputBridge(frame).evaluate((element) => element.dispatchEvent(new InputEvent("input", {
    bubbles: true, inputType: "insertText", data: "中文", isComposing: false,
  })));
  await expectBodies(page, ["base0123456789\n快速😀\nlast!中文", "other"]);
  const committed = '- """\nbase0123456789\n快速😀\nlast!中文"""\n- other\n';
  await expect.poll(() => authored(page, name)).toBe(committed);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(beforeIme);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => authored(page, name)).toBe(committed);
  await expectBodies(page, ["base0123456789\n快速😀\nlast!中文", "other"]);
  await composition(frame, "start", "");
  await composition(frame, "update", "取消内容");
  await page.keyboard.press("Escape");
  await composition(frame, "end", "");
  await expect(frame.locator(".composer-composition")).toBeHidden();
  expect(await authored(page, name)).toBe(committed);

  await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 2_000, compileMs: 10_000 });
  try {
    await page.keyboard.insertText("accepted");
    await expect.poll(() => authored(page, name)).toContain("accepted");
    await page.keyboard.insertText("recover this text");
    await expect.poll(async () => (await textState(page)).pendingIntentCount).toBeGreaterThan(0);
    await invokeMmtE2E(page, "workspace", "replaceDocument", name, "- external\n- other\n");
    await expect.poll(async () => (await textState(page)).recoveryText).toContain("recover this text");
    await expect.poll(() => authored(page, name)).toBe("- external\n- other\n");
    expect((await textState(page)).selection).toBeNull();
  } finally {
    await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 0, compileMs: 0 });
  }
  await resolveRecovery(page, "copy", (await textState(page)).recoveryText);
  expect(await authored(page, name)).toBe("- external\n- other\n");
});

test("oversized synthetic IME blur keeps the full local draft copyable without changing source", { tag: tags }, async ({ page }) => {
  test.info().annotations.push({
    type: "IME limitation",
    description: "Synthetic composition and blur events only; this proves local draft retention, not an OS candidate window.",
  });
  const name = "gui-oversized-ime-blur.mmt";
  const source = "- draft target\n";
  const frame = await openComposer(page, name, source);
  await clickComposerBoundary(page, frame, "draft target", 2);
  await page.keyboard.press("End");
  await expectSelection(page, [0, 12]);

  const oversizedDraft = "大".repeat(131_073);
  await composition(frame, "start", "");
  await composition(frame, "update", oversizedDraft);
  expect(await authored(page, name)).toBe(source);
  await inputBridge(frame).evaluate((element) => (element as HTMLTextAreaElement).blur());
  await expect(inputBridge(frame)).toHaveJSProperty("readOnly", true);
  expect(await inputBridge(frame).evaluate(
    (element, expected) => (element as HTMLTextAreaElement).value === expected,
    oversizedDraft,
  )).toBe(true);
  await inputBridge(frame).evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.focus();
    input.select();
  });
  await page.keyboard.press("Control+c");
  expect(await page.evaluate(async (expected) => await navigator.clipboard.readText() === expected, oversizedDraft)).toBe(true);
  expect(await authored(page, name)).toBe(source);
});

test("native glyph advances, line boxes and chosen occurrences survive zoom, reflow, pages and full resync", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-geometric-selection.mmt";
  const firstLine = "WiWi iiii mmmm";
  const secondLine = "second visual line";
  const wrappedBody = Array.from({ length: 32 }, (_, index) => `wrap${String(index).padStart(2, "0")}`).join(" ");
  const source = [
    "@typ", "#set page(width: 420.25pt, height: 260.1pt, margin: 18pt)", "@end",
    '- """', firstLine, secondLine, 'third visual line"""',
    "- repeated body", "- repeated body",
    ...Array.from({ length: 18 }, (_, index) => `- page row ${String(index).padStart(2, "0")} boundary`),
    `- ${wrappedBody}`,
    "@typ", "#set page(width: 280.5pt, height: 120.25pt, margin: 18pt)", "Geometry tail page", "@end",
    "",
  ].join("\n");
  const frame = await openComposer(page, name, source);
  await clickComposerBoundary(page, frame, firstLine, 2);
  await expectSelection(page, [0, 2]);
  await expectCaretAtGlyph(frame, firstLine, 2);
  await page.keyboard.press("Shift+ArrowRight");
  await expectSelection(page, [0, 2], [0, 3]);
  const start = await composerGlyphBoundary(frame, firstLine, 2);
  const end = await composerGlyphBoundary(frame, firstLine, 3);
  const neighbor = await composerText(frame, secondLine).boundingBox();
  if (!neighbor) throw new Error("The neighboring rendered line is unavailable");
  const iframe = await (await frame.frameElement()).boundingBox();
  if (!iframe) throw new Error("The preview iframe is unavailable");
  const neighboringY = neighbor.y - iframe.y + neighbor.height / 2;
  await expect.poll(async () => await frame.locator(".composer-selection-box").evaluateAll((elements, expected) => {
    const boxes = elements.map((element) => element.getBoundingClientRect());
    return {
      leftError: Math.min(...boxes.map((box) => Math.abs(box.left - expected.startX))),
      rightError: Math.min(...boxes.map((box) => Math.abs(box.right - expected.endX))),
      coversNeighbor: boxes.some((box) => box.top <= expected.neighborY && box.bottom >= expected.neighborY),
    };
  }, { startX: start.x, endX: end.x, neighborY: neighboringY })).toMatchObject({ coversNeighbor: false });
  const boxes = await frame.locator(".composer-selection-box").evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right };
  }));
  expect(Math.min(...boxes.map((box) => Math.abs(box.left - start.x)))).toBeLessThanOrEqual(1);
  expect(Math.min(...boxes.map((box) => Math.abs(box.right - end.x)))).toBeLessThanOrEqual(1);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await textState(page)).selection?.focus.offsetUtf16).toBeGreaterThan(firstLine.length);
  await page.keyboard.press("ArrowUp");
  await expectSelection(page, [0, 2]);
  await expectCaretAtGlyph(frame, firstLine, 2);
  await page.keyboard.press("Home");
  await expectSelection(page, [0, 0]);
  await page.keyboard.press("End");
  await expectSelection(page, [0, firstLine.length]);
  // Stay inside the word: its leading edge shares an affinity boundary with the preceding space.
  const word = await framePoint(frame, await composerGlyphBoundary(frame, firstLine, 7));
  await page.mouse.dblclick(word.x, word.y);
  await copySelection(page, "iiii");
  await dragBodies(page, frame, [firstLine, 5], [secondLine, 6]);
  await expectSelection(page, [0, 5], [0, firstLine.length + 1 + 6]);
  await copySelection(page, "iiii mmmm\nsecond");
  const thirdLine = await composerText(frame, "third visual line").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.top + bounds.height / 2;
  });
  expect(await frame.locator(".composer-selection-box").evaluateAll((elements, unselectedY) =>
    elements.some((element) => {
      const bounds = element.getBoundingClientRect();
      return bounds.top <= unselectedY && bounds.bottom >= unselectedY;
    }), thirdLine)).toBe(false);

  await clickComposerBoundary(page, frame, "repeated body", 3, 1);
  await expectSelection(page, [2, 3]);
  await expectCaretAtGlyph(frame, "repeated body", 3, 1);
  const selection = (await textState(page)).selection;
  await frame.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expectCaretAtGlyph(frame, "repeated body", 3, 1);
  expect((await textState(page)).selection).toEqual(selection);
  await page.setViewportSize({ width: 900, height: 700 });
  await frame.getByRole("button", { name: "Fit width", exact: true }).click();
  await expectCaretAtGlyph(frame, "repeated body", 3, 1);
  expect((await textState(page)).selection).toEqual(selection);
  await invokeMmtE2E(page, "preview", "interactionFixture", { action: "resync-renderer" });
  await waitForComposerFrame(page, name);
  await expectCaretAtGlyph(frame, "repeated body", 3, 1);
  expect((await textState(page)).selection).toEqual(selection);

  // A real edit rerenders the same selected occurrence; matching identical page text must not choose its neighbor.
  await inputBridge(frame).focus();
  await page.keyboard.insertText("X");
  await expectBodies(page, [
    `${firstLine}\n${secondLine}\nthird visual line`, "repeated body", "repXeated body",
    ...Array.from({ length: 18 }, (_, index) => `page row ${String(index).padStart(2, "0")} boundary`),
    wrappedBody,
  ]);
  await waitForComposerFrame(page, name);
  await expectCaretAtGlyph(frame, "repXeated body", 4);
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await textState(page)).bodies[2]?.text).toBe("repX\neated body");
  await waitForComposerFrame(page, name);
  await expectSelection(page, [2, 5]);
  await expectCaretAtGlyph(frame, "eated body", 0);

  const firstPage = await composerGlyphBoundary(frame, "page row 00 boundary", 1);
  const lastPage = await composerGlyphBoundary(frame, "page row 17 boundary", 2);
  expect(lastPage.pageIndex).toBeGreaterThan(firstPage.pageIndex);
  const dragStart = await framePoint(frame, await composerGlyphBoundary(frame, "page row 00 boundary", 1));
  const viewport = frame.locator(".viewport");
  const viewportBounds = await viewport.boundingBox();
  if (!viewportBounds) throw new Error("The SVG viewport is unavailable");
  const scrollBeforeDrag = await viewport.evaluate((element) => element.scrollTop);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x, viewportBounds.y + viewportBounds.height - 2, { steps: 8 });
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollBeforeDrag + 10);
  // Move the held pointer into the measured viewport interior to stop edge
  // autoscroll before acquiring the final glyph's current native position.
  const aimBounds = await viewport.boundingBox();
  if (!aimBounds) throw new Error("The SVG viewport is unavailable during the drag");
  await page.mouse.move(aimBounds.x + aimBounds.width / 2, aimBounds.y + aimBounds.height / 2);
  const dragEnd = await framePoint(frame, await composerGlyphBoundary(frame, "page row 17 boundary", 2));
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 8 });
  await page.mouse.up();
  await expectSelection(page, [3, 1], [20, 2]);
  const selectedText = [
    "age row 00 boundary",
    ...Array.from({ length: 16 }, (_, index) => `page row ${String(index + 1).padStart(2, "0")} boundary`),
    "pa",
  ].join("\n");
  await copySelection(page, selectedText);
  const selectedGeometry = await textState(page);
  const selectedPages = [...new Set(selectedGeometry.boxes.map((box) => box.pageIndex))].sort((left, right) => left - right);
  expect(selectedPages).toEqual(expect.arrayContaining([firstPage.pageIndex, lastPage.pageIndex]));
  const visibleSelectedPages = new Set<number>();
  // Offscreen highlights are intentionally unmounted. Visit the selected native
  // pages and prove their highlights become visible without losing the full range.
  for (let index = 0; index < 18; index += 1) {
    const point = await composerGlyphBoundary(frame, `page row ${String(index).padStart(2, "0")} boundary`, 1);
    if (visibleSelectedPages.has(point.pageIndex)) continue;
    await expect(frame.locator(`.composer-selection-box[data-page-index="${point.pageIndex}"]`).first()).toBeInViewport();
    const current = await textState(page);
    expect(current.selection).toEqual(selectedGeometry.selection);
    expect([...new Set(current.boxes.map((box) => box.pageIndex))].sort((left, right) => left - right)).toEqual(selectedPages);
    visibleSelectedPages.add(point.pageIndex);
  }
  expect([...visibleSelectedPages].sort((left, right) => left - right)).toEqual(selectedPages);
  await expectSelection(page, [3, 1], [20, 2]);
  await copySelection(page, selectedText);
  await testInfo.attach("multi-page-svg-selection", { body: await page.screenshot(), contentType: "image/png" });

  await composerGlyphBoundary(frame, /wrap31/u, 3);
  const lastFragment = await composerText(frame, /wrap31/u).textContent();
  if (!lastFragment) throw new Error("The last native wrapped text fragment is unavailable");
  const lastFragmentStart = wrappedBody.indexOf(lastFragment);
  expect(lastFragmentStart).toBeGreaterThan(0);
  expect(wrappedBody.lastIndexOf(lastFragment)).toBe(lastFragmentStart);
  await dragBodies(page, frame, [/^wrap00/u, 3], [lastFragment, 3]);
  await expectSelection(page, [21, 3], [21, lastFragmentStart + 3]);
  await copySelection(page, wrappedBody.slice(3, lastFragmentStart + 3));
  await expect.poll(async () => await frame.locator(".composer-selection-box").evaluateAll((elements) =>
    new Set(elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return Math.round(bounds.top);
    })).size)).toBeGreaterThan(1);

  await page.keyboard.press("Control+Home");
  await expectSelection(page, [0, 0]);
  await expect(frame.locator(".composer-caret")).toBeInViewport();
  await clickComposerBoundary(page, frame, firstLine, 0);
  const beforeDeferredRenderKey = (await textState(page)).renderKey;
  await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 0, compileMs: 2_000 });
  try {
    await page.keyboard.insertText("Z");
    await expect.poll(async () => (await textState(page)).bodies[0]?.text).toBe(
      `Z${firstLine}\n${secondLine}\nthird visual line`,
    );
    const bounds = await viewport.boundingBox();
    if (!bounds) throw new Error("The SVG viewport is unavailable during deferred reveal");
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 5_000);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
    // mouse.wheel returns before native scrolling completes. Capture the user's
    // completed viewport, not an intermediate compositor-animation position.
    await frame.evaluate(async () => {
      const settle = Reflect.get(globalThis, "__mmtWaitForPreviewViewportSettled");
      if (typeof settle !== "function") throw new Error("preview viewport settle acknowledgement is unavailable");
      await settle();
    });
    expect((await textState(page)).renderKey).toBe(beforeDeferredRenderKey);
    const userScroll = await viewport.evaluate((element) => element.scrollTop);
    await waitForComposerFrame(page, name);
    expect(Math.abs(await viewport.evaluate((element) => element.scrollTop) - userScroll)).toBeLessThanOrEqual(1);
    await expect(frame.locator(".composer-caret")).not.toBeInViewport();
  } finally {
    await invokeMmtE2E(page, "gui", "setTextDelays", { snapshotMs: 0, compileMs: 0 });
  }
});

test("SVG authoring retains native properties, source undo, one overlay, persistence, Local History and canonical PDF", { tag: tags }, async ({ page }, testInfo) => {
  const name = "gui-complete-loop.mmt";
  const original = "> 佳代子: first\n> 阿洛娜: second\n- tail\n";
  const frame = await openComposer(page, name, original);
  const bridge = await inputBridge(frame).elementHandle();
  if (!bridge) throw new Error("The single overlay input bridge is unavailable");
  const surface = guiSurface(page);
  const explorer = page.getByRole("tab", { name: /^资源管理器/u });
  await expect(explorer).toBeVisible();
  expect(await explorer.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2));
  }), "the shared overlay must not intercept native activity/sidebar controls").toBe(true);
  await replaceWholeBody(page, frame, "first", "loop body 😀");
  let expectedSource = "> 佳代子: loop body 😀\n> 阿洛娜: second\n- tail\n";
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(original);
  await page.keyboard.press("Control+Shift+z");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await documentAction(page, "高级源码");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ sourceVisible: true, guiVisible: false });
  const editor = page.locator(".workbench-editor .monaco-editor").first();
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.press("End");
  await page.keyboard.insertText(" source");
  await expect.poll(() => authored(page, name)).toBe(expectedSource.replace("loop body 😀", "loop body 😀 source"));
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, /^loop body/u, 0);
  await page.keyboard.press("Control+z");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, /^loop body/u, 0);
  await canvasAction(page, "文本模式");
  let dialog = surface.getByRole("dialog", { name: "文本模式", exact: true });
  await dialog.getByLabel("文本模式").selectOption("textRaw");
  await dialog.getByRole("button", { name: "应用", exact: true }).click();
  expectedSource = "> 佳代子: rt\"\"\"\nloop body 😀\"\"\"\n> 阿洛娜: second\n- tail\n";
  await expect.poll(() => authored(page, name)).toBe(expectedSource);

  const selectMessage = async () => {
    await waitForComposerFrame(page, name);
    await clickComposerBoundary(page, frame, /^loop body/u, 0);
  };
  await selectMessage();
  await surface.getByRole("button", { name: "内容操作", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "连续消息 · 强制连续", exact: true }).click();
  expectedSource = expectedSource.replace("> 佳代子:", ">(continued: true) 佳代子:");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await selectMessage();
  await canvasAction(page, "从本条起修改人物显示名…");
  const displayNameInput = page.locator(".mmt-preview-context-input input");
  await displayNameInput.fill("夜行佳代子");
  await displayNameInput.press("Enter");
  expectedSource = "@actor 佳代子\npreset: ba::佳代子\ndisplay-name: 夜行佳代子\n@end\n" + expectedSource;
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  const avatarInsertion = expectedSource.indexOf("@end");
  await invokeMmtE2E(page, "workspace", "editDocument", name, avatarInsertion, 0, "avatar: ba::阿洛娜/ba::avatar/default\n");
  expectedSource = expectedSource.replace("@end", "avatar: ba::阿洛娜/ba::avatar/default\n@end");
  await selectMessage();
  await canvasAction(page, "从本条起更换人物头像…");
  await page.locator('.mmt-avatar-picker button[data-avatar-entity="ba::佳代子"][data-avatar-variant="default"]').click();
  expectedSource = expectedSource.replace("avatar: ba::阿洛娜/", "avatar: ba::佳代子/");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await selectMessage();
  await canvasAction(page, "更换说话人…");
  dialog = surface.getByRole("dialog", { name: "更换说话人", exact: true });
  await dialog.getByLabel("说话人").selectOption({ label: "阿洛娜" });
  await dialog.getByRole("button", { name: "应用", exact: true }).click();
  expectedSource = expectedSource.replace(">(continued: true) 佳代子:", ">(continued: true) ba::阿洛娜:");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await selectMessage();
  await canvasAction(page, "下移");
  expectedSource = expectedSource.replace(">(continued: true) ba::阿洛娜: rt\"\"\"\nloop body 😀\"\"\"\n> 阿洛娜: second", "> 阿洛娜: second\n>(continued: true) ba::阿洛娜: rt\"\"\"\nloop body 😀\"\"\"");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, "tail", 0);
  await canvasAction(page, "在前面添加…");
  dialog = surface.getByRole("dialog", { name: "添加内容", exact: true });
  await dialog.getByLabel("类型").selectOption("narration");
  await dialog.getByRole("textbox", { name: "正文", exact: true }).fill("inserted");
  await dialog.getByRole("button", { name: "添加", exact: true }).click();
  expectedSource = expectedSource.replace("- tail\n", "- inserted\n- tail\n");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);
  await waitForComposerFrame(page, name);
  await clickComposerBoundary(page, frame, "tail", 0);
  await canvasAction(page, "删除整条旁白");
  expectedSource = expectedSource.replace("- tail\n", "");
  await expect.poll(() => authored(page, name)).toBe(expectedSource);

  const otherName = "gui-second-document.mmt";
  const otherFrame = await openComposer(page, otherName, "- another document\n");
  expect(otherFrame).toBe(frame);
  expect(await bridge.evaluate((element) => element.isConnected)).toBe(true);
  await clickComposerBoundary(page, frame, "another document", "end");
  await page.keyboard.insertText(" second");
  await expect.poll(() => authored(page, otherName)).toBe("- another document second\n");
  expect(await authored(page, name)).toBe(expectedSource);
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  const overlayCounts = await Promise.all(page.frames().map(async (candidate) => {
    try { return await candidate.locator("textarea.composer-input-bridge").count(); } catch { return 0; }
  }));
  expect(overlayCounts.reduce((sum, count) => sum + count, 0)).toBe(1);
  for (const documentName of [name, otherName]) {
    expect(await invokeMmtE2E(page, "composer", "editorState", documentName)).toMatchObject({ modelCount: 1, textDocumentCount: 1 });
  }
  await documentAction(page, "预览");
  expect(await waitForPreviewFrame(page, `mmtfs://workspace/${name}`)).toBe(frame);
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ guiVisible: true });
  await surface.getByRole("button", { name: "保存", exact: true }).click();

  // No immutable fixture is installed: export consumes this real canonical render, never the IME overlay.
  await clickComposerBoundary(page, frame, "inserted", "end");
  await composition(frame, "start", "");
  await composition(frame, "update", "NOT IN THE PDF");
  await expect(frame.locator(".composer-composition")).toHaveText("NOT IN THE PDF");
  expect(await authored(page, name)).toBe(expectedSource);
  await expect(frame.getByLabel("Current preview export")).toHaveAttribute("data-availability", "ready");
  const canonical = await invokeMmtE2E(page, "exactExport", "fixture", { action: "state" });
  const downloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await surface.getByRole("button", { name: "导出", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("gui-complete-loop.pdf");
  const pdf = await downloadBytes(download);
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  await testInfo.attach("canonical-svg-export", { body: pdf, contentType: "application/pdf" });
  if (!canonical || typeof canonical !== "object" || !("displayedRenderKey" in canonical)) {
    throw new Error("The real canonical export revision is unavailable");
  }
  await expect.poll(() => invokeMmtE2E(page, "exactExport", "fixture", { action: "state" })).toMatchObject({
    completedRenderKey: canonical.displayedRenderKey,
  });
  expect(await authored(page, name)).toBe(expectedSource);
  await resolveRecovery(page, "discard");
  await documentAction(page, "历史");
  await expect(page.getByRole("tab", { name: "本地历史", exact: true })).toHaveAttribute("aria-selected", "true");
  await invokeMmtE2E(page, "history", "createCheckpoint", "SVG complete loop");
  await page.getByRole("combobox", { name: "本地历史范围", exact: true }).selectOption("workspace");
  await expect(page.getByRole("tree", { name: "本地历史版本", exact: true })).toContainText("SVG complete loop");
  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  await waitForComposerFrame(page, name);
  await testInfo.attach("desktop-svg-and-native-tools", { body: await page.screenshot(), contentType: "image/png" });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  expect(await authored(page, name)).toBe(expectedSource);
  expect(await authored(page, otherName)).toBe("- another document second\n");
});

test("GUI native action menus accept rapid clicks once and retain keyboard, cancellation and narrow-screen behavior", { tag: tags }, async ({ page }) => {
  const name = "gui-native-action-menu.mmt";
  const original = "> 佳代子: menu body\n- tail\n";
  let frame = await openComposer(page, name, original);
  const surface = guiSurface(page);
  const more = surface.getByRole("button", { name: "更多操作", exact: true });
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  await draft.fill("keep the unsent draft");
  const requestsBefore = (await invokeMmtE2E(page, "gui", "state")).editRequests;

  await documentAction(page, "整理");
  await expect(surface).toHaveAttribute("data-arranging", "true");
  await documentAction(page, "完成整理");
  await expect(surface).toHaveAttribute("data-arranging", "false");
  expect((await invokeMmtE2E(page, "gui", "state")).editRequests).toBe(requestsBefore);

  await more.click();
  await expect(page.getByRole("menuitem", { name: "新建", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: "打开", exact: true })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const arrange = page.getByRole("menuitemcheckbox", { name: "整理", exact: true });
  await expect(arrange).toBeFocused();
  await expect(arrange).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(arrange).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  await draft.click();
  await expect(page.getByRole("menuitem", { name: "高级源码", exact: true })).toBeHidden();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("keep the unsent draft");

  await clickComposerBoundary(page, frame, "menu body", 0);
  const contentMenu = surface.getByRole("button", { name: "内容操作", exact: true });
  await contentMenu.click();
  await expect(page.getByRole("menuitemcheckbox", { name: "连续消息 · 自动", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByRole("menuitemcheckbox", { name: "连续消息 · 强制连续", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(nativeMenuItem(page, "重做")).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  await expect(contentMenu).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitemcheckbox", { name: "连续消息 · 自动", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(contentMenu).toBeFocused();

  await more.click();
  await invokeMmtE2E(page, "workspace", "editDocument", name, original.length, 0, "\n");
  await expect(page.getByRole("menuitem", { name: "高级源码", exact: true })).toBeHidden();
  await expect.poll(() => authored(page, name)).toBe(`${original}\n`);
  await expect(draft).toHaveValue("keep the unsent draft");
  frame = await waitForComposerFrame(page, name);
  await page.setViewportSize({ width: 320, height: 550 });
  await clickComposerBoundary(page, frame, "menu body", 0);
  await surface.getByRole("button", { name: "内容操作", exact: true }).click();
  const menu = page.getByRole("menu").last();
  await expect(menu).toBeVisible();
  const bounds = await menu.evaluate((element) => {
    const popup = element.closest(".context-view");
    if (!popup) throw new Error("The shared native context view is unavailable");
    const rect = popup.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  await page.keyboard.press("End");
  const navigate = page.getByRole("menuitem", { name: "转到源码", exact: true });
  await expect(navigate).toBeFocused();
  await expect(navigate).toBeInViewport();
  await page.keyboard.press("Escape");
  await documentAction(page, "高级源码");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ sourceVisible: true, guiVisible: false });
  await invokeMmtE2E(page, "composer", "openGui", name);
  await waitForComposerFrame(page, name);
  await expect(draft).toHaveValue("keep the unsent draft");
  expect((await invokeMmtE2E(page, "gui", "state")).editRequests).toBe(requestsBefore);
  await draft.fill("");
});

test("bottom Composer sends continuously, retains roles and unsent drafts across canvas edits and native history", { tag: tags }, async ({ page }) => {
  const name = "gui-continuous-writing.mmt";
  let frame = await openComposer(page, name, "> 佳代子: old body\n");
  let surface = guiSurface(page);
  const draft = () => surface.getByRole("textbox", { name: "新消息正文", exact: true });
  await expect(surface.locator("aside")).toHaveCount(0);
  const header = surface.locator("header");
  for (const label of ["撤销", "重做", "保存", "导出", "更多操作"]) {
    const action = header.getByRole("button", { name: label, exact: true });
    await expect(action).toHaveAttribute("title", label);
  }
  await header.getByRole("button", { name: "更多操作", exact: true }).click();
  for (const label of ["新建", "打开", "整理", "高级源码", "问题", "预览", "历史"]) {
    await expect(nativeMenuItem(page, label)).toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(surface.getByRole("button", { name: "老师", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const body of ["Teacher one", "Teacher two"]) {
    await draft().fill(body);
    await draft().press("Enter");
    await expect(draft()).toHaveValue("");
    await expect(surface.getByRole("button", { name: "老师", exact: true })).toHaveAttribute("aria-pressed", "true");
    frame = await waitForComposerFrame(page, name);
  }
  await expectBodies(page, ["old body", "Teacher one", "Teacher two"]);
  expect(await authored(page, name)).toContain('< _0: rt"""\nTeacher one"""\n< _0: rt"""\nTeacher two"""\n');

  await surface.getByRole("button", { name: "角色库", exact: true }).click();
  const library = surface.getByRole("dialog", { name: "选择角色", exact: true });
  await library.getByRole("textbox", { name: "搜索角色", exact: true }).fill("阿洛娜");
  await library.getByRole("button", { name: "阿洛娜", exact: true }).first().click();
  const selectedPortrait = surface.getByRole("button", { name: "阿洛娜", exact: true }).locator("img");
  await expect(selectedPortrait).toBeVisible();
  await expect.poll(() => selectedPortrait.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const currentRole = surface.getByRole("button", { name: "切换角色", exact: true });
  const currentPortrait = currentRole.locator("img");
  await expect(currentRole).toHaveAttribute("title", /阿洛娜/u);
  await expect(currentPortrait).toBeVisible();
  await expect.poll(() => currentPortrait.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  expect(await currentPortrait.getAttribute("src")).toBe(await selectedPortrait.getAttribute("src"));
  for (const body of ["Actor one", "Actor two"]) {
    await draft().fill(body);
    await surface.getByRole("button", { name: "发送", exact: true }).click();
    await expect(draft()).toHaveValue("");
    await expect(surface.getByRole("button", { name: "阿洛娜", exact: true })).toHaveAttribute("aria-pressed", "true");
    frame = await waitForComposerFrame(page, name);
  }
  await expectBodies(page, ["old body", "Teacher one", "Teacher two", "Actor one", "Actor two"]);
  await draft().fill("keep this unsent\nnext line");
  await clickComposerBoundary(page, frame, "old body", "end");
  await page.keyboard.insertText(" edited");
  await expectBodies(page, ["old body edited", "Teacher one", "Teacher two", "Actor one", "Actor two"]);
  await expect(draft()).toHaveValue("keep this unsent\nnext line");
  await surface.getByRole("button", { name: "撤销", exact: true }).click();
  await expectBodies(page, ["old body", "Teacher one", "Teacher two", "Actor one", "Actor two"]);
  await expect(draft()).toHaveValue("keep this unsent\nnext line");
  await surface.getByRole("button", { name: "重做", exact: true }).click();
  await expectBodies(page, ["old body edited", "Teacher one", "Teacher two", "Actor one", "Actor two"]);
  await documentAction(page, "高级源码");
  await invokeMmtE2E(page, "composer", "openGui", name);
  frame = await waitForComposerFrame(page, name);
  surface = guiSurface(page);
  await expect(draft()).toHaveValue("keep this unsent\nnext line");
  await expect(surface.getByRole("button", { name: "阿洛娜", exact: true })).toHaveAttribute("aria-pressed", "true");
  // The draft's real textarea handles IME sessions without interpreting Enter as Send.
  const beforeComposition = await authored(page, name);
  await draft().evaluate((element) => {
    element.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
    element.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "字" }));
  });
  expect(await authored(page, name)).toBe(beforeComposition);
  await expect(draft()).toHaveValue("keep this unsent\nnext line");
  await draft().fill("");
});

test("saved pack-backed fenced EOF messages reopen with live text authority and retain continuous sending", { tag: tags }, async ({ page }) => {
  const name = "gui-reopen-fenced-eof.mmt";
  const original = [
    "- 放学后的讨论（修改）",
    "< 今天的安排准备好了吗？",
    "- 先写下一条，再回头修改。",
    '> ba::阿洛娜: rt"""',
    '老师，已经准备好了。"""',
  ].join("\n");
  await openComposer(page, name, original);
  await guiSurface(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect.poll(() => authored(page, name)).toBe(original);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
  await invokeMmtE2E(page, "composer", "openGui", name);
  await invokeMmtE2E(page, "composer", "keepEditor", name);
  await waitForComposerFrame(page, name);
  expect(await authored(page, name)).toBe(original);
  const surface = guiSurface(page);
  const bodies = ["放学后的讨论（修改）", "今天的安排准备好了吗？", "先写下一条，再回头修改。", "老师，已经准备好了。"];
  await expectBodies(page, bodies);
  await expect(surface.getByRole("button", { name: "老师", exact: true })).toBeEnabled();
  await surface.getByRole("button", { name: "角色库", exact: true }).click();
  const library = surface.getByRole("dialog", { name: "选择角色", exact: true });
  await library.getByRole("textbox", { name: "搜索角色", exact: true }).fill("阿洛娜");
  await library.getByRole("button", { name: "阿洛娜", exact: true }).first().click();
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  const committed: string[] = [];
  const requestsBefore = (await invokeMmtE2E(page, "gui", "state")).editRequests;
  let previousSource = original;
  for (const body of ["下一句留在这里，尚未发送", "再写一句，保持同一个角色"]) {
    await draft.fill(body);
    await expect(surface.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    await surface.getByRole("button", { name: "发送", exact: true }).click();
    await expect(draft).toHaveValue("");
    bodies.push(body);
    await expectBodies(page, bodies);
    await expect.poll(() => authored(page, name)).not.toBe(previousSource);
    previousSource = await authored(page, name);
    expect(previousSource.startsWith(original)).toBe(true);
    committed.push(previousSource);
    await waitForComposerFrame(page, name);
    await expect(surface.getByRole("button", { name: "阿洛娜", exact: true, pressed: true })).toBeVisible();
  }
  expect((await invokeMmtE2E(page, "gui", "state")).editRequests - requestsBefore).toBe(2);
  await surface.getByRole("button", { name: "撤销", exact: true }).click();
  await expect.poll(() => authored(page, name)).toBe(committed[0]);
  await waitForComposerFrame(page, name);
  await surface.getByRole("button", { name: "重做", exact: true }).click();
  await expect.poll(() => authored(page, name)).toBe(committed[1]);
  await expect(draft).toHaveValue("");
});

test("bottom Shift+Enter and multiline clipboard paste each submit exactly one message", { tag: tags }, async ({ page }) => {
  const name = "gui-bottom-multiline-transactions.mmt";
  const original = "- seed\n";
  await openComposer(page, name, original);
  const draft = guiSurface(page).getByRole("textbox", { name: "新消息正文", exact: true });
  await draft.click();
  await page.keyboard.insertText("typed first");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.insertText("typed second");
  await expect(draft).toHaveValue("typed first\ntyped second");
  expect(await authored(page, name)).toBe(original);
  await page.keyboard.press("Enter");
  await expect(draft).toHaveValue("");
  await expectBodies(page, ["seed", "typed first\ntyped second"]);
  await waitForComposerFrame(page, name);
  const firstCommit = await authored(page, name);
  await draft.focus();
  await pasteText(page, "pasted first\npasted second");
  await expect(draft).toHaveValue("pasted first\npasted second");
  expect(await authored(page, name)).toBe(firstCommit);
  await page.keyboard.press("Enter");
  await expect(draft).toHaveValue("");
  await expectBodies(page, ["seed", "typed first\ntyped second", "pasted first\npasted second"]);
  await expect.poll(async () => (await invokeMmtE2E(page, "gui", "state")).nodeKinds).toEqual(["narration", "message", "message"]);
});

test("bottom drafts are literal text even under Typst inheritance, and Teacher availability follows the Rust boundary", { tag: tags }, async ({ page }) => {
  const name = "gui-literal-draft.mmt";
  const original = "@mode: T\n- Seed\n";
  await openComposer(page, name, original);
  let surface = guiSurface(page);
  const literal = "#strong[not code]\n> @reply: still text";
  await surface.getByRole("textbox", { name: "新消息正文", exact: true }).fill(literal);
  await surface.getByRole("button", { name: "发送", exact: true }).click();
  await expect.poll(async () => (await textState(page)).bodies.at(-1)).toMatchObject({ text: literal, resolvedMode: "textRaw" });
  expect((await authored(page, name)).startsWith(original)).toBe(true);
  const restrictedName = "gui-teacher-boundary.mmt";
  const restricted = "< 佳代子: named right\n";
  await openComposer(page, restrictedName, restricted);
  surface = guiSurface(page);
  const teacher = surface.getByRole("button", { name: "老师", exact: true });
  await expect(teacher).toBeDisabled();
  await expect(teacher).toHaveAttribute("title", /右侧说话人/u);
  await surface.getByRole("textbox", { name: "新消息正文", exact: true }).fill("retained, not silently reassigned");
  await expect(surface.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
  expect(await authored(page, restrictedName)).toBe(restricted);
  await surface.getByRole("textbox", { name: "新消息正文", exact: true }).fill("");
});

test("native block menus and multiline local Source Lens stay on the SVG canvas and preserve untouched source", { tag: tags }, async ({ page }) => {
  const name = "gui-local-source.mmt";
  const original = "- seed\n@typ\n#text(fill: blue)[Source lens]\n@end\n- tail\n";
  let frame = await openComposer(page, name, original);
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  await draft.fill("unsent while editing old content");
  await clickComposerBoundary(page, frame, "seed", 0);
  const point = await framePoint(frame, await composerGlyphBoundary(frame, "seed", 1));
  await page.mouse.click(point.x, point.y, { button: "right" });
  await nativeMenuItem(page, "编辑正文…").click();
  let local = page.getByRole("dialog", { name: "编辑正文", exact: true });
  await expect(local).toBeVisible();
  await expect(surface).toHaveAttribute("data-active", "true");
  await expect(surface.locator(".mmt-composer-inactive")).toBeHidden();
  await expect(frame.locator(".page")).toBeVisible();
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({ uri: `mmtfs://workspace/${name}` });
  await local.locator(".monaco-editor").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText("line one");
  await page.keyboard.press("Enter");
  await page.keyboard.insertText("line two");
  expect(await authored(page, name)).toBe(original);
  await page.keyboard.press("Control+Enter");
  await expectBodies(page, ["line one\nline two", "tail"]);
  const multiline = '- """\nline one\nline two"""\n@typ\n#text(fill: blue)[Source lens]\n@end\n- tail\n';
  await expect.poll(() => authored(page, name)).toBe(multiline);
  await expect(draft).toHaveValue("unsent while editing old content");
  frame = await waitForComposerFrame(page, name);

  await documentAction(page, "整理");
  await expect(surface).toHaveAttribute("data-arranging", "true");
  const retainedState = await textState(page);
  const retainedRenderer = {
    rendererSessionId: retainedState.rendererSessionId,
    rendererGeneration: retainedState.rendererGeneration,
  };
  // A scratch Monaco code model must not replace the selected native GUI
  // editor as the owner of the retained SVG, including while it has focus.
  await surface.getByLabel("整理内容", { exact: true }).selectOption({ index: 1 });
  await surface.getByRole("button", { name: "局部源码", exact: true }).click();
  local = page.getByRole("dialog", { name: "编辑局部源码", exact: true });
  await local.locator(".monaco-editor").click();
  await expect(surface).toHaveAttribute("data-active", "true");
  await expect(surface.locator(".mmt-composer-inactive")).toBeHidden();
  await expect(frame.locator(".page")).toBeVisible();
  await expect.poll(() => invokeMmtE2E(page, "gui", "state")).toMatchObject({ uri: `mmtfs://workspace/${name}` });
  await expect.poll(() => textState(page)).toMatchObject(retainedRenderer);
  await expect(draft).toHaveValue("unsent while editing old content");
  expect(await authored(page, name)).toBe(multiline);
  await page.keyboard.press("Escape");
  await surface.getByLabel("整理内容", { exact: true }).selectOption({ index: 2 });
  await surface.getByRole("button", { name: "局部源码", exact: true }).click();
  local = page.getByRole("dialog", { name: "编辑局部源码", exact: true });
  await expect(local.locator(".view-lines")).toContainText("@typ");
  await local.locator(".monaco-editor").click();
  await expect(surface).toHaveAttribute("data-active", "true");
  await expect(surface.locator(".mmt-composer-inactive")).toBeHidden();
  await expect(frame.locator(".page")).toBeVisible();
  await expect.poll(() => textState(page)).toMatchObject(retainedRenderer);
  await page.keyboard.press("Control+a");
  const replacement = "@typ\n#text(fill: blue)[Source lens changed]\n@end\n";
  await page.keyboard.insertText(replacement);
  await page.keyboard.press("Escape");
  expect(await authored(page, name)).toBe(multiline);
  await surface.getByRole("button", { name: "局部源码", exact: true }).click();
  local = page.getByRole("dialog", { name: "编辑局部源码", exact: true });
  await local.locator(".monaco-editor").click();
  await page.keyboard.press("Control+a");
  await page.keyboard.insertText(replacement);
  await local.getByRole("button", { name: "应用", exact: true }).click();
  const changed = multiline.replace("@typ\n#text(fill: blue)[Source lens]\n@end\n", replacement);
  await expect.poll(() => authored(page, name)).toBe(changed);
  await expect(draft).toHaveValue("unsent while editing old content");
  await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ guiVisible: true, sourceVisible: false, modelCount: 1, textDocumentCount: 1 });
  await waitForComposerFrame(page, name);
  await surface.getByLabel("整理内容", { exact: true }).selectOption({ index: 2 });
  await surface.getByRole("button", { name: "局部源码", exact: true }).click();
  local = page.getByRole("dialog", { name: "编辑局部源码", exact: true });
  await local.locator(".monaco-editor").click();
  await page.keyboard.press("Control+a");
  const retained = "@typ\n#text[unsubmitted local draft]\n@end\n";
  await page.keyboard.insertText(retained);
  await invokeMmtE2E(page, "workspace", "editDocument", name, changed.length, 0, "\n");
  await expect(local).toHaveCount(0);
  await expect.poll(() => authored(page, name)).toBe(`${changed}\n`);
  await expect(draft).toHaveValue("unsent while editing old content");
  await resolveRecovery(page, "copy", retained);
  await surface.getByRole("button", { name: "完成整理", exact: true }).click();
  await expect(surface).toHaveAttribute("data-arranging", "false");
  await draft.fill("");
});

test("canceling reload retains the bottom draft and leaves the live canvas runtime editable", { tag: tags }, async ({ page, context }) => {
  const name = "gui-cancel-draft-reload.mmt";
  const frame = await openComposer(page, name, "- live canvas\n");
  const surface = guiSurface(page);
  const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
  await draft.click();
  await page.keyboard.insertText("do not lose this draft");
  const cdp = await context.newCDPSession(page);
  try {
    const dialogPromise = page.waitForEvent("dialog", { predicate: (dialog) => dialog.type() === "beforeunload" });
    const reloadRequested = cdp.send("Page.reload");
    const dialog = await dialogPromise;
    await dialog.dismiss();
    // A canceled reload has no navigation commit; wait only for the native request acknowledgement.
    await reloadRequested;
  } finally {
    await cdp.detach();
  }
  await expect(draft).toHaveValue("do not lose this draft");
  await expect(frame.locator(".page")).toBeVisible();
  await clickComposerBoundary(page, frame, "live canvas", "end");
  await page.keyboard.insertText(" still live");
  await expect.poll(() => authored(page, name)).toBe("- live canvas still live\n");
  await expect(draft).toHaveValue("do not lose this draft");
  await draft.fill("");
});

test.describe("mobile SVG composer", () => {
  test.use({ hasTouch: true });

  test("compact GUI collapses restored native navigation and keeps every header action inside the viewport", {
    tag: [...tags, "@gui-composer-mobile"],
  }, async ({ page }) => {
    const name = "compact-native-navigation.mmt";
    await openComposer(page, name, "- reachable native GUI\n");
    await guiSurface(page).getByRole("button", { name: "保存", exact: true }).click();
    const sidebar = page.locator(".workbench-sidebar");
    await page.keyboard.press("Control+Shift+e");
    await expect(sidebar).toBeVisible();
    await page.setViewportSize({ width: 550, height: 760 });
    await expect(sidebar).toBeHidden();
    await expectHeaderActionsInViewport(page);

    // Explicit native view toggles remain available while the same GUI is active.
    await page.keyboard.press("Control+Shift+e");
    await expect(sidebar).toBeVisible();
    await expectHeaderActionsInViewport(page);
    await page.setViewportSize({ width: 1280, height: 820 });
    await invokeMmtE2E(page, "composer", "openGui", name);
    await expect(sidebar).toBeVisible();
    // Persist the desktop layout, then restore it at 320px without a live desktop resize handler.
    await page.goto("about:blank");
    await page.setViewportSize({ width: 320, height: 760 });
    await page.goto("/?mmtExportMode=current-preview");
    await expect(page.locator("html")).toHaveAttribute("data-mmt-stage", "mmt-ready");
    await invokeMmtE2E(page, "composer", "openGui", name);
    await waitForComposerFrame(page, name);
    await expect(sidebar).toBeHidden();
    await expectHeaderActionsInViewport(page);
    expect(await authored(page, name)).toBe("- reachable native GUI\n");

    await documentAction(page, "高级源码");
    await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({
      guiVisible: false, sourceVisible: true, modelCount: 1, textDocumentCount: 1,
    });
    await page.keyboard.press("Control+Shift+e");
    await expect(sidebar).toBeVisible();
  });

  test("550px default, 320px touch selection and keyboard-sized viewport keep the caret and Sheet reachable", {
    tag: [...tags, "@gui-composer-mobile"],
  }, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width: 551, height: 760 });
    await invokeMmtE2E(page, "workspace", "openDocument", "desktop-threshold.mmt", "- desktop\n");
    await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", "desktop-threshold.mmt")).toMatchObject({
      sourceVisible: true, guiVisible: false,
    });
    await page.setViewportSize({ width: 550, height: 760 });
    const name = "mobile-threshold.mmt";
    await invokeMmtE2E(page, "workspace", "openDocument", name, "- mobile body\n");
    const frame = await waitForComposerFrame(page, name);
    const surface = guiSurface(page);
    const draft = surface.getByRole("textbox", { name: "新消息正文", exact: true });
    const unsent = "尚未发送的下一句话需要完整显示";
    await draft.fill(unsent);
    await page.setViewportSize({ width: 320, height: 640 });
    await frame.getByRole("button", { name: "Fit width", exact: true }).click();
    await expect(draft).toHaveValue(unsent);
    await expect.poll(() => draft.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      return input.scrollHeight <= input.clientHeight;
    })).toBe(true);
    await draft.fill("");
    expect(await surface.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.locator("body").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const actionTops = await surface.locator(".mmt-composer-toolbar-actions button").evaluateAll((buttons) =>
      buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
    expect(new Set(actionTops).size).toBe(1);
    const targets = await surface.locator("button, select, input:not([type=hidden]), textarea").evaluateAll((buttons) => buttons
      .filter((button) => button.getClientRects().length > 0)
      .map((button) => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
    expect(targets.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
    const previewTargets = await frame.locator(".preview-toolbar button, .preview-toolbar select").evaluateAll((controls) => controls
      .filter((control) => control.getClientRects().length > 0)
      .map((control) => ({ width: control.getBoundingClientRect().width, height: control.getBoundingClientRect().height })));
    expect(previewTargets.every((box) => box.width >= 44 && box.height >= 44)).toBe(true);
    const start = await framePoint(frame, await composerGlyphBoundary(frame, "mobile body", 0));
    await page.touchscreen.tap(start.x, start.y);
    await expect(inputBridge(frame)).toBeFocused();
    await page.keyboard.press("Shift+ArrowRight");
    await expectSelection(page, [0, 0], [0, 1]);
    const focusHandle = frame.locator('.composer-touch-handle[data-endpoint="focus"]');
    await expect(focusHandle).toBeVisible();
    const handle = await focusHandle.boundingBox();
    if (!handle) throw new Error("The native semantic touch selection handle is unavailable");
    expect(handle.width).toBeGreaterThanOrEqual(44);
    expect(handle.height).toBeGreaterThanOrEqual(44);
    const end = await framePoint(frame, await composerGlyphBoundary(frame, "mobile body", "end"));
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: end.x, y: end.y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    } finally {
      await cdp.detach();
    }
    await expectSelection(page, [0, 0], [0, 11]);
    await copySelection(page, "mobile body");
    await page.keyboard.insertText("mobile edited");
    await expectBodies(page, ["mobile edited"]);
    await waitForComposerFrame(page, name);
    // Browser viewport reduction is a soft-keyboard geometry equivalent, not an OS keyboard claim.
    await page.setViewportSize({ width: 320, height: 360 });
    await expect(frame.locator(".composer-caret")).toBeInViewport();
    await expect(inputBridge(frame)).toBeFocused();
    await canvasAction(page, "文本模式");
    const dialog = surface.getByRole("dialog", { name: "文本模式", exact: true });
    await expect(dialog.getByLabel("文本模式")).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "应用", exact: true })).toBeInViewport();
    await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeInViewport();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await clickComposerBoundary(page, frame, "mobile edited", "end");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("next line");
    await expectBodies(page, ["mobile edited\nnext line"]);
    await waitForComposerFrame(page, name);
    await expect(frame.locator(".composer-caret")).toBeInViewport();
    await testInfo.attach("320px-svg-keyboard-viewport", { body: await page.screenshot(), contentType: "image/png" });
    await documentAction(page, "高级源码");
    await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", name)).toMatchObject({ sourceVisible: true, guiVisible: false });
    await page.waitForTimeout(500);
    expect((await invokeMmtE2E(page, "composer", "editorState", name)).sourceVisible).toBe(true);
    await invokeMmtE2E(page, "workspace", "openDocument", "mobile-second.mmt", "- second mobile document\n");
    expect(await waitForComposerFrame(page, "mobile-second.mmt")).toBe(frame);
    await documentAction(page, "预览");
    await expect.poll(() => invokeMmtE2E(page, "composer", "editorState", "mobile-second.mmt")).toMatchObject({ guiVisible: true });
    expect(await frame.locator("body").evaluate((element) => getComputedStyle(element).overflow)).toBe("hidden");
    expect(await frame.locator(".viewport").evaluate((element) => getComputedStyle(element).overflow)).toMatch(/auto|scroll/u);
  });
});
