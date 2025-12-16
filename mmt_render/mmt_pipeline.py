from __future__ import annotations

import argparse
import json
import subprocess
import sys
import os
from pathlib import Path
from typing import Optional

try:
    from mmt_render import mmt_text_to_json
    from mmt_render.resolve_expressions import resolve_file
    from mmt_render.typst_sandbox import TypstSandboxOptions, run_typst_sandboxed
except ModuleNotFoundError:
    import mmt_text_to_json  # type: ignore
    from resolve_expressions import resolve_file  # type: ignore
    from typst_sandbox import TypstSandboxOptions, run_typst_sandboxed  # type: ignore


def _find_tags_root(start: Path) -> Optional[Path]:
    """
    Find an existing `images/students` folder.
    Works even when `mmt_render` is a symlink to a sibling folder.
    """
    p = start
    for _ in range(10):
        direct = p / "images" / "students"
        if direct.exists():
            return direct
        # scan siblings under this parent (e.g. ../bluearchive-imgtagger/images/students)
        parent = p.parent
        if parent != p and parent.exists():
            for sib in parent.iterdir():
                cand = sib / "images" / "students"
                if cand.exists():
                    return cand
        if p.parent == p:
            break
        p = p.parent
    return None


def _typst_root_for(template: Path, chat_json: Path, tags_root: Path) -> Path:
    # Choose a root that contains all paths so typst can access them.
    common = os.path.commonpath([str(template.absolute()), str(chat_json.absolute()), str(tags_root.absolute())])
    return Path(common)


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        if k and k not in os.environ:
            os.environ[k] = v


def _default_paths(input_txt: Path) -> tuple[Path, Path, Path]:
    out_json = input_txt.with_suffix(".json")
    out_resolved = input_txt.with_suffix(".resolved.json")
    out_pdf = input_txt.with_suffix(".pdf")
    return out_json, out_resolved, out_pdf


def _run_typst(
    template: Path,
    pdf_out: Path,
    chat_json: Path,
    *,
    typst_mode: bool = False,
    disable_heading: bool = False,
    no_time: bool = False,
) -> None:
    tags_root = _find_tags_root(Path.cwd())
    if tags_root is None:
        raise RuntimeError("Cannot find images/students; please pass --tags-root explicitly.")

    root = _typst_root_for(template, chat_json, tags_root)
    # Typst resolves `json("...")` paths relative to the *source file directory*,
    # so pass the `chat` input relative to `template.parent`, not `--root`.
    cwd = template.absolute().parent
    rel_chat = Path(os.path.relpath(chat_json.absolute(), start=cwd.absolute()))
    rel_out = Path(os.path.relpath(pdf_out.absolute(), start=cwd.absolute()))
    rel_tpl = Path(os.path.relpath(template.absolute(), start=cwd.absolute()))
    cmd = [
        "typst",
        "compile",
        str(rel_tpl).replace("\\", "/"),
        str(rel_out).replace("\\", "/"),
        "--root",
        str(root.absolute()).replace("\\", "/"),
        "--input",
        f"chat={str(rel_chat).replace('\\', '/')}",
    ]
    if not no_time:
        cmd.extend(["--input", f"compiled_at={__import__('time').strftime('%Y-%m-%d %H:%M:%S')}"])
    if typst_mode:
        cmd.extend(["--input", "typst_mode=1"])
    if disable_heading:
        cmd.extend(["--input", "disable_heading=1"])

    # Best-effort sandbox: allow controlling via env without changing CLI surface too much.
    def _env_float(name: str, default: float) -> float:
        try:
            return float(os.environ.get(name, "").strip() or default)
        except Exception:
            return default

    def _env_int(name: str, default: int) -> int:
        try:
            return int(float(os.environ.get(name, "").strip() or default))
        except Exception:
            return default

    timeout_s = _env_float("MMT_TYPST_TIMEOUT_S", 30.0)
    max_mem_mb = _env_int("MMT_TYPST_MAXMEM_MB", 2048)
    rayon_threads = _env_int("MMT_TYPST_RAYON_THREADS", 4)
    procgov_bin = os.environ.get("MMT_PROCGOV_BIN", "").strip() or None
    enable_procgov = os.environ.get("MMT_TYPST_ENABLE_PROCGOV", "1").strip() not in {"0", "false", "False"}

    opts = TypstSandboxOptions(
        timeout_s=timeout_s if timeout_s > 0 else None,
        max_mem_mb=max_mem_mb if max_mem_mb > 0 else None,
        rayon_threads=rayon_threads if rayon_threads > 0 else None,
        procgov_bin=procgov_bin,
        enable_procgov=enable_procgov,
    )
    result = run_typst_sandboxed(cmd, cwd=cwd, options=opts)
    if result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, cmd, output=result.stdout, stderr=result.stderr)


