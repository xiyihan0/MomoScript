# MMT NONEBOT PLUGIN KNOWLEDGE BASE

**Domain:** Bot Adapter & Command Logic
**Platform:** NoneBot2 / Alconna / OneBot v11

## OVERVIEW
The `mmt_nonebot_plugin` (specifically `nonebot_plugin_mmt_pipe`) adapts the MMT DSL pipeline for chat platforms. It handles user input, resolves character/asset expressions (via reranking), invokes the Typst sandbox, and uploads resulting PNGs/PDFs.

## STRUCTURE
```
mmt_nonebot_plugin/nonebot_plugin_mmt_pipe/
├── commands/           # Alconna command definitions & matchers
│   ├── mmt.py          # /mmt and /mmtpdf
│   ├── img.py          # /mmt-img and /mmt-imgmatch
│   ├── pack.py         # /mmt-pack (EULA management)
│   └── registry.py     # Alconna namespace & shared options
├── services/           # Business logic & Pipeline glue
│   ├── mmt.py          # Main MMT pipeline (Parse -> Resolve -> Render)
│   ├── pack.py         # Pack-v2 resolution & EULA enforcement
│   ├── io.py           # OneBot I/O (Image sending, file uploads)
│   ├── assets.py       # Persistent asset management (/mmt-asset)
│   └── typst.py        # Typst CLI invocation wrapper
├── pack_store.py       # EULA (SQLite) & Pack validation logic
├── config.py           # Pydantic configuration model
└── plugin.py           # Entry point (matcher registration)
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| **Plugin Entry** | `plugin.py` | Imports all command modules |
| **Command Logic** | `commands/mmt.py` | Flags parsing & `handle_mmt_common` call |
| **Pipeline Flow** | `services/mmt.py` | Orchestrates the `mmt_core` -> Typst flow |
| **EULA/Packs** | `services/pack.py` | Logic for `@usepack` and user acceptance |
| **Rendering** | `services/typst.py` | Sandbox limits & temporary file cleanup |
| **OneBot I/O** | `services/io.py` | Adapter-specific message segment handling |

## CONVENTIONS
- **Command Parsing**: Strictly use `nonebot-plugin-alconna`. Define shared options in `registry.py`.
- **Configuration**: Access via `plugin_config` from `context.py`. Never use `os.getenv` directly.
- **Services**: All complex logic must reside in `services/`. Command handlers should be thin wrappers.
- **Error Handling**: Services should raise `RuntimeError` with user-friendly messages.
- **Paths**: Use `Path` objects. Use `plugin_config.work_dir_path()` for temporary files.

## ANTI-PATTERNS
- **NO** direct `mmt_core` imports in `commands/`: Use `services/` as a bridge.
- **NO** hardcoded OneBot IDs: Use `event_scope_ids` from `services/common.py`.
- **NO** direct DB queries: Use `EulaDB` from `pack_store.py` or `AssetStore` from `assets_store.py`.
- **AVOID** blocking I/O: Use `anyio.to_thread.run_sync` for Typst CLI or DB calls if needed (though NoneBot matchers are usually async).
