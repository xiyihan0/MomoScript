from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

from ..context import plugin_config

try:
    from mmt_core.typst_sandbox import TypstSandboxOptions, run_typst_sandboxed
except Exception:  # pragma: no cover
    TypstSandboxOptions = None  # type: ignore
    run_typst_sandboxed = None  # type: ignore


def common_root(*paths: Path) -> Path:
    # Compute a safe common root for Typst sandbox resolution.
    # Typst checks project root against the real/canonical file paths. If any of
    # these paths are symlinks, using `.absolute()` can yield a root that doesn't
    # actually contain the resolved targets and will trigger "outside of project root".
    resolved: list[str] = []
    for p in paths:
        try:
            resolved.append(str(p.resolve()))
        except Exception:
            resolved.append(str(p.absolute()))
    common = os.path.commonpath(resolved)
    return Path(common)


def _run_typst_command(cmd: list[str], *, cwd: Path):
    if run_typst_sandboxed is not None and TypstSandboxOptions is not None:
        procgov_bin = (plugin_config.mmt_procgov_bin or "").strip() or None
        opts = TypstSandboxOptions(
            timeout_s=float(
                getattr(plugin_config, "mmt_typst_timeout_s", 30.0) or 30.0
            ),
            max_mem_mb=int(getattr(plugin_config, "mmt_typst_maxmem_mb", 0) or 0)
            or None,
            rayon_threads=int(getattr(plugin_config, "mmt_typst_rayon_threads", 0) or 0)
            or None,
            procgov_bin=procgov_bin,
            enable_procgov=bool(
                getattr(plugin_config, "mmt_typst_enable_procgov", True)
            ),
        )
        return run_typst_sandboxed(cmd, cwd=cwd, options=opts)
    return subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)


def _byte_offset(text: str, line: int, column: int) -> int | None:
    if line < 1 or column < 1:
        return None
    lines = text.splitlines(keepends=True)
    if line > len(lines):
        return None
    prefix = "".join(lines[: line - 1])
    current = lines[line - 1]
    chars = list(current)
    if column > len(chars) + 1:
        return None
    return len((prefix + "".join(chars[: column - 1])).encode("utf-8"))


def _mmt_position(source: str, byte_offset: int) -> tuple[int, int] | None:
    encoded = source.encode("utf-8")
    if byte_offset < 0 or byte_offset > len(encoded):
        return None
    try:
        prefix = encoded[:byte_offset].decode("utf-8")
    except UnicodeDecodeError:
        return None
    line = prefix.count("\n") + 1
    column = len(prefix.rsplit("\n", 1)[-1]) + 1
    return line, column


def _map_typst_diagnostics(project_dir: Path, stderr: str) -> list[str]:
    try:
        generated = (project_dir / "main.typ").read_text(encoding="utf-8")
        source = (project_dir / "source.mmt").read_text(encoding="utf-8")
        report = json.loads(
            (project_dir / "source-map.json").read_text(encoding="utf-8")
        )
        origins = report["origins"]
        entries = report["source_map"]
    except Exception:
        return []

    mapped: list[str] = []
    seen: set[tuple[int, int]] = set()
    pattern = re.compile(r"(?:^|\n)(?:[^\n]*[/\\])?main\.typ:(\d+):(\d+):")
    for match in pattern.finditer(stderr):
        offset = _byte_offset(generated, int(match.group(1)), int(match.group(2)))
        if offset is None:
            continue
        origin_id = None
        for entry in entries:
            value = entry.get("generated_range", {})
            start, end = value.get("start"), value.get("end")
            if (
                isinstance(start, int)
                and isinstance(end, int)
                and start <= offset < end
            ):
                origin_id = entry.get("origin_id")
                break
        while isinstance(origin_id, int) and 0 <= origin_id < len(origins):
            origin = origins[origin_id]
            if origin.get("type") == "mmt_range":
                start = origin.get("range", {}).get("start")
                if isinstance(start, int):
                    position = _mmt_position(source, start)
                    if position is not None and position not in seen:
                        seen.add(position)
                        mapped.append(f"MMT {position[0]}:{position[1]}")
                break
            origin_id = origin.get("parent")
    return mapped


