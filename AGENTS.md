# MOMOSCRIPT (MMT) KNOWLEDGE BASE

**Generated:** 2026-01-12
**Platform:** Linux / Python 3.10+ / UV Workspace

## OVERVIEW
MomoScript (MMT) is a DSL for scripted visual storytelling (MoeTalk style), featuring a core parser/compiler, a Typst-based rendering engine, and a NoneBot integration.

## STRUCTURE
```
.
├── mmt_core/             # Core DSL parser, compiler, and resolver
├── mmt_nonebot_plugin/   # NoneBot adapter and plugin logic
├── typst_sandbox/        # Rendering engine (Typst) and asset packs
├── tools/                # Build pipelines, validation, and refactor checks
├── examples/             # Reference scripts (.mmt.txt) and outputs
├── bot.py                # Main NoneBot entry point
└── batch_tag_students.py # Student metadata management utility
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| **DSL Parsing** | `mmt_core/dsl_parser.py` | Custom grammar logic |
| **Compilation** | `mmt_core/dsl_compiler.py` | AST to JSON/Typst conversion |
| **Rendering** | `typst_sandbox/mmt_render` | Typst rendering templates |
| **Validation** | `tools/dsl_refactor_check.py` | Golden file regression tests |
| **Pipeline** | `tools/mmt_pipeline.py` | End-to-end (Text -> PDF) runner |
| **Assets** | `typst_sandbox/pack-v2/` | Managed asset bundles |

## CONVENTIONS
- **Workspace**: Managed by `uv`. Root `pyproject.toml` defines workspace members.
- **Logging**: Uses `loguru` exclusively.
- **Testing**: **NO standard pytest**. Uses "Golden File" regression (`tools/dsl_refactor_check.py`).
- **Assets**: Large binaries ignored in git. Metadata (`manifest.json`, `tags.json`) tracked.
- **Typst**: Executed via sandbox (`mmt_core/typst_sandbox.py`) with memory/timeout limits.

## ANTI-PATTERNS (THIS PROJECT)
- **NO** root pollution: (Legacy) Scripts like `bot.py` are at root, but new tools should go in `tools/`.
- **NO** arbitrary file access: Asset paths must be sanitized (basename only).
- **NO** manual JSON editing: Use `dsl_refactor_check.py --update` to regenerate goldens.
- **DO NOT** use `src/` layout (Legacy flat layout is enforced).

## COMMANDS
```bash
# Install dependencies
uv sync

# Run pipeline (Text -> PDF)
uv run tools/mmt_pipeline.py input.mmt.txt

# Run regression tests (Golden Files)
uv run tools/dsl_refactor_check.py

# Run Bot
uv run bot.py
```

## NOTES
- **EULA**: User-specific EULAs must be accepted for certain packs.
- **Performance**: Typst rendering capped at 2GB RAM / 30s timeout.
- **Legacy**: `MMT_DSL_ENGINE=legacy` is deprecated/unsupported.
