from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import shutil
import subprocess
import time
import uuid
from pathlib import Path
from typing import Optional

from nonebot import logger
from nonebot.adapters import Bot, Event

from ..context import plugin_config
from .common import extract_invoker_name, format_pdf_name
from .io import (
    decode_text_file,
    download_text_file,
    extract_text_file_url,
    onebot_available,
    send_onebot_images,
    upload_onebot_file,
)
from .typst import run_typst_project

_METADATA_RE = re.compile(r"^@(title|author):\s*(.*?)\s*$", re.MULTILINE)


def _absolute(path: Path) -> Path:
    return path.resolve() if path.is_absolute() else (Path.cwd() / path).resolve()


def _document_metadata(text: str, *, fallback_author: str) -> dict[str, str]:
    metadata = {"title": "无题", "author": fallback_author}
    for key, value in _METADATA_RE.findall(text):
        if value:
            metadata[key] = value
    return metadata


def _format_diagnostics(report: dict) -> str:
    diagnostics = report.get("diagnostics")
    if not isinstance(diagnostics, list) or not diagnostics:
        return "Rust DSL v2 编译失败，但未返回诊断。"
    lines: list[str] = []
    for item in diagnostics[:8]:
        if not isinstance(item, dict):
            continue
        phase = str(item.get("phase") or "compile")
        message = str(item.get("message") or "unknown error")
        span = item.get("span")
        location = ""
        if isinstance(span, dict) and isinstance(span.get("start"), dict):
            start = span["start"]
            location = f" {start.get('line', '?')}:{start.get('column', '?')}"
        lines.append(f"[{phase}{location}] {message}")
    return "\n".join(lines) or "Rust DSL v2 编译失败。"


async def _run_compiler(
    *, text: str, project_dir: Path, title: str, author: str
) -> dict:
    compiler = _absolute(plugin_config.compile_bin_path())
    if not compiler.is_file():
        raise RuntimeError(
            f"Rust compiler not found: {compiler}; run "
            "`cargo build --release --bin mmt-compile` first"
        )
    manifests = [_absolute(path) for path in plugin_config.pack_v3_manifest_paths()]
    if not manifests:
        raise RuntimeError("no pack-v3 manifest configured")
    missing = [str(path) for path in manifests if not path.is_file()]
    if missing:
        raise RuntimeError(f"pack-v3 manifest not found: {', '.join(missing)}")
    template_dir = _absolute(plugin_config.template_v2_dir_path())
    if not template_dir.joinpath("lib.typ").is_file():
        raise RuntimeError(f"Typst v2 template library not found: {template_dir}")

    workspace_root = _absolute(plugin_config.workspace_root_path())
    cache_dir = _absolute(plugin_config.materialize_cache_dir_path())
    command = [
        str(compiler),
        "--input",
        "-",
        "--output-dir",
        str(project_dir),
        "--template-dir",
        str(template_dir),
        "--workspace-root",
        str(workspace_root),
        "--cache-dir",
        str(cache_dir),
        "--avifdec-bin",
        str(plugin_config.mmt_avifdec_bin),
        "--decoder-profile",
        str(plugin_config.mmt_decoder_profile),
        "--title",
        title,
        "--author",
        author,
    ]
    for manifest in manifests:
        command.extend(["--manifest", str(manifest)])

    process_options: dict[str, object] = {}
    if os.name == "posix":
        process_options["start_new_session"] = True
    elif os.name == "nt":
        process_options["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    process = await asyncio.create_subprocess_exec(
        *command,
        cwd=str(workspace_root),
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        **process_options,
    )
    timeout = max(1.0, float(plugin_config.mmt_compile_timeout_s))
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(text.encode("utf-8")), timeout=timeout
        )
    except asyncio.TimeoutError:
        if os.name == "posix":
            os.killpg(process.pid, signal.SIGKILL)
            await process.wait()
        elif os.name == "nt":
            killer = await asyncio.create_subprocess_exec(
                "taskkill", "/PID", str(process.pid), "/T", "/F"
            )
            await killer.wait()
            await process.wait()
        else:
            process.kill()
            await process.wait()
        raise RuntimeError(
            f"Rust DSL v2 compilation timed out after {timeout:g}s"
        ) from None

    try:
        report = json.loads(stdout.decode("utf-8"))
    except Exception as exc:
        detail = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(
            f"invalid mmt-compile response: {exc}" + (f"\n{detail}" if detail else "")
        ) from exc
    if process.returncode != 0 or report.get("success") is not True:
        raise RuntimeError(_format_diagnostics(report))
    return report


