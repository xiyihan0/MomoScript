import {
  TinymistWorkerClient,
  validatePreviewRendererReady,
  type PreviewRendererReady,
  type TypstProjectUpdate
} from "../tinymistClient";
import { canonicalBytesDigest } from "../runtimeIdentity";

interface CompletionList {
  items: Array<{ label: string | { label: string } }>;
}

function hasLabel(result: CompletionList, expected: string): boolean {
  return result.items.some((item) =>
    typeof item.label === "string" ? item.label === expected : item.label.label === expected
  );
}

function fixtureIdentity(revision: number): Pick<
  TypstProjectUpdate,
  "sourceContent" | "projectDigest" | "projectionKey" | "mappingDigest"
> {
  const key = `fixture-${revision}`;
  return {
    sourceContent: key as TypstProjectUpdate["sourceContent"],
    projectDigest: key as TypstProjectUpdate["projectDigest"],
    projectionKey: key as TypstProjectUpdate["projectionKey"],
    mappingDigest: key
  };
}

async function testWorkerPreviewRenderer(client: TinymistWorkerClient): Promise<boolean> {
  const sessionId = "web-transcript";
  const logicalSourceId = "a".repeat(64);
  const entryUri = "untitled:/mmt-projection/web-preview-renderer/main.typ";
  const project = async (revision: number, length: number): Promise<TypstProjectUpdate> => {
    const text = `#set page(width: 120pt, height: 80pt)\n#line(length: ${length}pt)`;
    const digest = await canonicalBytesDigest("mmt-project-file-v1", [new TextEncoder().encode(text)]);
    return {
      sourceUri: "file:///workspace/web-preview-renderer.mmt",
      sourceVersion: revision,
      revision,
      ...fixtureIdentity(100 + revision),
      entryUri,
      full: true,
      files: [{ uri: entryUri, text, digest }]
    };
  };
  const render = async (
    update: TypstProjectUpdate,
    snapshotToken: PreviewRendererReady["snapshotToken"],
    baseGeneration: number | undefined,
    forceFull: boolean
  ): Promise<PreviewRendererReady> => {
    const result = await client.previewRenderer(update, { logicalSourceId }, {
      sessionId,
      snapshotToken,
      ...(baseGeneration === undefined ? {} : { baseGeneration }),
      forceFull
    });
    if (result.response.status !== "ready") {
      throw new Error(`Web preview renderer did not become ready: ${JSON.stringify(result.response)}`);
    }
    await validatePreviewRendererReady(result.response, {
      sessionId,
      snapshotToken,
      sourceDigest: result.synchronized.sourceDigest
    });
    return result.response;
  };
  try {
    const first = await render(await project(1, 20), "b".repeat(64) as PreviewRendererReady["snapshotToken"], undefined, true);
    if (first.frameKind !== "new" || first.generation !== 1 || first.baseGeneration !== 0) {
      throw new Error("Web preview renderer did not return a generation-one full frame");
    }
    const firstCommit = await client.transitionPreviewRenderer({
      action: "commit",
      sessionId,
      snapshotToken: first.snapshotToken,
      generation: first.generation
    });
    if (firstCommit.status !== "committed") throw new Error("Web preview renderer did not commit generation one");

    const secondProject = await project(2, 24);
    const secondToken = "c".repeat(64) as PreviewRendererReady["snapshotToken"];
    const second = await render(secondProject, secondToken, first.generation, false);
    if (second.frameKind !== "diff-v1" || second.generation !== 2 || second.baseGeneration !== 1) {
      throw new Error("Web preview renderer did not return a generation-two diff frame");
    }
    const discarded = await client.transitionPreviewRenderer({
      action: "discard",
      sessionId,
      snapshotToken: second.snapshotToken,
      generation: second.generation
    });
    if (discarded.status !== "discarded") throw new Error("Web preview renderer did not discard generation two");
    const resync = await client.previewRenderer(secondProject, { logicalSourceId }, {
      sessionId,
      snapshotToken: secondToken,
      baseGeneration: first.generation,
      forceFull: false
    });
    if (resync.response.status !== "resync" || resync.response.expectedBaseGeneration !== first.generation) {
      throw new Error("Web preview renderer did not require a full frame after discarding mutable producer state");
    }
    const replacement = await render(secondProject, secondToken, undefined, true);
    if (replacement.frameKind !== "new" || replacement.generation !== second.generation || replacement.baseGeneration !== 0) {
      throw new Error("Web preview renderer did not replace discarded producer state with a full frame");
    }
    const secondCommit = await client.transitionPreviewRenderer({
      action: "commit",
      sessionId,
      snapshotToken: replacement.snapshotToken,
      generation: replacement.generation
    });
    if (secondCommit.status !== "committed") throw new Error("Web preview renderer did not commit generation two");
    return true;
  } finally {
    const closed = await client.closePreviewRenderer(sessionId);
    if (closed.status !== "closed") throw new Error("Web preview renderer did not close its session");
  }
}

