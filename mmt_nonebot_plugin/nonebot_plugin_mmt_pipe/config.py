from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field


class MMTPipeConfig(BaseModel):
    # Root folder containing `images/students/{id}/tags.json` and images.
    mmt_tags_root: str = Field(default="typst_sandbox/mmt_render/images/students")
    # Pack v2 root (draft): contains pack folders like `typst_sandbox/pack-v2/ba/manifest.json`.
    mmt_pack_v2_root: str = Field(default="typst_sandbox/pack-v2")
    # Typst template path (usually `typst_sandbox/mmt_render/mmt_render.typ` in this repo).
    mmt_typst_template: str = Field(default="typst_sandbox/mmt_render/mmt_render.typ")
    # Work dir for intermediate json/pdf.
    mmt_work_dir: str = Field(default=".cache/nonebot_mmt")
    # Rust DSL v2 native compiler and project-export settings.
    mmt_compile_bin: str = Field(default="mmt_rs/target/release/mmt-compile")
    # Comma-separated pack-v3 manifest paths loaded in order.
    mmt_pack_v3_manifests: str = Field(
        default="typst_sandbox/pack-v3/ba_kivo/manifest.json"
    )
    mmt_template_v2_dir: str = Field(default="typst_sandbox/mmt_render")
    mmt_materialize_cache_dir: str = Field(default=".cache/nonebot_mmt/materialized")
    mmt_compile_timeout_s: float = Field(default=30.0)
    mmt_workspace_root: str = Field(default=".")
    mmt_avifdec_bin: str = Field(default="avifdec")
    mmt_decoder_profile: str = Field(default="avifdec-dav1d-png-v1")
    # Typst executable name/path.
    mmt_typst_bin: str = Field(default="typst")
    # Typst rendering sandbox: wall-clock timeout (seconds).
    mmt_typst_timeout_s: float = Field(default=30.0)
    # Typst rendering sandbox: max memory (MB). On Windows this is enforced via procgov/job object.
    mmt_typst_maxmem_mb: int = Field(default=2048)
    # Limit Typst parallelism (Typst uses Rayon); 1-4 is usually enough.
    mmt_typst_rayon_threads: int = Field(default=4)
    # Optional: path/name of procgov (Process Governor). If installed, it will be used automatically on Windows.
    mmt_procgov_bin: str = Field(default="")
    # Prefer procgov when available (Windows).
    mmt_typst_enable_procgov: bool = Field(default=True)
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

    # External asset cache dir (for [:https://...] and @asset.*).
    # Default keeps assets under typst_sandbox to avoid widening Typst --root.
    mmt_asset_cache_dir: str = Field(default="typst_sandbox/mmt_render/.assets")
    # Force redownload external assets (overrides cache).
    mmt_asset_redownload: bool = Field(default=False)
    # Max download size (MB) for external assets.
    mmt_asset_max_mb: int = Field(default=10)
    # Allow @asset.* to reference local images under mmt_asset_local_prefixes.
    mmt_asset_allow_local: bool = Field(default=False)
    # Comma-separated list of allowed first path segments for local @asset.* (default: mmt_assets).
    mmt_asset_local_prefixes: str = Field(default="mmt_assets")

    def tags_root_path(self) -> Path:
        return Path(self.mmt_tags_root).expanduser()

    def pack_v2_root_path(self) -> Path:
        return Path(self.mmt_pack_v2_root).expanduser()

    def typst_template_path(self) -> Path:
        return Path(self.mmt_typst_template).expanduser()

    def work_dir_path(self) -> Path:
        return Path(self.mmt_work_dir).expanduser()

    def compile_bin_path(self) -> Path:
        return Path(self.mmt_compile_bin).expanduser()

    def pack_v3_manifest_paths(self) -> list[Path]:
        return [
            Path(value.strip()).expanduser()
            for value in self.mmt_pack_v3_manifests.split(",")
            if value.strip()
        ]

    def template_v2_dir_path(self) -> Path:
        return Path(self.mmt_template_v2_dir).expanduser()

    def materialize_cache_dir_path(self) -> Path:
        return Path(self.mmt_materialize_cache_dir).expanduser()

    def workspace_root_path(self) -> Path:
        return Path(self.mmt_workspace_root).expanduser()

    def asset_cache_dir_path(self) -> Path:
        if self.mmt_asset_cache_dir.strip():
            return Path(self.mmt_asset_cache_dir).expanduser()
        return self.work_dir_path() / "assets"

    def asset_local_prefixes_list(self) -> list[str]:
        return [
            x.strip()
            for x in str(self.mmt_asset_local_prefixes).split(",")
            if x.strip()
        ]
