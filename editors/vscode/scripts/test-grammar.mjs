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

const lines = (await readFile(join(root, "src/test/fixtures/typst-regions.mmt"), "utf8"))
  .trimEnd()
  .split("\n");
let ruleStack = INITIAL;
const tokenized = lines.map((line) => {
  const result = grammar.tokenizeLine(line, ruleStack);
  ruleStack = result.ruleStack;
  return result.tokens.map((token) => ({
    text: line.slice(token.startIndex, token.endIndex),
    scopes: token.scopes
  }));
});

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

console.log("Typst TextMate regions: T/rT bodies, nested statement/resource patches, quoted markers, escapes, and long fences passed");
