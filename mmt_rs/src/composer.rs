//! Transport-free semantic edits for preview Composer commands.

use typst_syntax::{
    Source, SyntaxKind, SyntaxNode as TypstSyntaxNode,
    ast::{Arg, AstNode, Expr},
};

use crate::diag::{Diagnostic, Severity};
use crate::emit::{AuthoredOriginResolution, EmittedTypst};
use crate::inline::{DeclarationValueSyntax, QuoteKind, parse_declaration_value};
use crate::pack::PackRegistry;
use crate::pipeline::{AnalyzedDocument, analyze_text, analyze_text_with_pack};
use crate::resolve::ResourceTarget;
use crate::semantic::{
    ActorId, ActorState, CharacterPresetCatalog, ResolvedBodyMode, ResolvedStatementSpeaker,
    SpeakerIdentity,
};
use crate::source::TextRange;
use crate::syntax::{
    BodySyntax, DirectiveBlockSyntax, DirectiveItemSyntax, PatchSyntax, SpeakerMarkerSyntax,
    StatementKind, StatementSyntax, SyntaxNode,
};
use crate::typst_check::{check_typst_args, check_typst_source, scan_typst_overlay_macros};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContinuedValue {
    Auto,
    True,
    False,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerTarget {
    pub statement_range: TextRange,
    pub continued: ContinuedValue,
    pub actor_display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ComposerCommand {
    SetStatementContinued(ContinuedValue),
    SetActorDisplayNameFromStatement(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerTargetFailure {
    Unmapped,
    AmbiguousOrigin,
    UnsupportedNode,
    DocumentHasErrors,
    ActorUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComposerFailure {
    TargetChanged,
    DocumentHasErrors,
    InvalidValue,
    ActorUnavailable,
    CandidateInvalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComposerSourceEdit {
    pub range: TextRange,
    pub new_text: String,
}

pub fn resolve_preview_statement(
    analysis: &AnalyzedDocument,
    emitted: &EmittedTypst,
    generated_range: TextRange,
) -> Result<ComposerTarget, ComposerTargetFailure> {
    if analysis_has_errors(analysis) {
        return Err(ComposerTargetFailure::DocumentHasErrors);
    }
    let authored_range = match emitted.classify_authored_parent(generated_range) {
        AuthoredOriginResolution::Unique { range, .. } => range,
        AuthoredOriginResolution::Unmapped => return Err(ComposerTargetFailure::Unmapped),
        AuthoredOriginResolution::Ambiguous => {
            return Err(ComposerTargetFailure::AmbiguousOrigin);
        }
    };
    if authored_range.start > authored_range.end
        || authored_range.end > analysis.document.range.end
    {
        return Err(ComposerTargetFailure::UnsupportedNode);
    }
    let mut containing = analysis.document.nodes.iter().filter_map(|node| match node {
        SyntaxNode::Statement(statement)
            if statement.range.start <= authored_range.start
                && authored_range.end <= statement.range.end =>
        {
            Some(statement)
        }
        _ => None,
    });
    let statement = containing
        .next()
        .ok_or(ComposerTargetFailure::UnsupportedNode)?;
    if containing.next().is_some()
        || !matches!(statement.kind, StatementKind::Left | StatementKind::Right)
    {
        return Err(ComposerTargetFailure::UnsupportedNode);
    }
    let speaker = unique_statement_speaker(analysis, statement.range)
        .ok_or(ComposerTargetFailure::ActorUnavailable)?;
    let continued = statement_continued(statement)
        .map_err(|_| ComposerTargetFailure::UnsupportedNode)?;
    let actor_display_name = actor_for_speaker(analysis, speaker)
        .and_then(|(_, actor, revision)| {
            serialize_scalar(&actor.primary_name, None)?;
            actor
                .revisions
                .iter()
                .find(|candidate| candidate.number == revision)
                .map(|revision| revision.state.display_name.clone())
        });
    Ok(ComposerTarget {
        statement_range: statement.range,
        continued,
        actor_display_name,
    })
}

pub fn statement_continued(
    statement: &StatementSyntax,
) -> Result<ContinuedValue, ComposerFailure> {
    let Some(patch) = &statement.patch else {
        return Ok(ContinuedValue::Auto);
    };
    Ok(parse_patch_args(patch)?.continued.map_or(
        ContinuedValue::Auto,
        |continued| continued.value,
    ))
}

pub fn compose_edit(
    source: &str,
    analysis: &AnalyzedDocument,
    catalog: &impl CharacterPresetCatalog,
    target_range: TextRange,
    command: ComposerCommand,
) -> Result<ComposerSourceEdit, ComposerFailure> {
    compose_edit_using(source, analysis, target_range, command, |candidate| {
        analyze_text(candidate, catalog)
    })
}

pub fn compose_edit_with_pack(
    source: &str,
    analysis: &AnalyzedDocument,
    packs: &PackRegistry,
    target_range: TextRange,
    command: ComposerCommand,
) -> Result<ComposerSourceEdit, ComposerFailure> {
    compose_edit_using(source, analysis, target_range, command, |candidate| {
        analyze_text_with_pack(candidate, packs)
    })
}

fn compose_edit_using(
    source: &str,
    analysis: &AnalyzedDocument,
    target_range: TextRange,
    command: ComposerCommand,
    analyze_candidate: impl FnOnce(&str) -> AnalyzedDocument,
) -> Result<ComposerSourceEdit, ComposerFailure> {
    let target_ordinal = exact_statement_ordinal(analysis, target_range)
        .ok_or(ComposerFailure::TargetChanged)?;
    let statement = statement_at_ordinal(analysis, target_ordinal)
        .ok_or(ComposerFailure::TargetChanged)?;
    if !matches!(statement.kind, StatementKind::Left | StatementKind::Right) {
        return Err(ComposerFailure::TargetChanged);
    }
    if matches!(&command, ComposerCommand::SetStatementContinued(_)) {
        statement_continued(statement)?;
    }
    if analysis_has_errors(analysis) {
        return Err(ComposerFailure::DocumentHasErrors);
    }
    if unique_statement_speaker(analysis, statement.range).is_none()
    {
        return Err(ComposerFailure::TargetChanged);
    }

    let edit = match &command {
        ComposerCommand::SetStatementContinued(value) => {
            continued_edit(statement, source, *value)?
        }
        ComposerCommand::SetActorDisplayNameFromStatement(value) => {
            if value.is_empty() {
                return Err(ComposerFailure::InvalidValue);
            }
            display_name_edit(source, analysis, target_ordinal, statement, value)?
        }
    };
    let candidate_source = apply_source_edit(source, &edit)?;
    let candidate = analyze_candidate(&candidate_source);
    if analysis_has_errors(&candidate)
        || !statements_have_same_shape(analysis, &candidate)
        || !common_semantics_stable(analysis, &candidate)
    {
        return Err(ComposerFailure::CandidateInvalid);
    }
    let stable = match command {
        ComposerCommand::SetStatementContinued(value) => {
            continued_candidate_stable(analysis, &candidate, target_ordinal, value)
        }
        ComposerCommand::SetActorDisplayNameFromStatement(value) => {
            display_candidate_stable(analysis, &candidate, target_ordinal, &value)
        }
    };
    if !stable {
        return Err(ComposerFailure::CandidateInvalid);
    }
    Ok(edit)
}

fn exact_statement_ordinal(analysis: &AnalyzedDocument, range: TextRange) -> Option<usize> {
    let mut matches = analysis
        .document
        .nodes
        .iter()
        .filter_map(|node| match node {
            SyntaxNode::Statement(statement) => Some(statement),
            _ => None,
        })
        .enumerate()
        .filter(|(_, statement)| statement.range == range);
    let (ordinal, statement) = matches.next()?;
    if matches.next().is_some()
        || !matches!(statement.kind, StatementKind::Left | StatementKind::Right)
    {
        return None;
    }
    Some(ordinal)
}

fn statement_at_ordinal(analysis: &AnalyzedDocument, ordinal: usize) -> Option<&StatementSyntax> {
    analysis
        .document
        .nodes
        .iter()
        .filter_map(|node| match node {
            SyntaxNode::Statement(statement) => Some(statement),
            _ => None,
        })
        .nth(ordinal)
}

fn unique_statement_speaker(
    analysis: &AnalyzedDocument,
    range: TextRange,
) -> Option<&ResolvedStatementSpeaker> {
    let mut matches = analysis
        .actors
        .speakers
        .iter()
        .filter(|speaker| speaker.statement_range == range);
    let speaker = matches.next()?;
    matches.next().is_none().then_some(speaker)
}

fn actor_for_speaker<'a>(
    analysis: &'a AnalyzedDocument,
    speaker: &ResolvedStatementSpeaker,
) -> Option<(ActorId, &'a crate::semantic::ScriptActor, u32)> {
    let SpeakerIdentity::Actor(actor_id) = &speaker.speaker else {
        return None;
    };
    let actor_id = *actor_id;
    let revision = speaker.revision?;
    let mut actors = analysis
        .actors
        .actors
        .iter()
        .filter(|actor| actor.id == actor_id);
    let actor = actors.next()?;
    actors.next().is_none().then_some((actor_id, actor, revision))
}

#[derive(Debug)]
struct ParsedPatchArgs {
    items: Vec<TextRange>,
    continued: Option<ParsedContinued>,
}

#[derive(Debug, Clone, Copy)]
struct ParsedContinued {
    item_range: TextRange,
    value_range: TextRange,
    value: ContinuedValue,
}

fn parse_patch_args(patch: &PatchSyntax) -> Result<ParsedPatchArgs, ComposerFailure> {
    const PREFIX: &str = "#mmt-probe(";
    const SUFFIX: &str = ")[probe]";
    let wrapped = format!("{PREFIX}{}{SUFFIX}", patch.raw_args);
    let source = Source::detached(wrapped);
    if source.root().diagnosis().errors {
        return Err(ComposerFailure::CandidateInvalid);
    }
    let args_start = PREFIX.len() - 1;
    let args_body_start = PREFIX.len();
    let args_body_end = args_body_start + patch.raw_args.len();
    let args_enclosure_end = args_body_end + 1;
    let args_node = find_typst_args_node(
        source.root(),
        0,
        args_start,
        args_enclosure_end,
    )
    .ok_or(ComposerFailure::CandidateInvalid)?;
    let args = args_node
        .cast::<typst_syntax::ast::Args>()
        .ok_or(ComposerFailure::CandidateInvalid)?;
    let mut items = Vec::new();
    let mut continued = None;
    for arg in args.items() {
        let wrapped_range = source
            .find(arg.to_untyped().span())
            .map(|node| node.range())
            .ok_or(ComposerFailure::CandidateInvalid)?;
        if wrapped_range.end <= args_body_start || args_body_end <= wrapped_range.start {
            continue;
        }
        if wrapped_range.start < args_body_start || args_body_end < wrapped_range.end {
            return Err(ComposerFailure::CandidateInvalid);
        }
        let item_range =
            project_probe_range(wrapped_range, PREFIX.len(), patch.args_range)?;
        items.push(item_range);
        let Arg::Named(named) = arg else {
            continue;
        };
        if named.name().get().as_str() != "continued" {
            continue;
        }
        if continued.is_some() {
            return Err(ComposerFailure::CandidateInvalid);
        }
        let Expr::Bool(value) = named.expr() else {
            return Err(ComposerFailure::CandidateInvalid);
        };
        let value_range = project_probe_range(
            source
                .find(value.to_untyped().span())
                .map(|node| node.range())
                .ok_or(ComposerFailure::CandidateInvalid)?,
            PREFIX.len(),
            patch.args_range,
        )?;
        continued = Some(ParsedContinued {
            item_range,
            value_range,
            value: if value.get() {
                ContinuedValue::True
            } else {
                ContinuedValue::False
            },
        });
    }
    Ok(ParsedPatchArgs { items, continued })
}

fn find_typst_args_node<'a>(
    node: &'a TypstSyntaxNode,
    offset: usize,
    expected_start: usize,
    expected_end: usize,
) -> Option<&'a TypstSyntaxNode> {
    if node.kind() == SyntaxKind::Args
        && offset == expected_start
        && expected_end <= offset + node.len()
    {
        return Some(node);
    }
    let mut child_offset = offset;
    for child in node.children() {
        if child_offset <= expected_start && expected_end <= child_offset + child.len() {
            if let Some(found) = find_typst_args_node(
                child,
                child_offset,
                expected_start,
                expected_end,
            ) {
                return Some(found);
            }
        }
        child_offset += child.len();
    }
    None
}

fn project_probe_range(
    range: std::ops::Range<usize>,
    prefix_len: usize,
    args_range: TextRange,
) -> Result<TextRange, ComposerFailure> {
    let body_end = prefix_len + args_range.len();
    if range.start < prefix_len || range.end > body_end || range.start > range.end {
        return Err(ComposerFailure::CandidateInvalid);
    }
    Ok(TextRange::new(
        args_range.start + range.start - prefix_len,
        args_range.start + range.end - prefix_len,
    ))
}

fn continued_edit(
    statement: &StatementSyntax,
    source: &str,
    value: ContinuedValue,
) -> Result<ComposerSourceEdit, ComposerFailure> {
    let Some(patch) = &statement.patch else {
        return Ok(ComposerSourceEdit {
            range: TextRange::new(statement.range.start + 1, statement.range.start + 1),
            new_text: match value {
                ContinuedValue::Auto => String::new(),
                ContinuedValue::True => "(continued: true)".to_string(),
                ContinuedValue::False => "(continued: false)".to_string(),
            },
        });
    };
    let parsed = parse_patch_args(patch)?;
    match (value, parsed.continued) {
        (ContinuedValue::True | ContinuedValue::False, Some(current)) => Ok(ComposerSourceEdit {
            range: current.value_range,
            new_text: continued_bool(value).to_string(),
        }),
        (ContinuedValue::True | ContinuedValue::False, None) => {
            if parsed.items.is_empty() && !patch.raw_args.trim().is_empty() {
                return Err(ComposerFailure::CandidateInvalid);
            }
            Ok(ComposerSourceEdit {
                range: TextRange::new(patch.args_range.start, patch.args_range.start),
                new_text: if parsed.items.is_empty() {
                    format!("continued: {}", continued_bool(value))
                } else {
                    format!("continued: {}, ", continued_bool(value))
                },
            })
        }
        (ContinuedValue::Auto, None) => Ok(ComposerSourceEdit {
            range: TextRange::new(patch.args_range.start, patch.args_range.start),
            new_text: String::new(),
        }),
        (ContinuedValue::Auto, Some(_)) if parsed.items.len() == 1 => {
            Ok(ComposerSourceEdit {
                range: patch.range,
                new_text: String::new(),
            })
        }
        (ContinuedValue::Auto, Some(current)) => {
            let index = parsed
                .items
                .iter()
                .position(|range| *range == current.item_range)
                .ok_or(ComposerFailure::CandidateInvalid)?;
            let range = if let Some(next) = parsed.items.get(index + 1) {
                TextRange::new(current.item_range.start, next.start)
            } else {
                let previous = parsed
                    .items
                    .get(index.checked_sub(1).ok_or(ComposerFailure::CandidateInvalid)?)
                    .ok_or(ComposerFailure::CandidateInvalid)?;
                TextRange::new(previous.end, current.item_range.end)
            };
            if range.end > source.len() || !source.is_char_boundary(range.start) || !source.is_char_boundary(range.end) {
                return Err(ComposerFailure::CandidateInvalid);
            }
            Ok(ComposerSourceEdit {
                range,
                new_text: String::new(),
            })
        }
    }
}

fn continued_bool(value: ContinuedValue) -> &'static str {
    match value {
        ContinuedValue::True => "true",
        ContinuedValue::False => "false",
        ContinuedValue::Auto => "auto",
    }
}

fn display_name_edit(
    source: &str,
    analysis: &AnalyzedDocument,
    target_ordinal: usize,
    statement: &StatementSyntax,
    value: &str,
) -> Result<ComposerSourceEdit, ComposerFailure> {
    let speaker = unique_statement_speaker(analysis, statement.range)
        .ok_or(ComposerFailure::TargetChanged)?;
    let (actor_id, actor, revision_number) =
        actor_for_speaker(analysis, speaker).ok_or(ComposerFailure::ActorUnavailable)?;
    let revision = actor
        .revisions
        .iter()
        .find(|revision| revision.number == revision_number)
        .ok_or(ComposerFailure::ActorUnavailable)?;
    let actor_name = serialize_scalar(&actor.primary_name, None)
        .ok_or(ComposerFailure::ActorUnavailable)?;

    if let Some(edit) = adjacent_actor_block_edit(
        source,
        analysis,
        target_ordinal,
        statement,
        actor_id,
        revision.origin,
        value,
    )? {
        return Ok(edit);
    }

    let display_name = serialize_scalar(value, None).ok_or(ComposerFailure::InvalidValue)?;
    let newline = newline_before_target(source, statement.range.start)
        .ok_or(ComposerFailure::CandidateInvalid)?;
    Ok(ComposerSourceEdit {
        range: TextRange::new(statement.range.start, statement.range.start),
        new_text: format!(
            "@actor {actor_name}{newline}display-name: {display_name}{newline}@end{newline}"
        ),
    })
}

fn adjacent_actor_block_edit(
    source: &str,
    analysis: &AnalyzedDocument,
    target_ordinal: usize,
    statement: &StatementSyntax,
    actor_id: ActorId,
    revision_origin: TextRange,
    value: &str,
) -> Result<Option<ComposerSourceEdit>, ComposerFailure> {
    let statement_node_index = analysis
        .document
        .nodes
        .iter()
        .position(|node| matches!(node, SyntaxNode::Statement(candidate) if candidate.range == statement.range))
        .ok_or(ComposerFailure::TargetChanged)?;
    let Some(SyntaxNode::DirectiveBlock(block)) = statement_node_index
        .checked_sub(1)
        .and_then(|index| analysis.document.nodes.get(index))
    else {
        return Ok(None);
    };
    if block.name != "actor"
        || block.range != revision_origin
        || !has_single_line_terminator(source, block.range.end, statement.range.start)
        || statement_at_ordinal(analysis, target_ordinal).map(|target| target.range)
            != Some(statement.range)
    {
        return Ok(None);
    }
    let matching_revisions = analysis
        .actors
        .actors
        .iter()
        .filter(|actor| actor.id == actor_id)
        .flat_map(|actor| actor.revisions.iter())
        .filter(|revision| revision.origin == block.range)
        .count();
    if matching_revisions != 1 {
        return Ok(None);
    }
    let display_fields = block
        .items
        .iter()
        .filter_map(|item| match item {
            DirectiveItemSyntax::Field(field) if field.name == "display-name" => Some(field),
            _ => None,
        })
        .collect::<Vec<_>>();
    match display_fields.as_slice() {
        [field] => {
            let parsed = parse_declaration_value(&field.value, field.value_range.start);
            let literal = match (parsed.diagnostics.is_empty(), parsed.value) {
                (true, Some(DeclarationValueSyntax::Scalar(literal))) => literal,
                _ => return Err(ComposerFailure::CandidateInvalid),
            };
            let encoded = serialize_scalar(value, literal.quote)
                .ok_or(ComposerFailure::InvalidValue)?;
            Ok(Some(ComposerSourceEdit {
                range: literal.range,
                new_text: encoded,
            }))
        }
        [] => {
            let end_start = directive_end_line_start(source, block)?;
            let newline = newline_immediately_before(source, end_start)
                .ok_or(ComposerFailure::CandidateInvalid)?;
            let encoded = serialize_scalar(value, None).ok_or(ComposerFailure::InvalidValue)?;
            Ok(Some(ComposerSourceEdit {
                range: TextRange::new(end_start, end_start),
                new_text: format!("display-name: {encoded}{newline}"),
            }))
        }
        _ => Err(ComposerFailure::CandidateInvalid),
    }
}

fn directive_end_line_start(
    source: &str,
    block: &DirectiveBlockSyntax,
) -> Result<usize, ComposerFailure> {
    if block.range.end > source.len() || !source.is_char_boundary(block.range.end) {
        return Err(ComposerFailure::CandidateInvalid);
    }
    let before_end = &source[..block.range.end];
    let line_start = before_end.rfind('\n').map_or(0, |offset| offset + 1);
    if source[line_start..block.range.end].trim_end() != "@end" {
        return Err(ComposerFailure::CandidateInvalid);
    }
    Ok(line_start)
}

fn has_single_line_terminator(source: &str, start: usize, end: usize) -> bool {
    start <= end
        && end <= source.len()
        && source.is_char_boundary(start)
        && source.is_char_boundary(end)
        && matches!(&source[start..end], "\n" | "\r\n")
}

fn newline_immediately_before(source: &str, offset: usize) -> Option<&'static str> {
    if source.get(..offset)?.ends_with("\r\n") {
        Some("\r\n")
    } else if source.get(..offset)?.ends_with('\n') {
        Some("\n")
    } else {
        None
    }
}

fn newline_before_target(source: &str, offset: usize) -> Option<&'static str> {
    if offset == 0 {
        return source
            .as_bytes()
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|newline| {
                if newline > 0 && source.as_bytes()[newline - 1] == b'\r' {
                    "\r\n"
                } else {
                    "\n"
                }
            })
            .or(Some("\n"));
    }
    newline_immediately_before(source, offset)
}

