from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Optional

from nonebot import get_driver, logger, on_command
from nonebot.adapters import Bot, Event
from nonebot.params import CommandArg
from nonebot.plugin import PluginMetadata
from nonebot.typing import T_State

from .config import MMTPipeConfig
from .assets_store import (
    AssetDB,
    AssetDownloader,
    AssetError,
    merge_asset_meta,
    validate_asset_name,
    write_blob,
)
from .pack_store import EulaDB, PackStoreError, validate_pack_id

try:
    from nonebot.adapters.onebot.v11 import MessageSegment as V11MessageSegment
    from nonebot.adapters.onebot.v11 import Message as V11Message
    from nonebot.adapters.onebot.v11.exception import ActionFailed as V11ActionFailed
except Exception:  # pragma: no cover
    V11MessageSegment = None  # type: ignore
    V11Message = None  # type: ignore
    V11ActionFailed = None  # type: ignore

try:
    from mmt_render import mmt_text_to_json
except Exception:  # pragma: no cover
    mmt_text_to_json = None  # type: ignore

try:
    from mmt_render.typst_sandbox import TypstSandboxOptions, run_typst_sandboxed
except Exception:  # pragma: no cover
    TypstSandboxOptions = None  # type: ignore
    run_typst_sandboxed = None  # type: ignore

try:
    from mmt_render.resolve_expressions import resolve_file
except Exception:  # pragma: no cover
    resolve_file = None  # type: ignore

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

try:
    from mmt_render.pack_v2 import PackV2, load_pack_v2
except Exception:  # pragma: no cover
    PackV2 = None  # type: ignore
    load_pack_v2 = None  # type: ignore


driver = get_driver()
raw_cfg = driver.config
try:
    # nonebot uses pydantic settings (v1/v2) depending on version
    cfg_dict = raw_cfg.model_dump()  # type: ignore[attr-defined]
except Exception:
    try:
        cfg_dict = raw_cfg.dict()  # type: ignore[attr-defined]
    except Exception:
        cfg_dict = dict(raw_cfg)  # type: ignore[arg-type]

plugin_config = MMTPipeConfig.model_validate(cfg_dict)


def _load_ba_pack_v2() -> Optional["PackV2"]:
    if load_pack_v2 is None:
        return None
    root = plugin_config.pack_v2_root_path() / "ba"
    if not root.exists():
        return None
    try:
        return load_pack_v2(root)
    except Exception:
        return None


def _resolve_tags_file_and_images_dir_for_character(name: str) -> tuple[Path, Path, object]:
    """
    Returns: (tags_file, images_dir, id_for_title)
    - pack-v2: id_for_title = pack_char_id (str, e.g. "优香")
    - legacy:  id_for_title = student id (int)
    """
    token = (name or "").strip()
    if token.lower().startswith("ba."):
        token = token[3:].strip()

    # Prefer pack-v2 ba if available.
    pack = _load_ba_pack_v2()
    if pack is not None:
        pack_char_id = pack.resolve_char_id(token)
        if pack_char_id is not None:
            if pack_char_id not in pack.id_to_assets:
                raise RuntimeError(f"pack-v2 映射缺失：{token} -> {pack_char_id}")
            tags_file = pack.tags_path(pack_char_id)
            images_dir = tags_file.parent
            return tags_file, images_dir, pack_char_id

    # Fallback: legacy kivo id lookup.
    name_map_path, _avatar_dir = _find_name_map_and_avatar_dir()
    if not name_map_path.exists():
        raise RuntimeError(
            "pack-v2 未启用/未命中，且 legacy 名称映射缺失："
            f"{name_map_path}（请检查 `MMT_PACK_V2_ROOT` 或恢复 `avatar/name_to_id.json`）"
        )
    name_map = mmt_text_to_json._load_name_to_id(name_map_path)  # type: ignore[union-attr]
    base_index = mmt_text_to_json._build_base_index(name_map)  # type: ignore[union-attr]
    sid = mmt_text_to_json._resolve_student_id(token, name_map, base_index)  # type: ignore[union-attr]
    if sid is None:
        raise RuntimeError(f"未找到角色：{token}")
    images_dir = (plugin_config.tags_root_path() / str(sid)).resolve()
    tags_file = (images_dir / "tags.json").resolve()
    return tags_file, images_dir, int(sid)

def _parse_pack_csv(value: str) -> list[str]:
    raw = (value or "").strip()
    if not raw:
        return []
    out: list[str] = []
    for part in raw.split(","):
        p = part.strip()
        if not p:
            continue
        out.append(validate_pack_id(p))
    # de-dup, preserve order
    seen: set[str] = set()
    uniq: list[str] = []
    for p in out:
        if p in seen:
            continue
        seen.add(p)
        uniq.append(p)
    return uniq


def _parse_opts_tokens(tokens: list[str]) -> tuple[dict, list[str]]:
    """
    Extracts known options from tokens (any position).
    Returns: (opts, remaining_tokens)
    opts:
      - packs: list[str] | None
      - top_n: int | None
    """
    packs: list[str] | None = None
    top_n: int | None = None

    remain: list[str] = []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t == "--pack" and i + 1 < len(tokens):
            packs = _parse_pack_csv(tokens[i + 1])
            i += 2
            continue
        if t.startswith("--pack="):
            packs = _parse_pack_csv(t.split("=", 1)[1])
            i += 1
            continue
        if t == "--top-n" and i + 1 < len(tokens):
            try:
                top_n = max(1, int(tokens[i + 1]))
            except Exception:
                top_n = None
            i += 2
            continue
        if t.startswith("--top-n="):
            try:
                top_n = max(1, int(t.split("=", 1)[1]))
            except Exception:
                top_n = None
            i += 1
            continue
        remain.append(t)
        i += 1

    return {"packs": packs, "top_n": top_n}, remain


def _load_pack_v2_by_id(pack_id: str) -> "PackV2":
    if load_pack_v2 is None:
        raise RuntimeError("pack-v2 loader 不可用。")
    pid = validate_pack_id(pack_id)
    root = plugin_config.pack_v2_root_path() / pid
    if not root.exists():
        raise RuntimeError(f"pack-v2 不存在：{pid}（目录：{root}）")
    return load_pack_v2(root)


def _resolve_pack_v2_sources_for_character(
    *,
    name: str,
    pack_ids: Optional[list[str]],
) -> tuple[list[dict], object]:
    """
    Returns:
      - sources: list[{"pack_id","pack","char_id","tags_file","images_dir"}]
      - id_for_title: usually char_id (str) for pack-v2, or legacy student id (int)
    """
    token = (name or "").strip()
    if not token:
        raise RuntimeError("未提供角色名。")

    # Namespaced form: "<pack_id>.<char>"
    if "." in token:
        head, tail = token.split(".", 1)
        if head and tail:
            head_id = head.strip()
            if pack_ids is None or head_id in pack_ids:
                token = tail.strip()
                pack_ids = [head_id]

    if pack_ids:
        sources: list[dict] = []
        for pid in pack_ids:
            pack = _load_pack_v2_by_id(pid)
            cid = pack.resolve_char_id(token)
            if cid is None:
                continue
            tags_file = pack.tags_path(cid)
            sources.append(
                {
                    "pack_id": pid,
                    "pack": pack,
                    "char_id": cid,
                    "tags_file": tags_file,
                    "images_dir": tags_file.parent,
                }
            )
        if not sources:
            raise RuntimeError(f"未找到角色：{token}（pack={','.join(pack_ids)}）")
        # Prefer showing the first resolved id.
        return sources, sources[0]["char_id"]

    # No explicit pack: keep existing resolution behavior (ba pack-v2 -> legacy fallback).
    tags_file, images_dir, sid_for_title = _resolve_tags_file_and_images_dir_for_character(token)
    if load_pack_v2 is not None:
        # If pack-v2 ba hit, `_resolve_tags_file_and_images_dir_for_character` returns (tags_file, images_dir, char_id)
        # but we don't have the pack_id from it; infer it as "ba".
        if isinstance(sid_for_title, str):
            pack = _load_pack_v2_by_id("ba")
            return [
                {
                    "pack_id": "ba",
                    "pack": pack,
                    "char_id": sid_for_title,
                    "tags_file": tags_file,
                    "images_dir": images_dir,
                }
            ], sid_for_title

    # Legacy fallback: treat as a single source.
    return [
        {
            "pack_id": "legacy",
            "pack": None,
            "char_id": sid_for_title,
            "tags_file": tags_file,
            "images_dir": images_dir,
        }
    ], sid_for_title


def _find_name_map_and_avatar_dir() -> tuple[Path, Path]:
    name_map_path = Path("avatar/name_to_id.json")
    avatar_dir = Path("avatar")
    if not name_map_path.exists():
        candidate = Path.cwd() / "mmt_render" / "avatar" / "name_to_id.json"
        if candidate.exists():
            name_map_path = candidate
    if not avatar_dir.exists():
        candidate = Path.cwd() / "mmt_render" / "avatar"
        if candidate.exists():
            avatar_dir = candidate
    return name_map_path, avatar_dir


