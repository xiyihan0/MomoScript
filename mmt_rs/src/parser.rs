use crate::ast::*;

pub fn parse(input: &str) -> Vec<Node> {
    let mut nodes = Vec::new();

    for (idx, line) in input.lines().enumerate() {
        let line_no = idx + 1;
        let mut raw = line;
        if idx == 0 {
            raw = raw.trim_start_matches('\u{feff}');
        }

        let trimmed = raw.trim();
        if trimmed.is_empty() {
            nodes.push(Node::BlankLine(BlankLine { line_no }));
            continue;
        }

        let lstripped = raw.trim_start();
        if lstripped.starts_with("//") {
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

            nodes.push(Node::Directive(Directive {
                name: name.to_string(),
                payload: payload.to_string(),
                line_no,
            }));
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

            nodes.push(Node::Statement(Statement {
                kind,
                speaker,
                content,
                line_no,
            }));
            continue;
        }

        nodes.push(Node::Continuation(Continuation {
            text: lstripped.trim_end().to_string(),
            line_no,
        }));
    }

    nodes
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