fn serialize_scalar(value: &str, preferred_quote: Option<QuoteKind>) -> Option<String> {
    if value.is_empty() || value.contains('\r') || value.contains('\n') {
        return None;
    }
    if let Some(quote) = preferred_quote {
        return quoted_scalar(value, quote);
    }
    let parsed = parse_declaration_value(value, 0);
    if parsed.diagnostics.is_empty()
        && matches!(
            &parsed.value,
            Some(DeclarationValueSyntax::Scalar(literal))
                if literal.quote.is_none() && literal.value == value
        )
    {
        return Some(value.to_string());
    }
    quoted_scalar(value, QuoteKind::Double)
}

fn quoted_scalar(value: &str, quote: QuoteKind) -> Option<String> {
    let delimiter = match quote {
        QuoteKind::Single => '\'',
        QuoteKind::Double => '"',
    };
    let mut encoded = String::with_capacity(value.len() + 2);
    encoded.push(delimiter);
    for ch in value.chars() {
        if ch == '\\' || ch == delimiter {
            encoded.push('\\');
        }
        encoded.push(ch);
    }
    encoded.push(delimiter);
    let parsed = parse_declaration_value(&encoded, 0);
    matches!(
        &parsed.value,
        Some(DeclarationValueSyntax::Scalar(literal))
            if parsed.diagnostics.is_empty()
                && literal.quote == Some(quote)
                && literal.value == value
    )
    .then_some(encoded)
}

