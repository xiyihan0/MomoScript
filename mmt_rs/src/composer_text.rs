//! Snapshot-authorized, grapheme-safe body selections and atomic text edits.

use unicode_segmentation::UnicodeSegmentation;

use crate::composer::{
    COMPOSER_STATEMENT_TEXT_MAX_BYTES, ComposerSourceEdit, ComposerStatementDescription,
    analysis_has_errors, fenced_body_envelope, markers_equal, text_edit_semantics_stable,
};
use crate::composer_document::{
    ComposerDocumentNode, ComposerDocumentProjection, ComposerNodeRef, ComposerOpaqueCategory,
    composer_document_source_digest, project_analyzed_composer_document,
};
use crate::composer_structure::same_node_exact_and_semantic;
use crate::emit::{EmittedTypst, Origin, OriginKind};
use crate::pack::PackRegistry;
use crate::pipeline::{AnalyzedDocument, analyze_text, analyze_text_with_pack};
use crate::semantic::{CharacterPresetCatalog, ResolvedBodyMode};
use crate::source::TextRange;
use crate::syntax::{BodyMode, BodyPartSyntax, StatementSyntax, SyntaxNode};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerTextEditing {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerTextEndpoint {
    pub node: ComposerNodeRef,
    pub offset_utf16: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerTextSelection {
    pub anchor: ComposerTextEndpoint,
    pub focus: ComposerTextEndpoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerTextFailure {
    StaleDocument,
    TargetChanged,
    DocumentHasErrors,
    InvalidValue,
    UnsupportedStructure,
    CandidateInvalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedComposerTextSelection {
    pub selection: ComposerTextSelection,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerTextEditEndpointAfter {
    pub statement_range: TextRange,
    pub offset_utf16: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerTextEdit {
    pub edits: Vec<ComposerSourceEdit>,
    pub source_digest_after: String,
    pub selection_after: (ComposerTextEditEndpointAfter, ComposerTextEditEndpointAfter),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedComposerTextProjection {
    pub anchor: TextRange,
    pub focus: TextRange,
    pub segments: Vec<TextRange>,
}

struct BodyText<'a> {
    statement: &'a StatementSyntax,
    range: TextRange,
    raw: &'a str,
    text: String,
    mode: ResolvedBodyMode,
    eol: Option<&'static str>,
    mixed_eol: bool,
}

struct SelectedBody<'a> {
    index: usize,
    body: BodyText<'a>,
}

struct AuthorizedSelection<'a> {
    bodies: Vec<SelectedBody<'a>>,
    first_byte: usize,
    last_byte: usize,
}

pub(crate) fn describe_composer_text(
    source: &str,
    analysis: &AnalyzedDocument,
    statement_range: TextRange,
    node_range: TextRange,
) -> Option<ComposerTextEditing> {
    let body = body_text(source, analysis, statement_range, node_range).ok()?;
    Some(ComposerTextEditing { text: body.text })
}

/// Reads a previously authorized semantic selection without deriving identity
/// from body text. The returned selection retains its anchor/focus direction.
pub fn read_composer_text_selection(
    source: &str,
    analysis: &AnalyzedDocument,
    source_digest: &str,
    selection: &ComposerTextSelection,
) -> Result<ResolvedComposerTextSelection, ComposerTextFailure> {
    let projection = authorized_projection(source, analysis, source_digest)?;
    let selected = authorize_selection(source, analysis, &projection, selection)?;
    Ok(ResolvedComposerTextSelection {
        selection: selection.clone(),
        text: selected_text(&selected),
    })
}

/// Authored positions are collapsed, exact body boundaries, not statement hits.
pub fn resolve_composer_text_selection(
    source: &str,
    analysis: &AnalyzedDocument,
    source_digest: &str,
    anchor: TextRange,
    focus: TextRange,
) -> Result<ResolvedComposerTextSelection, ComposerTextFailure> {
    let projection = authorized_projection(source, analysis, source_digest)?;
    let selection = ComposerTextSelection {
        anchor: endpoint_from_authored(source, analysis, &projection, anchor)?,
        focus: endpoint_from_authored(source, analysis, &projection, focus)?,
    };
    let selected = authorize_selection(source, analysis, &projection, &selection)?;
    Ok(ResolvedComposerTextSelection {
        text: selected_text(&selected),
        selection,
    })
}

pub fn compose_text_edit(
    source: &str,
    analysis: &AnalyzedDocument,
    catalog: &impl CharacterPresetCatalog,
    source_digest: &str,
    selection: &ComposerTextSelection,
    replacement: &str,
) -> Result<ComposerTextEdit, ComposerTextFailure> {
    compose_text_edit_using(
        source,
        analysis,
        source_digest,
        selection,
        replacement,
        |candidate| analyze_text(candidate, catalog),
    )
}

pub fn compose_text_edit_with_pack(
    source: &str,
    analysis: &AnalyzedDocument,
    packs: &PackRegistry,
    source_digest: &str,
    selection: &ComposerTextSelection,
    replacement: &str,
) -> Result<ComposerTextEdit, ComposerTextFailure> {
    compose_text_edit_using(
        source,
        analysis,
        source_digest,
        selection,
        replacement,
        |candidate| analyze_text_with_pack(candidate, packs),
    )
}

fn compose_text_edit_using(
    source: &str,
    analysis: &AnalyzedDocument,
    source_digest: &str,
    selection: &ComposerTextSelection,
    replacement: &str,
    analyze_candidate: impl FnOnce(&str) -> AnalyzedDocument,
) -> Result<ComposerTextEdit, ComposerTextFailure> {
    let projection = authorized_projection(source, analysis, source_digest)?;
    let selected = authorize_selection(source, analysis, &projection, selection)?;
    if selected
        .bodies
        .iter()
        .any(|selected| selected.body.mixed_eol)
    {
        return Err(ComposerTextFailure::UnsupportedStructure);
    }
    let first = &selected.bodies[0];
    let last = selected
        .bodies
        .last()
        .ok_or(ComposerTextFailure::TargetChanged)?;
    let replacement = normalize_eols(replacement).0;
    let length = selected
        .first_byte
        .checked_add(replacement.len())
        .and_then(|length| length.checked_add(last.body.text.len() - selected.last_byte))
        .ok_or(ComposerTextFailure::InvalidValue)?;
    if length > COMPOSER_STATEMENT_TEXT_MAX_BYTES {
        return Err(ComposerTextFailure::InvalidValue);
    }
    let mut expected = String::with_capacity(length);
    expected.push_str(&first.body.text[..selected.first_byte]);
    expected.push_str(&replacement);
    expected.push_str(&last.body.text[selected.last_byte..]);
    if first.index == last.index && expected == first.body.text {
        return Err(ComposerTextFailure::InvalidValue);
    }
    let offset_after = first.body.text[..selected.first_byte]
        .encode_utf16()
        .count()
        + replacement.encode_utf16().count();
    semantic_byte(&expected, offset_after).map_err(|_| ComposerTextFailure::CandidateInvalid)?;

    let eol = first
        .body
        .eol
        .or_else(|| node_terminator(source, &projection.nodes[first.index]))
        .or_else(|| first_terminator(source))
        .unwrap_or("\n");
    let raw_start =
        raw_byte(first.body.raw, selected.first_byte).ok_or(ComposerTextFailure::TargetChanged)?;
    let raw_end =
        raw_byte(last.body.raw, selected.last_byte).ok_or(ComposerTextFailure::TargetChanged)?;
    let mut raw = String::with_capacity(length);
    raw.push_str(&first.body.raw[..raw_start]);
    if eol == "\n" {
        raw.push_str(&replacement);
    } else {
        for character in replacement.chars() {
            if character == '\n' {
                raw.push_str(eol);
            } else {
                raw.push(character);
            }
        }
    }
    raw.push_str(&last.body.raw[raw_end..]);
    if raw.len() > COMPOSER_STATEMENT_TEXT_MAX_BYTES {
        return Err(ComposerTextFailure::InvalidValue);
    }
    if normalize_eols(&raw).2 {
        return Err(ComposerTextFailure::UnsupportedStructure);
    }

    let mut edits = Vec::with_capacity(selected.bodies.len() + 1);
    edits.push(serialize_body_edit(source, &first.body, &raw, eol)?);
    for selected in selected.bodies.iter().skip(1) {
        edits.push(ComposerSourceEdit {
            range: projection.nodes[selected.index].range(),
            new_text: String::new(),
        });
    }
    // A merge into the final statement must not accidentally add a final EOL.
    // Intermediate opaque blanks are never consumed to reconcile it.
    if first.index != last.index && projection.nodes[last.index].range().end == source.len() {
        let before_final = final_terminator(source);
        let first_final = node_terminator(source, &projection.nodes[first.index]);
        let has_blanks = projection.nodes[first.index + 1..last.index]
            .iter()
            .any(|node| matches!(node, ComposerDocumentNode::Opaque(_)));
        if has_blanks && before_final.is_none() {
            return Err(ComposerTextFailure::CandidateInvalid);
        }
        if !has_blanks && before_final != first_final {
            let end = projection.nodes[first.index].range().end;
            edits.push(ComposerSourceEdit {
                range: TextRange::new(end - first_final.map_or(0, str::len), end),
                new_text: before_final.unwrap_or("").to_owned(),
            });
        }
    }
    edits.sort_by_key(|edit| (edit.range.start, edit.range.end));
    let candidate_source = apply_edits(source, &edits)?;
    let candidate = analyze_candidate(&candidate_source);
    if analysis_has_errors(&candidate) || !text_edit_semantics_stable(analysis, &candidate) {
        return Err(ComposerTextFailure::CandidateInvalid);
    }
    let after = project_analyzed_composer_document(&candidate_source, &candidate)
        .map_err(|_| ComposerTextFailure::CandidateInvalid)?;
    if after.has_errors
        || final_terminator(source) != final_terminator(&candidate_source)
        || !prove_candidate(
            source,
            &projection,
            &selected,
            &candidate_source,
            &candidate,
            &after,
            &expected,
        )
    {
        return Err(ComposerTextFailure::CandidateInvalid);
    }
    let statement_range =
        statement_range(&after.nodes[first.index]).ok_or(ComposerTextFailure::CandidateInvalid)?;
    let endpoint = ComposerTextEditEndpointAfter {
        statement_range,
        offset_utf16: offset_after,
    };
    Ok(ComposerTextEdit {
        edits,
        source_digest_after: after.source_digest,
        selection_after: (endpoint.clone(), endpoint),
    })
}

fn authorized_projection(
    source: &str,
    analysis: &AnalyzedDocument,
    source_digest: &str,
) -> Result<ComposerDocumentProjection, ComposerTextFailure> {
    if composer_document_source_digest(source) != source_digest {
        return Err(ComposerTextFailure::StaleDocument);
    }
    if analysis_has_errors(analysis) {
        return Err(ComposerTextFailure::DocumentHasErrors);
    }
    project_analyzed_composer_document(source, analysis)
        .map_err(|_| ComposerTextFailure::TargetChanged)
}

fn statement_range(node: &ComposerDocumentNode) -> Option<TextRange> {
    match node {
        ComposerDocumentNode::Message(node) => Some(node.statement_range),
        ComposerDocumentNode::Narration(node) => Some(node.statement_range),
        ComposerDocumentNode::Opaque(_) => None,
    }
}

fn statement_at(analysis: &AnalyzedDocument, range: TextRange) -> Option<&StatementSyntax> {
    let mut matches = analysis
        .document
        .nodes
        .iter()
        .filter_map(|node| match node {
            SyntaxNode::Statement(statement) if statement.range == range => Some(statement),
            _ => None,
        });
    let result = matches.next()?;
    matches.next().is_none().then_some(result)
}

fn body_text<'a>(
    source: &'a str,
    analysis: &'a AnalyzedDocument,
    statement_range: TextRange,
    node_range: TextRange,
) -> Result<BodyText<'a>, ComposerTextFailure> {
    let statement =
        statement_at(analysis, statement_range).ok_or(ComposerTextFailure::TargetChanged)?;
    if source.get(statement.body.range.start..statement.body.range.end)
        != Some(statement.body.source.as_str())
    {
        return Err(ComposerTextFailure::TargetChanged);
    }
    let mut modes = analysis
        .modes
        .bodies
        .iter()
        .filter(|mode| mode.range == statement.body.range);
    let mode = modes.next().ok_or(ComposerTextFailure::TargetChanged)?.mode;
    if modes.next().is_some() {
        return Err(ComposerTextFailure::TargetChanged);
    }
    if !matches!(
        mode,
        ResolvedBodyMode::TextMacro | ResolvedBodyMode::TextRaw
    ) || (mode == ResolvedBodyMode::TextMacro
        && statement
            .body
            .parts
            .iter()
            .any(|part| matches!(part, BodyPartSyntax::InlineMacro(_))))
    {
        return Err(ComposerTextFailure::UnsupportedStructure);
    }
    let mut range = statement.body.range;
    if range.end >= node_range.end {
        let owned = source
            .get(node_range.start..node_range.end)
            .ok_or(ComposerTextFailure::TargetChanged)?;
        let terminator = final_terminator(owned).map_or(0, str::len);
        range.end = range.end.min(node_range.end - terminator);
    }
    if range.start < node_range.start || range.start > range.end {
        return Err(ComposerTextFailure::TargetChanged);
    }
    let raw = source
        .get(range.start..range.end)
        .ok_or(ComposerTextFailure::TargetChanged)?;
    let (text, eol, mixed_eol) = normalize_eols(raw);
    if text.len() > COMPOSER_STATEMENT_TEXT_MAX_BYTES
        || raw.len() > COMPOSER_STATEMENT_TEXT_MAX_BYTES
    {
        return Err(ComposerTextFailure::UnsupportedStructure);
    }
    Ok(BodyText {
        statement,
        range,
        raw,
        text,
        mode,
        eol,
        mixed_eol,
    })
}

fn node_body<'a>(
    source: &'a str,
    analysis: &'a AnalyzedDocument,
    node: &ComposerDocumentNode,
) -> Result<BodyText<'a>, ComposerTextFailure> {
    if node.text_editing().is_none() {
        return Err(ComposerTextFailure::UnsupportedStructure);
    }
    body_text(
        source,
        analysis,
        statement_range(node).ok_or(ComposerTextFailure::UnsupportedStructure)?,
        node.range(),
    )
}

