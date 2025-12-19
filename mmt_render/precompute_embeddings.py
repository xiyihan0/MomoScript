from __future__ import annotations

import argparse
import asyncio
import logging
import os
from pathlib import Path
from typing import Iterable, List, Optional

from mmt_render.pack_v2 import PackV2, load_pack_v2
from mmt_render.resolve_expressions import (
    _doc_text,
    _load_tags_for_pack_char,
    _load_tags_for_student,
)
from mmt_render.siliconflow_embed import SiliconFlowEmbedConfig, SiliconFlowEmbedder


logger = logging.getLogger("mmt_precompute")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def _parse_csv(value: str) -> List[str]:
    raw = (value or "").strip()
    if not raw:
        return []
    out: List[str] = []
    for part in raw.split(","):
        p = part.strip()
        if p:
            out.append(p)
    return out


def _iter_pack_dirs(root: Path, pack_ids: Optional[List[str]]) -> Iterable[Path]:
    if pack_ids:
        for pid in pack_ids:
            yield root / pid
        return
    for d in sorted([p for p in root.iterdir() if p.is_dir()], key=lambda p: p.name.lower()):
        yield d


async def _embed_docs(
    *,
    embedder: SiliconFlowEmbedder,
    docs: List[str],
    label: str,
    batch_hint: int,
) -> int:
    if not docs:
        return 0
    logger.info("embedding %s | docs=%d", label, len(docs))
    await embedder.embed_texts(docs, use_cache=True)
    return len(docs)


async def _run(
    *,
    pack_v2_root: Path,
    pack_ids: Optional[List[str]],
    include_legacy: bool,
    legacy_tags_root: Optional[Path],
    config: SiliconFlowEmbedConfig,
) -> int:
    total_docs = 0
    pack_v2_root = pack_v2_root.expanduser()
    if pack_v2_root.exists():
        logger.info("pack-v2 root: %s", pack_v2_root)
    else:
        logger.warning("pack-v2 root missing: %s", pack_v2_root)

    async with SiliconFlowEmbedder(config) as embedder:
        if pack_v2_root.exists():
            for pack_dir in _iter_pack_dirs(pack_v2_root, pack_ids):
                try:
                    pack = load_pack_v2(pack_dir)
                except Exception as exc:
                    logger.warning("skip pack: %s (%s)", pack_dir.name, exc)
                    continue

                if pack.manifest.type not in ("base", "extension"):
                    logger.warning("skip pack with unknown type: %s", pack.manifest.pack_id)
                    continue

                for cid in sorted(pack.id_to_assets.keys()):
                    docs = _load_tags_for_pack_char(pack, cid)
                    text_docs = [_doc_text(d) for d in docs]
                    label = f"{pack.manifest.pack_id}:{cid}"
                    total_docs += await _embed_docs(
                        embedder=embedder,
                        docs=text_docs,
                        label=label,
                        batch_hint=config.batch_size,
                    )

        if include_legacy:
            tags_root = legacy_tags_root or Path("images/students")
            tags_root = tags_root.expanduser()
            if not tags_root.exists():
                logger.warning("legacy tags root missing: %s", tags_root)
            else:
                for p in sorted(tags_root.glob("*/tags.json")):
                    try:
                        sid = int(p.parent.name)
                    except Exception:
                        continue
                    docs = _load_tags_for_student(tags_root, sid)
                    text_docs = [_doc_text(d) for d in docs]
                    label = f"legacy:{sid}"
                    total_docs += await _embed_docs(
                        embedder=embedder,
                        docs=text_docs,
                        label=label,
                        batch_hint=config.batch_size,
                    )

    return total_docs


def main() -> int:
    p = argparse.ArgumentParser(description="Precompute embedding cache for all tags.json entries.")
    p.add_argument("--pack-v2-root", default=os.getenv("MMT_PACK_V2_ROOT", "pack-v2"))
    p.add_argument("--packs", default="", help="Comma-separated pack ids (default: all under pack-v2 root).")
    p.add_argument("--include-legacy", action="store_true", help="Also scan legacy tags root (images/students).")
    p.add_argument("--legacy-tags-root", default="", help="Legacy tags root (default: images/students).")
    p.add_argument("--model", default=SiliconFlowEmbedConfig.model)
    p.add_argument("--api-key-env", default="SILICON_API_KEY")
    p.add_argument("--cache-path", default=os.getenv("MMT_EMBED_CACHE_PATH", "").strip())
    p.add_argument("--batch-size", type=int, default=64)
    args = p.parse_args()

    cache_path = args.cache_path or SiliconFlowEmbedConfig.cache_path
    cfg = SiliconFlowEmbedConfig(
        api_key_env=str(args.api_key_env),
        model=str(args.model),
        cache_path=str(cache_path),
        batch_size=max(1, int(args.batch_size)),
    )

    pack_ids = _parse_csv(args.packs)
    legacy_root = Path(args.legacy_tags_root) if args.legacy_tags_root else None

    total = asyncio.run(
        _run(
            pack_v2_root=Path(args.pack_v2_root),
            pack_ids=pack_ids or None,
            include_legacy=bool(args.include_legacy),
            legacy_tags_root=legacy_root,
            config=cfg,
        )
    )
    logger.info("done | total_docs=%d cache=%s", total, cfg.cache_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
