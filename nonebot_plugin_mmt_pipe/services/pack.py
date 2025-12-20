from __future__ import annotations

from pathlib import Path
from typing import Optional

from nonebot.adapters import Event

from ..context import plugin_config
from ..pack_store import EulaDB, validate_pack_id
from .common import event_scope_ids, find_name_map_and_avatar_dir

try:
    from mmt_render import mmt_text_to_json
except Exception:  # pragma: no cover
    mmt_text_to_json = None  # type: ignore

try:
    from mmt_render.pack_v2 import PackV2, load_pack_v2
except Exception:  # pragma: no cover
    PackV2 = None  # type: ignore
    load_pack_v2 = None  # type: ignore


def state_db_path() -> Path:
    work = plugin_config.work_dir_path()
    work.mkdir(parents=True, exist_ok=True)
    return work / "state.sqlite3"


def load_ba_pack_v2() -> Optional["PackV2"]:
    if load_pack_v2 is None:
        return None
    root = plugin_config.pack_v2_root_path() / "ba"
    if not root.exists():
        return None
    try:
        return load_pack_v2(root)
    except Exception:
        return None


def load_pack_v2_by_id(pack_id: str) -> "PackV2":
    if load_pack_v2 is None:
        raise RuntimeError("pack-v2 loader 不可用。")
    pid = validate_pack_id(pack_id)
    root = plugin_config.pack_v2_root_path() / pid
    if not root.exists():
        raise RuntimeError(f"pack-v2 不存在：{pid}（目录：{root}）")
    return load_pack_v2(root)


def resolve_tags_file_and_images_dir_for_character(name: str) -> tuple[Path, Path, object]:
    """
    Returns: (tags_file, images_dir, id_for_title)
    - pack-v2: id_for_title = pack_char_id (str, e.g. "优香")
    - legacy:  id_for_title = student id (int)
    """
    token = (name or "").strip()
    if token.lower().startswith("ba."):
        token = token[3:].strip()

    # Prefer pack-v2 ba if available.
    pack = load_ba_pack_v2()
    if pack is not None:
        pack_char_id = pack.resolve_char_id(token)
        if pack_char_id is not None:
            if pack_char_id not in pack.id_to_assets:
                raise RuntimeError(f"pack-v2 映射缺失：{token} -> {pack_char_id}")
            tags_file = pack.tags_path(pack_char_id)
            images_dir = tags_file.parent
            return tags_file, images_dir, pack_char_id

    # Fallback: legacy kivo id lookup.
    name_map_path, _avatar_dir = find_name_map_and_avatar_dir()
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


def resolve_pack_v2_sources_for_character(
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
            pack = load_pack_v2_by_id(pid)
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
    tags_file, images_dir, sid_for_title = resolve_tags_file_and_images_dir_for_character(token)
    if load_pack_v2 is not None:
        # If pack-v2 ba hit, `resolve_tags_file_and_images_dir_for_character` returns (tags_file, images_dir, char_id)
        # but we don't have the pack_id from it; infer it as "ba".
        if isinstance(sid_for_title, str):
            pack = load_pack_v2_by_id("ba")
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


def enforce_pack_eulas_or_raise(*, data: dict, event: Event) -> None:
    # Guard: user must accept required EULAs before using @usepack.
    """
    Enforce per-user EULA acceptance for @usepack packs.
    """
    if load_pack_v2 is None:
        return
    alias_to_pack = _packs_from_data(data)
    if not alias_to_pack:
        return
    private_id, _group_id = event_scope_ids(event)
    if not private_id:
        return
    eula_db = EulaDB(state_db_path())
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


async def handle_mmt_pack(
    *,
    finish,
    bot,
    event: Event,
    cmd: str,
    pack_id: Optional[str] = None,
) -> None:
    # /mmt-pack handler (list or accept).
    if not cmd:
        await finish("用法：/mmt-pack list | /mmt-pack accept <pack_id>")

    private_id, _group_id = event_scope_ids(event)
    if not private_id:
        await finish("无法获取用户 id，无法记录 EULA 同意状态。")

    if cmd == "accept":
        if not pack_id:
            await finish("用法：/mmt-pack accept <pack_id>")
        pid = validate_pack_id(pack_id)
        EulaDB(state_db_path()).accept(user_id=private_id, pack_id=pid)
        await finish(f"已记录同意：{pid}")

    if cmd == "list":
        if load_pack_v2 is None:
            await finish("pack-v2 loader 不可用。")
        root = plugin_config.pack_v2_root_path()
        if not root.exists():
            await finish(f"pack-v2 根目录不存在：{root}")
        eula_db = EulaDB(state_db_path())
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
        await finish("\n".join(lines) if lines else "未找到可用 pack。")

    await finish("未知子命令。用法：/mmt-pack list | /mmt-pack accept <pack_id>")


__all__ = [
    "enforce_pack_eulas_or_raise",
    "handle_mmt_pack",
    "load_ba_pack_v2",
    "load_pack_v2_by_id",
    "resolve_pack_v2_sources_for_character",
    "resolve_tags_file_and_images_dir_for_character",
    "state_db_path",
]
