import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import { defineConfig, type Plugin } from "vite";

function e2eLifecyclePlugin(): Plugin | undefined {
  if (process.env.VITE_MMT_E2E !== "1") return undefined;
  return {
    name: "mmt-e2e-lifecycle",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (request.method !== "POST" || pathname !== "/__mmt_e2e/reload-main") {
          next();
          return;
        }
        try {
          const mainModule = await server.moduleGraph.getModuleByUrl("/src/main.ts");
          if (!mainModule) {
            response.statusCode = 404;
            response.end("main.ts is not loaded");
            return;
          }
          await server.reloadModule(mainModule);
          response.statusCode = 204;
          response.end();
        } catch (error) {
          response.statusCode = 500;
          response.end(error instanceof Error ? error.message : String(error));
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [e2eLifecyclePlugin()],
  build: {
    target: "esnext",
    assetsInlineLimit: 0,
    sourcemap: false
  },
  worker: {
    format: "es"
  },
  optimizeDeps: {
    esbuildOptions: {
      plugins: [importMetaUrlPlugin]
    },
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
