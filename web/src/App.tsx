import { useCallback, useEffect, useRef, useState } from "react";
import OpenAI from "openai";
import { $typst, FetchAccessModel } from "@myriaddreamin/typst.ts";
import { loadFonts } from "@myriaddreamin/typst.ts/dist/esm/options.init.mjs";
import { TypstSnippet } from "@myriaddreamin/typst.ts/dist/esm/contrib/snippet.mjs";
import { FetchPackageRegistry } from "@myriaddreamin/typst.ts/dist/esm/fs/package.mjs";
import initMmtWasm, {
  compile_text_with_options_wasm,
  compile_text_with_pack_and_options_wasm,
} from "./wasm/mmt_rs/mmt_rs.js";

declare global {
  interface Window {
    mmtCompiler?: {
      compileToJson: (source: string) => Promise<string> | string;
    };
    mmtTypstRoot?: string;
    mmtPackRoot?: string;
    mmtPackBase?: string;
    mmtPackFetchUrl?: string;
  }
}

const compilerWasmUrl =
  "https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler/pkg/typst_ts_web_compiler_bg.wasm";
const rendererWasmUrl =
  "https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-renderer/pkg/typst_ts_renderer_bg.wasm";

let typstInitialized = false;
let wasmInitPromise: Promise<unknown> | null = null;
let accessModelInitialized = false;

const normalizeTypstRoot = (root: string) => {
  const trimmed = root.endsWith("/") ? root.slice(0, -1) : root;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  const prefix = trimmed.startsWith("/") ? "" : "/";
  return `${window.location.origin}${prefix}${trimmed}`;
};

const resolveTypstRoot = () => {
  if (window.mmtTypstRoot) {
    return normalizeTypstRoot(window.mmtTypstRoot);
  }

  if (import.meta.env.VITE_MMT_TYPST_ROOT) {
    return normalizeTypstRoot(import.meta.env.VITE_MMT_TYPST_ROOT);
  }

  return normalizeTypstRoot("/typst_sandbox");
};

const resolvePackFetchUrl = () => {
  if (window.mmtPackFetchUrl) {
    return window.mmtPackFetchUrl;
  }

  if (import.meta.env.VITE_MMT_PACK_FETCH_URL) {
    return import.meta.env.VITE_MMT_PACK_FETCH_URL;
  }

  return `${resolveTypstRoot()}/pack-v2/ba`;
};

const resolvePackBasePath = () => {
  if (window.mmtPackBase) {
    return window.mmtPackBase;
  }

  if (import.meta.env.VITE_MMT_PACK_BASE) {
    return import.meta.env.VITE_MMT_PACK_BASE;
  }

  return resolveTypstRoot();
};

const resolvePackRootPath = () => {
  if (window.mmtPackRoot) {
    return window.mmtPackRoot;
  }

  if (import.meta.env.VITE_MMT_PACK_ROOT) {
    return import.meta.env.VITE_MMT_PACK_ROOT;
  }

  const base = resolvePackBasePath();
  if (base.startsWith("http://") || base.startsWith("https://")) {
    return `${base.replace(/\/+$/, "")}/pack-v2/ba`;
  }
  return "/typst_sandbox/pack-v2/ba";
};

type PackData = {
  charIdJson: string;
  assetMappingJson: string;
};

let packDataCache: PackData | null = null;
let packDataPromise: Promise<PackData> | null = null;

const loadPackData = async () => {
  if (packDataCache) {
    return packDataCache;
  }

  if (!packDataPromise) {
    packDataPromise = (async () => {
      const baseUrl = resolvePackFetchUrl();
      const [charIdRes, mappingRes] = await Promise.all([
        fetch(`${baseUrl}/char_id.json`),
        fetch(`${baseUrl}/asset_mapping.json`),
      ]);

      if (!charIdRes.ok || !mappingRes.ok) {
        throw new Error("Failed to load pack-v2 metadata");
      }

      const [charIdJson, assetMappingJson] = await Promise.all([
        charIdRes.text(),
        mappingRes.text(),
      ]);

      packDataCache = { charIdJson, assetMappingJson };
      return packDataCache;
    })();
  }

  return await packDataPromise;
};

const apiKeyStorageKey = "SILICONFLOW_API_KEY";
const pageWidthStorageKey = "MMT_PAGE_WIDTH";
const apiBaseUrl = "https://api.siliconflow.cn/v1";
const embeddingModel = "Qwen/Qwen3-Embedding-8B";
const rerankModel = "Qwen/Qwen3-Reranker-8B";
const embeddingDimensions = 1024;

type PackAsset = {
  expressionsDir: string;
  tags: string;
};

type TagDoc = {
  imageName: string;
  tags: string[];
  description: string;
};

type ResolvedSegment = Record<string, unknown> & { type: string };

let packAssetCache: Map<string, PackAsset> | null = null;
let tagsCache: Map<string, TagDoc[]> = new Map();
let tagsPromise: Map<string, Promise<TagDoc[]>> = new Map();
let embeddingCache: Map<string, number[][]> = new Map();
let openAiClient: OpenAI | null = null;
let openAiKey: string | null = null;

