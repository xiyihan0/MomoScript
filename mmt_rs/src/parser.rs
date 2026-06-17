use crate::diag::Diagnostic;
use crate::inline::parse_inline_macro_at;
use crate::source::{SourceFile, TextRange};
use crate::syntax::{
    BlankSyntax, BodyMode, BodyPartSyntax, BodySyntax, DirectiveBlockSyntax, DirectiveItemSyntax,
    DirectiveLineSyntax, ErrorNode, FieldSyntax, LiteralSyntax, PatchSyntax, SpeakerMarkerSyntax,
    StatementKind, StatementSyntax, SyntaxDocument, SyntaxNode,
};

#[derive(Debug, Clone)]
struct Line<'a> {
    text: &'a str,
    range: TextRange,
}

pub fn parse_text(text: &str) -> SyntaxDocument {
    let source = SourceFile::anonymous(text);
    parse_document(&source)
}

pub fn parse_document(source: &SourceFile) -> SyntaxDocument {
    let lines = collect_lines(source.text());
    let parser = Parser {
        source,
        lines,
        index: 0,
        diagnostics: Vec::new(),
        mode: BodyMode::TextMacro,
    };
    parser.parse()
}

struct Parser<'a> {
    source: &'a SourceFile,
    lines: Vec<Line<'a>>,
    index: usize,
    diagnostics: Vec<Diagnostic>,
    mode: BodyMode,
}