fn apply_source_edit(source: &str, edit: &ComposerSourceEdit) -> Result<String, ComposerFailure> {
    if edit.range.start > edit.range.end
        || edit.range.end > source.len()
        || !source.is_char_boundary(edit.range.start)
        || !source.is_char_boundary(edit.range.end)
    {
        return Err(ComposerFailure::CandidateInvalid);
    }
    let mut candidate = String::with_capacity(
        source.len() - edit.range.len() + edit.new_text.len(),
    );
    candidate.push_str(&source[..edit.range.start]);
    candidate.push_str(&edit.new_text);
    candidate.push_str(&source[edit.range.end..]);
    Ok(candidate)
}

fn analysis_has_errors(analysis: &AnalyzedDocument) -> bool {
    let groups: [&[Diagnostic]; 7] = [
        &analysis.document.diagnostics,
        &analysis.directive_diagnostics,
        &analysis.document_config.diagnostics,
        &analysis.modes.diagnostics,
        &analysis.actors.diagnostics,
        &analysis.assets.diagnostics,
        &analysis.resource_markers.diagnostics,
    ];
    groups
        .into_iter()
        .flatten()
        .chain(
            analysis
                .resolution
                .iter()
                .flat_map(|resolution| resolution.diagnostics.iter()),
        )
        .any(|diagnostic| diagnostic.severity == Severity::Error)
        || analysis_has_error_nodes(analysis)
        || analysis_has_typst_errors(analysis)
}

