from __future__ import annotations

from pathlib import Path

from nonebot.adapters import Bot, Event

from ..assets_store import (
    AssetDB,
    AssetDownloader,
    AssetError,
    merge_asset_meta,
    validate_asset_name,
    write_blob,
)
from ..context import plugin_config
from .common import event_scope_ids
from .io import extract_image_url


def asset_db_and_dir() -> tuple[Path, Path]:
    work = plugin_config.work_dir_path()
    db_path = work / "assets.sqlite3"
    asset_dir = plugin_config.asset_cache_dir_path()
    asset_dir.mkdir(parents=True, exist_ok=True)
    return db_path, asset_dir


def _parse_asset_cmd(text: str) -> tuple[str, list[str]]:
    s = (text or "").strip()
    if not s:
        return "help", []
    parts = s.split()
    return parts[0].lower(), parts[1:]


async def handle_mmt_asset(
    *,
    finish,
    bot: Bot,
    event: Event,
    raw: str,
    arg_msg: object,
) -> None:
    # Manage asset storage for /mmt-asset (add/list/remove/info).
    subcmd, rest = _parse_asset_cmd(raw)
    db_path, asset_dir = asset_db_and_dir()
    db = AssetDB(db_path)
    private_id, group_id = event_scope_ids(event)

    if subcmd in {"help", "-h", "--help"}:
        await finish(
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
            await finish("用法：/mmt-asset add <name> [--scope p|g|both] [--replace]（建议回复图片消息）")
        name = rest[0]
        try:
            name = validate_asset_name(name)
        except Exception as exc:
            await finish(f"名称不合法：{exc}")

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
            await finish("scope 只能是 p / g / both")
        if scope in {"g", "both"} and not group_id:
            await finish("当前不是群聊事件，无法写入群聊空间（scope=g/both）")
        if not private_id and scope in {"p", "both"}:
            await finish("无法获取 user_id，无法写入个人空间（scope=p/both）")

        try:
            url = await extract_image_url(bot, event, arg_msg)
        except Exception as exc:
            await finish(f"提取图片失败：{exc}")

        max_bytes = int(getattr(plugin_config, "mmt_asset_max_mb", 10) or 10) * 1024 * 1024
        async with AssetDownloader(timeout_s=20.0, max_bytes=max_bytes) as dl:
            try:
                data, ct = await dl.download(url)
            except Exception as exc:
                await finish(f"下载失败：{exc}")

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
            await finish(f"保存失败：{exc}")

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
            await finish(f"写入数据库失败：{exc}")

        await finish(f"已保存：{name}（可用 [asset:{name}] 引用；默认 p>g）")

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
            await finish("scope 只能是 p / g / all")

        lines: list[str] = []
        if scope in {"p", "all"} and private_id:
            items = db.list_names(scope="p", scope_id=private_id)
            lines.extend([f"p.{it.name}" for it in items])
        if scope in {"g", "all"} and group_id:
            items = db.list_names(scope="g", scope_id=group_id)
            lines.extend([f"g.{it.name}" for it in items])
        if not lines:
            await finish("（空）")
        await finish("\n".join(lines[:200]) + ("" if len(lines) <= 200 else "\n..."))

    if subcmd in {"rm", "del", "delete"}:
        if not rest:
            await finish("用法：/mmt-asset rm <name> [--scope p|g|all] [--yes]")
        name = rest[0]
        try:
            name = validate_asset_name(name)
        except Exception as exc:
            await finish(f"名称不合法：{exc}")
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
            await finish("scope 只能是 p / g / all")
        if not yes:
            await finish("确认删除请加 --yes")

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
            await finish("未找到该资源。")
        await finish(f"已删除 {'.'.join(deleted)}.{name}")

    if subcmd in {"info", "show"}:
        if not rest:
            await finish("用法：/mmt-asset info <name> [--scope p|g|all]")
        name = rest[0]
        try:
            name = validate_asset_name(name)
        except Exception as exc:
            await finish(f"名称不合法：{exc}")
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
            await finish("scope 只能是 p / g / all")

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
            await finish("未找到该资源。")
        await finish("\n".join(lines))

    await finish("未知子命令。用 /mmt-asset help 查看帮助。")


__all__ = ["asset_db_and_dir", "handle_mmt_asset"]