fn endpoint_from_authored(
    source: &str,
    analysis: &AnalyzedDocument,
    projection: &ComposerDocumentProjection,
    authored: TextRange,
) -> Result<ComposerTextEndpoint, ComposerTextFailure> {
    if !authored.is_empty()
        || authored.start > source.len()
        || !source.is_char_boundary(authored.start)
    {
        return Err(ComposerTextFailure::InvalidValue);
    }
    let mut endpoint = None;
    for node in &projection.nodes {
        if node.text_editing().is_none() {
            continue;
        }
        let body = node_body(source, analysis, node)?;
        if authored.start < body.range.start || authored.start > body.range.end {
            continue;
        }
        let raw_offset = authored.start - body.range.start;
        let semantic =
            semantic_offset(body.raw, raw_offset).ok_or(ComposerTextFailure::InvalidValue)?;
        let offset_utf16 = body.text[..semantic].encode_utf16().count();
        semantic_byte(&body.text, offset_utf16)?;
        if endpoint.is_some() {
            return Err(ComposerTextFailure::TargetChanged);
        }
        endpoint = Some(ComposerTextEndpoint {
            node: node.node_ref(),
            offset_utf16,
        });
    }
    endpoint.ok_or(ComposerTextFailure::UnsupportedStructure)
}

