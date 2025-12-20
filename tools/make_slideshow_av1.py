from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from pathlib import Path


_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}


def _image_order_key(name: str) -> tuple[int, str]:
    stem = Path(name).stem
    nums = re.findall(r"\d+", stem)
    if not nums:
        return (10**9, stem.lower())
    return (int(nums[-1]), stem.lower())


def _collect_images(dir_path: Path) -> list[Path]:
    files = [
        p
        for p in dir_path.iterdir()
        if p.is_file() and p.suffix.lower() in _IMAGE_EXTS
    ]
    return sorted(files, key=lambda p: _image_order_key(p.name))


def _write_concat_list(paths: list[Path], *, fps: int) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="mmt_slideshow_"))
    list_path = tmp / "list.txt"
    lines: list[str] = []
    duration = 1.0 / max(1, int(fps))
    last_index = len(paths) - 1
    for i, p in enumerate(paths):
        p_str = p.resolve().as_posix()
        lines.append(f"file '{p_str}'")
        if i != last_index:
            lines.append(f"duration {duration}")
    list_path.write_text("\n".join(lines), encoding="utf-8")
    return list_path


def _build_drawtext(fontfile: str | None) -> str:
    # 1-based index at bottom-right.
    text = r"%{eif\:n+1\:d}"
    args = [
        "drawtext=",
        f"text='{text}'",
        "x=w-tw-20",
        "y=h-th-20",
        "fontsize=28",
        "fontcolor=white",
        "borderw=2",
    ]
    if fontfile:
        args.insert(1, f"fontfile='{fontfile.replace('\\', '/')}'")
    return ":".join(args)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Make a 1fps slideshow video (AV1) with index watermark.",
    )
    parser.add_argument("images_dir", help="directory with images")
    parser.add_argument("output", help="output video path (e.g., out.mkv)")
    parser.add_argument("--fps", type=int, default=1, help="frames per second (default: 1)")
    parser.add_argument("--font", default="", help="font file for drawtext (optional)")
    parser.add_argument("--encoder", default="libsvtav1", help="AV1 encoder (libsvtav1/libaom-av1)")
    parser.add_argument("--crf", type=int, default=30, help="crf value (default: 30)")
    parser.add_argument("--preset", default="6", help="encoder preset (default: 6)")
    args = parser.parse_args()

    images_dir = Path(args.images_dir).resolve()
    if not images_dir.exists():
        raise SystemExit(f"dir not found: {images_dir}")

    images = _collect_images(images_dir)
    if not images:
        raise SystemExit("no images found")

    concat_list = _write_concat_list(images, fps=args.fps)
    out_path = Path(args.output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    drawtext = _build_drawtext(args.font.strip() or None)
    vf = f"fps={max(1, int(args.fps))},{drawtext}"

    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        str(concat_list),
        "-vf",
        vf,
        "-c:v",
        str(args.encoder),
        "-crf",
        str(int(args.crf)),
        "-preset",
        str(args.preset),
        "-pix_fmt",
        "yuv420p10le",
        str(out_path),
    ]
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as exc:
        raise SystemExit(exc.returncode)

    print(f"done: {out_path}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
