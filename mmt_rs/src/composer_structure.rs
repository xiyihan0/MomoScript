//! Partition-bound structural Composer edits.

use crate::composer::{
    ComposerAvatarCurrent, ComposerFailure, ComposerSourceEdit, ComposerSpeakerDescription,
    ContinuedValue, PackAvatarChoice, StatementTextMode, analysis_has_errors, apply_source_edit,
    compose_inserted_avatar_edit, serialize_scalar, serialize_statement_body,
    statement_body_value_with_eol,
};
use crate::composer_document::{
    ComposerBoundaryTarget, ComposerDocumentNode, ComposerDocumentProjection, ComposerMessageSide,
    ComposerNodeRef, eof_insert_separator, project_analyzed_composer_document,
    replaceable_source_node,
};
use crate::inline::QuoteKind;
use crate::pack::PackRegistry;
use crate::pipeline::{AnalyzedDocument, analyze_text, analyze_text_with_pack};
use crate::semantic::{
    CharacterPresetCatalog, PresetLookup, ResourceSelector, SubjectRef, VariantSelector,
    sanitized_workspace_relative_path,
};
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
pub enum ComposerNewStatementSpeaker {
    Actor { reference: String },
    Builtin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerStatementBodyInput {
    pub value: String,
    pub mode: StatementTextMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerMediaChoice {
    Asset {
        asset_name: String,
    },
    WorkspaceImage {
        relative_path: String,
    },
    Sticker {
        entity_id: String,
        set_id: String,
        ordinal: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerNewStatement {
    Message {
        side: ComposerMessageSide,
        speaker: ComposerNewStatementSpeaker,
        avatar: Option<PackAvatarChoice>,
        body: ComposerStatementBodyInput,
        continued: ContinuedValue,
    },
    Media {
        side: ComposerMessageSide,
        speaker: ComposerNewStatementSpeaker,
        avatar: Option<PackAvatarChoice>,
        continued: ContinuedValue,
        media: ComposerMediaChoice,
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
    SetStatementSide { side: ComposerMessageSide },
    ReplaceNodeSource { source: String },
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
        None,
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
        Some(packs),
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
    packs: Option<&PackRegistry>,
    analyze_candidate: impl Fn(&str) -> AnalyzedDocument,
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

    let operation = prepare_operation(source, analysis, &projection, target, command, packs)?;
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
    let mut edit = operation.edit;
    if let OperationProof::Insert {
        boundary_index,
        statement,
        prefix_nodes,
    } = operation.proof
    {
        if let ComposerNewStatement::Message {
            avatar: Some(choice),
            ..
        } = statement
        {
            let ComposerDocumentNode::Message(inserted) =
                &candidate_projection.nodes[boundary_index + prefix_nodes]
            else {
                return Err(ComposerStructureFailure::CandidateInvalid);
            };
            let current = inserted
                .description
                .actor_avatar
                .as_ref()
                .and_then(|avatar| avatar.current.as_ref());
            if !matches!(current, Some(ComposerAvatarCurrent::Pack(current)) if current == &choice)
            {
                let avatar_edit = compose_inserted_avatar_edit(
                    &candidate_source,
                    &candidate_analysis,
                    packs.ok_or(ComposerStructureFailure::InvalidValue)?,
                    inserted.statement_range,
                    choice,
                )
                .map_err(map_composer_failure)?;
                let relative = avatar_edit
                    .range
                    .start
                    .checked_sub(edit.range.start)
                    .filter(|offset| *offset <= edit.new_text.len())
                    .ok_or(ComposerStructureFailure::CandidateInvalid)?;
                if !avatar_edit.range.is_empty() {
                    return Err(ComposerStructureFailure::CandidateInvalid);
                }
                edit.new_text.insert_str(relative, &avatar_edit.new_text);
            }
        }
    }
    Ok(edit)
}
fn command_speakers_available(
    analysis: &AnalyzedDocument,
    catalog: &impl CharacterPresetCatalog,
    command: &ComposerStructureCommand,
) -> bool {
    let reference = match command {
        ComposerStructureCommand::InsertStatement {
            statement:
                ComposerNewStatement::Message {
                    speaker: ComposerNewStatementSpeaker::Actor { reference },
                    ..
                }
                | ComposerNewStatement::Media {
                    speaker: ComposerNewStatementSpeaker::Actor { reference },
                    ..
                },
        } => Some(reference.as_str()),
        ComposerStructureCommand::SetStatementSpeaker { speaker } => Some(speaker.reference()),
        _ => None,
    };
    reference.is_none_or(|reference| {
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
                prefix_nodes,
            } => prove_insert(
                before_source,
                before,
                after_source,
                after,
                *boundary_index,
                *prefix_nodes,
                statement,
            ),
            OperationProof::Delete { target_index } => {
                prove_delete(before_source, before, after_source, after, *target_index)
            }
            OperationProof::Move {
                target_index,
                boundary_index,
            } => prove_move(
                before_source,
                before,
                after_source,
                after,
                *target_index,
                *boundary_index,
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
            OperationProof::SetSide { target_index, side } => prove_set_side(
                before_source,
                before,
                after_source,
                after,
                *target_index,
                *side,
            ),
            OperationProof::ReplaceSource { target_index } => prove_replace_source(
                before_source,
                before,
                after_source,
                after,
                *target_index,
                &self.edit,
            ),
        }
    }
}

enum OperationProof {
    Insert {
        boundary_index: usize,
        statement: ComposerNewStatement,
        prefix_nodes: usize,
    },
    Delete {
        target_index: usize,
    },
    Move {
        target_index: usize,
        boundary_index: usize,
    },
    SetSpeaker {
        target_index: usize,
        speaker: ComposerSpeakerChoice,
    },
    SetSide {
        target_index: usize,
        side: ComposerMessageSide,
    },
    ReplaceSource {
        target_index: usize,
    },
}

fn prepare_operation(
    source: &str,
    analysis: &AnalyzedDocument,
    projection: &ComposerDocumentProjection,
    target: ComposerStructureTarget,
    command: ComposerStructureCommand,
    packs: Option<&PackRegistry>,
) -> Result<PreparedOperation, ComposerStructureFailure> {
    match (target, command) {
        (
            ComposerStructureTarget::Boundary(target),
            ComposerStructureCommand::InsertStatement { statement },
        ) => prepare_insert(source, analysis, projection, target, statement, packs),
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
        (
            ComposerStructureTarget::Node(target),
            ComposerStructureCommand::SetStatementSide { side },
        ) => prepare_set_side(source, analysis, projection, target, side),
        (
            ComposerStructureTarget::Node(target),
            ComposerStructureCommand::ReplaceNodeSource {
                source: replacement,
            },
        ) => prepare_replace_source(source, analysis, projection, target, replacement),
        _ => Err(ComposerStructureFailure::UnsupportedStructure),
    }
}

fn prepare_insert(
    source: &str,
    analysis: &AnalyzedDocument,
    projection: &ComposerDocumentProjection,
    target: ComposerBoundaryTarget,
    statement: ComposerNewStatement,
    packs: Option<&PackRegistry>,
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
    let (statement, prefix) = normalize_new_statement(analysis, statement, &capability.eol, packs)?;
    let mut statement = statement;
    if let ComposerNewStatement::Message {
        side,
        speaker: ComposerNewStatementSpeaker::Builtin,
        ..
    } = &statement
    {
        if !capability.builtin_message_sides.contains(side) {
            return Err(ComposerStructureFailure::UnsupportedStructure);
        }
    }
    let body = match &mut statement {
        ComposerNewStatement::Message { body, .. } | ComposerNewStatement::Narration { body } => {
            body
        }
        ComposerNewStatement::Media { .. } => return Err(ComposerStructureFailure::InvalidValue),
    };
    body.value = statement_body_value_with_eol(std::mem::take(&mut body.value), &capability.eol)
        .map_err(map_composer_failure)?;
    let serialized = serialize_new_statement(&statement, &capability.eol)?;
    let offset = target
        .after
        .as_ref()
        .map(|node| node.range.start)
        .or_else(|| target.before.as_ref().map(|node| node.range.end))
        .unwrap_or(0);
    let separator = (boundary_index == projection.nodes.len())
        .then(|| eof_insert_separator(source))
        .flatten();
    let mut new_text = String::with_capacity(
        serialized.len() + prefix.len() + capability.eol.len() + separator.map_or(0, str::len),
    );
    if let Some(separator) = separator {
        new_text.push_str(separator);
    }
    new_text.push_str(&prefix);
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
            prefix_nodes: usize::from(!prefix.is_empty()),
        },
    })
}

fn normalize_new_statement(
    analysis: &AnalyzedDocument,
    statement: ComposerNewStatement,
    eol: &str,
    packs: Option<&PackRegistry>,
) -> Result<(ComposerNewStatement, String), ComposerStructureFailure> {
    let (statement, prefix) = match statement {
        ComposerNewStatement::Media {
            side,
            speaker,
            avatar,
            continued,
            media,
        } => {
            let (body, prefix) = match media {
                ComposerMediaChoice::Asset { asset_name } => {
                    if analysis.assets.resolve(&asset_name).is_none() {
                        return Err(ComposerStructureFailure::InvalidValue);
                    }
                    (asset_marker(&asset_name)?, String::new())
                }
                ComposerMediaChoice::WorkspaceImage { relative_path } => {
                    if !sanitized_workspace_relative_path(&relative_path)
                        || relative_path.split('/').count() != 2
                        || !relative_path.starts_with("assets/")
                        || !relative_path.rsplit('.').next().is_some_and(|extension| {
                            matches!(
                                extension.to_ascii_lowercase().as_str(),
                                "png" | "jpg" | "jpeg"
                            )
                        })
                    {
                        return Err(ComposerStructureFailure::InvalidValue);
                    }
                    let mut ordinal = 1_u32;
                    let asset_name = loop {
                        let name = format!("image_{ordinal}");
                        if analysis.assets.resolve(&name).is_none()
                            && packs.is_none_or(|packs| {
                                packs
                                    .manifests()
                                    .iter()
                                    .all(|manifest| !manifest.assets.contains_key(&name))
                            })
                        {
                            break name;
                        }
                        ordinal = ordinal
                            .checked_add(1)
                            .ok_or(ComposerStructureFailure::InvalidValue)?;
                    };
                    let encoded = serialize_scalar(&relative_path, None)
                        .ok_or(ComposerStructureFailure::InvalidValue)?;
                    let prefix = format!("@asset {asset_name}{eol}src: {encoded}{eol}@end{eol}");
                    (asset_marker(&asset_name)?, prefix)
                }
                ComposerMediaChoice::Sticker {
                    entity_id,
                    set_id,
                    ordinal,
                } => {
                    let (namespace, name) = entity_id
                        .split_once("::")
                        .filter(|(namespace, name)| !namespace.is_empty() && !name.is_empty())
                        .ok_or(ComposerStructureFailure::InvalidValue)?;
                    let (contribution, set_key) = match set_id.split_once("::") {
                        Some((contribution, set))
                            if !contribution.is_empty()
                                && !set.is_empty()
                                && !contribution.contains(':')
                                && !set.contains(':') =>
                        {
                            (Some(contribution), set)
                        }
                        Some(_) => return Err(ComposerStructureFailure::InvalidValue),
                        None => (None, set_id.as_str()),
                    };
                    if ordinal == 0
                        || set_key.is_empty()
                        || entity_id.chars().any(char::is_control)
                        || entity_id.contains(['/', '[', ']', ','])
                        || set_id.chars().any(char::is_control)
                        || set_key.contains(['/', ':', '[', ']', ','])
                    {
                        return Err(ComposerStructureFailure::InvalidValue);
                    }
                    let selector = ResourceSelector::Sticker {
                        subject: SubjectRef::Entity {
                            namespace: Some(namespace.to_owned()),
                            name: name.to_owned(),
                        },
                        contribution: contribution.map(str::to_owned),
                        set: Some(set_key.to_owned()),
                        variant: VariantSelector::Ordinal(ordinal),
                    };
                    let resolved = packs
                        .ok_or(ComposerStructureFailure::InvalidValue)?
                        .resolve_sticker(&selector, &analysis.actors)
                        .map_err(|_| ComposerStructureFailure::InvalidValue)?;
                    if resolved.entity_id != entity_id
                        || resolved.set_id != set_key
                        || contribution
                            .is_some_and(|value| value != resolved.contribution_namespace)
                    {
                        return Err(ComposerStructureFailure::InvalidValue);
                    }
                    (
                        format!(
                            "[:{entity_id}/{}::sticker/{set_key}/#{ordinal}:]",
                            resolved.contribution_namespace
                        ),
                        String::new(),
                    )
                }
            };
            (
                ComposerNewStatement::Message {
                    side,
                    speaker,
                    avatar,
                    continued,
                    body: ComposerStatementBodyInput {
                        value: body,
                        mode: StatementTextMode::TextMacro,
                    },
                },
                prefix,
            )
        }
        statement => (statement, String::new()),
    };
    if let ComposerNewStatement::Message {
        speaker,
        avatar: Some(choice),
        ..
    } = &statement
    {
        if matches!(speaker, ComposerNewStatementSpeaker::Builtin) {
            return Err(ComposerStructureFailure::InvalidValue);
        }
        let resolved = packs
            .ok_or(ComposerStructureFailure::InvalidValue)?
            .resolve_avatar(
                &choice.entity_id,
                Some(&choice.contribution_namespace),
                &choice.variant_id,
            )
            .map_err(|_| ComposerStructureFailure::InvalidValue)?;
        if resolved.entity_id != choice.entity_id
            || resolved.contribution_namespace != choice.contribution_namespace
            || resolved.variant_id != choice.variant_id
        {
            return Err(ComposerStructureFailure::InvalidValue);
        }
    }
    Ok((statement, prefix))
}

fn asset_marker(asset_name: &str) -> Result<String, ComposerStructureFailure> {
    let encoded = serialize_scalar(asset_name, Some(QuoteKind::Double))
        .ok_or(ComposerStructureFailure::InvalidValue)?;
    Ok(format!("[:asset, {encoded}:]"))
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

fn prepare_replace_source(
    source: &str,
    analysis: &AnalyzedDocument,
    projection: &ComposerDocumentProjection,
    target: ComposerNodeRef,
    replacement: String,
) -> Result<PreparedOperation, ComposerStructureFailure> {
    let (target_index, node) = exact_node(projection, &target)?;
    let allowed = match node {
        ComposerDocumentNode::Message(node) => node.capabilities.replace_source,
        ComposerDocumentNode::Narration(node) => node.capabilities.replace_source,
        ComposerDocumentNode::Opaque(node) => node.capabilities.replace_source,
    };
    if !allowed {
        return Err(ComposerStructureFailure::UnsupportedStructure);
    }
    if replacement.is_empty()
        || replacement.len() > crate::composer::COMPOSER_STATEMENT_TEXT_MAX_BYTES
        || source.get(node.range().start..node.range().end) == Some(replacement.as_str())
    {
        return Err(ComposerStructureFailure::InvalidValue);
    }
    let before_syntax = replaceable_source_node(analysis, node.range())
        .ok_or(ComposerStructureFailure::UnsupportedStructure)?;
    let parsed = crate::parse_text(&replacement);
    if !parsed.diagnostics.is_empty()
        || parsed.nodes.len() != 1
        || !same_source_syntax_kind(before_syntax, &parsed.nodes[0])
    {
        return Err(ComposerStructureFailure::CandidateInvalid);
    }
    Ok(PreparedOperation {
        edit: ComposerSourceEdit {
            range: node.range(),
            new_text: replacement,
        },
        proof: OperationProof::ReplaceSource { target_index },
    })
}

fn same_source_syntax_kind(before: &SyntaxNode, after: &SyntaxNode) -> bool {
    match (before, after) {
        (SyntaxNode::Statement(before), SyntaxNode::Statement(after)) => before.kind == after.kind,
        (SyntaxNode::DirectiveLine(before), SyntaxNode::DirectiveLine(after)) => {
            before.name == after.name
        }
        (SyntaxNode::DirectiveBlock(before), SyntaxNode::DirectiveBlock(after)) => {
            before.name == after.name
        }
        (SyntaxNode::Reply(_), SyntaxNode::Reply(_))
        | (SyntaxNode::Bond(_), SyntaxNode::Bond(_)) => true,
        _ => false,
    }
}

fn prepare_move(
    source: &str,
    projection: &ComposerDocumentProjection,
    target: ComposerNodeRef,
    anchor: ComposerBoundaryTarget,
) -> Result<PreparedOperation, ComposerStructureFailure> {
    let (target_index, node) = exact_node(projection, &target)?;
    let targets = match node {
        ComposerDocumentNode::Message(node) => &node.capabilities.move_targets,
        ComposerDocumentNode::Narration(node) => &node.capabilities.move_targets,
        ComposerDocumentNode::Opaque(_) => {
            return Err(ComposerStructureFailure::UnsupportedStructure);
        }
    };
    if !targets.contains(&anchor) {
        return Err(ComposerStructureFailure::UnsupportedStructure);
    }
    let boundary_index = projection
        .boundaries
        .iter()
        .position(|boundary| boundary.target == anchor)
        .ok_or(ComposerStructureFailure::TargetChanged)?;
    let (start, end) = if boundary_index < target_index {
        (boundary_index, target_index + 1)
    } else {
        (target_index, boundary_index)
    };
    let nodes = &projection.nodes[start..end];
    let eol = nodes
        .iter()
        .find_map(|node| logical_payload(source, node.range()).ok()?.1)
        .ok_or(ComposerStructureFailure::UnsupportedStructure)?;
    let preserve_final_eol = logical_payload(source, nodes.last().unwrap().range())?
        .1
        .is_some();
    let mut replacement =
        String::with_capacity(nodes.last().unwrap().range().end - nodes[0].range().start);
    for position in start..end {
        let index = moved_node_index(position, target_index, boundary_index);
        replacement.push_str(logical_payload(source, projection.nodes[index].range())?.0);
        if position + 1 < end || preserve_final_eol {
            replacement.push_str(eol);
        }
    }
    Ok(PreparedOperation {
        edit: ComposerSourceEdit {
            range: TextRange::new(nodes[0].range().start, nodes.last().unwrap().range().end),
            new_text: replacement,
        },
        proof: OperationProof::Move {
            target_index,
            boundary_index,
        },
    })
}

fn moved_node_index(index: usize, target: usize, boundary: usize) -> usize {
    let destination = if boundary > target {
        boundary - 1
    } else {
        boundary
    };
    if index == destination {
        target
    } else if destination < target && destination < index && index <= target {
        index - 1
    } else if target < destination && target <= index && index < destination {
        index + 1
    } else {
        index
    }
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

fn prepare_set_side(
    source: &str,
    analysis: &AnalyzedDocument,
    projection: &ComposerDocumentProjection,
    target: ComposerNodeRef,
    side: ComposerMessageSide,
) -> Result<PreparedOperation, ComposerStructureFailure> {
    let (target_index, node) = exact_node(projection, &target)?;
    let ComposerDocumentNode::Message(message) = node else {
        return Err(ComposerStructureFailure::UnsupportedStructure);
    };
    if !message.capabilities.set_side.contains(&side) {
        return Err(ComposerStructureFailure::UnsupportedStructure);
    }
    if message.side == side {
        return Err(ComposerStructureFailure::InvalidValue);
    }
    let statement = exact_statement(analysis, message.statement_range)
        .ok_or(ComposerStructureFailure::TargetChanged)?;
    let expected = match message.side {
        ComposerMessageSide::Left => ">",
        ComposerMessageSide::Right => "<",
    };
    let sigil_range = TextRange::new(statement.range.start, statement.range.start + 1);
    if source.get(sigil_range.start..sigil_range.end) != Some(expected) {
        return Err(ComposerStructureFailure::TargetChanged);
    }
    let sigil = match side {
        ComposerMessageSide::Left => ">",
        ComposerMessageSide::Right => "<",
    };
    let mut edit = ComposerSourceEdit {
        range: sigil_range,
        new_text: sigil.to_owned(),
    };
    // History markers are side-local. Pin only this statement's already-resolved
    // actor before changing side; candidate proof still rejects neighbor drift.
    if let Some(ComposerSpeakerDescription::Actor { reference, .. }) = &message.description.speaker
    {
        let reference = validate_speaker_reference(reference)?;
        match &statement.marker {
            Some(SpeakerMarkerSyntax::Explicit { .. }) => {}
            Some(SpeakerMarkerSyntax::BackRef { range, .. })
            | Some(SpeakerMarkerSyntax::UniqueIndex { range, .. }) => {
                let middle = source
                    .get(sigil_range.end..range.start)
                    .ok_or(ComposerStructureFailure::TargetChanged)?;
                edit = ComposerSourceEdit {
                    range: TextRange::new(sigil_range.start, range.end),
                    new_text: format!("{sigil}{middle}{reference}"),
                };
            }
            None => {
                let header_end = statement
                    .patch
                    .as_ref()
                    .map_or(sigil_range.end, |patch| patch.range.end);
                let remainder = source
                    .get(header_end..statement.range.end)
                    .ok_or(ComposerStructureFailure::TargetChanged)?;
                let whitespace = remainder.len() - remainder.trim_start_matches([' ', '\t']).len();
                let insertion = header_end + whitespace;
                let middle = source
                    .get(sigil_range.end..insertion)
                    .ok_or(ComposerStructureFailure::TargetChanged)?;
                edit = ComposerSourceEdit {
                    range: TextRange::new(sigil_range.start, insertion),
                    new_text: format!("{sigil}{middle}{reference}: "),
                };
            }
        }
    }
    Ok(PreparedOperation {
        edit,
        proof: OperationProof::SetSide { target_index, side },
    })
}

fn serialize_new_statement(
    statement: &ComposerNewStatement,
    eol: &str,
) -> Result<String, ComposerStructureFailure> {
    match statement {
        ComposerNewStatement::Message {
            side,
            speaker,
            body,
            continued,
            ..
        } => {
            let reference = match speaker {
                ComposerNewStatementSpeaker::Actor { reference } => {
                    validate_speaker_reference(reference)?
                }
                ComposerNewStatementSpeaker::Builtin => "_0",
            };
            let sigil = match side {
                ComposerMessageSide::Left => '>',
                ComposerMessageSide::Right => '<',
            };
            let patch = match continued {
                ContinuedValue::Auto => "",
                ContinuedValue::True => "(continued: true)",
                ContinuedValue::False => "(continued: false)",
            };
            let mut serialized =
                String::with_capacity(reference.len() + patch.len() + body.value.len() + 32);
            serialized.push(sigil);
            serialized.push_str(patch);
            serialized.push(' ');
            serialized.push_str(reference);
            serialized.push_str(": ");
            let body = serialize_statement_body(&body.value, body.mode, eol, None, &serialized)
                .map_err(map_composer_failure)?;
            serialized.push_str(&body);
            Ok(serialized)
        }
        ComposerNewStatement::Narration { body } => {
            let body = serialize_statement_body(&body.value, body.mode, eol, None, "- ")
                .map_err(map_composer_failure)?;
            Ok(format!("- {body}"))
        }
        ComposerNewStatement::Media { .. } => Err(ComposerStructureFailure::InvalidValue),
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
    prefix_nodes: usize,
    requested: &ComposerNewStatement,
) -> bool {
    if after.nodes.len() != before.nodes.len() + 1 + prefix_nodes
        || boundary_index + prefix_nodes >= after.nodes.len()
        || after.nodes[boundary_index..boundary_index + prefix_nodes]
            .iter()
            .any(|node| {
                !matches!(node, ComposerDocumentNode::Opaque(node)
                if node.category == crate::composer_document::ComposerOpaqueCategory::Directive)
            })
    {
        return false;
    }
    let separator = (boundary_index == before.nodes.len())
        .then(|| eof_insert_separator(before_source))
        .flatten();
    for index in 0..before.nodes.len() {
        let after_index = if index < boundary_index {
            index
        } else {
            index + 1 + prefix_nodes
        };
        if index + 1 == before.nodes.len() {
            if let Some(separator) = separator {
                let left = &before.nodes[index];
                let right = &after.nodes[after_index];
                if right.range().start != left.range().start
                    || right.range().end != left.range().end + separator.len()
                    || before_source.get(left.range().start..left.range().end)
                        != after_source.get(right.range().start..left.range().end)
                    || after_source.get(left.range().end..right.range().end) != Some(separator)
                    || !same_node_semantics(left, right)
                {
                    return false;
                }
                continue;
            }
        }
        if !same_node_exact_and_semantic(
            before_source,
            &before.nodes[index],
            after_source,
            &after.nodes[after_index],
        ) {
            return false;
        }
    }
    inserted_node_matches(&after.nodes[boundary_index + prefix_nodes], requested)
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

fn prove_replace_source(
    before_source: &str,
    before: &ComposerDocumentProjection,
    after_source: &str,
    after: &ComposerDocumentProjection,
    target_index: usize,
    edit: &ComposerSourceEdit,
) -> bool {
    if before.nodes.len() != after.nodes.len()
        || target_index >= after.nodes.len()
        || after.nodes[target_index].range()
            != TextRange::new(edit.range.start, edit.range.start + edit.new_text.len())
    {
        return false;
    }
    before
        .nodes
        .iter()
        .zip(&after.nodes)
        .enumerate()
        .all(|(index, (left, right))| {
            if index == target_index {
                left.kind() == right.kind()
            } else {
                let expected_start = if index < target_index {
                    left.range().start
                } else {
                    left.range().start - edit.range.len() + edit.new_text.len()
                };
                right.range().start == expected_start
                    && same_node_exact_and_semantic(before_source, left, after_source, right)
            }
        })
}

fn prove_move(
    before_source: &str,
    before: &ComposerDocumentProjection,
    after_source: &str,
    after: &ComposerDocumentProjection,
    target_index: usize,
    boundary_index: usize,
) -> bool {
    if before.nodes.len() != after.nodes.len()
        || target_index >= before.nodes.len()
        || boundary_index > before.nodes.len()
        || boundary_index == target_index
        || boundary_index == target_index + 1
    {
        return false;
    }
    after.nodes.iter().enumerate().all(|(index, after_node)| {
        let before_index = moved_node_index(index, target_index, boundary_index);
        same_logical_node_exact_and_semantic(
            before_source,
            &before.nodes[before_index],
            after_source,
            after_node,
        )
    })
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

fn prove_set_side(
    before_source: &str,
    before: &ComposerDocumentProjection,
    after_source: &str,
    after: &ComposerDocumentProjection,
    target_index: usize,
    requested: ComposerMessageSide,
) -> bool {
    if before.nodes.len() != after.nodes.len() || target_index >= before.nodes.len() {
        return false;
    }
    before
        .nodes
        .iter()
        .zip(&after.nodes)
        .enumerate()
        .all(|(index, (left, right))| {
            if index == target_index {
                matches!((left, right),
                (ComposerDocumentNode::Message(left), ComposerDocumentNode::Message(right))
                if right.side == requested && left.description == right.description)
            } else {
                same_node_exact_and_semantic(before_source, left, after_source, right)
            }
        })
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
                ..
            },
        ) => {
            node.side == *side
                && node.description.body.current == body.value
                && node.description.body.mode == body.mode
                && node.description.continued == Some(*continued)
                && match speaker {
                    ComposerNewStatementSpeaker::Actor { reference } => {
                        actor_speaker_matches(node.description.speaker.as_ref(), reference)
                    }
                    ComposerNewStatementSpeaker::Builtin => matches!(
                        node.description.speaker.as_ref(),
                        Some(ComposerSpeakerDescription::Builtin { id }) if id == "__Sensei"
                    ),
                }
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
    actor_speaker_matches(speaker, requested.reference())
}

fn actor_speaker_matches(speaker: Option<&ComposerSpeakerDescription>, requested: &str) -> bool {
    let Some(ComposerSpeakerDescription::Actor {
        reference,
        preset_id,
        ..
    }) = speaker
    else {
        return false;
    };
    requested == reference || requested == preset_id
}

pub(crate) fn same_node_exact_and_semantic(
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

pub(crate) fn same_node_semantics(
    left: &ComposerDocumentNode,
    right: &ComposerDocumentNode,
) -> bool {
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