const loadApiKey = () => localStorage.getItem(apiKeyStorageKey) ?? "";
const loadPageWidth = () => localStorage.getItem(pageWidthStorageKey) ?? "";

const storeApiKey = (value: string) => {
  if (value) {
    localStorage.setItem(apiKeyStorageKey, value);
  } else {
    localStorage.removeItem(apiKeyStorageKey);
  }
};

const storePageWidth = (value: string) => {
  if (value) {
    localStorage.setItem(pageWidthStorageKey, value);
  } else {
    localStorage.removeItem(pageWidthStorageKey);
  }
};

const getOpenAiClient = (apiKey: string) => {
  if (!apiKey) {
    throw new Error("Missing SiliconFlow API key");
  }
  if (!openAiClient || openAiKey !== apiKey) {
    openAiClient = new OpenAI({
      apiKey,
      baseURL: apiBaseUrl,
      dangerouslyAllowBrowser: true,
    });
    openAiKey = apiKey;
  }
  return openAiClient;
};

const normalizePath = (value: string) => value.replace(/\/+$/, "");

const resolvePackRefPrefix = () => {
  const base = normalizePath(resolvePackBasePath());
  const root = normalizePath(resolvePackRootPath());
  if (root.startsWith(base)) {
    const rel = root.slice(base.length).replace(/^\/+/, "");
    return rel ? `/${rel}` : "/";
  }
  return root;
};

const parseAssetMapping = (text: string) => {
  const map = new Map<string, PackAsset>();
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return map;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const obj = value as Record<string, unknown>;
    const expressionsDir = String(obj.expressions_dir ?? "").trim();
    const tags = String(obj.tags ?? "tags.json").trim() || "tags.json";
    if (!key.trim() || !expressionsDir) {
      continue;
    }
    map.set(key.trim(), { expressionsDir, tags });
  }
  return map;
};

const getPackAssets = async () => {
  if (packAssetCache) {
    return packAssetCache;
  }
  const pack = await loadPackData();
  packAssetCache = parseAssetMapping(pack.assetMappingJson);
  return packAssetCache;
};

const imageOrderKey = (name: string) => {
  const trimmed = (name || "").trim();
  const stem = trimmed.split(".")[0];
  const nums = stem.match(/\d+/g) ?? [];
  const n = nums.length ? Number(nums[nums.length - 1]) : -1;
  return { n, name: trimmed.toLowerCase() };
};

const sortTagDocs = (docs: TagDoc[]) => {
  return [...docs].sort((a, b) => {
    const ka = imageOrderKey(a.imageName);
    const kb = imageOrderKey(b.imageName);
    if (ka.n !== kb.n) {
      return ka.n - kb.n;
    }
    return ka.name.localeCompare(kb.name);
  });
};

const loadTagsForChar = async (charId: string) => {
  if (tagsCache.has(charId)) {
    return tagsCache.get(charId) ?? [];
  }
  if (tagsPromise.has(charId)) {
    return await tagsPromise.get(charId)!;
  }
  const promise = (async () => {
    const assets = await getPackAssets();
    const asset = assets.get(charId);
    if (!asset) {
      return [] as TagDoc[];
    }
    const baseUrl = resolvePackFetchUrl();
    const url = `${baseUrl}/${asset.expressionsDir}/${asset.tags}`;
    const res = await fetch(url);
    if (!res.ok) {
      return [] as TagDoc[];
    }
    let raw: unknown = [];
    try {
      raw = await res.json();
    } catch {
      return [] as TagDoc[];
    }
    if (!Array.isArray(raw)) {
      return [] as TagDoc[];
    }
    const docs: TagDoc[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const obj = item as Record<string, unknown>;
      const imageName = String(obj.image_name ?? "").trim();
      if (!imageName) {
        continue;
      }
      const tags = Array.isArray(obj.tags)
        ? obj.tags.filter((t) => typeof t === "string").map((t) => String(t))
        : [];
      const description = String(obj.description ?? "");
      docs.push({ imageName, tags, description });
    }
    const sorted = sortTagDocs(docs);
    tagsCache.set(charId, sorted);
    return sorted;
  })();
  tagsPromise.set(charId, promise);
  const result = await promise;
  tagsPromise.delete(charId);
  return result;
};

const buildDocText = (doc: TagDoc) => {
  const tags = doc.tags.slice(0, 32).join(", ");
  if (tags) {
    return `${doc.description}\nTags: ${tags}\nFile: ${doc.imageName}`;
  }
  return `${doc.description}\nFile: ${doc.imageName}`;
};

const embedTexts = async (apiKey: string, texts: string[]) => {
  const client = getOpenAiClient(apiKey);
  const batchSize = 64;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const res = await client.embeddings.create({
      model: embeddingModel,
      input: batch,
      dimensions: embeddingDimensions,
      encoding_format: "float",
    });
    for (const item of res.data) {
      out.push(item.embedding as number[]);
    }
  }
  return out;
};

