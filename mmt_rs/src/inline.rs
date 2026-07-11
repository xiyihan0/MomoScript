use crate::source::TextRange;
use crate::syntax::PatchSyntax;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineMacroSyntax {
    pub args: Vec<MacroArgSyntax>,
    pub render_patch: Option<PatchSyntax>,
    pub range: TextRange,
    pub args_range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacroArgSyntax {
    pub value: MacroValueSyntax,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MacroValueSyntax {
    Bare(String),
    Quoted {
        value: String,
        quote: QuoteKind,
    },
    Namespaced {
        namespace: String,
        value: Box<MacroValueSyntax>,
    },
    Ordinal {
        n: u32,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteKind {
    Single,
    Double,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineMacroParse {
    pub syntax: InlineMacroSyntax,
    pub diagnostics: Vec<InlineMacroDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineMacroDiagnostic {
    pub message: String,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InlineMacroParseError {
    MissingClose { range: TextRange },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclarationValueParse {
    pub value: Option<DeclarationValueSyntax>,
    pub diagnostics: Vec<InlineMacroDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeclarationValueSyntax {
    Scalar(DeclarationLiteralSyntax),
    List {
        items: Vec<DeclarationLiteralSyntax>,
        range: TextRange,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclarationLiteralSyntax {
    pub value: String,
    pub quote: Option<QuoteKind>,
    pub range: TextRange,
}

pub fn parse_declaration_value(text: &str, absolute_start: usize) -> DeclarationValueParse {
    let leading = text.len() - text.trim_start().len();
    let trailing = text.len() - text.trim_end().len();
    let trimmed = text.trim();
    let range = TextRange::new(
        absolute_start + leading,
        absolute_start + text.len() - trailing,
    );
    if trimmed.is_empty() {
        return DeclarationValueParse {
            value: None,
            diagnostics: vec![InlineMacroDiagnostic {
                message: "missing declaration value".to_string(),
                range,
            }],
        };
    }

    if trimmed.starts_with('[') {
        return parse_declaration_list(trimmed, range);
    }

    let (literal, diagnostic) = parse_declaration_literal(trimmed, range);
    DeclarationValueParse {
        value: literal.map(DeclarationValueSyntax::Scalar),
        diagnostics: diagnostic.into_iter().collect(),
    }
}

fn parse_declaration_list(text: &str, range: TextRange) -> DeclarationValueParse {
    let Some(close) = find_declaration_list_close(text) else {
        return DeclarationValueParse {
            value: None,
            diagnostics: vec![InlineMacroDiagnostic {
                message: "unclosed declaration list".to_string(),
                range,
            }],
        };
    };

    if !text[close + 1..].trim().is_empty() {
        return DeclarationValueParse {
            value: None,
            diagnostics: vec![InlineMacroDiagnostic {
                message: "unexpected content after declaration list".to_string(),
                range: TextRange::new(range.start + close + 1, range.end),
            }],
        };
    }

    let inner = &text[1..close];
    let mut items = Vec::new();
    let mut diagnostics = Vec::new();
    for (start, end) in split_top_level_commas(inner) {
        let raw = &inner[start..end];
        let leading = raw.len() - raw.trim_start().len();
        let trailing = raw.len() - raw.trim_end().len();
        let item = raw.trim();
        let item_range = TextRange::new(
            range.start + 1 + start + leading,
            range.start + 1 + end - trailing,
        );
        if item.is_empty() {
            diagnostics.push(InlineMacroDiagnostic {
                message: "empty declaration list item".to_string(),
                range: item_range,
            });
            continue;
        }
        let (literal, diagnostic) = parse_declaration_literal(item, item_range);
        if let Some(literal) = literal {
            items.push(literal);
        }
        diagnostics.extend(diagnostic);
    }

    DeclarationValueParse {
        value: Some(DeclarationValueSyntax::List { items, range }),
        diagnostics,
    }
}

fn find_declaration_list_close(text: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    for (offset, ch) in text.char_indices().skip(1) {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
        } else if ch == ']' {
            return Some(offset);
        }
    }
    None
}

fn parse_declaration_literal(
    raw: &str,
    range: TextRange,
) -> (
    Option<DeclarationLiteralSyntax>,
    Option<InlineMacroDiagnostic>,
) {
    let quote = match raw.chars().next() {
        Some('"') => Some(('"', QuoteKind::Double)),
        Some('\'') => Some(('\'', QuoteKind::Single)),
        _ => None,
    };

    if let Some((delimiter, quote_kind)) = quote {
        let Some(value) = unquote(raw, delimiter) else {
            return (
                None,
                Some(InlineMacroDiagnostic {
                    message: "malformed quoted declaration value".to_string(),
                    range,
                }),
            );
        };
        return (
            Some(DeclarationLiteralSyntax {
                value,
                quote: Some(quote_kind),
                range,
            }),
            None,
        );
    }

    (
        Some(DeclarationLiteralSyntax {
            value: unescape_declaration_bare(raw),
            quote: None,
            range,
        }),
        None,
    )
}

fn unescape_declaration_bare(raw: &str) -> String {
    let mut value = String::new();
    let mut escaped = false;
    for ch in raw.chars() {
        if escaped {
            value.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else {
            value.push(ch);
        }
    }
    if escaped {
        value.push('\\');
    }
    value
}

pub fn parse_inline_macro_at(text: &str, absolute_start: usize) -> Option<InlineMacroSyntax> {
    parse_inline_macro_at_checked(text, absolute_start)
        .ok()
        .map(|parsed| parsed.syntax)
}

pub fn parse_inline_macro_at_checked(
    text: &str,
    absolute_start: usize,
) -> Result<InlineMacroParse, InlineMacroParseError> {
    if !text.starts_with("[:") {
        return Err(InlineMacroParseError::MissingClose {
            range: TextRange::empty(absolute_start),
        });
    }

    let close = find_macro_close(text).ok_or(InlineMacroParseError::MissingClose {
        range: TextRange::new(absolute_start, absolute_start + text.len()),
    })?;
    let args_text = &text[2..close];
    let args_range = TextRange::new(absolute_start + 2, absolute_start + close);
    let mut range_end = absolute_start + close + 2;
    let mut render_patch = None;
    let mut diagnostics = Vec::new();

    let suffix = &text[close + 2..];
    if suffix.starts_with('(') {
        if let Some((patch, consumed)) = parse_patch_suffix(suffix, absolute_start + close + 2) {
            range_end += consumed;
            render_patch = Some(patch);
        } else {
            diagnostics.push(InlineMacroDiagnostic {
                message: "unclosed inline macro render patch".to_string(),
                range: TextRange::new(absolute_start + close + 2, absolute_start + text.len()),
            });
        }
    }

    Ok(InlineMacroParse {
        syntax: InlineMacroSyntax {
            args: parse_macro_args(args_text, args_range.start),
            render_patch,
            range: TextRange::new(absolute_start, range_end),
            args_range,
        },
        diagnostics,
    })
}

pub fn parse_macro_args(args_text: &str, absolute_start: usize) -> Vec<MacroArgSyntax> {
    split_top_level_commas(args_text)
        .into_iter()
        .filter_map(|(start, end)| {
            let raw = &args_text[start..end];
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return None;
            }
            let leading_ws = raw.len() - raw.trim_start().len();
            let trailing_ws = raw.len() - raw.trim_end().len();
            let range = TextRange::new(
                absolute_start + start + leading_ws,
                absolute_start + end - trailing_ws,
            );
            Some(MacroArgSyntax {
                value: parse_macro_value(trimmed),
                range,
            })
        })
        .collect()
}

fn parse_macro_value(raw: &str) -> MacroValueSyntax {
    if let Some(rest) = raw.strip_prefix('#') {
        if let Ok(n) = rest.parse::<u32>() {
            return MacroValueSyntax::Ordinal { n };
        }
    }

    if let Some(value) = unquote(raw, '"') {
        return MacroValueSyntax::Quoted {
            value,
            quote: QuoteKind::Double,
        };
    }
    if let Some(value) = unquote(raw, '\'') {
        return MacroValueSyntax::Quoted {
            value,
            quote: QuoteKind::Single,
        };
    }

    if let Some((namespace, value)) = split_leading_namespace(raw) {
        if !namespace.is_empty() && !value.is_empty() {
            return MacroValueSyntax::Namespaced {
                namespace: namespace.to_string(),
                value: Box::new(parse_namespaced_value(value)),
            };
        }
    }

    MacroValueSyntax::Bare(raw.to_string())
}

fn split_leading_namespace(raw: &str) -> Option<(&str, &str)> {
    let namespace_offset = raw.find("::")?;
    if raw.find('/').is_some_and(|slash| slash < namespace_offset) {
        return None;
    }
    Some((&raw[..namespace_offset], &raw[namespace_offset + 2..]))
}

fn parse_namespaced_value(raw: &str) -> MacroValueSyntax {
    if let Some(rest) = raw.strip_prefix('#')
        && let Ok(n) = rest.parse::<u32>()
    {
        return MacroValueSyntax::Ordinal { n };
    }
    if let Some(value) = unquote(raw, '"') {
        return MacroValueSyntax::Quoted {
            value,
            quote: QuoteKind::Double,
        };
    }
    if let Some(value) = unquote(raw, '\'') {
        return MacroValueSyntax::Quoted {
            value,
            quote: QuoteKind::Single,
        };
    }
    MacroValueSyntax::Bare(raw.to_string())
}

fn unquote(raw: &str, quote: char) -> Option<String> {
    if !raw.starts_with(quote) || !raw.ends_with(quote) || raw.len() < 2 {
        return None;
    }

    let mut value = String::new();
    let mut escaped = false;
    for ch in raw[quote.len_utf8()..raw.len() - quote.len_utf8()].chars() {
        if escaped {
            value.push(ch);
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else {
            value.push(ch);
        }
    }
    if escaped {
        value.push('\\');
    }
    Some(value)
}

fn find_macro_close(text: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    let mut iter = text.char_indices().skip(2);
    while let Some((offset, ch)) = iter.next() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch == ':' && matches!(iter.clone().next(), Some((_, ']'))) {
            return Some(offset);
        }
    }
    None
}

fn split_top_level_commas(text: &str) -> Vec<(usize, usize)> {
    let mut result = Vec::new();
    let mut start = 0;
    let mut quote = None;
    let mut escaped = false;
    for (offset, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch == ',' {
            result.push((start, offset));
            start = offset + ch.len_utf8();
        }
    }
    result.push((start, text.len()));
    result
}

fn parse_patch_suffix(text: &str, absolute_start: usize) -> Option<(PatchSyntax, usize)> {
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;
    for (offset, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        match ch {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    let consumed = offset + ch.len_utf8();
                    let args_range = TextRange::new(absolute_start + 1, absolute_start + offset);
                    return Some((
                        PatchSyntax {
                            raw_args: text[1..offset].to_string(),
                            range: TextRange::new(absolute_start, absolute_start + consumed),
                            args_range,
                        },
                        consumed,
                    ));
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ordinal_and_namespaced_quoted_args() {
        let parsed = parse_inline_macro_at(
            r#"[:ba::晴_露营, ba_extpack::">_<笑", #1:](width: 2em)"#,
            10,
        )
        .expect("macro should parse");

        assert_eq!(parsed.args.len(), 3);
        assert!(matches!(
            parsed.args[2].value,
            MacroValueSyntax::Ordinal { n: 1 }
        ));
        assert_eq!(
            parsed
                .render_patch
                .as_ref()
                .map(|patch| patch.raw_args.as_str()),
            Some("width: 2em")
        );
    }

    #[test]
    fn quoted_commas_and_closing_tokens_do_not_split_args() {
        let parsed = parse_inline_macro_at(r#"[:ba::"晴,露营", "不是:]结束", #12:]"#, 0)
            .expect("macro should parse");

        assert_eq!(parsed.args.len(), 3);
        assert!(matches!(
            parsed.args[0].value,
            MacroValueSyntax::Namespaced { ref namespace, .. } if namespace == "ba"
        ));
        assert!(matches!(
            parsed.args[2].value,
            MacroValueSyntax::Ordinal { n: 12 }
        ));
    }

    #[test]
    fn fully_quoted_namespace_like_text_stays_quoted() {
        let parsed = parse_inline_macro_at(r#"[:"ba::晴":]"#, 0).expect("macro should parse");

        assert!(matches!(
            parsed.args[0].value,
            MacroValueSyntax::Quoted { ref value, .. } if value == "ba::晴"
        ));
    }

    #[test]
    fn full_resource_path_only_structures_the_leading_namespace() {
        let parsed = parse_inline_macro_at("[:ba::晴_露营/ba_extpack::sticker/default/#1:]", 0)
            .expect("macro should parse");

        assert!(matches!(
            &parsed.args[0].value,
            MacroValueSyntax::Namespaced { namespace, value }
                if namespace == "ba"
                    && matches!(value.as_ref(), MacroValueSyntax::Bare(path)
                        if path == "晴_露营/ba_extpack::sticker/default/#1")
        ));
    }

    #[test]
    fn checked_parser_reports_unclosed_render_patch() {
        let parsed =
            parse_inline_macro_at_checked("[:#1:](width: 2em", 5).expect("macro should parse");

        assert_eq!(parsed.syntax.render_patch, None);
        assert_eq!(parsed.diagnostics.len(), 1);
        assert_eq!(
            parsed.diagnostics[0].message,
            "unclosed inline macro render patch"
        );
    }

    #[test]
    fn declaration_lists_preserve_quotes_escapes_and_ranges() {
        let parsed =
            parse_declaration_value(r#" [hifumi, "日富美, 小鸟游", name\,with\,comma] "#, 10);
        assert!(parsed.diagnostics.is_empty());

        let Some(DeclarationValueSyntax::List { items, .. }) = parsed.value else {
            panic!("expected declaration list");
        };
        assert_eq!(
            items
                .iter()
                .map(|item| item.value.as_str())
                .collect::<Vec<_>>(),
            vec!["hifumi", "日富美, 小鸟游", "name,with,comma"]
        );
        assert_eq!(items[0].range, TextRange::new(12, 18));
    }

    #[test]
    fn declaration_scalar_unquotes_special_characters() {
        let parsed = parse_declaration_value(r#""游戏开发部的\"柚子\"""#, 4);
        assert!(parsed.diagnostics.is_empty());
        assert!(matches!(
            parsed.value,
            Some(DeclarationValueSyntax::Scalar(DeclarationLiteralSyntax {
                ref value,
                quote: Some(QuoteKind::Double),
                ..
            })) if value == "游戏开发部的\"柚子\""
        ));
    }

    #[test]
    fn malformed_declaration_values_report_diagnostics() {
        for value in ["[a, b", "[a] trailing", "\"unclosed"] {
            let parsed = parse_declaration_value(value, 0);
            assert_eq!(parsed.diagnostics.len(), 1, "value: {value}");
        }
    }
}
