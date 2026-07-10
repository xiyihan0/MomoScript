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

    if let Some((namespace, value)) = raw.split_once("::") {
        if !namespace.is_empty() && !value.is_empty() {
            return MacroValueSyntax::Namespaced {
                namespace: namespace.to_string(),
                value: Box::new(parse_macro_value(value)),
            };
        }
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
}
