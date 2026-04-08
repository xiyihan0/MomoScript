# rendering-pipeline Specification

## Purpose

Define how compiled MomoScript content is rendered through Typst while preserving safety, reproducibility, and pack-driven behavior.

## Requirements

### Requirement: Sandboxed Typst execution

The system SHALL execute Typst rendering through the project sandbox with bounded resources.

#### Scenario: Rendering a normal document

- GIVEN a compiled document ready for Typst rendering
- WHEN the renderer invokes Typst
- THEN execution occurs through the sandboxed path
- AND the configured memory and timeout limits remain in effect

### Requirement: Sanitized asset resolution

The system SHALL prevent arbitrary asset path traversal during rendering and asset lookup.

#### Scenario: Resolving a referenced asset

- GIVEN a script or template references an asset by name
- WHEN the pipeline resolves that asset
- THEN the resolved path is constrained to allowed pack assets
- AND raw arbitrary filesystem paths are not trusted as-is

### Requirement: Pack-driven visual output

The system SHALL derive render behavior from tracked templates and pack metadata rather than hidden runtime state.

#### Scenario: Rendering with a selected pack

- GIVEN a render request that targets a specific pack
- WHEN the pipeline prepares Typst inputs
- THEN the selected pack metadata and tracked templates determine the output behavior
- AND the render does not depend on undocumented local-only configuration