async function runTinymistWorkerClientTest(
  workerUri: string,
  moduleUri: string,
  wasmUri: string
): Promise<{ before: boolean; changed: boolean; after: boolean; restarted: number; semanticLegend: boolean; renderer: boolean }> {
  const client = await TinymistWorkerClient.start(workerUri, moduleUri, wasmUri);
  const initialLegend = client.semanticTokensLegend();
  if (!initialLegend || initialLegend.tokenTypes[0] !== "comment") {
    throw new Error("Tinymist Worker did not publish its dynamically registered semantic-token legend");
  }
  let restarted = 0;
  client.on("tinymist/clientRestarted", () => restarted++);
  const uriV1 = "untitled:/mmt-projection/replay-test/main-1.typ";
  const uriV2 = "untitled:/mmt-projection/replay-test/main-2.typ";
  const uriNextSession = "untitled:/mmt-projection/replay-test-next/main-1.typ";
  const update: TypstProjectUpdate = {
    sourceUri: "file:///workspace/replay-test.mmt",
    sourceVersion: 1,
    revision: 1,
    ...fixtureIdentity(1),
    entryUri: uriV1,
    full: true,
    files: [
      {
        uri: "untitled:/mmt-projection/replay-test/helper.typ",
        text: "#let replayed(name) = [Hello #name]"
      },
      {
        uri: uriV1,
        text: "#import \"helper.typ\": replayed\n#replayed(\"MMT\")\n#rep"
      }
    ]
  };
  try {
    client.syncProject(update);
    const before = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri: uriV1 },
      position: { line: 2, character: 4 }
    });
    client.syncProject({
      ...update,
      revision: 2,
      ...fixtureIdentity(2),
      entryUri: uriV2,
      full: false,
      files: [{ uri: uriV2, text: "#let repacked(name) = [Updated #name]\n#repacked(\"MMT\")\n#rep" }]
    });
    if (client.projectForEntry(uriV1)) throw new Error("retired worker projection remained addressable");
    client.syncProject({
      ...update,
      revision: 2,
      ...fixtureIdentity(2),
      entryUri: uriV2,
      full: false,
      files: [{ uri: uriV2, text: "#let stale = 1" }]
    });
    const changed = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri: uriV2 },
      position: { line: 2, character: 4 }
    });
    client.syncProject({
      ...update,
      revision: 1,
      ...fixtureIdentity(1),
      entryUri: uriNextSession,
      full: false,
      files: [{ uri: uriNextSession, text: "#let incomplete = 1" }]
    });
    if (client.projectForEntry(uriNextSession)) throw new Error("cross-session worker delta was accepted");
    client.syncProject({
      ...update,
      revision: 1,
      ...fixtureIdentity(1),
      entryUri: uriNextSession,
      full: true,
      files: [
        { uri: "untitled:/mmt-projection/replay-test-next/helper.typ", text: "#let replayed(name) = [Hello #name]" },
        { uri: uriNextSession, text: "#let repacked(name) = [Updated #name]\n#repacked(\"MMT\")\n#rep" }
      ]
    });
    const lateOldUri = "untitled:/mmt-projection/replay-test/main-3.typ";
    client.syncProject({
      ...update,
      revision: 3,
      ...fixtureIdentity(3),
      entryUri: lateOldUri,
      full: true,
      files: [{ uri: lateOldUri, text: "#let stale = 1" }]
    });
    if (!client.projectForEntry(uriNextSession)) throw new Error("new worker projection session was rejected");
    if (client.projectForEntry(lateOldUri)) {
      throw new Error("retired worker projection session was restored by a late update");
    }
    const renderer = await testWorkerPreviewRenderer(client);
    await client.restart();
    const restartedLegend = client.semanticTokensLegend();
    if (!restartedLegend || restartedLegend.tokenTypes[0] !== "comment") {
      throw new Error("Tinymist Worker restart did not restore its dynamic semantic-token legend");
    }
    const after = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri: uriNextSession },
      position: { line: 2, character: 4 }
    });
    return {
      before: hasLabel(before, "replayed"),
      changed: hasLabel(changed, "repacked"),
      after: hasLabel(after, "repacked"),
      semanticLegend: true,
      restarted,
      renderer,
    };
  } finally {
    await client.stop();
  }
}

(globalThis as unknown as {
  runTinymistWorkerClientTest: typeof runTinymistWorkerClientTest;
}).runTinymistWorkerClientTest = runTinymistWorkerClientTest;