const cosineSimilarity = (a: number[], b: number[]) => {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
};

const getDocEmbeddings = async (
  apiKey: string,
  charId: string,
  docs: TagDoc[],
) => {
  if (embeddingCache.has(charId)) {
    return embeddingCache.get(charId) ?? [];
  }
  const texts = docs.map(buildDocText);
  const embeddings = await embedTexts(apiKey, texts);
  embeddingCache.set(charId, embeddings);
  return embeddings;
};

const rerankDocuments = async (
  apiKey: string,
  query: string,
  documents: string[],
  topN = 5,
) => {
  const res = await fetch(`${apiBaseUrl}/rerank`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: rerankModel,
      query,
      documents,
      top_n: topN,
      return_documents: false,
    }),
  });
  if (!res.ok) {
    throw new Error("Rerank request failed");
  }
  const data = (await res.json()) as {
    results?: Array<{ index: number; relevance_score: number }>;
  };
  return data.results ?? [];
};

const isUrlLike = (value: string) => /^https?:\/\//i.test(value);

const fetchAsDataUrl = async (url: string) => {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error("Failed to fetch image");
  }
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.readAsDataURL(blob);
  });
};

const withError = (seg: Record<string, unknown>, error: string) => {
  return {
    ...seg,
    type: String(seg.type ?? "expr"),
    error,
  } as ResolvedSegment;
};

const resolveExprSegment = async (
  apiKey: string,
  seg: Record<string, unknown>,
  lineCharId: string | undefined,
): Promise<ResolvedSegment> => {
  const rawQuery = String(seg.query ?? "").trim();
  if (!rawQuery) {
    return seg as ResolvedSegment;
  }

  const query = rawQuery.startsWith(":") ? rawQuery.slice(1).trim() : rawQuery;

  if (query.startsWith("data:image/")) {
    return { type: "image", ref: query, alt: query };
  }

  if (isUrlLike(query)) {
    const dataUrl = await fetchAsDataUrl(query);
    return { type: "image", ref: dataUrl, alt: query };
  }

  const targetCharId = String(seg.target_char_id ?? lineCharId ?? "").trim();
  if (!targetCharId.startsWith("ba.")) {
    return withError(seg, "unsupported char id");
  }
  const cid = targetCharId.split(".", 2)[1];
  if (!cid) {
    return withError(seg, "missing char id");
  }

  const docs = await loadTagsForChar(cid);
  if (!docs.length) {
    return withError(seg, "missing tags");
  }

  const refPrefix = resolvePackRefPrefix();
  const assets = await getPackAssets();
  const asset = assets.get(cid);
  if (!asset) {
    return withError(seg, "missing asset mapping");
  }

  const directIdxMatch = query.match(
    /^#\s*(?:(?<alias>[A-Za-z0-9_]+)\s*[:.]\s*)?(?<n>\d+)\s*$/,
  );
  const directIndex = directIdxMatch ? Number(directIdxMatch.groups?.n) : null;
  if (directIndex && directIndex > 0) {
    const idx = directIndex - 1;
    if (idx >= docs.length) {
      return withError(seg, "index out of range");
    }
    const picked = docs[idx];
    return {
      type: "image",
      ref: `${refPrefix}/${asset.expressionsDir}/${picked.imageName}`,
      alt: query,
      score: 1,
    };
  }

  if (!apiKey) {
    return withError(seg, "missing api key");
  }

  let candidateDocs = docs;
  let candidateTexts = docs.map(buildDocText);
  try {
    const queryEmbedding = (await embedTexts(apiKey, [query]))[0];
    const docEmbeddings = await getDocEmbeddings(apiKey, cid, docs);
    const scored = docEmbeddings.map((emb, index) => ({
      index,
      score: cosineSimilarity(queryEmbedding, emb),
    }));
    scored.sort((a, b) => b.score - a.score);
    const topK = scored.slice(0, 50);
    candidateDocs = topK.map((item) => docs[item.index]);
    candidateTexts = topK.map((item) => buildDocText(docs[item.index]));
  } catch (error) {
    console.warn("Embedding failed, fallback to rerank all.", error);
  }

  const results = await rerankDocuments(apiKey, query, candidateTexts, 5);
  if (!results.length) {
    return withError(seg, "rerank failed");
  }
  const best = results[0];
  const picked = candidateDocs[best.index];
  if (!picked) {
    return withError(seg, "rerank index out of range");
  }
  return {
    type: "image",
    ref: `${refPrefix}/${asset.expressionsDir}/${picked.imageName}`,
    alt: query,
    score: best.relevance_score,
  };
};

const resolveSegmentsList = async (
  apiKey: string,
  segments: Record<string, unknown>[],
  lineCharId?: string,
) => {
  const out: ResolvedSegment[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== "object") {
      continue;
    }
    const segType = String(seg.type ?? "");
    if (segType !== "expr") {
      out.push(seg as ResolvedSegment);
      continue;
    }
    try {
      const resolved = await resolveExprSegment(apiKey, seg, lineCharId);
      out.push(resolved);
    } catch (error) {
      out.push(withError(seg, String(error)));
    }
  }
  return out;
};

