//! Lossless, transport-independent Composer document projection.

use crate::composer::{
    ComposerStatementDescription, analysis_has_errors, current_avatar_for_revision,
    describe_composer_statement, serialize_scalar,
};
use crate::identity::canonical_bytes_digest;
use crate::pack::PackRegistry;
use crate::pipeline::{AnalyzedDocument, analyze_text, analyze_text_with_pack};
use crate::semantic::CharacterPresetCatalog;
use crate::source::TextRange;
use crate::syntax::{DirectiveItemSyntax, StatementKind, SyntaxNode};

pub const COMPOSER_DOCUMENT_DIGEST_DOMAIN: &str = "mmt-composer-document-v1";
pub const COMPOSER_NODE_KEY_DOMAIN: &str = "mmt-composer-node-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerDocumentNodeKind {
    Message,
    Narration,
    Opaque,
}

impl ComposerDocumentNodeKind {
    fn canonical_name(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Narration => "narration",
            Self::Opaque => "opaque",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerMessageSide {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerOpaqueCategory {
    Blank,
    Comment,
    Directive,
    RecoverableError,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerNodeRef {
    pub node_key: String,
    pub node_kind: ComposerDocumentNodeKind,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerBoundaryTarget {
    pub before: Option<ComposerNodeRef>,
    pub after: Option<ComposerNodeRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerSpeakerSource {
    ScriptActor,
    PackEntity,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerInsertCapability {
    pub boundary: ComposerBoundaryTarget,
    pub message_sides: Vec<ComposerMessageSide>,
    pub statement_modes: Vec<crate::composer::StatementTextMode>,
    pub speaker_sources: Vec<ComposerSpeakerSource>,
    pub narration: bool,
    pub eol: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerBoundary {
    pub target: ComposerBoundaryTarget,
    pub insert: Option<ComposerInsertCapability>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ComposerMessageCapabilities {
    pub set_body: bool,
    pub set_continued: bool,
    pub set_display_name: bool,
    pub set_avatar: bool,
    pub set_speaker: bool,
    pub delete: bool,
    pub move_up: Option<ComposerBoundaryTarget>,
    pub move_down: Option<ComposerBoundaryTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ComposerNarrationCapabilities {
    pub set_body: bool,
    pub delete: bool,
    pub move_up: Option<ComposerBoundaryTarget>,
    pub move_down: Option<ComposerBoundaryTarget>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerMessageNode {
    pub node_key: String,
    pub range: TextRange,
    pub statement_range: TextRange,
    pub side: ComposerMessageSide,
    pub description: ComposerStatementDescription,
    pub capabilities: ComposerMessageCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerNarrationNode {
    pub node_key: String,
    pub range: TextRange,
    pub statement_range: TextRange,
    pub description: ComposerStatementDescription,
    pub capabilities: ComposerNarrationCapabilities,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerOpaqueNode {
    pub node_key: String,
    pub range: TextRange,
    pub category: ComposerOpaqueCategory,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerDocumentNode {
    Message(ComposerMessageNode),
    Narration(ComposerNarrationNode),
    Opaque(ComposerOpaqueNode),
}

impl ComposerDocumentNode {
    pub fn node_ref(&self) -> ComposerNodeRef {
        match self {
            Self::Message(node) => ComposerNodeRef {
                node_key: node.node_key.clone(),
                node_kind: ComposerDocumentNodeKind::Message,
                range: node.range,
            },
            Self::Narration(node) => ComposerNodeRef {
                node_key: node.node_key.clone(),
                node_kind: ComposerDocumentNodeKind::Narration,
                range: node.range,
            },
            Self::Opaque(node) => ComposerNodeRef {
                node_key: node.node_key.clone(),
                node_kind: ComposerDocumentNodeKind::Opaque,
                range: node.range,
            },
        }
    }

    pub fn range(&self) -> TextRange {
        match self {
            Self::Message(node) => node.range,
            Self::Narration(node) => node.range,
            Self::Opaque(node) => node.range,
        }
    }

    pub fn kind(&self) -> ComposerDocumentNodeKind {
        match self {
            Self::Message(_) => ComposerDocumentNodeKind::Message,
            Self::Narration(_) => ComposerDocumentNodeKind::Narration,
            Self::Opaque(_) => ComposerDocumentNodeKind::Opaque,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerScriptActorChoice {
    pub reference: String,
    pub display_name: String,
    pub primary_name: String,
    pub preset_id: String,
    pub avatar: Option<crate::composer::ComposerAvatarCurrent>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerDocumentProjection {
    pub source_digest: String,
    pub nodes: Vec<ComposerDocumentNode>,
    pub boundaries: Vec<ComposerBoundary>,
    pub script_actor_choices: Vec<ComposerScriptActorChoice>,
    pub has_errors: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerDocumentProjectionError {
    InvalidSyntaxRange,
    InvalidPartition,
}

#[derive(Debug, Clone, Copy)]
struct PhysicalLine {
    start: usize,
    content_end: usize,
    line_end: usize,
}

pub fn composer_document_source_digest(source: &str) -> String {
    canonical_bytes_digest(COMPOSER_DOCUMENT_DIGEST_DOMAIN, &[source.as_bytes()])
}

pub fn project_composer_document(
    source: &str,
    catalog: &impl CharacterPresetCatalog,
) -> Result<ComposerDocumentProjection, ComposerDocumentProjectionError> {
    let analysis = analyze_text(source, catalog);
    project_analyzed_composer_document(source, &analysis)
}

pub fn project_composer_document_with_pack(
    source: &str,
    packs: &PackRegistry,
) -> Result<ComposerDocumentProjection, ComposerDocumentProjectionError> {
    let analysis = analyze_text_with_pack(source, packs);
    project_analyzed_composer_document(source, &analysis)
}

pub fn project_analyzed_composer_document(
    source: &str,
    analysis: &AnalyzedDocument,
) -> Result<ComposerDocumentProjection, ComposerDocumentProjectionError> {
    if analysis.document.range != TextRange::new(0, source.len()) {
        return Err(ComposerDocumentProjectionError::InvalidSyntaxRange);
    }
    let source_digest = composer_document_source_digest(source);
    let lines = physical_lines(source);
    let mut drafts = Vec::with_capacity(analysis.document.nodes.len().saturating_add(2));
    let mut cursor = 0;

    if source.starts_with('\u{feff}') {
        let bom_end = '\u{feff}'.len_utf8();
        drafts.push(NodeDraft::Opaque {
            range: TextRange::new(0, bom_end),
            category: ComposerOpaqueCategory::Unsupported,
        });
        cursor = bom_end;
    }

    for syntax_node in &analysis.document.nodes {
        let syntax_range = syntax_node.range();
        if syntax_range.start > syntax_range.end
            || syntax_range.end > source.len()
            || !source.is_char_boundary(syntax_range.start)
            || !source.is_char_boundary(syntax_range.end)
        {
            return Err(ComposerDocumentProjectionError::InvalidSyntaxRange);
        }
        let node_start = syntax_range.start.max(cursor);
        if cursor < node_start {
            drafts.push(NodeDraft::Opaque {
                range: TextRange::new(cursor, node_start),
                category: ComposerOpaqueCategory::Unsupported,
            });
        }
        if syntax_range.end < cursor || (syntax_range.end == cursor && syntax_range.start < cursor)
        {
            continue;
        }
        let node_end = line_end_for_offset(&lines, syntax_range.end)
            .unwrap_or(syntax_range.end)
            .max(syntax_range.end);
        if node_end < node_start || node_end > source.len() {
            return Err(ComposerDocumentProjectionError::InvalidSyntaxRange);
        }
        let range = TextRange::new(node_start, node_end);
        drafts.push(match syntax_node {
            SyntaxNode::Statement(statement) => match statement.kind {
                StatementKind::Left => NodeDraft::Message {
                    range,
                    statement_range: statement.range,
                    side: ComposerMessageSide::Left,
                    description: describe_composer_statement(analysis, statement),
                },
                StatementKind::Right => NodeDraft::Message {
                    range,
                    statement_range: statement.range,
                    side: ComposerMessageSide::Right,
                    description: describe_composer_statement(analysis, statement),
                },
                StatementKind::Narration => NodeDraft::Narration {
                    range,
                    statement_range: statement.range,
                    description: describe_composer_statement(analysis, statement),
                },
            },
            SyntaxNode::Blank(_) => NodeDraft::Opaque {
                range,
                category: ComposerOpaqueCategory::Blank,
            },
            SyntaxNode::DirectiveLine(_) => NodeDraft::Opaque {
                range,
                category: ComposerOpaqueCategory::Directive,
            },
            SyntaxNode::DirectiveBlock(block) => NodeDraft::Opaque {
                range,
                category: if block
                    .items
                    .iter()
                    .any(|item| matches!(item, DirectiveItemSyntax::Error(_)))
                {
                    ComposerOpaqueCategory::RecoverableError
                } else {
                    ComposerOpaqueCategory::Directive
                },
            },
            SyntaxNode::Error(_) => NodeDraft::Opaque {
                range,
                category: ComposerOpaqueCategory::RecoverableError,
            },
            SyntaxNode::Reply(_) | SyntaxNode::Bond(_) => NodeDraft::Opaque {
                range,
                category: ComposerOpaqueCategory::Unsupported,
            },
        });
        cursor = node_end;
    }

    if cursor < source.len() {
        drafts.push(NodeDraft::Opaque {
            range: TextRange::new(cursor, source.len()),
            category: ComposerOpaqueCategory::Unsupported,
        });
    }

    drafts = split_trailing_statement_blanks(source, drafts);
    validate_partition(source, &drafts)?;
    let has_errors = analysis_has_errors(analysis);
    let mut nodes = drafts
        .into_iter()
        .map(|draft| draft.finish(&source_digest, has_errors))
        .collect::<Vec<_>>();
    let run_eols = movable_run_eols(source, &nodes);
    if !has_errors {
        authorize_node_capabilities(&mut nodes, &run_eols);
    }
    let boundaries = build_boundaries(source, &nodes, has_errors);
    let script_actor_choices = if has_errors {
        Vec::new()
    } else {
        script_actor_choices(analysis)
    };

    Ok(ComposerDocumentProjection {
        source_digest,
        nodes,
        boundaries,
        script_actor_choices,
        has_errors,
    })
}

#[derive(Debug)]
enum NodeDraft {
    Message {
        range: TextRange,
        statement_range: TextRange,
        side: ComposerMessageSide,
        description: ComposerStatementDescription,
    },
    Narration {
        range: TextRange,
        statement_range: TextRange,
        description: ComposerStatementDescription,
    },
    Opaque {
        range: TextRange,
        category: ComposerOpaqueCategory,
    },
}

impl NodeDraft {
    fn range(&self) -> TextRange {
        match self {
            Self::Message { range, .. }
            | Self::Narration { range, .. }
            | Self::Opaque { range, .. } => *range,
        }
    }

    fn kind(&self) -> ComposerDocumentNodeKind {
        match self {
            Self::Message { .. } => ComposerDocumentNodeKind::Message,
            Self::Narration { .. } => ComposerDocumentNodeKind::Narration,
            Self::Opaque { .. } => ComposerDocumentNodeKind::Opaque,
        }
    }
    fn set_range(&mut self, updated: TextRange) {
        match self {
            Self::Message { range, .. }
            | Self::Narration { range, .. }
            | Self::Opaque { range, .. } => *range = updated,
        }
    }

    fn finish(self, source_digest: &str, has_errors: bool) -> ComposerDocumentNode {
        let range = self.range();
        let key = composer_node_key(source_digest, self.kind(), range);
        match self {
            Self::Message {
                statement_range,
                side,
                description,
                ..
            } => {
                let capabilities = if has_errors {
                    ComposerMessageCapabilities::default()
                } else {
                    ComposerMessageCapabilities {
                        set_body: description.statement_text.is_some(),
                        set_continued: description.continued.is_some(),
                        set_display_name: description.actor_display_name.is_some(),
                        set_avatar: description.actor_avatar.is_some(),
                        set_speaker: matches!(
                            description.speaker,
                            Some(crate::composer::ComposerSpeakerDescription::Actor { .. })
                        ),
                        delete: true,
                        move_up: None,
                        move_down: None,
                    }
                };
                ComposerDocumentNode::Message(ComposerMessageNode {
                    node_key: key,
                    range,
                    statement_range,
                    side,
                    description,
                    capabilities,
                })
            }
            Self::Narration {
                statement_range,
                description,
                ..
            } => {
                let set_body = !has_errors && description.statement_text.is_some();
                ComposerDocumentNode::Narration(ComposerNarrationNode {
                    node_key: key,
                    range,
                    statement_range,
                    capabilities: if has_errors {
                        ComposerNarrationCapabilities::default()
                    } else {
                        ComposerNarrationCapabilities {
                            set_body,
                            delete: true,
                            move_up: None,
                            move_down: None,
                        }
                    },
                    description,
                })
            }
            Self::Opaque { category, .. } => ComposerDocumentNode::Opaque(ComposerOpaqueNode {
                node_key: key,
                range,
                category,
            }),
        }
    }
}

fn split_trailing_statement_blanks(source: &str, drafts: Vec<NodeDraft>) -> Vec<NodeDraft> {
    let mut partitioned = Vec::with_capacity(drafts.len());
    for mut draft in drafts {
        let editable_statement = match &draft {
            NodeDraft::Message { description, .. } | NodeDraft::Narration { description, .. } => {
                description.statement_text.is_some()
            }
            NodeDraft::Opaque { .. } => false,
        };
        let range = draft.range();
        if !editable_statement || range.end > source.len() {
            partitioned.push(draft);
            continue;
        }
        let bytes = source[range.start..range.end].as_bytes();
        let mut cursor = bytes.len();
        let mut endings = Vec::new();
        while cursor > 0 {
            let start = if cursor >= 2 && &bytes[cursor - 2..cursor] == b"\r\n" {
                cursor - 2
            } else if bytes[cursor - 1] == b'\n' {
                cursor - 1
            } else {
                break;
            };
            endings.push(TextRange::new(range.start + start, range.start + cursor));
            cursor = start;
        }
        endings.reverse();
        if endings.len() <= 1 {
            partitioned.push(draft);
            continue;
        }
        draft.set_range(TextRange::new(range.start, endings[1].start));
        partitioned.push(draft);
        partitioned.extend(endings.into_iter().skip(1).map(|blank| NodeDraft::Opaque {
            range: blank,
            category: ComposerOpaqueCategory::Blank,
        }));
    }
    partitioned
}

fn composer_node_key(
    source_digest: &str,
    kind: ComposerDocumentNodeKind,
    range: TextRange,
) -> String {
    let start = range.start.to_string();
    let end = range.end.to_string();
    canonical_bytes_digest(
        COMPOSER_NODE_KEY_DOMAIN,
        &[
            source_digest.as_bytes(),
            kind.canonical_name().as_bytes(),
            start.as_bytes(),
            end.as_bytes(),
        ],
    )
}

fn physical_lines(source: &str) -> Vec<PhysicalLine> {
    let mut lines = Vec::new();
    let mut start = 0;
    while start < source.len() {
        let remainder = &source[start..];
        if let Some(relative_newline) = remainder.find('\n') {
            let newline = start + relative_newline;
            let content_end = if newline > start && source.as_bytes()[newline - 1] == b'\r' {
                newline - 1
            } else {
                newline
            };
            lines.push(PhysicalLine {
                start,
                content_end,
                line_end: newline + 1,
            });
            start = newline + 1;
        } else {
            lines.push(PhysicalLine {
                start,
                content_end: source.len(),
                line_end: source.len(),
            });
            break;
        }
    }
    lines
}

fn line_end_for_offset(lines: &[PhysicalLine], offset: usize) -> Option<usize> {
    lines
        .iter()
        .find(|line| line.start <= offset && offset <= line.content_end)
        .map(|line| line.line_end)
}

fn validate_partition(
    source: &str,
    nodes: &[NodeDraft],
) -> Result<(), ComposerDocumentProjectionError> {
    if source.is_empty() {
        return if nodes.is_empty() {
            Ok(())
        } else {
            Err(ComposerDocumentProjectionError::InvalidPartition)
        };
    }
    if nodes.first().map(NodeDraft::range).map(|range| range.start) != Some(0)
        || nodes.last().map(NodeDraft::range).map(|range| range.end) != Some(source.len())
    {
        return Err(ComposerDocumentProjectionError::InvalidPartition);
    }
    for (index, node) in nodes.iter().enumerate() {
        let range = node.range();
        if range.is_empty()
            || !source.is_char_boundary(range.start)
            || !source.is_char_boundary(range.end)
            || (range.end > 0
                && range.end < source.len()
                && source.as_bytes()[range.end - 1] == b'\r'
                && source.as_bytes()[range.end] == b'\n')
        {
            return Err(ComposerDocumentProjectionError::InvalidPartition);
        }
        if index > 0 && nodes[index - 1].range().end != range.start {
            return Err(ComposerDocumentProjectionError::InvalidPartition);
        }
    }
    Ok(())
}

fn node_terminator<'a>(source: &'a str, node: &ComposerDocumentNode) -> Option<&'a str> {
    let range = node.range();
    let bytes = source.as_bytes();
    if range.end >= 2 && &bytes[range.end - 2..range.end] == b"\r\n" {
        Some("\r\n")
    } else if range.end >= 1 && bytes[range.end - 1] == b'\n' {
        Some("\n")
    } else {
        None
    }
}

fn movable_run_eols(source: &str, nodes: &[ComposerDocumentNode]) -> Vec<Option<String>> {
    let mut result = vec![None; nodes.len()];
    let mut index = 0;
    while index < nodes.len() {
        if nodes[index].kind() == ComposerDocumentNodeKind::Opaque {
            index += 1;
            continue;
        }
        let start = index;
        while index < nodes.len() && nodes[index].kind() != ComposerDocumentNodeKind::Opaque {
            index += 1;
        }
        let end = index;
        let mut style: Option<&str> = None;
        let mut valid = true;
        for node in &nodes[start..end] {
            if let Some(eol) = node_terminator(source, node) {
                if style.is_some_and(|current| current != eol) {
                    valid = false;
                    break;
                }
                style = Some(eol);
            }
        }
        if valid && style.is_some() {
            for slot in &mut result[start..end] {
                *slot = style.map(str::to_owned);
            }
        }
    }
    result
}

fn boundary_target(nodes: &[ComposerDocumentNode], index: usize) -> ComposerBoundaryTarget {
    ComposerBoundaryTarget {
        before: index
            .checked_sub(1)
            .map(|previous| nodes[previous].node_ref()),
        after: nodes.get(index).map(ComposerDocumentNode::node_ref),
    }
}

fn authorize_node_capabilities(nodes: &mut [ComposerDocumentNode], run_eols: &[Option<String>]) {
    let refs = nodes
        .iter()
        .map(ComposerDocumentNode::node_ref)
        .collect::<Vec<_>>();
    for index in 0..nodes.len() {
        if run_eols[index].is_none() {
            continue;
        }
        let movable_before =
            index > 0 && refs[index - 1].node_kind != ComposerDocumentNodeKind::Opaque;
        let movable_after =
            index + 1 < refs.len() && refs[index + 1].node_kind != ComposerDocumentNodeKind::Opaque;
        let move_up = movable_before.then(|| ComposerBoundaryTarget {
            before: index.checked_sub(2).map(|previous| refs[previous].clone()),
            after: Some(refs[index - 1].clone()),
        });
        let move_down = movable_after.then(|| ComposerBoundaryTarget {
            before: Some(refs[index + 1].clone()),
            after: refs.get(index + 2).cloned(),
        });
        match &mut nodes[index] {
            ComposerDocumentNode::Message(node) => {
                node.capabilities.move_up = move_up;
                node.capabilities.move_down = move_down;
            }
            ComposerDocumentNode::Narration(node) => {
                node.capabilities.move_up = move_up;
                node.capabilities.move_down = move_down;
            }
            ComposerDocumentNode::Opaque(_) => {}
        }
    }
}

fn build_boundaries(
    source: &str,
    nodes: &[ComposerDocumentNode],
    has_errors: bool,
) -> Vec<ComposerBoundary> {
    (0..=nodes.len())
        .map(|index| {
            let target = boundary_target(nodes, index);
            let eol = if nodes.is_empty() {
                Some("\n")
            } else {
                let mut styles = Vec::with_capacity(2);
                if let Some(before) = index.checked_sub(1).and_then(|item| nodes.get(item)) {
                    if let Some(style) = node_terminator(source, before) {
                        styles.push(style);
                    }
                }
                if let Some(after) = nodes.get(index) {
                    if let Some(style) = node_terminator(source, after) {
                        styles.push(style);
                    }
                }
                styles.sort_unstable();
                styles.dedup();
                styles.first().copied().filter(|_| styles.len() == 1)
            };
            let insert =
                (!has_errors)
                    .then_some(eol)
                    .flatten()
                    .map(|eol| ComposerInsertCapability {
                        boundary: target.clone(),
                        message_sides: vec![ComposerMessageSide::Left, ComposerMessageSide::Right],
                        statement_modes: vec![
                            crate::composer::StatementTextMode::Inherit,
                            crate::composer::StatementTextMode::TextMacro,
                            crate::composer::StatementTextMode::TextRaw,
                            crate::composer::StatementTextMode::TypstMacro,
                            crate::composer::StatementTextMode::TypstRaw,
                        ],
                        speaker_sources: vec![
                            ComposerSpeakerSource::ScriptActor,
                            ComposerSpeakerSource::PackEntity,
                        ],
                        narration: true,
                        eol: eol.to_owned(),
                    });
            ComposerBoundary { target, insert }
        })
        .collect()
}

fn script_actor_choices(analysis: &AnalyzedDocument) -> Vec<ComposerScriptActorChoice> {
    analysis
        .actors
        .actors
        .iter()
        .filter_map(|actor| {
            let declared_in_script = analysis.document.nodes.iter().any(|node| {
                let SyntaxNode::DirectiveBlock(block) = node else {
                    return false;
                };
                block.name == "actor"
                    && actor
                        .revisions
                        .iter()
                        .any(|revision| revision.origin == block.range)
            });
            if !declared_in_script || serialize_scalar(&actor.primary_name, None).is_none() {
                return None;
            }
            let revision = actor.revisions.last()?;
            let avatar = current_avatar_for_revision(analysis, actor.id, revision.number).flatten();
            Some(ComposerScriptActorChoice {
                reference: actor.primary_name.clone(),
                display_name: revision.state.display_name.clone(),
                primary_name: actor.primary_name.clone(),
                preset_id: actor.preset_id.clone(),
                avatar,
            })
        })
        .collect()
}
