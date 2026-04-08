# change-management Specification

## Purpose

Define how MomoScript uses OpenSpec to plan and review substantial behavior changes.

## Requirements

### Requirement: Substantial changes start from a change folder

The repository SHALL capture non-trivial behavior changes in `openspec/changes/<change-id>/` before or alongside implementation.

#### Scenario: Planning a DSL or rendering change

- GIVEN a proposed change that affects DSL semantics, rendering behavior, public workflows, or multiple modules
- WHEN work begins
- THEN a change folder is created with scope and verification notes

### Requirement: Changes identify affected capabilities

Each OpenSpec change SHALL point to the capability specs it modifies or relies on.

#### Scenario: Preparing a proposal

- GIVEN a new change proposal
- WHEN the proposal is written
- THEN it names the affected capability specs
- AND it explains the expected behavior impact in reviewable terms

### Requirement: Changes define verification up front

Each OpenSpec change SHALL include the verification path needed to justify confidence in the implementation.

#### Scenario: Preparing implementation tasks

- GIVEN a change with code impact
- WHEN `tasks.md` is created or updated
- THEN the tasks include the relevant regression, pipeline, or surface-specific checks
- AND reviewers can tell how the change should be validated
