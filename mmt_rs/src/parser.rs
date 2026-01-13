use crate::ast::*;

pub fn parse(input: &str) -> Vec<Node> {
    let mut nodes = Vec::new();
    let lines: Vec<&str> = input.lines().collect();
    let mut idx = 0;

    while idx < lines.len() {
        let line_no = idx + 1;
        let mut raw = lines[idx];
        if idx == 0 {
            raw = raw.trim_start_matches('\u{feff}');
        }

        let trimmed = raw.trim();
        if trimmed.is_empty() {
            nodes.push(Node::BlankLine(BlankLine { line_no }));
            idx += 1;
            continue;
        }

        let lstripped = raw.trim_start();
        if lstripped.starts_with("//") {
            idx += 1;
            continue;
        }

        let lowered = lstripped.to_lowercase();
        if lowered.starts_with("@reply:") {
            let payload = lstripped.splitn(2, ':').nth(1).unwrap_or("").trim();
            let items = split_reply_items(payload);
            if !items.is_empty() {
                nodes.push(Node::Reply(Reply { items, line_no }));
            }
            idx += 1;
            continue;
        }

        if lowered == "@reply" {
            let (items, next_idx) = parse_reply_block(&lines, idx + 1);
            if !items.is_empty() {
                nodes.push(Node::Reply(Reply { items, line_no }));
            }
            idx = next_idx;
            continue;
        }

        if lowered == "@end" {
            idx += 1;
            continue;
        }

        if lowered.starts_with("@bond") {
            let payload = lstripped.splitn(2, ':').nth(1).unwrap_or("").trim();
            if let Some((content, next_idx)) = parse_header_block(payload, &lines, idx) {
                nodes.push(Node::Bond(Bond { content, line_no }));
                idx = next_idx;
                continue;
            }
            nodes.push(Node::Bond(Bond {
                content: String::new(),
                line_no,
            }));
            idx += 1;
            continue;
        }

        if let Some(rest) = lstripped.strip_prefix('@') {
            let (name, payload) = if let Some((k, v)) = rest.split_once(':') {
                (k.trim(), v.trim())
            } else if let Some((k, v)) = rest.split_once(' ') {
                (k.trim(), v.trim())
            } else {
                (rest.trim(), "")
            };

            let mut payload_text = payload.to_string();
            let mut next_idx = idx + 1;
            if let Some((block_text, block_next)) = parse_header_block(payload, &lines, idx) {
                payload_text = block_text;
                next_idx = block_next;
            }

            nodes.push(Node::Directive(Directive {
                name: name.to_string(),
                payload: payload_text,
                line_no,
            }));
            idx = next_idx;
            continue;
        }

        let statement = if let Some(r) = lstripped.strip_prefix('>') {
            if r.chars().next().map(|c| c.is_whitespace()).unwrap_or(false) {
                Some((StatementKind::Left, r))
            } else {
                None
            }
        } else if let Some(r) = lstripped.strip_prefix('<') {
            if r.chars().next().map(|c| c.is_whitespace()).unwrap_or(false) {
                Some((StatementKind::Right, r))
            } else {
                None
            }
        } else if let Some(r) = lstripped.strip_prefix('-') {
            if r.chars().next().map(|c| c.is_whitespace()).unwrap_or(false) {
                Some((StatementKind::Narration, r))
            } else {
                None
            }
        } else {
            None
        };

        if let Some((kind, rest)) = statement {
            let rest = rest.trim_start();
            let (speaker, content) = match kind {
                StatementKind::Narration => (None, rest.trim().to_string()),
                _ => {
                    if let Some((s, c)) = split_top_level_colon(rest) {
                        (Some(s.trim().to_string()), c.trim().to_string())
                    } else {
                        (None, rest.trim().to_string())
                    }
                }
            };

            if let Some((block_text, next_idx)) = parse_triple_quote_block(&content, &lines, idx) {
                nodes.push(Node::Statement(Statement {
                    kind,
                    speaker,
                    content: block_text,
                    line_no,
                }));
                idx = next_idx;
                continue;
            }

            nodes.push(Node::Statement(Statement {
                kind,
                speaker,
                content,
                line_no,
            }));
            idx += 1;
            continue;
        }

        nodes.push(Node::Continuation(Continuation {
            text: lstripped.trim_end().to_string(),
            line_no,
        }));
        idx += 1;
    }

    nodes
}

