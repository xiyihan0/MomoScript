# MOMOSCRIPT (MMT) KNOWLEDGE BASE

**Generated:** 2026-01-12
**Platform:** Linux / Python 3.10+ / UV Workspace

## OVERVIEW
MomoScript (MMT) is a DSL for scripted visual storytelling (MoeTalk style), featuring a core parser/compiler, a Typst-based rendering engine, and a NoneBot integration.

## STRUCTURE
```
.
├── mmt_core/             # Core DSL parser, compiler, and resolver
├── mmt_rs/               # Rust DSL v2 core, CLI, pack resolver, and WASM analysis
├── mmt_nonebot_plugin/   # NoneBot adapter using the Rust v2 project pipeline
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
| **Rust v2 Parsing** | `mmt_rs/src/parser.rs` | Current syntax parser and recoverable AST |
| **Rust v2 Pipeline** | `mmt_rs/src/pipeline.rs` | Lowering, resolve, materialize, and Typst emission |
| **Legacy Python DSL** | `mmt_core/dsl_parser.py`, `mmt_core/dsl_compiler.py` | Historical v1 behavior only |
| **DSL v2 Syntax** | `openspec/changes/redesign-dsl-syntax-v2/` | Active Rust v2 spec delta and architecture |
| **Rust/WASM Core** | `mmt_rs/` | Main language core, native CLI, fixtures, and WASM analysis |
| **LSP/VS Code Research** | `openspec/changes/redesign-dsl-syntax-v2/tinymist-typst-lsp-integration-research.md` | Research only; not an approved implementation spec |
| **Rendering** | `typst_sandbox/mmt_render` | Typst rendering templates |
| **Rust Validation** | `mmt_rs/tests/` | Public API, pack, CLI, AVIFS, Typst, and source-map tests |
| **Legacy Validation** | `tools/dsl_refactor_check.py` | Python v1 golden regression only |
| **Assets** | `typst_sandbox/pack-v3/` | Local built packs; large binaries remain untracked |
| **Resource Pack v3** | `openspec/changes/design-resource-pack-v3/` | Manifest, AVIFS storage, Kivo builder, and materializer design |

## CONVENTIONS
- **Workspace**: Managed by `uv`. Root `pyproject.toml` defines workspace members.
- **Logging**: Uses `loguru` exclusively.
- **Testing**: Rust v2 uses Cargo tests under `mmt_rs/`; Python v1 uses golden regression; NoneBot mapping uses `unittest`.
- **Assets**: Large binaries ignored in git. Metadata (`manifest.json`, `tags.json`) tracked.
- **Typst**: Executed via sandbox (`mmt_core/typst_sandbox.py`) with memory/timeout limits.
- **OpenSpec**: Substantial DSL/rendering/workflow changes should be described under `openspec/changes/` and aligned to `openspec/specs/`.
- **Syntax Truth Source**: Treat `mmt_rs/` behavior tests and the active `redesign-dsl-syntax-v2` spec delta as the Rust v2 source of truth. Python parser/compiler and `openspec/specs/dsl-syntax/spec.md` are legacy v1 references until archival is complete.

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

# Run Rust v2 tests
cargo test --manifest-path mmt_rs/Cargo.toml --all-targets

# Export a Rust v2 Typst project
cargo run --manifest-path mmt_rs/Cargo.toml --bin mmt-compile -- --help

# Run Bot
uv run bot.py
```

## NOTES
- **EULA**: User-specific EULAs must be accepted for certain packs.
- **Performance**: Typst rendering capped at 2GB RAM / 30s timeout.
- **Legacy**: `MMT_DSL_ENGINE=legacy` is deprecated/unsupported.
- **OpenSpec Entry**: Start with `openspec/project.md`, then the relevant file under `openspec/specs/` or active drafts under `openspec/changes/`.
- **Active DSL v2 Drafts**: For the next parser/emitter design, see `openspec/changes/redesign-dsl-syntax-v2/design.md`, `rust-parser-architecture.md`, and `specs/dsl-parser-architecture/spec.md`.
