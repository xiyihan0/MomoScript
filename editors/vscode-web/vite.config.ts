import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import { defineConfig, type Plugin } from "vite";
import {
  PINNED_RUNTIME_WASM_URLS,
  TINYMIST_WASM_URL,
  TYPST_COMPILER_WASM_URL
} from "./src/runtimeArtifacts";

function publicAssets(root: string): Array<{ url: string; bytes: Buffer }> {
  const output: Array<{ url: string; bytes: Buffer }> = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        output.push({
          url: `/${path.relative(root, absolute).split(path.sep).join("/")}`,
          bytes: readFileSync(absolute),
        });
      }
    }
  };
  visit(root);
  return output;
}

function serviceWorkerSource(
  cacheId: string,
  urls: readonly string[],
  immutableUrls: readonly string[],
  immutablePrecacheUrls: readonly string[]
): string {
  return `const SHELL_CACHE = ${JSON.stringify(`momoscript-shell-${cacheId}`)};
const IMMUTABLE_CACHE = "momoscript-immutable-v1";
const OWNED_CACHE_PREFIXES = ["momoscript-shell-", "momoscript-immutable-"];
const PRECACHE_URLS = ${JSON.stringify(urls)};
const IMMUTABLE_URLS = ${JSON.stringify(immutableUrls)};
const IMMUTABLE_PRECACHE_URLS = ${JSON.stringify(immutablePrecacheUrls)};

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(PRECACHE_URLS);
    const immutable = await caches.open(IMMUTABLE_CACHE);
    await Promise.all(IMMUTABLE_PRECACHE_URLS.map(async (url) => {
      if (await immutable.match(url)) return;
      const response = await fetch(url, { cache: "reload" });
      if (!response.ok) throw new Error(\`Immutable precache failed: \${response.status} \${url}\`);
      await immutable.put(url, response);
    }));
  })());
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) =>
      OWNED_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))
        && name !== SHELL_CACHE
        && name !== IMMUTABLE_CACHE
        ? caches.delete(name)
        : Promise.resolve(false)
    ));
    await self.clients.claim();
  })());
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (request.mode === "navigate") {
        const shell = await caches.match("/index.html");
        if (shell) return shell;
      }
      return fetch(request);
    })());
    return;
  }
  if (IMMUTABLE_URLS.includes(url.href)) {
    event.respondWith((async () => {
      const cache = await caches.open(IMMUTABLE_CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    })());
  }
});
`;
}

function pwaPrecachePlugin(): Plugin {
  const root = path.resolve("public");
  const publicFiles = publicAssets(root);
  return {
    name: "momoscript-pwa-precache",
    apply: "build",
    generateBundle(_options, bundle) {
      const urls = new Set<string>(["/", "/index.html"]);
      const hash = createHash("sha256");
      const immutableUrls = [...PINNED_RUNTIME_WASM_URLS];
      const immutablePrecacheUrls = [TINYMIST_WASM_URL, TYPST_COMPILER_WASM_URL];
      hash.update(JSON.stringify({ immutableUrls, immutablePrecacheUrls }));
      for (const file of publicFiles) {
        urls.add(file.url);
        hash.update(file.url).update(file.bytes);
      }
      for (const output of Object.values(bundle).sort((left, right) => left.fileName.localeCompare(right.fileName))) {
        if (output.fileName === "sw.js" || output.fileName.endsWith(".map")) continue;
        urls.add(`/${output.fileName}`);
        hash.update(output.fileName);
        hash.update(output.type === "asset"
          ? typeof output.source === "string" ? output.source : Buffer.from(output.source)
          : output.code);
      }
      const cacheId = hash.digest("hex").slice(0, 20);
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: serviceWorkerSource(
          cacheId,
          [...urls].sort(),
          immutableUrls,
          immutablePrecacheUrls
        ),
      });
    },
  };
}

function e2eLifecyclePlugin(): Plugin | undefined {
  if (process.env.VITE_MMT_E2E !== "1") return undefined;
  return {
    name: "mmt-e2e-lifecycle",
    configureServer(server) {
      return () => {
        server.middlewares.use(async (request, response, next) => {
          const pathname = new URL(request.url ?? "/", "http://mmt-e2e.local").pathname;
          if (pathname !== "/__mmt_e2e/reload-main") return next();
          if (request.method !== "POST") {
            response.statusCode = 405;
            response.end("method not allowed");
            return;
          }
          const module = await server.moduleGraph.getModuleByUrl("/src/main.ts");
          if (!module) {
            response.statusCode = 404;
            response.end("main.ts is not loaded");
            return;
          }
          try {
            await server.reloadModule(module);
            response.statusCode = 204;
            response.end();
          } catch (error) {
            response.statusCode = 500;
            response.end(error instanceof Error ? error.message : String(error));
          }
        });
      };
    },
  };
}

export default defineConfig({
  plugins: [e2eLifecyclePlugin(), pwaPrecachePlugin()],
  define: {
    "import.meta.env.VITE_MMT_E2E": JSON.stringify(process.env.VITE_MMT_E2E === "1" ? "1" : "0")
  },
  build: {
    target: "esnext",
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  },
  worker: {
    format: "es"
  },
  optimizeDeps: {
    include: [
      "vscode-textmate",
      "vscode-oniguruma",
      "@codingame/monaco-vscode-media-preview-default-extension",
    ],
    esbuildOptions: {
      plugins: [importMetaUrlPlugin],
    },
  },
  resolve: {
    dedupe: [
      "vscode",
      "monaco-editor",
      "vscode-languageclient",
      "vscode-languageserver-protocol",
      "vscode-languageserver",
      "@codingame/monaco-vscode-api",
      "@codingame/monaco-vscode-extension-api",
    ],
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
  }
});
