from __future__ import annotations

import contextlib
import hashlib
import io
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from tools import build_kivo_pack_v3 as builder
from tools import reconcile_pack_v3_manifest as reconciler


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



class AvifInspectionTests(unittest.TestCase):
    def test_inspect_avifs_parses_resolution_and_frames(self) -> None:
        fixture = Path(__file__).resolve().parents[2] / "mmt_rs/tests/fixtures/avifs/alpha-sequence.avifs"
        self.assertEqual(builder._inspect_avifs(fixture), ((1002, 896), 28))
        self.assertEqual(reconciler._inspect_avifs(fixture), ((1002, 896), 28))

    def test_inspect_avifs_returns_none_for_missing_or_corrupted_file(self) -> None:
        with tempfile.NamedTemporaryFile() as tmp:
            tmp.write(b"not an avifs")
            tmp.flush()
            self.assertIsNone(builder._inspect_avifs(Path(tmp.name)))
        self.assertIsNone(builder._inspect_avifs(Path("/tmp/nonexistent-avifs-file.avifs")))
    def test_both_inspectors_accept_single_frame_avifdec_output(self) -> None:
        output = (
            "Image decoded: one.avifs\n"
            " * Resolution     : 8x7\n"
            " * 1 timescales per second, 1.00 seconds (1 timescales), 1 frame\n"
        )
        with tempfile.NamedTemporaryFile() as temporary:
            with patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, output)):
                self.assertEqual(builder._inspect_avifs(Path(temporary.name)), ((8, 7), 1))
                self.assertEqual(reconciler._inspect_avifs(Path(temporary.name)), ((8, 7), 1))


