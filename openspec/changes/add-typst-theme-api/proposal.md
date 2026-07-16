# Proposal: Add a versioned Typst theme API

## Summary

MomoScript SHALL evolve the current single-preset Typst configuration into a versioned public theme contract. The contract will preserve built-in presets, allow users to derive a complete custom theme from a preset, and support controlled position-dependent visual patches without requiring ordinary users to depend on internal Typst dictionaries.

This change is Typst-API-first. It documents and tests the public façade before adding corresponding MMT syntax.

## Motivation

The current v2 façade already exports `mmt.themes.moetalk()` and `mmt.configure(theme: ..., chat: ...)`, but these names do not yet form a complete extension contract:

- only one built-in preset exists;
- header and footer visuals remain outside the theme dictionary;
- `reply` and `bond` retain hard-coded defaults instead of consuming their theme groups;
- chat avatar geometry and message spacing tokens are declared but still bypassed by hard-coded layout values;
- `configure(theme: ...)` replaces the whole theme, while `configure(chat: ...)` shallow-merges one behavior dictionary;
- no public patch, validation, schema-version, or reset behavior exists;
- external callers cannot know which values are static at template initialization and which are position-sensitive.

A preset-only DSL field would be too rigid, while exposing internal dictionaries as accidental API would make later implementation changes unsafe. A documented theme ABI provides the middle layer: stable semantic tokens and merge behavior, with raw Typst remaining available for advanced composition.

## Proposed capability

The Typst package will provide:

1. multiple complete built-in theme functions;
2. a versioned complete theme dictionary schema;
3. a public helper that derives a complete theme from a base theme plus validated partial groups;
4. position-dependent partial theme updates for dynamic groups;
5. an explicit way to restore the template's initial theme/configuration;
6. documentation that distinguishes public, advanced, and internal APIs;
7. observable verification that every documented token reaches its intended renderer.

The intended customization layers are:

```text
node parameters
> current position-dependent configuration
> user theme derived from a preset
> built-in preset
> library defaults
```

## Scope

- `typst_sandbox/mmt_render/lib.typ` public exports
- built-in theme modules and complete theme record shape
- `template`, `config`, `chat`, `narration`, `reply`, and `bond` consumption of theme values
- public patch/validation/reset semantics
- Typst 0.15 examples and behavior tests
- current API documentation and compatibility policy

## Non-goals

- `language` or locale support
- final MMT syntax for `@document theme`, `@theme`, or `@configure`
- remote theme downloads or arbitrary URLs
- direct filesystem paths in MMT source
- pack-v3 theme distribution in the first implementation
- a general template/plugin ABI that replaces chat or document structure
- automatic translation, font download, or resource lookup
- preserving undocumented imports from internal `.typ` files

## Compatibility

The current `mmt.themes.moetalk()` call remains valid and remains the default. Existing full-theme calls to `mmt.configure(theme: mmt.themes.moetalk())` remain meaningful when theme updates change from replacement to validated merge, because a complete theme contains every required group.

The façade remains experimental during this change. The first external theme schema will be named `mmt-theme.v1`; once published as supported, incompatible key or type changes require a new schema version rather than silent reinterpretation.

## Current implementation status

Documentation-only design work is complete when this change is introduced. The current renderer still has one preset, whole-theme replacement, hard-coded special-node values, and no reset helper. Proposed examples MUST remain labeled unavailable until their implementation and behavior tests land.
