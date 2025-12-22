from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Optional

from nonebot import logger
from nonebot.adapters import Bot, Event

from ..assets_store import AssetError
from ..context import plugin_config


from nonebot.adapters.onebot.v11 import Message as V11Message, MessageSegment as V11MessageSegment
from nonebot.adapters.onebot.v11.exception import ActionFailed as V11ActionFailed


def onebot_available() -> bool:
    return V11MessageSegment is not None and V11Message is not None


def event_message_or_empty(event: Event) -> object:
    try:
        msg = getattr(event, "get_message", None)
        if callable(msg):
            return msg()
    except Exception:
        pass
    return []


async def send_onebot_images(bot: Bot, event: Event, png_paths: list[Path]) -> None:
    # Best-effort image send with URI/file fallback and timeout retry.
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


async def upload_onebot_file(
    bot: Bot,
    event: Event,
    file_path: Path,
    *,
    file_name: Optional[str] = None,
    folder_id: Optional[str] = None,
) -> dict:
    # Upload file to group/private chat based on the event scope.
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


def _extract_onebot_reply_id(event: Event) -> Optional[int]:
    # OneBot v11: reply segment may exist in message.
    # NapCat may use CQ-code like `[reply:id=123]` in raw_message.
    try:
        msg: list[V11MessageSegment] = event.original_message
        for seg in msg:
            if seg.type == "reply":
                data = seg.data or {}
                if "id" in data:
                    try:
                        return int(data.get("id"))
                    except Exception:
                        return None
        # msg = getattr(event, "get_message", None)
        # if callable(msg):
        #     for seg in msg():
        #         if getattr(seg, "type", None) == "reply":
        #             data = getattr(seg, "data", None) or {}
        #             if "id" in data:
        #                 try:
        #                     return int(data.get("id"))
        #                 except Exception:
        #                     return None
    except Exception:
        pass

    raw = str(getattr(event, "raw_message", "") or "")
    if raw:
        m = re.search(r"\[reply:id=(\d+)\]", raw)
        if m:
            try:
                return int(m.group(1))
            except Exception:
                return None
    return None


def _iter_message_segments(msg: object) -> list[object]:
    if msg is None or isinstance(msg, str):
        return []
    if isinstance(msg, (list, tuple)):
        return list(msg)
    try:
        return list(msg)
    except Exception:
        return []


def _seg_type(seg: object) -> Optional[str]:
    if isinstance(seg, dict):
        return str(seg.get("type") or "").strip()
    return str(getattr(seg, "type", "") or "").strip()


def _seg_data(seg: object) -> dict:
    if isinstance(seg, dict):
        data = seg.get("data") or {}
        return data if isinstance(data, dict) else {}
    data = getattr(seg, "data", None) or {}
    return data if isinstance(data, dict) else {}


def _first_image_from_message(msg: object) -> tuple[Optional[str], Optional[str]]:
    if isinstance(msg, str):
        return _extract_image_from_cqcode(msg)
    for seg in _iter_message_segments(msg):
        if _seg_type(seg) != "image":
            continue
        data = _seg_data(seg)
        url = str(data.get("url") or "").strip() or None
        file = str(data.get("file") or data.get("file_id") or "").strip() or None
        if url or file:
            return url, file
    return None, None


def _extract_image_from_cqcode(text: str) -> tuple[Optional[str], Optional[str]]:
    url = None
    file = None
    m = re.search(r"\[(?:CQ:)?image[: ,](?:[^\]]*?)(?:url=([^,\]]+))", text)
    if m:
        url = m.group(1)
    m = re.search(r"\[(?:CQ:)?image[: ,](?:[^\]]*?)(?:file=([^,\]]+))", text)
    if m:
        file = m.group(1)
    return url, file


async def _get_image_url_from_file(bot: Bot, file_token: str) -> Optional[str]:
    try:
        ret = await bot.call_api("get_image", file=file_token)
        url = (ret.get("url") or "").strip()
        if url:
            return url
    except Exception:
        return None
    return None


def _extract_file_from_cqcode(text: str) -> tuple[Optional[str], Optional[str], Optional[str]]:
    url = None
    file = None
    name = None
    m = re.search(r"\[(?:CQ:)?file[: ,](?:[^\]]*?)(?:url=([^,\]]+))", text)
    if m:
        url = m.group(1)
    m = re.search(r"\[(?:CQ:)?file[: ,](?:[^\]]*?)(?:file=([^,\]]+))", text)
    if m:
        file = m.group(1)
    m = re.search(r"\[(?:CQ:)?file[: ,](?:[^\]]*?)(?:name=([^,\]]+))", text)
    if m:
        name = m.group(1)
    return url, file, name


async def _get_file_url_from_file(bot: Bot, file_token: str) -> Optional[str]:
    try:
        ret = await bot.call_api("get_file", file=file_token)
        url = (ret.get("url") or "").strip()
        if url:
            return url
    except Exception:
        return None
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


async def extract_text_file_url(bot: Bot, event: Event, arg_msg: object) -> tuple[str, Optional[str]]:
    # Try command arg, full message, reply, then raw CQ-code for file URLs.
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


async def download_text_file(url: str, *, max_bytes: int = 1024 * 1024) -> bytes:
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


def decode_text_file(data: bytes) -> str:
    # Try UTF-8 first, then a common Chinese fallback.
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except Exception:
            continue
    # last resort
    return data.decode("utf-8", errors="replace")


async def extract_image_url(bot: Bot, event: Event, arg_msg: object) -> str:
    # Try command arg, full message, reply, then raw CQ-code for image URLs.
    # 1) Try image segments in command arg
    url, file = _first_image_from_message(arg_msg)
    if url:
        return url
    if file:
        url2 = await _get_image_url_from_file(bot, file)
        if url2:
            return url2

    # 2) Try image segments in the full message
    try:
        msg = getattr(event, "get_message", None)
        if callable(msg):
            url2, file2 = _first_image_from_message(msg())
            if url2:
                return url2
            if file2:
                url3 = await _get_image_url_from_file(bot, file2)
                if url3:
                    return url3
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
                url3, file3 = _first_image_from_message(msg_val)
                if url3:
                    return url3
                if file3:
                    url4 = await _get_image_url_from_file(bot, file3)
                    if url4:
                        return url4
        except Exception:
            pass

    # 4) raw_message fallback: parse image CQ-code directly
    raw = str(getattr(event, "raw_message", "") or "")
    url5, file5 = _extract_image_from_cqcode(raw)
    if url5:
        return url5
    if file5:
        url6 = await _get_image_url_from_file(bot, file5)
        if url6:
            return url6

    raise AssetError("no image found: attach an image or reply to an image message")


__all__ = [
    "decode_text_file",
    "download_text_file",
    "event_message_or_empty",
    "extract_image_url",
    "extract_text_file_url",
    "onebot_available",
    "send_onebot_images",
    "upload_onebot_file",
]
