import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import textmate from "vscode-textmate";
import oniguruma from "vscode-oniguruma";

const { Registry, INITIAL, parseRawGrammar } = textmate;
const { loadWASM, OnigScanner, OnigString } = oniguruma;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const onigWasm = await readFile(join(root, "node_modules/vscode-oniguruma/release/onig.wasm"));
await loadWASM(onigWasm.buffer.slice(onigWasm.byteOffset, onigWasm.byteOffset + onigWasm.byteLength));

const grammarFiles = new Map([
  ["source.mmt", join(root, "syntaxes/mmt.tmLanguage.json")],
  ["source.typst", join(root, "vendor/tinymist-0.15.2/typst.tmLanguage.json")]
]);
const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns) => new OnigScanner(patterns),
    createOnigString: (value) => new OnigString(value)
  }),
  loadGrammar: async (scopeName) => {
    const path = grammarFiles.get(scopeName);
    return path ? parseRawGrammar(await readFile(path, "utf8"), path) : null;
  }
});
const grammar = await registry.loadGrammar("source.mmt");
assert(grammar, "MMT grammar failed to load");

function tokenize(lines) {
  let ruleStack = INITIAL;
  return lines.map((line) => {
    const result = grammar.tokenizeLine(line, ruleStack);
    ruleStack = result.ruleStack;
    return result.tokens.map((token) => ({
      text: line.slice(token.startIndex, token.endIndex),
      scopes: token.scopes
    }));
  });
}

const lines = (await readFile(join(root, "src/test/fixtures/typst-regions.mmt"), "utf8"))
  .trimEnd()
  .split("\n");
const tokenized = tokenize(lines);

function scopes(line, text) {
  const token = tokenized[line - 1].find((candidate) => candidate.text === text);
  assert(token, `line ${line} has no token ${JSON.stringify(text)}`);
  return token.scopes;
}
function hasScope(line, text, scope) {
  assert(scopes(line, text).includes(scope), `line ${line} token ${JSON.stringify(text)} lacks ${scope}`);
}
function scopesContaining(line, text) {
  const token = tokenized[line - 1].find((candidate) => candidate.text.includes(text));
  assert(token, `line ${line} has no token containing ${JSON.stringify(text)}`);
  return token.scopes;
}
function hasContainingScope(line, text, scope) {
  assert(
    tokenized[line - 1].some((candidate) => candidate.text.includes(text) && candidate.scopes.includes(scope)),
    `line ${line} has no token containing ${JSON.stringify(text)} with ${scope}`
  );
}
function lacksContainingScope(line, text, scope) {
  assert(!scopesContaining(line, text).includes(scope), `line ${line} token containing ${JSON.stringify(text)} leaked ${scope}`);
}


hasScope(5, "strong", "entity.name.function.typst");
hasScope(5, "#1", "meta.macro.sticker.mmt");
hasScope(6, "emph", "entity.name.function.typst");
assert(!tokenized[5].some((token) => token.scopes.includes("meta.macro.sticker.mmt")), "rT region applied MMT macro scopes");
hasScope(8, "strong", "entity.name.function.typst");
hasScope(9, "#1", "meta.macro.sticker.mmt");
hasScope(12, "emph", "entity.name.function.typst");
hasScope(15, "strong", "entity.name.function.typst");
hasScope(16, "\"\"\"\"", "punctuation.definition.string.end.typst");
assert(!tokenized[16].some((token) => token.scopes.includes("meta.embedded.block.typst")), "four-quote fence did not close");

hasContainingScope(18, "right", "meta.embedded.inline.typst");
lacksContainingScope(18, "statement patch body", "meta.embedded.inline.typst");
hasScope(18, "inset", "variable.other.readwrite.typst");
hasScope(18, ":", "punctuation.separator.colon.typst");
hasScope(18, "1pt", "constant.numeric.length.typst");
hasContainingScope(18, "rgb", "support.function.builtin.typst");
hasScope(18, "#fff", "string.quoted.double.typst");
hasScope(19, "100%", "constant.numeric.percentage.typst");
hasScope(19, "-", "keyword.operator.arithmetic.typst");
hasScope(19, "#1", "meta.macro.sticker.mmt");
hasContainingScope(19, "2", "meta.embedded.inline.typst");
lacksContainingScope(19, "resource patch body", "meta.embedded.inline.typst");
hasContainingScope(20, "不是:]结束", "meta.macro.sticker.mmt");
hasContainingScope(20, "2", "meta.embedded.inline.typst");
lacksContainingScope(20, "quoted resource patch body", "meta.embedded.inline.typst");
hasContainingScope(21, "still", "meta.macro.sticker.mmt");
hasContainingScope(21, "3", "meta.embedded.inline.typst");
lacksContainingScope(21, "escaped close patch body", "meta.embedded.inline.typst");
hasContainingScope(22, "4", "meta.embedded.inline.typst");
lacksContainingScope(22, "paired escape patch body", "meta.embedded.inline.typst");

