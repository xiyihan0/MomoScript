use crate::diag::Diagnostic;
use crate::inline::{InlineMacroParseError, parse_inline_macro_at_checked};
use crate::source::{SourceFile, TextRange};
use crate::syntax::{
    BlankSyntax, BodyMode, BodyPartSyntax, BodySyntax, BondSyntax, DirectiveBlockSyntax,
    DirectiveItemSyntax, DirectiveLineSyntax, ErrorNode, FieldSyntax, LiteralSyntax, PatchSyntax,
    ReplySyntax, SpeakerMarkerSyntax, StatementKind, StatementSyntax, SyntaxDocument, SyntaxNode,
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
    };
    parser.parse()
}

struct Parser<'a> {
    source: &'a SourceFile,
    lines: Vec<Line<'a>>,
    index: usize,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone)]
struct DirectiveHeader {
    name: String,
    name_range: TextRange,
    patch: Option<PatchSyntax>,
    head_args: Vec<LiteralSyntax>,
    payload_start: Option<usize>,
}

#[derive(Debug, Clone)]
struct FenceOpen<'a> {
    mode: BodyMode,
    fence_len: usize,
    content_start: usize,
    remaining: &'a str,
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
            '>' => StatementKind::Left,
            '<' => StatementKind::Right,
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

        if let Some((body, statement_range_end)) =
            self.try_parse_fenced_body(&body_source, body_start, range_end)
        {
            return StatementSyntax {
                kind,
                marker,
                patch,
                body,
                range: TextRange::new(first_line.range.start, statement_range_end),
            };
        }

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

        let body = self.make_body(body_source, TextRange::new(body_start, range_end));

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
        let Some(header_parts) = self.parse_directive_header(header.clone()) else {
            self.index += 1;
            return SyntaxNode::Error(ErrorNode {
                message: "malformed directive".to_string(),
                source: header.text.to_string(),
                range: header.range,
            });
        };

        match header_parts.name.as_str() {
            "reply" => self.parse_reply(header_parts, header),
            "bond" => self.parse_bond(header_parts, header),
            "typ" if header_parts.payload_start.is_none() => {
                self.parse_content_directive_block(header_parts, header)
            }
            _ if header_parts.payload_start.is_some() => {
                self.parse_directive_line(header_parts, header)
            }
            _ => self.parse_directive_block(header_parts, header),
        }
    }

    fn parse_directive_line(
        &mut self,
        header_parts: DirectiveHeader,
        header: Line<'_>,
    ) -> SyntaxNode {
        let payload_start = header_parts
            .payload_start
            .expect("directive line requires payload start");
        let payload = &self.source.text()[payload_start..header.range.end];
        let payload_start =
            payload_start + payload.len().saturating_sub(payload.trim_start().len());
        let payload = payload.trim_start().to_string();
        self.index += 1;

        let payload = if payload.is_empty() {
            None
        } else if let Some((body, _range_end)) =
            self.try_parse_fenced_body(&payload, payload_start, header.range.end)
        {
            Some(body)
        } else if header_parts.name == "typ" {
            Some(self.make_body_with_mode(
                BodyMode::TypstRaw,
                payload,
                TextRange::new(payload_start, header.range.end),
            ))
        } else {
            Some(self.make_body(payload, TextRange::new(payload_start, header.range.end)))
        };

        SyntaxNode::DirectiveLine(DirectiveLineSyntax {
            name: header_parts.name,
            name_range: header_parts.name_range,
            payload,
            range: header.range,
        })
    }

    fn parse_content_directive_block(
        &mut self,
        header_parts: DirectiveHeader,
        header: Line<'_>,
    ) -> SyntaxNode {
        let mut source = String::new();
        let mut body_start = header.range.end;
        let mut body_end = header.range.end;
        let mut range_end = header.range.end;
        self.index += 1;

        while self.index < self.lines.len() {
            let line = self.lines[self.index].clone();
            if line.text == "@end" {
                range_end = line.range.end;
                self.index += 1;
                return SyntaxNode::DirectiveBlock(DirectiveBlockSyntax {
                    name: header_parts.name,
                    name_range: header_parts.name_range,
                    head_args: header_parts.head_args,
                    patch: header_parts.patch,
                    items: vec![DirectiveItemSyntax::Body(self.make_body_with_mode(
                        BodyMode::TypstRaw,
                        source,
                        TextRange::new(body_start, body_end),
                    ))],
                    range: TextRange::new(header.range.start, range_end),
                });
            }

            if source.is_empty() {
                body_start = line.range.start;
            } else {
                source.push_str(&self.source.text()[body_end..line.range.start]);
            }
            source.push_str(line.text);
            body_end = line.range.end;
            range_end = line.range.end;
            self.index += 1;
        }

        self.diagnostics.push(Diagnostic::syntax_error(
            "unterminated @typ block, expected @end",
            TextRange::new(header.range.start, range_end),
        ));
        SyntaxNode::DirectiveBlock(DirectiveBlockSyntax {
            name: header_parts.name,
            name_range: header_parts.name_range,
            head_args: header_parts.head_args,
            patch: header_parts.patch,
            items: vec![DirectiveItemSyntax::Body(self.make_body_with_mode(
                BodyMode::TypstRaw,
                source,
                TextRange::new(body_start, body_end),
            ))],
            range: TextRange::new(header.range.start, range_end),
        })
    }

    fn parse_directive_block(
        &mut self,
        header_parts: DirectiveHeader,
        header: Line<'_>,
    ) -> SyntaxNode {
        let mut items = Vec::new();
        let mut range_end = header.range.end;
        self.index += 1;

        while self.index < self.lines.len() {
            let line = self.lines[self.index].clone();
            if line.text.trim_end() == "@end" && line.text.starts_with("@end") {
                range_end = line.range.end;
                self.index += 1;
                return SyntaxNode::DirectiveBlock(DirectiveBlockSyntax {
                    name: header_parts.name,
                    name_range: header_parts.name_range,
                    head_args: header_parts.head_args,
                    patch: header_parts.patch,
                    items,
                    range: TextRange::new(header.range.start, range_end),
                });
            }

            if line.text.starts_with('@') {
                let error = self.consume_nested_directive_error();
                range_end = error.range.end;
                items.push(DirectiveItemSyntax::Error(error));
                continue;
            }

            range_end = line.range.end;
            items.push(parse_directive_item(line, &mut self.diagnostics));
            self.index += 1;
        }

        self.diagnostics.push(Diagnostic::syntax_error(
            "unterminated directive block, expected @end",
            TextRange::new(header.range.start, range_end),
        ));
        SyntaxNode::DirectiveBlock(DirectiveBlockSyntax {
            name: header_parts.name,
            name_range: header_parts.name_range,
            head_args: header_parts.head_args,
            patch: header_parts.patch,
            items,
            range: TextRange::new(header.range.start, range_end),
        })
    }

    fn consume_nested_directive_error(&mut self) -> ErrorNode {
        let start_line = self.lines[self.index].clone();
        self.diagnostics.push(Diagnostic::syntax_error(
            "nested directive blocks are not supported in this parser revision",
            start_line.range,
        ));

        let mut source = String::new();
        let mut range_end = start_line.range.end;
        while self.index < self.lines.len() {
            let line = self.lines[self.index].clone();
            if !source.is_empty() {
                source.push('\n');
            }
            source.push_str(line.text);
            range_end = line.range.end;
            self.index += 1;
            if line.text.starts_with("@end") && line.text.trim_end() == "@end" {
                break;
            }
        }

        ErrorNode {
            message: "nested directive block".to_string(),
            source,
            range: TextRange::new(start_line.range.start, range_end),
        }
    }

    fn parse_reply(&mut self, header_parts: DirectiveHeader, header: Line<'_>) -> SyntaxNode {
        if header_parts.payload_start.is_some() {
            return self.parse_reply_line(header_parts, header);
        }
        self.parse_reply_block(header_parts, header)
    }

    fn parse_reply_line(&mut self, header_parts: DirectiveHeader, header: Line<'_>) -> SyntaxNode {
        let payload_start = header_parts
            .payload_start
            .expect("reply line requires payload start");
        let payload = &self.source.text()[payload_start..header.range.end];
        let payload_start =
            payload_start + payload.len().saturating_sub(payload.trim_start().len());
        let payload = payload.trim_start();
        self.index += 1;

        let items = if payload.is_empty() {
            Vec::new()
        } else if let Some((body, _range_end)) =
            self.try_parse_fenced_body(payload, payload_start, header.range.end)
        {
            vec![body]
        } else {
            split_reply_items(payload, payload_start)
                .into_iter()
                .map(|(source, range)| self.make_body(source, range))
                .collect()
        };

        SyntaxNode::Reply(ReplySyntax {
            items,
            patch: header_parts.patch,
            range: header.range,
        })
    }

    fn parse_reply_block(&mut self, header_parts: DirectiveHeader, header: Line<'_>) -> SyntaxNode {
        let mut items = Vec::new();
        let mut current_item: Option<(String, usize, usize)> = None;
        let mut range_end = header.range.end;
        self.index += 1;

        while self.index < self.lines.len() {
            let line = self.lines[self.index].clone();
            if line.text.starts_with("@end") && line.text.trim_end() == "@end" {
                if let Some((source, start, end)) = current_item.take() {
                    items.push(self.make_body(source, TextRange::new(start, end)));
                }
                range_end = line.range.end;
                self.index += 1;
                return SyntaxNode::Reply(ReplySyntax {
                    items,
                    patch: header_parts.patch,
                    range: TextRange::new(header.range.start, range_end),
                });
            }

            if line.text.starts_with('@') {
                if let Some((source, start, end)) = current_item.take() {
                    items.push(self.make_body(source, TextRange::new(start, end)));
                }
                let error = self.consume_nested_directive_error();
                range_end = error.range.end;
                continue;
            }

            if line.text.starts_with('-') {
                if let Some((source, start, end)) = current_item.take() {
                    items.push(self.make_body(source, TextRange::new(start, end)));
                }

                let raw = &line.text[1..];
                let body_text = raw.trim_start();
                let body_start = line.range.start + 1 + raw.len() - body_text.len();
                self.index += 1;
                if let Some((body, item_range_end)) =
                    self.try_parse_fenced_body(body_text, body_start, line.range.end)
                {
                    range_end = item_range_end;
                    items.push(body);
                    continue;
                }

                current_item = Some((body_text.to_string(), body_start, line.range.end));
                range_end = line.range.end;
                continue;
            }

            if let Some((source, _start, end)) = &mut current_item {
                source.push('\n');
                source.push_str(line.text);
                *end = line.range.end;
            } else if !line.text.trim().is_empty() {
                self.diagnostics.push(Diagnostic::syntax_error(
                    "reply block item must start with '-'",
                    line.range,
                ));
            }
            range_end = line.range.end;
            self.index += 1;
        }

        if let Some((source, start, end)) = current_item.take() {
            items.push(self.make_body(source, TextRange::new(start, end)));
        }
        self.diagnostics.push(Diagnostic::syntax_error(
            "unterminated reply block, expected @end",
            TextRange::new(header.range.start, range_end),
        ));
        SyntaxNode::Reply(ReplySyntax {
            items,
            patch: header_parts.patch,
            range: TextRange::new(header.range.start, range_end),
        })
    }

    fn parse_bond(&mut self, header_parts: DirectiveHeader, header: Line<'_>) -> SyntaxNode {
        if header_parts.payload_start.is_some() {
            return self.parse_bond_line(header_parts, header);
        }
        self.parse_bond_block(header_parts, header)
    }

    fn parse_bond_line(&mut self, header_parts: DirectiveHeader, header: Line<'_>) -> SyntaxNode {
        let payload_start = header_parts
            .payload_start
            .expect("bond line requires payload start");
        let payload = &self.source.text()[payload_start..header.range.end];
        let payload_start =
            payload_start + payload.len().saturating_sub(payload.trim_start().len());
        let payload = payload.trim_start().to_string();
        self.index += 1;
        let body = if let Some((body, _range_end)) =
            self.try_parse_fenced_body(&payload, payload_start, header.range.end)
        {
            body
        } else {
            self.make_body(payload, TextRange::new(payload_start, header.range.end))
        };
        SyntaxNode::Bond(BondSyntax {
            body,
            patch: header_parts.patch,
            range: header.range,
        })
    }

    fn parse_bond_block(&mut self, header_parts: DirectiveHeader, header: Line<'_>) -> SyntaxNode {
        let mut body_source = String::new();
        let mut body_start = header.range.end;
        let mut body_end = header.range.end;
        let mut range_end = header.range.end;
        self.index += 1;

        while self.index < self.lines.len() {
            let line = self.lines[self.index].clone();
            if line.text.starts_with("@end") && line.text.trim_end() == "@end" {
                range_end = line.range.end;
                self.index += 1;
                let body = self.make_body(body_source, TextRange::new(body_start, body_end));
                return SyntaxNode::Bond(BondSyntax {
                    body,
                    patch: header_parts.patch,
                    range: TextRange::new(header.range.start, range_end),
                });
            }

            if line.text.starts_with('@') {
                let error = self.consume_nested_directive_error();
                range_end = error.range.end;
                continue;
            }

            if body_source.is_empty() {
                body_start = line.range.start;
            } else {
                body_source.push('\n');
            }
            body_source.push_str(line.text);
            body_end = line.range.end;
            range_end = line.range.end;
            self.index += 1;
        }

        self.diagnostics.push(Diagnostic::syntax_error(
            "unterminated bond block, expected @end",
            TextRange::new(header.range.start, range_end),
        ));
        let body = self.make_body(body_source, TextRange::new(body_start, body_end));
        SyntaxNode::Bond(BondSyntax {
            body,
            patch: header_parts.patch,
            range: TextRange::new(header.range.start, range_end),
        })
    }

    fn parse_directive_header(&mut self, header: Line<'_>) -> Option<DirectiveHeader> {
        let (name, name_range, after_name) = parse_directive_name(header.text, header.range.start)?;
        let mut cursor = after_name;
        let mut rest = &self.source.text()[cursor..header.range.end];
        let leading_ws = rest.len() - rest.trim_start().len();
        cursor += leading_ws;
        rest = rest.trim_start();

        let patch = if rest.starts_with('(') {
            match parse_patch(rest, cursor) {
                Ok((patch, consumed)) => {
                    cursor += consumed;
                    rest = &self.source.text()[cursor..header.range.end];
                    let ws = rest.len() - rest.trim_start().len();
                    cursor += ws;
                    rest = rest.trim_start();
                    Some(patch)
                }
                Err(range) => {
                    self.diagnostics
                        .push(Diagnostic::syntax_error("unclosed directive patch", range));
                    None
                }
            }
        } else {
            None
        };

        let payload_start = rest.strip_prefix(':').map(|_| cursor + 1);
        let head_args = if payload_start.is_some() {
            Vec::new()
        } else {
            parse_head_args(rest, cursor, &mut self.diagnostics)
        };

        Some(DirectiveHeader {
            name,
            name_range,
            patch,
            head_args,
            payload_start,
        })
    }

    fn try_parse_fenced_body(
        &mut self,
        first_text: &str,
        first_start: usize,
        first_line_end: usize,
    ) -> Option<(BodySyntax, usize)> {
        let open = parse_fence_open(first_text, first_start)?;
        let body_start = open.content_start;

        if let Some(close_offset) = find_fence_close(open.remaining, open.fence_len) {
            let source = open.remaining[..close_offset].to_string();
            let body_end = open.content_start + close_offset;
            return Some((
                self.make_body_with_mode(open.mode, source, TextRange::new(body_start, body_end)),
                first_line_end,
            ));
        }

        let mut source = String::new();
        if !open.remaining.is_empty() {
            source.push_str(open.remaining);
        }
        let mut body_end = first_line_end;
        let mut range_end = first_line_end;

        while self.index < self.lines.len() {
            let line = self.lines[self.index].clone();
            if let Some(close_offset) = find_fence_close(line.text, open.fence_len) {
                if !source.is_empty() {
                    source.push('\n');
                }
                source.push_str(&line.text[..close_offset]);
                body_end = line.range.start + close_offset;
                range_end = line.range.end;
                self.index += 1;
                return Some((
                    self.make_body_with_mode(
                        open.mode,
                        source,
                        TextRange::new(body_start, body_end),
                    ),
                    range_end,
                ));
            }

            if !source.is_empty() {
                source.push('\n');
            }
            source.push_str(line.text);
            body_end = line.range.end;
            range_end = line.range.end;
            self.index += 1;
        }

        self.diagnostics.push(Diagnostic::syntax_error(
            "unterminated fenced body",
            TextRange::new(first_start, range_end),
        ));
        Some((
            self.make_body_with_mode(open.mode, source, TextRange::new(body_start, body_end)),
            range_end,
        ))
    }

    fn make_body(&mut self, source: String, range: TextRange) -> BodySyntax {
        self.make_body_with_mode(BodyMode::Inherit, source, range)
    }

    fn make_body_with_mode(
        &mut self,
        mode: BodyMode,
        source: String,
        range: TextRange,
    ) -> BodySyntax {
        make_body(mode, source, range, &mut self.diagnostics)
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
    if parse_fence_open(text, absolute_start).is_some() {
        return (None, text.to_string(), absolute_start);
    }

    let Some(colon_offset) = find_speaker_colon(text) else {
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

fn find_speaker_colon(text: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    let mut paren_depth = 0usize;
    let mut bracket_depth = 0usize;
    let mut brace_depth = 0usize;

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
            '(' => paren_depth += 1,
            ')' => paren_depth = paren_depth.saturating_sub(1),
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            '{' => brace_depth += 1,
            '}' => brace_depth = brace_depth.saturating_sub(1),
            ':' if paren_depth == 0 && bracket_depth == 0 && brace_depth == 0 => {
                let before = text[..offset].chars().next_back();
                let after = text[offset + 1..].chars().next();
                if before == Some(':') || after == Some(':') {
                    continue;
                }
                if text[offset + 1..].starts_with("//") {
                    continue;
                }
                return Some(offset);
            }
            _ => {}
        }
    }
    None
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

fn parse_head_args(
    text: &str,
    absolute_start: usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<LiteralSyntax> {
    let mut result = Vec::new();
    let mut token_start = None;
    let mut quote = None;
    let mut escaped = false;

    for (offset, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            token_start.get_or_insert(offset);
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
            token_start.get_or_insert(offset);
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if let Some(start) = token_start.take() {
                result.push(LiteralSyntax {
                    raw: text[start..offset].to_string(),
                    range: TextRange::new(absolute_start + start, absolute_start + offset),
                });
            }
        } else {
            token_start.get_or_insert(offset);
        }
    }

    if let Some(start) = token_start {
        result.push(LiteralSyntax {
            raw: text[start..].to_string(),
            range: TextRange::new(absolute_start + start, absolute_start + text.len()),
        });
        if quote.is_some() {
            diagnostics.push(Diagnostic::syntax_error(
                "unclosed quoted directive argument",
                TextRange::new(absolute_start + start, absolute_start + text.len()),
            ));
        }
    }
    result
}

fn parse_directive_item(line: Line<'_>, diagnostics: &mut Vec<Diagnostic>) -> DirectiveItemSyntax {
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

    DirectiveItemSyntax::Body(make_body(
        BodyMode::Inherit,
        line.text.to_string(),
        line.range,
        diagnostics,
    ))
}

fn make_body(
    mode: BodyMode,
    source: String,
    range: TextRange,
    diagnostics: &mut Vec<Diagnostic>,
) -> BodySyntax {
    let parts = if matches!(mode, BodyMode::TextRaw | BodyMode::TypstRaw) {
        vec![BodyPartSyntax::Text {
            source: source.clone(),
            range,
        }]
    } else {
        parse_body_parts(&source, range.start, diagnostics)
    };

    BodySyntax {
        mode,
        source,
        range,
        parts,
    }
}

fn parse_body_parts(
    source: &str,
    absolute_start: usize,
    diagnostics: &mut Vec<Diagnostic>,
) -> Vec<BodyPartSyntax> {
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

        match parse_inline_macro_at_checked(&source[marker_start..], absolute_start + marker_start)
        {
            Ok(parsed) => {
                for diagnostic in parsed.diagnostics {
                    diagnostics.push(Diagnostic::syntax_error(
                        diagnostic.message,
                        diagnostic.range,
                    ));
                }
                cursor = parsed.syntax.range.end - absolute_start;
                parts.push(BodyPartSyntax::InlineMacro(parsed.syntax));
            }
            Err(InlineMacroParseError::MissingClose { range }) => {
                diagnostics.push(Diagnostic::syntax_error("unclosed inline macro", range));
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
    }

    if source.is_empty() {
        parts.push(BodyPartSyntax::Text {
            source: String::new(),
            range: TextRange::empty(absolute_start),
        });
    }

    parts
}

fn parse_fence_open<'a>(text: &'a str, absolute_start: usize) -> Option<FenceOpen<'a>> {
    let leading_ws = text.len() - text.trim_start().len();
    let trimmed = text.trim_start();

    for (prefix, mode) in [
        ("rT", BodyMode::TypstRaw),
        ("rt", BodyMode::TextRaw),
        ("T", BodyMode::TypstMacro),
        ("t", BodyMode::TextMacro),
        ("", BodyMode::Inherit),
    ] {
        let Some(after_prefix) = trimmed.strip_prefix(prefix) else {
            continue;
        };
        if !after_prefix.starts_with("\"\"\"") {
            continue;
        }
        let fence_len = after_prefix
            .chars()
            .take_while(|ch| *ch == '"')
            .map(char::len_utf8)
            .sum::<usize>();
        if fence_len < 3 {
            continue;
        }
        let content_start = leading_ws + prefix.len() + fence_len;
        return Some(FenceOpen {
            mode,
            fence_len,
            content_start: absolute_start + content_start,
            remaining: &text[content_start..],
        });
    }

    None
}