class AvifEncodingTests(unittest.TestCase):
    @staticmethod
    def _pack(out_dir: Path) -> dict[str, object]:
        image = out_dir / "assets/stickers/demo/default/001.png"
        image.parent.mkdir(parents=True)
        image.write_bytes(b"source")
        return {
            "entities": {
                "demo": {
                    "slots": {
                        "sticker": {
                            "default": "default",
                            "sets": {
                                "default": {
                                    "storage": "images",
                                    "variants": [{"id": "one", "ordinal": 1, "path": "001.png"}],
                                }
                            },
                        }
                    }
                }
            },
            "storage": {"images": {"kind": "image-dir", "base": "assets/stickers/demo/default"}},
            "thumbnails": {"demo/sticker/default/one": {"storage": "images", "path": "001.png"}},
        }

    @staticmethod
    def _args(*, resume: bool) -> SimpleNamespace:
        return SimpleNamespace(
            avif_concurrency=1,
            avif_qcolor=80,
            avif_qalpha=80,
            avif_yuv="420",
            avif_keyframe=30,
            avif_speed=8,
            avif_jobs="4",
            resume=resume,
            sticker_max_canvas_pixels=1000,
            sticker_max_aspect_ratio=10,
            avif_max_canvas_pixels=1000,
            avif_max_canvas_edge=100,
        )

    @staticmethod
    def _thumbnail(_sources: object, directory: Path, *, resume: bool) -> list[str]:
        directory.mkdir(parents=True)
        (directory / "001.webp").write_bytes(b"thumbnail")
        return ["001.webp"]

    def test_resume_reuses_inspected_single_frame_blob(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            out_dir = Path(directory)
            manifest = self._pack(out_dir)
            output = out_dir / "blobs/stickers/demo/default.avifs"
            output.parent.mkdir(parents=True)
            output.write_bytes(b"verified frame")
            avifdec_output = "Image decoded: single.avifs\n * Resolution: 8x7\n * 1 frame\n"
            with (
                patch.object(builder, "_image_info", return_value=([(8, 7)], False)),
                patch.object(builder, "_prepare_thumbnails", side_effect=self._thumbnail),
                patch.object(builder, "_run_avifenc", side_effect=AssertionError("must reuse")),
                patch("subprocess.run", return_value=subprocess.CompletedProcess([], 0, avifdec_output)),
            ):
                summary = builder._encode_avif_sequences(out_dir, manifest, self._args(resume=True))

            record = json.loads((out_dir / "encode_report.jsonl").read_text(encoding="utf-8"))
            self.assertEqual((summary["encoded"], summary["failed"]), (1, 0))
            self.assertEqual(record["status"], "reused")
            self.assertEqual(
                (record["target_size"], record["target_frames"], record["measured_size"], record["measured_frames"]),
                ([8, 7], 1, [8, 7], 1),
            )
            self.assertEqual(manifest["storage"]["images"]["frame_count"], 1)
            self.assertEqual(manifest["storage"]["images"]["size"], [8, 7])
            self.assertTrue((out_dir / manifest["storage"]["images"]["path"]).is_file())

    def test_uninspectable_encoded_blob_cannot_be_published_as_success(self) -> None:
        def encode(_inputs: object, output: Path, **_options: object) -> subprocess.CompletedProcess[str]:
            output.parent.mkdir(parents=True)
            output.write_bytes(b"not inspectable")
            return subprocess.CompletedProcess([], 0, "encoded")

        with tempfile.TemporaryDirectory() as directory:
            out_dir = Path(directory)
            manifest = self._pack(out_dir)
            with (
                patch.object(builder, "_image_info", return_value=([(8, 7)], False)),
                patch.object(builder, "_run_avifenc", side_effect=encode),
                patch.object(builder, "_inspect_avifs", return_value=None),
                patch.object(builder, "_prepare_thumbnails", side_effect=self._thumbnail),
            ):
                summary = builder._encode_avif_sequences(out_dir, manifest, self._args(resume=False))

            record = json.loads((out_dir / "encode_report.jsonl").read_text(encoding="utf-8"))
            self.assertEqual((summary["encoded"], summary["failed"]), (0, 1))
            self.assertEqual(record["status"], "failed")
            self.assertEqual(record["target_size"], [8, 7])
            self.assertNotIn("measured_size", record)
            self.assertNotIn("measured_frames", record)
            self.assertEqual(manifest["storage"]["images"]["kind"], "image-dir")



class ManifestReconciliationTests(unittest.TestCase):
    @staticmethod
    def _manifest(frame_count: int = 23) -> dict[str, object]:
        variants = [{"id": f"v_{i}", "frame": i} for i in range(frame_count)]
        contribution_variants = [{"id": f"c_{i}", "frame": i} for i in range(frame_count)]
        return {
            "schema": "mmt-pack.v3",
            "pack": {"namespace": "ba", "name": "Fixture", "version": "1", "type": "base"},
            "storage": {
                "test_images": {
                    "kind": "image-sequence",
                    "path": "blobs/test.avifs",
                    "size": [772, 772],
                    "frame_count": frame_count,
                },
                "thumbnails": {"kind": "image-dir", "base": "assets/thumbnails"},
            },
            "entities": {
                "test_entity": {
                    "slots": {
                        "sticker": {
                            "default": "default",
                            "sets": {
                                "default": {"storage": "test_images", "variants": variants},
                                "spare": {
                                    "storage": "thumbnails",
                                    "variants": [{"id": "spare", "path": "spare.webp"}],
                                },
                            },
                        }
                    }
                }
            },
            "contributions": [
                {
                    "target": "ba::test_entity",
                    "slots": {
                        "sticker": {
                            "default": "default",
                            "sets": {
                                "default": {"storage": "test_images", "variants": contribution_variants},
                                "spare": {
                                    "storage": "thumbnails",
                                    "variants": [{"id": "extra", "path": "extra.webp"}],
                                },
                            },
                        }
                    },
                }
            ],
            "thumbnails": {
                "test_entity/sticker/default/v_0": {"storage": "thumbnails", "path": "v_0.webp"},
                "test_entity/sticker/default/v_22": {"storage": "thumbnails", "path": "v_22.webp"},
                "ba::test_entity/sticker/default/c_22": {
                    "storage": "thumbnails", "path": "c_22.webp"
                },
            },
        }

    @staticmethod
    def _record(*, frames: int = 21, size: tuple[int, int] = (433, 400)) -> dict[str, object]:
        return {
            "storage": "test_images",
            "status": "encoded",
            "target_size": [772, 772],
            "target_frames": 23,
            "measured_size": list(size),
            "measured_frames": frames,
        }

    def test_reconciles_entities_contributions_and_thumbnail_index(self) -> None:
        manifest = self._manifest()
        reconciled, discrepancies = reconciler.reconcile_manifest(manifest, [self._record()])
        self.assertEqual(len(discrepancies), 1)
        self.assertEqual(reconciled["storage"]["test_images"]["size"], [433, 400])
        self.assertEqual(reconciled["storage"]["test_images"]["frame_count"], 21)
        entity = reconciled["entities"]["test_entity"]["slots"]["sticker"]
        contribution = reconciled["contributions"][0]["slots"]["sticker"]
        for slot in (entity, contribution):
            self.assertEqual(
                [variant["frame"] for variant in slot["sets"]["default"]["variants"]],
                list(range(21)),
            )
            self.assertEqual(slot["default"], "default")
            self.assertIn("spare", slot["sets"])
        self.assertIn("test_entity/sticker/default/v_0", reconciled["thumbnails"])
        self.assertNotIn("test_entity/sticker/default/v_22", reconciled["thumbnails"])
        self.assertNotIn("ba::test_entity/sticker/default/c_22", reconciled["thumbnails"])
        self.assertEqual(manifest["storage"]["test_images"]["frame_count"], 23)

    def test_empty_default_set_is_removed_and_default_remains_valid(self) -> None:
        manifest = self._manifest(2)
        entity_slot = manifest["entities"]["test_entity"]["slots"]["sticker"]
        entity_slot["sets"]["default"]["variants"] = [{"id": "v_22", "frame": 22}]
        contribution_slot = manifest["contributions"][0]["slots"]["sticker"]
        contribution_slot["sets"]["default"]["variants"] = [{"id": "c_22", "frame": 22}]
        reconciled, _ = reconciler.reconcile_manifest(manifest, [self._record(frames=1)])
        for slot in (
            reconciled["entities"]["test_entity"]["slots"]["sticker"],
            reconciled["contributions"][0]["slots"]["sticker"],
        ):
            self.assertEqual(slot["default"], "spare")
            self.assertEqual(set(slot["sets"]), {"spare"})

    def test_failed_skipped_and_planned_only_reports_are_not_evidence(self) -> None:
        reports = [
            {**self._record(), "status": "failed"},
            {**self._record(), "status": "skipped"},
            {"storage": "test_images", "status": "encoded", "target_size": [1, 1], "target_frames": 1},
            {"storage": "test_images", "status": "reused", "measured_size": [1, 1], "encoded_frames": 1},
            {**self._record(), "measured_frames": 0},
        ]
        for report in reports:
            with self.subTest(report=report):
                with self.assertRaisesRegex(ValueError, "cannot verify"):
                    reconciler.reconcile_manifest(self._manifest(), [report])
        manifest = self._manifest()
        manifest["storage"]["test_images"]["sha256"] = "a" * 64
        with self.assertRaisesRegex(ValueError, "report AVIFS SHA-256"):
            reconciler.reconcile_manifest(manifest, [self._record()])
        report = {**self._record(), "blob_sha256": "b" * 64}
        with self.assertRaisesRegex(ValueError, "report AVIFS SHA-256"):
            reconciler.reconcile_manifest(manifest, [report])
        verified_report = {**self._record(), "blob_sha256": "a" * 64}
        repaired, _ = reconciler.reconcile_manifest(manifest, [verified_report])
        self.assertEqual(repaired["storage"]["test_images"]["frame_count"], 21)

    def test_local_inspection_wins_and_uninspectable_local_blob_never_uses_report(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pack_dir = Path(directory)
            blob = pack_dir / "blobs/test.avifs"
            blob.parent.mkdir()
            blob.write_bytes(b"local blob")
            with patch.object(reconciler, "_inspect_avifs", return_value=((12, 14), 2)):
                reconciled, _ = reconciler.reconcile_manifest(
                    self._manifest(), [self._record(frames=1)], pack_dir=pack_dir
                )
            self.assertEqual(reconciled["storage"]["test_images"]["size"], [12, 14])
            self.assertEqual(reconciled["storage"]["test_images"]["frame_count"], 2)
            with patch.object(reconciler, "_inspect_avifs", return_value=None):
                with self.assertRaisesRegex(ValueError, "local AVIFS blob cannot be inspected"):
                    reconciler.reconcile_manifest(
                        self._manifest(), [self._record(frames=1)], pack_dir=pack_dir
                    )
            manifest = self._manifest()
            manifest["storage"]["test_images"]["sha256"] = "0" * 64
            with patch.object(reconciler, "_inspect_avifs", return_value=((12, 14), 2)):
                with self.assertRaisesRegex(ValueError, "local AVIFS SHA-256"):
                    reconciler.reconcile_manifest(manifest, [self._record()], pack_dir=pack_dir)

    def test_apply_pairs_exact_manifest_catalog_and_report_digests(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pack_dir = Path(directory)
            manifest_path = pack_dir / "manifest.json"
            catalog_path = pack_dir / "entity-catalog.json"
            build_report_path = pack_dir / "build_report.json"
            encode_report_path = pack_dir / "encode_report.jsonl"
            manifest = self._manifest()
            manifest["storage"]["test_images"]["sha256"] = "a" * 64
            manifest_path.write_bytes(reconciler._json_bytes(manifest))
            catalog = {
                "schema": "mmt-pack-entity-catalog.v1",
                "generated_at": "2026-08-16T00:00:00+00:00",
                "pack": {
                    "namespace": "ba",
                    "version": "1",
                    "manifest_sha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
                },
                "source": {
                    "id": "kivo.wiki",
                    "name": "Kivo Wiki",
                    "url": "https://kivo.wiki",
                    "retrieved_at": "2026-08-16T00:00:00+00:00",
                    "transformed": True,
                    "license": {
                        "id": "CC-BY-SA-4.0",
                        "url": "https://creativecommons.org/licenses/by-sa/4.0/",
                        "terms_url": "https://kivo.wiki/license",
                        "attribution": "Kivo Wiki",
                    },
                },
                "entities": {},
                "taxonomies": {"schools": {}, "relations": {}},
            }
            catalog_path.write_bytes(reconciler._json_bytes(catalog))
            build_report_path.write_bytes(reconciler._json_bytes({
                "entity_catalog": {
                    "sha256": hashlib.sha256(catalog_path.read_bytes()).hexdigest()
                }
            }))
            encode_report_path.write_text(
                json.dumps({**self._record(), "blob_sha256": "a" * 64}) + "\n",
                encoding="utf-8",
            )

            stdout = io.StringIO()
            with (
                patch("sys.argv", ["reconcile", "--manifest", str(manifest_path),
                                   "--encode-report", str(encode_report_path)]),
                contextlib.redirect_stdout(stdout),
            ):
                self.assertEqual(reconciler.main(), 0)
            self.assertIn("found 1 sequence", stdout.getvalue())
            self.assertEqual(json.loads(manifest_path.read_text())["storage"]["test_images"]["frame_count"], 23)
            before_catalog = catalog_path.read_bytes()

            with (
                patch("sys.argv", ["reconcile", "--manifest", str(manifest_path),
                                   "--encode-report", str(encode_report_path), "--apply"]),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(reconciler.main(), 0)
            manifest_bytes = manifest_path.read_bytes()
            catalog_bytes = catalog_path.read_bytes()
            self.assertNotEqual(before_catalog, catalog_bytes)
            self.assertEqual(
                json.loads(catalog_bytes)["pack"]["manifest_sha256"],
                hashlib.sha256(manifest_bytes).hexdigest(),
            )
            self.assertEqual(
                json.loads(build_report_path.read_bytes())["entity_catalog"]["sha256"],
                hashlib.sha256(catalog_bytes).hexdigest(),
            )
            self.assertEqual(json.loads(manifest_bytes)["storage"]["test_images"]["frame_count"], 21)

            alternate = pack_dir / "review.json"
            with (
                patch("sys.argv", ["reconcile", "--manifest", str(manifest_path),
                                   "--encode-report", str(encode_report_path),
                                   "--output", str(alternate)]),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                self.assertEqual(reconciler.main(), 0)
            self.assertTrue(alternate.is_file())
            self.assertEqual(manifest_path.read_bytes(), manifest_bytes)
            self.assertEqual(catalog_path.read_bytes(), catalog_bytes)

    def test_missing_evidence_or_incompatible_catalog_fails_before_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            pack_dir = Path(directory)
            manifest_path = pack_dir / "manifest.json"
            original_manifest = reconciler._json_bytes(self._manifest())
            manifest_path.write_bytes(original_manifest)
            stderr = io.StringIO()
            with (
                patch("sys.argv", ["reconcile", "--manifest", str(manifest_path), "--apply"]),
                contextlib.redirect_stderr(stderr),
            ):
                self.assertEqual(reconciler.main(), 1)
            self.assertIn("cannot verify", stderr.getvalue())
            self.assertEqual(manifest_path.read_bytes(), original_manifest)

            catalog_path = pack_dir / "entity-catalog.json"
            bad_catalog = {
                "schema": "mmt-pack-entity-catalog.v1",
                "pack": {"namespace": "wrong", "version": "1", "manifest_sha256": "0" * 64},
            }
            catalog_path.write_bytes(reconciler._json_bytes(bad_catalog))
            with self.assertRaisesRegex(ValueError, "does not match manifest"):
                reconciler._write_reconciled_manifest(manifest_path, self._manifest())
            self.assertEqual(manifest_path.read_bytes(), original_manifest)
            self.assertEqual(json.loads(catalog_path.read_bytes()), bad_catalog)
            bad_catalog["pack"]["namespace"] = "ba"
            catalog_path.write_bytes(reconciler._json_bytes(bad_catalog))
            with self.assertRaisesRegex(ValueError, "not bound to current manifest"):
                reconciler._write_reconciled_manifest(manifest_path, self._manifest())
            self.assertEqual(manifest_path.read_bytes(), original_manifest)
            self.assertEqual(json.loads(catalog_path.read_bytes()), bad_catalog)
            linked_manifest = pack_dir / "linked-manifest.json"
            linked_manifest.symlink_to(manifest_path)
            with self.assertRaisesRegex(ValueError, "symlinked manifest"):
                reconciler._write_reconciled_manifest(linked_manifest, self._manifest())


if __name__ == "__main__":
    unittest.main()