impl Parser<'_> {
    fn parse(mut self) -> SyntaxDocument {
        let mut nodes = Vec::new();

        while self.index < self.lines.len() {
            let line = self.lines[self.index].clone();
            if line.text.trim().is_empty() {
                nodes.push(SyntaxNode::Blank(BlankSyntax { range: line.range }));
                self.index += 1;
                continue;
            }

            if is_statement_start(line.text) {
                nodes.push(SyntaxNode::Statement(self.parse_statement()));
                continue;
            }

            if line.text.starts_with('@') {
                if line.text.trim_end() == "@end" {
                    self.diagnostics.push(Diagnostic::syntax_error(
                        "unexpected @end without matching directive block",
                        line.range,
                    ));
                    nodes.push(SyntaxNode::Error(ErrorNode {
                        message: "unexpected @end".to_string(),
                        source: line.text.to_string(),
                        range: line.range,
                    }));
                    self.index += 1;
                    continue;
                }

                nodes.push(self.parse_directive());
                continue;
            }

            nodes.push(SyntaxNode::Error(ErrorNode {
                message: "unrecognized top-level text".to_string(),
                source: line.text.to_string(),
                range: line.range,
            }));
            self.index += 1;
        }

        SyntaxDocument {
            nodes,
            diagnostics: self.diagnostics,
            range: self.source.range(),
        }
    }

    fn parse_statement(&mut self) -> StatementSyntax {
        let first_line = self.lines[self.index].clone();
        let sigil = first_line.text.as_bytes()[0] as char;
        let kind = match sigil {
            '>' => StatementKind::Right,
            '<' => StatementKind::Left,
            '-' => StatementKind::Narration,
            _ => unreachable!("caller only invokes parse_statement for statement lines"),
        };

        let mut cursor = first_line.range.start + 1;
        let mut rest = &first_line.text[1..];
        let leading_ws = rest.len() - rest.trim_start().len();
        cursor += leading_ws;
        rest = rest.trim_start();

        let patch = if rest.starts_with('(') {
            match parse_patch(rest, cursor) {
                Ok((patch, consumed)) => {
                    cursor += consumed;
                    rest = &rest[consumed..];
                    let ws = rest.len() - rest.trim_start().len();
                    cursor += ws;
                    rest = rest.trim_start();
                    Some(patch)
                }
                Err(range) => {
                    self.diagnostics
                        .push(Diagnostic::syntax_error("unclosed statement patch", range));
                    None
                }
            }
        } else {
            None
        };

        let (marker, first_body, first_body_start) = if kind == StatementKind::Narration {
            (None, rest.to_string(), cursor)
        } else {
            parse_speaker_and_body(rest, cursor)
        };

        let mut body_source = first_body;
        let body_start = first_body_start;
        let mut range_end = first_line.range.end;
        self.index += 1;

        while self.index < self.lines.len() {
            let line = self.lines[self.index].clone();
            if is_explicit_top_level_start(line.text) {
                break;
            }
            body_source.push('\n');
            body_source.push_str(line.text);
            range_end = line.range.end;
            self.index += 1;
        }

        let body = make_body(
            self.mode,
            body_source,
            TextRange::new(body_start, range_end),
        );

        StatementSyntax {
            kind,
            marker,
            patch,
            body,
            range: TextRange::new(first_line.range.start, range_end),
        }
    }

    fn parse_directive(&mut self) -> SyntaxNode {
        let header = self.lines[self.index].clone();
        let Some((name, name_range, after_name)) =
            parse_directive_name(header.text, header.range.start)
        else {
            self.index += 1;
            return SyntaxNode::Error(ErrorNode {
                message: "malformed directive".to_string(),
                source: header.text.to_string(),
                range: header.range,
            });
        };

        let after_name_text = &header.text[after_name - header.range.start..];
        if let Some(payload_start_relative) =
            after_name_text.strip_prefix(':').map(|_| after_name + 1)
        {
            let payload = &self.source.text()[payload_start_relative..header.range.end];
            let payload_start =
                payload_start_relative + payload.len().saturating_sub(payload.trim_start().len());
            let payload = payload.trim_start().to_string();
            self.index += 1;
            return SyntaxNode::DirectiveLine(DirectiveLineSyntax {
                name,
                name_range,
                payload: if payload.is_empty() {
                    None
                } else {
                    Some(make_body(
                        self.mode,
                        payload,
                        TextRange::new(payload_start, header.range.end),
                    ))
                },
                range: header.range,
            });
        }

        self.parse_directive_block(name, name_range, after_name, header)
    }

    fn parse_directive_block(
        &mut self,
        name: String,
        name_range: TextRange,
        after_name: usize,
        header: Line<'_>,
    ) -> SyntaxNode {
        let mut items = Vec::new();
        let mut range_end = header.range.end;
        let head_args = parse_head_args(
            &self.source.text()[after_name..header.range.end],
            after_name,
        );
        self.index += 1;

        while self.index < self.lines.len() {
            let line = self.lines[self.index].clone();
            if line.text.trim_end() == "@end" && line.text.starts_with("@end") {
                range_end = line.range.end;
                self.index += 1;
                return SyntaxNode::DirectiveBlock(DirectiveBlockSyntax {
                    name,
                    name_range,
                    head_args,
                    patch: None,
                    items,
                    range: TextRange::new(header.range.start, range_end),
                });
            }

            if line.text.starts_with('@') {
                self.diagnostics.push(Diagnostic::syntax_error(
                    "nested directive blocks are not supported in this parser revision",
                    line.range,
                ));
                items.push(DirectiveItemSyntax::Error(ErrorNode {
                    message: "nested directive block".to_string(),
                    source: line.text.to_string(),
                    range: line.range,
                }));
                range_end = line.range.end;
                self.index += 1;
                continue;
            }

            range_end = line.range.end;
            items.push(parse_directive_item(line, self.mode));
            self.index += 1;
        }

        self.diagnostics.push(Diagnostic::syntax_error(
            "unterminated directive block, expected @end",
            TextRange::new(header.range.start, range_end),
        ));
        SyntaxNode::DirectiveBlock(DirectiveBlockSyntax {
            name,
            name_range,
            head_args,
            patch: None,
            items,
            range: TextRange::new(header.range.start, range_end),
        })
    }
}

fn collect_lines(text: &str) -> Vec<Line<'_>> {
    let mut result = Vec::new();
    let mut offset = 0;

    for segment in text.split_inclusive('\n') {
        let line_text = segment.strip_suffix('\n').unwrap_or(segment);
        let line_text = line_text.strip_suffix('\r').unwrap_or(line_text);
        let end = offset + line_text.len();
        result.push(Line {
            text: line_text,
            range: TextRange::new(offset, end),
        });
        offset += segment.len();
    }

    if text.is_empty() {
        return result;
    }
    if !text.ends_with('\n') && result.is_empty() {
        result.push(Line {
            text,
            range: TextRange::new(0, text.len()),
        });
    }
    result
}

