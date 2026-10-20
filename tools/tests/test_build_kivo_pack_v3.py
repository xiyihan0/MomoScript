from __future__ import annotations

import argparse
import contextlib
import hashlib
import io
import importlib.util
import json
import shutil
import struct
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path
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

    def test_missing_avatar_retains_entity_metadata_without_fabricated_asset(self) -> None:
        for avatar in ["", "   ", None, "missing-key"]:
            with self.subTest(avatar=avatar):
                detail = self._detail(76, skin="", nick_name="大叔", skin_list=[])
                if avatar == "missing-key":
                    detail.pop("avatar")
                else:
                    detail["avatar"] = avatar
                with tempfile.TemporaryDirectory() as directory:
                    manifest, tasks, skipped = builder._build_manifest(
                        [detail],
                        namespace="ba",
                        pack_name="Fixture Pack",
                        pack_version="2026.10.20",
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
                self.assertEqual(tasks, [])
                self.assertEqual(manifest["entities"]["星野"]["names"], ["星野"])
                self.assertEqual(manifest["entities"]["星野"]["display_name"], "星野")
                self.assertNotIn("slots", manifest["entities"]["星野"])
                self.assertEqual(manifest["thumbnails"], {})
                catalog = builder._build_entity_catalog(
                    [detail],
                    manifest=manifest,
                    manifest_sha256="a" * 64,
                    schools=[],
                    relations=[],
                    api_versions=[],
                    api_times=[],
                    generated_at="2026-10-20T00:00:00+00:00",
                )
                self.assertIn("星野", catalog["entities"])
                self.assertEqual(
                    catalog["entities"]["星野"]["names"]["aliases"]["zh-CN"], ["大叔"]
                )

    def test_missing_avatar_does_not_remove_available_sticker_gallery(self) -> None:
        detail = self._detail(76, skin="", nick_name="", skin_list=[])
        detail["avatar"] = ""
        detail["gallery"] = [{"title": "表情", "images": ["https://example.invalid/sticker.png"]}]
        with tempfile.TemporaryDirectory() as directory:
            manifest, tasks, skipped = builder._build_manifest(
                [detail],
                namespace="ba",
                pack_name="Fixture Pack",
                pack_version="2026.10.20",
                out_dir=Path(directory),
                gallery_mode="all",
                excluded_gallery_titles=[],
                max_gallery_images=None,
                nickname_names=False,
                english_names=False,
                excluded_entity_markers=[],
                base_url="https://example.invalid/ba/",
            )
        self.assertEqual(skipped, [])
        self.assertNotIn("avatar", manifest["entities"]["星野"]["slots"])
        self.assertIn("sticker", manifest["entities"]["星野"]["slots"])
        self.assertEqual([task.url for task in tasks], ["https://example.invalid/sticker.png"])

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


class AvifOrderingOptionTests(unittest.TestCase):
    def test_invalid_encoding_options_are_rejected(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                builder.build_argparser().parse_args(["--avif-keyframe", "invalid"])
            with self.assertRaises(SystemExit):
                builder.build_argparser().parse_args(["--avif-frame-order", "invalid"])


class ImageMagickCommandTests(unittest.TestCase):
    def test_imagemagick_seven_uses_magick_for_both_operations(self) -> None:
        with patch.object(builder.shutil, "which", return_value="/tools/magick"):
            self.assertEqual(builder._imagemagick_command("identify"), ["/tools/magick", "identify"])
            self.assertEqual(builder._imagemagick_command("convert"), ["/tools/magick"])

    def test_imagemagick_six_uses_separate_executables(self) -> None:
        executables = {"convert": "/tools/convert", "identify": "/tools/identify"}
        with patch.object(builder.shutil, "which", side_effect=executables.get):
            self.assertEqual(builder._imagemagick_command("identify"), ["/tools/identify"])
            self.assertEqual(builder._imagemagick_command("convert"), ["/tools/convert"])

    def test_missing_imagemagick_has_actionable_error(self) -> None:
        with patch.object(builder.shutil, "which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "install ImageMagick"):
                builder._imagemagick_command("convert")

    def test_rgba_sample_requests_exact_eight_bit_rgba_dimensions(self) -> None:
        rgba = bytes(48 * 48 * 4)
        with (
            patch.object(builder, "_imagemagick_command", return_value=["convert"]),
            patch.object(
                builder.subprocess,
                "run",
                return_value=subprocess.CompletedProcess([], 0, rgba, b""),
            ) as run,
        ):
            self.assertEqual(builder._rgba_sample(Path("transparent.png")), rgba)
        self.assertEqual(
            run.call_args.args[0],
            [
                "convert", "transparent.png[0]", "-colorspace", "sRGB",
                "-alpha", "on", "-resize", "48x48!", "-depth", "8", "rgba:-",
            ],
        )
        self.assertNotIn("text", run.call_args.kwargs)

    def test_rgba_sample_rejects_wrong_byte_count_and_reports_subprocess_error(self) -> None:
        for result, expected in [
            (subprocess.CompletedProcess([], 0, bytes(9215), b""), "expected 9216"),
            (subprocess.CompletedProcess([], 1, b"", b"bad PNG input"), "bad PNG input"),
        ]:
            with self.subTest(expected=expected):
                with (
                    patch.object(builder, "_imagemagick_command", return_value=["convert"]),
                    patch.object(builder.subprocess, "run", return_value=result),
                    self.assertRaisesRegex(RuntimeError, expected),
                ):
                    builder._rgba_sample(Path("broken.png"))

    @unittest.skipUnless(shutil.which("magick") or shutil.which("convert"), "ImageMagick required")
    def test_fully_transparent_png_downsamples_to_exact_rgba_bytes(self) -> None:
        def chunk(kind: bytes, data: bytes) -> bytes:
            return (
                struct.pack(">I", len(data))
                + kind
                + data
                + struct.pack(">I", zlib.crc32(kind + data))
            )

        png = (
            b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 1, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00" + bytes(2 * 4)))
            + chunk(b"IEND", b"")
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "transparent.png"
            path.write_bytes(png)
            sample = builder._rgba_sample(path)
        self.assertEqual(len(sample), 9216)
        self.assertEqual(sample, bytes(9216))


class NearestFrameOrderTests(unittest.TestCase):
    def test_empty_and_single_frame_orders_need_no_numpy_or_sampling(self) -> None:
        with (
            patch.dict("sys.modules", {"numpy": None}),
            patch.object(builder, "_rgba_sample", side_effect=AssertionError("must not sample")),
        ):
            self.assertEqual(builder._nearest_frame_order([]), [])
            self.assertEqual(builder._nearest_frame_order([Path("one.png")]), [0])

    def test_missing_numpy_fails_before_sampling_without_falling_back(self) -> None:
        with (
            patch.dict("sys.modules", {"numpy": None}),
            patch.object(builder, "_rgba_sample", side_effect=AssertionError("must not sample")),
        ):
            with self.assertRaises(RuntimeError) as error:
                builder._nearest_frame_order([Path("one.png"), Path("two.png")])
        self.assertIsInstance(error.exception.__cause__, ImportError)

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "NumPy required for nearest ordering")
    def test_greedy_order_is_deterministic_and_breaks_ties_by_logical_index(self) -> None:
        paths = [Path(f"{index}.png") for index in range(4)]
        samples = {path: bytes([value]) * 9216 for path, value in zip(paths, [10, 12, 8, 13])}
        with patch.object(builder, "_rgba_sample", side_effect=samples.__getitem__):
            self.assertEqual(builder._nearest_frame_order(paths), [0, 1, 3, 2])
            self.assertEqual(builder._nearest_frame_order(paths), [0, 1, 3, 2])

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "NumPy required for nearest ordering")
    def test_rgba_distance_includes_alpha_without_unsigned_wraparound(self) -> None:
        paths = [Path(f"{index}.png") for index in range(3)]
        samples = {
            paths[0]: bytes([0, 0, 0, 255]) * (48 * 48),
            paths[1]: bytes([0, 0, 0, 0]) * (48 * 48),
            paths[2]: bytes([1, 1, 1, 255]) * (48 * 48),
        }
        with patch.object(builder, "_rgba_sample", side_effect=samples.__getitem__):
            self.assertEqual(builder._nearest_frame_order(paths), [0, 2, 1])


class AvifEncodingTests(unittest.TestCase):
    @staticmethod
    def _pack(
        out_dir: Path, *, sources: tuple[bytes, ...] = (b"source",)
    ) -> dict[str, object]:
        variants = []
        thumbnails = {}
        for index, source in enumerate(sources, start=1):
            image = out_dir / f"assets/stickers/demo/default/{index:03d}.png"
            image.parent.mkdir(parents=True, exist_ok=True)
            image.write_bytes(source)
            variant_id = "one" if index == 1 else f"variant-{index}"
            variants.append({"id": variant_id, "ordinal": index, "path": image.name})
            thumbnails[f"demo/sticker/default/{variant_id}"] = {
                "storage": "images", "path": image.name,
            }
        return {
            "entities": {
                "demo": {
                    "slots": {
                        "sticker": {
                            "default": "default",
                            "sets": {
                                "default": {
                                    "storage": "images",
                                    "variants": variants,
                                }
                            },
                        }
                    }
                }
            },
            "storage": {"images": {"kind": "image-dir", "base": "assets/stickers/demo/default"}},
            "thumbnails": thumbnails,
        }

    @staticmethod
    def _args(
        *, resume: bool, frame_order: str | None = None, keyframe: int | str | None = None
    ) -> argparse.Namespace:
        options = [
            "--avif-concurrency", "1",
            "--sticker-max-canvas-pixels", "1000",
            "--sticker-max-aspect-ratio", "10",
            "--avif-max-canvas-pixels", "1000",
            "--avif-max-canvas-edge", "100",
        ]
        if resume:
            options.append("--resume")
        if frame_order is not None:
            options.extend(["--avif-frame-order", frame_order])
        if keyframe is not None:
            options.extend(["--avif-keyframe", str(keyframe)])
        return builder.build_argparser().parse_args(options)

    @staticmethod
    def _thumbnail(sources: list[Path], directory: Path, *, resume: bool) -> list[str]:
        directory.mkdir(parents=True, exist_ok=True)
        names = []
        for index, source in enumerate(sources, start=1):
            name = f"{index:03d}.webp"
            (directory / name).write_bytes(b"thumbnail:" + source.read_bytes())
            names.append(name)
        return names

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
                summary = builder._encode_avif_sequences(
                    out_dir, manifest, self._args(resume=True, frame_order="source", keyframe=30)
                )

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
            self.assertEqual(record["frame_order"]["physical_to_logical"], [0])
            self.assertEqual(record["frame_order"]["logical_to_physical"], [0])
            self.assertEqual(manifest["storage"]["images"]["profile"]["keyframe_interval"], 30)

    def test_source_order_and_numeric_gop_do_not_use_nearest_or_numpy(self) -> None:
        sources = (b"\x00", b"\x09", b"\x01", b"\x02")
        encoded_sources = []
        encoded_options = []

        def encode(inputs: list[Path], output: Path, **options: object) -> subprocess.CompletedProcess[str]:
            encoded_sources.extend(path.read_bytes() for path in inputs)
            encoded_options.append(options)
            output.parent.mkdir(parents=True)
            output.write_bytes(b"encoded")
            return subprocess.CompletedProcess([], 0, "encoded")

        with tempfile.TemporaryDirectory() as directory:
            out_dir = Path(directory)
            manifest = self._pack(out_dir, sources=sources)
            with (
                patch.dict("sys.modules", {"numpy": None}),
                patch.object(builder, "_image_info", return_value=([(8, 7)] * 4, True)),
                patch.object(builder, "_run_avifenc", side_effect=encode),
                patch.object(builder, "_inspect_avifs", return_value=((8, 7), 4)),
                patch.object(builder, "_prepare_thumbnails", side_effect=self._thumbnail),
                patch.object(builder, "_nearest_frame_order", side_effect=AssertionError("must not reorder")),
                patch.object(builder, "_prepare_padded_frames", side_effect=AssertionError("must not pad")),
            ):
                summary = builder._encode_avif_sequences(
                    out_dir, manifest, self._args(resume=False, frame_order="source", keyframe=7)
                )
            record = json.loads((out_dir / "encode_report.jsonl").read_text(encoding="utf-8"))
            variants = manifest["entities"]["demo"]["slots"]["sticker"]["sets"]["default"]["variants"]
            self.assertEqual((summary["encoded"], summary["failed"]), (1, 0))
            self.assertEqual(encoded_sources, list(sources))
            self.assertEqual(encoded_options[0]["keyframe"], 7)
            self.assertEqual([variant["frame"] for variant in variants], [0, 1, 2, 3])
            self.assertEqual(record["frame_order"]["physical_to_logical"], [0, 1, 2, 3])
            self.assertEqual(record["profile"]["keyframe_interval"], 7)
            self.assertEqual(manifest["storage"]["images"]["profile"]["keyframe_interval"], 7)

    @unittest.skipUnless(importlib.util.find_spec("numpy"), "NumPy required for nearest ordering")
    def test_defaults_reorder_padded_inputs_but_preserve_variants_and_thumbnails(self) -> None:
        sources = (b"\x00", b"\x09", b"\x01", b"\x02")
        padded_paths = []
        sampled_paths = []
        thumbnail_sources = []
        encoded_sources = []
        encoded_options = []

        def pad(inputs: list[Path], directory: Path, **options: object) -> list[Path]:
            self.assertEqual(options, {"size": (8, 7), "alpha": True})
            for index, source in enumerate(inputs, start=1):
                target = directory / f"{index:03d}.png"
                target.write_bytes(source.read_bytes())
                padded_paths.append(target)
            return padded_paths

        def sample(path: Path) -> bytes:
            self.assertIn(path, padded_paths)
            sampled_paths.append(path)
            return path.read_bytes() * 9216

        def encode(inputs: list[Path], output: Path, **options: object) -> subprocess.CompletedProcess[str]:
            encoded_sources.extend(path.read_bytes() for path in inputs)
            encoded_options.append(options)
            output.parent.mkdir(parents=True)
            output.write_bytes(b"encoded")
            return subprocess.CompletedProcess([], 0, "encoded")

        def thumbnails(inputs: list[Path], directory: Path, *, resume: bool) -> list[str]:
            self.assertTrue(all(path not in padded_paths for path in inputs))
            thumbnail_sources.extend(path.read_bytes() for path in inputs)
            return self._thumbnail(inputs, directory, resume=resume)

        with tempfile.TemporaryDirectory() as directory:
            out_dir = Path(directory)
            manifest = self._pack(out_dir, sources=sources)
            variants = manifest["entities"]["demo"]["slots"]["sticker"]["sets"]["default"]["variants"]
            for variant, ordinal in zip(variants, [2, 5, 8, 13]):
                variant["ordinal"] = ordinal
            original_identities = [(variant["id"], variant["ordinal"]) for variant in variants]
            original_paths = [variant["path"] for variant in variants]
            with (
                patch.object(builder, "_image_info", return_value=([(8, 7), (4, 7), (8, 7), (6, 5)], True)),
                patch.object(builder, "_prepare_padded_frames", side_effect=pad),
                patch.object(builder, "_rgba_sample", side_effect=sample),
                patch.object(builder, "_run_avifenc", side_effect=encode),
                patch.object(builder, "_inspect_avifs", return_value=((8, 7), 4)),
                patch.object(builder, "_prepare_thumbnails", side_effect=thumbnails),
            ):
                summary = builder._encode_avif_sequences(
                    out_dir, manifest, self._args(resume=False),
                )
            record = json.loads((out_dir / "encode_report.jsonl").read_text(encoding="utf-8"))
            self.assertEqual((summary["encoded"], summary["failed"]), (1, 0))
            self.assertEqual(summary["profile"]["keyframe_interval"], "auto")
            self.assertEqual(encoded_sources, [sources[index] for index in [0, 2, 3, 1]])
            self.assertEqual(encoded_options[0]["keyframe"], 4)
            self.assertEqual(sampled_paths, padded_paths)
            self.assertTrue(all(not path.exists() for path in padded_paths))
            self.assertEqual(thumbnail_sources, list(sources))
            self.assertEqual([(variant["id"], variant["ordinal"]) for variant in variants], original_identities)
            self.assertEqual([variant["frame"] for variant in variants], [0, 3, 1, 2])
            self.assertTrue(all("path" not in variant for variant in variants))
            for variant, source in zip(variants, sources):
                thumbnail = manifest["thumbnails"][f"demo/sticker/default/{variant['id']}"]
                thumbnail_path = out_dir / "assets/thumbnails" / thumbnail["path"]
                self.assertEqual(thumbnail_path.read_bytes(), b"thumbnail:" + source)
            self.assertTrue(record["padded"])
            self.assertEqual(record["frame_order"], {
                "mode": "nearest",
                "algorithm": "rgba48-l1-greedy-v1",
                "physical_to_logical": [0, 2, 3, 1],
                "logical_to_physical": [0, 3, 1, 2],
            })
            for index, source in enumerate(record["source_variants"]):
                self.assertEqual(source["logical_index"], index)
                self.assertEqual((source["id"], source["ordinal"]), original_identities[index])
                self.assertEqual(Path(source["path"]).name, original_paths[index])
                self.assertEqual(source["sha256"], hashlib.sha256(sources[index]).hexdigest())
            profile = manifest["storage"]["images"]["profile"]
            self.assertEqual(profile, record["profile"])
            self.assertEqual(profile["keyframe_interval"], 4)
            self.assertEqual(set(profile), {
                "encoder", "codec", "qcolor", "qalpha", "yuv",
                "keyframe_interval", "fps", "speed", "jobs",
            })

    def test_unproven_order_or_profile_never_reuses_existing_blobs(self) -> None:
        for frame_order, keyframe in [("nearest", 30), ("source", "auto"), ("nearest", "auto")]:
            with self.subTest(frame_order=frame_order, keyframe=keyframe):
                with tempfile.TemporaryDirectory() as directory:
                    out_dir = Path(directory)
                    manifest = self._pack(out_dir)
                    source_output = out_dir / "blobs/stickers/demo/default.avifs"
                    source_output.parent.mkdir(parents=True)
                    source_output.write_bytes(b"old source")
                    encoding_output = source_output.with_name(f"default.{frame_order}.encoding.avifs")
                    encoding_output.write_bytes(b"old incompatible encode")
                    encoded_keyframes = []

                    def encode(inputs: list[Path], output: Path, **options: object) -> subprocess.CompletedProcess[str]:
                        self.assertEqual(output, encoding_output)
                        self.assertFalse(output.exists())
                        encoded_keyframes.append(options["keyframe"])
                        output.write_bytes(b"new encode")
                        return subprocess.CompletedProcess([], 0, "encoded")

                    with (
                        patch.object(builder, "_image_info", return_value=([(8, 7)], False)),
                        patch.object(builder, "_run_avifenc", side_effect=encode) as run,
                        patch.object(builder, "_inspect_avifs", return_value=((8, 7), 1)) as inspect,
                        patch.object(builder, "_prepare_thumbnails", side_effect=self._thumbnail),
                    ):
                        summary = builder._encode_avif_sequences(
                            out_dir, manifest,
                            self._args(resume=True, frame_order=frame_order, keyframe=keyframe),
                        )
                    record = json.loads((out_dir / "encode_report.jsonl").read_text(encoding="utf-8"))
                    self.assertEqual((summary["encoded"], summary["failed"]), (1, 0))
                    self.assertEqual(record["status"], "encoded")
                    self.assertFalse(record["reuse_encoded"])
                    self.assertEqual(run.call_count, 1)
                    self.assertEqual(inspect.call_count, 1)
                    self.assertEqual(source_output.read_bytes(), b"old source")
                    effective_keyframe = 1 if keyframe == "auto" else keyframe
                    self.assertEqual(encoded_keyframes, [effective_keyframe])
                    self.assertEqual(
                        manifest["storage"]["images"]["profile"]["keyframe_interval"],
                        effective_keyframe,
                    )

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
