from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import nonebot

nonebot.init()

from nonebot_plugin_mmt_pipe.services.typst import (  # noqa: E402
    _byte_offset,
    _map_typst_diagnostics,
    _mmt_position,
)


class TypstMappingTests(unittest.TestCase):
    def test_utf8_position_conversion(self) -> None:
        self.assertEqual(_byte_offset("一二\nabc", 1, 2), 3)
        self.assertEqual(_mmt_position("一二\nabc", 3), (1, 2))

    def test_generated_typst_location_maps_to_mmt_origin(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            project.joinpath("main.typ").write_text(
                "#let value = missing\n", encoding="utf-8"
            )
            project.joinpath("source.mmt").write_text(
                "@typ\n#let value = missing\n@end", encoding="utf-8"
            )
            project.joinpath("source-map.json").write_text(
                json.dumps(
                    {
                        "schema": "mmt.source-map.v1",
                        "origins": [
                            {
                                "type": "mmt_range",
                                "range": {"start": 5, "end": 25},
                                "kind": "typ_directive",
                            },
                            {
                                "type": "generated",
                                "kind": "template_wrapper",
                                "parent": 0,
                            },
                        ],
                        "source_map": [
                            {
                                "generated_range": {"start": 0, "end": 21},
                                "origin_id": 1,
                            }
                        ],
                    }
                ),
                encoding="utf-8",
            )

            mapped = _map_typst_diagnostics(
                project, "main.typ:1:14: error: unknown variable: missing"
            )

            self.assertEqual(mapped, ["MMT 2:1"])


if __name__ == "__main__":
    unittest.main()