def main() -> int:
    p = argparse.ArgumentParser(description="MMT pipeline: text -> json -> (optional) resolve -> (optional) pdf.")
    p.add_argument("input", help="Input MMT .txt")
    p.add_argument("--out-json", default=None)
    p.add_argument("--out-resolved", default=None)
    p.add_argument("--out-pdf", default=None)
    p.add_argument("--report", default=None, help="Write parse report json (optional)")
    p.add_argument("--ctx-n", type=int, default=2, help="Global context window size for '[图片]' (default: 2)")
    p.add_argument(
        "--typst",
        action="store_true",
        help="Typst markup mode: only parse expression markers written as '[:...]', leaving other '[...]' for Typst.",
    )

    p.add_argument("--resolve", action="store_true", help="Resolve inline [..] expressions to images via reranker.")
    tags_root_guess = _find_tags_root(Path.cwd())
    p.add_argument("--tags-root", default=str(tags_root_guess) if tags_root_guess else "images/students")
    p.add_argument("--rerank-model", default="Qwen/Qwen3-Reranker-8B")
    p.add_argument("--rerank-key-env", default="SILICON_API_KEY")
    p.add_argument("--rerank-concurrency", type=int, default=10)

    p.add_argument("--pdf", action="store_true", help="Render PDF via typst.")
    p.add_argument("--typst-template", default=str(Path(__file__).resolve().parent / "mmt_render.typ"))
    p.add_argument("--disable-heading", action="store_true", help="Disable the MoeTalk-style heading bar.")
    p.add_argument("--no-time", action="store_true", help="Do not auto-fill compiled_at time.")
    args = p.parse_args()

    # Load env vars if user keeps secrets in .env (cwd or parent)
    try:
        _load_dotenv(Path.cwd() / ".env")
        _load_dotenv(Path.cwd().parent / ".env")
    except Exception:
        pass

    in_path = Path(args.input).absolute()
    out_json_default, out_resolved_default, out_pdf_default = _default_paths(in_path)
    out_json = Path(args.out_json).resolve() if args.out_json else out_json_default
    out_resolved = Path(args.out_resolved).resolve() if args.out_resolved else out_resolved_default
    out_pdf = Path(args.out_pdf).resolve() if args.out_pdf else out_pdf_default
    report_path = Path(args.report).resolve() if args.report else None

    # Parse text -> json
    name_map_path = Path("avatar/name_to_id.json")
    avatar_dir = Path("avatar")
    # Use same convenience logic as mmt_text_to_json.main()
    if not name_map_path.exists():
        candidate = in_path.parent / "avatar" / "name_to_id.json"
        if candidate.exists():
            name_map_path = candidate
    if not avatar_dir.exists():
        candidate = in_path.parent / "avatar"
        if candidate.exists():
            avatar_dir = candidate
    name_map = mmt_text_to_json._load_name_to_id(name_map_path)
    text = in_path.read_text(encoding="utf-8")
    data, report = mmt_text_to_json.convert_text(
        text,
        name_to_id=name_map,
        avatar_dir=avatar_dir,
        join_with_newline=True,
        context_window=max(0, int(args.ctx_n)),
        typst_mode=bool(args.typst),
    )
    out_json.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if report_path:
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    chat_for_render = out_json
    if args.resolve:
        # Resolve expressions -> resolved json
        import asyncio

        tags_root = Path(args.tags_root).absolute()
        template = Path(args.typst_template).absolute()
        root = _typst_root_for(template, out_json, tags_root)
        asyncio.run(
            resolve_file(
                input_path=out_json,
                output_path=out_resolved,
                tags_root=tags_root,
                # refs should be relative to the typst source dir, not project root
                ref_root=template.parent,
                model=args.rerank_model,
                api_key_env=args.rerank_key_env,
                concurrency=args.rerank_concurrency,
            )
        )
        chat_for_render = out_resolved

    if args.pdf:
        template = Path(args.typst_template).resolve()
        _run_typst(
            template,
            out_pdf,
            chat_for_render,
            typst_mode=bool(args.typst),
            disable_heading=bool(args.disable_heading),
            no_time=bool(args.no_time),
        )

    print(f"[ok] json={out_json}")
    if args.resolve:
        print(f"[ok] resolved={out_resolved}")
    if args.pdf:
        print(f"[ok] pdf={out_pdf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
