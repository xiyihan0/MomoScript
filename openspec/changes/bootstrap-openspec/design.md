## Overview

This bootstrap is intentionally hand-authored and minimal. The goal is to make OpenSpec useful immediately for this brownfield repository without trying to reverse-engineer every current behavior.

## Key Decisions

### Seed only the highest-value capabilities

We define a small capability set around DSL compilation, rendering, verification, and change management. These match the main boundaries already visible in the repository and are enough to anchor most future work.

The first three are seeded as baseline repository specs. The `change-management` capability is also captured as a formal delta under this bootstrap change so future changes have a clear process anchor.

### Preserve existing agent setup

We do not rely on `openspec init` or `openspec update` for this bootstrap because the repository already has local agent guidance files and in-progress local changes. Manual bootstrapping avoids clobbering those files while still adopting the OpenSpec folder model.

### Encode project-specific verification

OpenSpec is most useful here when it reflects the real validation habits of the project. The bootstrap therefore centers `uv`, `tools/dsl_refactor_check.py`, `tools/mmt_pipeline.py`, and `web/` build validation instead of generic test instructions.

## Tradeoffs

- The initial specs are intentionally broad and will need refinement as new features land.
- Slash-command support is not bootstrapped automatically; the repository can opt into official CLI integration later if desired.
