from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import Optional

from nonebot import logger
from nonebot.adapters import Bot, Event

from ..context import plugin_config
from ..pack_store import EulaDB
from .common import event_scope_ids, image_order_key, parse_opts_tokens, safe_stem
from .pack import (
    resolve_pack_v2_sources_for_character,
    resolve_tags_file_and_images_dir_for_character,
    state_db_path,
)
from .typst import common_root, run_typst
from .io import send_onebot_images

try:
    from mmt_render import mmt_text_to_json
except Exception:  # pragma: no cover
    mmt_text_to_json = None  # type: ignore

try:
    from mmt_render.siliconflow_rerank import SiliconFlowRerankConfig, SiliconFlowReranker
except Exception:  # pragma: no cover
    SiliconFlowRerankConfig = None  # type: ignore
    SiliconFlowReranker = None  # type: ignore

try:
    from mmt_render.siliconflow_embed import SiliconFlowEmbedConfig, SiliconFlowEmbedder
    from mmt_render.embedding_index import EmbeddingIndex
except Exception:  # pragma: no cover
    SiliconFlowEmbedConfig = None  # type: ignore
    SiliconFlowEmbedder = None  # type: ignore
    EmbeddingIndex = None  # type: ignore


async def handle_mmt_img(
    *,
    finish,
    bot: Bot,
    event: Event,
    name: str,
    packs: Optional[list[str]] = None,
    page: int = 1,
) -> None:
    # Render a table view of all expressions for a character.
    if not name:
        await finish("用法：/mmt-img [--pack ba,ba_extpack] [--page 1] <角色名>")

    if mmt_text_to_json is None:
        await finish("mmt_render.mmt_text_to_json 无法导入，无法解析角色名。")

    try:
        sources, sid_for_title = resolve_pack_v2_sources_for_character(name=name, pack_ids=packs)
    except Exception as exc:
        await finish(str(exc))

    # EULA gate (best-effort)
    private_id, _group_id = event_scope_ids(event)
    if private_id:
        eula_db = EulaDB(state_db_path())
        for src in sources:
            pid = str(src.get("pack_id") or "")
            pack = src.get("pack")
            if pack is None:
                continue
            if pack.manifest.eula_required and not eula_db.is_accepted(user_id=private_id, pack_id=pid):
                await finish(f"该包需要先同意 EULA：{pid}\n同意后请发送：/mmt-pack accept {pid}")

    out_dir = plugin_config.work_dir_path()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = safe_stem(name)
    data_json = out_dir / f"{stem}.mmt_img.json"
    png_out_tpl = out_dir / f"{stem}.mmt_img-{{0p}}.png"

    template = (Path(__file__).resolve().parents[1] / "mmt_img.typ").resolve()
    if not template.exists():
        await finish(f"typst 模板不存在：{template}")

    items = []
    # Use project-root absolute paths (`/...`) so Typst resolves them against `--root`
    # instead of relative to the template directory. This avoids `..` escaping issues.
    pack_v2_root = plugin_config.pack_v2_root_path()
    images_dirs = [src["images_dir"] for src in sources if isinstance(src.get("images_dir"), Path)]
    if not images_dirs:
        await finish("未找到可用的 tags.json。")
    root_paths = [template, data_json, png_out_tpl, *images_dirs]
    if pack_v2_root.exists():
        root_paths.append(pack_v2_root)
    root_for_paths = common_root(*root_paths)

    for src in sources:
        tags_file = src.get("tags_file")
        images_dir = src.get("images_dir")
        if not isinstance(tags_file, Path) or not isinstance(images_dir, Path):
            continue
        if not tags_file.exists():
            await finish(f"该角色没有 tags.json：{tags_file}")
        try:
            raw = json.loads(tags_file.read_text(encoding="utf-8"))
        except Exception as exc:
            await finish(f"tags.json 解析失败：{exc}")
        if not isinstance(raw, list) or not raw:
            continue
        raw = sorted(
            [x for x in raw if isinstance(x, dict)],
            key=lambda it: image_order_key(str(it.get("image_name") or "")),
        )
        pack_id = str(src.get("pack_id") or "")
        for it in raw:
            image_name = str(it.get("image_name") or "")
            if not image_name:
                continue
            img_abs = images_dir / image_name
            try:
                img_abs_resolved = img_abs.resolve()
            except Exception:
                img_abs_resolved = img_abs.absolute()
            try:
                rel_from_root = Path(os.path.relpath(img_abs_resolved, start=root_for_paths.resolve())).as_posix()
                img_rel = f"/{rel_from_root.lstrip('/')}"
            except Exception:
                img_rel = str(img_abs_resolved).replace("\\", "/")
            tags = it.get("tags") if isinstance(it.get("tags"), list) else []
            tags = [str(x) for x in tags if isinstance(x, str)]
            desc = str(it.get("description") or "")
            items.append(
                {
                    "img_path": img_rel,
                    "pack": pack_id,
                    "tags": tags,
                    "description": desc,
                }
            )

    if not items:
        await finish("tags.json 为空。")

    page_size = 30
    total = len(items)
    total_pages = max(1, (total + page_size - 1) // page_size)
    if page < 1 or page > total_pages:
        await finish(f"页码超出范围：{page} / {total_pages}")
    start = (page - 1) * page_size
    end = start + page_size
    items = items[start:end]

    data_json.write_text(
        json.dumps({"character": name, "student_id": sid_for_title, "items": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    try:
        await asyncio.to_thread(
            run_typst,
            typst_bin=plugin_config.mmt_typst_bin,
            template=template,
            input_json=data_json,
            out_path=png_out_tpl,
            tags_root=pack_v2_root if pack_v2_root.exists() else images_dirs[0],
            out_format="png",
            input_key="data",
        )
    except Exception as exc:
        def _p(p: Path) -> str:
            try:
                return p.resolve().as_posix()
            except Exception:
                return p.absolute().as_posix()

        examples = ", ".join((it.get("img_path") or "") for it in items[:3])
        await finish(
            "Typst 渲染失败。\n"
            f"- error: {exc}\n"
            f"- data_json: {_p(data_json)}\n"
            f"- template: {_p(template)}\n"
            f"- tags_root: {_p(images_dir)}\n"
            f"- img_path examples: {examples}"
        )

    pngs = sorted(out_dir.glob(f"{stem}.mmt_img-*.png"), key=lambda p: p.name)
    if not pngs:
        single = out_dir / f"{stem}.mmt_img.png"
        if single.exists():
            pngs = [single]
    if not pngs:
        await finish("Typst 渲染成功但没找到输出图片。")

    try:
        await send_onebot_images(bot, event, pngs)
    except Exception as exc:
        await finish(f"已生成：{pngs[0]}（发送失败：{exc}）")

    await finish(
        f"已发送 {len(pngs)} 张表格图（第 {page}/{total_pages} 页，共 {total} 条记录）。"
    )


def _doc_text_for_rerank(item: dict) -> str:
    tags = item.get("tags") if isinstance(item.get("tags"), list) else []
    tags = [str(x) for x in tags if isinstance(x, str)]
    desc = str(item.get("description") or "")
    img = str(item.get("image_name") or "")
    tags_txt = ", ".join(tags[:32])
    if tags_txt:
        return f"{desc}\nTags: {tags_txt}\nFile: {img}"
    return f"{desc}\nFile: {img}"


async def handle_imgmatch(
    *,
    finish,
    bot: Bot,
    event: Event,
    packs: Optional[list[str]],
    name: str,
    top_n: int,
    query: str,
) -> None:
    # Two-stage retrieve (embed -> rerank) then render the top matches.
    if not name or not query:
        await finish("用法：/mmt-imgmatch [--pack ba,ba_extpack] <角色名> [--top-n=5] <描述>")

    if mmt_text_to_json is None:
        await finish("mmt_render.mmt_text_to_json 无法导入，无法解析角色名。")
    if SiliconFlowRerankConfig is None or SiliconFlowReranker is None:
        await finish("mmt_render.siliconflow_rerank 无法导入，无法使用 reranker。")

    # Resolve sources (support multiple packs)
    try:
        sources, sid_for_title = resolve_pack_v2_sources_for_character(name=name, pack_ids=packs)
    except Exception as exc:
        await finish(str(exc))

    # EULA gate (best-effort)
    private_id, _group_id = event_scope_ids(event)
    if private_id:
        eula_db = EulaDB(state_db_path())
        for src in sources:
            pid = str(src.get("pack_id") or "")
            pack = src.get("pack")
            if pack is None:
                continue
            if pack.manifest.eula_required and not eula_db.is_accepted(user_id=private_id, pack_id=pid):
                await finish(f"该包需要先同意 EULA：{pid}\n同意后请发送：/mmt-pack accept {pid}")

    docs: list[str] = []
    entries: list[dict] = []
    for src in sources:
        pid = str(src.get("pack_id") or "")
        tags_file = src.get("tags_file")
        images_dir = src.get("images_dir")
        if not isinstance(tags_file, Path) or not isinstance(images_dir, Path):
            continue
        if not tags_file.exists():
            await finish(f"该角色没有 tags.json：{tags_file}")
        try:
            raw_items = json.loads(tags_file.read_text(encoding="utf-8"))
        except Exception as exc:
            await finish(f"tags.json 解析失败：{exc}")
        if not isinstance(raw_items, list) or not raw_items:
            continue
        raw_items = sorted(
            [x for x in raw_items if isinstance(x, dict)],
            key=lambda it: image_order_key(str(it.get("image_name") or "")),
        )
        for i, it in enumerate(raw_items):
            image_name = str(it.get("image_name") or "")
            if not image_name:
                continue
            entry = dict(it)
            entry["_pack_id"] = pid
            entry["_images_dir"] = images_dir
            entry["_pack_index"] = i + 1
            if pid and pid != "legacy":
                entry["_ref"] = f"#{pid}.{i + 1}"
            else:
                entry["_ref"] = f"#{i + 1}"
            entries.append(entry)
            docs.append(_doc_text_for_rerank(it))

    if not entries:
        await finish("tags.json 没有有效条目（缺 image_name）。")

    cfg = SiliconFlowRerankConfig(api_key_env=plugin_config.mmt_rerank_key_env, model=plugin_config.mmt_rerank_model)
    try:
        # Two-stage retrieval (embedding -> rerank) when the candidate list is large.
        # For small lists, rerank directly is fast enough.
        docs_for_rerank = docs
        index_map: Optional[list[int]] = None

        embed_top_k = 50
        if (
            SiliconFlowEmbedConfig is not None
            and SiliconFlowEmbedder is not None
            and EmbeddingIndex is not None
            and embed_top_k > 0
            and len(docs) > embed_top_k
        ):
            try:
                embed_cfg = SiliconFlowEmbedConfig(
                    api_key_env=plugin_config.mmt_rerank_key_env,
                    cache_path=str(plugin_config.work_dir_path() / "siliconflow_embed.sqlite3"),
                )
                async with SiliconFlowEmbedder(embed_cfg) as embedder:
                    vecs = await embedder.embed_texts(docs, use_cache=True)
                    q_vec = (await embedder.embed_texts([query], use_cache=True))[0]
                idx = EmbeddingIndex.build(vecs)
                top_idx = idx.top_k(q_vec, embed_top_k)
                if top_idx:
                    index_map = list(top_idx)
                    docs_for_rerank = [docs[i] for i in top_idx]
            except Exception as exc:
                logger.warning(f"imgmatch embedding prefilter failed, fallback to rerank-only: {exc}")
                docs_for_rerank = docs
                index_map = None

        async with SiliconFlowReranker(cfg) as reranker:
            results = await reranker.rerank(
                query=query,
                documents=docs_for_rerank,
                top_n=min(top_n, len(docs_for_rerank)),
                return_documents=False,
            )
            if index_map is not None:
                for r in results:
                    idx = r.get("index")
                    if isinstance(idx, int) and 0 <= idx < len(index_map):
                        r["index"] = index_map[idx]
    except Exception as exc:
        await finish(f"rerank 失败：{exc}")

    # Prepare typst data
    out_dir = plugin_config.work_dir_path()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = safe_stem(name + query)
    data_json = out_dir / f"{stem}.mmt_imgmatch.json"
    png_out_tpl = out_dir / f"{stem}.mmt_imgmatch-{{0p}}.png"

    template = (Path(__file__).resolve().parents[1] / "mmt_imgmatch.typ").resolve()
    if not template.exists():
        await finish(f"typst 模板不存在：{template}")

    pack_v2_root = plugin_config.pack_v2_root_path()
    root_for_paths = common_root(
        template,
        data_json,
        png_out_tpl,
        pack_v2_root if pack_v2_root.exists() else sources[0]["images_dir"],
    )
    items: list[dict] = []
    for r in results:
        idx = r.get("index")
        if not isinstance(idx, int) or not (0 <= idx < len(entries)):
            continue
        base = entries[idx]
        image_name = str(base.get("image_name") or "")
        images_dir = base.get("_images_dir")
        if not isinstance(images_dir, Path):
            images_dir = sources[0]["images_dir"]
        img_abs = images_dir / image_name
        try:
            img_abs_resolved = img_abs.resolve()
        except Exception:
            img_abs_resolved = img_abs.absolute()
        try:
            rel_from_root = Path(os.path.relpath(img_abs_resolved, start=root_for_paths.resolve())).as_posix()
            img_path = f"/{rel_from_root.lstrip('/')}"
        except Exception:
            img_path = str(img_abs_resolved).replace("\\", "/")
        tags = base.get("tags") if isinstance(base.get("tags"), list) else []
        tags = [str(x) for x in tags if isinstance(x, str)]
        desc = str(base.get("description") or "")
        score = float(r.get("score") or 0.0)
        items.append(
            {
                "img_path": img_path,
                "image_name": image_name,
                "pack_id": str(base.get("_pack_id") or ""),
                "pack_index": int(base.get("_pack_index") or 0),
                "ref": str(base.get("_ref") or ""),
                "tags": tags,
                "description": desc,
                "score": round(score, 6),
            }
        )

    data_json.write_text(
        json.dumps(
            {"character": name, "student_id": sid_for_title, "query": query, "items": items},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    try:
        await asyncio.to_thread(
            run_typst,
            typst_bin=plugin_config.mmt_typst_bin,
            template=template,
            input_json=data_json,
            out_path=png_out_tpl,
            tags_root=pack_v2_root if pack_v2_root.exists() else sources[0]["images_dir"],
            out_format="png",
            input_key="data",
        )
    except Exception as exc:
        await finish(f"Typst 渲染失败：{exc}\n- data_json: {data_json}")

    pngs = sorted(out_dir.glob(f"{stem}.mmt_imgmatch-*.png"), key=lambda p: p.name)
    if not pngs:
        single = out_dir / f"{stem}.mmt_imgmatch.png"
        if single.exists():
            pngs = [single]
    if not pngs:
        await finish("Typst 渲染成功但没找到输出图片。")

    try:
        await send_onebot_images(bot, event, pngs)
    except Exception as exc:
        await finish(f"已生成：{pngs[0]}（发送失败：{exc}）")

    await finish(f"已发送 {len(pngs)} 张匹配结果（top_n={top_n}）。")


__all__ = [
    "handle_imgmatch",
    "handle_mmt_img",
]
