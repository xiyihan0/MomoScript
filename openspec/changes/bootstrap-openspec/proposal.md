## Why

MomoScript already has multiple moving parts and validation conventions, but that context currently lives across README text, AGENTS guidance, and contributor memory. A lightweight OpenSpec baseline will make future AI-assisted changes easier to scope, review, and verify without forcing a heavyweight process.

## What Changes

- Add repository-level OpenSpec context in `openspec/project.md`
- Seed a small set of baseline capability specs for DSL compilation, rendering, and verification
- Formalize future OpenSpec usage through the `change-management` capability
- Document how future MomoScript changes should use OpenSpec artifacts
- Add a README pointer so contributors can discover the spec layer quickly

## Impact

- Formal spec delta: `change-management`
- Seeded baseline docs: `dsl-compilation`, `rendering-pipeline`, `tooling-and-verification`
- Affected code: none
- Affected docs: repository onboarding and planning workflow
