import type { ExtensionConfig } from "monaco-languageclient/vscodeApiWrapper";
import languageConfiguration from "../../vscode/language-configuration.json?raw";
import manifest from "../../vscode/package.json";
import grammar from "../../vscode/syntaxes/mmt.tmLanguage.json?raw";
import typstGrammar from "../../vscode/vendor/tinymist-0.15.2/typst.tmLanguage.json?raw";

const theme = JSON.stringify({
  name: "MomoScript Dark",
  type: "dark",
  colors: {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#d4d4d4",
    "statusBar.background": "#181818",
    "statusBar.foreground": "#cccccc",
    "statusBar.border": "#2b2b2b",
    "statusBarItem.hoverBackground": "#ffffff1f",
    "statusBarItem.activeBackground": "#ffffff2e"
  },
  tokenColors: [
    { scope: "comment", settings: { foreground: "#6a9955" } },
    { scope: "keyword.control.directive.mmt", settings: { foreground: "#c586c0", fontStyle: "bold" } },
    { scope: "keyword.operator.statement.mmt", settings: { foreground: "#569cd6", fontStyle: "bold" } },
    { scope: "punctuation.definition.macro", settings: { foreground: "#dcdcaa" } },
    { scope: "string", settings: { foreground: "#ce9178" } },
    { scope: ["keyword", "storage", "support.type"], settings: { foreground: "#c586c0" } },
    { scope: ["entity.name.function", "support.function"], settings: { foreground: "#dcdcaa" } },
    { scope: ["variable", "meta.interpolation"], settings: { foreground: "#9cdcfe" } },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: "#b5cea8" } },
    { scope: ["markup.heading", "markup.bold"], settings: { foreground: "#569cd6", fontStyle: "bold" } },
    { scope: ["punctuation", "meta.brace"], settings: { foreground: "#d4d4d4" } },
  ]
});
export function mmtExtension(): ExtensionConfig {
  const config = {
    name: manifest.name,
    publisher: manifest.publisher,
    version: manifest.version,
    engines: manifest.engines,
    contributes: {
      languages: manifest.contributes.languages,
      grammars: manifest.contributes.grammars,
      configuration: manifest.contributes.configuration,
      commands: [
        { command: "mmt.preview.open", title: "Typst 预览", icon: "$(open-preview)" }
      ],
      menus: {
        "editor/title": [
          { command: "mmt.preview.open", when: "editorLangId == mmt || editorLangId == typst", group: "navigation" }
        ]
      },
      themes: [
        {
          id: "MomoScript Dark",
          label: "MomoScript Dark",
          uiTheme: "vs-dark" as const,
          path: "./themes/momoscript-dark.json"
        }
      ]
    }
  };
  return {
    config,
    filesOrContents: new Map([
      ["/language-configuration.json", languageConfiguration],
      ["/syntaxes/mmt.tmLanguage.json", grammar],
      ["/vendor/tinymist-0.15.2/typst.tmLanguage.json", typstGrammar],
      ["/themes/momoscript-dark.json", theme]
    ])
  };
}

