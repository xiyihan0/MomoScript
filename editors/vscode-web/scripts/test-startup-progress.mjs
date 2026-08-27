import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createInitialStartupProgress,
  reduceStartupProgress,
} from "../src/startupProgress.ts";

const stage = (snapshot, id) => snapshot.stages.find((candidate) => candidate.id === id);

const initial = createInitialStartupProgress();
assert.equal(initial.stages.length, 4);
assert.deepEqual(initial.stages.map(({ id }) => id), ["workbench", "filesystem", "tinymist", "mmt"]);
assert.equal(stage(initial, "workbench")?.state, "active");
assert.ok(initial.stages.slice(1).every(({ state }) => state === "pending"));

const requested = reduceStartupProgress(initial, {
  kind: "tinymist-artifact",
  progress: {
    phase: "download",
    state: "started",
    receivedBytes: 0,
    totalBytes: 8_781_775,
  },
});
assert.deepEqual(
  { received: stage(requested, "tinymist")?.receivedBytes, total: stage(requested, "tinymist")?.totalBytes },
  { received: 0, total: 8_781_775 },
);
assert.equal(stage(requested, "tinymist")?.percent, 0);

const downloading = reduceStartupProgress(requested, {
  kind: "tinymist-artifact",
  progress: {
    phase: "download",
    state: "progress",
    receivedBytes: 2_195_444,
    totalBytes: 8_781_775,
  },
});
assert.equal(stage(downloading, "tinymist")?.receivedBytes, 2_195_444);
assert.equal(stage(downloading, "tinymist")?.percent, 25);

const downloaded = reduceStartupProgress(downloading, {
  kind: "tinymist-artifact",
  progress: {
    phase: "download",
    state: "complete",
    receivedBytes: 8_781_775,
    totalBytes: 8_781_775,
  },
});
assert.equal(stage(downloaded, "tinymist")?.percent, 99, "download completion must not imply verified startup completion");

const decoding = reduceStartupProgress(downloaded, {
  kind: "tinymist-artifact",
  progress: { phase: "decode", state: "started", encodedBytes: 8_781_775 },
});
assert.equal(stage(decoding, "tinymist")?.detail, "正在校验并解压");
assert.equal(stage(decoding, "tinymist")?.percent, 99);

const failed = reduceStartupProgress(decoding, {
  kind: "stage",
  id: "tinymist",
  state: "failed",
  detail: "固定资源下载失败",
});
assert.equal(stage(failed, "tinymist")?.state, "failed");
assert.equal(stage(failed, "tinymist")?.percent, 99, "a failed resource must never display 100%");
assert.equal(reduceStartupProgress(failed, { kind: "ready" }).hasFailure, true);

const complete = reduceStartupProgress(decoding, {
  kind: "tinymist-artifact",
  progress: {
    phase: "decode",
    state: "complete",
    encodedBytes: 8_781_775,
    decodedBytes: 32_911_559,
  },
});
assert.equal(stage(complete, "tinymist")?.state, "complete");
assert.equal(stage(complete, "tinymist")?.percent, 100);

const html = await readFile(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
const css = await readFile(fileURLToPath(new URL("../src/startupProgress.css", import.meta.url)), "utf8");
assert.ok(html.indexOf('id="mmt-startup"') < html.indexOf('id="workbench"'));
assert.equal(html.match(/data-mmt-startup-stage=/g)?.length, 4);
assert.match(html, /Tinymist 固定 WASM/);
assert.match(html, /data-mmt-startup-live[\s\S]*role="status"/);
assert.match(css, /pointer-events:\s*none/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(css, /max-width:\s*420px/);

console.log("startup progress contracts passed");