fn endpoint_index(
    projection: &ComposerDocumentProjection,
    endpoint: &ComposerTextEndpoint,
) -> Result<usize, ComposerTextFailure> {
    let mut matches = projection
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.node_ref() == endpoint.node);
    let index = matches.next().ok_or(ComposerTextFailure::TargetChanged)?.0;
    if matches.next().is_some() {
        return Err(ComposerTextFailure::TargetChanged);
    }
    Ok(index)
}

fn authorize_selection<'a>(
    source: &'a str,
    analysis: &'a AnalyzedDocument,
    projection: &ComposerDocumentProjection,
    selection: &ComposerTextSelection,
) -> Result<AuthorizedSelection<'a>, ComposerTextFailure> {
    let anchor = endpoint_index(projection, &selection.anchor)?;
    let focus = endpoint_index(projection, &selection.focus)?;
    let (first, first_offset, last, last_offset) =
        if (anchor, selection.anchor.offset_utf16) <= (focus, selection.focus.offset_utf16) {
            (
                anchor,
                selection.anchor.offset_utf16,
                focus,
                selection.focus.offset_utf16,
            )
        } else {
            (
                focus,
                selection.focus.offset_utf16,
                anchor,
                selection.anchor.offset_utf16,
            )
        };
    let first_body = node_body(source, analysis, &projection.nodes[first])?;
    let first_byte = semantic_byte(&first_body.text, first_offset)?;
    let mode = first_body.mode;
    let mut bodies = vec![SelectedBody {
        index: first,
        body: first_body,
    }];
    for index in first + 1..=last {
        match &projection.nodes[index] {
            ComposerDocumentNode::Opaque(node)
                if node.category == ComposerOpaqueCategory::Blank && index != last =>
            {
                continue;
            }
            node => {
                let body = node_body(source, analysis, node)?;
                if body.mode != mode {
                    return Err(ComposerTextFailure::UnsupportedStructure);
                }
                bodies.push(SelectedBody { index, body });
            }
        }
    }
    let last_byte = semantic_byte(
        &bodies
            .last()
            .ok_or(ComposerTextFailure::TargetChanged)?
            .body
            .text,
        last_offset,
    )?;
    Ok(AuthorizedSelection {
        bodies,
        first_byte,
        last_byte,
    })
}