fn is_statement_start(text: &str) -> bool {
    matches!(
        text.as_bytes().first(),
        Some(b'>') | Some(b'<') | Some(b'-')
    )
}

fn is_explicit_top_level_start(text: &str) -> bool {
    text.starts_with('@') || is_statement_start(text)
}

fn parse_patch(text: &str, absolute_start: usize) -> Result<(PatchSyntax, usize), TextRange> {
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
                    return Ok((
                        PatchSyntax {
                            raw_args: text[1..offset].to_string(),
                            range: TextRange::new(absolute_start, absolute_start + consumed),
                            args_range: TextRange::new(absolute_start + 1, absolute_start + offset),
                        },
                        consumed,
                    ));
                }
            }
            _ => {}
        }
    }
    Err(TextRange::new(absolute_start, absolute_start + text.len()))
}

fn parse_speaker_and_body(
    text: &str,
    absolute_start: usize,
) -> (Option<SpeakerMarkerSyntax>, String, usize) {
    let Some(colon_offset) = text.find(':') else {
        return (None, text.to_string(), absolute_start);
    };

    let marker_raw = text[..colon_offset].trim();
    if marker_raw.is_empty() {
        return (
            None,
            text[colon_offset + 1..].trim_start().to_string(),
            absolute_start + colon_offset + 1 + text[colon_offset + 1..].len()
                - text[colon_offset + 1..].trim_start().len(),
        );
    }

    let marker_leading = text[..colon_offset].len() - text[..colon_offset].trim_start().len();
    let marker_range = TextRange::new(
        absolute_start + marker_leading,
        absolute_start + marker_leading + marker_raw.len(),
    );
    let body_raw = &text[colon_offset + 1..];
    let body_leading = body_raw.len() - body_raw.trim_start().len();
    let body_start = absolute_start + colon_offset + 1 + body_leading;

    (
        Some(parse_speaker_marker(marker_raw, marker_range)),
        body_raw.trim_start().to_string(),
        body_start,
    )
}

fn parse_speaker_marker(raw: &str, range: TextRange) -> SpeakerMarkerSyntax {
    if let Some(rest) = raw.strip_prefix('_') {
        if rest.is_empty() {
            return SpeakerMarkerSyntax::BackRef { n: 1, range };
        }
        if let Ok(n) = rest.parse::<u32>() {
            return SpeakerMarkerSyntax::BackRef { n, range };
        }
    }

    if let Some(rest) = raw.strip_prefix('~') {
        if rest.is_empty() {
            return SpeakerMarkerSyntax::UniqueIndex { n: 1, range };
        }
        if let Ok(n) = rest.parse::<u32>() {
            return SpeakerMarkerSyntax::UniqueIndex { n, range };
        }
    }

    SpeakerMarkerSyntax::Explicit {
        raw: raw.to_string(),
        range,
    }
}

fn parse_directive_name(text: &str, absolute_start: usize) -> Option<(String, TextRange, usize)> {
    let rest = text.strip_prefix('@')?;
    let mut name_end = 0;
    for (offset, ch) in rest.char_indices() {
        if ch.is_alphanumeric() || ch == '_' {
            name_end = offset + ch.len_utf8();
        } else {
            break;
        }
    }
    if name_end == 0 {
        return None;
    }
    let name_start = absolute_start + 1;
    Some((
        rest[..name_end].to_string(),
        TextRange::new(name_start, name_start + name_end),
        name_start + name_end,
    ))
}

fn parse_head_args(text: &str, absolute_start: usize) -> Vec<LiteralSyntax> {
    let mut result = Vec::new();
    let mut cursor = 0;
    for token in text.split_whitespace() {
        if let Some(relative) = text[cursor..].find(token) {
            let start = cursor + relative;
            result.push(LiteralSyntax {
                raw: token.to_string(),
                range: TextRange::new(absolute_start + start, absolute_start + start + token.len()),
            });
            cursor = start + token.len();
        }
    }
    result
}

