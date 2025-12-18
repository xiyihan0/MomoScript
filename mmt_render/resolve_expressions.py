from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

try:
    from mmt_render.embedding_index import EmbeddingIndex
    from mmt_render.siliconflow_embed import SiliconFlowEmbedConfig, SiliconFlowEmbedder
except ModuleNotFoundError:  # pragma: no cover
    from embedding_index import EmbeddingIndex  # type: ignore
    from siliconflow_embed import SiliconFlowEmbedConfig, SiliconFlowEmbedder  # type: ignore

try:
    from mmt_render.siliconflow_rerank import SiliconFlowRerankConfig, SiliconFlowReranker
except ModuleNotFoundError:
    from siliconflow_rerank import SiliconFlowRerankConfig, SiliconFlowReranker

try:
    from mmt_render.external_assets import ExternalAssetConfig, ExternalAssetDownloader, is_url_like
except ModuleNotFoundError:  # pragma: no cover
    from external_assets import ExternalAssetConfig, ExternalAssetDownloader, is_url_like  # type: ignore

try:
    from mmt_render.pack_v2 import PackV2, load_pack_v2
except ModuleNotFoundError:  # pragma: no cover
    PackV2 = None  # type: ignore
    load_pack_v2 = None  # type: ignore


@dataclass(frozen=True)
class CandidateDoc:
    image_name: str
    tags: List[str]
    description: str

    def to_doc_text(self) -> str:
        return json.dumps(
            {"image_name": self.image_name, "tags": self.tags, "description": self.description},
            ensure_ascii=False,
            separators=(",", ":"),
        )


def _image_order_key(image_name: str) -> tuple[int, str]:
    """
    Prefer numeric suffix order (e.g. xxx.png, xxx1.png, xxx2.png, xxx10.png, ...).
    - No number => -1 (often the "base" image).
    """
    s = (image_name or "").strip()
    stem = s.rsplit(".", 1)[0]
    nums = re.findall(r"\d+", stem)
    n = int(nums[-1]) if nums else -1
    return (n, s.lower())


def _load_tags_for_student(tags_root: Path, student_id: int) -> List[CandidateDoc]:
    p = tags_root / str(student_id) / "tags.json"
    if not p.exists():
        return []
    raw = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        return []
    docs: List[CandidateDoc] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        img = str(item.get("image_name") or "")
        if not img:
            continue
        tags = item.get("tags") or []
        if not isinstance(tags, list):
            tags = []
        tags = [str(x) for x in tags if isinstance(x, str)]
        desc = str(item.get("description") or "")
        docs.append(CandidateDoc(image_name=img, tags=tags, description=desc))
    docs.sort(key=lambda d: _image_order_key(d.image_name))
    return docs


def _load_tags_for_pack_char(pack: "PackV2", char_id: str) -> List[CandidateDoc]:
    p = pack.tags_path(char_id)
    if not p.exists():
        return []
    raw = json.loads(p.read_text(encoding="utf-8"))
    if not isinstance(raw, list):
        return []
    docs: List[CandidateDoc] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        img = str(item.get("image_name") or "")
        if not img:
            continue
        tags = item.get("tags") or []
        if not isinstance(tags, list):
            tags = []
        tags = [str(x) for x in tags if isinstance(x, str)]
        desc = str(item.get("description") or "")
        docs.append(CandidateDoc(image_name=img, tags=tags, description=desc))
    docs.sort(key=lambda d: _image_order_key(d.image_name))
    return docs


def _doc_text(candidate: CandidateDoc) -> str:
    # Keep this short and reranker-friendly: description + tags.
    tags = ", ".join(candidate.tags[:32])
    if tags:
        return f"{candidate.description}\nTags: {tags}\nFile: {candidate.image_name}"
    return f"{candidate.description}\nFile: {candidate.image_name}"


def _assets_from_meta(meta: Dict[str, Any]) -> Dict[str, str]:
    assets: Dict[str, str] = {}
    for k, v in (meta or {}).items():
        if not isinstance(k, str):
            continue
        if not k.startswith("asset."):
            continue
        name = k.split(".", 1)[1].strip()
        if not name:
            continue
        if not isinstance(v, str):
            continue
        vv = v.strip()
        if not vv:
            continue
        assets[name] = vv
    return assets