fn selected_text(selected: &AuthorizedSelection<'_>) -> String {
    let mut text = String::new();
    for (index, selected_body) in selected.bodies.iter().enumerate() {
        if index != 0 {
            text.push('\n');
        }
        let start = if index == 0 { selected.first_byte } else { 0 };
        let end = if index + 1 == selected.bodies.len() {
            selected.last_byte
        } else {
            selected_body.body.text.len()
        };
        text.push_str(&selected_body.body.text[start..end]);
    }
    text
}

fn semantic_byte(text: &str, offset_utf16: usize) -> Result<usize, ComposerTextFailure> {
    let mut utf16 = 0;
    let mut byte = None;
    for (offset, character) in text.char_indices() {
        if utf16 == offset_utf16 {
            byte = Some(offset);
            break;
        }
        utf16 += character.len_utf16();
    }
    if byte.is_none() && utf16 == offset_utf16 {
        byte = Some(text.len());
    }
    let byte = byte.ok_or(ComposerTextFailure::InvalidValue)?;
    if byte == text.len()
        || text
            .grapheme_indices(true)
            .any(|(boundary, _)| boundary == byte)
    {
        Ok(byte)
    } else {
        Err(ComposerTextFailure::InvalidValue)
    }
}

fn normalize_eols(raw: &str) -> (String, Option<&'static str>, bool) {
    let mut text = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    let mut eol = None;
    let mut mixed = false;
    while let Some(character) = chars.next() {
        let ending = match character {
            '\r' if chars.peek() == Some(&'\n') => {
                chars.next();
                Some("\r\n")
            }
            '\r' => Some("\r"),
            '\n' => Some("\n"),
            _ => None,
        };
        if let Some(ending) = ending {
            mixed |= eol.is_some_and(|previous| previous != ending);
            eol.get_or_insert(ending);
            text.push('\n');
        } else {
            text.push(character);
        }
    }
    (text, eol, mixed)
}

