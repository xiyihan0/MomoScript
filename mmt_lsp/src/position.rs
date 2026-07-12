use lsp_types::{Position, PositionEncodingKind, Range};
use mmt_rs::source::TextRange;

#[derive(Debug, Clone)]
pub struct LineIndex {
    line_starts: Vec<usize>,
    text_len: usize,
}

impl LineIndex {
    pub fn new(text: &str) -> Self {
        let mut line_starts = vec![0];
        for (offset, ch) in text.char_indices() {
            if ch == '\n' {
                line_starts.push(offset + 1);
            }
        }
        Self {
            line_starts,
            text_len: text.len(),
        }
    }

    pub fn position(
        &self,
        text: &str,
        offset: usize,
        encoding: &PositionEncodingKind,
    ) -> Option<Position> {
        if offset > self.text_len || !text.is_char_boundary(offset) {
            return None;
        }
        let line = match self.line_starts.binary_search(&offset) {
            Ok(line) => line,
            Err(next) => next.saturating_sub(1),
        };
        let line_start = self.line_starts[line];
        let line_end = self
            .line_starts
            .get(line + 1)
            .copied()
            .unwrap_or(self.text_len);
        let line_with_ending = &text[line_start..line_end];
        let line_text = line_with_ending
            .strip_suffix('\n')
            .unwrap_or(line_with_ending);
        let line_text = line_text.strip_suffix('\r').unwrap_or(line_text);
        let content_end = line_start + line_text.len();
        let normalized_offset = offset.min(content_end);
        let prefix = &text[line_start..normalized_offset];
        let character = if *encoding == PositionEncodingKind::UTF8 {
            prefix.len()
        } else {
            prefix.encode_utf16().count()
        };
        Some(Position::new(line as u32, character as u32))
    }

    pub fn offset(
        &self,
        text: &str,
        position: Position,
        encoding: &PositionEncodingKind,
    ) -> Option<usize> {
        let line = position.line as usize;
        let line_start = *self.line_starts.get(line)?;
        let line_end = self
            .line_starts
            .get(line + 1)
            .copied()
            .unwrap_or(self.text_len);
        let line_with_ending = &text[line_start..line_end];
        let line_text = line_with_ending
            .strip_suffix('\n')
            .unwrap_or(line_with_ending);
        let line_text = line_text.strip_suffix('\r').unwrap_or(line_text);
        let content_end = line_start + line_text.len();
        let target = position.character as usize;
        if *encoding == PositionEncodingKind::UTF8 {
            let offset = line_start.checked_add(target)?;
            return (offset <= content_end && text.is_char_boundary(offset)).then_some(offset);
        }

        let mut utf16 = 0;
        for (byte, ch) in line_text.char_indices() {
            if utf16 == target {
                return Some(line_start + byte);
            }
            utf16 += ch.len_utf16();
            if utf16 > target {
                return None;
            }
        }
        (utf16 == target).then_some(content_end)
    }

    pub fn range(
        &self,
        text: &str,
        range: TextRange,
        encoding: &PositionEncodingKind,
    ) -> Option<Range> {
        Some(Range::new(
            self.position(text, range.start, encoding)?,
            self.position(text, range.end, encoding)?,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_round_trips_chinese_and_supplementary_characters() {
        let text = "甲😀乙\nabc";
        let index = LineIndex::new(text);
        for offset in [0, "甲".len(), "甲😀".len(), "甲😀乙".len(), text.len()] {
            let position = index
                .position(text, offset, &PositionEncodingKind::UTF16)
                .unwrap();
            assert_eq!(
                index.offset(text, position, &PositionEncodingKind::UTF16),
                Some(offset)
            );
        }
        assert_eq!(
            index.offset(text, Position::new(0, 2), &PositionEncodingKind::UTF16),
            None,
            "position inside the emoji surrogate pair must be rejected"
        );
    }

    #[test]
    fn utf8_rejects_offsets_inside_codepoints() {
        let text = "晴";
        let index = LineIndex::new(text);
        assert_eq!(
            index.offset(text, Position::new(0, 1), &PositionEncodingKind::UTF8),
            None
        );
        assert_eq!(
            index.offset(text, Position::new(0, 3), &PositionEncodingKind::UTF8),
            Some(3)
        );
    }

    #[test]
    fn positions_cannot_cross_a_line_ending() {
        let text = "abc\r\ndef";
        let index = LineIndex::new(text);
        assert_eq!(
            index.offset(text, Position::new(0, 3), &PositionEncodingKind::UTF16),
            Some(3)
        );
        assert_eq!(
            index.offset(text, Position::new(0, 4), &PositionEncodingKind::UTF16),
            None
        );
        assert_eq!(
            index.position(text, 3, &PositionEncodingKind::UTF16),
            Some(Position::new(0, 3))
        );
        assert_eq!(
            index.position(text, 4, &PositionEncodingKind::UTF16),
            Some(Position::new(0, 3))
        );
    }
}