async def pipe_to_outputs(
    *,
    text: str,
    out_format: str,
    out_dir: Path,
    title: str,
    author: str,
) -> tuple[list[Path], dict[str, str], dict[str, int]]:
    out_format = out_format.strip().lower()
    if out_format not in {"png", "pdf"}:
        raise ValueError(f"unsupported format: {out_format}")
    work_root = _absolute(out_dir)
    work_root.mkdir(parents=True, exist_ok=True)
    project_dir = work_root / f"rust-v2-{time.time_ns()}-{uuid.uuid4().hex[:8]}"

    started = time.perf_counter()
    compile_started = time.perf_counter()
    try:
        await _run_compiler(
            text=text, project_dir=project_dir, title=title, author=author
        )
        compile_finished = time.perf_counter()
        outputs = await asyncio.to_thread(
            run_typst_project,
            typst_bin=plugin_config.mmt_typst_bin,
            project_dir=project_dir,
            out_format=out_format,
        )
    except Exception:
        await asyncio.to_thread(shutil.rmtree, project_dir, True)
        raise
    render_finished = time.perf_counter()
    timings = {
        "compile_ms": int((compile_finished - compile_started) * 1000),
        "render_ms": int((render_finished - compile_finished) * 1000),
        "total_ms": int((render_finished - started) * 1000),
    }
    return outputs, {"title": title, "author": author}, timings


def parse_flags(text: str, *, default_format: str) -> tuple[dict, str]:
    return {
        "help": False,
        "from_file": False,
        "verbose": False,
        "out_format": default_format,
    }, text


async def handle_mmt_common(
    *,
    finish,
    matcher_name: str,
    bot: Bot,
    event: Event,
    raw: str,
    arg_msg: object,
    default_format: str,
    flags_override: Optional[dict] = None,
) -> None:
    total_started = time.perf_counter()
    flags, content = parse_flags(raw, default_format=default_format)
    for key, value in (flags_override or {}).items():
        if value is not None:
            flags[key] = value

    if flags.get("help"):
        await finish(
            "\n".join(
                [
                    f"用法：/{matcher_name} [--png|--pdf] [--file] [-v] <Rust DSL v2 文本>",
                    "",
                    "Rust DSL v2 使用 pack-v3 做确定性资源解析。",
                    "表情示例：[:#1:]、[:星野, sportswear/#1:]",
                    "正文模式：t / T / rt / rT；不再提供旧自然语言 resolve。",
                    "",
                    "选项：",
                    "- --png：输出 PNG（/mmt 默认）",
                    "- --pdf：输出 PDF（/mmtpdf 默认）",
                    "- --format <png|pdf>：指定格式",
                    "- --file：读取回复的 UTF-8 .txt 文件",
                    "- --verbose / -v：返回编译、渲染和发送用时",
                ]
            )
        )

    if not content and not flags.get("from_file"):
        await finish("未检测到 Rust DSL v2 正文。")

    file_read_ms = 0
    if flags.get("from_file"):
        file_started = time.perf_counter()
        try:
            url, _ = await extract_text_file_url(bot, event, arg_msg)
            data = await download_text_file(url, max_bytes=2 * 1024 * 1024)
            file_text = decode_text_file(data)
        except Exception as exc:
            await finish(f"读取文本文件失败：{exc}")
        file_read_ms = int((time.perf_counter() - file_started) * 1000)
        content = (
            (content.rstrip() + "\n" + file_text) if content.strip() else file_text
        )

    metadata = _document_metadata(
        content, fallback_author=extract_invoker_name(event) or ""
    )
    try:
        outputs, meta, timings = await pipe_to_outputs(
            text=content,
            out_format=str(flags.get("out_format") or default_format),
            out_dir=plugin_config.work_dir_path(),
            title=metadata["title"],
            author=metadata["author"],
        )
    except Exception as exc:
        logger.exception("Rust DSL v2 pipeline failed: %s", exc)
        await finish(f"处理失败：{exc}")
    if file_read_ms:
        timings["file_ms"] = file_read_ms

    out_format = str(flags.get("out_format") or default_format).strip().lower()
    project_dir = outputs[0].parent
    if out_format == "pdf":
        upload_name = format_pdf_name(
            meta=meta,
            compiled_at=time.strftime("%Y-%m-%d %H:%M:%S"),
            fallback=outputs[0].stem,
        )
        try:
            upload_started = time.perf_counter()
            await upload_onebot_file(bot, event, outputs[0], file_name=upload_name)
            upload_ms = int((time.perf_counter() - upload_started) * 1000)
        except Exception as exc:
            logger.warning("upload Rust v2 PDF failed: %s", exc)
            await finish(f"已生成：{outputs[0]}（上传失败：{exc}）")
        await asyncio.to_thread(shutil.rmtree, project_dir, True)
        if flags.get("verbose"):
            timings["upload_ms"] = upload_ms
            timings["total_ms"] = int((time.perf_counter() - total_started) * 1000)
            await finish("用时：" + ", ".join(f"{k}={v}ms" for k, v in timings.items()))
        await finish()

    if not onebot_available():
        await finish(f"已生成图片：{outputs[0]}")
    send_started = time.perf_counter()
    await send_onebot_images(bot, event, outputs)
    send_ms = int((time.perf_counter() - send_started) * 1000)
    await asyncio.to_thread(shutil.rmtree, project_dir, True)
    if flags.get("verbose"):
        timings["send_ms"] = send_ms
        timings["total_ms"] = int((time.perf_counter() - total_started) * 1000)
        await finish("用时：" + ", ".join(f"{k}={v}ms" for k, v in timings.items()))
    await finish()


__all__ = ["handle_mmt_common", "parse_flags", "pipe_to_outputs"]