fn split_reply_items(payload: &str) -> Vec<String> {
    payload
        .split('|')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn parse_reply_block(lines: &[&str], start_idx: usize) -> (Vec<String>, usize) {
    let mut items = Vec::new();
    let mut idx = start_idx;
    while idx < lines.len() {
        let trimmed = lines[idx].trim();
        if trimmed.is_empty() {
            idx += 1;
            continue;
        }
        if trimmed.eq_ignore_ascii_case("@end") {
            idx += 1;
            break;
        }
        if let Some((block_text, next_idx)) = parse_triple_quote_block(trimmed, lines, idx) {
            if !block_text.trim().is_empty() {
                items.push(block_text);
            }
            idx = next_idx;
            continue;
        }
        items.push(trimmed.to_string());
        idx += 1;
    }
    (items, idx)
}

fn parse_header_block(payload: &str, lines: &[&str], idx: usize) -> Option<(String, usize)> {
    let trimmed = payload.trim();
    if trimmed.is_empty() {
        if idx + 1 < lines.len() {
            let next_trimmed = lines[idx + 1].trim();
            if is_triple_quote_line(next_trimmed) {
                return parse_triple_quote_block(next_trimmed, lines, idx + 1);
            }
        }
        return Some((String::new(), idx + 1));
    }

    if is_triple_quote_line(trimmed) {
        return parse_triple_quote_block(trimmed, lines, idx);
    }
    Some((trimmed.to_string(), idx + 1))
}

fn is_triple_quote_line(s: &str) -> bool {
    let mut count = 0;
    for ch in s.chars() {
        if ch == '"' {
            count += 1;
        } else {
            break;
        }
    }
    count >= 3
}

fn parse_triple_quote_block(
    head: &str,
    lines: &[&str],
    start_idx: usize,
) -> Option<(String, usize)> {
    let trimmed = head.trim();
    let mut quote_len = 0;
    for ch in trimmed.chars() {
        if ch == '"' {
            quote_len += 1;
        } else {
            break;
        }
    }
    if quote_len < 3 {
        return None;
    }
    let delim: String = "\"".repeat(quote_len);
    let rest = trimmed[quote_len..].to_string();

    if let Some(end_pos) = rest.find(&delim) {
        let content = rest[..end_pos].to_string();
        return Some((content, start_idx + 1));
    }

    let mut out_lines = Vec::new();
    if !rest.trim().is_empty() {
        out_lines.push(rest.trim_end().to_string());
    }

    let mut idx = start_idx + 1;
    while idx < lines.len() {
        let line_trimmed = lines[idx].trim();
        if line_trimmed == delim {
            return Some((out_lines.join("\n"), idx + 1));
        }
        out_lines.push(lines[idx].to_string());
        idx += 1;
    }
    Some((out_lines.join("\n"), idx))
}

fn split_top_level_colon(s: &str) -> Option<(&str, &str)> {
    let mut depth_sq = 0;
    let mut depth_par = 0;
    let mut escaped = false;
    for (idx, ch) in s.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '[' {
            depth_sq += 1;
            continue;
        }
        if ch == ']' {
            if depth_sq > 0 {
                depth_sq -= 1;
            }
            continue;
        }
        if ch == '(' {
            depth_par += 1;
            continue;
        }
        if ch == ')' {
            if depth_par > 0 {
                depth_par -= 1;
            }
            continue;
        }
        if ch == ':' && depth_sq == 0 && depth_par == 0 {
            let head = &s[..idx];
            let tail = &s[idx + 1..];
            return Some((head, tail));
        }
    }
    None
}