def _asset_value(meta: Dict[str, Any], name: str) -> Optional[str]:
    if not name:
        return None
    v = (meta or {}).get(f"asset.{name}")
    return v.strip() if isinstance(v, str) and v.strip() else None


def _safe_cache_filename(name: str) -> Optional[str]:
    s = (name or "").strip()
    if not s:
        return None
    if "/" in s or "\\" in s or ".." in s:
        return None
    return s


def _rewrite_asset_ref(ref: str, meta: Dict[str, Any]) -> str:
    s = (ref or "").strip()
    if s.lower().startswith("asset:"):
        name = s.split(":", 1)[1].strip()
        v = _asset_value(meta, name)
        return v or ref
    return ref


def _apply_avatar_overrides(data: Dict[str, Any], meta: Dict[str, Any]) -> None:
    # Backward compatibility:
    # Older JSON schema used a global `avatar_overrides: {char_id: asset_name}` to rewrite
    # `custom_chars`' avatar refs (global/static). The current pipeline prefers per-line
    # `line.avatar_override` so avatar changes can be scoped inside a document.
    overrides = data.get("avatar_overrides")
    if not isinstance(overrides, dict) or not overrides:
        return
    cc = data.get("custom_chars")
    if not isinstance(cc, list) or not cc:
        return

    new_cc: list[list[Any]] = []
    for row in cc:
        if not (isinstance(row, list) and len(row) >= 3):
            continue
        char_id, avatar_ref, display = row[0], row[1], row[2]
        if isinstance(char_id, str):
            asset_name = overrides.get(char_id)
            if isinstance(asset_name, str) and asset_name.strip():
                v = _asset_value(meta, asset_name.strip())
                if v:
                    avatar_ref = v
        new_cc.append([char_id, avatar_ref, display])
    data["custom_chars"] = new_cc


def _rewrite_line_avatar_override(line: Dict[str, Any], meta: Dict[str, Any]) -> None:
    v = line.get("avatar_override")
    if not isinstance(v, str) or not v.strip():
        return
    vv = _rewrite_asset_ref(v, meta)
    if isinstance(vv, str) and vv.strip().lower().startswith("asset:"):
        # Missing asset mapping: drop override to avoid Typst trying to load an invalid path,
        # but keep a warning marker for the caller.
        name = vv.split(":", 1)[1].strip()
        line.pop("avatar_override", None)
        line["avatar_override_error"] = f"missing @asset.{name}"
        return
    line["avatar_override"] = vv


def _escape_typst_string(s: str) -> str:
    return s.replace("\\", "\\\\").replace('"', '\\"')


def _build_typst_assets_global(meta: Dict[str, Any]) -> str:
    assets = _assets_from_meta(meta)
    if not assets:
        return ""
    # Expose a simple Typst API:
    #   - `asset`: a dict mapping names -> image refs
    #   - `asset_img(name, ..)` returns an `image(...)` for the mapped ref
    lines = ["#let asset = (:)"]
    for name in sorted(assets.keys()):
        v = assets[name]
        lines.append(f'#asset.insert("{_escape_typst_string(name)}", "{_escape_typst_string(v)}")')
    lines.append(
        "#let asset_img(name, width: auto, height: auto, fit: \"contain\") = {"
        " let p = asset.at(name, default: none);"
        " if p == none { none } else { image(p, width: width, height: height, fit: fit) }"
        "}"
    )
    return "\n".join(lines) + "\n"


_LOCAL_ASSET_EXTS = {"png", "jpg", "jpeg", "webp", "gif", "bmp", "svg"}


