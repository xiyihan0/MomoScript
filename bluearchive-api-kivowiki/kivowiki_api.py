"""
Simple wrapper for the first two endpoints of https://api.kivo.wiki.

Endpoints covered:
1) GET /api/v1/data/students
2) GET /api/v1/data/students/{student_id}

Dependencies:
- curl-cffi (HTTP requests)
- pydantic (data validation / typing)

This module is fully async. Use `asyncio.run(...)` or call from an async context.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from curl_cffi import requests as curl_requests
from pydantic import BaseModel, ConfigDict, Field, model_validator

BASE_URL = "https://api.kivo.wiki/api/v1"


class ApiError(Exception):
    """Raised when the Kivo API cannot be reached or returns an error."""


def _normalize_params(params: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize query parameters (drop None, bool -> 'true'/'false')."""
    cleaned: dict[str, Any] = {}
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, bool):
            cleaned[key] = "true" if value else "false"
        else:
            cleaned[key] = value
    return cleaned


class KivoWikiClient:
    def __init__(
        self,
        base_url: str = BASE_URL,
        *,
        timeout: float = 10.0,
        user_agent: str = "kivowiki-api-wrapper/1.0",
        impersonate: str | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.user_agent = user_agent
        self.impersonate = impersonate
        self._session: curl_requests.AsyncSession | None = None

    async def __aenter__(self) -> "KivoWikiClient":
        if self._session is None:
            self._session = curl_requests.AsyncSession()
            self._session.headers.update({"User-Agent": self.user_agent})
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._session is not None:
            await self._session.close()
            self._session = None

    async def get_json(self, path: str, *, params: Optional[Dict[str, Any]] = None) -> Any:
        url = f"{self.base_url}{path}"
        if self._session is None:
            raise RuntimeError("Client session is not initialized. Use 'async with KivoWikiClient()'.")

        try:
            resp = await self._session.get(
                url,
                params=_normalize_params(params or {}),
                timeout=self.timeout,
                impersonate=self.impersonate,
            )
        except Exception as exc:  # curl-cffi can raise various transport errors
            raise ApiError(f"Could not reach server: {exc}") from exc

        if resp.status_code >= 400:
            body = getattr(resp, "text", "")
            raise ApiError(f"Request failed with {resp.status_code}: {body}")

        try:
            return resp.json()
        except Exception as exc:
            body = getattr(resp, "text", "")
            raise ApiError(f"Invalid JSON response: {body[:200]}") from exc

    async def get_students_raw(self, page: int, page_size: int, **filters: Any) -> Any:
        params: dict[str, Any] = {"page": page, "page_size": page_size}
        params.update(filters)
        return await self.get_json("/data/students", params=params)

    async def get_student_raw(self, student_id: int) -> Any:
        return await self.get_json(f"/data/students/{student_id}")


async def get_students(page: int, page_size: int, **filters: Any) -> Any:
    """
    Fetch the student list.

    Required parameters:
        page (int): Page number starting from 1.
        page_size (int): Number of items per page.

    Optional filters map directly to the API docs, e.g.:
        character_data_search, name_sort, id_sort, height_sort,
        birthday_sort, release_date_sort, release_date_global_sort,
        release_date_cn_sort, battlefield_position, attack_attribute,
        type, school, is_npc, is_install, is_install_global, is_install_cn,
        is_group_control, is_skin, special_apperance, rarity, limited,
        defensive_attributes, team_position, weapon_type, eqipment,
        birthday, body_shape, designer, illustrator, outdoor_adaptability,
        indoor_adaptability, street_adaptability.
    Extra keys in **filters will also be forwarded as query parameters.
    """
    async with KivoWikiClient() as client:
        return await client.get_students_raw(page=page, page_size=page_size, **filters)


async def get_student(student_id: int) -> Any:
    """
    Fetch detailed info for a single student by ID.

    Args:
        student_id: Numerical student ID from the list endpoint.
    """
    async with KivoWikiClient() as client:
        return await client.get_student_raw(student_id)


# --- Data models -----------------------------------------------------------


class ApiResponseBase(BaseModel):
    model_config = ConfigDict(extra="ignore")

    code: int = 0
    codename: str = ""
    message: str = ""
    success: bool = False
    time: int = 0
    version: str = ""


class StudentSummary(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    skin: str = ""
    skin_jp: str = ""
    skin_cn: str = ""
    skin_zh_tw: str = ""
    family_name: str = ""
    given_name: str = ""
    family_name_jp: str = ""
    given_name_jp: str = ""
    family_name_cn: str = ""
    given_name_cn: str = ""
    avatar: str = ""
    school: int = 0
    main_relation: int = 0


class StudentListData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    max_page: int
    students: List[StudentSummary] = Field(default_factory=list)


class SkinVariant(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    avatar: str = ""
    skin: str = ""
    skin_cn: str = ""


class VoiceLine(BaseModel):
    model_config = ConfigDict(extra="ignore")

    description: str = ""
    category: str = ""
    text: str = ""
    text_original: str = ""
    file: str = ""


class Gallery(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = ""
    images: List[str] = Field(default_factory=list)


class GiftData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    favorability: int = 0


class SkillInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    cost: Optional[int] = None
    describe: str = ""


class Skill(BaseModel):
    model_config = ConfigDict(extra="ignore")

    icon: str = ""
    title: str = ""
    title_cn: str = ""
    preview: str = ""
    max_level: int = 0
    link_student_id: int = 0
    is_passive_skill: bool = False
    derived_skills: List[Any] = Field(default_factory=list)
    info: List[SkillInfo] = Field(default_factory=list)


class SkillSet(BaseModel):
    model_config = ConfigDict(extra="allow")

    ex_skill: List[Skill] = Field(default_factory=list)
    passive_skill: List[Skill] = Field(default_factory=list)
    normal_attack: List[Skill] = Field(default_factory=list)
    sub_skill: List[Skill] = Field(default_factory=list)
    extra: Dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _collect_extra(self) -> "SkillSet":
        extra = getattr(self, "__pydantic_extra__", None) or {}
        known = {"ex_skill", "passive_skill", "normal_attack", "sub_skill", "extra"}
        self.extra = {k: v for k, v in extra.items() if k not in known}
        return self


class CharacterData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    character_id: int = 0
    dev_name: str = ""
    combat_style: str = ""
    type: str = ""
    attack_attribute: str = ""
    defensive_attributes: str = ""
    is_groupc_control: bool = False
    team_position: str = ""
    battlefield_position: str = ""
    rarity: int = 0
    limited: bool = False
    outdoor_adaptability: str = ""
    indoor_adaptability: str = ""
    street_adaptability: str = ""
    equipment: List[int] = Field(default_factory=list)
    cultivate_material: List[int] = Field(default_factory=list)
    favorite_equipment: Optional[int] = None
    skill: SkillSet = Field(default_factory=SkillSet)


class Stats(BaseModel):
    model_config = ConfigDict(extra="ignore")

    max_hp: int = 0
    attack: int = 0
    defense: int = 0
    healing: int = 0
    accuracy: int = 0
    evasion: int = 0
    crit: int = 0
    crit_res: int = 0
    crit_dmg: int = 0
    crit_dmg_res: int = 0
    stability: int = 0
    range: int = 0
    cc_power: int = 0
    cc_res: int = 0
    recovery_boost: int = 0
    mag_count: int = 0


class WeaponInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = ""
    description: str = ""


class Weapons(BaseModel):
    model_config = ConfigDict(extra="ignore")

    icon: str = ""
    name: str = ""
    name_cn: str = ""
    description: str = ""
    description_cn: str = ""
    info: List[WeaponInfo] = Field(default_factory=list)
    skill: List[Skill] = Field(default_factory=list)


class StudentDetail(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: int
    skin: str = ""
    skin_jp: str = ""
    skin_cn: str = ""
    skin_zh_tw: str = ""
    skin_list: List[SkinVariant] = Field(default_factory=list)
    family_name: str = ""
    given_name: str = ""
    family_name_jp: str = ""
    given_name_jp: str = ""
    family_name_kr: str = ""
    given_name_kr: str = ""
    family_name_en: str = ""
    given_name_en: str = ""
    family_name_zh_tw: str = ""
    given_name_zh_tw: str = ""
    family_name_cn: str = ""
    given_name_cn: str = ""
    nick_name: str = ""
    introduction: str = ""
    introduction_cn: str = ""
    momo_talk_signature: str = ""
    main_relation: Optional[int] = None
    relation: List[int] = Field(default_factory=list)
    age: Optional[int] = None
    grade: str = ""
    height: Optional[int] = None
    birthday: str = ""
    hobby: str = ""
    designer: str = ""
    illustrator: str = ""
    character_voice: str = ""
    character_voice_cn: str = ""
    release_date: str = ""
    release_date_cn: str = ""
    release_date_global: str = ""
    sd_model_image: str = ""
    avatar: str = ""
    school: Optional[int] = None
    weapon_type: str = ""
    is_install: Optional[bool] = None
    is_install_cn: Optional[bool] = None
    is_install_global: Optional[bool] = None
    is_npc: Optional[bool] = None
    show_list: Optional[bool] = None
    body_shape: str = ""
    special_appearance: Optional[bool] = None
    more: str = ""
    recollection_lobby_image: str = ""
    spine: List[int] = Field(default_factory=list)
    model: List[int] = Field(default_factory=list)
    voice_play_icon: str = ""
    voice_pause_icon: str = ""
    voice: List[VoiceLine] = Field(default_factory=list)
    gallery: List[Gallery] = Field(default_factory=list)
    gift_data: List[GiftData] = Field(default_factory=list)
    furniture: List[int] = Field(default_factory=list)
    character_datas: List[CharacterData] = Field(default_factory=list)
    basic: List[Stats] = Field(default_factory=list)
    weapons: Optional[Weapons] = None
    source: List[Any] = Field(default_factory=list)
    contributor: List[Any] = Field(default_factory=list)
    info_declare_uuid: str = ""
    skill_declare_uuid: str = ""
    supplementary_uuid: str = ""
    supplementary_declare_uuid: str = ""
    created_at: Optional[int] = None
    updated_at: Optional[int] = None


class StudentListResponse(ApiResponseBase):
    data: StudentListData = Field(default_factory=lambda: StudentListData(max_page=0))


class StudentDetailResponse(ApiResponseBase):
    data: StudentDetail = Field(default_factory=lambda: StudentDetail(id=0))


def parse_student_list_response(raw: Dict[str, Any]) -> StudentListResponse:
    """Convert the /data/students response JSON into a typed pydantic model."""
    return StudentListResponse.model_validate(raw)


def parse_student_detail_response(raw: Dict[str, Any]) -> StudentDetailResponse:
    """Convert the /data/students/{id} response JSON into a typed pydantic model."""
    return StudentDetailResponse.model_validate(raw)


async def get_students_parsed(page: int, page_size: int, **filters: Any) -> StudentListResponse:
    """Convenience wrapper returning a parsed model instead of raw JSON."""
    raw = await get_students(page=page, page_size=page_size, **filters)
    return parse_student_list_response(raw)


async def get_student_parsed(student_id: int) -> StudentDetailResponse:
    """Convenience wrapper returning a parsed model instead of raw JSON."""
    raw = await get_student(student_id)
    return parse_student_detail_response(raw)


# Optional: quick smoke test
async def _smoke() -> None:
    students = await get_students_parsed(page=1, page_size=1)
    sid = students.data.students[0].id if students.data.students else None
    if sid is not None:
        await get_student_parsed(sid)


if __name__ == "__main__":
    asyncio.run(_smoke())
