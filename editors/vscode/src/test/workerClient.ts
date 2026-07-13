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
): Promise<{ before: boolean; after: boolean; restarted: number }> {
  const client = await TinymistWorkerClient.start(workerUri, moduleUri, wasmUri);
  let restarted = 0;
  client.on("tinymist/clientRestarted", () => restarted++);
  const uri = "untitled:/mmt-projection/replay-test/main.typ";
  const update: TypstProjectUpdate = {
    sourceUri: "file:///workspace/replay-test.mmt",
    sourceVersion: 1,
    revision: 1,
    entryUri: uri,
    full: true,
    files: [
      {
        uri: uri.replace("main.typ", "helper.typ"),
        text: "#let replayed(name) = [Hello #name]"
      },
      {
        uri,
        text: "#import \"helper.typ\": replayed\n#replayed(\"MMT\")\n#rep"
      }
    ]
  };
  try {
    client.syncProject(update);
    const before = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 4 }
    });
    client.syncProject({
      ...update,
      sourceVersion: 2,
      revision: 2,
      full: false,
      files: [{ uri, text: "#import \"helper.typ\": replayed\n#replayed(\"MMT\")\n#rep" }]
    });
    await client.restart();
    const after = await client.request<CompletionList>("textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 4 }
    });
    return {
      before: hasLabel(before, "replayed"),
      after: hasLabel(after, "replayed"),
      restarted
    };
  } finally {
    await client.stop();
  }
}

(globalThis as unknown as {
  runTinymistWorkerClientTest: typeof runTinymistWorkerClientTest;
}).runTinymistWorkerClientTest = runTinymistWorkerClientTest;
