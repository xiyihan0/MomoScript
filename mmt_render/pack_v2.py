from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Optional


_PACK_ID_RE = re.compile(r"^[A-Za-z0-9_]+$")


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _is_safe_relpath(s: str) -> bool:
    ss = (s or "").strip().replace("\\", "/")
    if not ss:
        return False
    if "://" in ss or ss.startswith("//"):
        return False
    if re.match(r"^[A-Za-z]:", ss):
        return False
    parts = [p for p in ss.split("/") if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return False
    return True


@dataclass(frozen=True)
class PackManifest:
    pack_id: str
    name: str = ""
    version: str = ""
    type: str = "base"  # base|extension
    eula_required: bool = False
    eula_title: str = ""
    eula_url: str = ""


@dataclass(frozen=True)
class CharacterAssets:
    char_id: str
    avatar: str  # relpath under pack root; may be "" for extension packs (inherit from base)
    expressions_dir: str  # relpath under pack root
    tags: str = "tags.json"  # file name under expressions_dir


@dataclass(frozen=True)
class PackV2:
    root: Path
    manifest: PackManifest
    aliases_to_id: Dict[str, str]
    id_to_assets: Dict[str, CharacterAssets]

    def resolve_char_id(self, token: str) -> Optional[str]:
        t = (token or "").strip()
        if not t:
            return None
        return self.aliases_to_id.get(t) or (t if t in self.id_to_assets else None)

    def tags_path(self, char_id: str) -> Path:
        assets = self.id_to_assets[char_id]
        return (self.root / assets.expressions_dir / assets.tags).resolve()

    def avatar_path(self, char_id: str) -> Path:
        assets = self.id_to_assets[char_id]
        if not assets.avatar:
            raise FileNotFoundError(f"avatar is not provided for {char_id} in pack {self.manifest.pack_id}")
        return (self.root / assets.avatar).resolve()


def load_pack_v2(pack_root: Path) -> PackV2:
    pack_root = Path(pack_root).resolve()
    if not pack_root.exists():
        raise FileNotFoundError(pack_root)

    pack_id = pack_root.name
    if not _PACK_ID_RE.match(pack_id):
        raise ValueError(f"invalid pack_id dir name: {pack_id}")

    manifest_path = pack_root / "manifest.json"
    char_id_path = pack_root / "char_id.json"
    mapping_path = pack_root / "asset_mapping.json"
    if not manifest_path.exists():
        raise FileNotFoundError(f"missing manifest.json: {manifest_path}")
    if not char_id_path.exists():
        raise FileNotFoundError(f"missing char_id.json: {char_id_path}")
    if not mapping_path.exists():
        raise FileNotFoundError(f"missing asset_mapping.json: {mapping_path}")

    raw_manifest = _read_json(manifest_path)
    if not isinstance(raw_manifest, dict):
        raise ValueError("manifest.json must be an object")
    mid = str(raw_manifest.get("pack_id") or "").strip()
    if mid and mid != pack_id:
        raise ValueError(f"manifest.pack_id mismatch: {mid} != {pack_id}")

    eula = raw_manifest.get("eula") if isinstance(raw_manifest.get("eula"), dict) else {}
    manifest = PackManifest(
        pack_id=pack_id,
        name=str(raw_manifest.get("name") or "").strip(),
        version=str(raw_manifest.get("version") or "").strip(),
        type=str(raw_manifest.get("type") or "base").strip() or "base",
        eula_required=bool(eula.get("required")) if isinstance(eula, dict) else False,
        eula_title=str(eula.get("title") or "").strip() if isinstance(eula, dict) else "",
        eula_url=str(eula.get("url") or "").strip() if isinstance(eula, dict) else "",
    )

    raw_alias = _read_json(char_id_path)
    if not isinstance(raw_alias, dict):
        raise ValueError("char_id.json must be an object")
    aliases: Dict[str, str] = {}
    for k, v in raw_alias.items():
        if not isinstance(k, str) or not isinstance(v, str):
            continue
        kk = k.strip()
        vv = v.strip()
        if not kk or not vv:
            continue
        aliases[kk] = vv

    raw_map = _read_json(mapping_path)
    if not isinstance(raw_map, dict):
        raise ValueError("asset_mapping.json must be an object")

    id_to_assets: Dict[str, CharacterAssets] = {}
    for char_id, obj in raw_map.items():
        if not isinstance(char_id, str) or not isinstance(obj, dict):
            continue
        cid = char_id.strip()
        if not cid:
            continue
        avatar = str(obj.get("avatar") or "").strip()
        expr_dir = str(obj.get("expressions_dir") or "").strip()
        tags = str(obj.get("tags") or "tags.json").strip() or "tags.json"
        if not avatar:
            if manifest.type != "extension":
                raise ValueError(f"missing avatar path for {cid} in base pack")
        else:
            if not _is_safe_relpath(avatar):
                raise ValueError(f"invalid avatar path for {cid}: {avatar}")
        if not _is_safe_relpath(expr_dir):
            raise ValueError(f"invalid expressions_dir for {cid}: {expr_dir}")
        if "/" in tags or "\\" in tags or ".." in tags:
            raise ValueError(f"invalid tags file name for {cid}: {tags}")
        id_to_assets[cid] = CharacterAssets(char_id=cid, avatar=avatar, expressions_dir=expr_dir, tags=tags)

    # Ensure self ids are resolvable even without aliases.
    for cid in id_to_assets.keys():
        aliases.setdefault(cid, cid)

    return PackV2(root=pack_root, manifest=manifest, aliases_to_id=aliases, id_to_assets=id_to_assets)


def validate_pack_v2(pack_root: Path) -> None:
    pack = load_pack_v2(pack_root)
    # Basic file existence checks (best-effort)
    for cid, assets in pack.id_to_assets.items():
        _ = assets
        avatar = None
        if assets.avatar:
            avatar = pack.avatar_path(cid)
        tags = pack.tags_path(cid)
        if avatar is not None and not avatar.exists():
            raise FileNotFoundError(f"missing avatar for {cid}: {avatar}")
        if not tags.exists():
            raise FileNotFoundError(f"missing tags.json for {cid}: {tags}")
