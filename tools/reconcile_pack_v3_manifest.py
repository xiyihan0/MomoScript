"""
Reconcile and validate pack-v3 manifest sequence dimensions and frame counts
against encode reports or actual AVIFS media blobs.

This tool audits and repairs discrepancies where an image-sequence storage entry
in manifest.json has declared dimensions or frame counts that diverge from what
was actually encoded into the immutable AVIFS blob.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Iterator, Optional


def _inspect_avifs(path: Path, avifdec_bin: str = "avifdec") -> tuple[tuple[int, int], int] | None:
    if not path.is_file():
        return None
    res = subprocess.run(
        [avifdec_bin, "-i", str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if res.returncode != 0:
        return None
    res_m = re.search(r"Resolution\s*:\s*(\d+)x(\d+)", res.stdout)
    frames_m = re.search(r"\((\d+)\s+expected frames?\)", res.stdout)
    if frames_m is None:
        frames_m = re.search(r"\b(\d+)\s+frames?\b", res.stdout)
    if res_m and frames_m:
        width, height, frames = int(res_m.group(1)), int(res_m.group(2)), int(frames_m.group(1))
        if width > 0 and height > 0 and frames > 0:
            return (width, height), frames
    return None


def _load_json_or_url(source: str) -> dict[str, Any]:
    if source.startswith("http://") or source.startswith("https://"):
        import urllib.request
        with urllib.request.urlopen(source) as resp:
            return json.loads(resp.read().decode("utf-8"))
    return json.loads(Path(source).read_text(encoding="utf-8"))


def _load_report_lines(source: str) -> list[dict[str, Any]]:
    if source.startswith("http://") or source.startswith("https://"):
        import urllib.request
        with urllib.request.urlopen(source) as resp:
            content = resp.read().decode("utf-8")
    else:
        content = Path(source).read_text(encoding="utf-8")
    records = []
    for line in content.splitlines():
        line = line.strip()
        if line:
            records.append(json.loads(line))
    return records


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as blob:
        for chunk in iter(lambda: blob.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _measured_record(rec: dict[str, Any] | None) -> tuple[list[int], int] | None:
    if rec is None or rec.get("status") not in {"encoded", "reused"}:
        return None
    size, frames = rec.get("measured_size"), rec.get("measured_frames")
    if (
        not isinstance(size, list)
        or len(size) != 2
        or any(type(edge) is not int or edge <= 0 for edge in size)
        or type(frames) is not int
        or frames <= 0
    ):
        return None
    return list(size), frames


def _sticker_owners(manifest: dict[str, Any]) -> Iterator[tuple[list[str], dict[str, Any]]]:
    for entity_id, entity in manifest.get("entities", {}).items():
        yield [entity_id], entity.get("slots", {})
    namespace = manifest.get("pack", {}).get("namespace")
    for contribution in manifest.get("contributions", []):
        target = contribution.get("target")
        if not isinstance(target, str):
            continue
        owners = [target]
        if namespace and target.startswith(f"{namespace}::"):
            owners.append(target[len(namespace) + 2:])
        yield owners, contribution.get("slots", {})


def _thumbnail_ids(owners: list[str], set_id: str, variant_id: str) -> set[str]:
    return {f"{owner}/sticker/{set_id}/{variant_id}" for owner in owners}


def reconcile_manifest(
    manifest: dict[str, Any],
    encode_records: list[dict[str, Any]],
    *,
    pack_dir: Optional[Path] = None,
    avifdec_bin: str = "avifdec",
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    reconciled = json.loads(json.dumps(manifest))
    discrepancies: list[dict[str, Any]] = []
    unverified: list[str] = []
    pack_root = pack_dir.resolve() if pack_dir is not None else None
    removed_thumbnail_ids: set[str] = set()

    # The most recent attempt for a storage ID supersedes earlier report lines.
    report_by_storage = {
        rec["storage"]: rec for rec in encode_records
        if isinstance(rec, dict) and isinstance(rec.get("storage"), str)
    }
    for storage_id, storage in reconciled.get("storage", {}).items():
        if not isinstance(storage, dict) or storage.get("kind") != "image-sequence":
            continue

        measurement = None
        blob_path_value = storage.get("path")
        if pack_dir is not None and isinstance(blob_path_value, str):
            relative = Path(blob_path_value)
            blob_path = pack_dir / relative
            if relative.is_absolute() or not blob_path.resolve().is_relative_to(pack_root):
                unverified.append(f"{storage_id}: unsafe local AVIFS path")
                continue
            if blob_path.exists():
                try:
                    info = _inspect_avifs(blob_path, avifdec_bin=avifdec_bin)
                except OSError as exc:
                    unverified.append(f"{storage_id}: AVIFS inspection unavailable ({exc})")
                    continue
                if info is None:
                    unverified.append(f"{storage_id}: local AVIFS blob cannot be inspected")
                    continue
                measurement = (list(info[0]), info[1])
                sha256 = storage.get("sha256")
                if isinstance(sha256, str) and _sha256_file(blob_path) != sha256:
                    unverified.append(f"{storage_id}: local AVIFS SHA-256 does not match manifest")
                    continue

        if measurement is None:
            record = report_by_storage.get(storage_id)
            sha256 = storage.get("sha256")
            if (
                record is not None
                and isinstance(sha256, str)
                and record.get("blob_sha256") != sha256
            ):
                unverified.append(f"{storage_id}: report AVIFS SHA-256 does not match manifest")
                continue
            measurement = _measured_record(record)
        if measurement is None:
            unverified.append(f"{storage_id}: no verified local AVIFS or successful measured report")
            continue

        actual_size, actual_frames = measurement
        declared_size, declared_frames = storage.get("size"), storage.get("frame_count")
        if declared_size == actual_size and declared_frames == actual_frames:
            continue
        discrepancies.append({
            "storage_id": storage_id,
            "declared_size": declared_size,
            "actual_size": actual_size,
            "declared_frames": declared_frames,
            "actual_frames": actual_frames,
        })
        storage["size"] = actual_size
        storage["frame_count"] = actual_frames

        if declared_frames == actual_frames:
            continue
        for owners, slots in _sticker_owners(reconciled):
            sticker = slots.get("sticker")
            if not isinstance(sticker, dict):
                continue
            sets = sticker.get("sets", {})
            for set_id, set_data in list(sets.items()):
                if set_data.get("storage") != storage_id:
                    continue
                kept = []
                for variant in set_data.get("variants") or []:
                    frame = variant.get("frame")
                    if type(frame) is int and 0 <= frame < actual_frames:
                        kept.append(variant)
                    else:
                        removed_thumbnail_ids.update(
                            _thumbnail_ids(owners, set_id, variant["id"])
                        )
                if kept:
                    set_data["variants"] = kept
                else:
                    del sets[set_id]
                    if sets:
                        if sticker.get("default") == set_id:
                            sticker["default"] = "default" if "default" in sets else next(iter(sets))
                    else:
                        slots.pop("sticker", None)

    if unverified:
        raise ValueError("cannot verify sequence storage: " + "; ".join(unverified))

    if removed_thumbnail_ids:
        retained_thumbnail_ids: set[str] = set()
        for owners, slots in _sticker_owners(reconciled):
            sticker = slots.get("sticker")
            if not isinstance(sticker, dict):
                continue
            for set_id, set_data in sticker.get("sets", {}).items():
                for variant in set_data.get("variants") or []:
                    retained_thumbnail_ids.update(
                        _thumbnail_ids(owners, set_id, variant["id"])
                    )
        for thumbnail_id in sorted(removed_thumbnail_ids - retained_thumbnail_ids):
            reconciled.get("thumbnails", {}).pop(thumbnail_id, None)

    return reconciled, discrepancies


def _json_bytes(data: Any) -> bytes:
    return (json.dumps(data, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _write_reconciled_manifest(out_path: Path, manifest: dict[str, Any]) -> None:
    if out_path.is_symlink():
        raise ValueError(f"refusing to overwrite symlinked manifest: {out_path}")
    out_path = out_path.resolve()
    manifest_bytes = _json_bytes(manifest)
    updates = [(out_path, manifest_bytes)]
    catalog_path = out_path.with_name("entity-catalog.json")
    if out_path.name == "manifest.json" and catalog_path.is_symlink():
        raise ValueError(f"refusing to update symlinked entity catalog: {catalog_path}")
    if out_path.name == "manifest.json" and catalog_path.exists():
        catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
        pack = catalog.get("pack") if isinstance(catalog, dict) else None
        manifest_pack = manifest.get("pack") if isinstance(manifest.get("pack"), dict) else {}
        if (
            not isinstance(catalog, dict)
            or catalog.get("schema") != "mmt-pack-entity-catalog.v1"
            or not isinstance(pack, dict)
            or pack.get("namespace") != manifest_pack.get("namespace")
            or pack.get("version") != manifest_pack.get("version")
        ):
            raise ValueError(f"entity catalog does not match manifest: {catalog_path}")
        if not out_path.is_file() or pack.get("manifest_sha256") != _sha256_file(out_path):
            raise ValueError(f"entity catalog is not bound to current manifest: {catalog_path}")
        pack["manifest_sha256"] = hashlib.sha256(manifest_bytes).hexdigest()
        catalog_bytes = _json_bytes(catalog)
        updates.insert(0, (catalog_path, catalog_bytes))

        report_path = out_path.with_name("build_report.json")
        if report_path.is_symlink():
            raise ValueError(f"refusing to update symlinked build report: {report_path}")
        if report_path.exists():
            build_report = json.loads(report_path.read_text(encoding="utf-8"))
            if not isinstance(build_report, dict):
                raise ValueError(f"invalid build report: {report_path}")
            catalog_report = build_report.get("entity_catalog")
            if catalog_report is not None:
                if not isinstance(catalog_report, dict):
                    raise ValueError(f"invalid entity catalog build report: {report_path}")
                catalog_report["sha256"] = hashlib.sha256(catalog_bytes).hexdigest()
                updates.insert(1, (report_path, _json_bytes(build_report)))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    staged: list[Path] = []

    def stage(path: Path, content: bytes) -> Path:
        with tempfile.NamedTemporaryFile(
            dir=path.parent, prefix=f".{path.name}.", delete=False
        ) as temporary:
            staged_path = Path(temporary.name)
            staged.append(staged_path)
            temporary.write(content)
        return staged_path

    replaced: list[tuple[Path, bytes | None]] = []
    try:
        prepared = [(path, stage(path, content)) for path, content in updates]
        for path, temporary in prepared:
            original = path.read_bytes() if path.exists() else None
            temporary.replace(path)
            replaced.append((path, original))
    except OSError:
        for path, original in reversed(replaced):
            try:
                if original is None:
                    path.unlink()
                else:
                    stage(path, original).replace(path)
            except OSError as exc:
                raise RuntimeError(
                    f"could not restore {path}; manifest and catalog may be inconsistent"
                ) from exc
        raise
    finally:
        for path in staged:
            path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Audit and reconcile pack-v3 manifest sequence dimensions and frame counts."
    )
    parser.add_argument(
        "--manifest",
        required=True,
        help="Path or URL to manifest.json.",
    )
    parser.add_argument(
        "--encode-report",
        help="Path or URL to encode_report.jsonl.",
    )
    parser.add_argument(
        "--pack-dir",
        type=Path,
        help="Path to pack root directory containing blobs/.",
    )
    output_group = parser.add_mutually_exclusive_group()
    output_group.add_argument(
        "--output",
        type=Path,
        help="Output path for reconciled manifest.json.",
    )
    output_group.add_argument(
        "--apply",
        action="store_true",
        help="Overwrite --manifest in place (local files only).",
    )
    parser.add_argument(
        "--avifdec-bin",
        default="avifdec",
        help="Path to avifdec binary.",
    )

    args = parser.parse_args()

    try:
        manifest = _load_json_or_url(args.manifest)
        encode_records = _load_report_lines(args.encode_report) if args.encode_report else []
        pack_dir = args.pack_dir
        if pack_dir is None and not args.manifest.startswith(("http://", "https://")):
            pack_dir = Path(args.manifest).resolve().parent
        reconciled, discrepancies = reconcile_manifest(
            manifest,
            encode_records,
            pack_dir=pack_dir,
            avifdec_bin=args.avifdec_bin,
        )
    except (OSError, ValueError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    print(f"[audit] found {len(discrepancies)} sequence discrepanc(y/ies)")
    for d in discrepancies:
        print(
            f"  - {d['storage_id']}: "
            f"size {d['declared_size']} -> {d['actual_size']}, "
            f"frames {d['declared_frames']} -> {d['actual_frames']}"
        )

    out_path = None
    if args.output:
        out_path = args.output
    elif args.apply:
        if args.manifest.startswith("http://") or args.manifest.startswith("https://"):
            print("[error] --apply cannot overwrite remote URLs", file=sys.stderr)
            return 1
        out_path = Path(args.manifest)

    if out_path:
        try:
            _write_reconciled_manifest(out_path, reconciled)
        except (OSError, ValueError, RuntimeError) as exc:
            print(f"[error] {exc}", file=sys.stderr)
            return 1
        print(f"[ok] wrote reconciled manifest to {out_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
