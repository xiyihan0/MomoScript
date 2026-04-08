# Project Context

## Summary

MomoScript is a DSL and rendering toolchain for scripted visual storytelling in a Momotalk or MoeTalk style. The repository combines a Python DSL parser and compiler, a Typst-based rendering pipeline, a NoneBot integration, and a web editor backed by wasm and browser-side Typst rendering.

## Primary Areas

- `mmt_core/`: DSL parsing, compilation, path resolution, sandbox integration
- `typst_sandbox/`: Typst templates, packs, rendering assets
- `mmt_nonebot_plugin/`: NoneBot plugin integration
- `tools/`: pipeline and golden-file validation scripts
- `web/`: Vite + React editor and wasm integration

## Constraints

- Python work is managed with `uv`; do not introduce ad-hoc environment instructions.
- Golden-file regression is the main verification path; standard `pytest` is not the project norm.
- Typst execution must stay sandboxed with memory and timeout limits.
- Asset access must remain sanitized; avoid arbitrary filesystem access from user-provided paths.
- New tooling should prefer `tools/` rather than adding more root-level scripts.
- The legacy flat layout is intentional; do not introduce a `src/` reorganization.

## Change Guidance

- Prefer specs for cross-cutting changes, DSL behavior changes, renderer behavior changes, or public workflow changes.
- Small typo fixes and isolated refactors can skip a full OpenSpec change if behavior is unchanged.
- When a change affects DSL semantics, rendering, or asset resolution, update both the relevant spec and the verification plan.

## Verification Defaults

- Workspace setup: `uv sync`
- Golden regression: `uv run tools/dsl_refactor_check.py`
- Pipeline spot check: `uv run tools/mmt_pipeline.py examples/example_t.mmt.txt`
- Bot entry sanity: `uv run bot.py`
- Web build sanity: `cd web && npm install && npm run build`

## Spec Map

- `openspec/specs/dsl-compilation/spec.md`: authoring, parsing, compilation expectations
- `openspec/specs/rendering-pipeline/spec.md`: Typst rendering and asset-safety expectations
- `openspec/specs/tooling-and-verification/spec.md`: repo workflows, validation, and change confidence
- `openspec/specs/change-management/spec.md`: when and how this repository uses OpenSpec

## Non-Goals

- This spec set is not a full generated reference for every current behavior.
- OpenSpec here does not replace code review or golden-file validation.
- OpenSpec should not force heavyweight planning for every small edit.