async def _send_onebot_images(bot: Bot, event: Event, png_paths: list[Path]) -> None:
    if V11MessageSegment is None or V11Message is None:
        raise RuntimeError("onebot v11 adapter is not available")

    def _img_seg(p: Path, *, use_uri: bool) -> object:
        if use_uri:
            return V11MessageSegment.image(file=p.resolve().as_uri())  # type: ignore[misc]
        return V11MessageSegment.image(file=str(p.resolve()))  # type: ignore[misc]

    async def _send_once(*, use_uri: bool) -> None:
        msg = V11Message()  # type: ignore[call-arg]
        for p in png_paths:
            msg.append(_img_seg(p, use_uri=use_uri))  # type: ignore[attr-defined]
        await bot.send(event=event, message=msg)

    async def _send_with_retry(*, use_uri: bool) -> None:
        try:
            await _send_once(use_uri=use_uri)
            return
        except Exception as exc:
            if V11ActionFailed is not None and isinstance(exc, V11ActionFailed):
                ret = getattr(exc, "retcode", None)
                if ret == 1200 or "Timeout" in str(exc):
                    await asyncio.sleep(0.8)
                    await _send_once(use_uri=use_uri)
                    return
            raise

    async def _send_seg_with_retry(seg: object) -> None:
        try:
            await bot.send(event=event, message=seg)
            return
        except Exception as exc:
            if V11ActionFailed is not None and isinstance(exc, V11ActionFailed):
                ret = getattr(exc, "retcode", None)
                if ret == 1200 or "Timeout" in str(exc):
                    await asyncio.sleep(0.8)
                    await bot.send(event=event, message=seg)
                    return
            raise

    try:
        await _send_with_retry(use_uri=True)
        return
    except Exception as exc1:
        try:
            await _send_with_retry(use_uri=False)
            return
        except Exception as exc2:
            logger.warning("send images failed (batch), fallback to sequential: %s | %s", exc1, exc2)

    delay = max(0, int(getattr(plugin_config, "mmt_send_delay_ms", 0) or 0)) / 1000.0
    for p in png_paths:
        try:
            await _send_seg_with_retry(_img_seg(p, use_uri=False))
        except Exception:
            await _send_seg_with_retry(_img_seg(p, use_uri=True))
        if delay:
            await asyncio.sleep(delay)

async def _upload_onebot_file(
    bot: Bot,
    event: Event,
    file_path: Path,
    *,
    file_name: Optional[str] = None,
    folder_id: Optional[str] = None,
) -> dict:
    p = file_path.resolve()
    if not p.exists():
        raise FileNotFoundError(f"file not found: {p}")
    name = (file_name or p.name).strip() or p.name

    group_id = getattr(event, "group_id", None)
    user_id = getattr(event, "user_id", None)
    if group_id is not None:
        return await bot.call_api(
            "upload_group_file",
            group_id=int(group_id),
            file=str(p),
            name=name,
            folder=folder_id,
        )
    if user_id is not None:
        return await bot.call_api(
            "upload_private_file",
            user_id=int(user_id),
            file=str(p),
            name=name,
        )
    raise ValueError("event type not supported for file upload")


def _sanitize_filename_component(s: str) -> str:
    s = (s or "").strip()
    if not s:
        return ""
    # Windows forbidden chars: \ / : * ? " < > | and control chars.
    s = re.sub(r'[\x00-\x1f<>:"/\\\\|?*]+', "_", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = s.strip(". ")
    return s


def _format_pdf_name(*, meta: dict, compiled_at: str, fallback: str) -> str:
    title = _sanitize_filename_component(str(meta.get("title") or "无题"))
    author = _sanitize_filename_component(str(meta.get("author") or ""))
    # Always include a time part to avoid unreadable random stems.
    ts = compiled_at.strip() or time.strftime("%Y-%m-%d %H:%M:%S")
    ts = _sanitize_filename_component(ts)

    parts = [p for p in (title, author, ts) if p]
    if not parts:
        parts = [_sanitize_filename_component(fallback) or "mmt"]
    name = "-".join(parts) + ".pdf"
    if len(name) > 160:
        name = name[:156] + ".pdf"
    return name


def _common_root(*paths: Path) -> Path:
    import os

    # Typst checks project root against the real/canonical file paths. If any of
    # these paths are symlinks, using `.absolute()` can yield a root that doesn't
    # actually contain the resolved targets and will trigger "outside of project root".
    resolved: list[str] = []
    for p in paths:
        try:
            resolved.append(str(p.resolve()))
        except Exception:
            resolved.append(str(p.absolute()))
    common = os.path.commonpath(resolved)
    return Path(common)


def _run_typst(
    *,
    typst_bin: str,
    template: Path,
    input_json: Path,
    out_path: Path,
    tags_root: Path,
    out_format: str,
    input_key: str = "chat",
    extra_inputs: Optional[dict[str, str]] = None,
) -> None:
    pack_v2_root = plugin_config.pack_v2_root_path()
    if pack_v2_root.exists():
        root = _common_root(template, input_json, out_path, tags_root, pack_v2_root)
    else:
        root = _common_root(template, input_json, out_path, tags_root)
    cwd = template.parent
    rel_in = Path(os.path.relpath(input_json.absolute(), start=cwd.absolute()))
    rel_out = Path(os.path.relpath(out_path.absolute(), start=cwd.absolute()))
    rel_tpl = Path(os.path.relpath(template.absolute(), start=cwd.absolute()))

    cmd = [
        typst_bin,
        "compile",
        str(rel_tpl).replace("\\", "/"),
        str(rel_out).replace("\\", "/"),
        "--format",
        out_format,
        *(
            ["--ppi", str(int(plugin_config.mmt_png_ppi))]
            if out_format.lower() == "png" and int(getattr(plugin_config, "mmt_png_ppi", 0) or 0) > 0
            else []
        ),
        "--root",
        str(root.absolute()).replace("\\", "/"),
        "--input",
        f"{input_key}={str(rel_in).replace('\\', '/')}",
    ]
    if extra_inputs:
        for k, v in extra_inputs.items():
            cmd.extend(["--input", f"{k}={v}"])

    if run_typst_sandboxed is not None and TypstSandboxOptions is not None:
        procgov_bin = (plugin_config.mmt_procgov_bin or "").strip() or None
        opts = TypstSandboxOptions(
            timeout_s=float(getattr(plugin_config, "mmt_typst_timeout_s", 30.0) or 30.0),
            max_mem_mb=int(getattr(plugin_config, "mmt_typst_maxmem_mb", 0) or 0) or None,
            rayon_threads=int(getattr(plugin_config, "mmt_typst_rayon_threads", 0) or 0) or None,
            procgov_bin=procgov_bin,
            enable_procgov=bool(getattr(plugin_config, "mmt_typst_enable_procgov", True)),
        )
        proc = run_typst_sandboxed(cmd, cwd=cwd, options=opts)
    else:
        proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"typst failed ({proc.returncode}):\n{proc.stderr or proc.stdout}")


def _safe_stem(text: str) -> str:
    return str(int(time.time() * 1000))


def _image_order_key(image_name: str) -> tuple[int, str]:
    s = (image_name or "").strip()
    stem = s.rsplit(".", 1)[0]
    nums = re.findall(r"\d+", stem)
    n = int(nums[-1]) if nums else -1
    return (n, s.lower())


def _asset_db_and_dir() -> tuple[Path, Path]:
    work = plugin_config.work_dir_path()
    db_path = work / "assets.sqlite3"
    asset_dir = plugin_config.asset_cache_dir_path()
    asset_dir.mkdir(parents=True, exist_ok=True)
    return db_path, asset_dir


def _state_db_path() -> Path:
    work = plugin_config.work_dir_path()
    work.mkdir(parents=True, exist_ok=True)
    return work / "state.sqlite3"


