from __future__ import annotations

import argparse
import base64
import concurrent.futures
import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

from llm_request import OpenAIChat, load_openai_config, LlmRequestError, load_dotenv


IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp"}


PROMPT_FIRST_BATCH = """\
我现在想要建立一个蔚蓝档案的表情检索器，请对这里的所有图片按顺序建立类似这样的模型，组装成json列表返回：
{ "tags": ["smile", "closed_eyes",...], "description": "(简单的中文文本自然语言描述)..." }
(注意，请只输出json结果)
"""


PROMPT_NEXT_BATCH = """\
我现在想要建立一个蔚蓝档案的表情检索器，请对这里的所有图片按顺序建立类似这样的模型，组装成json列表返回：
{ "tags": ["smile", "closed_eyes",...], "description": "(简单的中文文本自然语言描述)..." }

这是前几轮的json响应结果，供参考:
```json
{prev_result}
```

(注意，请只输出此轮图片对应的json结果,不要拼接)
"""


def _read_image_as_data_url(path: Path) -> str:
    ext = path.suffix.lower().lstrip(".") or "png"
    mime = "image/png" if ext == "png" else f"image/{ext}"
    data = path.read_bytes()
    b64 = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{b64}"


def _extract_json(text: str) -> Any:
    text = text.strip()
    if not text:
        raise ValueError("empty response")

    # Strip common fences
    if text.startswith("```"):
        parts = text.split("```")
        # Try to find the fenced payload
        for p in parts:
            p = p.strip()
            if not p or p.lower().startswith("json"):
                continue
            text = p
            break

    # Find first JSON container
    start_candidates = [i for i in (text.find("["), text.find("{")) if i != -1]
    if start_candidates:
        text = text[min(start_candidates) :]

    # Trim trailing junk after last closing bracket/brace
    last = max(text.rfind("]"), text.rfind("}"))
    if last != -1:
        text = text[: last + 1]

    return json.loads(text)


def _is_result_item(obj: Any) -> bool:
    return (
        isinstance(obj, dict)
        and isinstance(obj.get("tags"), list)
        and all(isinstance(x, str) for x in obj.get("tags", []))
        and isinstance(obj.get("description"), str)
    )


def _validate_batch_result(parsed: Any, expected_len: int) -> List[Dict[str, Any]]:
    if not isinstance(parsed, list):
        raise ValueError("response is not a JSON list")
    if len(parsed) != expected_len:
        raise ValueError(f"expected {expected_len} items, got {len(parsed)}")
    if not all(_is_result_item(x) for x in parsed):
        raise ValueError("one or more items do not match schema")
    return parsed  # type: ignore[return-value]


def _build_messages(prompt: str, image_paths: Sequence[Path]) -> List[Dict[str, Any]]:
    names = "\n".join([f"- {i+1}. {p.name}" for i, p in enumerate(image_paths)])
    prompt = (
        prompt.rstrip()
        + "\n\n"
        + f"本轮共有 {len(image_paths)} 张图片。你必须输出一个严格 JSON 数组，长度必须恰好等于 {len(image_paths)}。\n"
        + "数组第 i 项严格对应第 i 张图片，顺序不能改变；即使不确定也必须输出占位项（tags 可为空数组，但必须有 description）。\n"
        + "本轮图片文件名顺序如下：\n"
        + names
    )

    content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
    for i, p in enumerate(image_paths):
        content.append({"type": "text", "text": f"第 {i+1} 张：{p.name}"})
        content.append({"type": "image_url", "image_url": {"url": _read_image_as_data_url(p)}})
    return [{"role": "user", "content": content}]


@dataclass
class FolderResult:
    items: List[Dict[str, Any]]

    def to_prev_result_str(self, max_items: int = 16) -> str:
        # Keep it small to avoid ballooning context: last N items
        tail = self.items[-max_items:] if len(self.items) > max_items else self.items
        return json.dumps(tail, ensure_ascii=False, separators=(",", ":"))


def _iter_student_folders(root: Path) -> List[Path]:
    if not root.exists():
        return []
    folders = [p for p in root.iterdir() if p.is_dir()]
    # numeric sort by folder name if possible
    def key(p: Path):
        try:
            return (0, int(p.name))
        except Exception:
            return (1, p.name)

    return sorted(folders, key=key)


def _iter_images(folder: Path) -> List[Path]:
    imgs = [p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in IMAGE_EXTS]
    return sorted(imgs, key=lambda p: p.name)


def _chunk(seq: Sequence[Path], size: int) -> List[List[Path]]:
    return [list(seq[i : i + size]) for i in range(0, len(seq), size)]


def _make_prompt(prev_items: Sequence[Dict[str, Any]], is_first_batch: bool) -> str:
    if is_first_batch and not prev_items:
        return PROMPT_FIRST_BATCH
    prev = FolderResult(items=list(prev_items)).to_prev_result_str()
    return PROMPT_NEXT_BATCH.replace("{prev_result}", prev)


def _call_llm_for_batch(
    *,
    llm: OpenAIChat,
    prompt: str,
    batch: Sequence[Path],
    max_attempts: int = 3,
) -> List[Dict[str, Any]]:
    messages = _build_messages(prompt, batch)
    last_err: Optional[str] = None
    for _ in range(max_attempts):
        try:
            text = llm.chat(messages)
            parsed = _extract_json(text)
            return _validate_batch_result(parsed, expected_len=len(batch))
        except (LlmRequestError, ValueError, json.JSONDecodeError) as exc:
            last_err = str(exc)
            repair = (
                "你的输出不符合要求：必须是严格 JSON 数组，长度必须等于图片数量，"
                "每项必须包含 tags(字符串数组) 和 description(字符串)。请只输出 JSON。"
            )
            messages = _build_messages(repair + "\n\n" + prompt, batch)
    raise LlmRequestError(last_err or "LLM failed")