const resolveExpressions = async (
  apiKey: string,
  data: Record<string, unknown>,
) => {
  const chat = Array.isArray(data.chat) ? data.chat : [];
  for (const line of chat) {
    if (!line || typeof line !== "object") {
      continue;
    }
    const lineObj = line as Record<string, unknown>;
    const segments = lineObj.segments;
    const lineCharId =
      typeof lineObj.char_id === "string" ? lineObj.char_id : undefined;
    if (Array.isArray(segments)) {
      lineObj.segments = await resolveSegmentsList(
        apiKey,
        segments as Record<string, unknown>[],
        lineCharId,
      );
    }
    const items = lineObj.items;
    if (Array.isArray(items)) {
      for (const item of items) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const itemObj = item as Record<string, unknown>;
        if (Array.isArray(itemObj.segments)) {
          itemObj.segments = await resolveSegmentsList(
            apiKey,
            itemObj.segments as Record<string, unknown>[],
            lineCharId,
          );
        }
      }
    }
  }
  return data;
};

const ensureTypstReady = () => {
  if (typstInitialized) {
    return;
  }

  $typst.setCompilerInitOptions({
    beforeBuild: [
      loadFonts(
        [
          "https://eo.xiyihan.cn/MainFont.otf",
          "https://eo.xiyihan.cn/MainFont_Bold.otf",
        ],
        {
          assets: ["text", "cjk", "emoji"],
        },
      ),
    ],
    getModule: () => compilerWasmUrl,
  });
  $typst.setRendererInitOptions({
    getModule: () => rendererWasmUrl,
  });

  typstInitialized = true;
};

const ensureAccessModelReady = () => {
  if (accessModelInitialized) {
    return;
  }

  const root = resolveTypstRoot();
  const accessModel = new FetchAccessModel(root);
  $typst.use(TypstSnippet.withAccessModel(accessModel));
  $typst.use(
    TypstSnippet.withPackageRegistry(new FetchPackageRegistry(accessModel)),
  );
  accessModelInitialized = true;
};

const ensureWasmReady = async () => {
  if (!wasmInitPromise) {
    wasmInitPromise = initMmtWasm();
  }

  await wasmInitPromise;
};

const compileMmtToJson = async (source: string, typstMode: boolean) => {
  const compiler = window.mmtCompiler;

  if (compiler) {
    return await compiler.compileToJson(source);
  }

  await ensureWasmReady();

  const joinWithNewline = true;

  try {
    const packData = await loadPackData();
    return compile_text_with_pack_and_options_wasm(
      source,
      typstMode,
      joinWithNewline,
      resolvePackRootPath(),
      resolvePackBasePath(),
      packData.charIdJson,
      packData.assetMappingJson,
    );
  } catch (error) {
    console.warn("Pack-v2 metadata load failed, using fallback.", error);
    return compile_text_with_options_wasm(source, typstMode, joinWithNewline);
  }
};

