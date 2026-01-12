#[derive(Debug, Clone, PartialEq)]
pub enum Node {
    Statement(Statement),
    Directive(Directive),
    Continuation(Continuation),
    BlankLine(BlankLine),
    Block(Block),
    Comment(String),
    Empty,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Statement {
    pub kind: StatementKind,
    pub speaker: Option<String>, // "Name" in "> Name: Content"
    pub content: String,
    pub line_no: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StatementKind {
    Left,      // >
    Right,     // <
    Narration, // -
}

#[derive(Debug, Clone, PartialEq)]
pub struct Directive {
    pub name: String,
    pub payload: String,
    pub line_no: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BlankLine {
    pub line_no: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Continuation {
    pub text: String,
    pub line_no: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub kind: BlockKind,
    pub content: String, // Or structured content
    pub line_no: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub enum BlockKind {
    Reply,
    TripleQuote, // """
}
