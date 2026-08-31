use std::collections::HashMap;

use lsp_types::{
    CompletionItem, CompletionOptions, CompletionParams, Diagnostic, DidChangeTextDocumentParams,
    DidCloseTextDocumentParams, DidOpenTextDocumentParams, DocumentSymbolParams,
    FoldingRangeParams, FoldingRangeProviderCapability, GotoDefinitionParams, Hover,
    HoverProviderCapability, InitializeParams, InitializeResult, InlayHintParams, Location,
    LogMessageParams, MessageType, OneOf, Position, PositionEncodingKind, PublishDiagnosticsParams,
    Range, ReferenceParams, RenameOptions, RenameParams, SemanticTokenType,
    SemanticTokensFullOptions, SemanticTokensLegend, SemanticTokensOptions, SemanticTokensParams,
    SemanticTokensServerCapabilities, ServerCapabilities, ServerInfo, SignatureHelpOptions,
    TextDocumentIdentifier, TextDocumentPositionParams, TextDocumentSyncCapability,
    TextDocumentSyncKind, Url,
};
use mmt_rs::{
    COMPOSER_SPEAKER_REFERENCE_MAX_BYTES, COMPOSER_STATEMENT_TEXT_MAX_BYTES, ComposerAvatarCurrent,
    ComposerBodyMode, ComposerBoundaryTarget, ComposerCommand, ComposerDocumentNode,
    ComposerDocumentNodeKind, ComposerInsertCapability, ComposerMessageCapabilities,
    ComposerMessageSide, ComposerNarrationCapabilities, ComposerNewStatement, ComposerNodeRef,
    ComposerOpaqueCategory, ComposerSpeakerChoice, ComposerSpeakerDescription,
    ComposerSpeakerSource, ComposerStatementBody, ComposerStatementBodyInput,
    ComposerStatementText, ComposerStructureCommand, ComposerStructureTarget, ContinuedValue,
    PackAvatarChoice, ProjectedEditTarget, ProjectedEditTransaction, ProjectedTargetClass,
    ProjectionKey, SourceContentKey, StatementTextMode, TypstProjectSnapshotKey,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    LanguageService, ProjectionStore, TypstRenderProjectUpdate,
    position::{MmtClientPosition, PositionEncoding},
    service::{ComposerDocumentRejection, ComposerEditRejection},
    typst_backend::ComposerTargetUnavailable,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypstPositionParams {
    text_document: TextDocumentIdentifier,
    position: Position,
    backend_encoding: PositionEncoding,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SemanticRouteParams {
    text_document: TextDocumentIdentifier,
    position: Position,
    version: i32,
    backend_encoding: PositionEncoding,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypstRangeParams {
    text_document: TextDocumentIdentifier,
    range: Range,
    backend_encoding: PositionEncoding,
    #[serde(default)]
    entry_uri: Option<Url>,
    #[serde(default)]
    revision: Option<u64>,
    #[serde(default)]
    source_content: Option<SourceContentKey>,
    #[serde(default)]
    project_digest: Option<TypstProjectSnapshotKey>,
    #[serde(default)]
    projection_key: Option<ProjectionKey>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapTypstCompletionParams {
    source_uri: Url,
    revision: u64,
    entry_uri: Url,
    backend_encoding: PositionEncoding,
    source_content: SourceContentKey,
    project_digest: TypstProjectSnapshotKey,
    projection_key: ProjectionKey,
    items: Vec<CompletionItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapTypstHoverParams {
    source_uri: Url,
    revision: u64,
    entry_uri: Url,
    backend_encoding: PositionEncoding,
    source_content: SourceContentKey,
    project_digest: TypstProjectSnapshotKey,
    projection_key: ProjectionKey,
    hover: Hover,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapTypstDiagnosticsParams {
    source_uri: Url,
    revision: u64,
    entry_uri: Url,
    backend_encoding: PositionEncoding,
    source_content: SourceContentKey,
    project_digest: TypstProjectSnapshotKey,
    projection_key: ProjectionKey,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapTypstReadLocationsParams {
    source_uri: Url,
    revision: u64,
    entry_uri: Url,
    backend_encoding: PositionEncoding,
    source_content: SourceContentKey,
    project_digest: TypstProjectSnapshotKey,
    projection_key: ProjectionKey,
    locations: Vec<Location>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetTypstProjectParams {
    uri: Url,
    #[serde(default)]
    timestamp: Option<mmt_rs::HostTimestamp>,
    #[serde(default)]
    trace_id: Option<String>,
    #[serde(default)]
    base_revision: Option<u64>,
    #[serde(default)]
    base_project_digest: Option<TypstProjectSnapshotKey>,
    #[serde(default)]
    force_full: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePackManifestsParams {
    revision: u64,
    sources: Vec<PackManifestSourceParams>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackManifestSourceParams {
    json: String,
    base_url: Option<Url>,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ComposerPosition {
    line: u32,
    character: u32,
}

impl From<ComposerPosition> for Position {
    fn from(position: ComposerPosition) -> Self {
        Position::new(position.line, position.character)
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ComposerRange {
    start: ComposerPosition,
    end: ComposerPosition,
}

impl From<ComposerRange> for Range {
    fn from(range: ComposerRange) -> Self {
        Range::new(range.start.into(), range.end.into())
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PreviewComposerLocation {
    uri: Url,
    range: ComposerRange,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PreviewComposerTargetParams {
    source_uri: Url,
    revision: u64,
    source_content: SourceContentKey,
    project_digest: TypstProjectSnapshotKey,
    projection_key: ProjectionKey,
    entry_uri: Url,
    backend_encoding: PositionEncoding,
    location: PreviewComposerLocation,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ComposerTextDocumentParams {
    uri: Url,
    version: i32,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ComposerDocumentParams {
    text_document: ComposerTextDocumentParams,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
enum ComposerTargetParams {
    #[serde(rename = "statement")]
    Statement { range: ComposerRange },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ComposerContinuedValue {
    Auto,
    True,
    False,
}

impl From<ComposerContinuedValue> for ContinuedValue {
    fn from(value: ComposerContinuedValue) -> Self {
        match value {
            ComposerContinuedValue::Auto => ContinuedValue::Auto,
            ComposerContinuedValue::True => ContinuedValue::True,
            ComposerContinuedValue::False => ContinuedValue::False,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
enum ComposerAvatarChoiceParams {
    #[serde(rename = "packAvatar")]
    PackAvatar {
        #[serde(rename = "entityId")]
        entity_id: String,
        #[serde(rename = "contributionNamespace")]
        contribution_namespace: String,
        #[serde(rename = "variantId")]
        variant_id: String,
    },
}

impl ComposerAvatarChoiceParams {
    fn components(&self) -> (&str, &str, &str) {
        match self {
            Self::PackAvatar {
                entity_id,
                contribution_namespace,
                variant_id,
            } => (entity_id, contribution_namespace, variant_id),
        }
    }
}

impl From<ComposerAvatarChoiceParams> for PackAvatarChoice {
    fn from(choice: ComposerAvatarChoiceParams) -> Self {
        match choice {
            ComposerAvatarChoiceParams::PackAvatar {
                entity_id,
                contribution_namespace,
                variant_id,
            } => Self {
                entity_id,
                contribution_namespace,
                variant_id,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ComposerStatementTextModeParams {
    Inherit,
    TextMacro,
    TextRaw,
    TypstMacro,
    TypstRaw,
}

impl From<ComposerStatementTextModeParams> for StatementTextMode {
    fn from(mode: ComposerStatementTextModeParams) -> Self {
        match mode {
            ComposerStatementTextModeParams::Inherit => Self::Inherit,
            ComposerStatementTextModeParams::TextMacro => Self::TextMacro,
            ComposerStatementTextModeParams::TextRaw => Self::TextRaw,
            ComposerStatementTextModeParams::TypstMacro => Self::TypstMacro,
            ComposerStatementTextModeParams::TypstRaw => Self::TypstRaw,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
enum ComposerCommandParams {
    #[serde(rename = "setStatementContinued")]
    SetStatementContinued { value: ComposerContinuedValue },
    #[serde(rename = "setActorDisplayNameFromStatement")]
    SetActorDisplayNameFromStatement { value: String },
    #[serde(rename = "setActorAvatarFromStatement")]
    SetActorAvatarFromStatement { avatar: ComposerAvatarChoiceParams },
    #[serde(rename = "setStatementBody")]
    SetStatementBody {
        value: String,
        mode: ComposerStatementTextModeParams,
    },
}

impl From<ComposerCommandParams> for ComposerCommand {
    fn from(command: ComposerCommandParams) -> Self {
        match command {
            ComposerCommandParams::SetStatementContinued { value } => {
                ComposerCommand::SetStatementContinued(value.into())
            }
            ComposerCommandParams::SetActorDisplayNameFromStatement { value } => {
                ComposerCommand::SetActorDisplayNameFromStatement(value)
            }
            ComposerCommandParams::SetActorAvatarFromStatement { avatar } => {
                ComposerCommand::SetActorAvatarFromStatement(avatar.into())
            }
            ComposerCommandParams::SetStatementBody { value, mode } => {
                ComposerCommand::SetStatementBody {
                    value,
                    mode: mode.into(),
                }
            }
        }
    }
}
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ComposerPropertyEditParams {
    text_document: ComposerTextDocumentParams,
    target: ComposerTargetParams,
    command: ComposerCommandParams,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ComposerNodeKindParams {
    Message,
    Narration,
    Opaque,
}

impl From<ComposerNodeKindParams> for ComposerDocumentNodeKind {
    fn from(kind: ComposerNodeKindParams) -> Self {
        match kind {
            ComposerNodeKindParams::Message => Self::Message,
            ComposerNodeKindParams::Narration => Self::Narration,
            ComposerNodeKindParams::Opaque => Self::Opaque,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ComposerNodeRefParams {
    node_key: String,
    node_kind: ComposerNodeKindParams,
    range: ComposerRange,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
enum ComposerBoundaryTargetParams {
    #[serde(rename = "boundary")]
    Boundary {
        before: Option<ComposerNodeRefParams>,
        after: Option<ComposerNodeRefParams>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
enum ComposerStructureTargetParams {
    #[serde(rename = "node")]
    Node { node: ComposerNodeRefParams },
    #[serde(rename = "boundary")]
    Boundary {
        before: Option<ComposerNodeRefParams>,
        after: Option<ComposerNodeRefParams>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
enum ComposerSpeakerChoiceParams {
    #[serde(rename = "actor")]
    Actor { reference: String },
}

impl From<ComposerSpeakerChoiceParams> for ComposerSpeakerChoice {
    fn from(choice: ComposerSpeakerChoiceParams) -> Self {
        match choice {
            ComposerSpeakerChoiceParams::Actor { reference } => Self::Actor { reference },
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ComposerStatementBodyInputParams {
    value: String,
    mode: ComposerStatementTextModeParams,
}

impl From<ComposerStatementBodyInputParams> for ComposerStatementBodyInput {
    fn from(body: ComposerStatementBodyInputParams) -> Self {
        Self {
            value: body.value,
            mode: body.mode.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
enum ComposerNewStatementParams {
    #[serde(rename = "message")]
    Message {
        side: ComposerMessageSideParams,
        speaker: ComposerSpeakerChoiceParams,
        body: ComposerStatementBodyInputParams,
        continued: ComposerContinuedValue,
    },
    #[serde(rename = "narration")]
    Narration {
        body: ComposerStatementBodyInputParams,
    },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ComposerMessageSideParams {
    Left,
    Right,
}

impl From<ComposerMessageSideParams> for ComposerMessageSide {
    fn from(side: ComposerMessageSideParams) -> Self {
        match side {
            ComposerMessageSideParams::Left => Self::Left,
            ComposerMessageSideParams::Right => Self::Right,
        }
    }
}

impl From<ComposerNewStatementParams> for ComposerNewStatement {
    fn from(statement: ComposerNewStatementParams) -> Self {
        match statement {
            ComposerNewStatementParams::Message {
                side,
                speaker,
                body,
                continued,
            } => Self::Message {
                side: side.into(),
                speaker: speaker.into(),
                body: body.into(),
                continued: continued.into(),
            },
            ComposerNewStatementParams::Narration { body } => Self::Narration { body: body.into() },
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, tag = "kind")]
enum ComposerStructureCommandParams {
    #[serde(rename = "insertStatement")]
    InsertStatement {
        statement: ComposerNewStatementParams,
    },
    #[serde(rename = "deleteNode")]
    DeleteNode,
    #[serde(rename = "moveNode")]
    MoveNode {
        anchor: ComposerBoundaryTargetParams,
    },
    #[serde(rename = "setStatementSpeaker")]
    SetStatementSpeaker {
        speaker: ComposerSpeakerChoiceParams,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ComposerStructureEditParams {
    text_document: ComposerTextDocumentParams,
    source_digest: String,
    target: ComposerStructureTargetParams,
    command: ComposerStructureCommandParams,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ComposerEditParams {
    Property(ComposerPropertyEditParams),
    Structure(ComposerStructureEditParams),
}

const MAX_COMPOSER_DISPLAY_NAME_BYTES: usize = 1024;
const MAX_COMPOSER_AVATAR_COMPONENT_BYTES: usize = 1024;
const CANONICAL_DIGEST_HEX_LEN: usize = 64;

fn validate_composer_digest(value: &str, field: &str) -> Result<(), ServerError> {
    if value.len() != CANONICAL_DIGEST_HEX_LEN
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ServerError::invalid_params(format!(
            "{field} must be a lowercase SHA-256 digest"
        )));
    }
    Ok(())
}

fn validate_preview_composer_identity(
    params: &PreviewComposerTargetParams,
) -> Result<(), ServerError> {
    validate_composer_digest(&params.source_content.0, "sourceContent")?;
    validate_composer_digest(&params.project_digest.0, "projectDigest")?;
    validate_composer_digest(&params.projection_key.0, "projectionKey")
}

fn validate_composer_command(command: &ComposerCommandParams) -> Result<(), ServerError> {
    match command {
        ComposerCommandParams::SetActorDisplayNameFromStatement { value }
            if value.len() > MAX_COMPOSER_DISPLAY_NAME_BYTES =>
        {
            Err(ServerError::invalid_params(format!(
                "display-name value exceeds {MAX_COMPOSER_DISPLAY_NAME_BYTES} UTF-8 bytes"
            )))
        }
        ComposerCommandParams::SetStatementBody { value, .. }
            if value.is_empty()
                || value.len() > COMPOSER_STATEMENT_TEXT_MAX_BYTES
                || value.contains(['\r', '\n']) =>
        {
            Err(ServerError::invalid_params(format!(
                "statement text must be 1-{COMPOSER_STATEMENT_TEXT_MAX_BYTES} UTF-8 bytes on one line"
            )))
        }
        ComposerCommandParams::SetActorAvatarFromStatement { avatar } => {
            let (entity_id, contribution_namespace, variant_id) = avatar.components();
            validate_avatar_component(entity_id, "entityId")?;
            validate_avatar_component(contribution_namespace, "contributionNamespace")?;
            validate_avatar_component(variant_id, "variantId")?;
            let mut entity_parts = entity_id.split("::");
            if entity_parts.next().is_none_or(str::is_empty)
                || entity_parts.next().is_none_or(str::is_empty)
                || entity_parts.next().is_some()
            {
                return Err(ServerError::invalid_params(
                    "entityId must be one canonical namespace::id",
                ));
            }
            if contribution_namespace.contains("::") {
                return Err(ServerError::invalid_params(
                    "contributionNamespace must not contain ::",
                ));
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn validate_composer_structure(params: &ComposerStructureEditParams) -> Result<(), ServerError> {
    validate_composer_digest(&params.source_digest, "sourceDigest")?;
    validate_structure_target(&params.target)?;
    match (&params.target, &params.command) {
        (
            ComposerStructureTargetParams::Boundary { .. },
            ComposerStructureCommandParams::InsertStatement { statement },
        ) => validate_new_statement(statement),
        (
            ComposerStructureTargetParams::Node { .. },
            ComposerStructureCommandParams::DeleteNode,
        ) => Ok(()),
        (
            ComposerStructureTargetParams::Node { .. },
            ComposerStructureCommandParams::MoveNode { anchor },
        ) => validate_boundary_target(anchor),
        (
            ComposerStructureTargetParams::Node { .. },
            ComposerStructureCommandParams::SetStatementSpeaker { speaker },
        ) => validate_speaker_choice(speaker),
        _ => Err(ServerError::invalid_params(
            "Composer structure target and command kinds do not match",
        )),
    }
}

fn validate_structure_target(target: &ComposerStructureTargetParams) -> Result<(), ServerError> {
    match target {
        ComposerStructureTargetParams::Node { node } => validate_node_ref(node),
        ComposerStructureTargetParams::Boundary { before, after } => {
            validate_boundary_refs(before.as_ref(), after.as_ref())
        }
    }
}

fn validate_boundary_target(target: &ComposerBoundaryTargetParams) -> Result<(), ServerError> {
    let ComposerBoundaryTargetParams::Boundary { before, after } = target;
    validate_boundary_refs(before.as_ref(), after.as_ref())
}

fn validate_boundary_refs(
    before: Option<&ComposerNodeRefParams>,
    after: Option<&ComposerNodeRefParams>,
) -> Result<(), ServerError> {
    if let Some(node) = before {
        validate_node_ref(node)?;
    }
    if let Some(node) = after {
        validate_node_ref(node)?;
    }
    Ok(())
}

fn validate_node_ref(node: &ComposerNodeRefParams) -> Result<(), ServerError> {
    validate_composer_digest(&node.node_key, "nodeKey")
}

fn validate_new_statement(statement: &ComposerNewStatementParams) -> Result<(), ServerError> {
    match statement {
        ComposerNewStatementParams::Message { speaker, body, .. } => {
            validate_speaker_choice(speaker)?;
            validate_statement_body_input(body)
        }
        ComposerNewStatementParams::Narration { body } => validate_statement_body_input(body),
    }
}

fn validate_statement_body_input(
    body: &ComposerStatementBodyInputParams,
) -> Result<(), ServerError> {
    if body.value.is_empty()
        || body.value.len() > COMPOSER_STATEMENT_TEXT_MAX_BYTES
        || body.value.contains(['\r', '\n'])
    {
        return Err(ServerError::invalid_params(format!(
            "statement text must be 1-{COMPOSER_STATEMENT_TEXT_MAX_BYTES} UTF-8 bytes on one line"
        )));
    }
    Ok(())
}

fn validate_speaker_choice(choice: &ComposerSpeakerChoiceParams) -> Result<(), ServerError> {
    let ComposerSpeakerChoiceParams::Actor { reference } = choice;
    if reference.is_empty()
        || reference.len() > COMPOSER_SPEAKER_REFERENCE_MAX_BYTES
        || reference.trim() != reference
        || reference.contains(['\r', '\n'])
        || reference.chars().any(char::is_control)
    {
        return Err(ServerError::invalid_params(format!(
            "speaker reference must be 1-{COMPOSER_SPEAKER_REFERENCE_MAX_BYTES} UTF-8 bytes without surrounding whitespace, newlines or controls"
        )));
    }
    Ok(())
}

fn structure_node_ref(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
    node: ComposerNodeRefParams,
) -> Result<ComposerNodeRef, ServerError> {
    Ok(ComposerNodeRef {
        node_key: node.node_key,
        node_kind: node.node_kind.into(),
        range: snapshot
            .text_range(node.range.into())
            .ok_or_else(|| ServerError::invalid_params("Composer node range is invalid"))?,
    })
}

fn structure_boundary_target(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
    target: ComposerBoundaryTargetParams,
) -> Result<ComposerBoundaryTarget, ServerError> {
    let ComposerBoundaryTargetParams::Boundary { before, after } = target;
    Ok(ComposerBoundaryTarget {
        before: before
            .map(|node| structure_node_ref(snapshot, node))
            .transpose()?,
        after: after
            .map(|node| structure_node_ref(snapshot, node))
            .transpose()?,
    })
}

fn structure_target(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
    target: ComposerStructureTargetParams,
) -> Result<ComposerStructureTarget, ServerError> {
    match target {
        ComposerStructureTargetParams::Node { node } => Ok(ComposerStructureTarget::Node(
            structure_node_ref(snapshot, node)?,
        )),
        ComposerStructureTargetParams::Boundary { before, after } => {
            Ok(ComposerStructureTarget::Boundary(ComposerBoundaryTarget {
                before: before
                    .map(|node| structure_node_ref(snapshot, node))
                    .transpose()?,
                after: after
                    .map(|node| structure_node_ref(snapshot, node))
                    .transpose()?,
            }))
        }
    }
}

fn structure_command(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
    command: ComposerStructureCommandParams,
) -> Result<ComposerStructureCommand, ServerError> {
    Ok(match command {
        ComposerStructureCommandParams::InsertStatement { statement } => {
            ComposerStructureCommand::InsertStatement {
                statement: statement.into(),
            }
        }
        ComposerStructureCommandParams::DeleteNode => ComposerStructureCommand::DeleteNode,
        ComposerStructureCommandParams::MoveNode { anchor } => ComposerStructureCommand::MoveNode {
            anchor: structure_boundary_target(snapshot, anchor)?,
        },
        ComposerStructureCommandParams::SetStatementSpeaker { speaker } => {
            ComposerStructureCommand::SetStatementSpeaker {
                speaker: speaker.into(),
            }
        }
    })
}

fn validate_avatar_component(value: &str, field: &str) -> Result<(), ServerError> {
    if value.is_empty()
        || value.len() > MAX_COMPOSER_AVATAR_COMPONENT_BYTES
        || value.chars().any(char::is_whitespace)
        || value.chars().any(char::is_control)
        || value.contains(['/', '\\'])
    {
        return Err(ServerError::invalid_params(format!(
            "{field} must be 1-{MAX_COMPOSER_AVATAR_COMPONENT_BYTES} UTF-8 bytes without whitespace, controls, slash or backslash"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerTextDocumentResult {
    uri: Url,
    version: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
enum ComposerTargetResult {
    #[serde(rename = "statement")]
    Statement { range: Range },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum ComposerContinuedResult {
    Auto,
    True,
    False,
}

impl From<ContinuedValue> for ComposerContinuedResult {
    fn from(value: ContinuedValue) -> Self {
        match value {
            ContinuedValue::Auto => ComposerContinuedResult::Auto,
            ContinuedValue::True => ComposerContinuedResult::True,
            ContinuedValue::False => ComposerContinuedResult::False,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerActorDisplayNameResult {
    current: String,
    scope: ComposerActorDisplayNameScope,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComposerActorDisplayNameScope {
    FromStatement,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
enum ComposerAvatarCurrentResult {
    #[serde(rename = "packAvatar")]
    PackAvatar {
        #[serde(rename = "entityId")]
        entity_id: String,
        #[serde(rename = "contributionNamespace")]
        contribution_namespace: String,
        #[serde(rename = "variantId")]
        variant_id: String,
    },
    #[serde(rename = "asset")]
    Asset {
        #[serde(rename = "assetName")]
        asset_name: String,
    },
}

impl From<ComposerAvatarCurrent> for ComposerAvatarCurrentResult {
    fn from(current: ComposerAvatarCurrent) -> Self {
        match current {
            ComposerAvatarCurrent::Pack(choice) => Self::PackAvatar {
                entity_id: choice.entity_id,
                contribution_namespace: choice.contribution_namespace,
                variant_id: choice.variant_id,
            },
            ComposerAvatarCurrent::Asset(asset_name) => Self::Asset { asset_name },
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComposerActorAvatarScope {
    FromStatement,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerActorAvatarResult {
    scope: ComposerActorAvatarScope,
    actor_preset_id: String,
    current: Option<ComposerAvatarCurrentResult>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComposerStatementTextModeResult {
    Inherit,
    TextMacro,
    TextRaw,
    TypstMacro,
    TypstRaw,
}

impl From<StatementTextMode> for ComposerStatementTextModeResult {
    fn from(mode: StatementTextMode) -> Self {
        match mode {
            StatementTextMode::Inherit => Self::Inherit,
            StatementTextMode::TextMacro => Self::TextMacro,
            StatementTextMode::TextRaw => Self::TextRaw,
            StatementTextMode::TypstMacro => Self::TypstMacro,
            StatementTextMode::TypstRaw => Self::TypstRaw,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComposerBodyModeResult {
    TextMacro,
    TextRaw,
    TypstMacro,
    TypstRaw,
}

impl From<ComposerBodyMode> for ComposerBodyModeResult {
    fn from(mode: ComposerBodyMode) -> Self {
        match mode {
            ComposerBodyMode::TextMacro => Self::TextMacro,
            ComposerBodyMode::TextRaw => Self::TextRaw,
            ComposerBodyMode::TypstMacro => Self::TypstMacro,
            ComposerBodyMode::TypstRaw => Self::TypstRaw,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerStatementTextResult {
    current: String,
    mode: ComposerStatementTextModeResult,
    resolved_mode: ComposerBodyModeResult,
    inherited_mode: ComposerBodyModeResult,
}

impl From<ComposerStatementText> for ComposerStatementTextResult {
    fn from(statement_text: ComposerStatementText) -> Self {
        Self {
            current: statement_text.current,
            mode: statement_text.mode.into(),
            resolved_mode: statement_text.resolved_mode.into(),
            inherited_mode: statement_text.inherited_mode.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerPropertiesResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    continued: Option<ComposerContinuedResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    actor_display_name: Option<ComposerActorDisplayNameResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    actor_avatar: Option<ComposerActorAvatarResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    statement_text: Option<ComposerStatementTextResult>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum PreviewComposerUnavailableReason {
    StalePreview,
    NonMmtSource,
    Unmapped,
    AmbiguousOrigin,
    UnsupportedNode,
    DocumentHasErrors,
    ActorUnavailable,
}

impl From<ComposerTargetUnavailable> for PreviewComposerUnavailableReason {
    fn from(reason: ComposerTargetUnavailable) -> Self {
        match reason {
            ComposerTargetUnavailable::StalePreview => Self::StalePreview,
            ComposerTargetUnavailable::NonMmtSource => Self::NonMmtSource,
            ComposerTargetUnavailable::Unmapped => Self::Unmapped,
            ComposerTargetUnavailable::AmbiguousOrigin => Self::AmbiguousOrigin,
            ComposerTargetUnavailable::UnsupportedNode => Self::UnsupportedNode,
            ComposerTargetUnavailable::DocumentHasErrors => Self::DocumentHasErrors,
            ComposerTargetUnavailable::ActorUnavailable => Self::ActorUnavailable,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
enum PreviewComposerTargetResult {
    Editable {
        #[serde(rename = "textDocument")]
        text_document: ComposerTextDocumentResult,
        target: ComposerTargetResult,
        properties: ComposerPropertiesResult,
    },
    Unavailable {
        reason: PreviewComposerUnavailableReason,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComposerEditRejectedReason {
    StaleDocument,
    TargetChanged,
    DocumentHasErrors,
    InvalidValue,
    ActorUnavailable,
    AvatarUnavailable,
    CandidateInvalid,
    UnsupportedStructure,
    SpeakerUnavailable,
}

impl From<ComposerEditRejection> for ComposerEditRejectedReason {
    fn from(reason: ComposerEditRejection) -> Self {
        match reason {
            ComposerEditRejection::StaleDocument => Self::StaleDocument,
            ComposerEditRejection::TargetChanged => Self::TargetChanged,
            ComposerEditRejection::DocumentHasErrors => Self::DocumentHasErrors,
            ComposerEditRejection::InvalidValue => Self::InvalidValue,
            ComposerEditRejection::ActorUnavailable => Self::ActorUnavailable,
            ComposerEditRejection::AvatarUnavailable => Self::AvatarUnavailable,
            ComposerEditRejection::CandidateInvalid => Self::CandidateInvalid,
            ComposerEditRejection::UnsupportedStructure => Self::UnsupportedStructure,
            ComposerEditRejection::SpeakerUnavailable => Self::SpeakerUnavailable,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
enum ComposerEditResult {
    Edit { edit: lsp_types::WorkspaceEdit },
    Rejected { reason: ComposerEditRejectedReason },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComposerDocumentRejectedReason {
    StaleDocument,
    DocumentUnavailable,
}

impl From<ComposerDocumentRejection> for ComposerDocumentRejectedReason {
    fn from(reason: ComposerDocumentRejection) -> Self {
        match reason {
            ComposerDocumentRejection::StaleDocument => Self::StaleDocument,
            ComposerDocumentRejection::DocumentUnavailable => Self::DocumentUnavailable,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComposerNodeKindResult {
    Message,
    Narration,
    Opaque,
}

impl From<ComposerDocumentNodeKind> for ComposerNodeKindResult {
    fn from(kind: ComposerDocumentNodeKind) -> Self {
        match kind {
            ComposerDocumentNodeKind::Message => Self::Message,
            ComposerDocumentNodeKind::Narration => Self::Narration,
            ComposerDocumentNodeKind::Opaque => Self::Opaque,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerNodeRefResult {
    node_key: String,
    node_kind: ComposerNodeKindResult,
    range: Range,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerBoundaryTargetResult {
    kind: &'static str,
    before: Option<ComposerNodeRefResult>,
    after: Option<ComposerNodeRefResult>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComposerMessageSideResult {
    Left,
    Right,
}

impl From<ComposerMessageSide> for ComposerMessageSideResult {
    fn from(side: ComposerMessageSide) -> Self {
        match side {
            ComposerMessageSide::Left => Self::Left,
            ComposerMessageSide::Right => Self::Right,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComposerOpaqueCategoryResult {
    Blank,
    Comment,
    Directive,
    RecoverableError,
    Unsupported,
}

impl From<ComposerOpaqueCategory> for ComposerOpaqueCategoryResult {
    fn from(category: ComposerOpaqueCategory) -> Self {
        match category {
            ComposerOpaqueCategory::Blank => Self::Blank,
            ComposerOpaqueCategory::Comment => Self::Comment,
            ComposerOpaqueCategory::Directive => Self::Directive,
            ComposerOpaqueCategory::RecoverableError => Self::RecoverableError,
            ComposerOpaqueCategory::Unsupported => Self::Unsupported,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ComposerSpeakerSourceResult {
    ScriptActor,
    PackEntity,
}

impl From<ComposerSpeakerSource> for ComposerSpeakerSourceResult {
    fn from(source: ComposerSpeakerSource) -> Self {
        match source {
            ComposerSpeakerSource::ScriptActor => Self::ScriptActor,
            ComposerSpeakerSource::PackEntity => Self::PackEntity,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
enum ComposerSpeakerResult {
    #[serde(rename = "actor")]
    Actor {
        reference: String,
        #[serde(rename = "displayName")]
        display_name: String,
        #[serde(rename = "primaryName")]
        primary_name: String,
        #[serde(rename = "presetId")]
        preset_id: String,
        avatar: Option<ComposerAvatarCurrentResult>,
    },
    #[serde(rename = "builtin")]
    Builtin { id: String },
}

impl From<ComposerSpeakerDescription> for ComposerSpeakerResult {
    fn from(speaker: ComposerSpeakerDescription) -> Self {
        match speaker {
            ComposerSpeakerDescription::Actor {
                reference,
                display_name,
                primary_name,
                preset_id,
                avatar,
            } => Self::Actor {
                reference,
                display_name,
                primary_name,
                preset_id,
                avatar: avatar.map(Into::into),
            },
            ComposerSpeakerDescription::Builtin { id } => Self::Builtin { id },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerStatementBodyResult {
    current: String,
    mode: ComposerStatementTextModeResult,
    resolved_mode: Option<ComposerBodyModeResult>,
    inherited_mode: Option<ComposerBodyModeResult>,
}

impl From<ComposerStatementBody> for ComposerStatementBodyResult {
    fn from(body: ComposerStatementBody) -> Self {
        Self {
            current: body.current,
            mode: body.mode.into(),
            resolved_mode: body.resolved_mode.map(Into::into),
            inherited_mode: body.inherited_mode.map(Into::into),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerMessageCapabilitiesResult {
    set_body: bool,
    set_continued: bool,
    set_display_name: bool,
    set_avatar: bool,
    set_speaker: bool,
    delete: bool,
    move_up: Option<ComposerBoundaryTargetResult>,
    move_down: Option<ComposerBoundaryTargetResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerNarrationCapabilitiesResult {
    set_body: bool,
    delete: bool,
    move_up: Option<ComposerBoundaryTargetResult>,
    move_down: Option<ComposerBoundaryTargetResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
enum ComposerDocumentNodeResult {
    #[serde(rename = "message")]
    Message {
        #[serde(rename = "nodeKey")]
        node_key: String,
        range: Range,
        #[serde(rename = "statementRange")]
        statement_range: Range,
        side: ComposerMessageSideResult,
        speaker: Option<ComposerSpeakerResult>,
        body: ComposerStatementBodyResult,
        continued: Option<ComposerContinuedResult>,
        #[serde(rename = "actorDisplayName")]
        actor_display_name: Option<String>,
        #[serde(rename = "actorAvatar")]
        actor_avatar: Option<ComposerActorAvatarResult>,
        capabilities: ComposerMessageCapabilitiesResult,
    },
    #[serde(rename = "narration")]
    Narration {
        #[serde(rename = "nodeKey")]
        node_key: String,
        range: Range,
        #[serde(rename = "statementRange")]
        statement_range: Range,
        body: ComposerStatementBodyResult,
        capabilities: ComposerNarrationCapabilitiesResult,
    },
    #[serde(rename = "opaque")]
    Opaque {
        #[serde(rename = "nodeKey")]
        node_key: String,
        range: Range,
        category: ComposerOpaqueCategoryResult,
        #[serde(rename = "sourcePreview")]
        source_preview: String,
        #[serde(rename = "sourceTruncated")]
        source_truncated: bool,
        summary: String,
        #[serde(rename = "canOpenSource")]
        can_open_source: bool,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerInsertCapabilityResult {
    boundary: ComposerBoundaryTargetResult,
    message_sides: Vec<ComposerMessageSideResult>,
    statement_modes: Vec<ComposerStatementTextModeResult>,
    speaker_sources: Vec<ComposerSpeakerSourceResult>,
    narration: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerBoundaryResult {
    target: ComposerBoundaryTargetResult,
    insert: Option<ComposerInsertCapabilityResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ComposerScriptActorChoiceResult {
    reference: String,
    display_name: String,
    primary_name: String,
    preset_id: String,
    avatar: Option<ComposerAvatarCurrentResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind")]
enum ComposerDocumentResult {
    Snapshot {
        #[serde(rename = "textDocument")]
        text_document: ComposerTextDocumentResult,
        #[serde(rename = "sourceDigest")]
        source_digest: String,
        nodes: Vec<ComposerDocumentNodeResult>,
        boundaries: Vec<ComposerBoundaryResult>,
        #[serde(rename = "scriptActorChoices")]
        script_actor_choices: Vec<ComposerScriptActorChoiceResult>,
    },
    Rejected {
        reason: ComposerDocumentRejectedReason,
    },
}

fn composer_document_range(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
    range: mmt_rs::source::TextRange,
) -> Result<Range, ServerError> {
    snapshot
        .range(range)
        .ok_or_else(|| ServerError::internal_error("Composer document range conversion failed"))
}

fn composer_node_ref_result(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
    node: &ComposerNodeRef,
) -> Result<ComposerNodeRefResult, ServerError> {
    Ok(ComposerNodeRefResult {
        node_key: node.node_key.clone(),
        node_kind: node.node_kind.into(),
        range: composer_document_range(snapshot, node.range)?,
    })
}

fn composer_boundary_target_result(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
    target: &ComposerBoundaryTarget,
) -> Result<ComposerBoundaryTargetResult, ServerError> {
    Ok(ComposerBoundaryTargetResult {
        kind: "boundary",
        before: target
            .before
            .as_ref()
            .map(|node| composer_node_ref_result(snapshot, node))
            .transpose()?,
        after: target
            .after
            .as_ref()
            .map(|node| composer_node_ref_result(snapshot, node))
            .transpose()?,
    })
}

fn composer_insert_capability_result(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
    capability: &ComposerInsertCapability,
) -> Result<ComposerInsertCapabilityResult, ServerError> {
    Ok(ComposerInsertCapabilityResult {
        boundary: composer_boundary_target_result(snapshot, &capability.boundary)?,
        message_sides: capability
            .message_sides
            .iter()
            .copied()
            .map(Into::into)
            .collect(),
        statement_modes: capability
            .statement_modes
            .iter()
            .copied()
            .map(Into::into)
            .collect(),
        speaker_sources: capability
            .speaker_sources
            .iter()
            .copied()
            .map(Into::into)
            .collect(),
        narration: capability.narration,
    })
}

fn composer_message_capabilities_result(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
    capabilities: &ComposerMessageCapabilities,
) -> Result<ComposerMessageCapabilitiesResult, ServerError> {
    Ok(ComposerMessageCapabilitiesResult {
        set_body: capabilities.set_body,
        set_continued: capabilities.set_continued,
        set_display_name: capabilities.set_display_name,
        set_avatar: capabilities.set_avatar,
        set_speaker: capabilities.set_speaker,
        delete: capabilities.delete,
        move_up: capabilities
            .move_up
            .as_ref()
            .map(|target| composer_boundary_target_result(snapshot, target))
            .transpose()?,
        move_down: capabilities
            .move_down
            .as_ref()
            .map(|target| composer_boundary_target_result(snapshot, target))
            .transpose()?,
    })
}

fn composer_narration_capabilities_result(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
    capabilities: &ComposerNarrationCapabilities,
) -> Result<ComposerNarrationCapabilitiesResult, ServerError> {
    Ok(ComposerNarrationCapabilitiesResult {
        set_body: capabilities.set_body,
        delete: capabilities.delete,
        move_up: capabilities
            .move_up
            .as_ref()
            .map(|target| composer_boundary_target_result(snapshot, target))
            .transpose()?,
        move_down: capabilities
            .move_down
            .as_ref()
            .map(|target| composer_boundary_target_result(snapshot, target))
            .transpose()?,
    })
}

fn bounded_source_preview(source: &str) -> (String, bool) {
    const MAX_BYTES: usize = 4096;
    if source.len() <= MAX_BYTES {
        return (source.to_owned(), false);
    }
    let mut end = MAX_BYTES;
    while !source.is_char_boundary(end) {
        end -= 1;
    }
    (source[..end].to_owned(), true)
}

fn composer_document_result(
    snapshot: &crate::service::ComposerDocumentSnapshot<'_>,
) -> Result<ComposerDocumentResult, ServerError> {
    let projection = &snapshot.projection;
    let mut nodes = Vec::with_capacity(projection.nodes.len());
    for node in &projection.nodes {
        nodes.push(match node {
            ComposerDocumentNode::Message(node) => {
                let description = &node.description;
                ComposerDocumentNodeResult::Message {
                    node_key: node.node_key.clone(),
                    range: composer_document_range(snapshot, node.range)?,
                    statement_range: composer_document_range(snapshot, node.statement_range)?,
                    side: node.side.into(),
                    speaker: description.speaker.clone().map(Into::into),
                    body: description.body.clone().into(),
                    continued: description.continued.map(Into::into),
                    actor_display_name: description.actor_display_name.clone(),
                    actor_avatar: description.actor_avatar.clone().map(|avatar| {
                        ComposerActorAvatarResult {
                            scope: ComposerActorAvatarScope::FromStatement,
                            actor_preset_id: avatar.actor_preset_id,
                            current: avatar.current.map(Into::into),
                        }
                    }),
                    capabilities: composer_message_capabilities_result(
                        snapshot,
                        &node.capabilities,
                    )?,
                }
            }
            ComposerDocumentNode::Narration(node) => ComposerDocumentNodeResult::Narration {
                node_key: node.node_key.clone(),
                range: composer_document_range(snapshot, node.range)?,
                statement_range: composer_document_range(snapshot, node.statement_range)?,
                body: node.description.body.clone().into(),
                capabilities: composer_narration_capabilities_result(snapshot, &node.capabilities)?,
            },
            ComposerDocumentNode::Opaque(node) => {
                let authored = &snapshot.text[node.range.start..node.range.end];
                let (source_preview, source_truncated) = bounded_source_preview(authored);
                ComposerDocumentNodeResult::Opaque {
                    node_key: node.node_key.clone(),
                    range: composer_document_range(snapshot, node.range)?,
                    category: node.category.into(),
                    source_preview,
                    source_truncated,
                    summary: authored.chars().take(160).collect(),
                    can_open_source: true,
                }
            }
        });
    }
    let boundaries = projection
        .boundaries
        .iter()
        .map(|boundary| {
            Ok(ComposerBoundaryResult {
                target: composer_boundary_target_result(snapshot, &boundary.target)?,
                insert: boundary
                    .insert
                    .as_ref()
                    .map(|capability| composer_insert_capability_result(snapshot, capability))
                    .transpose()?,
            })
        })
        .collect::<Result<Vec<_>, ServerError>>()?;
    let script_actor_choices = projection
        .script_actor_choices
        .iter()
        .map(|choice| ComposerScriptActorChoiceResult {
            reference: choice.reference.clone(),
            display_name: choice.display_name.clone(),
            primary_name: choice.primary_name.clone(),
            preset_id: choice.preset_id.clone(),
            avatar: choice.avatar.clone().map(Into::into),
        })
        .collect();
    Ok(ComposerDocumentResult::Snapshot {
        text_document: ComposerTextDocumentResult {
            uri: snapshot.uri.clone(),
            version: snapshot.version,
        },
        source_digest: projection.source_digest.clone(),
        nodes,
        boundaries,
        script_actor_choices,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerEvent {
    pub method: String,
    pub params: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct NotificationOutcome {
    pub events: Vec<ServerEvent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ServerError>,
}

impl NotificationOutcome {
    fn success(events: Vec<ServerEvent>) -> Self {
        Self {
            events,
            error: None,
        }
    }

    fn failure(method: &str, error: ServerError) -> Self {
        Self {
            events: vec![error.log_event(method)],
            error: Some(error),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ServerError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ServerError {
    pub fn parse_error(error: impl ToString) -> Self {
        Self {
            code: -32700,
            message: format!("failed to decode JSON params: {}", error.to_string()),
            data: None,
        }
    }

    fn invalid_params(error: impl ToString) -> Self {
        Self {
            code: -32602,
            message: error.to_string(),
            data: None,
        }
    }

    fn invalid_request(error: impl ToString) -> Self {
        Self {
            code: -32600,
            message: error.to_string(),
            data: None,
        }
    }

    fn internal_error(error: impl ToString) -> Self {
        Self {
            code: -32603,
            message: error.to_string(),
            data: None,
        }
    }

    fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("unsupported method: {method}"),
            data: None,
        }
    }

    fn log_event(&self, method: &str) -> ServerEvent {
        ServerEvent {
            method: "window/logMessage".to_string(),
            params: serde_json::to_value(LogMessageParams {
                typ: MessageType::ERROR,
                message: format!("{method}: {} ({})", self.message, self.code),
            })
            .expect("log message is serializable"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServerLifecycle {
    Created,
    Initialized,
    Shutdown,
}

#[derive(Debug)]
pub struct MmtLanguageServer {
    service: LanguageService,
    projections: ProjectionStore,
    published_project_entries: HashMap<Url, Url>,
    render_project_snapshots: HashMap<Url, TypstRenderProjectUpdate>,
    projection_errors: HashMap<Url, ServerError>,
    preview_on_change: bool,
    typst_language_features: bool,
    lifecycle: ServerLifecycle,
}

impl Default for MmtLanguageServer {
    fn default() -> Self {
        Self {
            service: LanguageService::default(),
            projections: ProjectionStore::default(),
            published_project_entries: HashMap::new(),
            render_project_snapshots: HashMap::new(),
            projection_errors: HashMap::new(),
            preview_on_change: false,
            typst_language_features: false,
            lifecycle: ServerLifecycle::Created,
        }
    }
}

impl MmtLanguageServer {
    pub fn service(&self) -> &LanguageService {
        &self.service
    }

    pub fn projections(&self) -> &ProjectionStore {
        &self.projections
    }

    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, ServerError> {
        if method == "initialize" {
            if self.lifecycle != ServerLifecycle::Created {
                return Err(ServerError::invalid_request(
                    "initialize may only be requested once",
                ));
            }
            let result = self.initialize(params)?;
            self.lifecycle = ServerLifecycle::Initialized;
            return Ok(result);
        }
        if method == "shutdown" {
            if self.lifecycle != ServerLifecycle::Initialized {
                return Err(ServerError::invalid_request(
                    "shutdown requires an initialized server",
                ));
            }
            self.lifecycle = ServerLifecycle::Shutdown;
            return Ok(Value::Null);
        }
        if self.lifecycle != ServerLifecycle::Initialized {
            return Err(ServerError::invalid_request(
                "language request requires an initialized server",
            ));
        }
        match method {
            "textDocument/documentSymbol" => {
                let params: DocumentSymbolParams = decode(params)?;
                encode(self.service.document_symbols(&params.text_document.uri))
            }
            "textDocument/foldingRange" => {
                let params: FoldingRangeParams = decode(params)?;
                encode(self.service.folding_ranges(&params.text_document.uri))
            }
            "textDocument/semanticTokens/full" => {
                let params: SemanticTokensParams = decode(params)?;
                encode(self.service.semantic_tokens(&params.text_document.uri))
            }
            "textDocument/inlayHint" => {
                let params: InlayHintParams = decode(params)?;
                encode(
                    self.service
                        .inlay_hints(&params.text_document.uri, params.range),
                )
            }
            "textDocument/completion" => {
                let params: CompletionParams = decode(params)?;
                encode(self.service.completions(
                    &params.text_document_position.text_document.uri,
                    params.text_document_position.position,
                ))
            }
            "textDocument/hover" => {
                let params: lsp_types::HoverParams = decode(params)?;
                encode(self.service.hover(
                    &params.text_document_position_params.text_document.uri,
                    params.text_document_position_params.position,
                ))
            }
            "textDocument/signatureHelp" => {
                let params: lsp_types::SignatureHelpParams = decode(params)?;
                encode(self.service.signature_help(
                    &params.text_document_position_params.text_document.uri,
                    params.text_document_position_params.position,
                ))
            }
            "textDocument/definition" => {
                let params: GotoDefinitionParams = decode(params)?;
                encode(self.service.definition(
                    &params.text_document_position_params.text_document.uri,
                    params.text_document_position_params.position,
                ))
            }
            "textDocument/references" => {
                let params: ReferenceParams = decode(params)?;
                encode(self.service.references(
                    &params.text_document_position.text_document.uri,
                    params.text_document_position.position,
                    params.context.include_declaration,
                ))
            }
            "textDocument/prepareRename" => {
                let params: TextDocumentPositionParams = decode(params)?;
                encode(
                    self.service
                        .prepare_rename(&params.text_document.uri, params.position),
                )
            }
            "textDocument/rename" => {
                let params: RenameParams = decode(params)?;
                encode(self.service.rename(
                    &params.text_document_position.text_document.uri,
                    params.text_document_position.position,
                    &params.new_name,
                ))
            }
            "mmt/previewComposerTarget" => {
                let params: PreviewComposerTargetParams = decode(params)?;
                validate_preview_composer_identity(&params)?;
                let client_encoding = PositionEncoding::from_lsp(self.service.encoding())
                    .map_err(ServerError::invalid_params)?;
                let snapshot = self.service.snapshot(&params.source_uri);
                let snapshot_has_errors =
                    snapshot.is_some_and(|snapshot| self.service.snapshot_has_errors(snapshot));
                let result = self.projections.resolve_composer_target(
                    &params.source_uri,
                    &params.entry_uri,
                    params.revision,
                    &params.source_content,
                    &params.project_digest,
                    &params.projection_key,
                    Location::new(params.location.uri, params.location.range.into()),
                    params.backend_encoding,
                    client_encoding,
                    snapshot,
                    snapshot_has_errors,
                );
                encode(match result {
                    Ok(target) => PreviewComposerTargetResult::Editable {
                        text_document: ComposerTextDocumentResult {
                            uri: params.source_uri,
                            version: target.source_version,
                        },
                        target: ComposerTargetResult::Statement {
                            range: target.statement_range,
                        },
                        properties: ComposerPropertiesResult {
                            continued: target.continued.map(Into::into),
                            actor_display_name: target.actor_display_name.map(|current| {
                                ComposerActorDisplayNameResult {
                                    current,
                                    scope: ComposerActorDisplayNameScope::FromStatement,
                                }
                            }),
                            actor_avatar: target.actor_avatar.map(|avatar| {
                                ComposerActorAvatarResult {
                                    scope: ComposerActorAvatarScope::FromStatement,
                                    actor_preset_id: avatar.actor_preset_id,
                                    current: avatar.current.map(Into::into),
                                }
                            }),
                            statement_text: target.statement_text.map(Into::into),
                        },
                    },
                    Err(reason) => PreviewComposerTargetResult::Unavailable {
                        reason: reason.into(),
                    },
                })
            }
            "mmt/composerDocument" => {
                let params: ComposerDocumentParams = decode(params)?;
                let uri = params.text_document.uri;
                let version = params.text_document.version;
                match self.service.composer_document(&uri, version) {
                    Ok(snapshot) => encode(composer_document_result(&snapshot)?),
                    Err(reason) => encode(ComposerDocumentResult::Rejected {
                        reason: reason.into(),
                    }),
                }
            }
            "mmt/composerEdit" => {
                let params: ComposerEditParams = decode(params)?;
                let result = match params {
                    ComposerEditParams::Property(params) => {
                        validate_composer_command(&params.command)?;
                        let target = match params.target {
                            ComposerTargetParams::Statement { range } => range.into(),
                        };
                        self.service.composer_edit(
                            &params.text_document.uri,
                            params.text_document.version,
                            target,
                            params.command.into(),
                        )
                    }
                    ComposerEditParams::Structure(params) => {
                        validate_composer_structure(&params)?;
                        let uri = params.text_document.uri;
                        let version = params.text_document.version;
                        let (target, command) = match self.service.composer_document(&uri, version)
                        {
                            Ok(snapshot) => (
                                structure_target(&snapshot, params.target)?,
                                structure_command(&snapshot, params.command)?,
                            ),
                            Err(_) => {
                                return encode(ComposerEditResult::Rejected {
                                    reason: ComposerEditRejectedReason::StaleDocument,
                                });
                            }
                        };
                        self.service.composer_structure_edit(
                            &uri,
                            version,
                            &params.source_digest,
                            target,
                            command,
                        )
                    }
                };
                encode(match result {
                    Ok(edit) => ComposerEditResult::Edit { edit },
                    Err(reason) => ComposerEditResult::Rejected {
                        reason: reason.into(),
                    },
                })
            }
            "mmt/semanticRoute" => {
                let params: SemanticRouteParams = decode(params)?;
                let Some(snapshot) = self.service.snapshot(&params.text_document.uri) else {
                    return encode("none");
                };
                if snapshot.version != params.version {
                    return encode("none");
                }
                if self
                    .service
                    .semantic_position_is_native(&params.text_document.uri, params.position)
                {
                    return encode("native");
                }
                let projection_is_current = self
                    .projections
                    .get(&params.text_document.uri)
                    .is_some_and(|projection| {
                        projection.source_revision == snapshot.revision
                            && projection.source_version == snapshot.version
                    });
                if !projection_is_current {
                    return encode("none");
                }
                let Ok(client_encoding) = PositionEncoding::from_lsp(self.service.encoding())
                else {
                    return encode("none");
                };
                let projected = self.projections.project_position(
                    &params.text_document.uri,
                    MmtClientPosition::new(params.position),
                    client_encoding,
                    params.backend_encoding,
                );
                encode(projected.is_ok().then_some("projected").unwrap_or("none"))
            }
            "mmt/typstPosition" => {
                let params: TypstPositionParams = decode(params)?;
                let Ok(client_encoding) = PositionEncoding::from_lsp(self.service.encoding())
                else {
                    return Ok(Value::Null);
                };
                encode(
                    self.projections
                        .project_position(
                            &params.text_document.uri,
                            MmtClientPosition::new(params.position),
                            client_encoding,
                            params.backend_encoding,
                        )
                        .ok(),
                )
            }
            "mmt/typstRange" => {
                let params: TypstRangeParams = decode(params)?;
                let Ok(client_encoding) = PositionEncoding::from_lsp(self.service.encoding())
                else {
                    return Ok(Value::Null);
                };
                let projected = match (
                    &params.entry_uri,
                    params.revision,
                    &params.source_content,
                    &params.project_digest,
                    &params.projection_key,
                ) {
                    (
                        Some(entry_uri),
                        Some(revision),
                        Some(source_content),
                        Some(project_digest),
                        Some(projection_key),
                    ) => self.projections.project_range_for_generation(
                        &params.text_document.uri,
                        params.range,
                        client_encoding,
                        params.backend_encoding,
                        entry_uri,
                        revision,
                        source_content,
                        project_digest,
                        projection_key,
                    ),
                    (None, None, None, None, None) => self.projections.project_range(
                        &params.text_document.uri,
                        params.range,
                        client_encoding,
                        params.backend_encoding,
                    ),
                    _ => {
                        return Err(ServerError::invalid_params(
                            "render generation identity must be complete",
                        ));
                    }
                };
                encode(projected.ok())
            }
            "mmt/validateProjectedEdit" => {
                let transaction: ProjectedEditTransaction = decode(params)?;
                let targets = transaction
                    .expected_versions
                    .iter()
                    .map(|expected| {
                        let current = Url::parse(&expected.uri)
                            .ok()
                            .and_then(|uri| self.service.snapshot(&uri));
                        ProjectedEditTarget {
                            uri: expected.uri.as_str(),
                            version: current.map_or(expected.version, |snapshot| snapshot.version),
                            class: if current.is_some() {
                                ProjectedTargetClass::Authored
                            } else {
                                ProjectedTargetClass::ReadOnlyVirtual
                            },
                            writable: current.is_some(),
                        }
                    })
                    .collect::<Vec<_>>();
                match self
                    .projections
                    .validate_projected_edit(&transaction, &targets)
                {
                    Ok(validated) => Ok(serde_json::json!({
                        "kind": "Validated",
                        "documents": validated.documents.into_iter().map(|document| serde_json::json!({
                            "normalizedUri": document.normalized_uri,
                            "expectedVersion": document.expected_version,
                            "edits": document.edits.into_iter().map(|edit| serde_json::json!({
                                "startByte": edit.range.start,
                                "endByte": edit.range.end,
                                "newText": edit.new_text,
                            })).collect::<Vec<_>>(),
                        })).collect::<Vec<_>>(),
                    })),
                    Err(failure) => encode(failure),
                }
            }
            "mmt/mapTypstCompletion" => {
                let params: MapTypstCompletionParams = decode(params)?;
                let Ok(client_encoding) = PositionEncoding::from_lsp(self.service.encoding())
                else {
                    return Ok(Value::Null);
                };
                let Ok(document) = self.projections.response_generation(
                    &params.source_uri,
                    &params.entry_uri,
                    params.revision,
                    &params.source_content,
                    &params.project_digest,
                    &params.projection_key,
                ) else {
                    return Ok(Value::Null);
                };
                let mapped = params
                    .items
                    .into_iter()
                    .map(|item| {
                        document.map_completion_item(item, params.backend_encoding, client_encoding)
                    })
                    .collect::<Result<Vec<_>, _>>();
                encode(mapped.ok())
            }
            "mmt/mapTypstHover" => {
                let mut params: MapTypstHoverParams = decode(params)?;
                let Ok(client_encoding) = PositionEncoding::from_lsp(self.service.encoding())
                else {
                    return Ok(Value::Null);
                };
                let Ok(document) = self.projections.response_generation(
                    &params.source_uri,
                    &params.entry_uri,
                    params.revision,
                    &params.source_content,
                    &params.project_digest,
                    &params.projection_key,
                ) else {
                    return Ok(Value::Null);
                };
                if let Some(range) = params.hover.range {
                    let Ok(mapped) = document.typst_range_to_mmt(
                        range,
                        params.backend_encoding,
                        client_encoding,
                    ) else {
                        return Ok(Value::Null);
                    };
                    params.hover.range = Some(mapped);
                }
                encode(params.hover)
            }
            "mmt/mapTypstDiagnostics" => {
                let params: MapTypstDiagnosticsParams = decode(params)?;
                let Ok(client_encoding) = PositionEncoding::from_lsp(self.service.encoding())
                else {
                    return Ok(Value::Null);
                };
                let Ok(document) = self.projections.response_generation(
                    &params.source_uri,
                    &params.entry_uri,
                    params.revision,
                    &params.source_content,
                    &params.project_digest,
                    &params.projection_key,
                ) else {
                    return Ok(Value::Null);
                };
                let mapped = params
                    .diagnostics
                    .into_iter()
                    .map(|diagnostic| {
                        document
                            .map_diagnostic(diagnostic, params.backend_encoding, client_encoding)
                            .ok()
                    })
                    .collect::<Vec<_>>();
                encode(mapped)
            }
            "mmt/mapTypstReadLocations" => {
                let params: MapTypstReadLocationsParams = decode(params)?;
                let Ok(client_encoding) = PositionEncoding::from_lsp(self.service.encoding())
                else {
                    return Ok(Value::Null);
                };
                encode(
                    params
                        .locations
                        .into_iter()
                        .map(|location| {
                            self.projections.classify_response_location(
                                &params.source_uri,
                                &params.entry_uri,
                                params.revision,
                                &params.source_content,
                                &params.project_digest,
                                &params.projection_key,
                                location,
                                params.backend_encoding,
                                client_encoding,
                            )
                        })
                        .collect::<Vec<_>>(),
                )
            }
            "mmt/getTypstProject" => {
                let params: GetTypstProjectParams = decode(params)?;
                let Some(document) = self.projections.get(&params.uri) else {
                    if let Some(error) = self.projection_errors.get(&params.uri) {
                        return Err(error.clone());
                    }
                    return Ok(Value::Null);
                };
                let update = document.project_update();
                self.published_project_entries
                    .insert(params.uri, update.entry_uri.clone());
                encode(update)
            }
            "mmt/getDocumentConfig" => {
                let params: GetTypstProjectParams = decode(params)?;
                let Some(document) = self.service.snapshot(&params.uri) else {
                    return Ok(Value::Null);
                };
                document_config_response(document, self.service.encoding())
            }
            "mmt/getTypstRenderProject" => {
                let params: GetTypstProjectParams = decode(params)?;
                let Some((document_revision, document_version)) = self
                    .service
                    .snapshot(&params.uri)
                    .map(|document| (document.revision, document.version))
                else {
                    return Ok(Value::Null);
                };
                if self.service.pack_registry().is_none() {
                    return Ok(Value::Null);
                }
                let projection_is_current =
                    self.projections.get(&params.uri).is_some_and(|projection| {
                        projection.source_revision == document_revision
                            && projection.source_version == document_version
                    });
                if !projection_is_current {
                    self.refresh_projection(&params.uri);
                }
                let Some(projection) = self.projections.get(&params.uri) else {
                    if let Some(error) = self.projection_errors.get(&params.uri) {
                        return Err(error.clone());
                    }
                    return Ok(Value::Null);
                };
                if projection.source_revision != document_revision
                    || projection.source_version != document_version
                {
                    return Ok(Value::Null);
                }
                let timestamp = params
                    .timestamp
                    .map(|timestamp| {
                        mmt_rs::HostTimestamp::new(
                            timestamp.unix_millis,
                            timestamp.local_offset_minutes,
                        )
                    })
                    .transpose()
                    .map_err(ServerError::invalid_params)?;
                if params.base_revision.is_some() != params.base_project_digest.is_some() {
                    return Err(ServerError::invalid_params(
                        "render delta base revision and digest must be supplied together",
                    ));
                }
                let full_update = self
                    .projections
                    .build_render_project(&params.uri, self.service.pack_revision(), timestamp)
                    .map_err(|error| {
                        ServerError::invalid_params(format!(
                            "failed to build render project: {error:?}"
                        ))
                    })?;
                let mut update = match (
                    params.force_full,
                    params.base_revision,
                    params.base_project_digest.as_ref(),
                    self.render_project_snapshots.get(&params.uri),
                ) {
                    (false, Some(base_revision), Some(base_digest), Some(base))
                        if full_update.revision > base.revision
                            && base.revision == base_revision
                            && &base.project_digest == base_digest =>
                    {
                        full_update.clone().delta_from(base)
                    }
                    _ => full_update.clone(),
                };
                self.render_project_snapshots
                    .insert(params.uri.clone(), full_update);
                if params.trace_id.is_none() {
                    update.timings = None;
                }
                update.trace_id = params.trace_id;
                let mut result = encode(update.clone())?;
                if let Value::Object(fields) = &mut result {
                    fields.insert(
                        "events".to_string(),
                        serde_json::to_value(vec![ServerEvent {
                            method: "mmt/typstRenderProjectUpdated".to_string(),
                            params: serde_json::to_value(update)
                                .expect("Typst render project update is serializable"),
                        }])
                        .expect("server events are serializable"),
                    );
                }
                Ok(result)
            }
            "mmt/updatePackManifests" => {
                let params: UpdatePackManifestsParams = decode(params)?;
                let base_urls = params
                    .sources
                    .iter()
                    .filter_map(|source| {
                        let manifest = mmt_rs::pack::PackManifest::from_json(&source.json).ok()?;
                        Some((manifest.pack.namespace, source.base_url.clone()?))
                    })
                    .collect::<HashMap<_, _>>();
                let manifests = params
                    .sources
                    .into_iter()
                    .map(|source| source.json)
                    .collect::<Vec<_>>();
                let updated = self
                    .service
                    .update_pack_manifests(params.revision, &manifests)
                    .map_err(ServerError::invalid_params)?;
                if updated {
                    self.service.set_pack_base_urls(params.revision, base_urls);
                }
                let mut events = Vec::new();
                if updated {
                    let documents = self
                        .service
                        .document_uris()
                        .into_iter()
                        .filter_map(|uri| {
                            let document = self.service.snapshot(&uri)?;
                            Some((uri, document.version))
                        })
                        .collect::<Vec<_>>();
                    for (uri, version) in documents {
                        let projection_error = self.refresh_projection(&uri);
                        events.extend(self.document_events(uri, version, projection_error));
                    }
                }
                Ok(serde_json::json!({
                    "revision": params.revision,
                    "updated": updated,
                    "events": events,
                }))
            }
            _ => Err(ServerError::method_not_found(method)),
        }
    }

    pub fn request_json(&mut self, method: &str, params: &str) -> String {
        let result = serde_json::from_str(params)
            .map_err(ServerError::parse_error)
            .and_then(|params| self.request(method, params));
        match result {
            Ok(result) => serde_json::json!({ "result": result }).to_string(),
            Err(error) => serde_json::json!({ "error": error }).to_string(),
        }
    }

    pub fn notification(
        &mut self,
        method: &str,
        params: Value,
    ) -> Result<Vec<ServerEvent>, ServerError> {
        if method == "exit" {
            return Ok(Vec::new());
        }
        if self.lifecycle != ServerLifecycle::Initialized {
            return Err(ServerError::invalid_request(
                "language notification requires an initialized server",
            ));
        }
        match method {
            "initialized" => Ok(Vec::new()),
            "textDocument/didOpen" => {
                let params: DidOpenTextDocumentParams = decode(params)?;
                let document = params.text_document;
                self.service
                    .open(document.uri.clone(), document.version, document.text);
                let projection_error = self.refresh_projection(&document.uri);
                Ok(self.document_events(document.uri, document.version, projection_error))
            }
            "textDocument/didChange" => {
                let params: DidChangeTextDocumentParams = decode(params)?;
                if params.content_changes.len() != 1 {
                    return Err(ServerError::invalid_params(format!(
                        "full document sync requires exactly one content change, received {}",
                        params.content_changes.len()
                    )));
                }
                let change = params
                    .content_changes
                    .into_iter()
                    .next()
                    .expect("length checked above");
                if change.range.is_some() {
                    return Err(ServerError::invalid_params(
                        "mmt-lsp negotiated full document sync but received a ranged change",
                    ));
                }
                let document = params.text_document;
                if self.service.snapshot(&document.uri).is_none() {
                    return Err(ServerError::invalid_params(format!(
                        "received didChange for unopened document {}",
                        document.uri
                    )));
                }
                if self
                    .service
                    .change(document.uri.clone(), document.version, change.text)
                    .is_none()
                {
                    return Ok(Vec::new());
                }
                let projection_error = self.refresh_projection(&document.uri);
                Ok(self.document_events(document.uri, document.version, projection_error))
            }
            "textDocument/didClose" => {
                let params: DidCloseTextDocumentParams = decode(params)?;
                let uri = params.text_document.uri;
                let entry_uri = self.published_project_entries.remove(&uri).or_else(|| {
                    self.projections
                        .get(&uri)
                        .map(|project| project.entry_uri.clone())
                });
                self.service.close(&uri);
                self.projections.remove(&uri);
                self.projection_errors.remove(&uri);
                self.render_project_snapshots.remove(&uri);
                let mut events = vec![publish_diagnostics(uri.clone(), None, Vec::new())];
                if let Some(entry_uri) = entry_uri {
                    events.push(ServerEvent {
                        method: "mmt/typstProjectClosed".to_string(),
                        params: serde_json::json!({"sourceUri": uri, "entryUri": entry_uri}),
                    });
                }
                Ok(events)
            }
            _ => Ok(Vec::new()),
        }
    }

    pub fn notification_outcome(&mut self, method: &str, params: Value) -> NotificationOutcome {
        match self.notification(method, params) {
            Ok(events) => NotificationOutcome::success(events),
            Err(error) => NotificationOutcome::failure(method, error),
        }
    }

    pub fn notification_json(&mut self, method: &str, params: &str) -> String {
        let outcome = match serde_json::from_str(params) {
            Ok(params) => self.notification_outcome(method, params),
            Err(error) => NotificationOutcome::failure(method, ServerError::parse_error(error)),
        };
        serde_json::to_string(&outcome).expect("notification outcome is serializable")
    }

    fn initialize(&mut self, params: Value) -> Result<Value, ServerError> {
        let params: InitializeParams = decode(params)?;
        let encodings = params
            .capabilities
            .general
            .as_ref()
            .and_then(|general| general.position_encodings.as_ref());
        let encoding =
            if encodings.is_some_and(|encodings| encodings.contains(&PositionEncodingKind::UTF8)) {
                PositionEncodingKind::UTF8
            } else {
                PositionEncodingKind::UTF16
            };
        self.service.set_encoding(encoding.clone());
        self.preview_on_change = params
            .initialization_options
            .as_ref()
            .and_then(|options| options.get("previewOnChange"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        self.typst_language_features = params
            .initialization_options
            .as_ref()
            .and_then(|options| options.get("typstLanguageFeatures"))
            .and_then(Value::as_bool)
            .unwrap_or(false);

        let mut completion_trigger_characters = vec![
            "_".to_string(),
            "~".to_string(),
            "[".to_string(),
            ":".to_string(),
            ",".to_string(),
            "#".to_string(),
        ];
        if self.typst_language_features {
            completion_trigger_characters.push(".".to_string());
        }

        encode(InitializeResult {
            capabilities: ServerCapabilities {
                position_encoding: Some(encoding),
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                document_symbol_provider: Some(OneOf::Left(true)),
                folding_range_provider: Some(FoldingRangeProviderCapability::Simple(true)),
                completion_provider: Some(CompletionOptions {
                    trigger_characters: Some(completion_trigger_characters),
                    ..CompletionOptions::default()
                }),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                definition_provider: Some(OneOf::Left(true)),
                references_provider: Some(OneOf::Left(true)),
                rename_provider: Some(OneOf::Right(RenameOptions {
                    prepare_provider: Some(true),
                    work_done_progress_options: Default::default(),
                })),
                inlay_hint_provider: Some(OneOf::Left(true)),
                signature_help_provider: Some(SignatureHelpOptions {
                    trigger_characters: Some(vec!["(".to_string(), ",".to_string()]),
                    retrigger_characters: Some(vec![",".to_string()]),
                    work_done_progress_options: Default::default(),
                }),
                semantic_tokens_provider: Some(
                    SemanticTokensServerCapabilities::SemanticTokensOptions(
                        SemanticTokensOptions {
                            legend: SemanticTokensLegend {
                                token_types: vec![
                                    SemanticTokenType::KEYWORD,
                                    SemanticTokenType::VARIABLE,
                                    SemanticTokenType::ENUM_MEMBER,
                                    SemanticTokenType::PROPERTY,
                                ],
                                token_modifiers: Vec::new(),
                            },
                            range: None,
                            full: Some(SemanticTokensFullOptions::Bool(true)),
                            work_done_progress_options: Default::default(),
                        },
                    ),
                ),
                ..ServerCapabilities::default()
            },
            server_info: Some(ServerInfo {
                name: "mmt-lsp".to_string(),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            }),
        })
    }

    fn document_events(
        &mut self,
        uri: lsp_types::Url,
        version: i32,
        projection_error: Option<ServerEvent>,
    ) -> Vec<ServerEvent> {
        let include_template = !self.published_project_entries.contains_key(&uri);
        let mut events = vec![publish_diagnostics(
            uri.clone(),
            Some(version),
            self.service.diagnostics(&uri),
        )];
        if let Some(projection) = self.projections.get(&uri) {
            if self.preview_on_change {
                events.push(ServerEvent {
                    method: "mmt/previewRequested".to_string(),
                    params: serde_json::json!({ "uri": uri, "revision": projection.revision }),
                });
            }
            events.push(ServerEvent {
                method: "mmt/typstProjectUpdated".to_string(),
                params: serde_json::to_value(if include_template {
                    projection.project_update()
                } else {
                    projection.project_delta()
                })
                .expect("Typst project update is serializable"),
            });
            self.published_project_entries
                .insert(uri.clone(), projection.entry_uri.clone());
        }
        if projection_error.is_some()
            && let Some(entry_uri) = self.published_project_entries.remove(&uri)
        {
            events.push(ServerEvent {
                method: "mmt/typstProjectClosed".to_string(),
                params: serde_json::json!({"sourceUri": uri, "entryUri": entry_uri}),
            });
        }
        events.extend(projection_error);
        events
    }

    fn refresh_projection(&mut self, uri: &lsp_types::Url) -> Option<ServerEvent> {
        let document = self.service.snapshot(uri)?;
        let result = self.projections.upsert(uri.clone(), document);
        match result {
            Ok(_) => {
                self.projection_errors.remove(uri);
                None
            }
            Err(error) => {
                self.projections.remove(uri);
                let error = ServerError {
                    code: -32603,
                    message: format!("failed to build Typst projection: {error:?}"),
                    data: Some(serde_json::json!({"uri": uri, "revision": document.revision})),
                };
                self.projection_errors.insert(uri.clone(), error.clone());
                Some(error.log_event("mmt/projection"))
            }
        }
    }
}

fn document_config_response(
    document: &crate::DocumentSnapshot,
    encoding: &PositionEncodingKind,
) -> Result<Value, ServerError> {
    let source = &document.text;
    let syntax = &document.analysis.document;
    let blocks = syntax
        .nodes
        .iter()
        .filter_map(|node| match node {
            mmt_rs::syntax::SyntaxNode::DirectiveBlock(block) if block.name == "document" => {
                Some(block)
            }
            _ => None,
        })
        .collect::<Vec<_>>();
    let malformed = syntax.nodes.iter().any(|node| match node {
        mmt_rs::syntax::SyntaxNode::DirectiveLine(line) => line.name == "document",
        mmt_rs::syntax::SyntaxNode::Error(error) => {
            error.source.trim_start().starts_with("@document")
        }
        _ => false,
    });
    if malformed || blocks.len() > 1 {
        return Err(ServerError::invalid_params(
            "document configuration must be one valid @document ... @end block",
        ));
    }
    let range = blocks
        .first()
        .map(|block| {
            document
                .lines
                .range(source, block.range, encoding)
                .ok_or_else(|| {
                    ServerError::invalid_params("document configuration range is invalid")
                })
        })
        .transpose()?;
    let lowered = &document.analysis.document_config;
    if let Some(diagnostic) = lowered
        .diagnostics
        .iter()
        .find(|diagnostic| diagnostic.severity == mmt_rs::diag::Severity::Error)
    {
        return Err(ServerError::invalid_params(format!(
            "fix the existing @document diagnostic before replacing it: {}",
            diagnostic.message
        )));
    }
    let compiled_at = match &lowered.config.compiled_at {
        mmt_rs::CompiledAtConfig::Hidden => serde_json::json!({ "mode": "hidden" }),
        mmt_rs::CompiledAtConfig::Manual(text) => {
            serde_json::json!({ "mode": "manual", "text": text })
        }

        mmt_rs::CompiledAtConfig::Auto { format, timezone } => {
            let timezone = match timezone {
                mmt_rs::DocumentTimezone::Local => "local".to_string(),
                mmt_rs::DocumentTimezone::FixedOffsetMinutes(0) => "utc".to_string(),
                mmt_rs::DocumentTimezone::FixedOffsetMinutes(minutes) => {
                    let sign = if *minutes < 0 { '-' } else { '+' };
                    let absolute = minutes.unsigned_abs();
                    format!("{sign}{:02}:{:02}", absolute / 60, absolute % 60)
                }
            };
            serde_json::json!({
                "mode": "auto",
                "format": format,
                "timezone": timezone,
            })
        }
    };
    encode(serde_json::json!({
        "range": range,
        "title": lowered.config.title,
        "author": lowered.config.author,
        "showHeader": lowered.config.show_header,
        "compiledAt": compiled_at,
    }))
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, ServerError> {
    serde_json::from_value(value).map_err(ServerError::invalid_params)
}

fn encode<T: Serialize>(value: T) -> Result<Value, ServerError> {
    serde_json::to_value(value).map_err(ServerError::invalid_params)
}

fn publish_diagnostics(
    uri: lsp_types::Url,
    version: Option<i32>,
    diagnostics: Vec<lsp_types::Diagnostic>,
) -> ServerEvent {
    ServerEvent {
        method: "textDocument/publishDiagnostics".to_string(),
        params: serde_json::to_value(PublishDiagnosticsParams {
            uri,
            diagnostics,
            version,
        })
        .expect("diagnostics are serializable"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{TypstProjectUpdate, TypstRenderProjectUpdate};

    fn initialize(preview_on_change: bool) -> Value {
        serde_json::json!({
            "capabilities": { "general": { "positionEncodings": ["utf-8", "utf-16"] } },
            "initializationOptions": { "previewOnChange": preview_on_change }
        })
    }
    fn initialize_with_encoding(encoding: &str) -> Value {
        serde_json::json!({
            "capabilities": { "general": { "positionEncodings": [encoding] } },
            "initializationOptions": { "previewOnChange": false }
        })
    }

    fn open_document(server: &mut MmtLanguageServer, uri: &Url, version: i32, text: &str) {
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": "mmt",
                        "version": version,
                        "text": text
                    }
                }),
            )
            .unwrap();
    }

    fn preview_target_params(
        server: &MmtLanguageServer,
        uri: &Url,
        generated_start: usize,
        backend_encoding: &PositionEncodingKind,
    ) -> Value {
        let projection = server.projections.get(uri).unwrap();
        let update = projection.project_update();
        let generated = &projection.projection.emitted.source;
        let lines = crate::position::LineIndex::new(generated);
        let start = lines
            .position(generated, generated_start, backend_encoding)
            .unwrap();
        let end = lines
            .position(generated, generated_start + 1, backend_encoding)
            .unwrap();
        serde_json::json!({
            "sourceUri": uri,
            "revision": update.revision,
            "sourceContent": update.source_content,
            "projectDigest": update.project_digest,
            "projectionKey": update.projection_key,
            "entryUri": update.entry_uri,
            "backendEncoding": if *backend_encoding == PositionEncodingKind::UTF8 {
                "utf-8"
            } else {
                "utf-16"
            },
            "location": {
                "uri": projection.entry_uri,
                "range": {"start": start, "end": end}
            }
        })
    }

    #[test]
    fn composer_requests_are_strict_pure_and_versioned_over_request_json() {
        let uri = Url::parse("file:///workspace/composer.mmt").unwrap();
        let source = "< _0: 你好😀";
        let mut server = MmtLanguageServer::default();
        server
            .request("initialize", initialize_with_encoding("utf-8"))
            .unwrap();
        open_document(&mut server, &uri, 7, source);
        let glyph = server
            .projections
            .get(&uri)
            .unwrap()
            .projection
            .emitted
            .source
            .find("#text(\"")
            .unwrap()
            + 1;
        let target_params =
            preview_target_params(&server, &uri, glyph, &PositionEncodingKind::UTF8);
        let target_envelope: Value = serde_json::from_str(
            &server.request_json("mmt/previewComposerTarget", &target_params.to_string()),
        )
        .unwrap();
        let target = &target_envelope["result"];
        assert_eq!(target["kind"], "Editable");
        assert_eq!(target["textDocument"]["uri"], uri.as_str());
        assert_eq!(target["textDocument"]["version"], 7);
        assert_eq!(target["target"]["kind"], "statement");
        assert_eq!(
            target["target"]["range"]["start"],
            serde_json::json!({"line": 0, "character": 0})
        );
        assert_eq!(target["target"]["range"]["end"]["character"], source.len());
        assert_eq!(target["properties"]["continued"], "auto");
        assert!(target["properties"].get("actorDisplayName").is_none());
        assert_eq!(
            target["properties"]["statementText"],
            serde_json::json!({
                "current":"你好😀",
                "mode":"inherit",
                "resolvedMode":"textMacro",
                "inheritedMode":"textMacro"
            })
        );

        let edit_params = serde_json::json!({
            "textDocument": target["textDocument"],
            "target": target["target"],
            "command": {"kind": "setStatementContinued", "value": "true"}
        });
        let edit_envelope: Value = serde_json::from_str(
            &server.request_json("mmt/composerEdit", &edit_params.to_string()),
        )
        .unwrap();
        let edit = &edit_envelope["result"];
        assert_eq!(edit["kind"], "Edit");
        assert!(edit["edit"].get("changes").is_none());
        let document_changes = edit["edit"]["documentChanges"].as_array().unwrap();
        assert_eq!(document_changes.len(), 1);
        assert_eq!(document_changes[0]["textDocument"]["uri"], uri.as_str());
        assert_eq!(document_changes[0]["textDocument"]["version"], 7);
        assert_eq!(document_changes[0]["edits"].as_array().unwrap().len(), 1);
        assert_eq!(server.service.snapshot(&uri).unwrap().text, source);
        assert_eq!(server.service.snapshot(&uri).unwrap().version, 7);

        let mut stale_edit = edit_params.clone();
        stale_edit["textDocument"]["version"] = serde_json::json!(6);
        let stale = server.request("mmt/composerEdit", stale_edit).unwrap();
        assert_eq!(
            stale,
            serde_json::json!({"kind": "Rejected", "reason": "staleDocument"})
        );

        let changed = server
            .request(
                "mmt/composerEdit",
                serde_json::json!({
                    "textDocument": {"uri": uri, "version": 7},
                    "target": {
                        "kind": "statement",
                        "range": {
                            "start": {"line": 0, "character": 1},
                            "end": {"line": 0, "character": source.len()}
                        }
                    },
                    "command": {"kind": "setStatementContinued", "value": "false"}
                }),
            )
            .unwrap();
        assert_eq!(
            changed,
            serde_json::json!({"kind": "Rejected", "reason": "targetChanged"})
        );

        let empty = server
            .request(
                "mmt/composerEdit",
                serde_json::json!({
                    "textDocument": {"uri": uri, "version": 7},
                    "target": target["target"],
                    "command": {"kind": "setActorDisplayNameFromStatement", "value": ""}
                }),
            )
            .unwrap();
        assert_eq!(
            empty,
            serde_json::json!({"kind": "Rejected", "reason": "invalidValue"})
        );
        let builtin = server
            .request(
                "mmt/composerEdit",
                serde_json::json!({
                    "textDocument": {"uri": uri, "version": 7},
                    "target": target["target"],
                    "command": {"kind": "setActorDisplayNameFromStatement", "value": "名字"}
                }),
            )
            .unwrap();
        assert_eq!(
            builtin,
            serde_json::json!({"kind": "Rejected", "reason": "actorUnavailable"})
        );

        let oversized_display_name = server
            .request(
                "mmt/composerEdit",
                serde_json::json!({
                    "textDocument": {"uri": uri, "version": 7},
                    "target": target["target"],
                    "command": {
                        "kind": "setActorDisplayNameFromStatement",
                        "value": "名".repeat(MAX_COMPOSER_DISPLAY_NAME_BYTES + 1)
                    }
                }),
            )
            .unwrap_err();
        assert_eq!(oversized_display_name.code, -32602);
        assert!(oversized_display_name.message.contains("display-name"));

        for (field, invalid_digest) in [
            ("sourceContent", "0".repeat(CANONICAL_DIGEST_HEX_LEN - 1)),
            ("projectDigest", "g".repeat(CANONICAL_DIGEST_HEX_LEN)),
            ("projectionKey", "0".repeat(CANONICAL_DIGEST_HEX_LEN + 1)),
        ] {
            let mut malformed_identity = target_params.clone();
            malformed_identity[field] = Value::String(invalid_digest);
            let error = server
                .request("mmt/previewComposerTarget", malformed_identity)
                .unwrap_err();
            assert_eq!(error.code, -32602);
            assert!(error.message.contains(field));
        }

        let mut unknown = target_params;
        unknown["unexpected"] = Value::Bool(true);
        let strict = server
            .request("mmt/previewComposerTarget", unknown)
            .unwrap_err();
        assert_eq!(strict.code, -32602);
    }

    #[test]
    fn composer_document_is_strict_versioned_bounded_and_error_visible() {
        let mut server = MmtLanguageServer::default();
        server
            .request("initialize", initialize_with_encoding("utf-16"))
            .unwrap();

        let valid_uri = Url::parse("file:///workspace/document.mmt").unwrap();
        open_document(&mut server, &valid_uri, 3, "- Unicode 😀\r\n");
        let valid = server
            .request(
                "mmt/composerDocument",
                serde_json::json!({
                    "textDocument": {"uri": valid_uri, "version": 3}
                }),
            )
            .unwrap();
        assert_eq!(valid["kind"], "Snapshot");
        assert_eq!(
            valid["sourceDigest"],
            "b764fdd6f4a8bb209bebee01873de5b29986a4ef2263ab6deae0c853ee1249f0"
        );
        assert_eq!(valid["nodes"][0]["kind"], "narration");
        assert_eq!(
            valid["nodes"][0]["range"],
            serde_json::json!({
                "start": {"line": 0, "character": 0},
                "end": {"line": 1, "character": 0}
            })
        );
        assert_eq!(valid["boundaries"].as_array().unwrap().len(), 2);

        let empty_uri = Url::parse("file:///workspace/empty.mmt").unwrap();
        open_document(&mut server, &empty_uri, 1, "");
        let empty = server
            .request(
                "mmt/composerDocument",
                serde_json::json!({
                    "textDocument": {"uri": empty_uri, "version": 1}
                }),
            )
            .unwrap();
        assert_eq!(empty["kind"], "Snapshot");
        assert_eq!(empty["nodes"], serde_json::json!([]));
        assert_eq!(empty["boundaries"].as_array().unwrap().len(), 1);

        let error_uri = Url::parse("file:///workspace/error.mmt").unwrap();
        let error_source = format!("// {}😀", "x".repeat(5000));
        open_document(&mut server, &error_uri, 8, &error_source);
        let error = server
            .request(
                "mmt/composerDocument",
                serde_json::json!({
                    "textDocument": {"uri": error_uri, "version": 8}
                }),
            )
            .unwrap();
        assert_eq!(error["kind"], "Snapshot");
        assert_eq!(error["nodes"][0]["kind"], "opaque");
        assert_eq!(error["nodes"][0]["category"], "recoverableError");
        assert_eq!(error["nodes"][0]["sourceTruncated"], true);
        assert!(error["nodes"][0]["sourcePreview"].as_str().unwrap().len() <= 4096);
        assert!(
            error["nodes"][0]["summary"]
                .as_str()
                .unwrap()
                .chars()
                .count()
                <= 160
        );
        assert!(
            error["boundaries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|boundary| boundary["insert"].is_null())
        );

        assert_eq!(
            server
                .request(
                    "mmt/composerDocument",
                    serde_json::json!({
                        "textDocument": {"uri": valid_uri, "version": 2}
                    }),
                )
                .unwrap(),
            serde_json::json!({"kind":"Rejected","reason":"staleDocument"})
        );
        assert!(
            server
                .request(
                    "mmt/composerDocument",
                    serde_json::json!({
                        "textDocument": {"uri": valid_uri, "version": 3},
                        "unknown": true
                    }),
                )
                .is_err()
        );
    }

    #[test]
    fn composer_structure_wire_is_strict_and_returns_one_versioned_edit() {
        let uri = Url::parse("file:///workspace/structure.mmt").unwrap();
        let source = "- A\n- B";
        let mut server = MmtLanguageServer::default();
        server
            .request("initialize", initialize_with_encoding("utf-16"))
            .unwrap();
        open_document(&mut server, &uri, 5, source);
        let document = server
            .request(
                "mmt/composerDocument",
                serde_json::json!({
                    "textDocument": {"uri": uri, "version": 5}
                }),
            )
            .unwrap();
        let first = &document["nodes"][0];
        let node_ref = serde_json::json!({
            "nodeKey": first["nodeKey"],
            "nodeKind": first["kind"],
            "range": first["range"]
        });
        let params = serde_json::json!({
            "textDocument": document["textDocument"],
            "sourceDigest": document["sourceDigest"],
            "target": {"kind": "node", "node": node_ref},
            "command": {
                "kind": "moveNode",
                "anchor": first["capabilities"]["moveDown"]
            }
        });
        let edit = server.request("mmt/composerEdit", params.clone()).unwrap();
        assert_eq!(edit["kind"], "Edit");
        assert!(edit["edit"].get("changes").is_none());
        assert_eq!(edit["edit"]["documentChanges"].as_array().unwrap().len(), 1);
        assert_eq!(
            edit["edit"]["documentChanges"][0]["textDocument"],
            serde_json::json!({"uri":uri,"version":5})
        );
        assert_eq!(
            edit["edit"]["documentChanges"][0]["edits"],
            serde_json::json!([{
                "range": {
                    "start": {"line":0,"character":0},
                    "end": {"line":1,"character":3}
                },
                "newText":"- B\n- A"
            }])
        );
        assert_eq!(server.service.snapshot(&uri).unwrap().text, source);

        let mut stale_digest = params.clone();
        stale_digest["sourceDigest"] = serde_json::json!("0".repeat(64));
        assert_eq!(
            server.request("mmt/composerEdit", stale_digest).unwrap(),
            serde_json::json!({"kind":"Rejected","reason":"staleDocument"})
        );

        let mut invalid_combo = params.clone();
        invalid_combo["target"] = document["boundaries"][0]["target"].clone();
        assert!(server.request("mmt/composerEdit", invalid_combo).is_err());

        let mut unknown = params.clone();
        unknown["command"]["unknown"] = serde_json::json!(true);
        assert!(server.request("mmt/composerEdit", unknown).is_err());

        let mut overlong = params;
        overlong["command"] = serde_json::json!({
            "kind":"insertStatement",
            "statement":{
                "kind":"narration",
                "body":{"value":"x".repeat(COMPOSER_STATEMENT_TEXT_MAX_BYTES + 1),"mode":"inherit"}
            }
        });
        overlong["target"] = document["boundaries"][0]["target"].clone();
        assert!(server.request("mmt/composerEdit", overlong).is_err());
    }

    #[test]
    fn preview_composer_target_uses_utf16_and_fails_closed_for_stale_or_unsupported_locations() {
        let uri = Url::parse("file:///workspace/composer-utf16.mmt").unwrap();
        let source = "< _0: 你好😀";
        let mut server = MmtLanguageServer::default();
        server
            .request("initialize", initialize_with_encoding("utf-16"))
            .unwrap();
        open_document(&mut server, &uri, 1, source);
        let glyph = server
            .projections
            .get(&uri)
            .unwrap()
            .projection
            .emitted
            .source
            .find("#text(\"")
            .unwrap()
            + 1;
        let params = preview_target_params(&server, &uri, glyph, &PositionEncodingKind::UTF16);
        let editable = server
            .request("mmt/previewComposerTarget", params.clone())
            .unwrap();
        assert_eq!(editable["kind"], "Editable");
        assert_eq!(editable["target"]["range"]["end"]["character"], 10);

        let mut external = params.clone();
        external["location"]["uri"] = serde_json::json!("mmt-package:/fixture.typ");
        let unsupported = server
            .request("mmt/previewComposerTarget", external)
            .unwrap();
        assert_eq!(
            unsupported,
            serde_json::json!({"kind": "Unavailable", "reason": "unsupportedNode"})
        );

        let mut non_mmt = params.clone();
        non_mmt["sourceUri"] = serde_json::json!("file:///workspace/not-open.mmt");
        let unavailable = server
            .request("mmt/previewComposerTarget", non_mmt)
            .unwrap();
        assert_eq!(
            unavailable,
            serde_json::json!({"kind": "Unavailable", "reason": "nonMmtSource"})
        );

        server
            .notification(
                "textDocument/didChange",
                serde_json::json!({
                    "textDocument": {"uri": uri, "version": 2},
                    "contentChanges": [{"text": "< _0: changed"}]
                }),
            )
            .unwrap();
        let stale = server.request("mmt/previewComposerTarget", params).unwrap();
        assert_eq!(
            stale,
            serde_json::json!({"kind": "Unavailable", "reason": "stalePreview"})
        );
    }

    #[test]
    fn composer_requests_return_unmapped_error_and_candidate_rejections_without_edits() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();

        let chat_uri = Url::parse("file:///workspace/unmapped.mmt").unwrap();
        open_document(&mut server, &chat_uri, 1, "< _0: hello");
        let unmapped_params =
            preview_target_params(&server, &chat_uri, 0, &PositionEncodingKind::UTF8);
        let unmapped = server
            .request("mmt/previewComposerTarget", unmapped_params)
            .unwrap();
        assert_eq!(
            unmapped,
            serde_json::json!({"kind": "Unavailable", "reason": "unmapped"})
        );

        let narration_uri = Url::parse("file:///workspace/narration.mmt").unwrap();
        open_document(&mut server, &narration_uri, 1, "- narration");
        let projection = server.projections.get(&narration_uri).unwrap();
        let authored = projection
            .projection
            .emitted
            .source_map
            .iter()
            .find(|entry| {
                matches!(
                    &projection.projection.emitted.origins[entry.origin_id],
                    mmt_rs::emit::Origin::MmtRange { .. }
                )
            })
            .unwrap()
            .generated_range
            .start;
        let narration_params = preview_target_params(
            &server,
            &narration_uri,
            authored,
            &PositionEncodingKind::UTF8,
        );
        let narration_target = server
            .request("mmt/previewComposerTarget", narration_params)
            .unwrap();
        assert_eq!(narration_target["kind"], "Editable");
        assert_eq!(
            narration_target["properties"],
            serde_json::json!({"statementText":{
                "current":"narration",
                "mode":"inherit",
                "resolvedMode":"textMacro",
                "inheritedMode":"textMacro"
            }})
        );

        let broken_uri = Url::parse("file:///workspace/broken.mmt").unwrap();
        open_document(&mut server, &broken_uri, 1, "not syntax");
        let broken_params =
            preview_target_params(&server, &broken_uri, 0, &PositionEncodingKind::UTF8);
        let broken = server
            .request("mmt/previewComposerTarget", broken_params)
            .unwrap();
        assert_eq!(
            broken,
            serde_json::json!({"kind": "Unavailable", "reason": "documentHasErrors"})
        );
        let broken_edit = server
            .request(
                "mmt/composerEdit",
                serde_json::json!({
                    "textDocument": {"uri": broken_uri, "version": 1},
                    "target": {
                        "kind": "statement",
                        "range": {
                            "start": {"line": 0, "character": 0},
                            "end": {"line": 0, "character": 10}
                        }
                    },
                    "command": {"kind": "setStatementContinued", "value": "true"}
                }),
            )
            .unwrap();
        assert_eq!(
            broken_edit,
            serde_json::json!({"kind": "Rejected", "reason": "documentHasErrors"})
        );

        let malformed_uri = Url::parse("file:///workspace/malformed-patch.mmt").unwrap();
        let malformed_source = "<(continued: true, continued: false) _0: hello";
        open_document(&mut server, &malformed_uri, 1, malformed_source);
        let candidate = server
            .request(
                "mmt/composerEdit",
                serde_json::json!({
                    "textDocument": {"uri": malformed_uri, "version": 1},
                    "target": {
                        "kind": "statement",
                        "range": {
                            "start": {"line": 0, "character": 0},
                            "end": {"line": 0, "character": malformed_source.len()}
                        }
                    },
                    "command": {"kind": "setStatementContinued", "value": "false"}
                }),
            )
            .unwrap();
        assert_eq!(
            candidate,
            serde_json::json!({"kind": "Rejected", "reason": "candidateInvalid"})
        );
        assert!(candidate.get("edit").is_none());
    }

    #[test]
    fn composer_display_name_edit_uses_current_pack_context_and_exact_unicode_value() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"A":{"names":["A"],"display_name":"Actor A"}}
        }"#;
        let uri = Url::parse("file:///workspace/display-name.mmt").unwrap();
        let source = "> A: before\n> _0: target😀";
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        server
            .request(
                "mmt/updatePackManifests",
                serde_json::json!({
                    "revision": 1,
                    "sources": [{"json": manifest}]
                }),
            )
            .unwrap();
        open_document(&mut server, &uri, 3, source);
        let edit = server
            .request(
                "mmt/composerEdit",
                serde_json::json!({
                    "textDocument": {"uri": uri, "version": 3},
                    "target": {
                        "kind": "statement",
                        "range": {
                            "start": {"line": 1, "character": 0},
                            "end": {"line": 1, "character": 16}
                        }
                    },
                    "command": {
                        "kind": "setActorDisplayNameFromStatement",
                        "value": "老师 😀 "
                    }
                }),
            )
            .unwrap();
        assert_eq!(edit["kind"], "Edit");
        assert_eq!(
            edit["edit"]["documentChanges"][0]["textDocument"]["version"],
            3
        );
        let source_edit = &edit["edit"]["documentChanges"][0]["edits"][0];
        assert!(
            source_edit["newText"]
                .as_str()
                .unwrap()
                .contains("display-name: \"老师 😀 \"")
        );
        assert_eq!(server.service.snapshot(&uri).unwrap().text, source);
    }

    #[test]
    fn composer_statement_text_edit_is_strict_minimal_and_versioned() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"A":{"names":["A"],"display_name":"Actor A"}}
        }"#;
        let uri = Url::parse("file:///workspace/message-text.mmt").unwrap();
        let source = ">(fill: green) A: old";
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        server
            .request(
                "mmt/updatePackManifests",
                serde_json::json!({
                    "revision": 1,
                    "sources": [{"json": manifest}]
                }),
            )
            .unwrap();
        open_document(&mut server, &uri, 3, source);
        let params = serde_json::json!({
            "textDocument": {"uri": uri, "version": 3},
            "target": {
                "kind": "statement",
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 21}
                }
            },
            "command": {
                "kind": "setStatementBody",
                "value": "新正文😀 \"quote\" \\\\path",
                "mode": "inherit"
            }
        });
        let edit = server.request("mmt/composerEdit", params.clone()).unwrap();
        assert_eq!(edit["kind"], "Edit", "{edit}");
        assert_eq!(
            edit["edit"]["documentChanges"][0]["textDocument"],
            serde_json::json!({"uri": uri, "version": 3})
        );
        assert_eq!(edit["edit"].get("changes"), None);
        assert_eq!(
            edit["edit"]["documentChanges"][0]["edits"][0],
            serde_json::json!({
                "range": {
                    "start": {"line": 0, "character": 18},
                    "end": {"line": 0, "character": 21}
                },
                "newText": "新正文😀 \"quote\" \\\\path"
            })
        );
        assert_eq!(server.service.snapshot(&uri).unwrap().text, source);

        let mut stale = params.clone();
        stale["textDocument"]["version"] = serde_json::json!(2);
        assert_eq!(
            server.request("mmt/composerEdit", stale).unwrap(),
            serde_json::json!({"kind":"Rejected","reason":"staleDocument"})
        );
        let mut invalid_candidate = params.clone();
        invalid_candidate["command"]["value"] = serde_json::json!("broken [:macro");
        assert_eq!(
            server
                .request("mmt/composerEdit", invalid_candidate)
                .unwrap(),
            serde_json::json!({"kind":"Rejected","reason":"candidateInvalid"})
        );
        for malformed in [
            serde_json::json!({"kind":"setStatementBody","value":"","mode":"inherit"}),
            serde_json::json!({"kind":"setStatementBody","value":"line one\nline two","mode":"inherit"}),
            serde_json::json!({
                "kind":"setStatementBody",
                "value":"x".repeat(COMPOSER_STATEMENT_TEXT_MAX_BYTES + 1),
                "mode":"inherit"
            }),
            serde_json::json!({"kind":"setStatementBody","value":"new","mode":"inherit","rawSource":"new"}),
            serde_json::json!({"kind":"setStatementBody","value":"new"}),
        ] {
            let mut invalid = params.clone();
            invalid["command"] = malformed;
            assert!(server.request("mmt/composerEdit", invalid).is_err());
        }
        let mut mode_params = params.clone();
        mode_params["command"] =
            serde_json::json!({"kind":"setStatementBody","value":"old","mode":"textRaw"});
        let mode_edit = server
            .request("mmt/composerEdit", mode_params.clone())
            .unwrap();
        assert_eq!(mode_edit["kind"], "Edit", "{mode_edit}");
        assert_eq!(
            mode_edit["edit"]["documentChanges"][0]["edits"][0],
            serde_json::json!({
                "range": {
                    "start": {"line": 0, "character": 18},
                    "end": {"line": 0, "character": 21}
                },
                "newText": "rt\"\"\"old\"\"\""
            })
        );
        mode_params["command"] = serde_json::json!({
            "kind":"setStatementBody",
            "value":"new #strong[Typst]",
            "mode":"typstRaw"
        });
        let typst_mode_edit = server
            .request("mmt/composerEdit", mode_params.clone())
            .unwrap();
        assert_eq!(
            typst_mode_edit["edit"]["documentChanges"][0]["edits"][0]["newText"],
            "rT\"\"\"new #strong[Typst]\"\"\""
        );
        for malformed in [
            serde_json::json!({"kind":"setStatementBody","value":"old","mode":"unknown"}),
            serde_json::json!({
                "kind":"setStatementBody",
                "value":"old",
                "mode":"textRaw",
                "scope":"document"
            }),
            serde_json::json!({"kind":"setStatementText","value":"old"}),
            serde_json::json!({"kind":"setStatementTextMode","value":"textRaw"}),
        ] {
            mode_params["command"] = malformed;
            assert!(
                server
                    .request("mmt/composerEdit", mode_params.clone())
                    .is_err()
            );
        }

        let narration_uri = Url::parse("file:///workspace/narration-text.mmt").unwrap();
        let narration_source = "- narration before";
        open_document(&mut server, &narration_uri, 4, narration_source);
        let narration_edit = server
            .request(
                "mmt/composerEdit",
                serde_json::json!({
                    "textDocument": {"uri": narration_uri, "version": 4},
                    "target": {
                        "kind": "statement",
                        "range": {
                            "start": {"line": 0, "character": 0},
                            "end": {"line": 0, "character": narration_source.len()}
                        }
                    },
                    "command": {
                        "kind": "setStatementBody",
                        "value": "narration after",
                        "mode": "inherit"
                    }
                }),
            )
            .unwrap();
        assert_eq!(
            narration_edit["edit"]["documentChanges"][0]["edits"][0],
            serde_json::json!({
                "range": {
                    "start": {"line": 0, "character": 2},
                    "end": {"line": 0, "character": narration_source.len()}
                },
                "newText": "narration after"
            })
        );
    }

    #[test]
    fn composer_avatar_edit_is_strict_pack_bound_and_versioned() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{
              "A":{"names":["A"],"display_name":"Actor A","slots":{"avatar":{"default":"default","items":{"default":{"storage":"avatars","path":"a.png"}}}}},
              "B":{"names":["B"],"display_name":"Actor B","slots":{"avatar":{"default":"default","items":{"default":{"storage":"avatars","path":"b.png"}}}}}
            },
            "storage":{"avatars":{"kind":"image-dir","base":"assets/avatar"}}
        }"#;
        let uri = Url::parse("file:///workspace/avatar.mmt").unwrap();
        let source = "> A: target😀";
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        server
            .request(
                "mmt/updatePackManifests",
                serde_json::json!({
                    "revision": 1,
                    "sources": [{"json": manifest}]
                }),
            )
            .unwrap();
        open_document(&mut server, &uri, 4, source);
        let params = serde_json::json!({
            "textDocument": {"uri": uri, "version": 4},
            "target": {
                "kind": "statement",
                "range": {
                    "start": {"line": 0, "character": 0},
                    "end": {"line": 0, "character": 15}
                }
            },
            "command": {
                "kind": "setActorAvatarFromStatement",
                "avatar": {
                    "kind": "packAvatar",
                    "entityId": "ba::B",
                    "contributionNamespace": "ba",
                    "variantId": "default"
                }
            }
        });
        let edit = server.request("mmt/composerEdit", params.clone()).unwrap();
        assert_eq!(edit["kind"], "Edit", "{edit}");
        assert_eq!(
            edit["edit"]["documentChanges"][0]["textDocument"],
            serde_json::json!({"uri": uri, "version": 4})
        );
        assert_eq!(edit["edit"].get("changes"), None);
        assert!(
            edit["edit"]["documentChanges"][0]["edits"][0]["newText"]
                .as_str()
                .unwrap()
                .contains("avatar: ba::B/ba::avatar/default")
        );
        assert_eq!(server.service.snapshot(&uri).unwrap().text, source);

        let mut missing = params.clone();
        missing["command"]["avatar"]["variantId"] = serde_json::json!("missing");
        assert_eq!(
            server.request("mmt/composerEdit", missing).unwrap(),
            serde_json::json!({"kind":"Rejected","reason":"avatarUnavailable"})
        );
        for malformed in [
            serde_json::json!({
                "kind":"packAvatar","entityId":"B","contributionNamespace":"ba","variantId":"default"
            }),
            serde_json::json!({
                "kind":"packAvatar","entityId":"ba::B","contributionNamespace":"ba::ext","variantId":"default"
            }),
            serde_json::json!({
                "kind":"packAvatar","entityId":"ba::B","contributionNamespace":"ba","variantId":"bad/value"
            }),
            serde_json::json!({
                "kind":"packAvatar","entityId":"ba::B","contributionNamespace":"ba","variantId":"default","url":"https://example.com/b.png"
            }),
            serde_json::json!({
                "kind":"packAvatar","entityId":"ba::B","contributionNamespace":"ba","variantId":"x".repeat(1025)
            }),
        ] {
            let mut invalid = params.clone();
            invalid["command"]["avatar"] = malformed;
            assert!(server.request("mmt/composerEdit", invalid).is_err());
        }

        let no_pack_uri = Url::parse("file:///workspace/avatar-no-pack.mmt").unwrap();
        let no_pack_source = "< _0: target";
        let mut no_pack = MmtLanguageServer::default();
        no_pack.request("initialize", initialize(false)).unwrap();
        open_document(&mut no_pack, &no_pack_uri, 1, no_pack_source);
        assert_eq!(
            no_pack
                .request(
                    "mmt/composerEdit",
                    serde_json::json!({
                        "textDocument":{"uri":no_pack_uri,"version":1},
                        "target":{"kind":"statement","range":{
                            "start":{"line":0,"character":0},
                            "end":{"line":0,"character":12}
                        }},
                        "command":{"kind":"setActorAvatarFromStatement","avatar":{
                            "kind":"packAvatar","entityId":"ba::B",
                            "contributionNamespace":"ba","variantId":"default"
                        }}
                    }),
                )
                .unwrap(),
            serde_json::json!({"kind":"Rejected","reason":"avatarUnavailable"})
        );
        let serialized = serde_json::to_value(ComposerPropertiesResult {
            continued: Some(ComposerContinuedResult::Auto),
            actor_display_name: Some(ComposerActorDisplayNameResult {
                current: "A".to_string(),
                scope: ComposerActorDisplayNameScope::FromStatement,
            }),
            actor_avatar: Some(ComposerActorAvatarResult {
                scope: ComposerActorAvatarScope::FromStatement,
                actor_preset_id: "ba::A".to_string(),
                current: Some(ComposerAvatarCurrentResult::PackAvatar {
                    entity_id: "ba::B".to_string(),
                    contribution_namespace: "ba".to_string(),
                    variant_id: "default".to_string(),
                }),
            }),
            statement_text: Some(ComposerStatementTextResult {
                current: "正文😀".to_string(),
                mode: ComposerStatementTextModeResult::TextMacro,
                resolved_mode: ComposerBodyModeResult::TextMacro,
                inherited_mode: ComposerBodyModeResult::TextRaw,
            }),
        })
        .unwrap();
        assert_eq!(
            serialized,
            serde_json::json!({
                "continued":"auto",
                "actorDisplayName":{"current":"A","scope":"fromStatement"},
                "actorAvatar":{
                    "scope":"fromStatement",
                    "actorPresetId":"ba::A",
                    "current":{
                        "kind":"packAvatar",
                        "entityId":"ba::B",
                        "contributionNamespace":"ba",
                        "variantId":"default"
                    }
                },
                "statementText":{
                    "current":"正文😀",
                    "mode":"textMacro",
                    "resolvedMode":"textMacro",
                    "inheritedMode":"textRaw"
                }
            })
        );
        let asset = serde_json::to_value(ComposerPropertiesResult {
            continued: Some(ComposerContinuedResult::Auto),
            actor_display_name: None,
            actor_avatar: Some(ComposerActorAvatarResult {
                scope: ComposerActorAvatarScope::FromStatement,
                actor_preset_id: "ba::A".to_string(),
                current: Some(ComposerAvatarCurrentResult::Asset {
                    asset_name: "portrait".to_string(),
                }),
            }),
            statement_text: None,
        })
        .unwrap();
        assert_eq!(
            asset["actorAvatar"]["current"],
            serde_json::json!({"kind":"asset","assetName":"portrait"})
        );
        let no_avatar = serde_json::to_value(ComposerPropertiesResult {
            continued: Some(ComposerContinuedResult::Auto),
            actor_display_name: None,
            actor_avatar: Some(ComposerActorAvatarResult {
                scope: ComposerActorAvatarScope::FromStatement,
                actor_preset_id: "ba::A".to_string(),
                current: None,
            }),
            statement_text: None,
        })
        .unwrap();
        assert_eq!(no_avatar["actorAvatar"]["current"], serde_json::Value::Null);
        let narration = serde_json::to_value(ComposerPropertiesResult {
            continued: None,
            actor_display_name: None,
            actor_avatar: None,
            statement_text: Some(ComposerStatementTextResult {
                current: "旁白正文".to_string(),
                mode: ComposerStatementTextModeResult::Inherit,
                resolved_mode: ComposerBodyModeResult::TextRaw,
                inherited_mode: ComposerBodyModeResult::TextRaw,
            }),
        })
        .unwrap();
        assert_eq!(
            narration,
            serde_json::json!({"statementText":{
                "current":"旁白正文",
                "mode":"inherit",
                "resolvedMode":"textRaw",
                "inheritedMode":"textRaw"
            }})
        );
    }

    #[test]
    fn negotiates_utf8_and_emits_revision_bound_preview_requests() {
        let mut server = MmtLanguageServer::default();
        let result = server.request("initialize", initialize(true)).unwrap();
        assert_eq!(result["capabilities"]["positionEncoding"], "utf-8");
        assert_eq!(
            result["capabilities"]["completionProvider"]["triggerCharacters"],
            serde_json::json!(["_", "~", "[", ":", ",", "#"])
        );
        assert_eq!(result["capabilities"]["definitionProvider"], true);
        assert_eq!(result["capabilities"]["referencesProvider"], true);
        assert_eq!(
            result["capabilities"]["renameProvider"]["prepareProvider"],
            true
        );

        let events = server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": "file:///workspace/example.mmt",
                        "languageId": "mmt",
                        "version": 1,
                        "text": "- hello"
                    }
                }),
            )
            .unwrap();
        assert_eq!(events[0].method, "textDocument/publishDiagnostics");
        assert_eq!(events[1].method, "mmt/previewRequested");
        assert_eq!(events[1].params["revision"], 1);
    }

    #[test]
    fn standard_semantic_requests_return_versioned_single_document_edits() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"A":{"names":["A"]}}
        }"#;
        let uri = "file:///workspace/semantic.mmt";
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        server
            .request(
                "mmt/updatePackManifests",
                serde_json::json!({
                    "revision": 1,
                    "sources": [{ "json": manifest }]
                }),
            )
            .unwrap();
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": "mmt",
                        "version": 5,
                        "text": "@actor main\npreset: ba::A\nalso-as: [alias]\n@end\n> alias: hello"
                    }
                }),
            )
            .unwrap();
        let position = serde_json::json!({
            "textDocument": { "uri": uri },
            "position": { "line": 4, "character": 3 }
        });

        let definition = server
            .request("textDocument/definition", position.clone())
            .unwrap();
        assert_eq!(definition["uri"], uri);
        assert_eq!(definition["range"]["start"]["line"], 2);
        let references = server
            .request(
                "textDocument/references",
                serde_json::json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": 4, "character": 3 },
                    "context": { "includeDeclaration": true }
                }),
            )
            .unwrap();
        assert_eq!(references.as_array().unwrap().len(), 3);
        let prepared = server
            .request("textDocument/prepareRename", position.clone())
            .unwrap();
        assert_eq!(prepared["placeholder"], "alias");
        let renamed = server
            .request(
                "textDocument/rename",
                serde_json::json!({
                    "textDocument": { "uri": uri },
                    "position": { "line": 4, "character": 3 },
                    "newName": "renamed"
                }),
            )
            .unwrap();
        assert_eq!(renamed["documentChanges"][0]["textDocument"]["version"], 5);
        assert_eq!(
            renamed["documentChanges"][0]["edits"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn serves_resolved_speaker_inlay_hints_over_the_lsp_contract() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{
                "A":{"names":["A"],"display_name":"Actor A"},
                "B":{"names":["B"],"display_name":"Actor B"}
            }
        }"#;
        let mut server = MmtLanguageServer::default();
        let initialized = server.request("initialize", initialize(false)).unwrap();
        assert_eq!(
            initialized["capabilities"]["inlayHintProvider"],
            serde_json::json!(true)
        );
        server
            .request(
                "mmt/updatePackManifests",
                serde_json::json!({
                    "revision": 1,
                    "sources": [{
                        "manifestUrl": "https://example.test/manifest.json",
                        "baseUrl": "https://example.test/",
                        "json": manifest
                    }]
                }),
            )
            .unwrap();
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": "file:///workspace/example.mmt",
                        "languageId": "mmt",
                        "version": 1,
                        "text": "> A: first\n> B: second\n> _1: third\n> ~1: fourth\n> fifth"
                    }
                }),
            )
            .unwrap();

        let hints = server
            .request(
                "textDocument/inlayHint",
                serde_json::json!({
                    "textDocument": { "uri": "file:///workspace/example.mmt" },
                    "range": {
                        "start": { "line": 0, "character": 0 },
                        "end": { "line": 4, "character": 7 }
                    }
                }),
            )
            .unwrap();
        assert_eq!(
            hints,
            serde_json::json!([
                {
                    "position": { "line": 2, "character": 4 },
                    "label": "→ Actor A",
                    "tooltip": "实际说话人：Actor A",
                    "paddingLeft": true
                },
                {
                    "position": { "line": 3, "character": 4 },
                    "label": "→ Actor A",
                    "tooltip": "实际说话人：Actor A",
                    "paddingLeft": true
                },
                {
                    "position": { "line": 4, "character": 1 },
                    "label": "→ Actor A",
                    "tooltip": "实际说话人：Actor A",
                    "paddingLeft": true
                }
            ])
        );
    }

    #[test]
    fn advertises_typst_member_completion_trigger_when_enabled() {
        let mut server = MmtLanguageServer::default();
        let result = server
            .request(
                "initialize",
                serde_json::json!({
                    "capabilities": {
                        "general": { "positionEncodings": ["utf-16"] }
                    },
                    "initializationOptions": {
                        "previewOnChange": false,
                        "typstLanguageFeatures": true
                    }
                }),
            )
            .unwrap();
        assert_eq!(
            result["capabilities"]["completionProvider"]["triggerCharacters"],
            serde_json::json!(["_", "~", "[", ":", ",", "#", "."])
        );
    }

    #[test]
    fn projection_store_tracks_the_open_document_revision_and_close() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = lsp_types::Url::parse("file:///workspace/example.mmt").unwrap();
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri.clone(),
                        "languageId": "mmt",
                        "version": 1,
                        "text": "@typ: #let x = 1"
                    }
                }),
            )
            .unwrap();
        let first = server.projections().get(&uri).unwrap();
        assert_eq!(first.source_version, 1);
        assert_eq!(first.revision, 1);

        server
            .notification(
                "textDocument/didChange",
                serde_json::json!({
                    "textDocument": {"uri": uri.clone(), "version": 2},
                    "contentChanges": [{"text": "@typ: #let x = 2"}]
                }),
            )
            .unwrap();
        let second = server.projections().get(&uri).unwrap();
        assert_eq!(second.source_version, 2);

        assert_eq!(second.revision, 2);

        let expected_closed_entry = second.entry_uri.to_string();
        let close_events = server
            .notification(
                "textDocument/didClose",
                serde_json::json!({"textDocument": {"uri": uri.clone()}}),
            )
            .unwrap();
        assert!(close_events.iter().any(|event| {
            event.method == "mmt/typstProjectClosed"
                && event.params["sourceUri"] == uri.as_str()
                && event.params["entryUri"] == expected_closed_entry
        }));
        assert!(server.projections().get(&uri).is_none());
    }

    #[test]
    fn projected_edit_rpc_binds_current_projection_and_standard_document_version() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = Url::parse("file:///workspace/projected-edit.mmt").unwrap();
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": "mmt",
                        "version": 1,
                        "text": "@typ: #let alpha = 1"
                    }
                }),
            )
            .unwrap();
        let projection = server.projections().get(&uri).unwrap();
        let update = projection.project_update();
        let projected_source = &projection.projection.emitted.source;
        let alpha = projected_source.find("alpha").unwrap();
        let prefix = &projected_source[..alpha];
        let line = prefix.bytes().filter(|byte| *byte == b'\n').count();
        let line_start = prefix.rfind('\n').map_or(0, |newline| newline + 1);
        let character = projected_source[line_start..alpha].encode_utf16().count();
        let transaction = serde_json::json!({
            "protocolVersion": 1,
            "documents": [{
                "virtualUri": update.entry_uri,
                "sourceContent": update.source_content,
                "projectionKey": update.projection_key,
                "encoding": "utf-16"
            }],
            "edits": [{
                "virtualUri": projection.entry_uri,
                "range": {
                    "start": {"line": line, "character": character},
                    "end": {"line": line, "character": character + 5}
                },
                "newText": "beta"
            }],
            "expectedVersions": [{"uri": uri, "version": 1}]
        });
        let validated = server
            .request("mmt/validateProjectedEdit", transaction.clone())
            .unwrap();
        assert_eq!(validated["kind"], "Validated");
        assert_eq!(validated["documents"][0]["normalizedUri"], uri.as_str());
        assert_eq!(validated["documents"][0]["edits"][0]["newText"], "beta");

        server
            .notification(
                "textDocument/didChange",
                serde_json::json!({
                    "textDocument": {"uri": uri, "version": 2},
                    "contentChanges": [{"text": "@typ: #let alpha = 2"}]
                }),
            )
            .unwrap();
        let stale = server
            .request("mmt/validateProjectedEdit", transaction)
            .unwrap();
        assert_eq!(stale["kind"], "StaleProjection");
        assert_eq!(stale["reason"], "retiredProjection");
    }

    #[test]
    fn returns_current_typst_project_for_preview_replay() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = lsp_types::Url::parse("file:///workspace/example.mmt").unwrap();
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri.clone(),
                        "languageId": "mmt",
                        "version": 7,
                        "text": "@typ: #let x = 1"
                    }
                }),
            )
            .unwrap();

        let project = server
            .request(
                "mmt/getTypstProject",
                serde_json::json!({"uri": uri.clone()}),
            )
            .unwrap();
        assert_eq!(project["sourceUri"], uri.as_str());
        assert_eq!(project["sourceVersion"], 7);
        assert_eq!(project["revision"], 1);
        assert!(
            project["files"]
                .as_array()
                .is_some_and(|files| !files.is_empty())
        );
        assert_eq!(project["full"], true);
        assert!(
            project["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|file| file.get("dataBase64").is_some())
        );
        let events = server
            .notification(
                "textDocument/didChange",
                serde_json::json!({
                    "textDocument": {"uri": uri.clone(), "version": 8},
                    "contentChanges": [{"text": "@typ: #let x = 2"}]
                }),
            )
            .unwrap();
        let delta = events
            .iter()
            .find(|event| event.method == "mmt/typstProjectUpdated")
            .expect("standard didChange project update");
        assert_eq!(delta.params["full"], false);
        assert_eq!(delta.params["files"].as_array().unwrap().len(), 1);
        assert_eq!(delta.params["files"][0]["uri"], delta.params["entryUri"]);
        assert!(
            events
                .iter()
                .any(|event| event.method == "textDocument/publishDiagnostics")
        );

        let missing = server
            .request(
                "mmt/getTypstProject",
                serde_json::json!({"uri": "file:///workspace/missing.mmt"}),
            )
            .unwrap();
        assert!(missing.is_null());
    }

    #[test]
    fn opens_multiline_typ_block_and_returns_current_typst_project() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = lsp_types::Url::parse("file:///workspace/test.mmt").unwrap();
        let events = server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri.clone(),
                        "languageId": "mmt",
                        "version": 1,
                        "text": "@typ\r\n\r\n#let step(body) = text(fill: white, weight: \"bold\", body)\r\n\r\n@end"
                    }
                }),
            )
            .unwrap();

        assert!(
            !events.iter().any(|event| {
                event.method == "window/logMessage"
                    && event.params["message"]
                        .as_str()
                        .is_some_and(|message| message.starts_with("mmt/projection:"))
            }),
            "unexpected projection error: {events:?}",
        );
        let project = server
            .request(
                "mmt/getTypstProject",
                serde_json::json!({"uri": uri.clone()}),
            )
            .unwrap();
        assert!(!project.is_null(), "projection was not retained");
        assert_eq!(project["sourceUri"], uri.as_str());
        assert!(
            project["files"]
                .as_array()
                .is_some_and(
                    |files| files
                        .iter()
                        .any(|file| file["text"].as_str().is_some_and(|text| {
                            text.contains(
                                "#let step(body) = text(fill: white, weight: \"bold\", body)",
                            ) && text.contains("\r\n")
                        }))
                ),
            "Typst project omitted the multiline @typ body: {project}",
        );
    }

    #[test]
    fn get_typst_project_returns_the_recorded_projection_error() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = lsp_types::Url::parse("file:///workspace/failed.mmt").unwrap();
        server.projection_errors.insert(
            uri.clone(),
            ServerError {
                code: -32603,
                message: "failed to build Typst projection: invalid boundary".to_string(),
                data: Some(serde_json::json!({"uri": uri, "revision": 1})),
            },
        );

        let error = server
            .request("mmt/getTypstProject", serde_json::json!({"uri": uri}))
            .unwrap_err();
        assert_eq!(error.code, -32603);
        assert!(error.message.contains("invalid boundary"));
    }

    #[test]
    fn standard_did_change_returns_full_bundle_before_project_fetch() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = lsp_types::Url::parse("file:///workspace/atomic.mmt").unwrap();
        server
            .service
            .open(uri.clone(), 1, "@typ: #let x = 1".to_string());
        server.refresh_projection(&uri);

        let events = server
            .notification(
                "textDocument/didChange",
                serde_json::json!({
                    "textDocument": {"uri": uri, "version": 2},
                    "contentChanges": [{"text": "@typ: #let x = 2"}]
                }),
            )
            .unwrap();
        let project = events
            .iter()
            .find(|event| event.method == "mmt/typstProjectUpdated")
            .expect("standard didChange project update");
        assert_eq!(project.params["full"], true);
        assert!(
            project.params["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|file| file.get("dataBase64").is_some())
        );
    }

    #[test]
    fn projection_failure_closes_the_host_project_instead_of_republishing_it() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = lsp_types::Url::parse("file:///workspace/failure.mmt").unwrap();
        server
            .service
            .open(uri.clone(), 1, "@typ: #let x = 1".to_string());
        server.refresh_projection(&uri);
        let initial = server.document_events(uri.clone(), 1, None);
        let initial_update = initial
            .iter()
            .find(|event| event.method == "mmt/typstProjectUpdated")
            .unwrap();
        assert_eq!(initial_update.params["full"], true);
        assert!(server.published_project_entries.contains_key(&uri));
        server.projections.remove(&uri);
        let error = ServerError {
            code: -32603,
            message: "projection failed".to_string(),
            data: None,
        }
        .log_event("mmt/projection");
        let events = server.document_events(uri.clone(), 1, Some(error));
        assert!(
            !events
                .iter()
                .any(|event| event.method == "mmt/typstProjectUpdated")
        );
        assert!(events.iter().any(|event| {
            event.method == "mmt/typstProjectClosed"
                && event.params["sourceUri"] == uri.as_str()
                && event.params["entryUri"].is_string()
        }));
        assert!(!server.published_project_entries.contains_key(&uri));
        server
            .service
            .change(uri.clone(), 2, "@typ: #let x = 2".to_string())
            .unwrap();
        server.refresh_projection(&uri);
        let recovered = server.document_events(uri, 2, None);
        let update = recovered
            .iter()
            .find(|event| event.method == "mmt/typstProjectUpdated")
            .unwrap();
        assert_eq!(update.params["full"], true);
        assert!(
            update.params["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|file| file.get("dataBase64").is_some())
        );
    }

    #[test]
    fn semantic_route_prioritizes_unresolved_native_zones_and_rejects_stale_positions() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = lsp_types::Url::parse("file:///workspace/semantic-route.mmt").unwrap();
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri.clone(),
                        "languageId": "mmt",
                        "version": 1,
                        "text": "> ghost: hello\n@typ\n#let projected = 1\n@end"
                    }
                }),
            )
            .unwrap();
        server.refresh_projection(&uri);
        assert_ne!(
            server.projections.get(&uri).unwrap().revision,
            server.service.snapshot(&uri).unwrap().revision
        );
        let route = |server: &mut MmtLanguageServer, line, character, version| {
            server
                .request(
                    "mmt/semanticRoute",
                    serde_json::json!({
                        "textDocument": {"uri": uri.clone()},
                        "position": {"line": line, "character": character},
                        "version": version,
                        "backendEncoding": "utf-16"
                    }),
                )
                .unwrap()
        };
        assert_eq!(route(&mut server, 0, 3, 1), serde_json::json!("native"));
        assert_eq!(route(&mut server, 2, 7, 1), serde_json::json!("projected"));
        assert_eq!(route(&mut server, 1, 1, 1), serde_json::json!("none"));
        assert_eq!(route(&mut server, 2, 7, 2), serde_json::json!("none"));
    }

    #[test]
    fn typst_route_maps_identity_completion_and_rejects_stale_revision() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = lsp_types::Url::parse("file:///workspace/example.mmt").unwrap();
        let events = server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri.clone(),
                        "languageId": "mmt",
                        "version": 1,
                        "text": "@typ\n#let gre\n@end"
                    }
                }),
            )
            .unwrap();
        assert!(
            events
                .iter()
                .any(|event| event.method == "mmt/typstProjectUpdated")
        );

        let route = server
            .request(
                "mmt/typstPosition",
                serde_json::json!({
                    "textDocument": {"uri": uri.clone()},
                    "position": {"line": 1, "character": 8},
                    "backendEncoding": "utf-16"
                }),
            )
            .unwrap();
        assert_eq!(route["revision"], 1);
        let projected_range = server
            .request(
                "mmt/typstRange",
                serde_json::json!({
                    "textDocument": {"uri": uri.clone()},
                    "range": {
                        "start": {"line": 1, "character": 5},
                        "end": {"line": 1, "character": 8}
                    },
                    "backendEncoding": "utf-16"
                }),
            )
            .unwrap();
        assert_eq!(projected_range["revision"], route["revision"]);
        assert_eq!(projected_range["entryUri"], route["entryUri"]);
        assert_eq!(projected_range["range"]["end"], route["position"]);
        let unsafe_projected_range = server
            .request(
                "mmt/typstRange",
                serde_json::json!({
                    "textDocument": {"uri": uri.clone()},
                    "range": {
                        "start": {"line": 0, "character": 0},
                        "end": {"line": 1, "character": 8}
                    },
                    "backendEncoding": "utf-16"
                }),
            )
            .unwrap();
        assert!(unsafe_projected_range.is_null());
        let mapped = server
            .request(
                "mmt/mapTypstCompletion",
                serde_json::json!({
                    "sourceUri": uri.clone(),
                    "revision": route["revision"],
                    "entryUri": route["entryUri"],
                    "backendEncoding": route["positionEncoding"],
                    "sourceContent": route["sourceContent"],
                    "projectDigest": route["projectDigest"],
                    "projectionKey": route["projectionKey"],
                    "items": [{
                        "label": "greet",
                        "textEdit": {
                            "range": {
                                "start": route["position"],
                                "end": route["position"]
                            },
                            "newText": "greet"
                        }
                    }]
                }),
            )
            .unwrap();
        assert_eq!(mapped[0]["textEdit"]["range"]["start"]["line"], 1);
        assert_eq!(mapped[0]["textEdit"]["range"]["start"]["character"], 8);
        let mut authored_backend_position = route["position"].clone();
        let authored_character = authored_backend_position["character"]
            .as_u64()
            .unwrap()
            .checked_sub(1)
            .unwrap();
        authored_backend_position["character"] = serde_json::json!(authored_character);

        let reads = server
            .request(
                "mmt/mapTypstReadLocations",
                serde_json::json!({
                    "sourceUri": uri.clone(),
                    "revision": route["revision"],
                    "entryUri": route["entryUri"],
                    "backendEncoding": route["positionEncoding"],
                    "sourceContent": route["sourceContent"],
                    "projectDigest": route["projectDigest"],
                    "projectionKey": route["projectionKey"],
                    "locations": [
                        {
                            "uri": route["entryUri"],
                            "range": {"start": authored_backend_position, "end": route["position"]}
                        },
                        {
                            "uri": route["entryUri"],
                            "range": {
                                "start": {"line": 0, "character": 0},
                                "end": {"line": 0, "character": 1}
                            }
                        },
                        {
                            "uri": "file:///workspace/helper.typ",
                            "range": {
                                "start": {"line": 0, "character": 0},
                                "end": {"line": 0, "character": 1}
                            }
                        },
                        {
                            "uri": "mmt-package:/preview/example/1.0.0/lib.typ?digest=abc",
                            "range": {
                                "start": {"line": 0, "character": 0},
                                "end": {"line": 0, "character": 1}
                            }
                        }
                    ]
                }),
            )
            .unwrap();
        assert_eq!(reads[0]["kind"], "authoredIdentity");
        assert_eq!(reads[0]["uri"], uri.as_str());
        assert_eq!(reads[1]["kind"], "generatedProjection");
        assert!(
            reads[1]["uri"]
                .as_str()
                .unwrap()
                .starts_with("mmt-projection:")
        );
        assert_eq!(reads[2]["kind"], "workspaceTypst");
        assert_eq!(reads[3]["kind"], "packageFile");

        server
            .notification(
                "textDocument/didChange",
                serde_json::json!({
                    "textDocument": {"uri": uri.clone(), "version": 2},
                    "contentChanges": [{"text": "@typ\n#let greet\n@end"}]
                }),
            )
            .unwrap();
        let stale = server
            .request(
                "mmt/mapTypstCompletion",
                serde_json::json!({
                    "sourceUri": uri.clone(),
                    "revision": route["revision"],
                    "entryUri": route["entryUri"],
                    "backendEncoding": route["positionEncoding"],
                    "sourceContent": route["sourceContent"],
                    "projectDigest": route["projectDigest"],
                    "projectionKey": route["projectionKey"],
                    "items": []
                }),
            )
            .unwrap();
        assert!(stale.is_null());
        let stale_read = server
            .request(
                "mmt/mapTypstReadLocations",
                serde_json::json!({
                    "sourceUri": uri,
                    "revision": route["revision"],
                    "entryUri": route["entryUri"],
                    "backendEncoding": route["positionEncoding"],
                    "sourceContent": route["sourceContent"],
                    "projectDigest": route["projectDigest"],
                    "projectionKey": route["projectionKey"],
                    "locations": [{
                        "uri": route["entryUri"],
                        "range": {"start": route["position"], "end": route["position"]}
                    }]
                }),
            )
            .unwrap();
        assert_eq!(stale_read[0]["kind"], "staleUnknown");
        assert!(stale_read[0].get("uri").is_none());
    }

    #[test]
    fn typst_range_maps_a_cursor_inside_a_multiline_typ_block() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = lsp_types::Url::parse("file:///workspace/multiline.mmt").unwrap();
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri.clone(),
                        "languageId": "mmt",
                        "version": 1,
                        "text": "@typ\n12345\n#divider()\nabcde 123434\n@end\n"
                    }
                }),
            )
            .unwrap();

        let projected = server
            .request(
                "mmt/typstRange",
                serde_json::json!({
                    "textDocument": {"uri": uri},
                    "range": {
                        "start": {"line": 3, "character": 2},
                        "end": {"line": 3, "character": 2}
                    },
                    "backendEncoding": "utf-16"
                }),
            )
            .unwrap();

        assert!(!projected.is_null());
        assert_eq!(projected["range"]["start"], projected["range"]["end"]);
    }

    #[test]
    fn request_transcript_returns_symbols_and_folding_ranges() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": "file:///workspace/example.mmt",
                        "languageId": "mmt",
                        "version": 1,
                        "text": "@reply\n- A\n- B\n@end"
                    }
                }),
            )
            .unwrap();
        let params = serde_json::json!({
            "textDocument": { "uri": "file:///workspace/example.mmt" }
        });
        let symbols = server
            .request("textDocument/documentSymbol", params.clone())
            .unwrap();
        let folding = server.request("textDocument/foldingRange", params).unwrap();
        assert_eq!(symbols.as_array().unwrap().len(), 1);
        assert_eq!(folding.as_array().unwrap().len(), 1);
    }

    #[test]
    fn invalid_full_sync_change_is_reported_without_mutating_the_snapshot() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": "file:///workspace/example.mmt",
                        "languageId": "mmt",
                        "version": 1,
                        "text": "- original"
                    }
                }),
            )
            .unwrap();

        let outcome = server.notification_outcome(
            "textDocument/didChange",
            serde_json::json!({
                "textDocument": { "uri": "file:///workspace/example.mmt", "version": 2 },
                "contentChanges": [
                    { "text": "- first" },
                    { "text": "- second" }
                ]
            }),
        );
        assert_eq!(outcome.error.unwrap().code, -32602);
        assert_eq!(outcome.events[0].method, "window/logMessage");
        let uri = lsp_types::Url::parse("file:///workspace/example.mmt").unwrap();
        let snapshot = server.service().snapshot(&uri).unwrap();
        assert_eq!(snapshot.version, 1);
        assert_eq!(snapshot.text, "- original");
    }

    #[test]
    fn pack_update_republishes_open_document_semantics() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = "file:///workspace/speaker.mmt";
        let opened = server.notification(
            "textDocument/didOpen",
            serde_json::json!({
                "textDocument": { "uri": uri, "languageId": "mmt", "version": 1, "text": "> 花子: hello" }
            }),
        ).unwrap();
        assert!(
            opened
                .iter()
                .find(|event| event.method == "textDocument/publishDiagnostics")
                .unwrap()
                .params["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|diagnostic| diagnostic["message"]
                    .as_str()
                    .unwrap()
                    .contains("unknown character preset"))
        );
        let before: TypstProjectUpdate = serde_json::from_value(
            opened
                .iter()
                .find(|event| event.method == "mmt/typstProjectUpdated")
                .unwrap()
                .params
                .clone(),
        )
        .unwrap();
        let before_text = before
            .files
            .iter()
            .find(|file| file.uri == before.entry_uri)
            .unwrap()
            .text
            .as_deref()
            .unwrap()
            .to_string();
        assert_eq!(before.source_version, 1);

        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"花子":{"names":["花子"]}}
        }"#;
        let result = server.request("mmt/updatePackManifests", serde_json::json!({
            "revision": 1,
            "sources": [{ "manifestUrl": "https://example.test/manifest.json", "baseUrl": "https://example.test/", "json": manifest }]
        })).unwrap();
        let events: Vec<ServerEvent> = serde_json::from_value(result["events"].clone()).unwrap();
        let diagnostics = events
            .iter()
            .find(|event| event.method == "textDocument/publishDiagnostics")
            .unwrap();
        assert!(
            diagnostics.params["diagnostics"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let after: TypstProjectUpdate = serde_json::from_value(
            events
                .iter()
                .find(|event| event.method == "mmt/typstProjectUpdated")
                .unwrap()
                .params
                .clone(),
        )
        .unwrap();
        let after_text = after
            .files
            .iter()
            .find(|file| file.uri == after.entry_uri)
            .unwrap()
            .text
            .as_deref()
            .unwrap();
        assert_eq!(after.source_version, before.source_version);
        assert!(after.revision > before.revision);
        assert_ne!(after_text, before_text);

        let render_result = server
            .request(
                "mmt/getTypstRenderProject",
                serde_json::json!({ "uri": uri }),
            )
            .unwrap();
        assert_eq!(
            render_result["events"][0]["method"],
            "mmt/typstRenderProjectUpdated"
        );
        let render: TypstRenderProjectUpdate = serde_json::from_value(render_result).unwrap();
        assert_eq!(render.source_version, 1);
        assert_eq!(render.revision, after.revision);
        assert_eq!(render.trace_id, None);
        assert_eq!(render.timings, None);
        let traced: TypstRenderProjectUpdate = serde_json::from_value(
            server
                .request(
                    "mmt/getTypstRenderProject",
                    serde_json::json!({ "uri": uri, "traceId": "trace-render-1" }),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(traced.trace_id.as_deref(), Some("trace-render-1"));
        let timings = traced.timings.expect("trace requests include Rust timings");
        assert!(timings.rust_semantic_ms.is_some());
        assert!(timings.rust_emit_ms.is_some());
        assert!(timings.rust_index_digest_ms.is_some());
        server
            .projections
            .response_generation(
                &Url::parse(uri).unwrap(),
                &render.entry_uri,
                render.revision,
                &render.source_content,
                &render.project_digest,
                &render.projection_key,
            )
            .expect("render generation identity must resolve");
        server
            .projections
            .project_range_for_generation(
                &Url::parse(uri).unwrap(),
                Range::new(Position::new(0, 10), Position::new(0, 15)),
                PositionEncoding::Utf8,
                PositionEncoding::Utf8,
                &render.entry_uri,
                render.revision,
                &render.source_content,
                &render.project_digest,
                &render.projection_key,
            )
            .expect("render generation range must map");
        let rendered_range = server
            .request(
                "mmt/typstRange",
                serde_json::json!({
                    "textDocument": {"uri": uri},
                    "range": {
                        "start": {"line": 0, "character": 10},
                        "end": {"line": 0, "character": 15}
                    },
                    "backendEncoding": "utf-8",
                    "entryUri": render.entry_uri,
                    "revision": render.revision,
                    "sourceContent": render.source_content,
                    "projectDigest": render.project_digest,
                    "projectionKey": render.projection_key
                }),
            )
            .unwrap();
        assert_eq!(rendered_range["projectDigest"], render.project_digest.0);
        let mapped_back = server
            .request(
                "mmt/mapTypstReadLocations",
                serde_json::json!({
                    "sourceUri": uri,
                    "revision": render.revision,
                    "entryUri": render.entry_uri,
                    "backendEncoding": "utf-8",
                    "sourceContent": render.source_content,
                    "projectDigest": render.project_digest,
                    "projectionKey": render.projection_key,
                    "locations": [{
                        "uri": render.entry_uri,
                        "range": rendered_range["range"]
                    }]
                }),
            )
            .unwrap();
        assert_eq!(mapped_back[0]["kind"], "authoredIdentity");
        assert_eq!(mapped_back[0]["uri"], uri);
        server
            .notification(
                "textDocument/didChange",
                serde_json::json!({
                    "textDocument": { "uri": uri, "version": 2 },
                    "contentChanges": [{ "text": "> 花子: hello again" }]
                }),
            )
            .unwrap();
        let delta: TypstRenderProjectUpdate = serde_json::from_value(
            server
                .request(
                    "mmt/getTypstRenderProject",
                    serde_json::json!({
                        "uri": uri,
                        "baseRevision": render.revision,
                        "baseProjectDigest": render.project_digest
                    }),
                )
                .unwrap(),
        )
        .unwrap();
        assert!(!delta.full);
        assert_eq!(delta.base_revision, Some(render.revision));
        assert_eq!(
            delta.base_project_digest.as_ref(),
            Some(&render.project_digest)
        );
        assert_eq!(delta.files.len(), 1);
        assert!(delta.files.iter().all(|file| !file.digest.is_empty()));
        assert_eq!(delta.deleted_uris, vec![render.entry_uri.clone()]);
    }

    #[test]
    fn render_project_request_recovers_a_missing_current_projection() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        server
            .request(
                "mmt/updatePackManifests",
                serde_json::json!({ "revision": 1, "sources": [] }),
            )
            .unwrap();
        let uri = Url::parse("file:///workspace/render.mmt").unwrap();
        server
            .notification(
                "textDocument/didOpen",
                serde_json::json!({
                    "textDocument": {
                        "uri": uri,
                        "languageId": "mmt",
                        "version": 1,
                        "text": "@typ: #rect(width: 1cm, height: 1cm, fill: red)"
                    }
                }),
            )
            .unwrap();
        server.projections.remove(&uri);
        assert!(server.projections.get(&uri).is_none());

        let render: TypstRenderProjectUpdate = serde_json::from_value(
            server
                .request(
                    "mmt/getTypstRenderProject",
                    serde_json::json!({ "uri": uri }),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(render.source_uri, uri);
        assert_eq!(render.source_version, 1);
    }

    #[test]
    fn document_config_response_returns_ast_range_and_rejects_lossy_replacement() {
        let source = "@document\n\
                      title: Story\n\
                      compiled-at: auto\n\
                      timezone: +08:00\n\
                      @end\n\
                      - hello";
        let mut service = LanguageService::default();
        let document_uri = Url::parse("file:///workspace/config.mmt").unwrap();
        let document = service
            .open(document_uri.clone(), 1, source.to_string())
            .clone();
        let response = document_config_response(&document, &PositionEncodingKind::UTF16).unwrap();
        assert_eq!(response["title"], "Story");
        assert_eq!(response["compiledAt"]["mode"], "auto");
        assert_eq!(response["compiledAt"]["timezone"], "+08:00");
        assert_eq!(response["range"]["start"]["line"], 0);
        assert_eq!(response["range"]["end"]["line"], 4);

        let invalid = service
            .open(
                document_uri,
                2,
                "@document\nunknown: value\n@end".to_string(),
            )
            .clone();
        let error = document_config_response(&invalid, &PositionEncodingKind::UTF16).unwrap_err();
        assert!(error.message.contains("unknown @document field"));
    }

    #[test]
    fn json_bridge_preserves_parse_errors_and_notification_logging() {
        let mut server = MmtLanguageServer::default();
        let request: Value = serde_json::from_str(&server.request_json("initialize", "{"))
            .expect("request envelope is JSON");
        assert_eq!(request["error"]["code"], -32700);
        assert!(
            request["error"]["message"]
                .as_str()
                .unwrap()
                .contains("failed to decode JSON params")
        );

        let outcome: NotificationOutcome =
            serde_json::from_str(&server.notification_json("textDocument/didChange", "{"))
                .expect("notification outcome is JSON");
        assert_eq!(outcome.error.unwrap().code, -32700);
        assert_eq!(outcome.events[0].method, "window/logMessage");
    }

    #[test]
    fn lifecycle_rejects_requests_before_initialize_and_reinitialize() {
        let mut server = MmtLanguageServer::default();
        let error = server
            .request("textDocument/documentSymbol", serde_json::json!({}))
            .unwrap_err();
        assert_eq!(error.code, -32600);
        server.request("initialize", initialize(false)).unwrap();
        let error = server.request("initialize", initialize(false)).unwrap_err();
        assert_eq!(error.code, -32600);
        server.request("shutdown", Value::Null).unwrap();
        let outcome = server.notification_outcome(
            "textDocument/didOpen",
            serde_json::json!({ "textDocument": {} }),
        );
        assert_eq!(outcome.error.unwrap().code, -32600);
    }
}