hasContainingScope(24, "fill", "meta.embedded.inline.typst");
hasScope(24, "fill", "variable.other.readwrite.typst");
hasContainingScope(25, "box", "meta.embedded.inline.typst");
hasScope(26, "#1", "meta.macro.sticker.mmt");
hasContainingScope(27, "emph", "meta.embedded.block.typst");
assert(!tokenized[26].some((token) => token.scopes.includes("meta.macro.sticker.mmt")), "explicit rT override applied MMT macro scopes");
lacksContainingScope(28, "raw text", "meta.embedded.inline.typst");
assert(!tokenized[27].some((token) => token.scopes.includes("meta.macro.sticker.mmt")), "explicit rt override applied MMT macro scopes");
hasScope(29, "#1", "meta.macro.sticker.mmt");
hasScope(31, "strong", "entity.name.function.typst");
hasScope(31, "#1", "meta.macro.sticker.mmt");
hasScope(34, "grid", "entity.name.function.typst");
lacksContainingScope(37, "box", "meta.embedded.inline.typst");
hasContainingScope(39, "emph", "meta.embedded.inline.typst");
assert(!tokenized[38].some((token) => token.scopes.includes("meta.macro.sticker.mmt")), "raw Typst mode applied MMT macro scopes");
hasScope(41, "emph", "entity.name.function.typst");
assert(!tokenized[40].some((token) => token.scopes.includes("meta.macro.sticker.mmt")), "raw inherited fence applied MMT macro scopes");

hasScope(45, "fill", "variable.other.readwrite.typst");
hasScope(45, "rgb", "support.function.builtin.typst");
hasContainingScope(45, "3", "meta.expr.call.typst");
hasScope(45, "3", "constant.numeric.integer.typst");
hasScope(45, "image", "entity.name.function.typst");
hasScope(46, "fill", "variable.other.readwrite.typst");
hasScope(46, "image", "entity.name.function.typst");
hasContainingScope(47, "stack", "meta.embedded.block.typst");
hasScope(47, "stack", "entity.name.function.typst");
hasContainingScope(50, "5", "meta.expr.call.typst");
hasContainingScope(50, "strong", "meta.embedded.block.typst");
hasScope(50, "strong", "entity.name.function.typst");
hasScope(50, "#1", "meta.macro.sticker.mmt");
hasScope(52, "fill", "variable.other.readwrite.typst");
hasScope(52, "emph", "entity.name.function.typst");
hasContainingScope(52, "emph", "meta.embedded.block.typst");
assert(!tokenized[51].some((token) => token.scopes.includes("meta.macro.sticker.mmt")), "patched rT region applied MMT macro scopes");
hasScope(54, "fill", "variable.other.readwrite.typst");
hasScope(54, "#1", "meta.macro.sticker.mmt");
lacksContainingScope(54, "patched text macro", "meta.embedded.block.typst");
hasScope(56, "fill", "variable.other.readwrite.typst");
lacksContainingScope(56, "patched raw text", "meta.embedded.block.typst");
assert(!tokenized[55].some((token) => token.scopes.includes("meta.macro.sticker.mmt")), "patched rt region applied MMT macro scopes");
lacksContainingScope(58, "plain after patched fences", "meta.embedded.block.typst");
hasScope(59, "fill", "variable.other.readwrite.typst");
hasContainingScope(59, "美游", "entity.name.character.mmt");
hasScope(59, "daily_record", "entity.name.function.typst");
hasContainingScope(60, "观察对象", "meta.embedded.block.typst");
hasScope(61, "\"\"\"", "punctuation.definition.string.end.typst");
lacksContainingScope(62, "plain after patched speaker fence", "meta.embedded.block.typst");

const documentLines = (await readFile(join(root, "src/test/fixtures/document-config.mmt"), "utf8"))
  .trimEnd()
  .split("\n");
const documentTokens = tokenize(documentLines);
function hasDocumentScope(line, text, scope) {
  assert(
    documentTokens[line - 1].some((token) => token.text === text && token.scopes.includes(scope)),
    `document line ${line} token ${JSON.stringify(text)} lacks ${scope}`
  );
}
hasDocumentScope(1, "@document", "keyword.control.directive.mmt");
hasDocumentScope(2, "title", "variable.other.property.mmt");
hasDocumentScope(2, "Story", "string.quoted.double.mmt");
hasDocumentScope(4, "show-header", "variable.other.property.mmt");
hasDocumentScope(4, "true", "constant.language.boolean.mmt");
hasDocumentScope(5, "compiled-at", "variable.other.property.mmt");
hasDocumentScope(5, "auto", "constant.language.enum.mmt");
hasDocumentScope(6, "compiled-at-format", "variable.other.property.mmt");
hasDocumentScope(7, "timezone", "variable.other.property.mmt");
hasDocumentScope(7, "+08:00", "constant.language.enum.mmt");
hasDocumentScope(8, "@end", "keyword.control.directive.mmt");

console.log("MMT TextMate grammar: document fields/values and Typst t/T/rt/rT regions passed");
