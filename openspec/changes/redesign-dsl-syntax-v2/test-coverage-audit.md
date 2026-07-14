# DSL v2 Syntax Spec ↔ Rust Behavior Test Audit

审计日期：2026-07-14

## Scope And Method

审计对象是 `specs/dsl-syntax/spec.md` 的全部 80 个 `#### Scenario:`。证据只接受当前 Rust 行为测试中的可观察断言：`mmt_rs/src/**/*.rs` module tests、`mmt_rs/tests/syntax_api.rs` public API tests 和 `mmt_rs/tests/pack_v3_e2e.rs` integration tests。legacy Python tests 不作为 Rust v2 证据。

状态定义：

- **Covered**：现有测试直接防守 scenario 的主要可观察合同。
- **Partial**：现有测试只防守部分分支、上下文或失败模式。
- **Missing**：实现可能存在，但没有提交的直接行为测试。
- **Conflict**：已观察实现违反 normative clause。Conflict 另列优先级，不与 coverage status 重复计数。

汇总：**62 Covered / 9 Partial / 9 Missing**。另发现 **1 个 P0 normative conflict**：Typst overlay scanner 在 CST 分类前 mask candidate，导致 `\[:#1:]` 中位于 Typst Escape leaf 后的 `[:` 被选为 macro，违反 Escape-leaf scan boundary。精确 scenario 输入 `[\:` 的当前行为是零 macro；没有发现它与 spec 冲突。

## Per-Scenario Matrix