// Both maps walk Unicode scalars, treating CRLF as one semantic LF. Neither
// direction admits a boundary between CR and LF or inside a UTF-8 scalar.
fn eol_boundary(raw: &str, target: usize, inverse: bool) -> Option<usize> {
    let mut physical = 0;
    let mut semantic = 0;
    loop {
        if target == if inverse { physical } else { semantic } {
            return Some(if inverse { semantic } else { physical });
        }
        let remaining = raw.get(physical..)?;
        let character = remaining.chars().next()?;
        if remaining.starts_with("\r\n") {
            physical += 2;
            semantic += 1;
        } else {
            physical += character.len_utf8();
            semantic += character.len_utf8();
        }
    }
}

fn raw_byte(raw: &str, semantic_byte: usize) -> Option<usize> {
    eol_boundary(raw, semantic_byte, false)
}

fn semantic_offset(raw: &str, raw_byte: usize) -> Option<usize> {
    eol_boundary(raw, raw_byte, true)
}

fn final_terminator(source: &str) -> Option<&'static str> {
    if source.ends_with("\r\n") {
        Some("\r\n")
    } else if source.ends_with('\n') {
        Some("\n")
    } else {
        None
    }
}

fn first_terminator(source: &str) -> Option<&'static str> {
    let offset = source.find('\n')?;
    Some(if offset > 0 && source.as_bytes()[offset - 1] == b'\r' {
        "\r\n"
    } else {
        "\n"
    })
}

fn node_terminator(source: &str, node: &ComposerDocumentNode) -> Option<&'static str> {
    final_terminator(source.get(node.range().start..node.range().end)?)
}

