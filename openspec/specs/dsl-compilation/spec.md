# dsl-compilation Specification

## Purpose

Define how MomoScript source text becomes a stable compiled representation for rendering and downstream integrations.

## Requirements

### Requirement: Deterministic DSL compilation

The system SHALL compile the same valid MMT input into the same semantic result when run with the same project version and asset context.

#### Scenario: Stable compilation for a valid script

- GIVEN a valid `.mmt.txt` script
- AND the same pack metadata and compiler version
- WHEN the pipeline compiles the script more than once
- THEN the semantic compilation result remains consistent across runs

### Requirement: Useful failure reporting

The system SHALL reject invalid DSL input with diagnostics that help the author identify the failing construct or stage.

#### Scenario: Invalid statement is rejected

- GIVEN a script containing invalid DSL syntax or unsupported structure
- WHEN parsing or compilation runs
- THEN the command fails explicitly
- AND the failure indicates the problematic construct or processing stage

### Requirement: Backward-aware language evolution

The system SHALL treat DSL behavior changes as explicit compatibility decisions instead of silent incidental drift.

#### Scenario: Changing DSL semantics

- GIVEN a proposed change that modifies parsing or compilation behavior
- WHEN the change is planned and implemented
- THEN the affected OpenSpec capability is updated
- AND the golden-file workflow is used to verify the intended impact
