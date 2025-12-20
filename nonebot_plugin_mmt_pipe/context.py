from __future__ import annotations

from nonebot import get_driver

from .config import MMTPipeConfig


driver = get_driver()
raw_cfg = driver.config
try:
    # nonebot uses pydantic settings (v1/v2) depending on version
    cfg_dict = raw_cfg.model_dump()  # type: ignore[attr-defined]
except Exception:
    try:
        cfg_dict = raw_cfg.dict()  # type: ignore[attr-defined]
    except Exception:
        cfg_dict = dict(raw_cfg)  # type: ignore[arg-type]

plugin_config = MMTPipeConfig.model_validate(cfg_dict)
