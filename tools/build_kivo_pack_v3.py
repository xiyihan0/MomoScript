"""
Build a draft pack-v3 resource pack from Kivo Wiki student data.

This is intentionally a pack builder, not the final schema validator. It fetches
Kivo student details, downloads avatars and sticker-like gallery groups in
parallel, optionally encodes sticker sets concurrently, and writes a pack-v3
manifest plus an auditable build report.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import unquote, urlsplit

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from mmt_core.kivowiki_api import (  # noqa: E402
    ApiError,
    KivoWikiClient,
    parse_student_list_response,
)


DEFAULT_EXCLUDED_GALLERY_TITLES = (
    "官方图集",
    "相关图像",
    "资料图像",
    "官方画集",
    "角色画廊",
    "角色图像",
    "官方画廊",
    "图像资料",
    "官方图像",
)
LIKELY_STICKER_GALLERY_MARKERS = (
    "差分",
    "表情",
    "脸部",
    "脸图",
    "头套",
    "战损",
    "泳装",
    "运动服",
    "偶像服",
    "旧立绘",
    "旧冬装",
    "防寒",
    "鬼屋",
    "无武器",
    "礼服",
    "幼儿园",
    "燕尾服",
    "紧身衣",
    "玩偶服",
    "临战",
    "FOX EATS",
    "睡衣",
    "轮椅",
    "机甲",
    "包扎",
    "学校泳装",
    "机器人",
    "身体",
    "墨镜",
    "中学",
    "巫女",
    "耳机",
    "眼镜",
    "脱帽",
    "制服",
    "和服",
    "黑化",
    "黄昏",
)
KNOWN_SET_IDS = {
    "初始立绘差分": "default",
    "初始差分": "default",
    "战损差分": "damaged",
    "学校泳装": "school_swimsuit",
    "运动服": "sportswear",
    "旧冬装差分": "old_winter",
    "头套差分": "mask",
    "头套眼镜差分": "mask_glasses",
    "一年级立绘差分": "first_year",
    "中学时期差分": "middle_school",
    "临战立绘差分": "tactical",
    "体操服立绘差分": "gym_uniform",
    "偶像服差分": "idol",
    "初始立绘-脸部差分": "default_face",
    "初始立绘差分（持盾）": "default_shield_raised",
    "初始立绘差分（收盾）": "default_shield_lowered",
    "副武器持盾差分": "secondary_weapon_shield",
    "包扎差分": "bandaged",
    "包扎立绘差分": "bandaged_full",
    "和服差分": "kimono",
    "圣徒会制服立绘差分": "saint_council_uniform",
    "墨镜立绘差分": "sunglasses",
    "巫女服差分": "miko",
    "差分": "variants",
    "幼儿园泳装立绘差分": "kindergarten_swimsuit",
    "幼儿园立绘差分": "kindergarten",
    "应援服立绘差分": "cheer_uniform",
    "战损立绘差分": "damaged_full",
    "战损（机甲）差分": "damaged_mecha",
    "战斗模式立绘差分": "battle_mode",
    "打工制服差分": "work_uniform",
    "护士服立绘差分": "nurse",
    "新立绘表情差分": "new_art_expressions",
    "无披肩差分": "no_cape",
    "无武器差分": "no_weapon",
    "无武器立绘差分": "no_weapon_full",
    "无眼镜差分": "no_glasses",
    "无耳机差分": "no_headphones",
    "旧立绘差分": "old_art",
    "机器人表情差分": "robot_expressions",
    "泳装立绘差分": "swimsuit",
    "演出服差分": "stage_outfit",
    "偶像服": "idol",
    "玩偶服立绘差分": "mascot_costume",
    "燕尾服差分": "tailcoat",
    "燕尾服": "tailcoat",
    "睡衣差分": "pajamas",
    "睡衣（黑眼圈）差分": "pajamas_dark_circles",
    "礼服立绘差分": "formal_dress",
    "神名十文字身体差分": "shinmei_cross_body",
    "紧身衣差分": "bodysuit",
    "脱帽差分": "no_hat",
    "脸图差分": "face_portrait",
    "脸部差分": "face",
    "脸部差分-正面": "face_front",
    "表情差分": "expressions",
    "角色差分": "character_variants",
    "轮椅立绘差分": "wheelchair",
    "运动服立绘差分": "sportswear",
    "防寒服差分": "winter_uniform",
    "防寒棉袄差分": "winter_coat",
    "阿比舒机甲差分": "abydos_mecha",
    "领航服差分": "navigator_uniform",
    "鬼屋装扮差分": "haunted_house",
    "黄昏立绘差分": "twilight",
    "黑化立绘差分": "corrupted",
}
COLLAB_FULL_NAMES = {
    "初音未来",
    "御坂美琴",
    "食蜂操祈",
    "佐天泪子",
}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _normalize_url(url: str) -> str:
    url = _safe_text(url)
    if url.startswith("//"):
        return f"https:{url}"
    return url


def _url_ext(url: str, *, default: str = ".bin") -> str:
    path = unquote(urlsplit(_normalize_url(url)).path)
    ext = os.path.splitext(path)[1].lower()
    if ext in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
        return ".jpg" if ext == ".jpeg" else ext
    return default


def _slugify(value: str, *, fallback: str) -> str:
    value = _safe_text(value).lower()
    value = re.sub(r"[^a-z0-9]+", "_", value)
    value = re.sub(r"_+", "_", value).strip("_")
    return value or fallback


def _unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in values:
        value = _safe_text(raw)
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _split_nicknames(value: str) -> list[str]:
    parts = re.split(r"[,，、/]+", _safe_text(value))
    return _unique(parts)


def _first_character_data(detail: dict[str, Any]) -> dict[str, Any]:
    datas = detail.get("character_datas") or []
    if isinstance(datas, list) and datas and isinstance(datas[0], dict):
        return datas[0]
    return {}


def _full_name(detail: dict[str, Any], *, locale: str) -> str:
    if locale == "zh-CN":
        family = _safe_text(detail.get("family_name_cn") or detail.get("family_name"))
        given = _safe_text(detail.get("given_name_cn") or detail.get("given_name"))
        return f"{family}{given}".strip()
    if locale == "en-US":
        family = _safe_text(detail.get("family_name_en"))
        given = _safe_text(detail.get("given_name_en"))
        return f"{given} {family}".strip()
    family = _safe_text(detail.get("family_name"))
    given = _safe_text(detail.get("given_name"))
    return f"{family}{given}".strip()


def _entity_id_for(detail: dict[str, Any]) -> str:
    student_id = int(detail.get("id") or 0)
    full_cn = _full_name(detail, locale="zh-CN")
    given = _display_name(detail)
    base_id = full_cn if full_cn in COLLAB_FULL_NAMES else given
    skin = _safe_text(
        detail.get("skin_cn") or detail.get("skin") or detail.get("skin_jp")
    )
    if base_id and skin:
        return f"{base_id}_{skin}"
    if base_id:
        return base_id
    return f"student_{student_id}"


def _display_name(detail: dict[str, Any]) -> str:
    return (
        _safe_text(
            detail.get("given_name_cn")
            or detail.get("given_name")
            or detail.get("given_name_en")
        )
        or f"student-{detail.get('id')}"
    )


def _canonical_names(
    detail: dict[str, Any], *, nickname_names: bool, english_names: bool
) -> list[str]:
    full_cn = _full_name(detail, locale="zh-CN")
    given = _display_name(detail)
    primary_name = full_cn if full_cn in COLLAB_FULL_NAMES else given
    skin = _safe_text(detail.get("skin_cn") or detail.get("skin"))
    names: list[str] = []
    if skin:
        names.extend([f"{primary_name}_{skin}", f"{primary_name}({skin})"])
    else:
        names.append(primary_name)

    if english_names:
        given_en = _safe_text(detail.get("given_name_en"))
        skin_en = _safe_text(detail.get("skin_jp") or detail.get("skin"))
        if given_en and skin:
            names.append(f"{given_en}_{_slugify(skin_en or skin, fallback='skin')}")
        elif given_en:
            names.append(given_en)

    if nickname_names:
        names.extend(_split_nicknames(_safe_text(detail.get("nick_name"))))

    return _unique(names)


def _locale_map(*items: tuple[str, Any]) -> dict[str, str]:
    return {locale: text for locale, raw in items if (text := _safe_text(raw))}


def _entity_meta(
    detail: dict[str, Any], *, api_version: str = "", api_time: int = 0
) -> dict[str, Any]:
    cdata = _first_character_data(detail)
    character_id = cdata.get("character_id")
    nicknames = _split_nicknames(_safe_text(detail.get("nick_name")))

    meta: dict[str, Any] = {
        "external": {
            "kivo": {
                "student_id": int(detail.get("id") or 0),
                "character_id": character_id,
                "api_version": api_version,
                "api_time": api_time,
                "created_at": detail.get("created_at"),
                "updated_at": detail.get("updated_at"),
            }
        },
        "names": {
            "family": _locale_map(
                ("zh-CN", detail.get("family_name_cn") or detail.get("family_name")),
                ("ja-JP", detail.get("family_name_jp")),
                ("ko-KR", detail.get("family_name_kr")),
                ("en-US", detail.get("family_name_en")),
                ("zh-TW", detail.get("family_name_zh_tw")),
            ),
            "given": _locale_map(
                ("zh-CN", detail.get("given_name_cn") or detail.get("given_name")),
                ("ja-JP", detail.get("given_name_jp")),
                ("ko-KR", detail.get("given_name_kr")),
                ("en-US", detail.get("given_name_en")),
                ("zh-TW", detail.get("given_name_zh_tw")),
            ),
            "display": _locale_map(("zh-CN", _display_name(detail))),
            "skin": _locale_map(
                ("zh-CN", detail.get("skin_cn") or detail.get("skin")),
                ("ja-JP", detail.get("skin_jp")),
                ("zh-TW", detail.get("skin_zh_tw")),
            ),
            "nicknames": {"zh-CN": nicknames} if nicknames else {},
        },
        "affiliation": {
            "school": {"source_id": detail.get("school")}
            if detail.get("school") is not None
            else {},
            "main_relation": {"source_id": detail.get("main_relation")}
            if detail.get("main_relation") is not None
            else {},
            "relations": [{"source_id": r} for r in (detail.get("relation") or [])],
        },
    }

    # Drop empty nested maps/lists while preserving false/0.
    return _drop_empty(meta)


def _drop_empty(value: Any) -> Any:
    if isinstance(value, dict):
        out = {k: _drop_empty(v) for k, v in value.items()}
        return {k: v for k, v in out.items() if v not in ({}, [], "", None)}
    if isinstance(value, list):
        return [
            _drop_empty(v) for v in value if _drop_empty(v) not in ({}, [], "", None)
        ]
    return value


def _set_id_for(title: str, index: int) -> str:
    title = _safe_text(title)
    if title in KNOWN_SET_IDS:
        return KNOWN_SET_IDS[title]
    ascii_slug = _slugify(title, fallback="")
    if ascii_slug:
        return ascii_slug
    return f"set_{index + 1:02d}"


def _set_handles_for(title: str, *, is_default: bool, is_only_set: bool) -> list[str]:
    names = [title]
    if is_default or is_only_set:
        names.append("default")
    return _unique(names)


def _is_sticker_gallery(
    title: str, count: int, *, mode: str, excluded_titles: list[str]
) -> bool:
    if mode == "none":
        return False
    if mode == "all":
        return count > 0
    if count < 2:
        return False
    if any(excluded in title for excluded in excluded_titles):
        return False
    return any(marker in title for marker in LIKELY_STICKER_GALLERY_MARKERS)


@dataclass(frozen=True)
class DownloadTask:
    url: str
    target: Path
    label: str


async def _fetch_student_ids(
    client: KivoWikiClient,
    *,
    page_size: int,
    include_npc: bool,
    limit: Optional[int],
) -> list[int]:
    ids: list[int] = []
    raw = await client.get_students_raw(
        page=1, page_size=page_size, is_npc=None if include_npc else False
    )
    parsed = parse_student_list_response(raw)
    ids.extend(s.id for s in parsed.data.students)
    max_page = int(parsed.data.max_page or 1)

    for page in range(2, max_page + 1):
        if limit is not None and len(ids) >= limit:
            break
        raw = await client.get_students_raw(
            page=page, page_size=page_size, is_npc=None if include_npc else False
        )
        parsed = parse_student_list_response(raw)
        ids.extend(s.id for s in parsed.data.students)

    return ids[:limit] if limit is not None else ids


async def _fetch_detail(
    client: KivoWikiClient,
    student_id: int,
    *,
    semaphore: asyncio.Semaphore,
) -> tuple[int, Optional[dict[str, Any]], Optional[str], str, int]:
    async with semaphore:
        try:
            raw = await client.get_student_raw(student_id)
        except ApiError as exc:
            return student_id, None, str(exc), "", 0

    data = raw.get("data")
    if not isinstance(data, dict):
        return (
            student_id,
            None,
            "missing data object",
            _safe_text(raw.get("version")),
            int(raw.get("time") or 0),
        )
    return (
        student_id,
        data,
        None,
        _safe_text(raw.get("version")),
        int(raw.get("time") or 0),
    )


async def _download_one(
    client: KivoWikiClient,
    task: DownloadTask,
    *,
    semaphore: asyncio.Semaphore,
    resume: bool,
    timeout: float,
) -> tuple[DownloadTask, bool, Optional[str]]:
    async with semaphore:
        if resume and task.target.exists() and task.target.stat().st_size > 0:
            return task, True, None
        try:
            status_code, _headers, content = await client.get_bytes(
                task.url, timeout=timeout
            )
        except ApiError as exc:
            return task, False, str(exc)

    if status_code >= 400:
        return task, False, f"HTTP {status_code}"

    try:
        task.target.parent.mkdir(parents=True, exist_ok=True)
        task.target.write_bytes(content)
    except Exception as exc:
        return task, False, f"write failed: {exc}"
    return task, True, None


def _build_manifest(
    details: list[dict[str, Any]],
    *,
    namespace: str,
    pack_name: str,
    pack_version: str,
    out_dir: Path,
    gallery_mode: str,
    excluded_gallery_titles: list[str],
    max_gallery_images: Optional[int],
    nickname_names: bool,
    english_names: bool,
    api_versions: dict[int, str],
    api_times: dict[int, int],
) -> tuple[dict[str, Any], list[DownloadTask]]:
    entities: dict[str, Any] = {}
    storage: dict[str, Any] = {
        "avatars": {
            "kind": "image-dir",
            "base": "assets/avatar",
        }
    }
    thumbnails: dict[str, Any] = {}
    tasks: list[DownloadTask] = []

    id_to_entity: dict[int, str] = {}
    used_entity_ids: set[str] = set()
    for detail in details:
        base_id = _entity_id_for(detail)
        entity_id = base_id
        if entity_id in used_entity_ids:
            entity_id = f"{base_id}_{int(detail.get('id') or 0)}"
        used_entity_ids.add(entity_id)
        id_to_entity[int(detail.get("id") or 0)] = entity_id

    for detail in details:
        student_id = int(detail.get("id") or 0)
        entity_id = id_to_entity[student_id]
        avatar_url = _normalize_url(_safe_text(detail.get("avatar")))
        avatar_ext = _url_ext(avatar_url, default=".png")
        avatar_filename = f"{entity_id}{avatar_ext}"

        slots: dict[str, Any] = {
            "avatar": {
                "default": "default",
                "items": {
                    "default": {
                        "storage": "avatars",
                        "path": avatar_filename,
                    }
                },
            }
        }

        if avatar_url:
            tasks.append(
                DownloadTask(
                    url=avatar_url,
                    target=out_dir / "assets" / "avatar" / avatar_filename,
                    label=f"{entity_id}:avatar",
                )
            )

        sticker_sets: dict[str, Any] = {}
        galleries = detail.get("gallery") or []
        if isinstance(galleries, list):
            for gallery_index, gallery in enumerate(galleries):
                if not isinstance(gallery, dict):
                    continue
                title = (
                    _safe_text(gallery.get("title")) or f"gallery-{gallery_index + 1}"
                )
                images = [u for u in (gallery.get("images") or []) if _safe_text(u)]
                if not _is_sticker_gallery(
                    title,
                    len(images),
                    mode=gallery_mode,
                    excluded_titles=excluded_gallery_titles,
                ):
                    continue
                if max_gallery_images is not None:
                    images = images[:max_gallery_images]
                if not images:
                    continue

                set_id = _set_id_for(title, gallery_index)
                if set_id in sticker_sets:
                    set_id = f"{set_id}_{gallery_index + 1}"
                storage_id = f"{entity_id}_{set_id}_images"
                base_dir = f"assets/stickers/{entity_id}/{set_id}"
                storage[storage_id] = {
                    "kind": "image-dir",
                    "base": base_dir,
                }

                variants: list[dict[str, Any]] = []
                for image_index, url in enumerate(images):
                    normalized = _normalize_url(_safe_text(url))
                    ext = _url_ext(normalized, default=".jpg")
                    filename = f"{image_index + 1:03d}{ext}"
                    variants.append(
                        {
                            "id": f"{set_id}_{image_index + 1:03d}",
                            "ordinal": image_index + 1,
                            "path": filename,
                        }
                    )
                    thumbnails[f"{entity_id}/sticker/{set_id}/{set_id}_{image_index + 1:03d}"] = {
                        "storage": storage_id,
                        "path": filename,
                    }
                    tasks.append(
                        DownloadTask(
                            url=normalized,
                            target=out_dir / base_dir / filename,
                            label=f"{entity_id}:{set_id}:{image_index + 1}",
                        )
                    )

                sticker_sets[set_id] = {
                    "display_name": title,
                    "storage": storage_id,
                    "variants": variants,
                }

        if sticker_sets:
            default_set = (
                "default" if "default" in sticker_sets else next(iter(sticker_sets))
            )
            is_only_set = len(sticker_sets) == 1
            for set_id, set_data in sticker_sets.items():
                set_data["handles"] = _set_handles_for(
                    set_data["display_name"],
                    is_default=set_id == default_set,
                    is_only_set=is_only_set,
                )
            slots["sticker"] = {
                "default": default_set,
                "sets": sticker_sets,
            }

        entities[entity_id] = _drop_empty(
            {
                "names": _canonical_names(
                    detail,
                    nickname_names=nickname_names,
                    english_names=english_names,
                ),
                "display_name": _display_name(detail),
                "slots": slots,
            }
        )

    manifest = {
        "schema": "mmt-pack.v3",
        "pack": {
            "namespace": namespace,
            "name": pack_name,
            "version": pack_version,
            "type": "base",
            "source": "kivo.wiki",
            "generated_at": _utc_now_iso(),
        },
        "entities": dict(sorted(entities.items(), key=lambda kv: kv[0])),
        "contributions": [],
        "assets": {},
        "thumbnails": dict(sorted(thumbnails.items(), key=lambda kv: kv[0])),
        "storage": dict(sorted(storage.items(), key=lambda kv: kv[0])),
    }
    return manifest, tasks


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def _entity_name_conflicts(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    owners: dict[str, list[str]] = {}
    for entity_id, entity in manifest.get("entities", {}).items():
        if not isinstance(entity, dict):
            continue
        for name in entity.get("names") or []:
            if isinstance(name, str) and name:
                owners.setdefault(name, []).append(str(entity_id))
    return [
        {"name": name, "entities": entity_ids}
        for name, entity_ids in sorted(owners.items())
        if len(entity_ids) > 1
    ]


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _image_info(paths: list[Path]) -> tuple[list[tuple[int, int]], bool]:
    sizes: list[tuple[int, int]] = []
    has_alpha = False
    for path in paths:
        result = subprocess.run(
            ["magick", "identify", "-format", "%w %h %[channels]", str(path)],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                (result.stderr or result.stdout).strip() or f"identify failed: {path}"
            )
        width, height, channels = result.stdout.strip().split(maxsplit=2)
        sizes.append((int(width), int(height)))
        has_alpha = has_alpha or "a" in channels.lower() or "alpha" in channels.lower()
    return sizes, has_alpha


def _prepare_padded_frames(
    paths: list[Path], out_dir: Path, *, size: tuple[int, int], alpha: bool
) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    background = "none" if alpha else "white"
    prepared: list[Path] = []
    for index, src in enumerate(paths, start=1):
        target = out_dir / f"{index:03d}.png"
        result = subprocess.run(
            [
                "magick",
                str(src),
                "-background",
                background,
                "-gravity",
                "center",
                "-extent",
                f"{size[0]}x{size[1]}",
                str(target),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                (result.stderr or result.stdout).strip() or f"padding failed: {src}"
            )
        prepared.append(target)
    return prepared


def _prepare_thumbnails(
    paths: list[Path], out_dir: Path, *, resume: bool
) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    names: list[str] = []
    for index, source in enumerate(paths, start=1):
        name = f"{index:03d}.webp"
        target = out_dir / name
        names.append(name)
        if resume and target.exists() and target.stat().st_size > 0:
            continue
        result = subprocess.run(
            [
                "magick",
                f"{source}[0]",
                "-auto-orient",
                "-thumbnail",
                "256x256>",
                "-strip",
                "-quality",
                "75",
                str(target),
            ],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
        )
        if result.returncode != 0 or not target.exists():
            raise RuntimeError(
                (result.stdout or "").strip()[-1000:]
                or f"thumbnail conversion failed for {source}"
            )
    return names


def _run_avifenc(
    inputs: list[Path],
    output: Path,
    *,
    qcolor: int,
    qalpha: int,
    yuv: str,
    keyframe: int,
    speed: int,
    jobs: str,
) -> subprocess.CompletedProcess[str]:
    output.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "avifenc",
        "--fps",
        "1",
        "-k",
        str(keyframe),
        "-s",
        str(speed),
        "-j",
        str(jobs),
        "-y",
        str(yuv),
        "--qcolor",
        str(qcolor),
        "--qalpha",
        str(qalpha),
        *[str(p) for p in inputs],
        str(output),
    ]
    return subprocess.run(
        cmd, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False
    )


def _drop_sticker_set(
    manifest: dict[str, Any], entity: dict[str, Any], set_id: str, storage_id: Any
) -> None:
    sticker = entity.get("slots", {}).get("sticker")
    if not isinstance(sticker, dict):
        return

    sets = sticker.get("sets")
    if isinstance(sets, dict):
        sets.pop(set_id, None)
        if isinstance(storage_id, str):
            manifest.get("storage", {}).pop(storage_id, None)
        if sets:
            if sticker.get("default") == set_id:
                sticker["default"] = (
                    "default" if "default" in sets else next(iter(sets))
                )
        else:
            entity.get("slots", {}).pop("sticker", None)


def _encode_avif_sequences(
    out_dir: Path, manifest: dict[str, Any], args: argparse.Namespace
) -> dict[str, Any]:
    report_path = out_dir / "encode_report.jsonl"
    summary: dict[str, Any] = {
        "enabled": True,
        "concurrency": int(args.avif_concurrency),
        "profile": {
            "encoder": "avifenc",
            "codec": "aom",
            "qcolor": int(args.avif_qcolor),
            "qalpha": int(args.avif_qalpha),
            "yuv": str(args.avif_yuv),
            "keyframe_interval": int(args.avif_keyframe),
            "fps": 1,
            "speed": int(args.avif_speed),
            "jobs": str(args.avif_jobs),
        },
        "total": 0,
        "encoded": 0,
        "failed": 0,
        "skipped_sets": 0,
        "skipped_variants": 0,
        "original_bytes": 0,
        "compressed_bytes": 0,
        "compression_ratio": None,
        "failures": [],
    }

    def run_one(job: dict[str, Any]) -> dict[str, Any]:
        record = dict(job["record"])
        image_paths: list[Path] = job["image_paths"]
        record["original_bytes"] = sum(
            path.stat().st_size for path in image_paths if path.exists()
        )
        variants: list[dict[str, Any]] = job["variants"]
        output_rel: Path = job["output_rel"]
        output_path = out_dir / output_rel
        try:
            if any(not path.exists() for path in image_paths):
                raise RuntimeError("missing input image")

            sizes, has_alpha = _image_info(image_paths)
            target_size = (
                max(width for width, _ in sizes),
                max(height for _, height in sizes),
            )
            target_pixels = target_size[0] * target_size[1]
            aspect_ratio = max(
                target_size[0] / target_size[1], target_size[1] / target_size[0]
            )
            record["size"] = [target_size[0], target_size[1]]
            record["pixels"] = target_pixels
            record["aspect_ratio"] = round(aspect_ratio, 3)
            record["alpha"] = bool(has_alpha)

            if target_pixels > int(args.sticker_max_canvas_pixels):
                record["status"] = "skipped"
                record["reason"] = "sticker canvas too large"
                return {**job, "record": record}
            if aspect_ratio > float(args.sticker_max_aspect_ratio):
                record["status"] = "skipped"
                record["reason"] = "sticker canvas aspect ratio too large"
                return {**job, "record": record}
            if target_pixels > int(args.avif_max_canvas_pixels):
                raise RuntimeError(
                    f"canvas too large: {target_size[0]}x{target_size[1]} "
                    f"({target_pixels} pixels)"
                )
            if max(target_size) > int(args.avif_max_canvas_edge):
                raise RuntimeError(
                    f"canvas edge too large: {target_size[0]}x{target_size[1]}"
                )

            if (
                bool(args.resume)
                and output_path.exists()
                and output_path.stat().st_size > 0
            ):
                status = "reused"
            else:
                encode_inputs = image_paths
                temp_dir_obj: tempfile.TemporaryDirectory[str] | None = None
                if len(set(sizes)) > 1:
                    temp_dir_obj = tempfile.TemporaryDirectory(prefix="mmt-avif-")
                    encode_inputs = _prepare_padded_frames(
                        image_paths,
                        Path(temp_dir_obj.name),
                        size=target_size,
                        alpha=has_alpha,
                    )
                    record["padded"] = True
                    record["source_sizes"] = sorted(set(sizes))
                else:
                    record["padded"] = False

                try:
                    output_path.unlink(missing_ok=True)
                    result = _run_avifenc(
                        encode_inputs,
                        output_path,
                        qcolor=int(args.avif_qcolor),
                        qalpha=int(args.avif_qalpha),
                        yuv=str(args.avif_yuv),
                        keyframe=int(args.avif_keyframe),
                        speed=int(args.avif_speed),
                        jobs=str(args.avif_jobs),
                    )
                finally:
                    if temp_dir_obj is not None:
                        temp_dir_obj.cleanup()

                if result.returncode != 0 or not output_path.exists():
                    raise RuntimeError(
                        (result.stdout or "").strip()[-1000:]
                        or f"avifenc exited {result.returncode}"
                    )
                status = "encoded"

            thumbnail_dir = (
                out_dir / "assets" / "thumbnails" / record["entity"] / job["set_id"]
            )
            thumbnail_names = _prepare_thumbnails(
                image_paths, thumbnail_dir, resume=bool(args.resume)
            )
            storage_update = {
                "kind": "image-sequence",
                "path": output_rel.as_posix(),
                "container": "avifs",
                "codec": "av1",
                "frame_count": len(variants),
                "fps": 1,
                "size": [target_size[0], target_size[1]],
                "alpha": bool(has_alpha),
                "sha256": _sha256_file(output_path),
                "profile": summary["profile"],
            }
            record["status"] = status
            record["output"] = output_rel.as_posix()
            record["bytes"] = output_path.stat().st_size
            return {
                **job,
                "record": record,
                "storage_update": storage_update,
                "thumbnail_names": thumbnail_names,
            }
        except Exception as exc:
            record["status"] = "failed"
            record["error"] = str(exc)
            return {**job, "record": record}

    jobs: list[dict[str, Any]] = []
    immediate: list[dict[str, Any]] = []
    for entity_id, entity in manifest.get("entities", {}).items():
        sticker = entity.get("slots", {}).get("sticker")
        if not isinstance(sticker, dict):
            continue
        for set_id, set_data in list(sticker.get("sets", {}).items()):
            summary["total"] += 1
            storage_id = set_data.get("storage")
            storage = manifest.get("storage", {}).get(storage_id)
            if not isinstance(storage, dict) or storage.get("kind") != "image-dir":
                continue

            base = out_dir / str(storage.get("base", ""))
            variant_pairs = [
                (variant, base / str(variant.get("path")))
                for variant in set_data.get("variants") or []
                if isinstance(variant, dict) and variant.get("path")
            ]
            skipped_variants = [
                {
                    "id": variant.get("id"),
                    "ordinal": variant.get("ordinal"),
                    "path": path.name,
                    "reason": "gif",
                }
                for variant, path in variant_pairs
                if path.suffix.lower() == ".gif"
            ]
            if skipped_variants:
                summary["skipped_variants"] += len(skipped_variants)
                variant_pairs = [
                    (variant, path)
                    for variant, path in variant_pairs
                    if path.suffix.lower() != ".gif"
                ]
                set_data["variants"] = [variant for variant, _ in variant_pairs]

            record: dict[str, Any] = {
                "entity": entity_id,
                "set": set_id,
                "storage": storage_id,
                "frames": len(set_data.get("variants") or []),
                "encoded_frames": len(variant_pairs),
            }
            if skipped_variants:
                record["skipped_variants"] = skipped_variants

            job = {
                "entity": entity,
                "set_id": set_id,
                "set_data": set_data,
                "storage_id": storage_id,
                "storage": storage,
                "variants": [variant for variant, _ in variant_pairs],
                "image_paths": [path for _, path in variant_pairs],
                "output_rel": Path("blobs")
                / "stickers"
                / entity_id
                / f"{set_id}.avifs",
                "record": record,
            }
            if variant_pairs:
                jobs.append(job)
            else:
                record["status"] = "skipped"
                record["reason"] = "no encodable image after per-file filtering"
                immediate.append(job)

    def apply_result(result: dict[str, Any], report: Any) -> None:
        record = result["record"]
        status = record["status"]
        summary["original_bytes"] += int(record.get("original_bytes") or 0)
        if status in {"encoded", "reused"}:
            thumbnail_storage_id = "thumbnails"
            manifest["storage"].setdefault(
                thumbnail_storage_id,
                {"kind": "image-dir", "base": "assets/thumbnails"},
            )
            thumbnail_prefix = f"{record['entity']}/sticker/{result['set_id']}/"
            thumbnail_names = result["thumbnail_names"]
            for index, variant in enumerate(result["variants"]):
                resource_id = f"{thumbnail_prefix}{variant['id']}"
                thumbnail = manifest.get("thumbnails", {}).get(resource_id)
                if thumbnail is not None:
                    thumbnail["storage"] = thumbnail_storage_id
                    thumbnail["path"] = (
                        f"{record['entity']}/{result['set_id']}/{thumbnail_names[index]}"
                    )
            valid_thumbnail_ids = {
                f"{thumbnail_prefix}{variant['id']}" for variant in result["variants"]
            }
            for resource_id in list(manifest.get("thumbnails", {})):
                if resource_id.startswith(thumbnail_prefix) and resource_id not in valid_thumbnail_ids:
                    manifest["thumbnails"].pop(resource_id, None)
            for index, variant in enumerate(result["variants"]):
                variant.pop("path", None)
                variant["frame"] = index
            storage = result["storage"]
            storage.clear()
            storage.update(result["storage_update"])
            summary["encoded"] += 1
            summary["compressed_bytes"] += int(record.get("bytes") or 0)
        elif status == "skipped":
            thumbnail_prefix = f"{record['entity']}/sticker/{result['set_id']}/"
            for resource_id in list(manifest.get("thumbnails", {})):
                if resource_id.startswith(thumbnail_prefix):
                    manifest["thumbnails"].pop(resource_id, None)
            _drop_sticker_set(
                manifest, result["entity"], result["set_id"], result["storage_id"]
            )
            summary["skipped_sets"] += 1
        else:
            summary["failed"] += 1
            summary["failures"].append(record)

        report.write(json.dumps(record, ensure_ascii=False) + "\n")
        report.flush()
        done = summary["encoded"] + summary["failed"] + summary["skipped_sets"]
        if done == 1 or done % 25 == 0 or done == len(jobs) + len(immediate):
            print(
                f"[encode] processed={done} ok={summary['encoded']} "
                f"skipped={summary['skipped_sets']} failed={summary['failed']} "
                f"last={record['entity']}/{record['set']}",
                flush=True,
            )

    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("w", encoding="utf-8") as report:
        for job in immediate:
            apply_result(job, report)
        with ThreadPoolExecutor(
            max_workers=max(1, int(args.avif_concurrency))
        ) as executor:
            futures = [executor.submit(run_one, job) for job in jobs]
            for future in as_completed(futures):
                apply_result(future.result(), report)

    if summary["original_bytes"]:
        summary["compression_ratio"] = round(
            summary["compressed_bytes"] / summary["original_bytes"], 6
        )

    return summary


async def main_async(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir).resolve()
    student_ids = list(args.student_id or [])
    if args.student_ids:
        student_ids.extend(
            int(x.strip()) for x in args.student_ids.split(",") if x.strip()
        )
    student_ids = list(dict.fromkeys(student_ids))

    async with KivoWikiClient(
        timeout=float(args.timeout), user_agent=args.user_agent
    ) as client:
        if not student_ids:
            try:
                student_ids = await _fetch_student_ids(
                    client,
                    page_size=int(args.page_size),
                    include_npc=bool(args.include_npc),
                    limit=int(args.limit) if args.limit is not None else None,
                )
            except ApiError as exc:
                print(f"[error] failed to fetch student list: {exc}", file=sys.stderr)
                return 2

        if args.limit is not None and args.student_id:
            student_ids = student_ids[: int(args.limit)]

        if not student_ids:
            print("[error] no student ids selected", file=sys.stderr)
            return 2

        print(f"[info] fetching {len(student_ids)} student detail record(s)")
        fetch_sem = asyncio.Semaphore(int(args.concurrency))
        detail_results = await asyncio.gather(
            *[_fetch_detail(client, sid, semaphore=fetch_sem) for sid in student_ids]
        )

        details: list[dict[str, Any]] = []
        errors: list[dict[str, Any]] = []
        api_versions: dict[int, str] = {}
        api_times: dict[int, int] = {}
        for student_id, detail, err, version, api_time in detail_results:
            if err or detail is None:
                errors.append({"id": student_id, "error": err or "unknown error"})
                continue
            details.append(detail)
            api_versions[student_id] = version
            api_times[student_id] = api_time

        if not details:
            _write_json(
                out_dir / "build_errors.json",
                {"errors": errors, "generated_at": _utc_now_iso()},
            )
            print(
                f"[error] no details fetched; see {out_dir / 'build_errors.json'}",
                file=sys.stderr,
            )
            return 1

        if args.save_raw:
            for detail in details:
                student_id = int(detail.get("id") or 0)
                _write_json(
                    out_dir / "sources" / "kivo" / "students" / f"{student_id}.json",
                    detail,
                )

        manifest, tasks = _build_manifest(
            details,
            namespace=args.namespace,
            pack_name=args.pack_name,
            pack_version=args.pack_version,
            out_dir=out_dir,
            gallery_mode=args.gallery_mode,
            excluded_gallery_titles=list(args.exclude_gallery_title),
            max_gallery_images=int(args.max_gallery_images)
            if args.max_gallery_images is not None
            else None,
            nickname_names=bool(args.nickname_names),
            english_names=bool(args.english_names),
            api_versions=api_versions,
            api_times=api_times,
        )

        _write_json(out_dir / "manifest.json", manifest)
        report: dict[str, Any] = {
            "generated_at": _utc_now_iso(),
            "student_ids": student_ids,
            "entities": len(manifest["entities"]),
            "name_conflicts": _entity_name_conflicts(manifest),
            "download_tasks": len(tasks),
            "detail_errors": errors,
            "dry_run": bool(args.dry_run),
        }

        if args.dry_run:
            _write_json(out_dir / "build_report.json", report)
            print(f"[ok] wrote draft manifest to {out_dir / 'manifest.json'} (dry-run)")
            return 0 if not errors else 1

        print(f"[info] downloading {len(tasks)} resource file(s)")
        download_sem = asyncio.Semaphore(
            int(args.download_concurrency or args.concurrency)
        )
        download_results = await asyncio.gather(
            *[
                _download_one(
                    client,
                    task,
                    semaphore=download_sem,
                    resume=bool(args.resume),
                    timeout=float(args.download_timeout),
                )
                for task in tasks
            ]
        )
        failures = [
            {
                "label": task.label,
                "url": task.url,
                "target": str(task.target),
                "error": err,
            }
            for task, ok, err in download_results
            if not ok
        ]
        report["downloaded"] = len(tasks) - len(failures)
        report["download_failures"] = failures

        if args.encode_avifs and not failures:
            print("[info] encoding sticker sets to AVIFS")
            encode_summary = _encode_avif_sequences(out_dir, manifest, args)
            report["encode"] = encode_summary
            _write_json(out_dir / "manifest.json", manifest)

        _write_json(out_dir / "build_report.json", report)

        encode_failures = int((report.get("encode") or {}).get("failed") or 0)
        if failures or errors or encode_failures:
            print(
                f"[warn] wrote manifest but had {len(errors)} detail error(s), "
                f"{len(failures)} download failure(s), {encode_failures} encode failure(s); "
                f"see {out_dir / 'build_report.json'}"
            )
            return 1

        print(f"[ok] built draft pack at {out_dir}")
        return 0


def build_argparser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Build a draft MomoScript pack-v3 from Kivo Wiki resources."
    )
    parser.add_argument(
        "--out-dir",
        default="typst_sandbox/pack-v3/ba_kivo",
        help="Output pack directory.",
    )
    parser.add_argument(
        "--namespace", default="ba", help="Pack namespace written to manifest."
    )
    parser.add_argument(
        "--pack-name",
        default="Kivo Wiki Blue Archive draft pack",
        help="Pack display name.",
    )
    parser.add_argument(
        "--pack-version",
        default=datetime.now().strftime("%Y.%m.%d"),
        help="Pack version.",
    )
    parser.add_argument(
        "--student-id",
        type=int,
        action="append",
        help="Kivo student id to include. Can repeat.",
    )
    parser.add_argument(
        "--student-ids", default="", help="Comma-separated Kivo student ids to include."
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Limit fetched students when using list mode.",
    )
    parser.add_argument(
        "--include-npc", action="store_true", help="Include NPCs in list mode."
    )
    parser.add_argument(
        "--page-size", type=int, default=100, help="Kivo list page size."
    )
    parser.add_argument(
        "--concurrency", type=int, default=12, help="Concurrent API detail fetches."
    )
    parser.add_argument(
        "--download-concurrency",
        type=int,
        default=None,
        help="Concurrent resource downloads.",
    )
    parser.add_argument(
        "--timeout", type=float, default=20.0, help="API timeout seconds."
    )
    parser.add_argument(
        "--download-timeout",
        type=float,
        default=45.0,
        help="Resource download timeout seconds.",
    )
    parser.add_argument(
        "--user-agent",
        default="MomoScript-pack-v3-builder/0.1",
        help="HTTP User-Agent.",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Skip downloads for existing non-empty files.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Write manifest/report only; do not download files.",
    )
    parser.add_argument(
        "--save-raw",
        action="store_true",
        help="Save raw Kivo student detail JSON under sources/kivo.",
    )
    parser.add_argument(
        "--gallery-mode",
        choices=["sticker-like", "all", "none"],
        default="sticker-like",
        help="Which Kivo gallery groups become sticker sets.",
    )
    parser.add_argument(
        "--exclude-gallery-title",
        action="append",
        default=list(DEFAULT_EXCLUDED_GALLERY_TITLES),
        help="Substring of gallery titles to exclude in sticker-like mode. Can repeat.",
    )
    parser.add_argument(
        "--max-gallery-images",
        type=int,
        default=None,
        help="Cap images per gallery set for tests.",
    )
    parser.add_argument(
        "--nickname-names",
        "--nickname-handles",
        dest="nickname_names",
        action="store_true",
        help="Promote Kivo nicknames to deterministic entity names.",
    )
    parser.add_argument(
        "--english-names",
        "--english-handles",
        dest="english_names",
        action="store_true",
        help="Add generated English entity names.",
    )
    parser.add_argument(
        "--encode-avifs",
        action="store_true",
        help="Encode sticker image dirs to AVIFS sequences.",
    )
    parser.add_argument(
        "--avif-qcolor", type=int, default=80, help="AVIF color quality."
    )
    parser.add_argument(
        "--avif-qalpha", type=int, default=80, help="AVIF alpha quality."
    )
    parser.add_argument(
        "--avif-yuv",
        choices=["420", "422", "444"],
        default="420",
        help="AVIF chroma format.",
    )
    parser.add_argument(
        "--avif-keyframe", type=int, default=30, help="AVIF sequence keyframe interval."
    )
    parser.add_argument("--avif-speed", type=int, default=8, help="avifenc speed.")
    parser.add_argument("--avif-jobs", default="4", help="avifenc worker jobs.")
    parser.add_argument(
        "--avif-concurrency",
        type=int,
        default=4,
        help="Sticker sets encoded concurrently; each avifenc also uses --avif-jobs.",
    )
    parser.add_argument(
        "--sticker-max-canvas-pixels",
        type=int,
        default=2_000_000,
        help="Drop sticker sets whose padded canvas exceeds this many pixels.",
    )
    parser.add_argument(
        "--sticker-max-aspect-ratio",
        type=float,
        default=2.0,
        help="Drop sticker sets whose padded canvas aspect ratio exceeds this value.",
    )
    parser.add_argument(
        "--avif-max-canvas-pixels",
        type=int,
        default=8_000_000,
        help="Skip encoding sets whose padded canvas would exceed this many pixels.",
    )
    parser.add_argument(
        "--avif-max-canvas-edge",
        type=int,
        default=3000,
        help="Skip encoding sets whose padded canvas width or height exceeds this value.",
    )
    return parser


def main() -> int:
    return asyncio.run(main_async(build_argparser().parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
