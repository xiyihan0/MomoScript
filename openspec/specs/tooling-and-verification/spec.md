# tooling-and-verification Specification

## Purpose

Define the repository workflows that establish confidence for DSL, rendering, integration, and editor changes.

## Requirements

### Requirement: Golden-file regression as the default safety net

The system SHALL use the repository golden-file workflow as the primary regression signal for parser, compiler, and renderer changes.

#### Scenario: Changing pipeline behavior

- GIVEN a change that affects parsing, compilation, or rendering behavior
- WHEN the author prepares the change for review
- THEN `tools/dsl_refactor_check.py` is part of verification
- AND any intentional output shifts are reviewed explicitly

### Requirement: End-to-end pipeline verification

The system SHALL provide a command-line path to validate text-to-render behavior in one flow.

#### Scenario: Verifying a script end to end

- GIVEN a repository script example or a focused reproduction case
- WHEN `tools/mmt_pipeline.py` is executed
- THEN the workflow exercises parse, compile, resolve, and render stages together

### Requirement: Surface-specific validation

The system SHALL verify changes using the surface they affect instead of relying on unrelated checks alone.

#### Scenario: Updating the web editor

- GIVEN a change under `web/`
- WHEN verification is prepared
- THEN a web build or equivalent editor-specific validation is included
- AND Python-only validation is not treated as sufficient by itself

#### Scenario: Updating NoneBot integration

- GIVEN a change under `mmt_nonebot_plugin/` or bot entry flows
- WHEN verification is prepared
- THEN the bot or plugin surface is sanity-checked in addition to core pipeline checks when relevant