fn analysis_has_error_nodes(analysis: &AnalyzedDocument) -> bool {
    analysis.document.nodes.iter().any(|node| match node {
        SyntaxNode::Error(_) => true,
        SyntaxNode::DirectiveBlock(block) => block
            .items
            .iter()
            .any(|item| matches!(item, DirectiveItemSyntax::Error(_))),
        _ => false,
    })
}

fn analysis_has_typst_errors(analysis: &AnalyzedDocument) -> bool {
    analysis.document.nodes.iter().any(|node| match node {
        SyntaxNode::Statement(statement) => {
            patch_has_typst_errors(statement.patch.as_ref())
                || body_has_typst_errors(analysis, &statement.body)
        }
        SyntaxNode::DirectiveBlock(block) => {
            patch_has_typst_errors(block.patch.as_ref())
                || (block.name == "typ"
                    && block.items.iter().any(|item| match item {
                        DirectiveItemSyntax::Body(body) => !check_typst_source(
                            &body.source,
                            body.range,
                        )
                        .is_empty(),
                        _ => false,
                    }))
        }
        SyntaxNode::Reply(reply) => {
            patch_has_typst_errors(reply.patch.as_ref())
                || reply
                    .items
                    .iter()
                    .any(|body| body_has_typst_errors(analysis, body))
        }
        SyntaxNode::Bond(bond) => {
            patch_has_typst_errors(bond.patch.as_ref())
                || body_has_typst_errors(analysis, &bond.body)
        }
        SyntaxNode::DirectiveLine(_) | SyntaxNode::Blank(_) | SyntaxNode::Error(_) => false,
    })
}