def run_typst(
    *,
    typst_bin: str,
    template: Path,
    input_json: Path,
    out_path: Path,
    tags_root: Path,
    out_format: str,
    input_key: str = "chat",
    extra_inputs: Optional[dict[str, str]] = None,
) -> None:
    # Invoke Typst with sandboxing if configured.
    pack_v2_root = plugin_config.pack_v2_root_path()
    if pack_v2_root.exists():
        root = common_root(template, input_json, out_path, tags_root, pack_v2_root)
    else:
        root = common_root(template, input_json, out_path, tags_root)
    cwd = template.parent
    rel_in = Path(os.path.relpath(input_json.absolute(), start=cwd.absolute()))
    rel_out = Path(os.path.relpath(out_path.absolute(), start=cwd.absolute()))
    rel_tpl = Path(os.path.relpath(template.absolute(), start=cwd.absolute()))

    cmd = [
        typst_bin,
        "compile",
        str(rel_tpl).replace("\\", "/"),
        str(rel_out).replace("\\", "/"),
        "--format",
        out_format,
        *(
            ["--ppi", str(int(plugin_config.mmt_png_ppi))]
            if out_format.lower() == "png"
            and int(getattr(plugin_config, "mmt_png_ppi", 0) or 0) > 0
            else []
        ),
        "--root",
        str(root.absolute()).replace("\\", "/"),
        "--input",
        f"{input_key}={str(rel_in).replace('\\', '/')}",
    ]
    if extra_inputs:
        for k, v in extra_inputs.items():
            cmd.extend(["--input", f"{k}={v}"])

    proc = _run_typst_command(cmd, cwd=cwd)
    if proc.returncode != 0:
        raise RuntimeError(
            f"typst failed ({proc.returncode}):\n{proc.stderr or proc.stdout}"
        )


def run_typst_project(
    *, typst_bin: str, project_dir: Path, out_format: str
) -> list[Path]:
    project_dir = project_dir.resolve()
    main = project_dir / "main.typ"
    if not main.is_file():
        raise RuntimeError(f"Rust compiler did not export main.typ under {project_dir}")
    out_format = out_format.strip().lower()
    if out_format not in {"png", "pdf"}:
        raise ValueError(f"unsupported format: {out_format}")

    output_name = "output-{0p}.png" if out_format == "png" else "output.pdf"
    cmd = [
        typst_bin,
        "compile",
        "main.typ",
        output_name,
        "--format",
        out_format,
        *(
            ["--ppi", str(int(plugin_config.mmt_png_ppi))]
            if out_format == "png" and int(plugin_config.mmt_png_ppi) > 0
            else []
        ),
        "--root",
        ".",
        "--diagnostic-format",
        "short",
    ]
    proc = _run_typst_command(cmd, cwd=project_dir)
    if proc.returncode != 0:
        detail = proc.stderr or proc.stdout
        mapped = _map_typst_diagnostics(project_dir, detail)
        suffix = f"\nMapped origins: {', '.join(mapped)}" if mapped else ""
        raise RuntimeError(f"typst failed ({proc.returncode}):\n{detail}{suffix}")
    if out_format == "pdf":
        output = project_dir / output_name
        if output.is_file():
            return [output]
        raise RuntimeError("typst succeeded but no PDF output was generated")

    def page_key(path: Path) -> tuple[int, str]:
        numbers = re.findall(r"\d+", path.stem)
        return (int(numbers[-1]) if numbers else -1, path.name)

    outputs = sorted(project_dir.glob("output-*.png"), key=page_key)
    if not outputs:
        raise RuntimeError("typst succeeded but no PNG output was generated")
    return outputs


__all__ = ["common_root", "run_typst", "run_typst_project"]
