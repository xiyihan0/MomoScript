import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import importMetaUrlPlugin from "@codingame/esbuild-import-meta-url-plugin";
import { defineConfig, type Plugin } from "vite";

const BUILD_VERSION_PATTERN = /^\d{12}-[0-9a-f]{7}$/;
const REPOSITORY_ROOT = fileURLToPath(new URL("../..", import.meta.url));

function resolveBuildVersion(): string {
  const override = process.env.MOMOSCRIPT_BUILD_VERSION?.trim();
  if (override) {
    if (!BUILD_VERSION_PATTERN.test(override)) {
      throw new Error("MOMOSCRIPT_BUILD_VERSION must match YYYYMMDDHHmm-abcdef0");
    }
    return override;
  }

  const [epochText, commit = ""] = execFileSync(
    "git",
    ["show", "-s", "--format=%ct%n%H", "HEAD"],
    { cwd: REPOSITORY_ROOT, encoding: "utf8" },
  ).trim().split(/\r?\n/, 2);
  const epochSeconds = Number(epochText);
  if (!Number.isSafeInteger(epochSeconds) || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error("Cannot derive the MomoScript build version from the current Git commit");
  }

  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(epochSeconds * 1_000)).map(({ type, value }) => [type, value]),
  );
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}-${commit.slice(0, 7)}`;
}

const buildVersion = resolveBuildVersion();

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
  version: string,
  urls: readonly string[],
): string {
  return `const SHELL_CACHE = ${JSON.stringify(`momoscript-shell-${cacheId}`)};
const BUILD_VERSION = ${JSON.stringify(version)};
const OWNED_CACHE_PREFIX = "momoscript-shell-";
const PRECACHE_URLS = ${JSON.stringify(urls)};

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.map((name) =>
      name.startsWith(OWNED_CACHE_PREFIX) && name !== SHELL_CACHE
        ? caches.delete(name)
        : Promise.resolve(false)
    ));
    await self.clients.claim();
  })());
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "GET_BUILD_VERSION") {
    event.ports[0]?.postMessage({ type: "BUILD_VERSION", version: BUILD_VERSION });
    return;
  }
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cached = await caches.match(request) ?? await caches.match(url.pathname);
    if (cached) return cached;
    if (request.mode === "navigate") {
      const shell = await caches.match("/index.html");
      if (shell) return shell;
    }
    return fetch(request);
  })());
});
`;
}

function typstCompilerBindingsPlugin(): Plugin {
  const compilerBinding = /@myriaddreamin\/typst-ts-web-compiler\/pkg\/typst_ts_web_compiler\.mjs$/;
  const pinnedBinding = path.resolve("../../third_party/typst-ts/pkg/typst_ts_web_compiler.mjs");
  return {
    name: "momoscript-pinned-typst-compiler-bindings",
    enforce: "pre",
    transform(_code, id) {
      if (!compilerBinding.test(id.split("?")[0]!)) return;
      return readFileSync(pinnedBinding, "utf8");
    },
  };
}

function monacoWebviewOfflineCachePlugin(): Plugin {
  const workerMarker = "const resourceCacheName = `vscode-resource-cache-${VERSION}`;";
  const fetchMarker = "\tconst requestUrl = new URL(event.request.url);\n";
  const offlineFallback = `${fetchMarker}\tif (requestUrl.origin === sw.origin) {
\t\treturn event.respondWith(fetch(event.request).catch(async (error) => {
\t\t\tconst cached = await caches.match(event.request) ?? await caches.match(requestUrl.pathname);
\t\t\tif (cached) return cached;
\t\t\tthrow error;
\t\t}));
\t}
`;
  return {
    name: "momoscript-monaco-webview-offline-cache",
    apply: "build",
    generateBundle(_options, bundle) {
      const workers = Object.values(bundle).filter((output) => {
        const source = output.type === "asset"
          ? typeof output.source === "string" ? output.source : Buffer.from(output.source).toString("utf8")
          : output.code;
        return typeof source === "string" && source.includes(workerMarker);
      });
      if (workers.length !== 1) {
        throw new Error(`Expected one Monaco Webview service worker, found ${workers.length}`);
      }
      const worker = workers[0]!;
      const source = worker.type === "asset"
        ? typeof worker.source === "string" ? worker.source : Buffer.from(worker.source).toString("utf8")
        : worker.code;
      if (source.split(fetchMarker).length !== 2) {
        throw new Error("Monaco Webview service worker fetch hook changed");
      }
      if (worker.type === "asset") worker.source = source.replace(fetchMarker, offlineFallback);
      else worker.code = source.replace(fetchMarker, offlineFallback);
    },
  };
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
      hash.update(buildVersion);
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
        source: serviceWorkerSource(cacheId, buildVersion, [...urls].sort()),
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

  plugins: [typstCompilerBindingsPlugin(), e2eLifecyclePlugin(), monacoWebviewOfflineCachePlugin(), pwaPrecachePlugin()],
  define: {
    "import.meta.env.VITE_MMT_BUILD_VERSION": JSON.stringify(buildVersion),
    "import.meta.env.VITE_MMT_E2E": JSON.stringify(process.env.VITE_MMT_E2E === "1" ? "1" : "0"),
    "import.meta.env.VITE_MMT_PWA_E2E": JSON.stringify(process.env.VITE_MMT_PWA_E2E === "1" ? "1" : "0"),
  },
  build: {
    target: "esnext",
    assetsInlineLimit: (filePath) => filePath.endsWith("mmt_lsp_bg.wasm"),
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: undefined
      }
    }
  },
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
  optimizeDeps: {
    exclude: [
      "@myriaddreamin/typst-ts-web-compiler",
      "tiny-brotli-dec-wasm",
    ],
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
    alias: {
      // editors/vscode/src 的裸导入在 CI 上无法向上解析到本包 node_modules；
      // 固定到本包自己声明的同一份依赖（js-toml 已是 dependencies）。
      "js-toml": createRequire(import.meta.url).resolve("js-toml"),
    },
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