def _process_images_with_fallback(
    *,
    llm: OpenAIChat,
    prev_items: Sequence[Dict[str, Any]],
    image_paths: Sequence[Path],
    is_first_batch: bool,
) -> List[Dict[str, Any]]:
    prompt = _make_prompt(prev_items, is_first_batch=is_first_batch)
    try:
        return _call_llm_for_batch(llm=llm, prompt=prompt, batch=image_paths)
    except Exception:
        if len(image_paths) <= 1:
            raise
        mid = len(image_paths) // 2
        left = _process_images_with_fallback(
            llm=llm,
            prev_items=prev_items,
            image_paths=image_paths[:mid],
            is_first_batch=is_first_batch,
        )
        right = _process_images_with_fallback(
            llm=llm,
            prev_items=list(prev_items) + left,
            image_paths=image_paths[mid:],
            is_first_batch=False,
        )
        return left + right


_print_lock = threading.Lock()


def _safe_print(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def _process_one_folder(folder: Path, args: argparse.Namespace, cfg) -> None:
    client = OpenAIChat(cfg)

    images = _iter_images(folder)
    if args.max_images and args.max_images > 0:
        images = images[: args.max_images]

    out_path = folder / args.out_name
    existing: List[Dict[str, Any]] = []
    if out_path.exists():
        if not args.resume:
            _safe_print(f"skip folder (already has {out_path.name}): {folder.name}")
            return
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
            if not isinstance(existing, list):
                raise ValueError("existing output is not a list")
        except Exception as exc:
            raise RuntimeError(f"cannot resume; invalid existing json: {out_path}: {exc}") from exc

    start_idx = len(existing)
    if start_idx >= len(images):
        _safe_print(f"skip folder (already complete): {folder.name}")
        return

    images_to_process = images[start_idx:]
    folder_result = FolderResult(items=list(existing))
    batches = _chunk(images_to_process, args.batch_size)

    _safe_print(f"folder {folder.name}: {len(images)} images, start={start_idx}, batches={len(batches)}")

    for batch_i, batch in enumerate(batches):
        is_first_batch = start_idx == 0 and batch_i == 0 and not folder_result.items
        try:
            items = _process_images_with_fallback(
                llm=client, prev_items=folder_result.items, image_paths=batch, is_first_batch=is_first_batch
            )
        except Exception as exc:
            raise RuntimeError(f"LLM failed after retries in {folder.name}: {exc}") from exc

        # Join filenames after we know output is aligned with image order
        for img_path, item in zip(batch, items):
            item = dict(item)
            item["image_name"] = img_path.name
            folder_result.items.append(item)

        out_path.write_text(json.dumps(folder_result.items, ensure_ascii=False, indent=2), encoding="utf-8")
        _safe_print(
            f"  [{folder.name}] batch {batch_i+1}/{len(batches)} ok -> {out_path.name} ({len(folder_result.items)}/{len(images)})"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Batch tag student images via an OpenAI-compatible API.")
    parser.add_argument("--images-root", type=str, default="images/students")
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument(
        "--folder-concurrency",
        type=int,
        default=1,
        help="How many student folders to process concurrently (default: 1).",
    )
    parser.add_argument("--model", type=str, default="gemini-3-pro-preview-maxthinking")
    parser.add_argument("--base-url", type=str, default="https://gcli.ggchan.dev/v1")
    parser.add_argument("--api-key-env", type=str, default="GCLI_API_KEY")
    parser.add_argument("--dotenv", type=str, default=".env", help="Load env vars from this file if present.")
    parser.add_argument("--dotenv-override", action="store_true", help="Override existing env vars from .env.")
    parser.add_argument("--out-name", type=str, default="tags.json", help="Output filename under each folder.")
    parser.add_argument("--resume", action="store_true", help="Resume if output exists; append missing items.")
    parser.add_argument("--max-folders", type=int, default=0, help="Only process first N folders (0 = all).")
    parser.add_argument("--max-images", type=int, default=0, help="Only process first N images per folder (0 = all).")
    args = parser.parse_args()

    load_dotenv(args.dotenv, override=bool(args.dotenv_override))

    if args.batch_size <= 0:
        raise SystemExit("--batch-size must be > 0")

    cfg = load_openai_config(model=args.model, base_url=args.base_url, api_key_env=args.api_key_env)

    root = Path(args.images_root)
    folders = _iter_student_folders(root)
    if args.max_folders and args.max_folders > 0:
        folders = folders[: args.max_folders]

    folder_conc = int(args.folder_concurrency or 1)
    if folder_conc <= 1 or len(folders) <= 1:
        for folder in folders:
            _process_one_folder(folder, args, cfg)
        return 0

    _safe_print(f"processing {len(folders)} folders with folder_concurrency={folder_conc}")
    futures: list[concurrent.futures.Future[None]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=folder_conc) as ex:
        for folder in folders:
            futures.append(ex.submit(_process_one_folder, folder, args, cfg))

        try:
            for fut in concurrent.futures.as_completed(futures):
                fut.result()
        except Exception as exc:
            # Best-effort cancel outstanding work; in-flight HTTP calls can't be interrupted reliably.
            for f in futures:
                f.cancel()
            raise SystemExit(str(exc)) from exc

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
