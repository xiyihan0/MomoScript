import { TinymistWorkerClient, type TypstProjectUpdate } from "../tinymistClient";

interface CompletionList {
  items: Array<{ label: string | { label: string } }>;
}

function hasLabel(result: CompletionList, expected: string): boolean {
  return result.items.some((item) =>
    typeof item.label === "string" ? item.label === expected : item.label.label === expected
  );
}

async function runTinymistWorkerClientTest(
  workerUri: string,
  moduleUri: string,
  wasmUri: string
): Promise<{ before: boolean; changed: boolean; after: boolean; restarted: number }> {
  const client = await TinymistWorkerClient.start(workerUri, moduleUri, wasmUri);
  let restarted = 0;
  client.on("tinymist/clientRestarted", () => restarted++);
  const uriV1 = "untitled:/mmt-projection/replay-test/main-1.typ";
  const uriV2 = "untitled:/mmt-projection/replay-test/main-2.typ";
  const uriNextSession = "untitled:/mmt-projection/replay-test-next/main-1.typ";
  const update: TypstProjectUpdate = {
    sourceUri: "file:///workspace/replay-test.mmt",
    sourceVersion: 1,
    revision: 1,
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
      entryUri: uriV2,
      full: false,
      files: [{ uri: uriV2, text: "#let repacked(name) = [Updated #name]\n#repacked(\"MMT\")\n#rep" }]
    });
    if (client.projectForEntry(uriV1)) throw new Error("retired worker projection remained addressable");
    client.syncProject({
      ...update,
      revision: 2,
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
      entryUri: uriNextSession,
      full: false,
      files: [{ uri: uriNextSession, text: "#let incomplete = 1" }]
    });
    if (client.projectForEntry(uriNextSession)) throw new Error("cross-session worker delta was accepted");
    client.syncProject({
      ...update,
      revision: 1,
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
      entryUri: lateOldUri,
      full: true,
      files: [{ uri: lateOldUri, text: "#let stale = 1" }]
    });
    if (!client.projectForEntry(uriNextSession)) throw new Error("new worker projection session was rejected");
    if (client.projectForEntry(lateOldUri)) {
      throw new Error("retired worker projection session was restored by a late update");
    }
    await client.restart();
    const after = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri: uriNextSession },
      position: { line: 2, character: 4 }
    });
    return {
      before: hasLabel(before, "replayed"),
      changed: hasLabel(changed, "repacked"),
      after: hasLabel(after, "repacked"),
      restarted
    };
  } finally {
    await client.stop();
  }
}

(globalThis as unknown as {
  runTinymistWorkerClientTest: typeof runTinymistWorkerClientTest;
}).runTinymistWorkerClientTest = runTinymistWorkerClientTest;