fn patch_has_typst_errors(patch: Option<&PatchSyntax>) -> bool {
    patch.is_some_and(|patch| !check_typst_args(&patch.raw_args, patch.args_range).is_empty())
}

fn body_has_typst_errors(analysis: &AnalyzedDocument, body: &BodySyntax) -> bool {
    let mode = analysis
        .modes
        .bodies
        .iter()
        .find(|entry| entry.range == body.range)
        .map(|entry| entry.mode);
    match mode {
        Some(ResolvedBodyMode::TypstRaw) => {
            !check_typst_source(&body.source, body.range).is_empty()
        }
        Some(ResolvedBodyMode::TypstMacro) => {
            !scan_typst_overlay_macros(&body.source, body.range)
                .diagnostics
                .is_empty()
        }
        Some(ResolvedBodyMode::TextMacro | ResolvedBodyMode::TextRaw) | None => false,
    }
}

fn statements_have_same_shape(before: &AnalyzedDocument, after: &AnalyzedDocument) -> bool {
    let before = before.document.nodes.iter().filter_map(|node| match node {
        SyntaxNode::Statement(statement) => Some(statement),
        _ => None,
    });
    let after = after.document.nodes.iter().filter_map(|node| match node {
        SyntaxNode::Statement(statement) => Some(statement),
        _ => None,
    });
    let before = before.collect::<Vec<_>>();
    let after = after.collect::<Vec<_>>();
    before.len() == after.len()
        && before.iter().zip(after).all(|(left, right)| {
            left.kind == right.kind
                && markers_equal(left.marker.as_ref(), right.marker.as_ref())
                && left.body.mode == right.body.mode
                && left.body.source == right.body.source
        })
}

