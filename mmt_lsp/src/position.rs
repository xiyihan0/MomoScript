use std::fmt;

use lsp_types::{Position, PositionEncodingKind, Range};
use mmt_rs::source::TextRange;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PositionEncoding {
    #[serde(rename = "utf-8")]
    Utf8,
    #[serde(rename = "utf-16")]
    Utf16,
}

impl PositionEncoding {
    pub fn from_lsp(encoding: &PositionEncodingKind) -> Result<Self, PositionConversionError> {
        if *encoding == PositionEncodingKind::UTF8 {
            Ok(Self::Utf8)
        } else if *encoding == PositionEncodingKind::UTF16 {
            Ok(Self::Utf16)
        } else {
            Err(PositionConversionError::AmbiguousEncoding)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MmtClientPosition(Position);

impl MmtClientPosition {
    pub fn new(position: Position) -> Self {
        Self(position)
    }

    pub fn into_lsp(self) -> Position {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TinymistBackendPosition(Position);

impl TinymistBackendPosition {
    pub fn new(position: Position) -> Self {
        Self(position)
    }

    pub fn into_lsp(self) -> Position {
        self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Utf8ByteOffset(usize);

impl Utf8ByteOffset {
    pub fn get(self) -> usize {
        self.0
    }
    pub(crate) fn new(offset: usize) -> Self {
        Self(offset)
    }

}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Utf8ByteRange {
    pub start: Utf8ByteOffset,
    pub end: Utf8ByteOffset,
}

impl Utf8ByteRange {
    pub fn new(start: Utf8ByteOffset, end: Utf8ByteOffset) -> Result<Self, PositionConversionError> {
        if start > end {
            return Err(PositionConversionError::InvalidRange);
        }
        Ok(Self { start, end })
    }

    pub fn into_text_range(self) -> TextRange {
        TextRange::new(self.start.get(), self.end.get())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PositionConversionError {
    InvalidLine,
    InvalidCharacter,
    SplitUtf8CodePoint,
    SplitUtf16Surrogate,
    InvalidRange,
    AbsentGeneration,
    StaleProjection,
    ProjectionMismatch,
    AmbiguousGeneration,
    AmbiguousEncoding,
    AmbiguousMapping,
}

impl fmt::Display for PositionConversionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?}")
    }
}

impl std::error::Error for PositionConversionError {}

#[derive(Debug, Clone)]
struct Line {
    start: usize,
    content_end: usize,
    /// Valid scalar boundaries as (UTF-8 bytes from line start, UTF-16 code units).
    boundaries: Vec<(usize, usize)>,
}

#[derive(Debug, Clone)]
pub struct LineIndex {
    lines: Vec<Line>,
    text_len: usize,
}

impl LineIndex {
    pub fn new(text: &str) -> Self {
        let mut starts = vec![0];
        for (offset, ch) in text.char_indices() {
            if ch == '\n' {
                starts.push(offset + 1);
            }
        }
        let lines = starts
            .iter()
            .enumerate()
            .map(|(line, start)| {
                let end = starts.get(line + 1).copied().unwrap_or(text.len());
                let with_ending = &text[*start..end];
                let without_lf = with_ending.strip_suffix('\n').unwrap_or(with_ending);
                let content = without_lf.strip_suffix('\r').unwrap_or(without_lf);
                let mut boundaries = Vec::with_capacity(content.chars().count() + 1);
                let mut utf16 = 0;
                boundaries.push((0, 0));
                for (byte, ch) in content.char_indices() {
                    utf16 += ch.len_utf16();
                    boundaries.push((byte + ch.len_utf8(), utf16));
                }
                Line {
                    start: *start,
                    content_end: *start + content.len(),
                    boundaries,
                }
            })
            .collect();
        Self { lines, text_len: text.len() }
    }

    fn checked_position(
        &self,
        offset: Utf8ByteOffset,
        encoding: PositionEncoding,
    ) -> Result<Position, PositionConversionError> {
        let offset = offset.get();
        if offset > self.text_len {
            return Err(PositionConversionError::InvalidCharacter);
        }
        let line_number = match self.lines.binary_search_by_key(&offset, |line| line.start) {
            Ok(line) => line,
            Err(next) => next.saturating_sub(1),
        };
        let line = self.lines.get(line_number).ok_or(PositionConversionError::InvalidLine)?;
        if offset > line.content_end {
            return Err(PositionConversionError::InvalidCharacter);
        }
        let byte = offset - line.start;
        let (_, utf16) = line
            .boundaries
            .iter()
            .find(|(boundary, _)| *boundary == byte)
            .ok_or(PositionConversionError::SplitUtf8CodePoint)?;
        let character = match encoding {
            PositionEncoding::Utf8 => byte,
            PositionEncoding::Utf16 => *utf16,
        };
        Ok(Position::new(line_number as u32, character as u32))
    }

    fn checked_offset(
        &self,
        position: Position,
        encoding: PositionEncoding,
    ) -> Result<Utf8ByteOffset, PositionConversionError> {
        let line = self
            .lines
            .get(position.line as usize)
            .ok_or(PositionConversionError::InvalidLine)?;
        let target = position.character as usize;
        match encoding {
            PositionEncoding::Utf8 => {
                if target > line.content_end - line.start {
                    return Err(PositionConversionError::InvalidCharacter);
                }
                if line.boundaries.iter().any(|(byte, _)| *byte == target) {
                    Ok(Utf8ByteOffset(line.start + target))
                } else {
                    Err(PositionConversionError::SplitUtf8CodePoint)
                }
            }
            PositionEncoding::Utf16 => line
                .boundaries
                .iter()
                .find(|(_, utf16)| *utf16 == target)
                .map(|(byte, _)| Utf8ByteOffset(line.start + byte))
                .ok_or_else(|| {
                    let max = line.boundaries.last().map_or(0, |(_, utf16)| *utf16);
                    if target < max {
                        PositionConversionError::SplitUtf16Surrogate
                    } else {
                        PositionConversionError::InvalidCharacter
                    }
                }),
        }
    }

    pub fn mmt_offset(
        &self,
        position: MmtClientPosition,
        encoding: PositionEncoding,
    ) -> Result<Utf8ByteOffset, PositionConversionError> {
        self.checked_offset(position.into_lsp(), encoding)
    }

    pub fn backend_offset(
        &self,
        position: TinymistBackendPosition,
        encoding: PositionEncoding,
    ) -> Result<Utf8ByteOffset, PositionConversionError> {
        self.checked_offset(position.into_lsp(), encoding)
    }

    pub fn mmt_position(
        &self,
        offset: Utf8ByteOffset,
        encoding: PositionEncoding,
    ) -> Result<MmtClientPosition, PositionConversionError> {
        self.checked_position(offset, encoding).map(MmtClientPosition::new)
    }

    pub fn backend_position(
        &self,
        offset: Utf8ByteOffset,
        encoding: PositionEncoding,
    ) -> Result<TinymistBackendPosition, PositionConversionError> {
        self.checked_position(offset, encoding).map(TinymistBackendPosition::new)
    }

    pub fn backend_range(
        &self,
        range: Range,
        encoding: PositionEncoding,
    ) -> Result<Utf8ByteRange, PositionConversionError> {
        Utf8ByteRange::new(
            self.backend_offset(TinymistBackendPosition::new(range.start), encoding)?,
            self.backend_offset(TinymistBackendPosition::new(range.end), encoding)?,
        )
    }

    pub fn mmt_range(
        &self,
        range: Utf8ByteRange,
        encoding: PositionEncoding,
    ) -> Result<Range, PositionConversionError> {
        Ok(Range::new(
            self.mmt_position(range.start, encoding)?.into_lsp(),
            self.mmt_position(range.end, encoding)?.into_lsp(),
        ))
    }

    // Non-projected language-service compatibility. Projection boundaries use the typed methods above.
    pub fn position(&self, text: &str, offset: usize, encoding: &PositionEncodingKind) -> Option<Position> {
        (text.len() == self.text_len)
            .then_some(())
            .and_then(|()| PositionEncoding::from_lsp(encoding).ok())
            .and_then(|encoding| self.checked_position(Utf8ByteOffset(offset), encoding).ok())
    }

    pub fn offset(&self, text: &str, position: Position, encoding: &PositionEncodingKind) -> Option<usize> {
        (text.len() == self.text_len)
            .then_some(())
            .and_then(|()| PositionEncoding::from_lsp(encoding).ok())
            .and_then(|encoding| self.checked_offset(position, encoding).ok())
            .map(Utf8ByteOffset::get)
    }

    pub fn range(&self, text: &str, range: TextRange, encoding: &PositionEncodingKind) -> Option<Range> {
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
    fn all_domains_round_trip_chinese_combining_and_astral_boundaries() {
        let text = "中文 e\u{301} 😀\r\n下一行";
        let index = LineIndex::new(text);
        let offsets = text
            .char_indices()
            .map(|(offset, _)| offset)
            .chain(std::iter::once(text.len()))
            .filter(|offset| !matches!(text.as_bytes().get(*offset), Some(b'\r' | b'\n')));
        for offset in offsets {
            let byte = Utf8ByteOffset(offset);
            for encoding in [PositionEncoding::Utf8, PositionEncoding::Utf16] {
                let client = index.mmt_position(byte, encoding).unwrap();
                assert_eq!(index.mmt_offset(client, encoding).unwrap(), byte);
                let backend = index.backend_position(byte, encoding).unwrap();
                assert_eq!(index.backend_offset(backend, encoding).unwrap(), byte);
            }
        }
    }

    #[test]
    fn invalid_utf_boundaries_and_line_endings_are_rejected_without_clamping() {
        let text = "晴😀\r\n";
        let index = LineIndex::new(text);
        assert_eq!(
            index.mmt_offset(MmtClientPosition::new(Position::new(0, 1)), PositionEncoding::Utf8),
            Err(PositionConversionError::SplitUtf8CodePoint)
        );
        assert_eq!(
            index.backend_offset(TinymistBackendPosition::new(Position::new(0, 2)), PositionEncoding::Utf16),
            Err(PositionConversionError::SplitUtf16Surrogate)
        );
        assert_eq!(
            index.checked_position(Utf8ByteOffset("晴😀".len() + 1), PositionEncoding::Utf16),
            Err(PositionConversionError::InvalidCharacter)
        );
        assert_eq!(
            PositionEncoding::from_lsp(&PositionEncodingKind::UTF32),
            Err(PositionConversionError::AmbiguousEncoding)
        );
    }
}
