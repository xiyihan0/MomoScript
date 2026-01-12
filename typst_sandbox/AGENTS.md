# MMT TYPST SANDBOX KNOWLEDGE BASE

**Generated:** 2026-01-12
**Platform:** Typst / Linux Sandbox

## OVERVIEW
The `typst_sandbox` is MomoScript's visual backend, responsible for rendering MMT-DSL (in JSON format) into high-quality PDFs and images. It provides a structured environment for Typst templates and asset management.

## STRUCTURE
- `mmt_render/`: Core Typst templates and layout logic.
  - `mmt.typ`: Main library defining components (bubbles, avatars, narrations).
  - `mmt_render.typ`: Entry point for the standard rendering pipeline.
- `pack-v2/`: Structured asset bundles (e.g., `ba` for Blue Archive).
  - `manifest.json`: Bundle metadata (version, author, EULA).
  - `char_id.json`: Character ID to display name mapping.
  - `asset_mapping.json`: Logical asset name to file path mapping.
  - `avatar/` & `images/`: Binary assets (character portraits, expressions).

## WHERE TO LOOK
- **Layout & Components**: `mmt_render/mmt.typ` (defines `single_chat`, `bubble`, `narration`).
- **Rendering Logic**: `mmt_render/mmt_render.typ` (handles JSON parsing and loop rendering).
- **Student Metadata**: `pack-v2/ba/char_id.json` and `asset_mapping.json`.
- **Styling**: Look for `#set text(...)`, `#set page(...)`, and color constants in `mmt.typ`.

## CONVENTIONS
- **Dynamic Content**: Use `sys.inputs.at("chat")` to pass JSON data into Typst.
- **Typst Mode**: Content is rendered via `eval(..., mode: "markup")` when Typst mode is enabled in the pipeline.
- **Asset Resolution**: Assets must be resolved to local paths (or base64) before being passed to Typst; Typst itself should not perform network requests.
- **Coordinates**: Most layouts use `pt` or `em` for relative sizing.

## ANTI-PATTERNS
- **NO Arbitrary File Access**: Templates should only access files within the sandbox root or via explicitly passed paths.
- **NO Network Access**: All external assets must be cached locally by the Python resolver (`resolve_expressions.py`) first.
- **NO Heavy Logic in Typst**: Prefer processing data in Python (compiler/resolver) and passing clean JSON to Typst.
- **Avoid Hardcoding Paths**: Use `manifest.json` and `asset_mapping.json` to decouple IDs from filenames.