fn markers_equal(left: Option<&SpeakerMarkerSyntax>, right: Option<&SpeakerMarkerSyntax>) -> bool {
    match (left, right) {
        (None, None) => true,
        (
            Some(SpeakerMarkerSyntax::Explicit { raw: left, .. }),
            Some(SpeakerMarkerSyntax::Explicit { raw: right, .. }),
        ) => left == right,
        (
            Some(SpeakerMarkerSyntax::BackRef { n: left, .. }),
            Some(SpeakerMarkerSyntax::BackRef { n: right, .. }),
        )
        | (
            Some(SpeakerMarkerSyntax::UniqueIndex { n: left, .. }),
            Some(SpeakerMarkerSyntax::UniqueIndex { n: right, .. }),
        ) => left == right,
        _ => false,
    }
}

fn common_semantics_stable(before: &AnalyzedDocument, after: &AnalyzedDocument) -> bool {
    before.document_config.config == after.document_config.config
        && before.modes.bodies.iter().map(|entry| entry.mode).eq(
            after.modes.bodies.iter().map(|entry| entry.mode),
        )
        && before.assets.assets.len() == after.assets.assets.len()
        && before.assets.assets.iter().zip(&after.assets.assets).all(|(left, right)| {
            left.id == right.id && left.source == right.source
        })
        && before.resource_markers.markers.len() == after.resource_markers.markers.len()
        && before
            .resource_markers
            .markers
            .iter()
            .zip(&after.resource_markers.markers)
            .all(|(left, right)| {
                left.selector == right.selector
                    && left.render_patch.as_ref().map(|patch| &patch.raw_args)
                        == right.render_patch.as_ref().map(|patch| &patch.raw_args)
            })
        && resolutions_equal(before, after)
}

