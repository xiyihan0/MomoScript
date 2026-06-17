# MOMOSCRIPT (MMT) KNOWLEDGE BASE

**Generated:** 2026-01-12
**Platform:** Linux / Python 3.10+ / UV Workspace

## OVERVIEW
MomoScript (MMT) is a DSL for scripted visual storytelling (MoeTalk style), featuring a core parser/compiler, a Typst-based rendering engine, and a NoneBot integration.

## STRUCTURE
```
.
├── mmt_core/             # Core DSL parser, compiler, and resolver
├── mmt_rs/               # Experimental Rust/WASM language-core work
├── mmt_nonebot_plugin/   # NoneBot adapter and plugin logic
├── typst_sandbox/        # Rendering engine (Typst) and asset packs
├── tools/                # Build pipelines, validation, and refactor checks
├── web/                  # Vite/React editor and WASM integration
├── openspec/             # Specs, active design changes, and planning notes
├── examples/             # Reference scripts (.mmt.txt) and outputs
├── bot.py                # Main NoneBot entry point
└── batch_tag_students.py # Student metadata management utility
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| **DSL Parsing** | `mmt_core/dsl_parser.py` | Custom grammar logic |
| **Compilation** | `mmt_core/dsl_compiler.py` | AST to JSON/Typst conversion |
| **Implemented DSL Syntax** | `openspec/specs/dsl-syntax/spec.md` | Spec aligned to parser/compiler behavior |
| **Draft DSL v2 Syntax** | `openspec/changes/redesign-dsl-syntax-v2/` | Next parser/emitter design; includes Rust parser architecture |
| **Rust/WASM Core** | `mmt_rs/` | Experimental Rust implementation; may be replaced by the v2 design |
| **Rendering** | `typst_sandbox/mmt_render` | Typst rendering templates |
| **Validation** | `tools/dsl_refactor_check.py` | Golden file regression tests |
| **Pipeline** | `tools/mmt_pipeline.py` | End-to-end (Text -> PDF) runner |
| **Assets** | `typst_sandbox/pack-v2/` | Managed asset bundles |
| **Resource Pack v3 Draft** | `openspec/changes/design-resource-pack-v3/` | Manifest, AVIFS storage, Kivo builder notes |

## CONVENTIONS
- **Workspace**: Managed by `uv`. Root `pyproject.toml` defines workspace members.
- **Logging**: Uses `loguru` exclusively.
- **Testing**: **NO standard pytest**. Uses "Golden File" regression (`tools/dsl_refactor_check.py`).
- **Assets**: Large binaries ignored in git. Metadata (`manifest.json`, `tags.json`) tracked.
- **Typst**: Executed via sandbox (`mmt_core/typst_sandbox.py`) with memory/timeout limits.
- **OpenSpec**: Substantial DSL/rendering/workflow changes should be described under `openspec/changes/` and aligned to `openspec/specs/`.
- **Syntax Truth Source**: Treat `mmt_core/dsl_parser.py`, `mmt_core/dsl_compiler.py`, and `openspec/specs/dsl-syntax/spec.md` as the source of truth for implemented syntax. `typst_sandbox/mmt_render/mmt_help_syntax.typ` is helpful, but may lag behind implementation.

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
- **OpenSpec Entry**: Start with `openspec/project.md`, then the relevant file under `openspec/specs/` or active drafts under `openspec/changes/`.
- **Active DSL v2 Drafts**: For the next parser/emitter design, see `openspec/changes/redesign-dsl-syntax-v2/design.md`, `rust-parser-architecture.md`, and `specs/dsl-parser-architecture/spec.md`.