fn serialize_body_edit(
    source: &str,
    body: &BodyText<'_>,
    raw: &str,
    eol: &str,
) -> Result<ComposerSourceEdit, ComposerTextFailure> {
    let fenced = fenced_body_envelope(body.statement, source)
        .map_err(|_| ComposerTextFailure::TargetChanged)?;
    if fenced.is_none() && !raw.is_empty() {
        let mut probe = source[body.statement.range.start..body.range.start].to_owned();
        probe.push_str(raw);
        let parsed = crate::parse_text(&probe);
        if let [SyntaxNode::Statement(candidate)] = parsed.nodes.as_slice() {
            if parsed.diagnostics.is_empty()
                && candidate.kind == body.statement.kind
                && markers_equal(candidate.marker.as_ref(), body.statement.marker.as_ref())
                && candidate.patch.as_ref().map(|patch| &patch.raw_args)
                    == body.statement.patch.as_ref().map(|patch| &patch.raw_args)
                && candidate.body.mode == body.statement.body.mode
                && candidate.body.source == raw
            {
                return Ok(ComposerSourceEdit {
                    range: body.range,
                    new_text: raw.to_owned(),
                });
            }
        }
    }
    let fence_length = raw
        .split(|character| character != '"')
        .map(str::len)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
        .max(3);
    let fence = "\"".repeat(fence_length);
    let prefix = match body.statement.body.mode {
        BodyMode::Inherit => "",
        BodyMode::TextMacro => "t",
        BodyMode::TextRaw => "rt",
        BodyMode::TypstMacro | BodyMode::TypstRaw => {
            return Err(ComposerTextFailure::UnsupportedStructure);
        }
    };
    Ok(ComposerSourceEdit {
        range: fenced.map_or(body.range, |(range, _)| range),
        new_text: format!("{prefix}{fence}{eol}{raw}{fence}"),
    })
}

fn apply_edits(source: &str, edits: &[ComposerSourceEdit]) -> Result<String, ComposerTextFailure> {
    let mut result = String::with_capacity(source.len());
    let mut cursor = 0;
    for edit in edits {
        if edit.range.start < cursor || edit.range.start > edit.range.end {
            return Err(ComposerTextFailure::CandidateInvalid);
        }
        result.push_str(
            source
                .get(cursor..edit.range.start)
                .ok_or(ComposerTextFailure::CandidateInvalid)?,
        );
        result.push_str(&edit.new_text);
        source
            .get(edit.range.start..edit.range.end)
            .ok_or(ComposerTextFailure::CandidateInvalid)?;
        cursor = edit.range.end;
    }
    result.push_str(
        source
            .get(cursor..)
            .ok_or(ComposerTextFailure::CandidateInvalid)?,
    );
    Ok(result)
}

fn description(node: &ComposerDocumentNode) -> Option<&ComposerStatementDescription> {
    match node {
        ComposerDocumentNode::Message(node) => Some(&node.description),
        ComposerDocumentNode::Narration(node) => Some(&node.description),
        ComposerDocumentNode::Opaque(_) => None,
    }
}

fn prove_candidate(
    source: &str,
    before: &ComposerDocumentProjection,
    selected: &AuthorizedSelection<'_>,
    candidate_source: &str,
    candidate: &AnalyzedDocument,
    after: &ComposerDocumentProjection,
    expected: &str,
) -> bool {
    if before.nodes.len() + 1 != after.nodes.len() + selected.bodies.len() {
        return false;
    }
    let first = &selected.bodies[0];
    let removed = &selected.bodies[1..];
    let mut after_index = 0;
    for (index, before_node) in before.nodes.iter().enumerate() {
        if removed.iter().any(|removed| removed.index == index) {
            continue;
        }
        let Some(after_node) = after.nodes.get(after_index) else {
            return false;
        };
        after_index += 1;
        if index != first.index {
            if !same_node_exact_and_semantic(source, before_node, candidate_source, after_node) {
                return false;
            }
            continue;
        }
        let Ok(body) = node_body(candidate_source, candidate, after_node) else {
            return false;
        };
        let (Some(before_description), Some(after_description)) =
            (description(before_node), description(after_node))
        else {
            return false;
        };
        if body.text != expected
            || body.statement.kind != first.body.statement.kind
            || body.statement.body.mode != first.body.statement.body.mode
            || body.mode != first.body.mode
            || !markers_equal(
                body.statement.marker.as_ref(),
                first.body.statement.marker.as_ref(),
            )
            || body.statement.patch.as_ref().map(|patch| &patch.raw_args)
                != first
                    .body
                    .statement
                    .patch
                    .as_ref()
                    .map(|patch| &patch.raw_args)
            || before_description.body.inherited_mode != after_description.body.inherited_mode
            || before_description.speaker != after_description.speaker
            || before_description.continued != after_description.continued
            || before_description.actor_display_name != after_description.actor_display_name
            || before_description.actor_avatar != after_description.actor_avatar
        {
            return false;
        }
    }
    after_index == after.nodes.len()
}

/// Projects reversible body fragments without crossing Typst wrappers.
/// Line breaks paint their exact preceding caret, not a nonexistent glyph.
pub fn project_composer_text_selection(
    source: &str,
    analysis: &AnalyzedDocument,
    emitted: &EmittedTypst,
    selection: &ComposerTextSelection,
) -> Result<ResolvedComposerTextProjection, ComposerTextFailure> {
    project_text_selection(source, analysis, emitted, selection, true)
}