fn resolutions_equal(before: &AnalyzedDocument, after: &AnalyzedDocument) -> bool {
    match (&before.resolution, &after.resolution) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            let left_inline = left
                .resources
                .iter()
                .filter(|resource| matches!(&resource.target, ResourceTarget::Inline))
                .map(|resource| &resource.kind)
                .collect::<Vec<_>>();
            let right_inline = right
                .resources
                .iter()
                .filter(|resource| matches!(&resource.target, ResourceTarget::Inline))
                .map(|resource| &resource.kind)
                .collect::<Vec<_>>();
            left_inline == right_inline
                && avatar_resource_identities_are_equal(&left.resources, &right.resources)
                && resource_failure_identities_are_equal(&left.failures, &right.failures)
        }
        _ => false,
    }
}

fn avatar_resource_identities_are_equal(
    left: &[crate::resolve::ResolvedResource],
    right: &[crate::resolve::ResolvedResource],
) -> bool {
    let contains = |haystack: &[crate::resolve::ResolvedResource],
                    needle: &crate::resolve::ResolvedResource| {
        let ResourceTarget::ActorAvatar {
            actor_id: needle_actor,
            ..
        } = &needle.target
        else {
            return true;
        };
        haystack.iter().any(|candidate| {
            matches!(
                &candidate.target,
                ResourceTarget::ActorAvatar {
                    actor_id: candidate_actor,
                    ..
                } if candidate_actor == needle_actor
            ) && candidate.kind == needle.kind
        })
    };
    left.iter().all(|resource| contains(right, resource))
        && right.iter().all(|resource| contains(left, resource))
}

fn resource_failure_identities_are_equal(
    left: &[crate::resolve::ResourceFailure],
    right: &[crate::resolve::ResourceFailure],
) -> bool {
    let contains = |haystack: &[crate::resolve::ResourceFailure],
                    needle: &crate::resolve::ResourceFailure| {
        match &needle.target {
            ResourceTarget::Inline => haystack
                .iter()
                .any(|candidate| matches!(&candidate.target, ResourceTarget::Inline)),
            ResourceTarget::ActorAvatar {
                actor_id: needle_actor,
                ..
            } => haystack.iter().any(|candidate| {
                matches!(
                    &candidate.target,
                    ResourceTarget::ActorAvatar {
                        actor_id: candidate_actor,
                        ..
                    } if candidate_actor == needle_actor
                )
            }),
        }
    };
    left.iter().all(|failure| contains(right, failure))
        && right.iter().all(|failure| contains(left, failure))
}

fn continued_candidate_stable(
    before: &AnalyzedDocument,
    after: &AnalyzedDocument,
    target_ordinal: usize,
    expected: ContinuedValue,
) -> bool {
    actor_models_equal(before, after)
        && before.actors.speakers.len() == after.actors.speakers.len()
        && before
            .actors
            .speakers
            .iter()
            .zip(&after.actors.speakers)
            .all(|(left, right)| left.speaker == right.speaker && left.revision == right.revision)
        && statement_at_ordinal(after, target_ordinal)
            .and_then(|statement| statement_continued(statement).ok())
            == Some(expected)
}

fn actor_models_equal(before: &AnalyzedDocument, after: &AnalyzedDocument) -> bool {
    before.actors.actors.len() == after.actors.actors.len()
        && before.actors.actors.iter().zip(&after.actors.actors).all(|(left, right)| {
            left.id == right.id
                && left.preset_id == right.preset_id
                && left.primary_name == right.primary_name
                && left.names == right.names
                && left.revisions.len() == right.revisions.len()
                && left.revisions.iter().zip(&right.revisions).all(|(left, right)| {
                    left.number == right.number && left.state == right.state
                })
        })
}

