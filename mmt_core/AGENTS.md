# MMT CORE KNOWLEDGE BASE (mmt_core)

**Focus:** DSL Parser, Semantic Compiler, and Asset Resolution.

## OVERVIEW
`mmt_core` handles the transformation of raw MMT text into a structured JSON IR consumed by the Typst renderer. It separates **Syntactic Parsing** (line-by-line AST generation) from **Semantic Compilation** (stateful resolution of speakers, aliases, and expressions).

## STRUCTURE
- `dsl_parser.py`: Low-level parser generating `Node` objects (AST) with precise `Span` tracking.
- `dsl_compiler.py`: Semantic evaluator that manages speaker state, aliases, and converts AST to JSON.
- `resolve_expressions.py`: AI-driven resolution for inline markers (e.g., `[happy]`) using embeddings.
- `pack_v2.py`: Asset bundle management (Character IDs, Avatars, Tags).
- `dsl_fixtures/`: Regression test suite (Input `.mmt.txt` + Expected `.golden.json`).

## WHERE TO LOOK
- **Parsing Logic**: `MMTLineParser` in `dsl_parser.py`. It uses regex and simple state for blocks (triple quotes, `@reply`).
- **Speaker Resolution**: `_emit_statement` in `dsl_compiler.py`. Handles backrefs (`_`), indices (`~1`), and explicit names.
- **Inline Expressions**: `parse_inline_segments` (compiler) and `resolve_expressions.py` (vector search).
- **ID Mapping**: `_resolve_char_id_from_selector`. Maps names to `ba.id` or `kivo-id`.

## CONVENTIONS
- **Nodes**: All AST nodes inherit from `Node` and include a `Span`.
- **Speaker IDs**: 
  - `ba.<id>`: Official assets from Pack-V2.
  - `kivo-<sid>`: Student ID from Kivotos wiki.
  - `custom-<hash>`: User-defined characters.
- **State Management**: The compiler maintains `SpeakerState` per side (`>` vs `<`) to track history for backrefs.
- **Goldens**: Verification is done by comparing `parse_to_json()` output against files in `dsl_fixtures/`.

## ANTI-PATTERNS
- **NO Nesting**: Directives like `@reply` or triple-quote blocks cannot be nested.
- **Indentation**: Statement kind markers (`-`, `>`, `<`) must be followed by at least one space.
- **Implicit Speakers**: Do not use `>` without a previous speaker defined unless it's the first statement (which will error).
- **Direct JSON Edit**: Never manually edit `.golden.json` files; use `tools/dsl_refactor_check.py --update`.
