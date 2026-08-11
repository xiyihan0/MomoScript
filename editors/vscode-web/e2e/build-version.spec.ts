import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "./fixtures";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

function expectedBuildVersion(): string {
  const override = process.env.MOMOSCRIPT_BUILD_VERSION?.trim();
  if (override) return override;

  const [epochText, commit = ""] = execFileSync(
    "git",
    ["show", "-s", "--format=%ct%n%H", "HEAD"],
    { cwd: repositoryRoot, encoding: "utf8" },
  ).trim().split(/\r?\n/, 2);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(Number(epochText) * 1_000)).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}-${commit.slice(0, 7)}`;
}

const expectedVersion = expectedBuildVersion();

test("production build exposes a traceable version without status-bar clutter", { tag: ["@editor-runtime"] }, async ({ page }) => {
  await page.goto("/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-mmt-stage", "mmt-ready");

  const buildVersion = await html.getAttribute("data-mmt-version");
  expect(buildVersion).toBe(expectedVersion);
  await expect(page.getByRole("status")).not.toContainText(buildVersion!);

  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByRole("menuitem", { name: "关于 MomoScript", exact: true }).click();
  const about = page.locator(".notification-list-item-message").filter({ hasText: "MomoScript Web · 构建版本" });
  await expect(about).toContainText(expectedVersion);
  await expect(about).toHaveCSS("font-size", "13px");
  await expect(about).toHaveCSS("color", "rgb(204, 204, 204)");

  await page.getByRole("button", { name: "通知", exact: true }).click();
  const notificationCenter = page.locator(".notifications-center.visible");
  await expect(notificationCenter).toBeVisible();
  const notificationTitle = notificationCenter.locator(".notifications-center-header-title");
  await expect(notificationTitle).toHaveText("通知");
  await expect(notificationTitle).toHaveCSS("color", "rgb(204, 204, 204)");
  await expect(page.locator(".monaco-workbench")).toHaveCSS("font-size", "13px");
  await expect(page.locator(".view-lines .view-line").first()).toHaveCSS("font-size", "14px");
});
