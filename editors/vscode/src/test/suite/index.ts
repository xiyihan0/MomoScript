import * as vscode from "vscode";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function completionLabel(item: vscode.CompletionItem): string {
  return typeof item.label === "string" ? item.label : item.label.label;
}

async function waitForCompletion(
  document: vscode.TextDocument,
  position: vscode.Position,
  label: string,
  detail?: string
): Promise<vscode.CompletionList> {
  return waitFor(async () => {
    const current = await vscode.commands.executeCommand<vscode.CompletionList>(
      "vscode.executeCompletionItemProvider",
      document.uri,
      position
    );
    return current?.items.some(
      (item) =>
        completionLabel(item) === label && (detail === undefined || item.detail?.includes(detail))
    )
      ? current
      : undefined;
  }, `missing completion '${label}' at ${position.line}:${position.character}`);
}

async function waitFor<T>(
  probe: () => T | undefined | PromiseLike<T | undefined>,
  message: string
): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

async function withTimeout<T>(
  operation: PromiseLike<T>,
  message: string,
  timeoutMs = 15_000
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function run(): Promise<void> {
  console.log("[mmt-web-test] locating extension");
  const extension = vscode.extensions.getExtension("momoscript.momoscript-vscode");
  assert(extension, "MomoScript extension was not installed in the Web Extension Host");
  await withTimeout(extension.activate(), "MomoScript extension activation timed out", 75_000);
  assert(extension.isActive, "MomoScript extension did not activate");
  console.log("[mmt-web-test] extension activated");

  const markerDocument = await vscode.workspace.openTextDocument({ language: "mmt", content: "" });
  const markerEditor = await vscode.window.showTextDocument(markerDocument);
  await vscode.commands.executeCommand("type", { text: "[" });
  await vscode.commands.executeCommand("type", { text: ":" });
  await waitFor(
    () => markerDocument.getText() === "[::]"
      && markerEditor.selection.active.isEqual(new vscode.Position(0, 2))
      ? true
      : undefined,
    "resource marker close and cursor did not settle between delimiters"
  );
  await vscode.commands.executeCommand("type", { text: "x" });
  await waitFor(
    () => markerDocument.getText() === "[:x:]" ? true : undefined,
    "resource marker text was inserted outside the delimiters"
  );
  assert(
    markerEditor.selection.active.isEqual(new vscode.Position(0, 3)),
    "resource marker cursor did not advance inside the delimiters"
  );
  console.log("[mmt-web-test] extension-host resource marker editing received");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  const multiMarkerDocument = await vscode.workspace.openTextDocument({ language: "mmt", content: "\n" });
  const multiMarkerEditor = await vscode.window.showTextDocument(multiMarkerDocument);
  multiMarkerEditor.selections = [
    new vscode.Selection(0, 0, 0, 0),
    new vscode.Selection(1, 0, 1, 0)
  ];
  await vscode.commands.executeCommand("type", { text: "[" });
  await vscode.commands.executeCommand("type", { text: ":" });
  await waitFor(
    () => multiMarkerDocument.getText() === "[::]\n[::]"
      && multiMarkerEditor.selections.every((selection) => selection.active.character === 2)
      ? true
      : undefined,
    "resource marker close and cursors did not settle for every extension-host cursor"
  );
  await vscode.commands.executeCommand("type", { text: "x" });
  await waitFor(
    () => multiMarkerDocument.getText() === "[:x:]\n[:x:]" ? true : undefined,
    "multi-cursor resource marker text was inserted outside the delimiters"
  );
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  const document = await vscode.workspace.openTextDocument({
    language: "mmt",
    content: "@reply\n- 选项 A\n- 选项 B\n@end\n@end"
  });
  await vscode.window.showTextDocument(document);

  const diagnostics = await waitFor(() => {
    const current = vscode.languages.getDiagnostics(document.uri);
    return current.some((diagnostic) => diagnostic.source === "mmt") ? current : undefined;
  }, "MMT diagnostics were not published by the browser Worker");
  assert(diagnostics.some((diagnostic) => diagnostic.source === "mmt"), "missing MMT diagnostic");
  console.log("[mmt-web-test] diagnostics received");

  const symbols = await waitFor(() => {
    const request = vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      document.uri
    );
    return request;
  }, "document symbol request was not scheduled");
  const resolvedSymbols = await symbols;
  assert(resolvedSymbols?.some((symbol) => symbol.name === "@reply"), "missing @reply symbol");
  console.log("[mmt-web-test] symbols received");

  const folding = await vscode.commands.executeCommand<vscode.FoldingRange[]>(
    "vscode.executeFoldingRangeProvider",
    document.uri
  );
  assert(folding?.length, "missing folding range from browser Worker");
  console.log("[mmt-web-test] folding received");

  const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    document.uri,
    new vscode.Position(0, 1)
  );
  assert(
    completions?.items.some((completion) => completion.label === "@reply"),
    "missing structural completion from browser Worker"
  );
  console.log("[mmt-web-test] completion received");

  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  const presetDocument = await vscode.workspace.openTextDocument({
    language: "mmt",
    content: "@actor\npreset: ba::一\n@end"
  });
  await vscode.window.showTextDocument(presetDocument);
  await waitForCompletion(presetDocument, new vscode.Position(1, 13), "ba::一花");
  console.log("[mmt-web-test] remote BA preset completion received");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  const typstDocument = await vscode.workspace.openTextDocument({
    language: "mmt",
    content: "@typ\n#let greet(name) = [Hello #name]\n#greet(\"MMT\")\n#gre\n#let broken = (\n@end"
  });
  await vscode.window.showTextDocument(typstDocument);
  const typstCompletion = await waitForCompletion(
    typstDocument,
    new vscode.Position(3, 4),
    "greet",
    "=>"
  );
  assert(
    typstCompletion.items.some(
      (item) => completionLabel(item) === "greet" && item.detail?.includes("=>")
    ),
    "missing mapped Typst completion"
  );
  console.log("[mmt-web-test] embedded Typst completion received");

  const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    typstDocument.uri,
    new vscode.Position(2, 3)
  );
  if (!hovers?.length) {
    throw new Error("missing mapped Typst hover");
  }
  console.log("[mmt-web-test] embedded Typst hover received");

  const signature = await vscode.commands.executeCommand<vscode.SignatureHelp>(
    "vscode.executeSignatureHelpProvider",
    typstDocument.uri,
    new vscode.Position(2, 7),
    "("
  );
  assert(
    signature?.signatures.some((item) => item.label.includes("greet")),
    "missing embedded Typst signature help"
  );
  console.log("[mmt-web-test] embedded Typst signature help received");

  const typstDiagnostic = await waitFor(() => {
    const current = vscode.languages.getDiagnostics(typstDocument.uri);
    return current.some((diagnostic) => diagnostic.source === "typst") ? current : undefined;
  }, "embedded Typst diagnostics were not mapped back to MMT");
  assert(
    typstDiagnostic.some((diagnostic) => diagnostic.source === "typst"),
    "missing mapped Typst diagnostic"
  );
  console.log("[mmt-web-test] embedded Typst diagnostics received");

  const activeEditor = vscode.window.activeTextEditor;
  assert(activeEditor, "Typst fixture editor is not active");
  const incompleteCall = "#gre";
  const incompleteStart = typstDocument.getText().lastIndexOf(incompleteCall);
  assert(incompleteStart >= 0, "incomplete Typst call is missing");
  await activeEditor.edit((builder) => {
    builder.replace(
      new vscode.Range(
        typstDocument.positionAt(incompleteStart),
        typstDocument.positionAt(incompleteStart + incompleteCall.length)
      ),
      "#greet(\"MMT\")"
    );
  });
  const brokenTypst = "#let broken = (";
  const brokenStart = typstDocument.getText().indexOf(brokenTypst);
  assert(brokenStart >= 0, "broken Typst fixture is missing");
  await activeEditor.edit((builder) => {
    builder.replace(
      new vscode.Range(
        typstDocument.positionAt(brokenStart),
        typstDocument.positionAt(brokenStart + brokenTypst.length)
      ),
      "#let broken = 3"
    );
  });
  await waitFor(() => {
    const current = vscode.languages.getDiagnostics(typstDocument.uri);
    return current.every((diagnostic) => diagnostic.source !== "typst") ? true : undefined;
  }, "fixed embedded Typst diagnostics were not cleared");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert(
    vscode.languages.getDiagnostics(typstDocument.uri).every((diagnostic) => diagnostic.source !== "typst"),
    "fixed embedded Typst diagnostics reappeared"
  );
  console.log("[mmt-web-test] fixed embedded Typst diagnostics cleared");
  await activeEditor.edit((builder) => {
    builder.replace(
      new vscode.Range(typstDocument.positionAt(0), typstDocument.positionAt(typstDocument.getText().length)),
      "@typ\n#let greet(name) = [Hello #name]\n#gre"
    );
  });
  await waitForCompletion(typstDocument, new vscode.Position(2, 4), "greet", "=>");
  console.log("[mmt-web-test] incomplete MMT projection recovered");

  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  const patchDocument = await vscode.workspace.openTextDocument({
    language: "mmt",
    content: "-(fill: gre) hello"
  });
  await vscode.window.showTextDocument(patchDocument);
  await waitForCompletion(patchDocument, new vscode.Position(0, 11), "green", "rgb");
  console.log("[mmt-web-test] statement patch completion received");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  const overlayText =
    "@asset: hero src:https://example.com/a.png\n- T\"\"\"[:asset, hero:](width: 1 +) #stro\"\"\"";
  const overlayDocument = await vscode.workspace.openTextDocument({
    language: "mmt",
    content: overlayText
  });
  await vscode.window.showTextDocument(overlayDocument);
  const overlayLine = overlayDocument.lineAt(1).text;
  const strongCursor = overlayLine.indexOf("#stro") + "#stro".length;
  const overlayCompletion = await waitForCompletion(
    overlayDocument,
    new vscode.Position(1, strongCursor),
    "strong",
    "=>"
  );
  const strong = overlayCompletion.items.find((item) => completionLabel(item) === "strong");
  assert(strong, "mapped overlay completion disappeared");
  if (strong.textEdit) {
    assert(
      strong.textEdit.range.start.character > overlayLine.indexOf(":]") + 2,
      "Typst completion edit crossed the overlay marker"
    );
  }
  const resourcePatchDiagnostic = await waitFor(() => {
    const current = vscode.languages.getDiagnostics(overlayDocument.uri);
    return current.find(
      (diagnostic) =>
        diagnostic.source === "typst" && diagnostic.range.start.line === 1
    );
  }, "resource patch Typst diagnostic was not mapped");
  assert(
    resourcePatchDiagnostic.range.start.character > overlayLine.indexOf(":]") + 2,
    "resource patch diagnostic crossed the overlay marker"
  );
  console.log("[mmt-web-test] overlay routing and resource patch diagnostic received");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");

  const facadeDocument = await vscode.workspace.openTextDocument({
    language: "mmt",
    content: "@typ: #mmt.chat-left"
  });
  await vscode.window.showTextDocument(facadeDocument);
  const facadeHover = await vscode.commands.executeCommand<vscode.Hover[]>(
    "vscode.executeHoverProvider",
    facadeDocument.uri,
    new vscode.Position(0, 16)
  );
  assert(facadeHover?.length, "missing template facade hover");
  console.log("[mmt-web-test] template facade hover received");
  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  console.log("[mmt-web-test] complete");
}
