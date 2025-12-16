from __future__ import annotations

import argparse
import asyncio
import json
import os
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
    return docs


def _doc_text(candidate: CandidateDoc) -> str:
    # Keep this short and reranker-friendly: description + tags.
    tags = ", ".join(candidate.tags[:32])
    if tags:
        return f"{candidate.description}\nTags: {tags}\nFile: {candidate.image_name}"
    return f"{candidate.description}\nFile: {candidate.image_name}"


def _student_key(student_id: int) -> str:
    return str(int(student_id))


@dataclass
class _StudentIndex:
    candidates: List[CandidateDoc]
    docs: List[str]
    index: EmbeddingIndex


class _StudentIndexCache:
    def __init__(self, max_students: int = 8):
        self.max_students = max(1, int(max_students))
        self._order: List[int] = []
        self._data: Dict[int, _StudentIndex] = {}

    def get(self, student_id: int) -> Optional[_StudentIndex]:
        it = self._data.get(student_id)
        if it is None:
            return None
        # refresh LRU
        try:
            self._order.remove(student_id)
        except ValueError:
            pass
        self._order.append(student_id)
        return it

    def put(self, student_id: int, item: _StudentIndex) -> None:
        if student_id in self._data:
            self._data[student_id] = item
            try:
                self._order.remove(student_id)
            except ValueError:
                pass
            self._order.append(student_id)
            return
        self._data[student_id] = item
        self._order.append(student_id)
        while len(self._order) > self.max_students:
            evict = self._order.pop(0)
            self._data.pop(evict, None)


async def resolve_one(
    reranker: SiliconFlowReranker,
    *,
    query: str,
    student_id: int,
    tags_root: Path,
    top_n: int = 1,
    embedder: Optional[SiliconFlowEmbedder] = None,
    embed_top_k: int = 50,
    index_cache: Optional[_StudentIndexCache] = None,
) -> Tuple[str, float]:
    candidates = _load_tags_for_student(tags_root, student_id)
    if not candidates:
        raise RuntimeError(f"missing tags for student {student_id}")

    docs_all = [_doc_text(c) for c in candidates]
    chosen_candidates = candidates
    chosen_docs = docs_all
    chosen_map: Optional[List[int]] = None

    if embedder is not None and int(embed_top_k) > 0 and len(candidates) > int(embed_top_k):
        cache = index_cache or _StudentIndexCache(max_students=8)
        cached = cache.get(student_id)
        if cached is None:
            vecs = await embedder.embed_texts(docs_all, use_cache=True)
            idx = EmbeddingIndex.build(vecs)
            cached = _StudentIndex(candidates=candidates, docs=docs_all, index=idx)
            cache.put(student_id, cached)
        # Do not cache queries to avoid unbounded cache growth.
        q_vec = (await embedder.embed_texts([query], use_cache=False))[0]
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
    image_path = tags_root / str(student_id) / image_name
    if not image_path.exists():
        raise RuntimeError(f"resolved image missing on disk: {image_path}")
    return image_name, score


async def resolve_file(
    *,
    input_path: Path,
    output_path: Path,
    tags_root: Path,
    ref_root: Optional[Path] = None,
    model: str,
    api_key_env: str,
    concurrency: int,
    strict: bool = False,
    use_embedding: bool = True,
    embed_model: str = "Qwen/Qwen3-Embedding-8B",
    embed_top_k: int = 50,
) -> int:
    data = json.loads(input_path.read_text(encoding="utf-8"))
    chat = data.get("chat")
    if not isinstance(chat, list):
        raise SystemExit("input JSON missing 'chat' list")

    cfg = SiliconFlowRerankConfig(api_key_env=api_key_env, model=model)
    embed_cfg = SiliconFlowEmbedConfig(api_key_env=api_key_env, model=embed_model)
    sem = asyncio.Semaphore(max(1, concurrency))
    idx_cache = _StudentIndexCache(max_students=8)

    ref_base = tags_root
    if ref_root is not None:
        # Typst resolves relative paths against the source file directory. Using relpath is more robust than Path.relative_to
        # because tags_root is often a sibling of the typst template directory (especially when mmt_render is a symlink).
        try:
            ref_base = Path(os.path.relpath(tags_root.resolve(), start=ref_root.resolve()))
        except Exception:
            ref_base = tags_root

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
            if seg.get("type") != "expr":
                new_segments.append(seg)
                continue
            query = str(seg.get("query") or "").strip()
            student_id = seg.get("student_id")
            if not query or not isinstance(student_id, int):
                new_segments.append(seg)
                continue
            try:
                async with sem:
                    image_name, score = await resolve_one(
                        reranker,
                        query=query,
                        student_id=student_id,
                        tags_root=tags_root,
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
            except Exception as exc:
                if strict:
                    return exc
                # Keep unresolved expr but annotate error for debugging.
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
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