fn display_candidate_stable(
    before: &AnalyzedDocument,
    after: &AnalyzedDocument,
    target_ordinal: usize,
    requested: &str,
) -> bool {
    let Some(before_target) = statement_at_ordinal(before, target_ordinal) else {
        return false;
    };
    let Some(after_target) = statement_at_ordinal(after, target_ordinal) else {
        return false;
    };
    let Some(before_speaker) = unique_statement_speaker(before, before_target.range) else {
        return false;
    };
    let Some(after_speaker) = unique_statement_speaker(after, after_target.range) else {
        return false;
    };
    let Some((target_actor, before_actor, target_revision)) = actor_for_speaker(before, before_speaker)
    else {
        return false;
    };
    let Some((after_actor_id, after_actor, _)) = actor_for_speaker(after, after_speaker) else {
        return false;
    };
    if target_actor != after_actor_id
        || before_actor.preset_id != after_actor.preset_id
        || before_actor.primary_name != after_actor.primary_name
        || before_actor.names != after_actor.names
        || before.actors.actors.len() != after.actors.actors.len()
    {
        return false;
    }
    for before_other in &before.actors.actors {
        let Some(after_other) = after
            .actors
            .actors
            .iter()
            .find(|actor| actor.id == before_other.id)
        else {
            return false;
        };
        if before_other.id != target_actor
            && (before_other.preset_id != after_other.preset_id
                || before_other.primary_name != after_other.primary_name
                || before_other.names != after_other.names
                || !revisions_have_same_states(before_other, after_other))
        {
            return false;
        }
    }

    let before_statements = before
        .document
        .nodes
        .iter()
        .filter_map(|node| match node {
            SyntaxNode::Statement(statement) => Some(statement),
            _ => None,
        })
        .collect::<Vec<_>>();
    let after_statements = after
        .document
        .nodes
        .iter()
        .filter_map(|node| match node {
            SyntaxNode::Statement(statement) => Some(statement),
            _ => None,
        })
        .collect::<Vec<_>>();
    let mut expected_display = requested.to_string();
    let mut prior_revision = target_revision;
    for (ordinal, (before_statement, after_statement)) in before_statements
        .iter()
        .zip(after_statements)
        .enumerate()
    {
        let before_entry = unique_statement_speaker(before, before_statement.range);
        let after_entry = unique_statement_speaker(after, after_statement.range);
        let (Some(before_entry), Some(after_entry)) = (before_entry, after_entry) else {
            if before_entry.is_some() || after_entry.is_some() {
                return false;
            }
            continue;
        };
        if before_entry.speaker != after_entry.speaker {
            return false;
        }
        match &before_entry.speaker {
            SpeakerIdentity::Builtin(_) => {}
            SpeakerIdentity::Actor(actor_id) => {
                let Some(before_state) = speaker_state(before, before_entry) else {
                    return false;
                };
                let Some(after_state) = speaker_state(after, after_entry) else {
                    return false;
                };
                if ordinal < target_ordinal || *actor_id != target_actor {
                    if before_state != after_state {
                        return false;
                    }
                    continue;
                }
                let Some(revision) = before_entry.revision else {
                    return false;
                };
                if revision != prior_revision {
                    if revision_has_explicit_display(before, target_actor, revision) {
                        expected_display = before_state.display_name.clone();
                    }
                    prior_revision = revision;
                }
                if after_state.avatar != before_state.avatar
                    || after_state.display_name != expected_display
                {
                    return false;
                }
            }
        }
    }
    true
}

fn revisions_have_same_states(
    left: &crate::semantic::ScriptActor,
    right: &crate::semantic::ScriptActor,
) -> bool {
    left.revisions.len() == right.revisions.len()
        && left.revisions.iter().zip(&right.revisions).all(|(left, right)| {
            left.number == right.number && left.state == right.state
        })
}

fn speaker_state<'a>(
    analysis: &'a AnalyzedDocument,
    speaker: &ResolvedStatementSpeaker,
) -> Option<&'a ActorState> {
    let (_, actor, revision) = actor_for_speaker(analysis, speaker)?;
    actor
        .revisions
        .iter()
        .find(|candidate| candidate.number == revision)
        .map(|revision| &revision.state)
}

fn revision_has_explicit_display(
    analysis: &AnalyzedDocument,
    actor_id: ActorId,
    revision_number: u32,
) -> bool {
    let Some(origin) = analysis
        .actors
        .actors
        .iter()
        .find(|actor| actor.id == actor_id)
        .and_then(|actor| {
            actor
                .revisions
                .iter()
                .find(|revision| revision.number == revision_number)
        })
        .map(|revision| revision.origin)
    else {
        return false;
    };
    analysis.document.nodes.iter().any(|node| {
        matches!(
            node,
            SyntaxNode::DirectiveBlock(block)
                if block.range == origin
                    && block.items.iter().any(|item| matches!(
                        item,
                        DirectiveItemSyntax::Field(field) if field.name == "display-name"
                    ))
        )
    })
}

