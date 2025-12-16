from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field


class MMTPipeConfig(BaseModel):
    # Root folder containing `images/students/{id}/tags.json` and images.
    mmt_tags_root: str = Field(default="images/students")
    # Typst template path (usually `mmt_render/mmt_render.typ` in this repo).
    mmt_typst_template: str = Field(default="mmt_render/mmt_render.typ")
    # Work dir for intermediate json/pdf.
    mmt_work_dir: str = Field(default=".cache/nonebot_mmt")
    # Typst executable name/path.
    mmt_typst_bin: str = Field(default="typst")
    # PPI for PNG export (smaller -> faster to send).
    mmt_png_ppi: int = Field(default=144)
    # Delay between sending multiple messages (ms). Used as fallback when we can't send all images in one message.
    mmt_send_delay_ms: int = Field(default=0)
    # Default context window for `[图片]` placeholders.
    mmt_ctx_n: int = Field(default=2)
    # SiliconFlow env var name for reranker key.
    mmt_rerank_key_env: str = Field(default="SILICON_API_KEY")
    # SiliconFlow reranker model.
    mmt_rerank_model: str = Field(default="Qwen/Qwen3-Reranker-8B")
    # Concurrency for rerank resolve.
    mmt_rerank_concurrency: int = Field(default=10)

    def tags_root_path(self) -> Path:
        return Path(self.mmt_tags_root).expanduser()

    def typst_template_path(self) -> Path:
        return Path(self.mmt_typst_template).expanduser()

    def work_dir_path(self) -> Path:
        return Path(self.mmt_work_dir).expanduser()