fn parse_directive_item(line: Line<'_>, mode: BodyMode) -> DirectiveItemSyntax {
    if let Some(colon) = line.text.find(':') {
        let name = line.text[..colon].trim();
        if !name.is_empty()
            && name
                .chars()
                .all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '-')
        {
            let leading = line.text[..colon].len() - line.text[..colon].trim_start().len();
            let value_raw = &line.text[colon + 1..];
            let value_leading = value_raw.len() - value_raw.trim_start().len();
            return DirectiveItemSyntax::Field(FieldSyntax {
                name: name.to_string(),
                name_range: TextRange::new(
                    line.range.start + leading,
                    line.range.start + leading + name.len(),
                ),
                value: value_raw.trim_start().to_string(),
                value_range: TextRange::new(
                    line.range.start + colon + 1 + value_leading,
                    line.range.end,
                ),
                range: line.range,
            });
        }
    }

    DirectiveItemSyntax::Body(make_body(mode, line.text.to_string(), line.range))
}

fn make_body(mode: BodyMode, source: String, range: TextRange) -> BodySyntax {
    let parts = if matches!(mode, BodyMode::TextRaw | BodyMode::TypstRaw) {
        vec![BodyPartSyntax::Text {
            source: source.clone(),
            range,
        }]
    } else {
        parse_body_parts(&source, range.start)
    };

    BodySyntax {
        mode,
        source,
        range,
        parts,
    }
}

