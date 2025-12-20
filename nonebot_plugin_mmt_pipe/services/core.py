from __future__ import annotations

# Compatibility re-exports after module split.
from .assets import asset_db_and_dir, handle_mmt_asset
from .common import (
    event_scope_ids,
    extract_invoker_name,
    find_name_map_and_avatar_dir,
    format_pdf_name,
    image_order_key,
    inject_author_if_missing,
    join_tokens,
    parse_opts_tokens,
    parse_pack_csv,
    safe_stem,
    sanitize_filename_component,
)
from .img import handle_imgmatch, handle_mmt_img
from .io import (
    decode_text_file,
    download_text_file,
    event_message_or_empty,
    extract_image_url,
    extract_text_file_url,
    onebot_available,
    send_onebot_images,
    upload_onebot_file,
)
from .mmt import handle_mmt_common, parse_flags, pipe_to_outputs, render_syntax_help_pngs
from .pack import (
    enforce_pack_eulas_or_raise,
    handle_mmt_pack,
    load_ba_pack_v2,
    load_pack_v2_by_id,
    resolve_pack_v2_sources_for_character,
    resolve_tags_file_and_images_dir_for_character,
)
from .typst import common_root, run_typst

__all__ = [
    "asset_db_and_dir",
    "common_root",
    "decode_text_file",
    "download_text_file",
    "enforce_pack_eulas_or_raise",
    "event_message_or_empty",
    "event_scope_ids",
    "extract_image_url",
    "extract_invoker_name",
    "extract_text_file_url",
    "find_name_map_and_avatar_dir",
    "format_pdf_name",
    "handle_imgmatch",
    "handle_mmt_asset",
    "handle_mmt_common",
    "handle_mmt_img",
    "handle_mmt_pack",
    "image_order_key",
    "inject_author_if_missing",
    "join_tokens",
    "load_ba_pack_v2",
    "load_pack_v2_by_id",
    "onebot_available",
    "parse_flags",
    "parse_opts_tokens",
    "parse_pack_csv",
    "pipe_to_outputs",
    "render_syntax_help_pngs",
    "resolve_pack_v2_sources_for_character",
    "resolve_tags_file_and_images_dir_for_character",
    "run_typst",
    "safe_stem",
    "sanitize_filename_component",
    "send_onebot_images",
    "upload_onebot_file",
]
