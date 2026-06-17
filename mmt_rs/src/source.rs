#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}

impl TextRange {
    pub fn new(start: usize, end: usize) -> Self {
        assert!(start <= end, "text range start must not exceed end");
        Self { start, end }
    }

    pub fn empty(offset: usize) -> Self {
        Self {
            start: offset,
            end: offset,
        }
    }

    pub fn len(self) -> usize {
        self.end - self.start
    }

    pub fn is_empty(self) -> bool {
        self.start == self.end
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineColumn {
    pub line: usize,
    pub column: usize,
}

#[derive(Debug, Clone)]
pub struct SourceFile {
    path: Option<String>,
    text: String,
    line_starts: Vec<usize>,
}

impl SourceFile {
    pub fn anonymous(text: impl Into<String>) -> Self {
        Self::new(None, text)
    }

    pub fn new(path: Option<String>, text: impl Into<String>) -> Self {
        let text = text.into();
        let mut line_starts = vec![0];
        for (offset, ch) in text.char_indices() {
            if ch == '\n' {
                line_starts.push(offset + ch.len_utf8());
            }
        }
        Self {
            path,
            text,
            line_starts,
        }
    }

    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn range(&self) -> TextRange {
        TextRange::new(0, self.text.len())
    }

    pub fn line_column(&self, byte_offset: usize) -> Option<LineColumn> {
        if byte_offset > self.text.len() || !self.text.is_char_boundary(byte_offset) {
            return None;
        }

        let line_index = match self.line_starts.binary_search(&byte_offset) {
            Ok(index) => index,
            Err(index) => index.saturating_sub(1),
        };
        let line_start = self.line_starts[line_index];
        let prefix = &self.text[line_start..byte_offset];
        Some(LineColumn {
            line: line_index + 1,
            column: prefix.chars().count() + 1,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_utf8_byte_offsets_to_line_columns() {
        let source = SourceFile::anonymous("一二\nabc\n");

        assert_eq!(
            source.line_column(0),
            Some(LineColumn { line: 1, column: 1 })
        );
        assert_eq!(
            source.line_column("一".len()),
            Some(LineColumn { line: 1, column: 2 })
        );
        assert_eq!(
            source.line_column("一二\n".len()),
            Some(LineColumn { line: 2, column: 1 })
        );
    }

    #[test]
    fn rejects_offsets_inside_utf8_codepoints() {
        let source = SourceFile::anonymous("晴");

        assert_eq!(source.line_column(1), None);
        assert_eq!(source.line_column(4), None);
    }
}