fn parse_body_parts(source: &str, absolute_start: usize) -> Vec<BodyPartSyntax> {
    let mut parts = Vec::new();
    let mut cursor = 0;
    while cursor < source.len() {
        let Some(relative) = source[cursor..].find("[:") else {
            parts.push(BodyPartSyntax::Text {
                source: source[cursor..].to_string(),
                range: TextRange::new(absolute_start + cursor, absolute_start + source.len()),
            });
            break;
        };
        let marker_start = cursor + relative;
        if marker_start > cursor {
            parts.push(BodyPartSyntax::Text {
                source: source[cursor..marker_start].to_string(),
                range: TextRange::new(absolute_start + cursor, absolute_start + marker_start),
            });
        }

        if let Some(marker) =
            parse_inline_macro_at(&source[marker_start..], absolute_start + marker_start)
        {
            cursor = marker.range.end - absolute_start;
            parts.push(BodyPartSyntax::InlineMacro(marker));
        } else {
            parts.push(BodyPartSyntax::Text {
                source: source[marker_start..marker_start + 2].to_string(),
                range: TextRange::new(
                    absolute_start + marker_start,
                    absolute_start + marker_start + 2,
                ),
            });
            cursor = marker_start + 2;
        }
    }

    if source.is_empty() {
        parts.push(BodyPartSyntax::Text {
            source: String::new(),
            range: TextRange::empty(absolute_start),
        });
    }

    parts
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inline::MacroValueSyntax;

    #[test]
    fn parses_empty_document() {
        let doc = parse_text("");
        assert!(doc.nodes.is_empty());
        assert!(doc.diagnostics.is_empty());
    }

    #[test]
    fn parses_statement_with_explicit_marker_and_patch() {
        let doc = parse_text(">(fill: green) 柚子: 你好");
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::Statement(statement) = &doc.nodes[0] else {
            panic!("expected statement");
        };
        assert_eq!(statement.kind, StatementKind::Right);
        assert_eq!(
            statement
                .patch
                .as_ref()
                .map(|patch| patch.raw_args.as_str()),
            Some("fill: green")
        );
        assert!(matches!(
            statement.marker,
            Some(SpeakerMarkerSyntax::Explicit { ref raw, .. }) if raw == "柚子"
        ));
        assert_eq!(statement.body.source, "你好");
    }

    #[test]
    fn parses_backref_and_unique_speaker_markers() {
        let doc = parse_text("> _: one\n< ~2: two");
        assert_eq!(doc.nodes.len(), 2);

        let SyntaxNode::Statement(first) = &doc.nodes[0] else {
            panic!("expected first statement");
        };
        assert!(matches!(
            first.marker,
            Some(SpeakerMarkerSyntax::BackRef { n: 1, .. })
        ));

        let SyntaxNode::Statement(second) = &doc.nodes[1] else {
            panic!("expected second statement");
        };
        assert!(matches!(
            second.marker,
            Some(SpeakerMarkerSyntax::UniqueIndex { n: 2, .. })
        ));
    }

    #[test]
    fn parses_colon_directive_line() {
        let doc = parse_text("@reply: 是 | 否");
        let SyntaxNode::DirectiveLine(line) = &doc.nodes[0] else {
            panic!("expected directive line");
        };
        assert_eq!(line.name, "reply");
        assert_eq!(
            line.payload.as_ref().map(|body| body.source.as_str()),
            Some("是 | 否")
        );
    }

    #[test]
    fn parses_inline_macro_parts_in_body() {
        let doc = parse_text("> 柚子: 看看[:#1:](width: 2em)");
        let SyntaxNode::Statement(statement) = &doc.nodes[0] else {
            panic!("expected statement");
        };

        assert!(statement.body.parts.iter().any(|part| matches!(
            part,
            BodyPartSyntax::InlineMacro(marker)
                if matches!(marker.args[0].value, MacroValueSyntax::Ordinal { n: 1 })
        )));
    }

    #[test]
    fn statement_continuation_stops_only_at_unindented_node_starts() {
        let doc = parse_text("> 柚子: 第一行\n  > 这行是文本\n第二行\n< 桃井: 新节点");
        assert!(doc.diagnostics.is_empty());
        assert_eq!(doc.nodes.len(), 2);

        let SyntaxNode::Statement(first) = &doc.nodes[0] else {
            panic!("expected first statement");
        };
        assert_eq!(first.body.source, "第一行\n  > 这行是文本\n第二行");

        let SyntaxNode::Statement(second) = &doc.nodes[1] else {
            panic!("expected second statement");
        };
        assert_eq!(second.body.source, "新节点");
    }

    #[test]
    fn directive_block_preserves_generic_fields() {
        let doc = parse_text("@char hifumi\nbind: ba::日富美\nhandles: 日富美\n@end");
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::DirectiveBlock(block) = &doc.nodes[0] else {
            panic!("expected directive block");
        };
        assert_eq!(block.name, "char");
        assert_eq!(block.head_args[0].raw, "hifumi");
        assert_eq!(block.items.len(), 2);
        assert!(matches!(
            &block.items[0],
            DirectiveItemSyntax::Field(field)
                if field.name == "bind" && field.value == "ba::日富美"
        ));
    }

    #[test]
    fn unterminated_directive_block_reports_diagnostic_but_keeps_node() {
        let doc = parse_text("@asset\nname: hero");

        assert_eq!(doc.nodes.len(), 1);
        assert_eq!(doc.diagnostics.len(), 1);
        assert!(
            doc.diagnostics[0]
                .message
                .contains("unterminated directive block")
        );
        assert!(matches!(doc.nodes[0], SyntaxNode::DirectiveBlock(_)));
    }

    #[test]
    fn nested_directive_inside_block_is_visible_error() {
        let doc = parse_text("@char hifumi\n@asset\n@end");

        assert_eq!(doc.diagnostics.len(), 1);
        assert!(
            doc.diagnostics[0]
                .message
                .contains("nested directive blocks")
        );

        let SyntaxNode::DirectiveBlock(block) = &doc.nodes[0] else {
            panic!("expected directive block");
        };
        assert!(matches!(&block.items[0], DirectiveItemSyntax::Error(_)));
    }

    #[test]
    fn unclosed_statement_patch_reports_syntax_error() {
        let doc = parse_text(">(fill: green 柚子: 你好");

        assert_eq!(doc.diagnostics.len(), 1);
        assert!(
            doc.diagnostics[0]
                .message
                .contains("unclosed statement patch")
        );
        assert!(matches!(doc.nodes[0], SyntaxNode::Statement(_)));
    }
}
