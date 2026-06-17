use crate::diag::Diagnostic;
use crate::inline::InlineMacroSyntax;
use crate::source::TextRange;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxDocument {
    pub nodes: Vec<SyntaxNode>,
    pub diagnostics: Vec<Diagnostic>,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyntaxNode {
    Statement(StatementSyntax),
    DirectiveLine(DirectiveLineSyntax),
    DirectiveBlock(DirectiveBlockSyntax),
    Reply(ReplySyntax),
    Bond(BondSyntax),
    Blank(BlankSyntax),
    Error(ErrorNode),
}

impl SyntaxNode {
    pub fn range(&self) -> TextRange {
        match self {
            SyntaxNode::Statement(node) => node.range,
            SyntaxNode::DirectiveLine(node) => node.range,
            SyntaxNode::DirectiveBlock(node) => node.range,
            SyntaxNode::Reply(node) => node.range,
            SyntaxNode::Bond(node) => node.range,
            SyntaxNode::Blank(node) => node.range,
            SyntaxNode::Error(node) => node.range,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StatementKind {
    Left,
    Right,
    Narration,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatementSyntax {
    pub kind: StatementKind,
    pub marker: Option<SpeakerMarkerSyntax>,
    pub patch: Option<PatchSyntax>,
    pub body: BodySyntax,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpeakerMarkerSyntax {
    Explicit { raw: String, range: TextRange },
    BackRef { n: u32, range: TextRange },
    UniqueIndex { n: u32, range: TextRange },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchSyntax {
    pub raw_args: String,
    pub range: TextRange,
    pub args_range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodySyntax {
    pub mode: BodyMode,
    pub source: String,
    pub range: TextRange,
    pub parts: Vec<BodyPartSyntax>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BodyMode {
    TextMacro,
    TypstMacro,
    TextRaw,
    TypstRaw,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BodyPartSyntax {
    Text { source: String, range: TextRange },
    InlineMacro(InlineMacroSyntax),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectiveLineSyntax {
    pub name: String,
    pub name_range: TextRange,
    pub payload: Option<BodySyntax>,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectiveBlockSyntax {
    pub name: String,
    pub name_range: TextRange,
    pub head_args: Vec<LiteralSyntax>,
    pub patch: Option<PatchSyntax>,
    pub items: Vec<DirectiveItemSyntax>,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DirectiveItemSyntax {
    Field(FieldSyntax),
    Body(BodySyntax),
    Error(ErrorNode),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldSyntax {
    pub name: String,
    pub name_range: TextRange,
    pub value: String,
    pub value_range: TextRange,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiteralSyntax {
    pub raw: String,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplySyntax {
    pub items: Vec<BodySyntax>,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BondSyntax {
    pub body: BodySyntax,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlankSyntax {
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ErrorNode {
    pub message: String,
    pub source: String,
    pub range: TextRange,
}