def _normalize_local_asset_ref(raw: str, *, allowed_prefixes: List[str]) -> Optional[str]:
    """
    Normalize a local asset reference to a Typst project-root absolute path:
      - No schemes like file://
      - No Windows drive letters
      - No '..' segments
      - Must be under one of allowed_prefixes (first path segment)
      - Must have an image extension
    Returns: '/prefix/.../file.ext' or None if invalid.
    """
    s = (raw or "").strip().replace("\\", "/")
    if not s:
        return None
    if s.startswith("./"):
        s = s[2:]
    if s.startswith("/"):
        s = s[1:]
    s = s.lstrip("/")
    if not s:
        return None
    if re.match(r"^[A-Za-z]:", s):
        return None
    if "://" in s or s.startswith("//"):
        return None
    parts = [p for p in s.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    if allowed_prefixes:
        if parts[0] not in set(allowed_prefixes):
            return None
    last = parts[-1]
    m = re.search(r"\.([A-Za-z0-9]{2,5})$", last)
    if not m:
        return None
    ext = m.group(1).lower()
    if ext not in _LOCAL_ASSET_EXTS:
        return None
    return "/" + "/".join(parts)


def _student_key(student_id: int) -> str:
    return str(int(student_id))


@dataclass
class _IndexItem:
    candidates: List[CandidateDoc]
    docs: List[str]
    index: EmbeddingIndex


class _IndexCache:
    def __init__(self, max_items: int = 8):
        self.max_items = max(1, int(max_items))
        self._order: List[str] = []
        self._data: Dict[str, _IndexItem] = {}

    def get(self, key: str) -> Optional[_IndexItem]:
        it = self._data.get(key)
        if it is None:
            return None
        # refresh LRU
        try:
            self._order.remove(key)
        except ValueError:
            pass
        self._order.append(key)
        return it

    def put(self, key: str, item: _IndexItem) -> None:
        if key in self._data:
            self._data[key] = item
            try:
                self._order.remove(key)
            except ValueError:
                pass
            self._order.append(key)
            return
        self._data[key] = item
        self._order.append(key)
        while len(self._order) > self.max_items:
            evict = self._order.pop(0)
            self._data.pop(evict, None)


async def resolve_one(
    reranker: SiliconFlowReranker,
    *,
    query: str,
    candidates: List[CandidateDoc],
    images_dir: Path,
    cache_key: str,
    top_n: int = 1,
    embedder: Optional[SiliconFlowEmbedder] = None,
    embed_top_k: int = 50,
    index_cache: Optional[_IndexCache] = None,
) -> Tuple[str, float]:
    if not candidates:
        raise RuntimeError("missing tags for target")

    docs_all = [_doc_text(c) for c in candidates]
    chosen_candidates = candidates
    chosen_docs = docs_all
    chosen_map: Optional[List[int]] = None

    if embedder is not None and int(embed_top_k) > 0 and len(candidates) > int(embed_top_k):
        cache = index_cache or _IndexCache(max_items=8)
        cached = cache.get(cache_key)
        if cached is None:
            vecs = await embedder.embed_texts(docs_all, use_cache=True)
            idx = EmbeddingIndex.build(vecs)
            cached = _IndexItem(candidates=candidates, docs=docs_all, index=idx)
            cache.put(cache_key, cached)
        # Cache query embeddings too (small: ~16KB for 4096-dim float32), to reduce repeated requests.
        q_vec = (await embedder.embed_texts([query], use_cache=True))[0]
        top_idx = cached.index.top_k(q_vec, int(embed_top_k))
        if top_idx:
            chosen_map = top_idx
            chosen_candidates = [cached.candidates[i] for i in top_idx]
            chosen_docs = [cached.docs[i] for i in top_idx]

    results = await reranker.rerank(query=query, documents=chosen_docs, top_n=top_n, return_documents=False)
    best = results[0]
    idx = best.get("index")
    score = float(best.get("score") or 0.0)
    if not isinstance(idx, int) or not (0 <= idx < len(chosen_candidates)):
        raise RuntimeError(f"invalid reranker result index: {idx}")

    if chosen_map is not None:
        idx = chosen_map[idx]
    image_name = candidates[idx].image_name
    image_path = images_dir / image_name
    if not image_path.exists():
        raise RuntimeError(f"resolved image missing on disk: {image_path}")
    return image_name, score


async def resolve_file(
    *,
    input_path: Path,
    output_path: Path,
    tags_root: Path,
    pack_v2_root: Optional[Path] = None,
    ref_root: Optional[Path] = None,
    model: str,
    api_key_env: str,
    concurrency: int,
    strict: bool = False,
    use_embedding: bool = True,
    embed_model: str = "Qwen/Qwen3-Embedding-8B",
    embed_top_k: int = 50,
    asset_cache_dir: Optional[Path] = None,
    redownload_assets: bool = False,
    asset_max_mb: int = 10,
    allow_local_assets: bool = False,
    asset_local_prefixes: Optional[List[str]] = None,
) -> int:
    data = json.loads(input_path.read_text(encoding="utf-8"))
    chat = data.get("chat")
    if not isinstance(chat, list):
        raise SystemExit("input JSON missing 'chat' list")

    cfg = SiliconFlowRerankConfig(api_key_env=api_key_env, model=model)
    embed_cfg = SiliconFlowEmbedConfig(api_key_env=api_key_env, model=embed_model)
    sem = asyncio.Semaphore(max(1, concurrency))
    idx_cache = _IndexCache(max_items=8)

    pack_ba: Optional["PackV2"] = None
    if load_pack_v2 is not None:
        if pack_v2_root is None:
            env_root = os.getenv("MMT_PACK_V2_ROOT", "").strip()
            pack_v2_root = Path(env_root) if env_root else Path("pack-v2")
        pack_v2_root = Path(pack_v2_root).expanduser()
        ba_root = pack_v2_root / "ba"
        if ba_root.exists():
            try:
                pack_ba = load_pack_v2(ba_root)
            except Exception:
                pack_ba = None

    meta = data.get("meta") if isinstance(data, dict) else None
    meta = meta if isinstance(meta, dict) else {}

    ref_base = tags_root
    if ref_root is not None:
        # Typst resolves relative paths against the source file directory. Using relpath is more robust than Path.relative_to
        # because tags_root is often a sibling of the typst template directory (especially when mmt_render is a symlink).
        try:
            ref_base = Path(os.path.relpath(tags_root.resolve(), start=ref_root.resolve()))
        except Exception:
            ref_base = tags_root

    if asset_cache_dir is None:
        env_dir = os.getenv("MMT_ASSET_CACHE_DIR", "").strip()
        asset_cache_dir = Path(env_dir) if env_dir else Path(".cache/mmt_assets")
    asset_cache_dir = asset_cache_dir.expanduser()
    asset_ref_base = asset_cache_dir
    if ref_root is not None:
        try:
            asset_ref_base = Path(os.path.relpath(asset_cache_dir.resolve(), start=ref_root.resolve()))
        except Exception:
            asset_ref_base = asset_cache_dir

    max_bytes = max(1, int(asset_max_mb)) * 1024 * 1024
    local_prefixes = asset_local_prefixes or ["mmt_assets"]

    async with ExternalAssetDownloader(ExternalAssetConfig(cache_dir=asset_cache_dir, max_bytes=max_bytes)) as dl:
        # Resolve @asset.* in meta to local cached files so Typst can read them.
        assets = _assets_from_meta(meta)
        if assets:
            for name, url in list(assets.items()):
                raw = (url or "").strip()
                # Trusted local cache reference injected by the bot/plugin:
                #   asset.<name>: cache:<filename>
                # This never allows arbitrary paths; only a basename under asset_cache_dir is accepted.
                if raw.lower().startswith("cache:"):
                    fn = _safe_cache_filename(raw.split(":", 1)[1].strip())
                    if not fn:
                        if strict:
                            raise RuntimeError(f"invalid @asset.{name}: bad cache ref")
                        meta.pop(f"asset.{name}", None)
                        meta[f"asset_error.{name}"] = "invalid cache ref"
                        continue
                    p_local = asset_cache_dir / fn
                    if not p_local.exists():
                        if strict:
                            raise RuntimeError(f"missing cached asset file for @asset.{name}: {fn}")
                        meta.pop(f"asset.{name}", None)
                        meta[f"asset_error.{name}"] = f"missing cached file: {fn}"
                        continue
                    meta[f"asset.{name}"] = f"{asset_ref_base.as_posix()}/{fn}"
                    continue
                # Security: do not allow arbitrary local paths via @asset.* (Typst would be able to read them
                # as long as they are under --root). Only allow external URLs (downloaded to cache) or data URLs.
                if raw.startswith("data:image/"):
                    meta[f"asset.{name}"] = raw
                    continue
                if not is_url_like(raw):
                    if allow_local_assets:
                        norm = _normalize_local_asset_ref(raw, allowed_prefixes=list(local_prefixes))
                        if norm is not None:
                            meta[f"asset.{name}"] = norm
                            continue
                    if strict:
                        raise RuntimeError(
                            f"invalid @asset.{name}: only URL/data:image/... is allowed (local requires allow_local_assets and under {local_prefixes})"
                        )
                    meta.pop(f"asset.{name}", None)
                    meta[f"asset_error.{name}"] = (
                        f"only URL/data:image/... is allowed; local must be under {local_prefixes} and be an image file"
                    )
                    continue
                try:
                    p = await dl.fetch(raw, force=bool(redownload_assets))
                    meta[f"asset.{name}"] = f"{asset_ref_base.as_posix()}/{p.name}"
                except Exception as exc:
                    if strict:
                        raise
                    meta.pop(f"asset.{name}", None)
                    meta[f"asset_error.{name}"] = str(exc)

        data["meta"] = meta
        data["typst_assets_global"] = _build_typst_assets_global(meta)
        _apply_avatar_overrides(data, meta)
        for line in chat:
            if isinstance(line, dict):
                _rewrite_line_avatar_override(line, meta)

        async def resolve_line(
            reranker: SiliconFlowReranker,
            embedder: Optional[SiliconFlowEmbedder],
            line: Dict[str, Any],
        ) -> Optional[Exception]:
            segments = line.get("segments")
            if not isinstance(segments, list):
                return None
            new_segments: List[Dict[str, Any]] = []
            for seg in segments:
                if not isinstance(seg, dict):
                    continue
                seg_type = seg.get("type")
                if seg_type == "asset":
                    name = str(seg.get("name") or "").strip()
                    v = _asset_value(meta, name)
                    if not v:
                        if strict:
                            return RuntimeError(f"missing @asset.{name}")
                        seg2 = dict(seg)
                        seg2["error"] = f"missing @asset.{name}"
                        new_segments.append(seg2)
                        continue

                    # v is already policy-filtered by the meta rewrite step above.
                    if v.startswith("data:image/"):
                        new_segments.append({"type": "image", "ref": v, "alt": f"asset:{name}"})
                        continue

                    if is_url_like(v):
                        try:
                            async with sem:
                                p = await dl.fetch(v, force=bool(redownload_assets))
                            new_segments.append(
                                {
                                    "type": "image",
                                    "ref": f"{asset_ref_base.as_posix()}/{p.name}",
                                    "alt": f"asset:{name}",
                                }
                            )
                            continue
                        except Exception as exc:
                            if strict:
                                return exc
                            seg2 = dict(seg)
                            seg2["error"] = str(exc)
                            new_segments.append(seg2)
                            continue

                    new_segments.append({"type": "image", "ref": v, "alt": f"asset:{name}"})
                    continue
                # External image URLs might already be parsed as `type=image` by the DSL parser.
                if seg_type == "image":
                    ref = str(seg.get("ref") or "").strip()
                    if not ref:
                        new_segments.append(seg)
                        continue
                    if ref.startswith("data:image/"):
                        new_segments.append(seg)
                        continue
                    if is_url_like(ref):
                        try:
                            async with sem:
                                p = await dl.fetch(ref, force=bool(redownload_assets))
                            seg2 = dict(seg)
                            seg2["ref"] = f"{asset_ref_base.as_posix()}/{p.name}"
                            new_segments.append(seg2)
                            continue
                        except Exception as exc:
                            if strict:
                                return exc
                            seg2 = dict(seg)
                            seg2["error"] = str(exc)
                            new_segments.append(seg2)
                            continue
                    new_segments.append(seg)
                    continue

                if seg_type != "expr":
                    new_segments.append(seg)
                    continue
                query = str(seg.get("query") or "").strip()
                student_id = seg.get("student_id")
                target_char_id = seg.get("target_char_id") or seg.get("char_id") or line.get("char_id")
                if not query:
                    new_segments.append(seg)
                    continue

                # External inline image: allow using [:https://...] as "inline image", bypassing rerank.
                if query.startswith("data:image/"):
                    new_segments.append({"type": "image", "ref": query, "alt": "data"})
                    continue
                if is_url_like(query):
                    try:
                        async with sem:
                            p = await dl.fetch(query, force=bool(redownload_assets))
                        new_segments.append(
                            {
                                "type": "image",
                                "ref": f"{asset_ref_base.as_posix()}/{p.name}",
                                "alt": query,
                            }
                        )
                        continue
                    except Exception as exc:
                        if strict:
                            return exc
                        seg2 = dict(seg)
                        seg2["error"] = str(exc)
                        new_segments.append(seg2)
                        continue

                # Direct by-index reference: [:#5] / [#5]
                m_idx = re.match(r"^#\s*(\d+)\s*$", query)
                direct_idx = int(m_idx.group(1)) if m_idx else None

                try:
                    async with sem:
                        if isinstance(student_id, int):
                            candidates = _load_tags_for_student(tags_root, student_id)
                            if not candidates:
                                raise RuntimeError(f"missing tags for student {student_id}")
                            images_dir = (tags_root / str(student_id)).resolve()

                            if direct_idx is not None:
                                i0 = direct_idx - 1
                                if i0 < 0 or i0 >= len(candidates):
                                    raise RuntimeError(f"index out of range: #{direct_idx} (1..{len(candidates)})")
                                image_name = candidates[i0].image_name
                                image_path = images_dir / image_name
                                if not image_path.exists():
                                    raise RuntimeError(f"resolved image missing on disk: {image_path}")
                                score = 1.0
                            else:
                                image_name, score = await resolve_one(
                                    reranker,
                                    query=query,
                                    candidates=candidates,
                                    images_dir=images_dir,
                                    cache_key=f"kivo:{student_id}",
                                    top_n=1,
                                    embedder=embedder,
                                    embed_top_k=int(embed_top_k),
                                    index_cache=idx_cache,
                                )

                            new_segments.append(
                                {
                                    "type": "image",
                                    "ref": f"{ref_base.as_posix()}/{student_id}/{image_name}",
                                    "alt": query,
                                    "score": score,
                                }
                            )
                        elif isinstance(target_char_id, str) and target_char_id.startswith("ba.") and pack_ba is not None:
                            cid = target_char_id.split(".", 1)[1]
                            if cid not in pack_ba.id_to_assets:
                                raise RuntimeError(f"unknown ba character: {cid}")
                            candidates = _load_tags_for_pack_char(pack_ba, cid)
                            if not candidates:
                                raise RuntimeError(f"missing tags for ba.{cid}")
                            tags_path = pack_ba.tags_path(cid)
                            images_dir = tags_path.parent.resolve()

                            if direct_idx is not None:
                                i0 = direct_idx - 1
                                if i0 < 0 or i0 >= len(candidates):
                                    raise RuntimeError(f"index out of range: #{direct_idx} (1..{len(candidates)})")
                                image_name = candidates[i0].image_name
                                image_path = images_dir / image_name
                                if not image_path.exists():
                                    raise RuntimeError(f"resolved image missing on disk: {image_path}")
                                score = 1.0
                            else:
                                image_name, score = await resolve_one(
                                    reranker,
                                    query=query,
                                    candidates=candidates,
                                    images_dir=images_dir,
                                    cache_key=f"ba:{cid}",
                                    top_n=1,
                                    embedder=embedder,
                                    embed_top_k=int(embed_top_k),
                                    index_cache=idx_cache,
                                )

                            img_abs = (images_dir / image_name).resolve()
                            if ref_root is not None:
                                try:
                                    ref = Path(os.path.relpath(img_abs, start=Path(ref_root).resolve())).as_posix()
                                except Exception:
                                    ref = img_abs.as_posix()
                            else:
                                ref = img_abs.as_posix()
                            new_segments.append({"type": "image", "ref": ref, "alt": query, "score": score})
                        else:
                            new_segments.append(seg)
                            continue
                except Exception as exc:
                    if strict:
                        return exc
                    seg2 = dict(seg)
                    seg2["error"] = str(exc)
                    new_segments.append(seg2)
            line["segments"] = new_segments
            return None

        async with SiliconFlowReranker(cfg) as reranker:
            if use_embedding:
                try:
                    async with SiliconFlowEmbedder(embed_cfg) as embedder:
                        tasks = []
                        for line in chat:
                            if isinstance(line, dict):
                                tasks.append(asyncio.create_task(resolve_line(reranker, embedder, line)))
                        results = await asyncio.gather(*tasks, return_exceptions=False)
                        for r in results:
                            if isinstance(r, Exception):
                                raise r
                except Exception:
                    # Fallback: rerank-only if embedding fails (e.g. no key / endpoint issues).
                    tasks = []
                    for line in chat:
                        if isinstance(line, dict):
                            tasks.append(asyncio.create_task(resolve_line(reranker, None, line)))
                    results = await asyncio.gather(*tasks, return_exceptions=False)
                    for r in results:
                        if isinstance(r, Exception):
                            raise r
            else:
                tasks = []
                for line in chat:
                    if isinstance(line, dict):
                        tasks.append(asyncio.create_task(resolve_line(reranker, None, line)))
                results = await asyncio.gather(*tasks, return_exceptions=False)
                for r in results:
                    if isinstance(r, Exception):
                        raise r

    output_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Resolve inline expression segments to image refs using SiliconFlow reranker.")
    p.add_argument("input", help="Input JSON produced by mmt_text_to_json.py")
    p.add_argument("-o", "--output", required=True, help="Output JSON with resolved image segments")
    p.add_argument("--tags-root", default="images/students", help="Root folder containing per-student tags.json")
    p.add_argument("--model", default="Qwen/Qwen3-Reranker-8B")
    p.add_argument("--api-key-env", default="SILICON_API_KEY")
    p.add_argument("--concurrency", type=int, default=10)
    p.add_argument("--embed-model", default="Qwen/Qwen3-Embedding-8B", help="Embedding model for first-stage recall.")
    p.add_argument("--embed-top-k", type=int, default=50, help="Recall top-k docs before rerank (default: 50).")
    p.add_argument("--no-embedding", action="store_true", help="Disable embedding recall; rerank over all candidates.")
    p.add_argument(
        "--asset-cache-dir",
        default=None,
        help="Cache dir for external image URLs (default: env MMT_ASSET_CACHE_DIR or .cache/mmt_assets)",
    )
    p.add_argument("--redownload-assets", action="store_true", help="Force redownload external images even if cached.")
    p.add_argument("--asset-max-mb", type=int, default=10, help="Max download size (MB) for external images.")
    p.add_argument(
        "--allow-local-assets",
        action="store_true",
        help="Allow @asset.* to reference local image files under specific prefixes (default: disabled).",
    )
    p.add_argument(
        "--asset-local-prefixes",
        default="mmt_assets",
        help="Comma-separated allowed first path segments for local @asset.* (default: mmt_assets).",
    )
    p.add_argument(
        "--strict",
        action="store_true",
        help="Fail the whole run if any expression cannot be resolved (default: keep unresolved with error).",
    )
    p.add_argument(
        "--ref-root",
        default=None,
        help="If provided, image refs are made relative to this root (useful for typst root).",
    )
    args = p.parse_args()

    return asyncio.run(
        resolve_file(
            input_path=Path(args.input),
            output_path=Path(args.output),
            tags_root=Path(args.tags_root),
            ref_root=Path(args.ref_root) if args.ref_root else None,
            model=args.model,
            api_key_env=args.api_key_env,
            concurrency=args.concurrency,
            strict=bool(args.strict),
            use_embedding=not bool(args.no_embedding),
            embed_model=str(args.embed_model),
            embed_top_k=int(args.embed_top_k),
            asset_cache_dir=Path(args.asset_cache_dir) if args.asset_cache_dir else None,
            redownload_assets=bool(args.redownload_assets),
            asset_max_mb=int(args.asset_max_mb),
            allow_local_assets=bool(args.allow_local_assets),
            asset_local_prefixes=[x.strip() for x in str(args.asset_local_prefixes).split(",") if x.strip()],
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