fn project_text_selection(
    source: &str,
    analysis: &AnalyzedDocument,
    emitted: &EmittedTypst,
    selection: &ComposerTextSelection,
    paint_line_breaks: bool,
) -> Result<ResolvedComposerTextProjection, ComposerTextFailure> {
    let projection =
        authorized_projection(source, analysis, &composer_document_source_digest(source))?;
    let selected = authorize_selection(source, analysis, &projection, selection)?;
    let endpoint = |endpoint: &ComposerTextEndpoint| -> Result<TextRange, ComposerTextFailure> {
        let index = endpoint_index(&projection, endpoint)?;
        let body = selected
            .bodies
            .iter()
            .find(|body| body.index == index)
            .ok_or(ComposerTextFailure::TargetChanged)?;
        let semantic = semantic_byte(&body.body.text, endpoint.offset_utf16)?;
        let authored = body.body.range.start
            + raw_byte(body.body.raw, semantic).ok_or(ComposerTextFailure::TargetChanged)?;
        Ok(TextRange::empty(project_caret(
            source, emitted, &body.body, authored,
        )?))
    };
    let anchor = endpoint(&selection.anchor)?;
    let focus = endpoint(&selection.focus)?;
    let mut segments = Vec::new();
    for (index, selected_body) in selected.bodies.iter().enumerate() {
        let body = &selected_body.body;
        let start = if index == 0 { selected.first_byte } else { 0 };
        let end = if index + 1 == selected.bodies.len() {
            selected.last_byte
        } else {
            body.text.len()
        };
        let raw_start = body.range.start
            + raw_byte(body.raw, start).ok_or(ComposerTextFailure::TargetChanged)?;
        let raw_end =
            body.range.start + raw_byte(body.raw, end).ok_or(ComposerTextFailure::TargetChanged)?;
        project_segments(
            source,
            emitted,
            body,
            TextRange::new(raw_start, raw_end),
            selection.anchor != selection.focus,
            paint_line_breaks,
            &mut segments,
        )?;
    }
    Ok(ResolvedComposerTextProjection {
        anchor,
        focus,
        segments,
    })
}

fn project_caret(
    source: &str,
    emitted: &EmittedTypst,
    body: &BodyText<'_>,
    authored: usize,
) -> Result<usize, ComposerTextFailure> {
    let mut mapped: Option<(u8, usize)> = None;
    for entry in &emitted.source_map {
        let Some(range) = emitted.exact_text_origin(source, entry) else {
            continue;
        };
        if range.start < body.statement.body.range.start
            || range.end > body.statement.body.range.end
            || authored < range.start
            || authored > range.end
        {
            continue;
        }
        let generated = emitted
            .map_text_boundary_to_generated(source, entry, authored)
            .ok_or(ComposerTextFailure::UnsupportedStructure)?;
        // A retained empty-line strut is authoritative at its boundary.
        // Otherwise prefer the next fragment's start over a preceding LF's
        // end, which may have no rendered glyph after a wrapper boundary.
        let rank = if range.is_empty() {
            2
        } else if range.start == authored {
            1
        } else {
            0
        };
        match mapped {
            Some((previous_rank, previous)) if previous_rank == rank && previous != generated => {
                return Err(ComposerTextFailure::TargetChanged);
            }
            Some((previous_rank, _)) if previous_rank > rank => {}
            _ => mapped = Some((rank, generated)),
        }
    }
    mapped
        .map(|(_, offset)| offset)
        .ok_or(ComposerTextFailure::UnsupportedStructure)
}

