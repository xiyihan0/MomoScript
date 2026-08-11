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
});
