from __future__ import annotations

import argparse
from pathlib import Path

from mmt_core.pack_v2 import validate_pack_v2


def main() -> int:
    p = argparse.ArgumentParser(description="Validate a MomoScript pack (v2 draft).")
    p.add_argument("pack_root", help="Path to mmt_packs/<pack_id>")
    args = p.parse_args()

    validate_pack_v2(Path(args.pack_root))
    print("[ok] pack validated:", args.pack_root)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

