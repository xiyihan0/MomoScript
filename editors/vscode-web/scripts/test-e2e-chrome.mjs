import { spawnSync } from "node:child_process";

const specs = [
  "e2e/current-preview-export.spec.ts",
  "e2e/editor.spec.ts",
  "e2e/exact-export.spec.ts",
  "e2e/local-history.spec.ts",
  "e2e/preview-interaction.spec.ts",
];

for (const spec of specs) {
  const result = spawnSync(
    process.execPath,
    ["node_modules/@playwright/test/cli.js", "test", "--project=chrome", spec],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
