//! Partition-bound structural Composer edits.

use crate::composer::{
    ComposerFailure, ComposerSourceEdit, ComposerSpeakerDescription, ContinuedValue,
    StatementTextMode, analysis_has_errors, apply_source_edit, serialize_statement_body,
};
use crate::composer_document::{
    ComposerBoundaryTarget, ComposerDocumentNode, ComposerDocumentNodeKind,
    ComposerDocumentProjection, ComposerMessageSide, ComposerNodeRef,
    project_analyzed_composer_document,
};
use crate::pack::PackRegistry;
use crate::pipeline::{AnalyzedDocument, analyze_text, analyze_text_with_pack};
use crate::semantic::{CharacterPresetCatalog, PresetLookup};
use crate::source::TextRange;
use crate::syntax::{SpeakerMarkerSyntax, StatementSyntax, SyntaxNode};

pub const COMPOSER_SPEAKER_REFERENCE_MAX_BYTES: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerSpeakerChoice {
    Actor { reference: String },
}

impl ComposerSpeakerChoice {
    pub fn reference(&self) -> &str {
        match self {
            Self::Actor { reference } => reference,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerStatementBodyInput {
    pub value: String,
    pub mode: StatementTextMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerNewStatement {
    Message {
        side: ComposerMessageSide,
        speaker: ComposerSpeakerChoice,
        body: ComposerStatementBodyInput,
        continued: ContinuedValue,
    },
    Narration {
        body: ComposerStatementBodyInput,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerStructureTarget {
    Node(ComposerNodeRef),
    Boundary(ComposerBoundaryTarget),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerStructureCommand {
    InsertStatement { statement: ComposerNewStatement },
    DeleteNode,
    MoveNode { anchor: ComposerBoundaryTarget },
    SetStatementSpeaker { speaker: ComposerSpeakerChoice },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerStructureFailure {
    StaleDocument,
    TargetChanged,
    DocumentHasErrors,
    InvalidValue,
    UnsupportedStructure,
    SpeakerUnavailable,
    CandidateInvalid,
}

pub fn compose_structure_edit(
    source: &str,
    analysis: &AnalyzedDocument,
    catalog: &impl CharacterPresetCatalog,
    source_digest: &str,
    target: ComposerStructureTarget,
    command: ComposerStructureCommand,
) -> Result<ComposerSourceEdit, ComposerStructureFailure> {
    let speakers_available = command_speakers_available(analysis, catalog, &command);
    compose_structure_edit_using(
        source,
        analysis,
        source_digest,
        target,
        command,
        speakers_available,
        |candidate| analyze_text(candidate, catalog),
    )
}

pub fn compose_structure_edit_with_pack(
    source: &str,
    analysis: &AnalyzedDocument,
    packs: &PackRegistry,
    source_digest: &str,
    target: ComposerStructureTarget,
    command: ComposerStructureCommand,
) -> Result<ComposerSourceEdit, ComposerStructureFailure> {
    let speakers_available = command_speakers_available(analysis, packs, &command);
    compose_structure_edit_using(
        source,
        analysis,
        source_digest,
        target,
        command,
        speakers_available,
        |candidate| analyze_text_with_pack(candidate, packs),
    )
}

fn compose_structure_edit_using(
    source: &str,
    analysis: &AnalyzedDocument,
    source_digest: &str,
    target: ComposerStructureTarget,
    command: ComposerStructureCommand,
    speakers_available: bool,
    analyze_candidate: impl FnOnce(&str) -> AnalyzedDocument,
) -> Result<ComposerSourceEdit, ComposerStructureFailure> {
    let projection = project_analyzed_composer_document(source, analysis)
        .map_err(|_| ComposerStructureFailure::CandidateInvalid)?;
    if projection.source_digest != source_digest {
        return Err(ComposerStructureFailure::StaleDocument);
    }
    if analysis_has_errors(analysis) || projection.has_errors {
        return Err(ComposerStructureFailure::DocumentHasErrors);
    }
    if !speakers_available {
        return Err(ComposerStructureFailure::SpeakerUnavailable);
    }

    let operation = prepare_operation(source, analysis, &projection, target, command)?;
    let candidate_source =
        apply_source_edit(source, &operation.edit).map_err(map_composer_failure)?;
    let candidate_analysis = analyze_candidate(&candidate_source);
    if analysis_has_errors(&candidate_analysis) {
        return Err(ComposerStructureFailure::CandidateInvalid);
    }
    let candidate_projection =
        project_analyzed_composer_document(&candidate_source, &candidate_analysis)
            .map_err(|_| ComposerStructureFailure::CandidateInvalid)?;
    if candidate_projection.has_errors
        || !operation.proves_candidate(
            source,
            &projection,
            &candidate_source,
            &candidate_projection,
        )
    {
        return Err(ComposerStructureFailure::CandidateInvalid);
    }
    Ok(operation.edit)
}
fn command_speakers_available(
    analysis: &AnalyzedDocument,
    catalog: &impl CharacterPresetCatalog,
    command: &ComposerStructureCommand,
) -> bool {
    let choice = match command {
        ComposerStructureCommand::InsertStatement {
            statement: ComposerNewStatement::Message { speaker, .. },
        }
        | ComposerStructureCommand::SetStatementSpeaker { speaker } => Some(speaker),
        ComposerStructureCommand::InsertStatement {
            statement: ComposerNewStatement::Narration { .. },
        }
        | ComposerStructureCommand::DeleteNode
        | ComposerStructureCommand::MoveNode { .. } => None,
    };
    choice.is_none_or(|choice| {
        let reference = choice.reference();
        analysis.actors.actors.iter().any(|actor| {
            actor.primary_name == reference || actor.names.iter().any(|name| name == reference)
        }) || matches!(catalog.resolve(reference), PresetLookup::Found(_))
    })
}

struct PreparedOperation {
    edit: ComposerSourceEdit,
    proof: OperationProof,
}

impl PreparedOperation {
    fn proves_candidate(
        &self,
        before_source: &str,
        before: &ComposerDocumentProjection,
        after_source: &str,
        after: &ComposerDocumentProjection,
    ) -> bool {
        match &self.proof {
            OperationProof::Insert {
                boundary_index,
                statement,
            } => prove_insert(
                before_source,
                before,
                after_source,
                after,
                *boundary_index,
                statement,
            ),
            OperationProof::Delete { target_index } => {
                prove_delete(before_source, before, after_source, after, *target_index)
            }
            OperationProof::Move {
                first_index,
                second_index,
            } => prove_move(
                before_source,
                before,
                after_source,
                after,
                *first_index,
                *second_index,
            ),
            OperationProof::SetSpeaker {
                target_index,
                speaker,
            } => prove_set_speaker(
                before_source,
                before,
                after_source,
                after,
                *target_index,
                speaker,
            ),
        }
    }
}

enum OperationProof {
    Insert {
        boundary_index: usize,
        statement: ComposerNewStatement,
    },
    Delete {
        target_index: usize,
    },
    Move {
        first_index: usize,
        second_index: usize,
    },
    SetSpeaker {
        target_index: usize,
        speaker: ComposerSpeakerChoice,
    },
}

fn prepare_operation(
    source: &str,
    analysis: &AnalyzedDocument,
    projection: &ComposerDocumentProjection,
    target: ComposerStructureTarget,
    command: ComposerStructureCommand,
) -> Result<PreparedOperation, ComposerStructureFailure> {
    match (target, command) {
        (
            ComposerStructureTarget::Boundary(target),
            ComposerStructureCommand::InsertStatement { statement },
        ) => prepare_insert(projection, target, statement),
        (ComposerStructureTarget::Node(target), ComposerStructureCommand::DeleteNode) => {
            prepare_delete(projection, target)
        }
        (ComposerStructureTarget::Node(target), ComposerStructureCommand::MoveNode { anchor }) => {
            prepare_move(source, projection, target, anchor)
        }
        (
            ComposerStructureTarget::Node(target),
            ComposerStructureCommand::SetStatementSpeaker { speaker },
        ) => prepare_set_speaker(source, analysis, projection, target, speaker),
        _ => Err(ComposerStructureFailure::UnsupportedStructure),
    }
}

fn prepare_insert(
    projection: &ComposerDocumentProjection,
    target: ComposerBoundaryTarget,
    statement: ComposerNewStatement,
) -> Result<PreparedOperation, ComposerStructureFailure> {
    let (boundary_index, capability) = projection
        .boundaries
        .iter()
        .enumerate()
        .find(|(_, boundary)| boundary.target == target)
        .and_then(|(index, boundary)| {
            boundary
                .insert
                .as_ref()
                .map(|capability| (index, capability))
        })
        .ok_or(ComposerStructureFailure::UnsupportedStructure)?;
    let serialized = serialize_new_statement(&statement)?;
    let offset = target
        .after
        .as_ref()
        .map(|node| node.range.start)
        .or_else(|| target.before.as_ref().map(|node| node.range.end))
        .unwrap_or(0);
    let mut new_text = String::with_capacity(serialized.len() + capability.eol.len());
    new_text.push_str(&serialized);
    new_text.push_str(&capability.eol);
    Ok(PreparedOperation {
        edit: ComposerSourceEdit {
            range: TextRange::empty(offset),
            new_text,
        },
        proof: OperationProof::Insert {
            boundary_index,
            statement,
        },
    })
}

fn prepare_delete(
    projection: &ComposerDocumentProjection,
    target: ComposerNodeRef,
) -> Result<PreparedOperation, ComposerStructureFailure> {
    let (target_index, node) = exact_node(projection, &target)?;
    let allowed = match node {
        ComposerDocumentNode::Message(node) => node.capabilities.delete,
        ComposerDocumentNode::Narration(node) => node.capabilities.delete,
        ComposerDocumentNode::Opaque(_) => false,
    };
    if !allowed {
        return Err(ComposerStructureFailure::UnsupportedStructure);
    }
    Ok(PreparedOperation {
        edit: ComposerSourceEdit {
            range: node.range(),
            new_text: String::new(),
        },
        proof: OperationProof::Delete { target_index },
    })
}

fn prepare_move(
    source: &str,
    projection: &ComposerDocumentProjection,
    target: ComposerNodeRef,
    anchor: ComposerBoundaryTarget,
) -> Result<PreparedOperation, ComposerStructureFailure> {
    let (target_index, node) = exact_node(projection, &target)?;
    let (first_index, second_index) = match node {
        ComposerDocumentNode::Message(node)
            if node.capabilities.move_up.as_ref() == Some(&anchor) =>
        {
            (
                target_index
                    .checked_sub(1)
                    .ok_or(ComposerStructureFailure::UnsupportedStructure)?,
                target_index,
            )
        }
        ComposerDocumentNode::Narration(node)
            if node.capabilities.move_up.as_ref() == Some(&anchor) =>
        {
            (
                target_index
                    .checked_sub(1)
                    .ok_or(ComposerStructureFailure::UnsupportedStructure)?,
                target_index,
            )
        }
        ComposerDocumentNode::Message(node)
            if node.capabilities.move_down.as_ref() == Some(&anchor) =>
        {
            (target_index, target_index + 1)
        }
        ComposerDocumentNode::Narration(node)
            if node.capabilities.move_down.as_ref() == Some(&anchor) =>
        {
            (target_index, target_index + 1)
        }
        _ => return Err(ComposerStructureFailure::UnsupportedStructure),
    };
    let first = projection
        .nodes
        .get(first_index)
        .ok_or(ComposerStructureFailure::TargetChanged)?;
    let second = projection
        .nodes
        .get(second_index)
        .ok_or(ComposerStructureFailure::TargetChanged)?;
    if first.kind() == ComposerDocumentNodeKind::Opaque
        || second.kind() == ComposerDocumentNodeKind::Opaque
    {
        return Err(ComposerStructureFailure::UnsupportedStructure);
    }
    let (first_payload, first_eol) = logical_payload(source, first.range())?;
    let (second_payload, second_eol) = logical_payload(source, second.range())?;
    let eol = match (first_eol, second_eol) {
        (Some(left), Some(right)) if left == right => left,
        (Some(style), None) | (None, Some(style)) => style,
        _ => return Err(ComposerStructureFailure::UnsupportedStructure),
    };
    let preserve_final_eol = second.range().end < source.len() || second_eol.is_some();
    let mut replacement = String::with_capacity(first.range().len() + second.range().len());
    replacement.push_str(second_payload);
    replacement.push_str(eol);
    replacement.push_str(first_payload);
    if preserve_final_eol {
        replacement.push_str(eol);
    }
    Ok(PreparedOperation {
        edit: ComposerSourceEdit {
            range: TextRange::new(first.range().start, second.range().end),
            new_text: replacement,
        },
        proof: OperationProof::Move {
            first_index,
            second_index,
        },
    })
}

fn prepare_set_speaker(
    source: &str,
    analysis: &AnalyzedDocument,
    projection: &ComposerDocumentProjection,
    target: ComposerNodeRef,
    speaker: ComposerSpeakerChoice,
) -> Result<PreparedOperation, ComposerStructureFailure> {
    let (target_index, node) = exact_node(projection, &target)?;
    let ComposerDocumentNode::Message(message) = node else {
        return Err(ComposerStructureFailure::UnsupportedStructure);
    };
    if !message.capabilities.set_speaker {
        return Err(ComposerStructureFailure::UnsupportedStructure);
    }
    let reference = validate_speaker_reference(speaker.reference())?;
    let statement = exact_statement(analysis, message.statement_range)
        .ok_or(ComposerStructureFailure::TargetChanged)?;
    let (range, new_text) = match &statement.marker {
        Some(SpeakerMarkerSyntax::Explicit { range, .. })
        | Some(SpeakerMarkerSyntax::BackRef { range, .. })
        | Some(SpeakerMarkerSyntax::UniqueIndex { range, .. }) => (*range, reference.to_owned()),
        None => {
            if statement.body.range.start > source.len()
                || !source.is_char_boundary(statement.body.range.start)
            {
                return Err(ComposerStructureFailure::TargetChanged);
            }
            (
                TextRange::empty(statement.body.range.start),
                format!("{reference}: "),
            )
        }
    };
    Ok(PreparedOperation {
        edit: ComposerSourceEdit { range, new_text },
        proof: OperationProof::SetSpeaker {
            target_index,
            speaker,
        },
    })
}

fn serialize_new_statement(
    statement: &ComposerNewStatement,
) -> Result<String, ComposerStructureFailure> {
    match statement {
        ComposerNewStatement::Message {
            side,
            speaker,
            body,
            continued,
        } => {
            let reference = validate_speaker_reference(speaker.reference())?;
            let body =
                serialize_statement_body(&body.value, body.mode).map_err(map_composer_failure)?;
            let sigil = match side {
                ComposerMessageSide::Left => '>',
                ComposerMessageSide::Right => '<',
            };
            let patch = match continued {
                ContinuedValue::Auto => String::new(),
                ContinuedValue::True => "(continued: true)".to_owned(),
                ContinuedValue::False => "(continued: false)".to_owned(),
            };
            Ok(format!("{sigil}{patch} {reference}: {body}"))
        }
        ComposerNewStatement::Narration { body } => {
            let body =
                serialize_statement_body(&body.value, body.mode).map_err(map_composer_failure)?;
            Ok(format!("- {body}"))
        }
    }
}

fn validate_speaker_reference(reference: &str) -> Result<&str, ComposerStructureFailure> {
    if reference.is_empty()
        || reference.len() > COMPOSER_SPEAKER_REFERENCE_MAX_BYTES
        || reference.trim() != reference
        || reference.contains(['\r', '\n'])
        || reference.chars().any(char::is_control)
    {
        return Err(ComposerStructureFailure::SpeakerUnavailable);
    }
    Ok(reference)
}

fn exact_node<'a>(
    projection: &'a ComposerDocumentProjection,
    target: &ComposerNodeRef,
) -> Result<(usize, &'a ComposerDocumentNode), ComposerStructureFailure> {
    let mut matches = projection
        .nodes
        .iter()
        .enumerate()
        .filter(|(_, node)| node.node_ref() == *target);
    let result = matches
        .next()
        .ok_or(ComposerStructureFailure::TargetChanged)?;
    if matches.next().is_some() {
        return Err(ComposerStructureFailure::TargetChanged);
    }
    Ok(result)
}

fn exact_statement(analysis: &AnalyzedDocument, range: TextRange) -> Option<&StatementSyntax> {
    let mut matches = analysis
        .document
        .nodes
        .iter()
        .filter_map(|node| match node {
            SyntaxNode::Statement(statement) if statement.range == range => Some(statement),
            _ => None,
        });
    let statement = matches.next()?;
    matches.next().is_none().then_some(statement)
}

fn logical_payload(
    source: &str,
    range: TextRange,
) -> Result<(&str, Option<&str>), ComposerStructureFailure> {
    let slice = source
        .get(range.start..range.end)
        .ok_or(ComposerStructureFailure::TargetChanged)?;
    if let Some(payload) = slice.strip_suffix("\r\n") {
        Ok((payload, Some("\r\n")))
    } else if let Some(payload) = slice.strip_suffix('\n') {
        Ok((payload, Some("\n")))
    } else {
        Ok((slice, None))
    }
}

fn prove_insert(
    before_source: &str,
    before: &ComposerDocumentProjection,
    after_source: &str,
    after: &ComposerDocumentProjection,
    boundary_index: usize,
    requested: &ComposerNewStatement,
) -> bool {
    if after.nodes.len() != before.nodes.len() + 1 || boundary_index >= after.nodes.len() {
        return false;
    }
    for index in 0..before.nodes.len() {
        let after_index = if index < boundary_index {
            index
        } else {
            index + 1
        };
        if !same_node_exact_and_semantic(
            before_source,
            &before.nodes[index],
            after_source,
            &after.nodes[after_index],
        ) {
            return false;
        }
    }
    inserted_node_matches(&after.nodes[boundary_index], requested)
}

fn prove_delete(
    before_source: &str,
    before: &ComposerDocumentProjection,
    after_source: &str,
    after: &ComposerDocumentProjection,
    target_index: usize,
) -> bool {
    if before.nodes.len() != after.nodes.len() + 1 || target_index >= before.nodes.len() {
        return false;
    }
    before
        .nodes
        .iter()
        .enumerate()
        .filter(|(index, _)| *index != target_index)
        .enumerate()
        .all(|(after_index, (_, before_node))| {
            same_node_exact_and_semantic(
                before_source,
                before_node,
                after_source,
                &after.nodes[after_index],
            )
        })
}

fn prove_move(
    before_source: &str,
    before: &ComposerDocumentProjection,
    after_source: &str,
    after: &ComposerDocumentProjection,
    first_index: usize,
    second_index: usize,
) -> bool {
    if before.nodes.len() != after.nodes.len()
        || second_index != first_index + 1
        || second_index >= before.nodes.len()
    {
        return false;
    }
    for index in 0..before.nodes.len() {
        let before_index = if index == first_index {
            second_index
        } else if index == second_index {
            first_index
        } else {
            index
        };
        if !same_logical_node_exact_and_semantic(
            before_source,
            &before.nodes[before_index],
            after_source,
            &after.nodes[index],
        ) {
            return false;
        }
    }
    true
}

fn prove_set_speaker(
    before_source: &str,
    before: &ComposerDocumentProjection,
    after_source: &str,
    after: &ComposerDocumentProjection,
    target_index: usize,
    requested: &ComposerSpeakerChoice,
) -> bool {
    if before.nodes.len() != after.nodes.len() || target_index >= before.nodes.len() {
        return false;
    }
    for index in 0..before.nodes.len() {
        if index == target_index {
            let (ComposerDocumentNode::Message(before), ComposerDocumentNode::Message(after)) =
                (&before.nodes[index], &after.nodes[index])
            else {
                return false;
            };
            if before.side != after.side
                || before.description.body != after.description.body
                || before.description.continued != after.description.continued
                || !speaker_matches(after.description.speaker.as_ref(), requested)
            {
                return false;
            }
        } else if !same_node_exact_and_semantic(
            before_source,
            &before.nodes[index],
            after_source,
            &after.nodes[index],
        ) {
            return false;
        }
    }
    true
}

fn inserted_node_matches(node: &ComposerDocumentNode, requested: &ComposerNewStatement) -> bool {
    match (node, requested) {
        (
            ComposerDocumentNode::Message(node),
            ComposerNewStatement::Message {
                side,
                speaker,
                body,
                continued,
            },
        ) => {
            node.side == *side
                && node.description.body.current == body.value
                && node.description.body.mode == body.mode
                && node.description.continued == Some(*continued)
                && speaker_matches(node.description.speaker.as_ref(), speaker)
        }
        (ComposerDocumentNode::Narration(node), ComposerNewStatement::Narration { body }) => {
            node.description.body.current == body.value && node.description.body.mode == body.mode
        }
        _ => false,
    }
}

fn speaker_matches(
    speaker: Option<&ComposerSpeakerDescription>,
    requested: &ComposerSpeakerChoice,
) -> bool {
    let Some(ComposerSpeakerDescription::Actor {
        reference,
        preset_id,
        ..
    }) = speaker
    else {
        return false;
    };
    requested.reference() == reference || requested.reference() == preset_id
}

fn same_node_exact_and_semantic(
    left_source: &str,
    left: &ComposerDocumentNode,
    right_source: &str,
    right: &ComposerDocumentNode,
) -> bool {
    left_source.get(left.range().start..left.range().end)
        == right_source.get(right.range().start..right.range().end)
        && same_node_semantics(left, right)
}

fn same_logical_node_exact_and_semantic(
    left_source: &str,
    left: &ComposerDocumentNode,
    right_source: &str,
    right: &ComposerDocumentNode,
) -> bool {
    logical_payload(left_source, left.range())
        .ok()
        .map(|value| value.0)
        == logical_payload(right_source, right.range())
            .ok()
            .map(|value| value.0)
        && same_node_semantics(left, right)
}

fn same_node_semantics(left: &ComposerDocumentNode, right: &ComposerDocumentNode) -> bool {
    match (left, right) {
        (ComposerDocumentNode::Message(left), ComposerDocumentNode::Message(right)) => {
            left.side == right.side && left.description == right.description
        }
        (ComposerDocumentNode::Narration(left), ComposerDocumentNode::Narration(right)) => {
            left.description == right.description
        }
        (ComposerDocumentNode::Opaque(left), ComposerDocumentNode::Opaque(right)) => {
            left.category == right.category
        }
        _ => false,
    }
}

fn map_composer_failure(failure: ComposerFailure) -> ComposerStructureFailure {
    match failure {
        ComposerFailure::TargetChanged => ComposerStructureFailure::TargetChanged,
        ComposerFailure::DocumentHasErrors => ComposerStructureFailure::DocumentHasErrors,
        ComposerFailure::InvalidValue => ComposerStructureFailure::InvalidValue,
        ComposerFailure::ActorUnavailable | ComposerFailure::AvatarUnavailable => {
            ComposerStructureFailure::SpeakerUnavailable
        }
        ComposerFailure::CandidateInvalid => ComposerStructureFailure::CandidateInvalid,
    }
}
