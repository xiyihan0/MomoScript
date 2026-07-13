import type { ExtensionConfig } from "monaco-languageclient/vscodeApiWrapper";
import languageConfiguration from "../../vscode/language-configuration.json?raw";
import manifest from "../../vscode/package.json";
import grammar from "../../vscode/syntaxes/mmt.tmLanguage.json?raw";

const theme = JSON.stringify({
  name: "MomoScript Dark",
  type: "dark",
  colors: {
    "editor.background": "#1e1e1e",
    "editor.foreground": "#d4d4d4"
  },
  tokenColors: [
    { scope: "comment", settings: { foreground: "#6a9955" } },
    { scope: "keyword.control.directive.mmt", settings: { foreground: "#c586c0", fontStyle: "bold" } },
    { scope: "keyword.operator.statement.mmt", settings: { foreground: "#569cd6", fontStyle: "bold" } },
    { scope: "punctuation.definition.macro", settings: { foreground: "#dcdcaa" } },
    { scope: "string", settings: { foreground: "#ce9178" } }
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
      ["/themes/momoscript-dark.json", theme]
    ])
  };
}

