from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from tools import build_kivo_pack_v3 as builder


class EntityCatalogBuilderTests(unittest.TestCase):
    def test_catalog_preserves_search_metadata_without_changing_manifest_names(self) -> None:
        details = [
            self._detail(
                76,
                skin="",
                nick_name="大叔、星野",
                skin_list=[{"id": 76}, {"id": 42, "skin_cn": "泳装"}],
            ),
            self._detail(
                42,
                skin="泳装",
                nick_name="水星野、水大叔",
                skin_list=[{"id": 76}, {"id": 42, "skin_cn": "泳装"}],
            ),
        ]
        with tempfile.TemporaryDirectory() as directory:
            manifest, _tasks, skipped = builder._build_manifest(
                details,
                namespace="ba",
                pack_name="Fixture Pack",
                pack_version="2026.08.16",
                out_dir=Path(directory),
                gallery_mode="none",
                excluded_gallery_titles=[],
                max_gallery_images=None,
                nickname_names=False,
                english_names=False,
                excluded_entity_markers=[],
                base_url="https://example.invalid/ba/",
            )

        self.assertEqual(skipped, [])
        self.assertEqual(manifest["entities"]["星野"]["names"], ["星野"])
        self.assertNotIn("大叔", manifest["entities"]["星野"]["names"])
        self.assertNotIn("meta", manifest["entities"]["星野"])

        manifest_bytes = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
        manifest_digest = hashlib.sha256(manifest_bytes).hexdigest()
        catalog = builder._build_entity_catalog(
            details,
            manifest=manifest,
            manifest_sha256=manifest_digest,
            schools=[{"id": 1, "name": "阿比多斯高中", "name_cn": "阿拜多斯高等学院"}],
            relations=[{"id": 19, "name": "废校对策委员会", "name_cn": "对策委员会"}],
            api_versions=["1.0.0-beta.43"],
            api_times=[1786869555, 1786869559],
            generated_at="2026-08-16T00:00:00+00:00",
        )

        self.assertEqual(catalog["schema"], "mmt-pack-entity-catalog.v1")
        self.assertEqual(catalog["pack"]["manifest_sha256"], manifest_digest)
        self.assertEqual(catalog["source"]["license"]["id"], "CC-BY-SA-4.0")
        self.assertEqual(catalog["source"]["license"]["terms_url"], "https://kivo.wiki/license")
        self.assertTrue(catalog["source"]["transformed"])
        self.assertEqual(catalog["source"]["api_time_range"], {"first": 1786869555, "last": 1786869559})
        self.assertEqual(catalog["entities"]["星野"]["names"]["aliases"]["zh-CN"], ["大叔", "星野"])
        self.assertEqual(catalog["entities"]["星野_泳装"]["names"]["display"]["zh-CN"], "星野（泳装）")
        self.assertEqual(
            catalog["entities"]["星野"]["related_entities"],
            [{"kind": "alternate_skin", "entity": "ba::星野_泳装"}],
        )
        self.assertEqual(catalog["entities"]["星野"]["affiliation"]["school"], "1")
        self.assertEqual(catalog["entities"]["星野"]["affiliation"]["main_relation"], "19")
        self.assertEqual(
            catalog["taxonomies"]["schools"]["1"],
            {"display_name": "阿拜多斯高等学院", "aliases": ["阿比多斯高中"]},
        )
        self.assertEqual(
            catalog["taxonomies"]["relations"]["19"],
            {"display_name": "对策委员会", "aliases": ["废校对策委员会"]},
        )

    def test_schema_contract_is_strict_and_matches_builder_discriminator(self) -> None:
        schema_path = (
            Path(__file__).resolve().parents[2]
            / "openspec"
            / "changes"
            / "design-resource-pack-v3"
            / "schemas"
            / "mmt-pack-entity-catalog.v1.schema.json"
        )
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        self.assertEqual(schema["properties"]["schema"]["const"], builder.ENTITY_CATALOG_SCHEMA)
        self.assertFalse(schema["additionalProperties"])
        self.assertFalse(schema["$defs"]["entity"]["additionalProperties"])
        self.assertEqual(
            set(schema["required"]),
            {"schema", "generated_at", "pack", "source", "entities", "taxonomies"},
        )

    @staticmethod
    def _detail(
        student_id: int,
        *,
        skin: str,
        nick_name: str,
        skin_list: list[dict[str, object]],
    ) -> dict[str, object]:
        return {
            "id": student_id,
            "family_name": "小鳥遊",
            "family_name_cn": "小鸟游",
            "family_name_jp": "小鳥遊",
            "family_name_en": "Takanashi",
            "given_name": "ホシノ",
            "given_name_cn": "星野",
            "given_name_jp": "ホシノ",
            "given_name_en": "Hoshino",
            "skin": skin,
            "skin_cn": skin,
            "skin_jp": "水着" if skin else "",
            "nick_name": nick_name,
            "school": 1,
            "main_relation": 19,
            "relation": [19],
            "skin_list": skin_list,
            "character_datas": [{"character_id": 10000 + student_id}],
            "avatar": "https://example.invalid/avatar.png",
            "gallery": [],
        }


class TaxonomyFetchTests(unittest.IsolatedAsyncioTestCase):
    async def test_taxonomy_fetches_every_page_and_preserves_provenance(self) -> None:
        client = _FakeTaxonomyClient()
        records, versions, times = await builder._fetch_taxonomy(
            client,
            path="/data/schools",
            data_key="school",
            page_size=2,
        )
        self.assertEqual([record["id"] for record in records], [1, 2, 3])
        self.assertEqual(versions, ["v1", "v2"])
        self.assertEqual(times, [10, 11])
        self.assertEqual(client.pages, [1, 2])


class _FakeTaxonomyClient:
    def __init__(self) -> None:
        self.pages: list[int] = []

    async def get_json(self, _path: str, *, params: dict[str, object]) -> dict[str, object]:
        page = int(params["page"])
        self.pages.append(page)
        if page == 1:
            records = [{"id": 1, "name": "A"}, {"id": 2, "name": "B"}]
        else:
            records = [{"id": 3, "name": "C"}]
        return {
            "data": {"max_page": 2, "school": records},
            "version": f"v{page}",
            "time": 9 + page,
        }


if __name__ == "__main__":
    unittest.main()
