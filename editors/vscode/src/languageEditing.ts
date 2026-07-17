import * as vscode from "vscode";

export function registerMmtLanguageEditing(): vscode.Disposable {
  let applyingEdit = false;
  return vscode.workspace.onDidChangeTextDocument((event) => {
    if (applyingEdit || event.document.languageId !== "mmt") return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) return;

    const ranges = event.contentChanges.flatMap((change) => {
      if (change.text !== ":") return [];
      const start = change.range.start;
      const line = event.document.lineAt(start.line).text;
      if (start.character < 1
        || line.slice(start.character - 1, start.character + 1) !== "[:") return [];
      const close = start.translate(0, 1);
      const end = line.at(close.character) === "]" ? close.translate(0, 1) : close;
      return [new vscode.Range(close, end)];
    });
    if (ranges.length === 0) return;

    applyingEdit = true;
    void Promise.resolve(editor.insertSnippet(new vscode.SnippetString("$0:]"), ranges)).finally(() => {
      applyingEdit = false;
    });
  });
}
