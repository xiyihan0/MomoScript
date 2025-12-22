from __future__ import annotations

import os
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
            if out_format.lower() == "png" and int(getattr(plugin_config, "mmt_png_ppi", 0) or 0) > 0
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

    if run_typst_sandboxed is not None and TypstSandboxOptions is not None:
        procgov_bin = (plugin_config.mmt_procgov_bin or "").strip() or None
        opts = TypstSandboxOptions(
            timeout_s=float(getattr(plugin_config, "mmt_typst_timeout_s", 30.0) or 30.0),
            max_mem_mb=int(getattr(plugin_config, "mmt_typst_maxmem_mb", 0) or 0) or None,
            rayon_threads=int(getattr(plugin_config, "mmt_typst_rayon_threads", 0) or 0) or None,
            procgov_bin=procgov_bin,
            enable_procgov=bool(getattr(plugin_config, "mmt_typst_enable_procgov", True)),
        )
        proc = run_typst_sandboxed(cmd, cwd=cwd, options=opts)
    else:
        proc = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"typst failed ({proc.returncode}):\n{proc.stderr or proc.stdout}")


__all__ = ["common_root", "run_typst"]