function App() {
  const [code, setCode] = useState<string>(
    "// Type your MomoScript code here...",
  );
  const [renderedSvg, setRenderedSvg] = useState<string>("");
  const [debugJson, setDebugJson] = useState<string>("");
  const [apiKey, setApiKey] = useState<string>(loadApiKey());
  const [pageWidth, setPageWidth] = useState<string>(loadPageWidth());
  const [resolveEnabled, setResolveEnabled] = useState<boolean>(true);
  const [typstMode, setTypstMode] = useState<boolean>(true);
  const [activeSidebarTab, setActiveSidebarTab] = useState<
    "settings" | "debug" | null
  >(null);
  const [zoom, setZoom] = useState<number>(1.0);
  const [jsonCopied, setJsonCopied] = useState<boolean>(false);
  const [sourceWidth, setSourceWidth] = useState<number>(420);
  const [sidebarWidth, setSidebarWidth] = useState<number>(320);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const previewContentRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{
    type: "source" | "sidebar";
    startX: number;
    startSourceWidth: number;
    startSidebarWidth: number;
  } | null>(null);
  const initialWidthSetRef = useRef<boolean>(false);
  const minSourceWidth = 280;
  const minSidebarWidth = 260;
  const minPreviewWidth = 320;
  const previewPadding = 32;

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 0.1, 5.0));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 0.1, 0.1));

  const getMainWidth = () => containerRef.current?.clientWidth ?? 0;

  useEffect(() => {
    if (initialWidthSetRef.current) {
      return;
    }
    const mainWidth = getMainWidth();
    if (!mainWidth) {
      return;
    }
    const sidebarSpace = activeSidebarTab ? sidebarWidth : 0;
    const maxSourceWidth = Math.max(
      minSourceWidth,
      mainWidth - sidebarSpace - minPreviewWidth,
    );
    const targetWidth = Math.min(
      Math.max(minSourceWidth, Math.round(mainWidth * 0.5)),
      maxSourceWidth,
    );
    if (targetWidth > 0) {
      setSourceWidth(targetWidth);
      initialWidthSetRef.current = true;
    }
  }, [
    activeSidebarTab,
    sidebarWidth,
    minPreviewWidth,
    minSourceWidth,
    sourceWidth,
  ]);

  useEffect(() => {
    const mainWidth = getMainWidth();
    if (!mainWidth) {
      return;
    }
    const sidebarSpace = activeSidebarTab ? sidebarWidth : 0;
    const maxSourceWidth = Math.max(
      minSourceWidth,
      mainWidth - sidebarSpace - minPreviewWidth,
    );
    if (sourceWidth > maxSourceWidth) {
      setSourceWidth(maxSourceWidth);
    }
    if (activeSidebarTab) {
      const maxSidebarWidth = Math.max(
        minSidebarWidth,
        mainWidth - sourceWidth - minPreviewWidth,
      );
      if (sidebarWidth > maxSidebarWidth) {
        setSidebarWidth(maxSidebarWidth);
      }
    }
  }, [
    activeSidebarTab,
    sidebarWidth,
    sourceWidth,
    minPreviewWidth,
    minSidebarWidth,
    minSourceWidth,
  ]);

  const handleFitWidth = () => {
    const container = previewContainerRef.current;
    const content = previewContentRef.current;
    if (!container || !content) {
      return;
    }
    const containerWidth = Math.max(container.clientWidth - previewPadding, 1);
    const rect = content.getBoundingClientRect();
    const unscaledWidth = rect.width / zoom;
    if (unscaledWidth <= 0) {
      return;
    }
    const nextZoom = containerWidth / unscaledWidth;
    const clampedZoom = Math.min(Math.max(0.1, nextZoom), 5.0);
    setZoom(Math.round(clampedZoom * 100) / 100);
  };

  const startResize = (type: "source" | "sidebar", event: React.MouseEvent) => {
    event.preventDefault();
    const mainWidth = getMainWidth();
    if (!mainWidth) {
      return;
    }
    resizeStateRef.current = {
      type,
      startX: event.clientX,
      startSourceWidth: sourceWidth,
      startSidebarWidth: sidebarWidth,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const state = resizeStateRef.current;
      if (!state) {
        return;
      }
      const width = getMainWidth();
      if (!width) {
        return;
      }
      const delta = moveEvent.clientX - state.startX;
      if (state.type === "source") {
        const sidebarSpace = activeSidebarTab ? state.startSidebarWidth : 0;
        const maxSourceWidth = Math.max(
          minSourceWidth,
          width - sidebarSpace - minPreviewWidth,
        );
        const nextWidth = Math.min(
          Math.max(minSourceWidth, state.startSourceWidth + delta),
          maxSourceWidth,
        );
        setSourceWidth(nextWidth);
        return;
      }
      const maxSidebarWidth = Math.max(
        minSidebarWidth,
        width - state.startSourceWidth - minPreviewWidth,
      );
      const nextSidebarWidth = Math.min(
        Math.max(minSidebarWidth, state.startSidebarWidth - delta),
        maxSidebarWidth,
      );
      setSidebarWidth(nextSidebarWidth);
    };

    const handleMouseUp = () => {
      resizeStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -0.1 : 0.1;
        setZoom((prev) => {
          const next = prev + delta;
          return Math.min(Math.max(0.1, next), 5.0);
        });
      }
    },
    [setZoom],
  );

  const handleCopyJson = async () => {
    try {
      let textToCopy = debugJson;
      try {
        textToCopy = JSON.stringify(JSON.parse(debugJson), null, 2);
      } catch {
        textToCopy = debugJson;
      }
      await navigator.clipboard.writeText(textToCopy);
      setJsonCopied(true);
      setTimeout(() => setJsonCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy JSON", err);
    }
  };

  const buildResolvedJson = async (source: string, typstMode: boolean) => {
    const chatJson = await compileMmtToJson(source, typstMode);
    const data = JSON.parse(chatJson) as Record<string, unknown>;
    const resolved = resolveEnabled
      ? await resolveExpressions(apiKey, data)
      : data;
    return resolved;
  };

  const extractImagePaths = (data: Record<string, unknown>) => {
    const paths = new Set<string>();

    // 1. Extract from custom_chars (avatars)
    if (Array.isArray(data.custom_chars)) {
      for (const item of data.custom_chars) {
        if (Array.isArray(item) && typeof item[1] === "string") {
          const ref = item[1];
          if (ref && !ref.startsWith("data:") && !ref.startsWith("http")) {
            paths.add(ref);
          }
        }
      }
    }

    // 2. Extract from chat segments (expressions / images)
    if (Array.isArray(data.chat)) {
      for (const line of data.chat) {
        if (!line || typeof line !== "object") continue;
        const lineObj = line as Record<string, unknown>;

        // Chat segments
        if (Array.isArray(lineObj.segments)) {
          for (const seg of lineObj.segments) {
            const segObj = seg as Record<string, unknown>;
            if (segObj.type === "image" && typeof segObj.ref === "string") {
              const ref = segObj.ref;
              if (ref && !ref.startsWith("data:") && !ref.startsWith("http")) {
                paths.add(ref);
              }
            }
          }
        }

        // Reply items
        if (Array.isArray(lineObj.items)) {
          for (const item of lineObj.items) {
            const itemObj = item as Record<string, unknown>;
            if (Array.isArray(itemObj.segments)) {
              for (const seg of itemObj.segments) {
                const segObj = seg as Record<string, unknown>;
                if (segObj.type === "image" && typeof segObj.ref === "string") {
                  const ref = segObj.ref;
                  if (
                    ref &&
                    !ref.startsWith("data:") &&
                    !ref.startsWith("http")
                  ) {
                    paths.add(ref);
                  }
                }
              }
            }
          }
        }
      }
    }

    return Array.from(paths);
  };

  const fetchAndMapImages = async (paths: string[]) => {
    let base = resolveTypstRoot();
    if (!base.endsWith("/")) {
      base += "/";
    }

    await Promise.all(
      paths.map(async (path) => {
        try {
          let fetchUrl: string;
          try {
            fetchUrl = new URL(path, base).href;
          } catch {
            fetchUrl = path;
          }

          const res = await fetch(fetchUrl);
          if (!res.ok) {
            throw new Error(`Failed to fetch ${fetchUrl}: ${res.status}`);
          }

          const contentType = res.headers.get("Content-Type");
          if (contentType && contentType.includes("text/html")) {
            throw new Error(`Expected image but got HTML for ${fetchUrl}`);
          }

          const buf = await res.arrayBuffer();
          await $typst.mapShadow(path, new Uint8Array(buf));
        } catch (e) {
          console.warn(`Failed to preload image: ${path}`, e);
        }
      }),
    );
  };

  const handleExportPdf = async () => {
    try {
      ensureTypstReady();
      ensureAccessModelReady();
      const resolvedData = await buildResolvedJson(code, typstMode);

      // Preload images
      const imagePaths = extractImagePaths(resolvedData);
      await fetchAndMapImages(imagePaths);

      const jsonString = JSON.stringify(resolvedData, null, 2);
      await $typst.mapShadow(
        "/@memory/chat.json",
        new TextEncoder().encode(jsonString),
      );
      const widthInput = pageWidth.trim();
      const pdfData = await $typst.pdf({
        mainFilePath: "/mmt_render/mmt_render.typ",
        inputs: {
          chat: "/@memory/chat.json",
          typst_mode: typstMode ? "1" : "0",
          width: widthInput,
        },
      });
      if (!pdfData) {
        throw new Error("PDF generation failed");
      }
      const blob = new Blob([new Uint8Array(pdfData)], {
        type: "application/pdf",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "momoscript.pdf";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
    }
  };

  const render = useCallback(
    async (source: string) => {
      try {
        ensureTypstReady();
        ensureAccessModelReady();
        const resolvedData = await buildResolvedJson(source, typstMode);
        const jsonString = JSON.stringify(resolvedData, null, 2);
        setDebugJson(jsonString);

        // Preload images
        const imagePaths = extractImagePaths(resolvedData);
        await fetchAndMapImages(imagePaths);

        await $typst.mapShadow(
          "/@memory/chat.json",
          new TextEncoder().encode(jsonString),
        );
        const widthInput = pageWidth.trim();
        const svg = await $typst.svg({
          mainFilePath: "/mmt_render/mmt_render.typ",
          inputs: {
            chat: "/@memory/chat.json",
            typst_mode: typstMode ? "1" : "0",
            width: widthInput,
          },
        });
        setRenderedSvg(svg);
      } catch (error) {
        console.error(error);
        setRenderedSvg("");
      }
    },
    [apiKey, resolveEnabled, typstMode, pageWidth],
  );

  useEffect(() => {
    storeApiKey(apiKey.trim());
  }, [apiKey]);

  useEffect(() => {
    storePageWidth(pageWidth.trim());
  }, [pageWidth]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      void render(code);
    }, 300);

    return () => window.clearTimeout(handle);
  }, [code, render]);

  return (
    <div className="flex flex-col h-screen w-screen bg-gray-50 text-gray-900 font-sans">
      <header className="flex-none h-14 bg-white border-b border-gray-200 px-4 flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-semibold text-gray-800 tracking-tight">
            MomoScript Editor
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 mr-2">v0.1.0</span>

          <button
            onClick={() =>
              setActiveSidebarTab(activeSidebarTab === "debug" ? null : "debug")
            }
            className={`p-2 rounded-md transition-colors ${
              activeSidebarTab === "debug"
                ? "bg-blue-50 text-blue-600"
                : "text-gray-500 hover:bg-gray-100"
            }`}
            title="Toggle Debug JSON"
            type="button"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="16 18 22 12 16 6" />
              <polyline points="8 6 2 12 8 18" />
            </svg>
          </button>

          <button
            className={`p-2 rounded-md transition-colors ${
              activeSidebarTab === "settings"
                ? "bg-blue-50 text-blue-600"
                : "text-gray-500 hover:bg-gray-100"
            }`}
            onClick={() =>
              setActiveSidebarTab(
                activeSidebarTab === "settings" ? null : "settings",
              )
            }
            title="Settings"
            type="button"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.1a2 2 0 0 1-1-1.72v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>

          <div className="h-4 w-px bg-gray-200 mx-1"></div>

          <button
            className="px-4 py-1.5 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
            onClick={() => void render(code)}
            type="button"
          >
            Render
          </button>
        </div>
      </header>

      <main ref={containerRef} className="flex-1 flex overflow-hidden">
        <div
          className="flex-none flex flex-col bg-white min-w-[240px]"
          style={{ width: sourceWidth }}
        >
          <div className="flex-none px-4 py-2 border-b border-gray-100 bg-gray-50 text-xs text-gray-500 uppercase font-medium tracking-wider flex justify-between items-center">
            <span>Source</span>
          </div>
          <div className="flex-1 relative">
            <textarea
              className="absolute inset-0 w-full h-full p-4 resize-none outline-none font-mono text-sm leading-relaxed text-gray-800 bg-white"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              spellCheck={false}
              placeholder="Enter your script..."
            />
          </div>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panels"
          className="w-2 flex-none cursor-col-resize -ml-1 z-10 flex justify-center group outline-none hover:bg-blue-50"
          onMouseDown={(event) => startResize("source", event)}
        >
          <div className="w-[1px] h-full bg-gray-200 transition-colors duration-200 ease-out group-hover:bg-blue-400 group-active:bg-blue-600" />
        </div>

        <div className="flex-1 flex flex-col bg-gray-100/50 min-w-[320px]">
          <div className="flex-none px-4 py-2 border-b border-gray-200 bg-gray-50 flex justify-between items-center">
            <span className="text-xs text-gray-500 uppercase font-medium tracking-wider">
              Preview
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={handleZoomOut}
                className="p-1 hover:bg-gray-200 rounded text-gray-600 transition-colors"
                title="Zoom Out"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <span className="text-xs font-mono text-gray-600 w-12 text-center select-none">
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={handleZoomIn}
                className="p-1 hover:bg-gray-200 rounded text-gray-600 transition-colors"
                title="Zoom In"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
              <button
                onClick={handleFitWidth}
                className="p-1 hover:bg-gray-200 rounded text-gray-600 transition-colors"
                title="Fit Width"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
              <div className="h-4 w-px bg-gray-300 mx-2"></div>
              <button
                onClick={handleExportPdf}
                className="flex items-center gap-1.5 px-2 py-1 bg-white border border-gray-300 rounded text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
                title="Export PDF"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span>Export PDF</span>
              </button>
            </div>
          </div>
          <div
            ref={previewContainerRef}
            className="flex-1 overflow-auto p-4 flex flex-col items-center gap-4"
            onWheel={handleWheel}
          >
            <div
              ref={previewContentRef}
              className={`bg-white shadow-lg ring-1 ring-gray-900/5 w-auto min-w-[300px] transition-transform duration-200 ease-out origin-top ${
                renderedSvg
                  ? ""
                  : "min-h-[500px] flex items-center justify-center"
              }`}
              style={{ transform: `scale(${zoom})` }}
            >
              {renderedSvg ? (
                <div
                  className="w-full"
                  dangerouslySetInnerHTML={{ __html: renderedSvg }}
                />
              ) : (
                <div className="text-center p-8">
                  <svg
                    className="mx-auto h-12 w-12 text-gray-300"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                  <h3 className="mt-2 text-sm font-medium text-gray-900">
                    No content
                  </h3>
                  <p className="mt-1 text-sm text-gray-500">
                    Render your script to see the result.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {activeSidebarTab && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              className="w-2 flex-none cursor-col-resize -ml-1 z-10 flex justify-center group outline-none hover:bg-blue-50"
              onMouseDown={(event) => startResize("sidebar", event)}
            >
              <div className="w-[1px] h-full bg-gray-200 transition-colors duration-200 ease-out group-hover:bg-blue-400 group-active:bg-blue-600" />
            </div>
            <div
              className="flex-none bg-white min-w-[260px] flex flex-col transition-all duration-300 ease-in-out"
              style={{ width: sidebarWidth }}
            >
              <div className="flex-none px-4 py-3 border-b border-gray-100 flex justify-between items-center">
                <h2 className="text-sm font-semibold text-gray-800">
                  {activeSidebarTab === "settings" ? "Settings" : "Debug JSON"}
                </h2>
                <div className="flex items-center gap-2">
                  {activeSidebarTab === "debug" && (
                    <>
                      <span className="text-xs text-gray-400 font-mono">
                        {(debugJson.length / 1024).toFixed(1)} KB
                      </span>
                      <div className="h-3 w-px bg-gray-200 mx-1"></div>
                      <button
                        onClick={handleCopyJson}
                        className="text-gray-400 hover:text-blue-600 p-1 hover:bg-blue-50 rounded transition-colors"
                        title="Copy to Clipboard"
                      >
                        {jsonCopied ? (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="text-green-500"
                          >
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        ) : (
                          <svg
                            xmlns="http://www.w3.org/2000/svg"
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          >
                            <rect
                              x="9"
                              y="9"
                              width="13"
                              height="13"
                              rx="2"
                              ry="2"
                            ></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                          </svg>
                        )}
                      </button>
                    </>
                  )}
                  <button
                    onClick={() => setActiveSidebarTab(null)}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M18 6 6 18" />
                      <path d="m6 6 12 12" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto p-4 space-y-6">
                {activeSidebarTab === "settings" ? (
                  <>
                    <div>
                      <label className="flex items-center justify-between cursor-pointer group mb-1">
                        <span className="text-sm font-medium text-gray-700">
                          Expression Resolve
                        </span>
                        <div className="relative">
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={resolveEnabled}
                            onChange={(e) =>
                              setResolveEnabled(e.target.checked)
                            }
                          />
                          <div
                            className={`block w-9 h-5 rounded-full transition-colors duration-200 ease-in-out ${
                              resolveEnabled ? "bg-blue-600" : "bg-gray-200"
                            }`}
                          ></div>
                          <div
                            className={`absolute left-1 top-1 bg-white w-3 h-3 rounded-full transition-transform duration-200 ease-in-out shadow-sm ${
                              resolveEnabled ? "translate-x-4" : "translate-x-0"
                            }`}
                          ></div>
                        </div>
                      </label>
                      <p className="text-xs text-gray-500">
                        Enable AI-based character and expression resolution.
                      </p>
                    </div>

                    <div>
                      <label className="flex items-center justify-between cursor-pointer group mb-1">
                        <span className="text-sm font-medium text-gray-700">
                          Typst Mode
                        </span>
                        <div className="relative">
                          <input
                            type="checkbox"
                            className="sr-only"
                            checked={typstMode}
                            onChange={(e) => setTypstMode(e.target.checked)}
                          />
                          <div
                            className={`block w-9 h-5 rounded-full transition-colors duration-200 ease-in-out ${
                              typstMode ? "bg-blue-600" : "bg-gray-200"
                            }`}
                          ></div>
                          <div
                            className={`absolute left-1 top-1 bg-white w-3 h-3 rounded-full transition-transform duration-200 ease-in-out shadow-sm ${
                              typstMode ? "translate-x-4" : "translate-x-0"
                            }`}
                          ></div>
                        </div>
                      </label>
                      <p className="text-xs text-gray-500">
                        Interpret inline segments in Typst mode.
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Page Width
                      </label>
                      <div className="relative">
                        <input
                          type="text"
                          className="w-full pl-3 pr-8 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-gray-700 placeholder-gray-400 bg-gray-50/50 hover:bg-white focus:bg-white"
                          placeholder="e.g. 300pt, 100mm"
                          value={pageWidth}
                          onChange={(e) => setPageWidth(e.target.value)}
                          spellCheck={false}
                        />
                        {pageWidth && (
                          <button
                            type="button"
                            onClick={() => setPageWidth("")}
                            className="absolute right-2 top-2.5 text-gray-400 hover:text-red-500 transition-colors"
                            title="Reset to Auto"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="14"
                              height="14"
                              viewBox="0 0 20 20"
                              fill="currentColor"
                            >
                              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                            </svg>
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        Override document width (e.g. 400pt). Leave empty for
                        auto.
                      </p>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        SiliconFlow API Key
                      </label>
                      <div className="relative">
                        <input
                          type="password"
                          className="w-full pl-3 pr-8 py-2 text-sm border border-gray-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all text-gray-700 placeholder-gray-400 bg-gray-50/50 hover:bg-white focus:bg-white"
                          placeholder="sk-..."
                          value={apiKey}
                          onChange={(e) => setApiKey(e.target.value)}
                          autoComplete="off"
                          spellCheck={false}
                        />
                        {apiKey && (
                          <button
                            type="button"
                            onClick={() => setApiKey("")}
                            className="absolute right-2 top-2.5 text-gray-400 hover:text-red-500 transition-colors"
                            title="Clear API Key"
                          >
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              width="14"
                              height="14"
                              viewBox="0 0 20 20"
                              fill="currentColor"
                            >
                              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                            </svg>
                          </button>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-1">
                        Required for image search and ranking.
                      </p>
                    </div>
                  </>
                ) : (
                  <pre className="text-xs font-mono text-gray-600 bg-white whitespace-pre-wrap break-all">
                    {(() => {
                      try {
                        return JSON.stringify(JSON.parse(debugJson), null, 2);
                      } catch {
                        return debugJson;
                      }
                    })()}
                  </pre>
                )}
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