def _packs_from_data(data: object) -> dict[str, str]:
    """
    Returns alias -> pack_id mapping from mmt_text_to_json output.
    """
    if not isinstance(data, dict):
        return {}
    packs = data.get("packs")
    if not isinstance(packs, dict):
        return {}
    aliases = packs.get("aliases")
    if not isinstance(aliases, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in aliases.items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        kk = k.strip()
        vv = v.strip()
        if not kk or not vv:
            continue
        out[kk] = vv
    return out


def _enforce_pack_eulas_or_raise(*, data: dict, event: Event) -> None:
    """
    Enforce per-user EULA acceptance for @usepack packs.
    """
    if load_pack_v2 is None:
        return
    alias_to_pack = _packs_from_data(data)
    if not alias_to_pack:
        return
    private_id, _group_id = _event_scope_ids(event)
    if not private_id:
        return
    eula_db = EulaDB(_state_db_path())
    pack_root = plugin_config.pack_v2_root_path()
    for alias, pack_id in alias_to_pack.items():
        pid = validate_pack_id(pack_id)
        if pid == "ba":
            continue
        pack_path = (pack_root / pid).resolve()
        pack = load_pack_v2(pack_path)
        if not bool(getattr(pack.manifest, "eula_required", False)):
            continue
        if eula_db.is_accepted(user_id=private_id, pack_id=pid):
            continue
        title = (getattr(pack.manifest, "eula_title", "") or "").strip() or pid
        url = (getattr(pack.manifest, "eula_url", "") or "").strip()
        msg = f"需要先同意扩展包 EULA 才能使用：{pid}（alias={alias}, title={title}）"
        if url:
            msg += f"\nEULA: {url}"
        msg += f"\n同意后请发送：/mmt-pack accept {pid}"
        raise RuntimeError(msg)


def _event_scope_ids(event: Event) -> tuple[Optional[str], Optional[str]]:
    # private scope: always available if user_id exists
    uid = getattr(event, "user_id", None)
    private_id = str(uid) if uid is not None else None
    gid = getattr(event, "group_id", None)
    group_id = str(gid) if gid is not None else None
    return private_id, group_id


def _extract_onebot_reply_id(event: Event) -> Optional[int]:
    # OneBot v11: reply segment may exist in message.
    # NapCat may use CQ-code like `[reply:id=123]` in raw_message.
    try:
        msg = getattr(event, "get_message", None)
        if callable(msg):
            m = msg()
        else:
            m = getattr(event, "message", None)
        if m is None:
            m = None
        if m is not None:
            for seg in m:
                try:
                    if isinstance(seg, dict):
                        if seg.get("type") != "reply":
                            continue
                        data = seg.get("data") or {}
                        if isinstance(data, dict):
                            rid = data.get("id") or data.get("message_id")
                        else:
                            rid = seg.get("id") or seg.get("message_id")
                        if rid is not None:
                            return int(rid)
                    else:
                        if getattr(seg, "type", None) != "reply":
                            continue
                        data = getattr(seg, "data", None) or {}
                        rid = None
                        if isinstance(data, dict):
                            rid = data.get("id") or data.get("message_id")
                        if rid is not None:
                            return int(rid)
                except Exception:
                    continue
    except Exception:
        return None

    # Fallback: parse from raw_message CQ-code.
    raw = str(getattr(event, "raw_message", "") or "")
    m = re.search(r"\[(?:CQ:)?reply[:,]id=(\d+)\]", raw)
    if m:
        try:
            return int(m.group(1))
        except Exception:
            return None
    return None


def _first_image_url_from_message(msg: object) -> Optional[str]:
    try:
        for seg in msg:
            if getattr(seg, "type", None) != "image":
                continue
            data = getattr(seg, "data", None) or {}
            url = (data.get("url") or "").strip()
            if url:
                return url
    except Exception:
        return None
    return None


def _extract_image_from_cqcode(text: str) -> tuple[Optional[str], Optional[str]]:
    """
    Parse OneBot/NapCat CQ-like code string and return (url, file).
    """
    s = (text or "").strip()
    if not s:
        return None, None
    # Examples:
    # - [CQ:image,file=xxx,url=https://...]
    # - [image:summary=,file=xxx,url=https://...]
    m = re.search(r"\[(?:CQ:)?image(?::|,)([^\]]+)\]", s)
    if not m:
        return None, None
    params = m.group(1)
    url: Optional[str] = None
    file: Optional[str] = None
    for part in params.split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip()
        v = v.replace("&amp;", "&")
        if k == "url" and v:
            url = v
        if k == "file" and v:
            file = v
    return url, file


async def _get_image_url_from_file(bot: Bot, file_token: str) -> Optional[str]:
    ft = (file_token or "").strip()
    if not ft:
        return None
    try:
        ret = await bot.call_api("get_image", file=ft)
        if isinstance(ret, dict):
            url = str(ret.get("url") or "").strip()
            return url or None
    except Exception:
        return None
    return None


def _extract_file_from_cqcode(text: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Parse OneBot/NapCat CQ-like code string and return (url, file, name).
    Examples:
      - [CQ:file,file=...,url=...,name=...]
      - [file:file=...,url=...,name=...]
    """
    s = (text or "").strip()
    if not s:
        return None, None, None
    m = re.search(r"\[(?:CQ:)?file(?::|,)([^\]]+)\]", s)
    if not m:
        return None, None, None
    params = m.group(1)
    url: Optional[str] = None
    file: Optional[str] = None
    name: Optional[str] = None
    for part in params.split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k = k.strip()
        v = v.strip().replace("&amp;", "&")
        if k == "url" and v:
            url = v
        if k == "file" and v:
            file = v
        if k in {"name", "filename"} and v:
            name = v
    return url, file, name


async def _get_file_url_from_file(bot: Bot, file_token: str) -> Optional[str]:
    ft = (file_token or "").strip()
    if not ft:
        return None
    for api in ("get_file", "get_file_url"):
        try:
            ret = await bot.call_api(api, file=ft)
            if isinstance(ret, dict):
                url = str(ret.get("url") or "").strip()
                if url:
                    return url
        except Exception:
            continue
    return None


def _first_file_url_from_message(msg: object) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """
    Returns (url, file, name).
    """
    try:
        for seg in msg:
            if getattr(seg, "type", None) != "file":
                continue
            data = getattr(seg, "data", None) or {}
            url = (data.get("url") or "").strip()
            file = (data.get("file") or "").strip()
            name = (data.get("name") or data.get("filename") or "").strip()
            if url or file:
                return (url or None), (file or None), (name or None)
    except Exception:
        return None, None, None
    return None, None, None


async def _extract_text_file_url(bot: Bot, event: Event, arg_msg: object) -> tuple[str, Optional[str]]:
    # 1) file segments in command arg
    url, file, name = _first_file_url_from_message(arg_msg)
    if url:
        return url, name
    if file:
        url2 = await _get_file_url_from_file(bot, file)
        if url2:
            return url2, name

    # 2) file segments in the full message
    try:
        msg = getattr(event, "get_message", None)
        if callable(msg):
            url, file, name = _first_file_url_from_message(msg())
            if url:
                return url, name
            if file:
                url2 = await _get_file_url_from_file(bot, file)
                if url2:
                    return url2, name
    except Exception:
        pass

    # 3) replied message
    rid = _extract_onebot_reply_id(event)
    if rid is not None:
        try:
            ret = await bot.call_api("get_msg", message_id=int(rid))
            msg_val = ret.get("message")
            if isinstance(msg_val, str):
                url3, file3, name3 = _extract_file_from_cqcode(msg_val)
                if url3:
                    return url3, name3
                if file3:
                    url4 = await _get_file_url_from_file(bot, file3)
                    if url4:
                        return url4, name3
            elif isinstance(msg_val, list):
                for seg in msg_val:
                    if not isinstance(seg, dict):
                        continue
                    if seg.get("type") != "file":
                        continue
                    data = seg.get("data") or {}
                    if not isinstance(data, dict):
                        continue
                    url3 = str(data.get("url") or "").strip()
                    name3 = str(data.get("name") or data.get("filename") or "").strip() or None
                    if url3:
                        return url3, name3
                    file3 = str(data.get("file") or "").strip()
                    if file3:
                        url4 = await _get_file_url_from_file(bot, file3)
                        if url4:
                            return url4, name3
        except Exception:
            pass

    # 4) raw_message fallback: parse file CQ-code directly
    raw = str(getattr(event, "raw_message", "") or "")
    url5, file5, name5 = _extract_file_from_cqcode(raw)
    if url5:
        return url5, name5
    if file5:
        url6 = await _get_file_url_from_file(bot, file5)
        if url6:
            return url6, name5

    raise AssetError("no file found: attach a .txt file or reply to a file message")


async def _download_text_file(url: str, *, max_bytes: int = 1024 * 1024) -> bytes:
    from curl_cffi import requests as curl_requests

    u = (url or "").strip()
    if not (u.startswith("http://") or u.startswith("https://")):
        raise AssetError("only http/https url is allowed")
    async with curl_requests.AsyncSession() as s:
        s.headers.update({"User-Agent": "mmt-textfile/0.1"})
        resp = await s.get(u, timeout=30.0)
        if resp.status_code >= 400:
            raise AssetError(f"download HTTP {resp.status_code}")
        data = resp.content or b""
        if max_bytes > 0 and len(data) > max_bytes:
            raise AssetError(f"text file too large: {len(data)} bytes (max {max_bytes})")
        return data


def _decode_text_file(data: bytes) -> str:
    # Try UTF-8 first, then a common Chinese fallback.
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except Exception:
            continue
    # last resort
    return data.decode("utf-8", errors="replace")


async def _extract_image_url(bot: Bot, event: Event, arg_msg: object) -> str:
    # 1) Try image segments in command arg
    url = _first_image_url_from_message(arg_msg)
    if url:
        return url

    # 2) Try image segments in the full message
    try:
        msg = getattr(event, "get_message", None)
        if callable(msg):
            url2 = _first_image_url_from_message(msg())
            if url2:
                return url2
    except Exception:
        pass

    # 3) Try replied message (best UX)
    rid = _extract_onebot_reply_id(event)
    if rid is not None:
        try:
            ret = await bot.call_api("get_msg", message_id=int(rid))
            msg_val = ret.get("message")
            if isinstance(msg_val, str):
                url3, file3 = _extract_image_from_cqcode(msg_val)
                if url3:
                    return url3
                if file3:
                    url4 = await _get_image_url_from_file(bot, file3)
                    if url4:
                        return url4
            elif isinstance(msg_val, list):
                for seg in msg_val:
                    if not isinstance(seg, dict):
                        continue
                    if seg.get("type") != "image":
                        continue
                    data = seg.get("data") or {}
                    if not isinstance(data, dict):
                        continue
                    url3 = str(data.get("url") or "").strip()
                    if url3:
                        return url3
                    file3 = str(data.get("file") or "").strip()
                    if file3:
                        url4 = await _get_image_url_from_file(bot, file3)
                        if url4:
                            return url4
        except Exception:
            pass

    raise AssetError("no image found: attach an image or reply to an image message")


async def _render_syntax_help_pngs(*, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_stem("mmt-help-syntax")
    typ_path = out_dir / f"{stem}.mmt_help_syntax.typ"
    dummy_json = out_dir / f"{stem}.dummy.json"
    png_out_tpl = out_dir / f"{stem}-{{0p}}.png"

    dummy_json.write_text("{}", encoding="utf-8")
    typ_path.write_text(
        "\n".join(
            [
                """\
#show raw: set text(font: ("Cascadia Code","FZLanTingYuanGBK"))
#show raw.where(block: true): it => block(
  fill: luma(240),
  inset: 6pt,
  radius: 4pt,
  text(fill: black, it)
)""",
                "#set page(width: 168mm, height: auto, margin: (x: 10mm, y: 10mm))",
                "#set text(size: 10.5pt, font: \"FZLanTingYuanGBK\",lang:\"zh\")",
                "#set par(first-line-indent: (amount: 2em, all: true))",
                "",
                "= MomoScript",
                "MMT DSL 语法速览",
                "",
                r"== 头部指令（\@）",
                "- 只在文件开头解析，用于填写元信息或 Typst 全局代码",
                "- 形式：`@key: value`（value 为任意文本）",
                "- 常用：`@title` / `@author` / `@created_at`（会写入输出 JSON 的 `meta`）",
                "- 其它 `@key` 也会写入 `meta`（不与保留字段冲突即可）",
                "- Typst：`@typst_global: ...`（可配合 `\"\"\"...\"\"\"` 写多行块）",
                "- 资源：`@asset.<name>: <url|data:image/...>`（默认只允许外链或 data URL；resolve 后可在 Typst 模式用 `#asset_img(\"<name>\")` 引用）",
                "- 本地资源（可选）：加 `--allow-local-assets` 后，允许 `@asset.<name>: mmt_assets/xxx.png`（仅限白名单目录且必须是图片文件）",
                """- 备注：
  - `@typst: on|off` 只写入 `meta.typst`，实际解析模式以 `--typst` 为准
  - 文档中的 `...` 仅表示“任意内容占位”，不是语法的一部分；实际写法是 `@key: value`""",
                "",
                r"== 动态别名（\@alias）",
                "- 可出现在任意位置，仅修改显示名（不影响 id 查找；对后续气泡持续生效）",
                "- 语法：`@alias 角色名=显示名`（清空：`@alias 角色名=`）",
                "",
                r"== 临时别名（\@tmpalias）",
                "- 局部作用域显示名覆盖（切换到其它说话人后自动回退）",
                "- 语法：`@tmpalias 角色名=显示名`（清空：`@tmpalias 角色名=`）",
                "",
                r"== 别名 ID（\@aliasid / \@unaliasid）",
                "- 为说话人标记添加短 id，并映射到真实角色名（不影响头像/名称刷新）",
                "- 语法：`@aliasid <id> <角色名>` / `@unaliasid <id>`",
                "",
                r"== 自定义人物 ID（\@charid / \@uncharid）",
                "- 声明一个稳定的短 id 表示“非学生库角色”（避免被哈希化为 custom-xxxx）",
                "- 语法：`@charid <id> <显示名>` / `@uncharid <id>`",
                "",
                r"== 自定义头像（\@avatarid / \@unavatarid）",
                "- 绑定 `@asset.<name>` 为某个自定义人物（@charid）的头像",
                "- 语法：`@avatarid <id> <asset_name>` / `@unavatarid <id>`",
                "",
                r"== 标准库角色换头像（\@avatar）",
                "- 临时覆盖学生库（kivo）角色头像（仅对本次文本生效；依赖 @asset）",
                "- 语法：`@avatar <角色名>=<asset_name>`（清空：`@avatar <角色名>=`）",
                "",
                "== 语句行",
                "- `- `：旁白（居中系统文本）",
                "- `> `：对方气泡（默认左侧）",
                "- `< `：自己气泡（默认右侧；也可以写成其它角色的右侧气泡）",
                "",
                "== 续行",
                "不以 `- ` / `> ` / `< ` 开头的行会被视为上一条语句的续行（一般用 `\\\\n` 连接）。",
                "",
                '== 多行块（`"""..."""`）',
                '当内容以 `"""` 开头时进入多行块，直到遇到“单独一行”的 `"""` 结束。',
                "块内内容原样保留（推荐用于列表/公式/代码）。",
                "",
                "== 说话人",
                "`>` 与 `<` 可携带“说话人切换”标记：",
                "",
                "- 显式指定：`> {name}: {content}` 或 `< {name}: {content}`",
                "- 方向内回溯：`> _:` / `> _2:`（回到该方向历史的第 1/2 个说话人）",
                "- “第 i 个出现的人物”：`> ~1:`（从对话开始以来第 1 个新出现的说话人）",
                "",
                "== 表情/图片标记",
                "普通模式（未开启 `--typst`）：",
                "- `[描述]` / `[角色:描述]` / `(角色)[描述]`（会进入 rerank 解析）",
                "- `[asset:xxx]`（引用头部 `@asset.xxx`；需要 resolve 才能下载外链）",
                "",
                "Typst 模式（`--typst`）：",
                "- 只识别 `[:描述]` / `[:角色:描述]` / `(角色)[:描述]`",
                "- `[:asset:xxx]`（引用头部 `@asset.xxx`；需要 resolve 才能下载外链）",
                "- 其它 `[...]` 会原样交给 Typst（因此纯文本里的 `[`/`]` 可能需要转义）",
                "",
                "== 示例",
                "```text",
                "@title: 测试",
                "@author: (可省略，插件会自动填充)",
                "",
                "> 星野: 早上好",
                "> 续行（仍然是星野）",
                "@alias 星野=星野(一年级)",
                "> 1!",
                "@alias 星野=星野(临战)",
                "> 2!",
                "",
                "- \"\"\"",
                "#let fib(n) = if n <= 2 { 1 } else { fib(n - 1) + fib(n - 2) }",
                "#fib(10)",
                "\"\"\"",
                "",
                "> [:期待]",
                "```",
                "",
                'Tip：若开启 `--typst`，可以用 ``` """...""" ``` 在气泡里写 Typst 的原始代码块。',
            ]
        ),
        encoding="utf-8",
    )

    await asyncio.to_thread(
        _run_typst,
        typst_bin=plugin_config.mmt_typst_bin,
        template=typ_path,
        input_json=dummy_json,
        out_path=png_out_tpl,
        tags_root=out_dir,
        out_format="png",
        input_key="dummy",
        extra_inputs=None,
    )

    pngs = sorted(out_dir.glob(f"{stem}-*.png"), key=lambda p: p.name)
    if not pngs:
        single = out_dir / f"{stem}.png"
        if single.exists():
            return [single]
        raise RuntimeError("typst succeeded but no png output found")
    return pngs


async def _pipe_to_outputs(
    *,
    text: str,
    bot: Bot,
    event: Event,
    resolve: bool,
    strict: bool,
    ctx_n: int,
    image_scale: Optional[float],
    typst: bool,
    disable_heading: bool,
    no_time: bool,
    out_format: str,
    redownload_assets: bool,
    allow_local_assets: bool,
    asset_local_prefixes: Optional[str],
    out_dir: Path,
) -> tuple[list[Path], dict, dict, str, dict]:
    if mmt_text_to_json is None:
        raise RuntimeError("mmt_render.mmt_text_to_json is not importable in this environment")

    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_stem(text)
    json_path = out_dir / f"{stem}.json"
    resolved_path = out_dir / f"{stem}.resolved.json"
    out_format_norm = (out_format or "png").strip().lower()
    if out_format_norm not in {"png", "pdf"}:
        raise ValueError(f"unsupported format: {out_format}")
    out_path: Path = (
        (out_dir / f"{stem}-{{0p}}.png") if out_format_norm == "png" else (out_dir / f"{stem}.pdf")
    )

    # Parse text -> json
    t_start = time.perf_counter()
    t_parse0 = time.perf_counter()
    name_map_path, avatar_dir = _find_name_map_and_avatar_dir()

    name_map = mmt_text_to_json._load_name_to_id(name_map_path)
    data, _report = mmt_text_to_json.convert_text(
        text,
        name_to_id=name_map,
        avatar_dir=avatar_dir,
        join_with_newline=True,
        context_window=max(0, int(ctx_n)),
        typst_mode=bool(typst),
        pack_v2_root=plugin_config.pack_v2_root_path(),
    )
    t_parse1 = time.perf_counter()

    # Inject per-user/private and per-group assets into meta (default lookup order: p > g).
    t_inj0 = time.perf_counter()
    try:
        private_id, group_id = _event_scope_ids(event)
        if private_id or group_id:
            db_path, asset_dir = _asset_db_and_dir()
            db = AssetDB(db_path)
            p_assets = db.list_names(scope="p", scope_id=private_id) if private_id else []
            g_assets = db.list_names(scope="g", scope_id=group_id) if group_id else []
            if isinstance(data, dict):
                meta0 = data.get("meta")
                meta0 = meta0 if isinstance(meta0, dict) else {}
                data["meta"] = merge_asset_meta(meta=meta0, private_assets=p_assets, group_assets=g_assets, prefer_private=True)
    except Exception:
        # Asset injection is best-effort; do not fail rendering.
        pass
    t_inj1 = time.perf_counter()

    # Enforce EULA for @usepack packs (per-user acceptance).
    if isinstance(data, dict):
        _enforce_pack_eulas_or_raise(data=data, event=event)

    json_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    meta = data.get("meta") if isinstance(data, dict) else None
    meta = meta if isinstance(meta, dict) else {}

    chat_for_render = json_path
    resolve_stats: dict = {"unresolved": 0, "errors": [], "asset_errors": 0, "avatar_errors": 0, "asset_error_examples": []}
    if resolve:
        t_resolve0 = time.perf_counter()
        if resolve_file is None:
            raise RuntimeError("mmt_render.resolve_expressions.resolve_file is not importable in this environment")
        tags_root = plugin_config.tags_root_path()
        template = plugin_config.typst_template_path()
        await resolve_file(
            input_path=json_path,
            output_path=resolved_path,
            tags_root=tags_root,
            pack_v2_root=plugin_config.pack_v2_root_path(),
            ref_root=template.parent,
            model=plugin_config.mmt_rerank_model,
            api_key_env=plugin_config.mmt_rerank_key_env,
            concurrency=plugin_config.mmt_rerank_concurrency,
            strict=bool(strict),
            asset_cache_dir=plugin_config.asset_cache_dir_path(),
            redownload_assets=bool(redownload_assets or getattr(plugin_config, "mmt_asset_redownload", False)),
            asset_max_mb=int(getattr(plugin_config, "mmt_asset_max_mb", 10) or 10),
            allow_local_assets=bool(allow_local_assets or getattr(plugin_config, "mmt_asset_allow_local", False)),
            asset_local_prefixes=(
                [x.strip() for x in str(asset_local_prefixes or "").split(",") if x.strip()]
                if asset_local_prefixes
                else plugin_config.asset_local_prefixes_list()
            ),
        )
        chat_for_render = resolved_path
        try:
            resolved_data = json.loads(resolved_path.read_text(encoding="utf-8"))
            chat = resolved_data.get("chat") if isinstance(resolved_data, dict) else None
            if isinstance(chat, list):
                for line in chat:
                    if not isinstance(line, dict):
                        continue
                    segs = line.get("segments")
                    if not isinstance(segs, list):
                        continue
                    for seg in segs:
                        if not isinstance(seg, dict):
                            continue
                        if seg.get("type") == "expr":
                            resolve_stats["unresolved"] += 1
                            err = seg.get("error")
                            if isinstance(err, str) and err and len(resolve_stats["errors"]) < 5:
                                resolve_stats["errors"].append(err)
                        if seg.get("type") == "asset":
                            err = seg.get("error")
                            if isinstance(err, str) and err:
                                resolve_stats["asset_errors"] += 1
                                if len(resolve_stats["asset_error_examples"]) < 5:
                                    resolve_stats["asset_error_examples"].append(err)
                    if isinstance(line.get("avatar_override_error"), str) and line.get("avatar_override_error"):
                        resolve_stats["avatar_errors"] += 1
        except Exception:
            pass
        t_resolve1 = time.perf_counter()
    else:
        t_resolve0 = t_resolve1 = time.perf_counter()

    # Render png(s) via typst (blocking)
    tags_root = plugin_config.tags_root_path()
    template = plugin_config.typst_template_path()
    if not template.is_absolute():
        template = (Path.cwd() / template).resolve()
    if not template.exists():
        # Fallback: common locations in a repo checkout
        for cand in (
            Path.cwd() / "mmt_render" / "mmt_render.typ",
            Path.cwd() / "mmt_render.typ",
        ):
            if cand.exists():
                template = cand.resolve()
                break
    if not template.exists():
        raise RuntimeError(f"typst template not found: {template}")

    if not tags_root.is_absolute():
        tags_root = (Path.cwd() / tags_root).resolve()
    compiled_at = "" if no_time else time.strftime("%Y-%m-%d %H:%M:%S")
    t_render0 = time.perf_counter()
    await asyncio.to_thread(
        _run_typst,
        typst_bin=plugin_config.mmt_typst_bin,
        template=template,
        input_json=chat_for_render,
        out_path=out_path,
        tags_root=tags_root,
        out_format=out_format_norm,
        input_key="chat",
        extra_inputs={
            **(
                {"image_scale": str(float(image_scale))}
                if image_scale is not None and image_scale > 0
                else {}
            ),
            **({"typst_mode": "1"} if typst else {}),
            **({"disable_heading": "1"} if disable_heading else {}),
            **({} if no_time else {"compiled_at": compiled_at}),
        }
        or None,
    )
    t_render1 = time.perf_counter()

    timings: dict = {
        "parse_ms": int((t_parse1 - t_parse0) * 1000),
        "asset_inject_ms": int((t_inj1 - t_inj0) * 1000),
        "resolve_ms": int((t_resolve1 - t_resolve0) * 1000),
        "render_ms": int((t_render1 - t_render0) * 1000),
        "total_ms": int((t_render1 - t_start) * 1000),
    }

    if out_format_norm == "pdf":
        if out_path.exists():
            return [out_path], resolve_stats, meta, compiled_at, timings
        raise RuntimeError("typst succeeded but no pdf output found")

    pngs = sorted(out_dir.glob(f"{stem}-*.png"), key=lambda p: p.name)
    if not pngs:
        single = out_dir / f"{stem}.png"
        if single.exists():
            return [single], resolve_stats, meta, compiled_at, timings
        raise RuntimeError("typst succeeded but no png output found")
    return pngs, resolve_stats, meta, compiled_at, timings


def _parse_flags(text: str, *, default_format: str) -> tuple[dict, str]:
    # Keep user's newlines in body; only strip leading CLI flags.
    s = text.strip()
    resolve = True
    strict = False
    ctx_n: Optional[int] = None
    image_scale: Optional[float] = None
    typst: bool = False
    disable_heading: bool = False
    no_time: bool = False
    out_format: str = (default_format or "png").strip().lower()
    redownload_assets: bool = False
    allow_local_assets: bool = False
    asset_local_prefixes: Optional[str] = None
    from_file: bool = False
    verbose: bool = False
    show_help: bool = False
    help_mode: Optional[str] = None

    while True:
        s = s.lstrip()
        if s == "help" or s.startswith("help "):
            show_help = True
            s = s[len("help") :]
            continue
        if s == "--help" or s.startswith("--help "):
            show_help = True
            s = s[len("--help") :]
            continue
        if s == "-h" or s.startswith("-h "):
            show_help = True
            s = s[len("-h") :]
            continue
        if s == "-t" or s.startswith("-t "):
            typst = True
            s = s[len("-t") :]
            continue
        if s.startswith("--typst"):
            typst = True
            s = s[len("--typst") :]
            continue
        if s.startswith("--disable-heading"):
            disable_heading = True
            s = s[len("--disable-heading") :]
            continue
        if s.startswith("--disable_heading"):
            disable_heading = True
            s = s[len("--disable_heading") :]
            continue
        if s.startswith("--no-time"):
            no_time = True
            s = s[len("--no-time") :]
            continue
        if s.startswith("--no_time"):
            no_time = True
            s = s[len("--no_time") :]
            continue
        if s.startswith("--redownload-assets"):
            redownload_assets = True
            s = s[len("--redownload-assets") :]
            continue
        if s.startswith("--redownload_assets"):
            redownload_assets = True
            s = s[len("--redownload_assets") :]
            continue
        if s.startswith("--file"):
            from_file = True
            s = s[len("--file") :]
            continue
        if s.startswith("--from-file"):
            from_file = True
            s = s[len("--from-file") :]
            continue
        if s.startswith("--from_file"):
            from_file = True
            s = s[len("--from_file") :]
            continue
        if s.startswith("--allow-local-assets"):
            allow_local_assets = True
            s = s[len("--allow-local-assets") :]
            continue
        if s.startswith("--allow_local_assets"):
            allow_local_assets = True
            s = s[len("--allow_local_assets") :]
            continue
        m = re.match(r"^--asset-local-prefixes(?:=|\s+)([^\\s]+)", s)
        if m:
            asset_local_prefixes = str(m.group(1)).strip()
            s = s[m.end() :]
            continue
        if s.startswith("--pdf"):
            out_format = "pdf"
            s = s[len("--pdf") :]
            continue
        if s.startswith("--png"):
            out_format = "png"
            s = s[len("--png") :]
            continue
        m = re.match(r"^--format(?:=|\s+)(png|pdf)(?=\s|$)", s, flags=re.IGNORECASE)
        if m:
            out_format = m.group(1).lower()
            s = s[m.end() :]
            continue
        if s.startswith("--no-resolve"):
            resolve = False
            s = s[len("--no-resolve") :]
            continue
        if s.startswith("--noresolve"):
            resolve = False
            s = s[len("--noresolve") :]
            continue
        if s.startswith("--resolve"):
            resolve = True
            s = s[len("--resolve") :]
            continue
        if s.startswith("--strict"):
            strict = True
            s = s[len("--strict") :]
            continue
        if s.startswith("--verbose"):
            verbose = True
            s = s[len("--verbose") :]
            continue
        if s == "-v" or s.startswith("-v "):
            verbose = True
            s = s[len("-v") :]
            continue
        m = re.match(r"^--image(?:_|-)scale(?:=|\s+)([0-9]*\.?[0-9]+)", s)
        if m:
            try:
                image_scale = float(m.group(1))
            except Exception:
                image_scale = None
            s = s[m.end() :]
            continue
        m = re.match(r"^--ctx-n(?:=|\s+)(\d+)", s)
        if m:
            ctx_n = int(m.group(1))
            s = s[m.end() :]
            continue
        break

    if show_help:
        ss = s.lstrip()
        m = re.match(r"^(syntax|dsl)(?:\\s+|$)", ss, flags=re.IGNORECASE)
        if m:
            help_mode = "syntax"
            s = ss[m.end() :]

    cfg = {
        "resolve": resolve,
        "strict": strict,
        "ctx_n": plugin_config.mmt_ctx_n if ctx_n is None else int(ctx_n),
        "image_scale": image_scale,
        "typst": typst,
        "disable_heading": disable_heading,
        "no_time": no_time,
        "out_format": out_format,
        "redownload_assets": redownload_assets,
        "allow_local_assets": allow_local_assets,
        "asset_local_prefixes": asset_local_prefixes,
        "from_file": from_file,
        "verbose": verbose,
        "help": show_help,
        "help_mode": help_mode,
    }
    return cfg, s.lstrip("\r\n ")


def _extract_invoker_name(event: Event) -> Optional[str]:
    try:
        fn = getattr(event, "get_user_name", None)
        if callable(fn):
            name = fn()
            if isinstance(name, str) and name.strip():
                return name.strip()
    except Exception:
        pass

    sender = getattr(event, "sender", None)
    if isinstance(sender, dict):
        name = (sender.get("card") or sender.get("nickname") or "").strip()
        if name:
            return name
    elif sender is not None:
        try:
            card = getattr(sender, "card", None)
            nickname = getattr(sender, "nickname", None)
            name = (str(card or nickname or "")).strip()
            if name:
                return name
        except Exception:
            pass

    try:
        fn = getattr(event, "get_user_id", None)
        if callable(fn):
            uid = fn()
            if isinstance(uid, str) and uid.strip():
                return uid.strip()
    except Exception:
        pass

    uid = getattr(event, "user_id", None)
    if uid is not None:
        s = str(uid).strip()
        if s:
            return s

    return None


def _inject_author_if_missing(text: str, author: Optional[str]) -> str:
    if not author:
        return text

    # Only consider the header region (before the first statement line).
    for line in text.splitlines():
        s = line.lstrip()
        if s.startswith(("- ", "> ", "< ")):
            break
        if re.match(r"^@author\\s*:", s):
            return text

    return f"@author: {author}\n{text}"


mmt = on_command("mmt", priority=10, block=True)
mmtpdf = on_command("mmtpdf", priority=10, block=True)
mmt_pack = on_command("mmt-pack", aliases={"mmtpack", "mmt_pack"}, priority=10, block=True)
mmt_img = on_command("mmt-img", aliases={"mmtimg", "mmt_img"}, priority=10, block=True)
mmt_imgmatch = on_command("mmt-imgmatch", aliases={"mmtimgmatch", "mmt_imgmatch"}, priority=10, block=True)
mmt_asset = on_command("mmt-asset", aliases={"mmtasset", "mmt_asset"}, priority=10, block=True)

async def _handle_mmt_common(
    *,
    matcher_name: str,
    bot: Bot,
    event: Event,
    raw: str,
    arg_msg: object,
    default_format: str,
) -> None:
    t_total0 = time.perf_counter()
    if not raw:
        if matcher_name == "mmtpdf":
            await mmtpdf.finish("请在指令后粘贴 MMT 文本，例如：/mmtpdf <内容>（默认会 resolve；默认输出 pdf）")
        await mmt.finish("请在指令后粘贴 MMT 文本，例如：/mmt <内容>（默认会 resolve）")

    flags, content = _parse_flags(raw, default_format=default_format)
    if flags.get("help"):
        if flags.get("help_mode") == "syntax":
            out_dir = plugin_config.work_dir_path()
            try:
                png_paths = await _render_syntax_help_pngs(out_dir=out_dir)
            except Exception as exc:
                logger.exception("render syntax help failed: %s", exc)
                if matcher_name == "mmtpdf":
                    await mmtpdf.finish(f"生成语法帮助失败：{exc}")
                await mmt.finish(f"生成语法帮助失败：{exc}")

            if V11MessageSegment is None or V11Message is None:
                if matcher_name == "mmtpdf":
                    await mmtpdf.finish(f"已生成：{png_paths[0]}")
                await mmt.finish(f"已生成：{png_paths[0]}")

            await _send_onebot_images(bot, event, png_paths)
            if matcher_name == "mmtpdf":
                await mmtpdf.finish()
            await mmt.finish()

        help_text = "\n".join(
            [
                f"用法：/{matcher_name} [flags] <MMT文本>（默认会 resolve）",
                "",
                "输出格式：",
                f"- --png：输出 PNG（默认：/mmt）",
                f"- --pdf：输出 PDF（默认：/mmtpdf）",
                "- --format <png|pdf>：同上",
                "- --redownload-assets：外链图片/asset 强制重新下载",
                "",
                "常用 flags：",
                "- --no-resolve：不做表情/图片推断",
                "- --resolve：强制开启 resolve",
                "- --strict：resolve 失败直接报错",
                "- --verbose / -v：输出各阶段用时信息",
                "- --typst / -t：文本按 Typst markup 渲染（表情标记仅识别 '[:...]'）",
                "- --image-scale <0.1-1.0>：气泡内图片缩放",
                f"- --ctx-n <N>：'[图片]' 使用的上下文窗口大小（默认 {plugin_config.mmt_ctx_n}）",
                "- --disable-heading：关闭标题栏",
                "- --no-time：不自动填充编译时间",
                "- --redownload-assets：强制重新下载外链图片",
                "- --allow-local-assets：允许 @asset.* 引用本地图片（受前缀白名单限制）",
                "- --asset-local-prefixes <a,b,c>：本地 @asset.* 允许的一级目录（默认 mmt_assets）",
                "",
                "其他指令：",
                "- /mmt-img <角色名>：列出该角色库内所有表情",
                "- /mmt-imgmatch <角色名> [--top-n=5] <描述>：语义匹配表情",
                "- /mmt -h syntax：渲染 DSL 语法速览图",
                "- /mmt --file：从“回复的 .txt 文件”读取 MMT 文本（解决超长输入）",
            ]
        )
        if matcher_name == "mmtpdf":
            await mmtpdf.finish(help_text)
        await mmt.finish(help_text)

    if not content and not bool(flags.get("from_file")):
        if matcher_name == "mmtpdf":
            await mmtpdf.finish("未检测到正文内容（参数后需要跟 MMT 文本）。")
        await mmt.finish("未检测到正文内容（参数后需要跟 MMT 文本）。")

    file_read_ms = 0
    if bool(flags.get("from_file")):
        t_file0 = time.perf_counter()
        try:
            url, fname = await _extract_text_file_url(bot, event, arg_msg)
            data = await _download_text_file(url, max_bytes=2 * 1024 * 1024)
            file_text = _decode_text_file(data)
        except Exception as exc:
            if matcher_name == "mmtpdf":
                await mmtpdf.finish(f"读取文本文件失败：{exc}")
            await mmt.finish(f"读取文本文件失败：{exc}")
        file_read_ms = int((time.perf_counter() - t_file0) * 1000)
        # Allow optional prefix content after flags (useful for overriding @title/@author etc).
        content = (content.rstrip() + "\n" + file_text) if content.strip() else file_text

    content = _inject_author_if_missing(content, _extract_invoker_name(event))

    out_dir = plugin_config.work_dir_path()
    try:
        out_paths, resolve_stats, meta, compiled_at, timings = await _pipe_to_outputs(
            text=content,
            bot=bot,
            event=event,
            resolve=flags["resolve"],
            strict=flags["strict"],
            ctx_n=flags["ctx_n"],
            image_scale=flags.get("image_scale"),
            typst=bool(flags.get("typst")),
            disable_heading=bool(flags.get("disable_heading")),
            no_time=bool(flags.get("no_time")),
            out_format=str(flags.get("out_format") or default_format),
            redownload_assets=bool(flags.get("redownload_assets")),
            allow_local_assets=bool(flags.get("allow_local_assets")),
            asset_local_prefixes=flags.get("asset_local_prefixes"),
            out_dir=out_dir,
        )
    except subprocess.CalledProcessError as exc:
        logger.exception("typst failed: %s", exc)
        if matcher_name == "mmtpdf":
            await mmtpdf.finish(f"Typst 渲染失败：{exc}")
        await mmt.finish(f"Typst 渲染失败：{exc}")
    except Exception as exc:
        logger.exception("mmt pipe failed: %s", exc)
        if matcher_name == "mmtpdf":
            await mmtpdf.finish(f"处理失败：{exc}")
        await mmt.finish(f"处理失败：{exc}")

    out_format_norm = str(flags.get("out_format") or default_format).strip().lower()
    if out_format_norm == "pdf":
        pdf_path = out_paths[0]
        upload_name = _format_pdf_name(meta=meta, compiled_at=compiled_at, fallback=pdf_path.stem)
        upload_ms = 0
        try:
            t_up0 = time.perf_counter()
            await _upload_onebot_file(bot, event, pdf_path, file_name=upload_name)
            upload_ms = int((time.perf_counter() - t_up0) * 1000)
        except Exception as exc:
            logger.warning("upload pdf failed: %s", exc)
            if matcher_name == "mmtpdf":
                await mmtpdf.finish(f"已生成：{pdf_path}（上传失败：{exc}）")
            await mmt.finish(f"已生成：{pdf_path}（上传失败：{exc}）")

        msg = ""
        if flags["resolve"] and int(resolve_stats.get("unresolved") or 0) > 0:
            msg += f"\n注意：仍有 {resolve_stats['unresolved']} 处表情未解析（通常是找不到对应学生的 tags.json 或图片文件）。"
            errs = resolve_stats.get("errors") or []
            if errs:
                msg += "\n示例错误：" + "; ".join(str(x) for x in errs)
            msg += "\n可用 `--strict` 让其直接报错定位。"
        if bool(flags.get("verbose")) and isinstance(timings, dict):
            parts = []
            if file_read_ms:
                parts.append(f"file={file_read_ms}ms")
            parts.extend(
                [
                    f"parse={timings.get('parse_ms', 0)}ms",
                    f"asset_inject={timings.get('asset_inject_ms', 0)}ms",
                    f"resolve={timings.get('resolve_ms', 0)}ms",
                    f"render={timings.get('render_ms', 0)}ms",
                ]
            )
            if upload_ms:
                parts.append(f"upload={upload_ms}ms")
            parts.append(f"total={int((time.perf_counter() - t_total0) * 1000)}ms")
            msg += ("\n" if msg else "") + "用时：" + ", ".join(parts)
        if matcher_name == "mmtpdf":
            await mmtpdf.finish(msg if msg else None)
        await mmt.finish(msg if msg else None)

    # PNG: For OneBot v11/NapCat, sending images is more compatible than sending PDFs.
    if V11MessageSegment is None or V11Message is None:
        if matcher_name == "mmtpdf":
            await mmtpdf.finish(f"已生成图片：{out_paths[0]}")
        await mmt.finish(f"已生成图片：{out_paths[0]}")

    t_send0 = time.perf_counter()
    await _send_onebot_images(bot, event, out_paths)
    send_ms = int((time.perf_counter() - t_send0) * 1000)
    msg = ""
    if flags["resolve"] and int(resolve_stats.get("unresolved") or 0) > 0:
        msg += f"\n注意：仍有 {resolve_stats['unresolved']} 处表情未解析（通常是找不到对应学生的 tags.json 或图片文件）。"
        errs = resolve_stats.get("errors") or []
        if errs:
            msg += "\n示例错误：" + "; ".join(str(x) for x in errs)
        msg += "\n可用 `--strict` 让其直接报错定位。"
    if flags["resolve"] and int(resolve_stats.get("asset_errors") or 0) > 0:
        msg += f"\n注意：有 {resolve_stats['asset_errors']} 处资源未找到（通常是 asset 名写错或未上传）。"
        ex = resolve_stats.get("asset_error_examples") or []
        if ex:
            msg += "\n示例错误：" + "; ".join(str(x) for x in ex)
    if flags["resolve"] and int(resolve_stats.get("avatar_errors") or 0) > 0:
        msg += f"\n注意：有 {resolve_stats['avatar_errors']} 处头像覆盖未生效（asset 名可能写错）。"
    if bool(flags.get("verbose")) and isinstance(timings, dict):
        parts = []
        if file_read_ms:
            parts.append(f"file={file_read_ms}ms")
        parts.extend(
            [
                f"parse={timings.get('parse_ms', 0)}ms",
                f"asset_inject={timings.get('asset_inject_ms', 0)}ms",
                f"resolve={timings.get('resolve_ms', 0)}ms",
                f"render={timings.get('render_ms', 0)}ms",
                f"send={send_ms}ms",
                f"total={int((time.perf_counter() - t_total0) * 1000)}ms",
            ]
        )
        msg += ("\n" if msg else "") + "用时：" + ", ".join(parts)
    if matcher_name == "mmtpdf":
        await mmtpdf.finish(msg if msg else None)
    await mmt.finish(msg if msg else None)


@mmtpdf.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    raw = arg.extract_plain_text().strip()
    await _handle_mmt_common(matcher_name="mmtpdf", bot=bot, event=event, raw=raw, arg_msg=arg, default_format="pdf")


@mmt.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    raw = arg.extract_plain_text().strip()
    await _handle_mmt_common(matcher_name="mmt", bot=bot, event=event, raw=raw, arg_msg=arg, default_format="png")


@mmt_pack.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    raw = arg.extract_plain_text().strip()
    if not raw:
        await mmt_pack.finish("用法：/mmt-pack list | /mmt-pack accept <pack_id>")

    parts = raw.split()
    cmd = parts[0].lower()
    rest = parts[1:] if len(parts) > 1 else []

    private_id, _group_id = _event_scope_ids(event)
    if not private_id:
        await mmt_pack.finish("无法获取用户 id，无法记录 EULA 同意状态。")

    if cmd == "accept":
        if not rest:
            await mmt_pack.finish("用法：/mmt-pack accept <pack_id>")
        pid = validate_pack_id(rest[0])
        EulaDB(_state_db_path()).accept(user_id=private_id, pack_id=pid)
        await mmt_pack.finish(f"已记录同意：{pid}")

    if cmd == "list":
        if load_pack_v2 is None:
            await mmt_pack.finish("pack-v2 loader 不可用。")
        root = plugin_config.pack_v2_root_path()
        if not root.exists():
            await mmt_pack.finish(f"pack-v2 根目录不存在：{root}")
        eula_db = EulaDB(_state_db_path())
        lines: list[str] = []
        for d in sorted([p for p in root.iterdir() if p.is_dir()], key=lambda p: p.name.lower()):
            try:
                pack = load_pack_v2(d)
            except Exception as exc:
                # In this test-phase command, show invalid packs to help debugging.
                lines.append(f"- {d.name} (invalid) - error: {exc}")
                continue
            pid = pack.manifest.pack_id
            req = "EULA" if pack.manifest.eula_required else "-"
            acc = (
                "accepted"
                if (not pack.manifest.eula_required or eula_db.is_accepted(user_id=private_id, pack_id=pid))
                else "not-accepted"
            )
            lines.append(f"- {pid} ({pack.manifest.type}) {req} {acc}")
        await mmt_pack.finish("\n".join(lines) if lines else "未找到可用 pack。")

    await mmt_pack.finish("未知子命令。用法：/mmt-pack list | /mmt-pack accept <pack_id>")


@mmt_img.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    name = arg.extract_plain_text().strip()
    if not name:
        await mmt_img.finish("用法：/mmt-img <角色名>")

    if mmt_text_to_json is None:
        await mmt_img.finish("mmt_render.mmt_text_to_json 无法导入，无法解析角色名。")

    try:
        tags_file, images_dir, sid_for_title = _resolve_tags_file_and_images_dir_for_character(name)
    except Exception as exc:
        await mmt_img.finish(str(exc))
    if not tags_file.exists():
        await mmt_img.finish(f"该角色没有 tags.json：{tags_file}")

    try:
        raw = json.loads(tags_file.read_text(encoding="utf-8"))
    except Exception as exc:
        await mmt_img.finish(f"tags.json 解析失败：{exc}")
    if not isinstance(raw, list) or not raw:
        await mmt_img.finish("tags.json 为空。")
    raw = sorted(
        raw,
        key=lambda it: _image_order_key(str(it.get("image_name") or "")) if isinstance(it, dict) else (10**9, ""),
    )

    out_dir = plugin_config.work_dir_path()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_stem(name)
    data_json = out_dir / f"{stem}.mmt_img.json"
    png_out_tpl = out_dir / f"{stem}.mmt_img-{{0p}}.png"

    template = Path(__file__).with_name("mmt_img.typ").resolve()
    if not template.exists():
        await mmt_img.finish(f"typst 模板不存在：{template}")

    items = []
    # Use project-root absolute paths (`/...`) so Typst resolves them against `--root`
    # instead of relative to the template directory. This avoids `..` escaping issues.
    pack_v2_root = plugin_config.pack_v2_root_path()
    root_for_paths = _common_root(
        template,
        data_json,
        png_out_tpl,
        images_dir,
        pack_v2_root if pack_v2_root.exists() else images_dir,
    )
    for it in raw:
        if not isinstance(it, dict):
            continue
        image_name = str(it.get("image_name") or "")
        if not image_name:
            continue
        img_abs = (images_dir / image_name)
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
        items.append({"img_path": img_rel, "tags": tags, "description": desc})

    data_json.write_text(
        json.dumps({"character": name, "student_id": sid_for_title, "items": items}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    try:
        await asyncio.to_thread(
            _run_typst,
            typst_bin=plugin_config.mmt_typst_bin,
            template=template,
            input_json=data_json,
            out_path=png_out_tpl,
            tags_root=images_dir,
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
        await mmt_img.finish(
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
        await mmt_img.finish("Typst 渲染成功但没找到输出图片。")

    try:
        await _send_onebot_images(bot, event, pngs)
    except Exception as exc:
        await mmt_img.finish(f"已生成：{pngs[0]}（发送失败：{exc}）")

    await mmt_img.finish(f"已发送 {len(pngs)} 张表格图（共 {len(items)} 条记录）。")


def _doc_text_for_rerank(item: dict) -> str:
    tags = item.get("tags") if isinstance(item.get("tags"), list) else []
    tags = [str(x) for x in tags if isinstance(x, str)]
    desc = str(item.get("description") or "")
    img = str(item.get("image_name") or "")
    tags_txt = ", ".join(tags[:32])
    if tags_txt:
        return f"{desc}\nTags: {tags_txt}\nFile: {img}"
    return f"{desc}\nFile: {img}"


def _parse_imgmatch_args(text: str) -> tuple[str, int, str]:
    # Back-compat helper (pack arg is ignored).
    _packs, name, top_n, desc = _parse_imgmatch_args_v2(text)
    return name, top_n, desc


def _parse_imgmatch_args_v2(text: str) -> tuple[Optional[list[str]], str, int, str]:
    """
    Parses:
      [--pack ba,ba_extpack] <character_name> [--top-n=5] <description...>
    Options can appear in any position.

    Returns: (pack_ids, character_name, top_n, description)
    """
    s = (text or "").strip()
    if not s:
        raise ValueError("missing args")
    tokens = s.split()
    opts, remain = _parse_opts_tokens(tokens)
    packs = opts.get("packs")
    top_n = int(opts.get("top_n") or 5)

    if not remain:
        raise ValueError("missing args")
    name = remain[0].strip()
    desc = " ".join(remain[1:]).strip()
    if not desc:
        raise ValueError("missing description")
    return packs, name, top_n, desc


@mmt_imgmatch.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    raw = arg.extract_plain_text().strip()
    try:
        packs, name, top_n, query = _parse_imgmatch_args_v2(raw)
    except Exception:
        await mmt_imgmatch.finish("用法：/mmt-imgmatch [--pack ba,ba_extpack] <角色名> [--top-n=5] <描述>")

    if mmt_text_to_json is None:
        await mmt_imgmatch.finish("mmt_render.mmt_text_to_json 无法导入，无法解析角色名。")
    if SiliconFlowRerankConfig is None or SiliconFlowReranker is None:
        await mmt_imgmatch.finish("mmt_render.siliconflow_rerank 无法导入，无法使用 reranker。")

    # Resolve sources (support multiple packs)
    try:
        sources, sid_for_title = _resolve_pack_v2_sources_for_character(name=name, pack_ids=packs)
    except Exception as exc:
        await mmt_imgmatch.finish(str(exc))

    # EULA gate (best-effort)
    private_id, _group_id = _event_scope_ids(event)
    if private_id:
        eula_db = EulaDB(_state_db_path())
        for src in sources:
            pid = str(src.get("pack_id") or "")
            pack = src.get("pack")
            if pack is None:
                continue
            if pack.manifest.eula_required and not eula_db.is_accepted(user_id=private_id, pack_id=pid):
                await mmt_imgmatch.finish(f"该包需要先同意 EULA：{pid}\n同意后请发送：/mmt-pack accept {pid}")

    docs: list[str] = []
    entries: list[dict] = []
    for src in sources:
        pid = str(src.get("pack_id") or "")
        tags_file = src.get("tags_file")
        images_dir = src.get("images_dir")
        if not isinstance(tags_file, Path) or not isinstance(images_dir, Path):
            continue
        if not tags_file.exists():
            await mmt_imgmatch.finish(f"该角色没有 tags.json：{tags_file}")
        try:
            raw_items = json.loads(tags_file.read_text(encoding="utf-8"))
        except Exception as exc:
            await mmt_imgmatch.finish(f"tags.json 解析失败：{exc}")
        if not isinstance(raw_items, list) or not raw_items:
            continue
        raw_items = sorted(
            [x for x in raw_items if isinstance(x, dict)],
            key=lambda it: _image_order_key(str(it.get("image_name") or "")),
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
        await mmt_imgmatch.finish("tags.json 没有有效条目（缺 image_name）。")

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
        await mmt_imgmatch.finish(f"rerank 失败：{exc}")

    # Prepare typst data
    out_dir = plugin_config.work_dir_path()
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_stem(name + query)
    data_json = out_dir / f"{stem}.mmt_imgmatch.json"
    png_out_tpl = out_dir / f"{stem}.mmt_imgmatch-{{0p}}.png"

    template = Path(__file__).with_name("mmt_imgmatch.typ").resolve()
    if not template.exists():
        await mmt_imgmatch.finish(f"typst 模板不存在：{template}")

    pack_v2_root = plugin_config.pack_v2_root_path()
    root_for_paths = _common_root(
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
            _run_typst,
            typst_bin=plugin_config.mmt_typst_bin,
            template=template,
            input_json=data_json,
            out_path=png_out_tpl,
            tags_root=pack_v2_root if pack_v2_root.exists() else sources[0]["images_dir"],
            out_format="png",
            input_key="data",
        )
    except Exception as exc:
        await mmt_imgmatch.finish(f"Typst 渲染失败：{exc}\n- data_json: {data_json}")

    pngs = sorted(out_dir.glob(f"{stem}.mmt_imgmatch-*.png"), key=lambda p: p.name)
    if not pngs:
        single = out_dir / f"{stem}.mmt_imgmatch.png"
        if single.exists():
            pngs = [single]
    if not pngs:
        await mmt_imgmatch.finish("Typst 渲染成功但没找到输出图片。")

    try:
        await _send_onebot_images(bot, event, pngs)
    except Exception as exc:
        await mmt_imgmatch.finish(f"已生成：{pngs[0]}（发送失败：{exc}）")

    await mmt_imgmatch.finish(f"已发送 {len(pngs)} 张匹配结果（top_n={top_n}）。")


def _parse_asset_cmd(text: str) -> tuple[str, list[str]]:
    s = (text or "").strip()
    if not s:
        return "help", []
    parts = s.split()
    return parts[0].lower(), parts[1:]


@mmt_asset.handle()
async def _(bot: Bot, event: Event, state: T_State, arg=CommandArg()):
    raw = arg.extract_plain_text().strip()
    subcmd, rest = _parse_asset_cmd(raw)
    db_path, asset_dir = _asset_db_and_dir()
    db = AssetDB(db_path)
    private_id, group_id = _event_scope_ids(event)

    if subcmd in {"help", "-h", "--help"}:
        await mmt_asset.finish(
            "\n".join(
                [
                    "用法：/mmt-asset <add|ls|rm|info> ...（建议回复一条图片消息使用 add）",
                    "",
                    "add：/mmt-asset add <name> [--scope p|g|both] [--replace]",
                    "ls： /mmt-asset ls [--scope p|g|all]",
                    "rm： /mmt-asset rm <name> [--scope p|g|all] [--yes]",
                    "info：/mmt-asset info <name> [--scope p|g|all]",
                    "",
                    "引用：正文里用 `[asset:<name>]`（默认解析顺序 p>g），也可写 `[asset:p.<name>]` / `[asset:g.<name>]`。",
                ]
            )
        )

    if subcmd == "add":
        if not rest:
            await mmt_asset.finish("用法：/mmt-asset add <name> [--scope p|g|both] [--replace]（建议回复图片消息）")
        name = rest[0]
        try:
            name = validate_asset_name(name)
        except Exception as exc:
            await mmt_asset.finish(f"名称不合法：{exc}")

        scope = "p"
        replace = False
        for tok in rest[1:]:
            if tok.startswith("--scope="):
                scope = tok.split("=", 1)[1].strip().lower()
            elif tok == "--scope":
                # handled by naive parser? allow next token
                pass
            elif tok in {"--replace", "--force"}:
                replace = True

        # Also accept: --scope p
        if "--scope" in rest:
            try:
                idx = rest.index("--scope")
                scope = rest[idx + 1].strip().lower()
            except Exception:
                pass

        if scope not in {"p", "g", "both"}:
            await mmt_asset.finish("scope 只能是 p / g / both")
        if scope in {"g", "both"} and not group_id:
            await mmt_asset.finish("当前不是群聊事件，无法写入群聊空间（scope=g/both）")
        if not private_id and scope in {"p", "both"}:
            await mmt_asset.finish("无法获取 user_id，无法写入个人空间（scope=p/both）")

        try:
            url = await _extract_image_url(bot, event, arg)
        except Exception as exc:
            await mmt_asset.finish(f"提取图片失败：{exc}")

        max_bytes = int(getattr(plugin_config, "mmt_asset_max_mb", 10) or 10) * 1024 * 1024
        async with AssetDownloader(timeout_s=20.0, max_bytes=max_bytes) as dl:
            try:
                data, ct = await dl.download(url)
            except Exception as exc:
                await mmt_asset.finish(f"下载失败：{exc}")

        ext = "bin"
        try:
            ct0 = (ct.split(";", 1)[0].strip().lower())
            if ct0 == "image/svg+xml":
                ext = "svg"
            elif ct0 in {"image/jpeg", "image/jpg"}:
                ext = "jpg"
            elif "/" in ct0:
                ext = ct0.split("/", 1)[1]
            else:
                ext = ct0 or "bin"
        except Exception:
            ext = "bin"

        try:
            blob_id, filename, path = write_blob(asset_dir, data=data, ext=ext)
        except Exception as exc:
            await mmt_asset.finish(f"保存失败：{exc}")

        uploader = str(getattr(event, "user_id", "") or "0")
        try:
            if scope in {"p", "both"} and private_id:
                db.upsert(
                    scope="p",
                    scope_id=private_id,
                    name=name,
                    blob_id=blob_id,
                    ext=Path(filename).suffix.lstrip("."),
                    size=len(data),
                    uploader_id=uploader,
                    replace=replace,
                )
            if scope in {"g", "both"} and group_id:
                db.upsert(
                    scope="g",
                    scope_id=group_id,
                    name=name,
                    blob_id=blob_id,
                    ext=Path(filename).suffix.lstrip("."),
                    size=len(data),
                    uploader_id=uploader,
                    replace=replace,
                )
        except Exception as exc:
            await mmt_asset.finish(f"写入数据库失败：{exc}")

        await mmt_asset.finish(f"已保存：{name}（可用 [asset:{name}] 引用；默认 p>g）")

    if subcmd in {"ls", "list"}:
        scope = "all"
        for tok in rest:
            if tok.startswith("--scope="):
                scope = tok.split("=", 1)[1].strip().lower()
        if "--scope" in rest:
            try:
                idx = rest.index("--scope")
                scope = rest[idx + 1].strip().lower()
            except Exception:
                pass
        if scope not in {"p", "g", "all"}:
            await mmt_asset.finish("scope 只能是 p / g / all")

        lines: list[str] = []
        if scope in {"p", "all"} and private_id:
            items = db.list_names(scope="p", scope_id=private_id)
            lines.extend([f"p.{it.name}" for it in items])
        if scope in {"g", "all"} and group_id:
            items = db.list_names(scope="g", scope_id=group_id)
            lines.extend([f"g.{it.name}" for it in items])
        if not lines:
            await mmt_asset.finish("（空）")
        await mmt_asset.finish("\n".join(lines[:200]) + ("" if len(lines) <= 200 else "\n..."))

    if subcmd in {"rm", "del", "delete"}:
        if not rest:
            await mmt_asset.finish("用法：/mmt-asset rm <name> [--scope p|g|all] [--yes]")
        name = rest[0]
        try:
            name = validate_asset_name(name)
        except Exception as exc:
            await mmt_asset.finish(f"名称不合法：{exc}")
        scope = "all"
        yes = False
        for tok in rest[1:]:
            if tok.startswith("--scope="):
                scope = tok.split("=", 1)[1].strip().lower()
            if tok == "--yes":
                yes = True
        if "--scope" in rest:
            try:
                idx = rest.index("--scope")
                scope = rest[idx + 1].strip().lower()
            except Exception:
                pass
        if scope not in {"p", "g", "all"}:
            await mmt_asset.finish("scope 只能是 p / g / all")
        if not yes:
            await mmt_asset.finish("确认删除请加 --yes")

        deleted: list[str] = []
        blob_ids: list[str] = []
        if scope in {"p", "all"} and private_id:
            bid = db.delete_name(scope="p", scope_id=private_id, name=name)
            if bid:
                deleted.append("p")
                blob_ids.append(bid)
        if scope in {"g", "all"} and group_id:
            bid = db.delete_name(scope="g", scope_id=group_id, name=name)
            if bid:
                deleted.append("g")
                blob_ids.append(bid)

        # Best-effort delete blob file if unreferenced.
        for bid in set(blob_ids):
            if not db.blob_is_referenced(bid):
                for p in asset_dir.glob(f"{bid}.*"):
                    try:
                        p.unlink(missing_ok=True)
                    except Exception:
                        pass

        if not deleted:
            await mmt_asset.finish("未找到该资源。")
        await mmt_asset.finish(f"已删除 {'.'.join(deleted)}.{name}")

    if subcmd in {"info", "show"}:
        if not rest:
            await mmt_asset.finish("用法：/mmt-asset info <name> [--scope p|g|all]")
        name = rest[0]
        try:
            name = validate_asset_name(name)
        except Exception as exc:
            await mmt_asset.finish(f"名称不合法：{exc}")
        scope = "all"
        for tok in rest[1:]:
            if tok.startswith("--scope="):
                scope = tok.split("=", 1)[1].strip().lower()
        if "--scope" in rest:
            try:
                idx = rest.index("--scope")
                scope = rest[idx + 1].strip().lower()
            except Exception:
                pass
        if scope not in {"p", "g", "all"}:
            await mmt_asset.finish("scope 只能是 p / g / all")

        lines: list[str] = []
        if scope in {"p", "all"} and private_id:
            fn = db.get_filename(scope="p", scope_id=private_id, name=name)
            if fn:
                lines.append(f"p.{name} -> {fn}")
        if scope in {"g", "all"} and group_id:
            fn = db.get_filename(scope="g", scope_id=group_id, name=name)
            if fn:
                lines.append(f"g.{name} -> {fn}")
        if not lines:
            await mmt_asset.finish("未找到该资源。")
        await mmt_asset.finish("\n".join(lines))

    await mmt_asset.finish("未知子命令。用 /mmt-asset help 查看帮助。")
