# OpenSpec in MomoScript

This repository uses OpenSpec as a lightweight planning layer for non-trivial changes.

Start here:

1. Read `openspec/project.md` for repository context, constraints, and verification rules.
2. Read the relevant capability spec under `openspec/specs/`.
3. Create a change folder under `openspec/changes/<change-id>/` before implementing substantial behavior changes.

Recommended change contents:

- `proposal.md` for why and scope
- `design.md` when architecture or tradeoffs matter
- `tasks.md` for implementation and verification checklist
- `specs/<capability>/spec.md` for spec deltas

Repository-specific verification:

- Use `uv sync` to prepare the Python workspace.
- Use `uv run tools/dsl_refactor_check.py` for golden-file regression checks.
- Use `uv run tools/mmt_pipeline.py <script.mmt.txt>` for end-to-end render checks when pipeline behavior changes.
- Run `npm install && npm run build` in `web/` when changing the web editor.

OpenSpec is meant to stay incremental here. Do not try to spec the whole codebase up front; add or refine specs as features evolve.