| # | Spec location and scenario | Status | Exact Rust test/assertion evidence or gap |
|---:|---|---|---|
| 1 | L7 Script actor configuration uses aggregated declarations | Covered | `semantic/actor.rs:732 lazy_actor_aliases_and_revisions_share_one_identity`; `parser.rs:1402 directive_block_preserves_generic_fields` |
| 2 | L14 Headless actor opens the preset default actor | Covered | `semantic/actor.rs:792 headless_actor_uses_preset_default_names` |
| 3 | L23 Headless actor requires a preset | Covered | `semantic/actor.rs:939 malformed_actor_shapes_report_semantic_errors` |
| 4 | L30 Named actor with preset creates an independent actor | Covered | `semantic/actor.rs:769 named_actors_from_one_preset_are_independent` |
| 5 | L38 Existing actor name opens its actor | Covered | `semantic/actor.rs:732 lazy_actor_aliases_and_revisions_share_one_identity`; public path: `tests/syntax_api.rs:60 public_actor_lowering_api_captures_statement_revisions` |
| 6 | L46 Existing actor rejects implicit preset replacement | Covered | `semantic/actor.rs:911 invalid_actor_declarations_do_not_rebind_or_merge_names` |
| 7 | L53 Missing named actor does not infer a local preset | Covered | `semantic/actor.rs:939 malformed_actor_shapes_report_semantic_errors` |
| 8 | L60 Additional actor names are explicit and additive | Covered | `semantic/actor.rs:732 lazy_actor_aliases_and_revisions_share_one_identity` |
| 9 | L68 Multiple positional actor names are rejected | Covered | `semantic/actor.rs:939 malformed_actor_shapes_report_semantic_errors` |
| 10 | L75 Actor name conflict is rejected by default | Covered | `semantic/actor.rs:911 invalid_actor_declarations_do_not_rebind_or_merge_names` |
| 11 | L82 Asset registration supports canonical block and shared short form | Covered | `semantic/asset.rs:380 block_assets_default_to_custom_namespace`; `semantic/asset.rs:400 short_asset_forms_share_the_block_semantics`; invalid forms: `:421` |
| 12 | L92 Inline reply uses pipe-separated items | Covered | `parser.rs:1318 parses_reply_line_into_split_items`; quoting/escaping: `parser.rs:1545 reply_line_preserves_quoted_and_escaped_pipes` |
| 13 | L99 Reply block uses explicit item markers | Covered | `parser.rs:1558 reply_block_uses_explicit_items_and_continuations` |
| 14 | L108 Reply item fenced body belongs to the current item | Covered | `parser.rs:1558 reply_block_uses_explicit_items_and_continuations` asserts fenced second item and continuation ownership |
| 15 | L115 Bond block remains ordinary content | Covered | `parser.rs:1571 bond_line_and_block_parse_as_bond_nodes` |
| 16 | L122 Bond colon form is single-line or fenced | Partial | `parser.rs:1571 bond_line_and_block_parse_as_bond_nodes` covers single-line and non-colon block; no direct fenced `@bond:` payload test |
| 17 | L134 Statement-local patch applies only to the current node | Partial | `parser.rs:1227 parses_statement_with_explicit_marker_and_patch` 与 `emit.rs:756 emits_typ_directives_and_checked_node_patches` 只覆盖一个 patched statement；没有后续节点断言 patch 不继承 |
| 18 | L141 Patch remains single-line in the first revision | Missing | `parser.rs:1456 unclosed_statement_patch_reports_syntax_error` 只覆盖同一行未闭合 patch；没有测试证明 multiline patch 被拒绝且下一行不被消费为 patch |
| 19 | L148 Syntax parser only checks patch enclosure | Covered | `parser.rs:1456 unclosed_statement_patch_reports_syntax_error` |
| 20 | L156 Typst argument validation happens after syntax parsing | Covered | `emit.rs:777 invalid_patch_reports_typst_diagnostic_with_original_range`; public API: `tests/syntax_api.rs:85 public_typst_argument_check_maps_errors_to_mmt_ranges` |
| 21 | L163 Statement lines accept implicit continuations | Covered | `parser.rs:1385 statement_continuation_stops_only_at_unindented_node_starts` |
| 22 | L170 Statement continuation stops at explicit node starts | Covered | `parser.rs:1385 statement_continuation_stops_only_at_unindented_node_starts` |
| 23 | L177 Indented node-like lines remain continuation text | Covered | `parser.rs:1385 statement_continuation_stops_only_at_unindented_node_starts` |
| 24 | L184 Fenced statement body protects line-head markers | Covered | `parser.rs:1469 statement_fenced_body_protects_line_head_markers` |
| 25 | L191 Longer fences can contain shorter quote runs | Covered | `parser.rs:1534 longer_fences_can_contain_shorter_quote_runs` |
| 26 | L198 Colon directives are single-line or fenced payloads | Partial | `parser.rs:1329 generic_colon_directive_line_still_preserves_payload` covers single-line; no generic fenced-colon directive test |
| 27 | L206 Non-colon directives are explicit blocks | Covered | `parser.rs:1402 directive_block_preserves_generic_fields`; missing-end recovery: `parser.rs:1420 unterminated_directive_block_reports_diagnostic_but_keeps_node`; public range: `tests/syntax_api.rs:33` |
| 28 | L213 Top-level control tokens are unindented | Partial | `parser.rs:1385` covers an indented `>` as continuation; no direct indented `@end`/directive control-token test |
| 29 | L224 Backreference marker references side-local MRU distinct speakers | Covered | `semantic/actor.rs:813 distinct_backrefs_and_unique_indexes_are_side_local`; `:883 backref_two_uses_distinct_speaker_mru_order` |
| 30 | L235 Repeated shorthand alternates two speakers | Covered | `semantic/actor.rs:853 backref_one_alternates_between_recent_distinct_speakers` |
| 31 | L242 Unique-index marker references side-local first-seen order | Covered | `semantic/actor.rs:813 distinct_backrefs_and_unique_indexes_are_side_local` |
| 32 | L250 Speaker references point to script actor identities | Covered | `semantic/actor.rs:732 lazy_actor_aliases_and_revisions_share_one_identity`; public API: `tests/syntax_api.rs:60` |
| 33 | L258 Invalid speaker references fail deterministically | Covered | `semantic/actor.rs:813 distinct_backrefs_and_unique_indexes_are_side_local` asserts invalid right-side `~2` diagnostic |
| 34 | L265 Omitted speaker preserves side-local current state and Sensei default | Covered | `semantic/actor.rs:978 omitted_speakers_reuse_current_actor_or_default_right_side_to_sensei`; configurable fallbacks: `:1009` |
| 35 | L282 Sticker marker uses argument-list syntax | Covered | `parser.rs:1371 parses_inline_macro_parts_in_body`; `semantic/resource.rs:579 normalizes_current_and_explicit_subject_stickers` |
| 36 | L289 Subject and sticker selector can be provided positionally | Covered | `semantic/resource.rs:579 normalizes_current_and_explicit_subject_stickers` |
| 37 | L296 Contribution namespace can disambiguate sticker variants | Covered | `pack.rs:942 sticker_resolution_requires_contribution_disambiguation`; public integration: `tests/pack_v3_e2e.rs:48` |
| 38 | L303 Namespaced selector may quote the right-hand literal | Covered | `inline.rs:526 parses_ordinal_and_namespaced_quoted_args`; `:548 quoted_commas_and_closing_tokens_do_not_split_args`; lowering: `semantic/resource.rs:579` |
| 39 | L311 Natural language query syntax is deferred | Covered | `semantic/resource.rs:675 rejects_implicit_subjects_queries_calls_and_bad_ordinals` |
| 40 | L318 Ordinal selector references manifest order | Covered | `pack.rs:961 ordinal_and_set_defaults_resolve_stably`; pipeline integration: `tests/pack_v3_e2e.rs:48` |
| 41 | L327 Syntax parser tokenizes inline marker arguments | Covered | `inline.rs:526`, `:548`, `:564`, `:574`; parser AST: `parser.rs:1371`; public AST: `tests/syntax_api.rs:11` |
| 42 | L336 Ordinal selector fails deterministically | Partial | `semantic/resource.rs:675` covers `#0`; `tests/pack_v3_e2e.rs:79` covers cross-pack ambiguity; no direct out-of-range or missing-default-set test |
| 43 | L343 Explicit resource spaces bypass subject interpretation | Covered | `semantic/resource.rs:630 normalizes_full_paths_and_explicit_resource_spaces` covers `asset`, `tmp`, `file`, `url` and URL shorthand |
| 44 | L350 Bare subject selector requires message speaker | Covered | `semantic/resource.rs:579 normalizes_current_and_explicit_subject_stickers` |
| 45 | L357 Bare subject selector is invalid outside message speaker context | Partial | `semantic/resource.rs:675` covers narration; no direct reply-item or bond-content case |
| 46 | L364 Resource render options use marker suffix patch | Covered | `emit.rs:924 resolved_resource_marker_materializes_into_sticker_call_with_patch_origin`; validation: `semantic/resource.rs:710` |
| 47 | L372 Resource selector cannot embed Typst call syntax | Covered | `semantic/resource.rs:675 rejects_implicit_subjects_queries_calls_and_bad_ordinals` |
| 48 | L379 Deterministic references do not fall back to natural language | Covered | query rejection at `semantic/resource.rs:675`; deterministic missing-resource resolve diagnostic at `resolve.rs:409 missing_resources_report_resolve_phase_at_marker` |
| 49 | L386 Quoted deterministic selectors stay deterministic | Covered | tokenization: `inline.rs:548` and `:564`; lowering preserves exact quoted literal at `semantic/resource.rs:579` |
| 50 | L393 Legacy inline target forms are not the preferred next syntax | Missing | No direct Rust test proves `[expr]`, `[expr](target)` and `(target)[expr]` remain outside v2 macro semantics |
| 51 | L406 Global Typst code uses `@typ` | Covered | line form: `parser.rs:1329`; block form: `parser.rs:1346`; emission: `emit.rs:756` |
| 52 | L417 Body mode has syntax and macro dimensions | Covered | `parser.rs:1483 body_modes_distinguish_inherited_and_explicit_fences`; `semantic.rs:149 mode_directives_apply_forward_and_explicit_fences_override_locally` |
| 53 | L426 Mode directive affects following body nodes | Covered | `semantic.rs:149 mode_directives_apply_forward_and_explicit_fences_override_locally` |
| 54 | L434 Mode directive accepts short and long names | Covered | `semantic.rs:182 accepts_all_documented_mode_names` |
| 55 | L441 Mode directive is file-local and body-only | Covered | directive isolation: `semantic.rs:221 mode_does_not_create_entries_for_directive_content`; public document-local API: `tests/syntax_api.rs:50` |
| 56 | L448 Fenced body can override mode locally | Covered | `semantic.rs:149`; parser mode shape: `parser.rs:1483` |
| 57 | L455 Inline resource marker is an MMT macro, not Typst syntax | Covered | lowering: `semantic/resource.rs:579`; materialized Typst emission: `emit.rs:924` |
| 58 | L462 Macro-enabled body can escape marker opener | Missing | No committed direct test. A 2026-07-14 focused probe of `scan_typst_overlay_macros(r"[\:")` returned zero macros and zero diagnostics, so the exact scenario currently behaves as specified |
| 59 | L470 Raw macro modes preserve marker text | Covered | resource lowering: `semantic/resource.rs:692 raw_modes_ignore_markers_and_typst_mode_uses_overlay_context`; all raw mode names: `semantic.rs:182` |
| 60 | L477 Typst mode uses typst-syntax as an overlay boundary | Partial / P0 conflict | `typst_check.rs:251 typst_overlay_only_selects_markup_and_nested_content_regions`; `emit.rs:884 typst_macro_mode_only_expands_ast_markup_regions`. Gap/conflict: a focused probe of `scan_typst_overlay_macros(r"\[:#1:]")` returned one macro because candidates are masked before CST classification, violating the normative Escape-leaf boundary |
| 61 | L493 Patch content must be valid call arguments | Covered | `typst_check.rs:199 valid_typst_markup_and_args_pass_syntax_checks`; `:222 argument_errors_project_out_of_the_synthetic_wrapper`; public API: `tests/syntax_api.rs:85` |
| 62 | L500 Statement patch targets statement rendering parameters | Covered | `emit.rs:756 emits_typ_directives_and_checked_node_patches` |
| 63 | L507 Statement patch cannot select stickers | Missing | No dedicated committed test. A focused probe of `check_typst_args("sticker: #3", …)` returned Typst errors (`#` invalid in code and expected comma), so the exact form is currently rejected |
| 64 | L518 Value references separate structure from namespace | Covered | inline namespace shape: `inline.rs:526` and `:574`; actor/asset value paths: `semantic/actor.rs:732`, `semantic/asset.rs:400` |
| 65 | L529 Avatar resource paths identify entity, contribution source, slot, and variant | Partial | `resolve.rs:423 resolves_default_shorthand_and_full_path_avatars` covers entity/slot/variant; no direct contribution-qualified or script-actor-name full-path case |
| 66 | L538 Sticker resource paths identify entity, contribution source, set, and variant | Covered | `semantic/resource.rs:630`; public integration: `tests/pack_v3_e2e.rs:48` |
| 67 | L548 Sticker path may omit set only when default set is explicit | Partial | positive default resolution at `pack.rs:961`; no direct missing-default-set ambiguous failure |
| 68 | L555 Slot omission is limited to contexts with a default slot | Missing | Existing positive shorthand tests do not directly prove ordinary resource paths, patch args and Typst fragments never infer a slot |
| 69 | L564 Avatar and sticker slots are distinct | Missing | No direct negative cross-slot test; avatar and sticker happy paths are tested separately only |
| 70 | L575 Avatar patch keeps Typst argument semantics | Missing | No direct test proves `avatar: happy` remains a Typst argument and is not rewritten as a DSL avatar selector |
| 71 | L582 Resource selector logic stays in sticker markers | Covered | marker lowering at `semantic/resource.rs:579` and materialized marker emission at `emit.rs:924`; statement patches are emitted as Typst args at `emit.rs:756` |
| 72 | L589 Patch resource references must be explicit | Missing | No direct test proves bare `contribution_namespace::variant` inside a patch receives no DSL selector semantics |
| 73 | L600 Stable custom assets use `asset::` | Covered | lowering: `semantic/resource.rs:630`; script asset resolution: `resolve.rs:392 script_asset_shadows_same_named_pack_asset_explicitly` |
| 74 | L606 Runtime temporary assets use `tmp::` | Covered | `semantic/resource.rs:630 normalizes_full_paths_and_explicit_resource_spaces` |
| 75 | L617 Extension pack patches an existing entity | Covered | `pack.rs:942 sticker_resolution_requires_contribution_disambiguation`; public fixture integration: `tests/pack_v3_e2e.rs:48` |
| 76 | L624 Duplicate variants require explicit disambiguation | Covered | `pack.rs:942`; unscoped public failure: `tests/pack_v3_e2e.rs:79` |
| 77 | L631 Extension packs do not silently change defaults | Missing | No direct test asserts a full base+extension registry retains the base default when the extension contributes another default-style resource |
| 78 | L642 Quoted values preserve special characters | Covered | `inline.rs:620 declaration_scalar_unquotes_special_characters`; list literals at `:601` |
| 79 | L649 Field lists use explicit brackets | Covered | `inline.rs:601 declaration_lists_preserve_quotes_escapes_and_ranges` |
| 80 | L657 Bare comma-separated fields are ambiguous | Covered | semantic rejection: `semantic/actor.rs:939 malformed_actor_shapes_report_semantic_errors`; malformed declaration coverage: `inline.rs:634` |

## Priority Closure

### P0 — contract violation

1. Fix `scan_typst_overlay_macros` so candidate discovery respects Typst CST replaceable ranges and Escape leaves before masking. Regression inputs must include `[\:`, `\[:#1:]`, strings, raw blocks, comments, code expressions and nested markup.

### P1 — missing or partial behavioral evidence

1. Parser boundaries: scenarios 16、17、18、26 and 28.
2. Selector failures and contexts: scenarios 42, 45 and 50.
3. Direct mode/patch regressions: scenarios 58 and 63.
4. Resource path/default/slot semantics: scenarios 65, 67, 68, 69, 70 and 72.
5. Pack default precedence: scenario 77.
6. Promote representative actor conflict, resource default/path, raw mode and contribution ambiguity contracts into public API/integration tests; `mmt_rs/tests/syntax_api.rs` currently provides strong external evidence for parser AST, document ranges, mode resolution, actor revisions and Typst argument diagnostics, but not the full semantic surface.

### P2 — documentation lifecycle

After P0/P1 closure, archive the stable v2 delta. Keep legacy Python v1 specs explicitly versioned and out of Rust v2 acceptance signals.