fn project_segments(
    source: &str,
    emitted: &EmittedTypst,
    body: &BodyText<'_>,
    selected: TextRange,
    include_empty: bool,
    paint_line_breaks: bool,
    segments: &mut Vec<TextRange>,
) -> Result<(), ComposerTextFailure> {
    if selected.is_empty() {
        let caret = project_caret(source, emitted, body, selected.start)?;
        if include_empty {
            segments.push(TextRange::empty(caret));
        }
        return Ok(());
    }
    let mut fragments = Vec::new();
    for entry in &emitted.source_map {
        let Some(Origin::MmtRange {
            range,
            kind: OriginKind::TextBody,
        }) = emitted.origins.get(entry.origin_id)
        else {
            continue;
        };
        if !range.is_empty() && (range.end <= selected.start || selected.end <= range.start)
            || range.is_empty() && (range.start < selected.start || range.start >= selected.end)
        {
            continue;
        }
        if range.start < body.statement.body.range.start
            || range.end > body.statement.body.range.end
        {
            return Err(ComposerTextFailure::UnsupportedStructure);
        }
        let start = range.start.max(selected.start);
        let end = range.end.min(selected.end);
        let generated_start = emitted
            .map_text_boundary_to_generated(source, entry, start)
            .ok_or(ComposerTextFailure::UnsupportedStructure)?;
        let generated_end = emitted
            .map_text_boundary_to_generated(source, entry, end)
            .ok_or(ComposerTextFailure::UnsupportedStructure)?;
        fragments.push((
            TextRange::new(start, end),
            TextRange::new(generated_start, generated_end),
            entry,
        ));
    }
    fragments.sort_by_key(|(range, _, _)| (range.start, range.end));
    let mut cursor = selected.start;
    let mut empty_anchor = None;
    for (authored, generated, entry) in fragments {
        if authored.start != cursor {
            return Err(ComposerTextFailure::TargetChanged);
        }
        if paint_line_breaks && authored.is_empty() {
            if let Some((offset, previous)) = empty_anchor
                && offset == authored.start
                && previous != generated.start
            {
                return Err(ComposerTextFailure::TargetChanged);
            }
            empty_anchor = Some((authored.start, generated.start));
        }
        if paint_line_breaks && source[authored.start..authored.end].contains(['\r', '\n']) {
            let boundary = |offset| {
                emitted
                    .map_text_boundary_to_generated(source, entry, offset)
                    .ok_or(ComposerTextFailure::UnsupportedStructure)
            };
            let mut run_start = authored.start;
            for (offset, character) in source[authored.start..authored.end].char_indices() {
                let newline = authored.start + offset;
                if character != '\n'
                    && !(character == '\r' && source.as_bytes().get(newline + 1) == Some(&b'\n'))
                {
                    continue;
                }
                if run_start < newline {
                    segments.push(TextRange::new(boundary(run_start)?, boundary(newline)?));
                }
                // CR and LF may occupy separate escaped source-map entries.
                // A CRLF has one semantic caret, before CR, never between them.
                if character != '\n' || newline == 0 || source.as_bytes()[newline - 1] != b'\r' {
                    let offset = match empty_anchor {
                        Some((at, generated)) if at == newline => generated,
                        _ => boundary(newline)?,
                    };
                    let caret = TextRange::empty(offset);
                    if segments.last() != Some(&caret) {
                        segments.push(caret);
                    }
                }
                run_start = newline + 1;
            }
            if run_start < authored.end {
                segments.push(TextRange::new(boundary(run_start)?, generated.end));
            }
        } else {
            segments.push(generated);
        }
        cursor = authored.end;
    }
    if cursor != selected.end {
        return Err(ComposerTextFailure::UnsupportedStructure);
    }
    Ok(())
}

/// Exact inverse used by backend text hits. It additionally proves grapheme
/// boundaries against the current semantic body, unlike generic navigation.
pub fn resolve_composer_text_source_range(
    source: &str,
    analysis: &AnalyzedDocument,
    emitted: &EmittedTypst,
    generated: TextRange,
) -> Result<TextRange, ComposerTextFailure> {
    if generated.start > generated.end {
        return Err(ComposerTextFailure::InvalidValue);
    }
    let start = emitted
        .map_text_caret_to_authored(source, generated.start)
        .ok_or(ComposerTextFailure::UnsupportedStructure)?;
    let end = emitted
        .map_text_caret_to_authored(source, generated.end)
        .ok_or(ComposerTextFailure::UnsupportedStructure)?;
    let resolved = resolve_composer_text_selection(
        source,
        analysis,
        &composer_document_source_digest(source),
        TextRange::empty(start),
        TextRange::empty(end),
    )?;
    if resolved.selection.anchor.node != resolved.selection.focus.node || start > end {
        return Err(ComposerTextFailure::UnsupportedStructure);
    }
    let projected = project_text_selection(source, analysis, emitted, &resolved.selection, false)?;
    if projected.anchor.start != generated.start || projected.focus.start != generated.end {
        return Err(ComposerTextFailure::TargetChanged);
    }
    let mut cursor = generated.start;
    for segment in projected.segments {
        if segment.start != cursor {
            return Err(ComposerTextFailure::UnsupportedStructure);
        }
        cursor = segment.end;
    }
    if cursor != generated.end {
        return Err(ComposerTextFailure::UnsupportedStructure);
    }
    Ok(TextRange::new(start, end))
}
