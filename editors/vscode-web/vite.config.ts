import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "esnext",
    assetsInlineLimit: 0,
    sourcemap: true
  },
  worker: {
    format: "es"
  },
  optimizeDeps: {
    include: ["vscode-textmate", "vscode-oniguruma"]
  },
  resolve: {
    dedupe: [
      "vscode",
      "monaco-editor",
      "vscode-languageclient",
      "vscode-languageserver",
      "@codingame/monaco-vscode-api",
      "@codingame/monaco-vscode-editor-api",
      "@codingame/monaco-vscode-extension-api"
    ]
  }
});