fn find_fence_close(text: &str, fence_len: usize) -> Option<usize> {
    let mut quote_run_start = None;
    let mut quote_count = 0usize;

    for (offset, ch) in text.char_indices() {
        if ch == '"' {
            if quote_run_start.is_none() {
                quote_run_start = Some(offset);
            }
            quote_count += 1;
            if quote_count >= fence_len {
                return quote_run_start;
            }
        } else {
            quote_run_start = None;
            quote_count = 0;
        }
    }

    None
}

fn split_reply_items(text: &str, absolute_start: usize) -> Vec<(String, TextRange)> {
    let mut result = Vec::new();
    let mut start = 0usize;
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
        if ch == '|' {
            push_reply_item(text, start, offset, absolute_start, &mut result);
            start = offset + ch.len_utf8();
        }
    }
    push_reply_item(text, start, text.len(), absolute_start, &mut result);
    result
}

fn push_reply_item(
    text: &str,
    start: usize,
    end: usize,
    absolute_start: usize,
    result: &mut Vec<(String, TextRange)>,
) {
    let raw = &text[start..end];
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    let leading_ws = raw.len() - raw.trim_start().len();
    let trailing_ws = raw.len() - raw.trim_end().len();
    result.push((
        trimmed.to_string(),
        TextRange::new(
            absolute_start + start + leading_ws,
            absolute_start + end - trailing_ws,
        ),
    ));
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
        assert_eq!(statement.kind, StatementKind::Left);
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
        let doc = parse_text("> _: one\n> _0: current\n< ~2: two");
        assert_eq!(doc.nodes.len(), 3);

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
            Some(SpeakerMarkerSyntax::BackRef { n: 0, .. })
        ));

        let SyntaxNode::Statement(third) = &doc.nodes[2] else {
            panic!("expected third statement");
        };
        assert!(matches!(
            third.marker,
            Some(SpeakerMarkerSyntax::UniqueIndex { n: 2, .. })
        ));
    }

    #[test]
    fn speaker_separator_ignores_namespaces_urls_and_nested_colons() {
        let doc = parse_text(
            "> ba::柚子: namespaced speaker\n\
             > [:#1:] body without speaker\n\
             > https://example.com/a.png\n\
             > #text(\"label: value\")",
        );
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::Statement(first) = &doc.nodes[0] else {
            panic!("expected statement");
        };
        assert!(matches!(
            &first.marker,
            Some(SpeakerMarkerSyntax::Explicit { raw, .. }) if raw == "ba::柚子"
        ));
        for node in &doc.nodes[1..] {
            let SyntaxNode::Statement(statement) = node else {
                panic!("expected statement");
            };
            assert!(statement.marker.is_none());
        }
    }

    #[test]
    fn speaker_separator_does_not_split_fenced_typst_body() {
        let doc = parse_text("> T\"\"\"[:#1:] #text(\"label: value\")\"\"\"");
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::Statement(statement) = &doc.nodes[0] else {
            panic!("expected statement");
        };
        assert!(statement.marker.is_none());
        assert_eq!(statement.body.mode, BodyMode::TypstMacro);
        assert_eq!(statement.body.source, "[:#1:] #text(\"label: value\")");
    }

    #[test]
    fn parses_reply_line_into_split_items() {
        let doc = parse_text("@reply: 是 | 否");
        let SyntaxNode::Reply(reply) = &doc.nodes[0] else {
            panic!("expected reply");
        };
        assert_eq!(reply.items.len(), 2);
        assert_eq!(reply.items[0].source, "是");
        assert_eq!(reply.items[1].source, "否");
    }

    #[test]
    fn generic_colon_directive_line_still_preserves_payload() {
        let doc = parse_text("@typ: #let x = 1");
        let SyntaxNode::DirectiveLine(line) = &doc.nodes[0] else {
            panic!("expected directive line");
        };
        assert_eq!(line.name, "typ");
        assert_eq!(
            line.payload.as_ref().map(|body| body.source.as_str()),
            Some("#let x = 1")
        );
        assert_eq!(
            line.payload.as_ref().map(|body| body.mode),
            Some(BodyMode::TypstRaw)
        );
    }

    #[test]
    fn typ_block_preserves_arbitrary_content_as_one_raw_body() {
        let doc = parse_text(
            "@typ\n\
             #let config = (\n\
             name: \"value\",\n\
             )\n\
             @reference remains typst content\n\
             @end",
        );
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::DirectiveBlock(block) = &doc.nodes[0] else {
            panic!("expected typ directive block");
        };
        assert_eq!(block.name, "typ");
        assert_eq!(block.items.len(), 1);
        assert!(matches!(
            &block.items[0],
            DirectiveItemSyntax::Body(body)
                if body.mode == BodyMode::TypstRaw
                    && body.source == "#let config = (\nname: \"value\",\n)\n@reference remains typst content"
        ));
    }

    #[test]
    fn typ_block_preserves_crlf_in_identity_mapped_body() {
        let source =
            "@typ\r\n\r\n#let step(body) = text(fill: white, weight: \"bold\", body)\r\n\r\n@end";
        let doc = parse_text(source);
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::DirectiveBlock(block) = &doc.nodes[0] else {
            panic!("expected typ directive block");
        };
        let DirectiveItemSyntax::Body(body) = &block.items[0] else {
            panic!("expected typ directive body");
        };
        assert_eq!(body.source, &source[body.range.start..body.range.end]);
        assert_eq!(
            body.source,
            "#let step(body) = text(fill: white, weight: \"bold\", body)\r\n"
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
        let doc = parse_text("@actor hifumi\npreset: ba::日富美\nalso-as: [日富美]\n@end");
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::DirectiveBlock(block) = &doc.nodes[0] else {
            panic!("expected directive block");
        };
        assert_eq!(block.name, "actor");
        assert_eq!(block.head_args[0].raw, "hifumi");
        assert_eq!(block.items.len(), 2);
        assert!(matches!(
            &block.items[0],
            DirectiveItemSyntax::Field(field)
                if field.name == "preset" && field.value == "ba::日富美"
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
        let doc = parse_text("@actor hifumi\n@asset\n@end");

        assert_eq!(doc.diagnostics.len(), 2);
        assert!(
            doc.diagnostics[0]
                .message
                .contains("nested directive blocks")
        );
        assert!(
            doc.diagnostics[1]
                .message
                .contains("unterminated directive block")
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

    #[test]
    fn statement_fenced_body_protects_line_head_markers() {
        let doc =
            parse_text("> 柚子: \"\"\"\n@reply: 不应切出\n> 也不是新消息\n\"\"\"\n< 桃井: done");
        assert!(doc.diagnostics.is_empty());
        assert_eq!(doc.nodes.len(), 2);

        let SyntaxNode::Statement(statement) = &doc.nodes[0] else {
            panic!("expected statement");
        };
        assert_eq!(statement.body.source, "@reply: 不应切出\n> 也不是新消息\n");
        assert_eq!(statement.body.mode, BodyMode::Inherit);
    }

    #[test]
    fn body_modes_distinguish_inherited_and_explicit_fences() {
        let doc = parse_text(
            "> 柚子: plain\n\
             > 柚子: t\"\"\"text\"\"\"\n\
             > 柚子: T\"\"\"typst\"\"\"\n\
             > 柚子: rt\"\"\"raw text\"\"\"\n\
             > 柚子: rT\"\"\"raw typst\"\"\"",
        );
        assert!(doc.diagnostics.is_empty());

        let modes = doc
            .nodes
            .iter()
            .map(|node| match node {
                SyntaxNode::Statement(statement) => statement.body.mode,
                _ => panic!("expected statement"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            modes,
            vec![
                BodyMode::Inherit,
                BodyMode::TextMacro,
                BodyMode::TypstMacro,
                BodyMode::TextRaw,
                BodyMode::TypstRaw,
            ]
        );
    }

    #[test]
    fn mode_directive_does_not_change_syntax_body_mode() {
        let doc = parse_text("@mode: T\n> 柚子: [:ba::柚子/#1:]");
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::DirectiveLine(mode) = &doc.nodes[0] else {
            panic!("expected mode directive");
        };
        assert_eq!(mode.name, "mode");

        let SyntaxNode::Statement(statement) = &doc.nodes[1] else {
            panic!("expected statement");
        };
        assert_eq!(statement.body.mode, BodyMode::Inherit);
        assert!(matches!(
            statement.body.parts.as_slice(),
            [BodyPartSyntax::InlineMacro(_)]
        ));
    }

    #[test]
    fn longer_fences_can_contain_shorter_quote_runs() {
        let doc = parse_text("> 柚子: \"\"\"\"\n可以包含 \"\"\"\n\"\"\"\"");
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::Statement(statement) = &doc.nodes[0] else {
            panic!("expected statement");
        };
        assert_eq!(statement.body.source, "可以包含 \"\"\"\n");
    }

    #[test]
    fn reply_line_preserves_quoted_and_escaped_pipes() {
        let doc = parse_text("@reply: 是 | \"也许 | 之后\" | 不知道\\|算了");
        let SyntaxNode::Reply(reply) = &doc.nodes[0] else {
            panic!("expected reply");
        };

        assert_eq!(reply.items.len(), 3);
        assert_eq!(reply.items[0].source, "是");
        assert_eq!(reply.items[1].source, "\"也许 | 之后\"");
        assert_eq!(reply.items[2].source, "不知道\\|算了");
    }

    #[test]
    fn reply_block_uses_explicit_items_and_continuations() {
        let doc = parse_text("@reply\n- 12\n34\n- \"\"\"\n也许 | 之后再说\n\"\"\"\n@end");
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::Reply(reply) = &doc.nodes[0] else {
            panic!("expected reply block");
        };
        assert_eq!(reply.items.len(), 2);
        assert_eq!(reply.items[0].source, "12\n34");
        assert_eq!(reply.items[1].source, "也许 | 之后再说\n");
    }

    #[test]
    fn bond_line_and_block_parse_as_bond_nodes() {
        let doc = parse_text("@bond(pad: 1em): 羁绊\n@bond\n- 这不是列表\n@end");
        assert!(doc.diagnostics.is_empty());
        assert_eq!(doc.nodes.len(), 2);

        let SyntaxNode::Bond(first) = &doc.nodes[0] else {
            panic!("expected inline bond");
        };
        assert_eq!(first.body.source, "羁绊");
        assert_eq!(
            first.patch.as_ref().map(|patch| patch.raw_args.as_str()),
            Some("pad: 1em")
        );

        let SyntaxNode::Bond(second) = &doc.nodes[1] else {
            panic!("expected block bond");
        };
        assert_eq!(second.body.source, "- 这不是列表");
    }

    #[test]
    fn directive_block_header_patch_is_preserved() {
        let doc = parse_text("@actor(display: \"left\") hifumi\npreset: ba::日富美\n@end");
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::DirectiveBlock(block) = &doc.nodes[0] else {
            panic!("expected directive block");
        };
        assert_eq!(
            block.patch.as_ref().map(|patch| patch.raw_args.as_str()),
            Some("display: \"left\"")
        );
        assert_eq!(block.head_args[0].raw, "hifumi");
    }

    #[test]
    fn directive_head_arguments_preserve_quoted_spaces_and_escapes() {
        let doc = parse_text("@actor \"Alice Smith\" alias\\ name\n@end");
        assert!(doc.diagnostics.is_empty());

        let SyntaxNode::DirectiveBlock(block) = &doc.nodes[0] else {
            panic!("expected directive block");
        };
        assert_eq!(block.head_args.len(), 2);
        assert_eq!(block.head_args[0].raw, "\"Alice Smith\"");
        assert_eq!(block.head_args[1].raw, "alias\\ name");
    }

    #[test]
    fn unclosed_quoted_head_argument_reports_syntax_error() {
        let doc = parse_text("@actor \"Alice Smith\n@end");

        assert_eq!(doc.diagnostics.len(), 1);
        assert!(doc.diagnostics[0].message.contains("unclosed quoted"));
    }

    #[test]
    fn malformed_inline_macros_report_visible_diagnostics() {
        let doc = parse_text("> 柚子: [:foo\n> 桃井: [:#1:](width: 2em");

        assert_eq!(doc.diagnostics.len(), 2);
        assert!(doc.diagnostics[0].message.contains("unclosed inline macro"));
        assert!(
            doc.diagnostics[1]
                .message
                .contains("unclosed inline macro render patch")
        );
    }
}
