//! Typst façade emitter with chunk-level source maps.

use std::collections::HashMap;

use crate::diag::{Diagnostic, DiagnosticPhase, Severity};
use crate::semantic::{
    ActorId, ActorLowering, BodyModeResolution, BuiltinSpeakerId, ResolvedBodyMode, SpeakerIdentity,
};
use crate::source::TextRange;
use crate::syntax::{
    BodyPartSyntax, BodySyntax, PatchSyntax, StatementKind, SyntaxDocument, SyntaxNode,
};
use crate::typst_check::{check_typst_args, check_typst_source, scan_typst_overlay_macros};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginKind {
    TextBody,
    TypstBody,
    StatementPatch,
    ResourceMarker,
    ResourcePatch,
    TypDirective,
    DirectiveField,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GeneratedKind {
    TemplateWrapper,
    EscapedText,
    MacroExpansion,
    ResourceCallWrapper,
    StatementCallWrapper,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    MmtRange {
        range: TextRange,
        kind: OriginKind,
    },
    Generated {
        kind: GeneratedKind,
        parent: Option<usize>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitChunk {
    pub text: String,
    pub origin: Origin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceMapEntry {
    pub generated_range: TextRange,
    pub origin_id: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmittedTypst {
    pub source: String,
    pub origins: Vec<Origin>,
    pub source_map: Vec<SourceMapEntry>,
    pub diagnostics: Vec<Diagnostic>,
}

impl EmittedTypst {
    pub fn lookup_origin(&self, generated_range: TextRange) -> Option<&Origin> {
        let origin_id = self.lookup_origin_id(generated_range)?;
        self.origins.get(origin_id)
    }

    pub fn lookup_mmt_origin(&self, generated_range: TextRange) -> Option<&Origin> {
        let mut origin_id = self.lookup_origin_id(generated_range)?;
        loop {
            match self.origins.get(origin_id)? {
                origin @ Origin::MmtRange { .. } => return Some(origin),
                Origin::Generated {
                    parent: Some(parent),
                    ..
                } => origin_id = *parent,
                Origin::Generated { parent: None, .. } => return None,
            }
        }
    }

    fn lookup_origin_id(&self, generated_range: TextRange) -> Option<usize> {
        let offset = generated_range.start.min(self.source.len());
        self.source_map
            .iter()
            .find(|entry| {
                let range = entry.generated_range;
                if offset == self.source.len() {
                    range.end == offset
                } else {
                    range.start <= offset && offset < range.end
                }
            })
            .map(|entry| entry.origin_id)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltinPresentation {
    pub name: Option<String>,
    pub avatar_path: Option<String>,
    pub reserve_avatar_space: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmitOptions {
    pub template_import: String,
    pub show_header: bool,
    pub title: String,
    pub author: Option<String>,
}

impl Default for EmitOptions {
    fn default() -> Self {
        Self {
            template_import: "typst_sandbox/mmt_render/lib.typ".to_string(),
            show_header: true,
            title: "无题".to_string(),
            author: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct MaterializedContent {
    pub actor_avatars: HashMap<(ActorId, u32), String>,
    pub builtins: HashMap<BuiltinSpeakerId, BuiltinPresentation>,
    pub inline_typst: HashMap<TextRange, String>,
}

pub fn emit_typst(
    document: &SyntaxDocument,
    modes: &BodyModeResolution,
    actors: &ActorLowering,
    materialized: &MaterializedContent,
    options: &EmitOptions,
) -> EmittedTypst {
    TypstEmitter::new(document, modes, actors, materialized, options).emit()
}

struct TypstEmitter<'a> {
    document: &'a SyntaxDocument,
    modes: HashMap<TextRange, ResolvedBodyMode>,
    actors: &'a ActorLowering,
    speakers: HashMap<TextRange, usize>,
    materialized: &'a MaterializedContent,
    options: &'a EmitOptions,
    builder: EmitBuilder,
    diagnostics: Vec<Diagnostic>,
    previous_chat: Option<ChatGroupKey>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ChatGroupKey {
    side: StatementKind,
    speaker: SpeakerIdentity,
    display_name: Option<String>,
    avatar_path: Option<String>,
}

struct SpeakerView {
    identity: SpeakerIdentity,
    display_name: Option<String>,
    avatar_path: Option<String>,
    reserve_avatar_space: bool,
}

#[derive(Default)]
struct EmitBuilder {
    source: String,
    origins: Vec<Origin>,
    source_map: Vec<SourceMapEntry>,
}

impl<'a> TypstEmitter<'a> {
    fn new(
        document: &'a SyntaxDocument,
        modes: &'a BodyModeResolution,
        actors: &'a ActorLowering,
        materialized: &'a MaterializedContent,
        options: &'a EmitOptions,
    ) -> Self {
        Self {
            document,
            modes: modes
                .bodies
                .iter()
                .map(|entry| (entry.range, entry.mode))
                .collect(),
            actors,
            speakers: actors
                .speakers
                .iter()
                .enumerate()
                .map(|(index, speaker)| (speaker.statement_range, index))
                .collect(),
            materialized,
            options,
            builder: EmitBuilder::default(),
            diagnostics: Vec::new(),
            previous_chat: None,
        }
    }

    fn emit(mut self) -> EmittedTypst {
        self.emit_prelude();
        for node in &self.document.nodes {
            match node {
                SyntaxNode::Statement(statement) if statement.kind == StatementKind::Narration => {
                    self.previous_chat = None;
                    self.emit_content_call(
                        "narration",
                        statement.patch.as_ref(),
                        &statement.body,
                        statement.range,
                    );
                }
                SyntaxNode::Statement(statement) => self.emit_chat(statement),
                SyntaxNode::Reply(reply) => {
                    self.previous_chat = None;
                    self.emit_reply(reply);
                }
                SyntaxNode::Bond(bond) => {
                    self.previous_chat = None;
                    self.emit_content_call("bond", bond.patch.as_ref(), &bond.body, bond.range);
                }
                SyntaxNode::DirectiveLine(directive) if directive.name == "typ" => {
                    self.previous_chat = None;
                    if let Some(body) = &directive.payload {
                        self.emit_typ_directive(body);
                    }
                }
                SyntaxNode::DirectiveBlock(block) if block.name == "typ" => {
                    self.previous_chat = None;
                    for item in &block.items {
                        if let crate::syntax::DirectiveItemSyntax::Body(body) = item {
                            self.emit_typ_directive(body);
                        }
                    }
                }
                _ => {}
            }
        }
        self.builder
            .push_generated("\n]", GeneratedKind::TemplateWrapper, None);
        EmittedTypst {
            source: self.builder.source,
            origins: self.builder.origins,
            source_map: self.builder.source_map,
            diagnostics: self.diagnostics,
        }
    }

    fn emit_prelude(&mut self) {
        let import = escape_typst_string(&self.options.template_import);
        let title = escape_typst_string(&self.options.title);
        let author = self
            .options
            .author
            .as_deref()
            .map(escape_typst_string)
            .map(|author| format!("\n  author: \"{author}\","))
            .unwrap_or_default();
        self.builder.push_generated(
            &format!(
                "#import \"{import}\" as mmt\n\n#show: mmt.template.with(\n  show-header: {},\n  title: \"{title}\",{author}\n)\n\n#[",
                self.options.show_header,
            ),
            GeneratedKind::TemplateWrapper,
            None,
        );
    }

    fn emit_chat(&mut self, statement: &crate::syntax::StatementSyntax) {
        let Some(speaker_index) = self.speakers.get(&statement.range).copied() else {
            self.semantic_error("statement has no lowered speaker", statement.range);
            self.previous_chat = None;
            return;
        };
        let speaker = &self.actors.speakers[speaker_index];
        let Some(view) = self.speaker_view(speaker, statement.range) else {
            self.previous_chat = None;
            return;
        };
        let group = ChatGroupKey {
            side: statement.kind,
            speaker: view.identity.clone(),
            display_name: view.display_name.clone(),
            avatar_path: view.avatar_path.clone(),
        };
        let auto_continued = self.previous_chat.as_ref() == Some(&group);
        self.previous_chat = Some(group);

        let parent = self.builder.register_origin(Origin::MmtRange {
            range: statement.range,
            kind: OriginKind::TextBody,
        });
        let function = match statement.kind {
            StatementKind::Right => "chat-left",
            StatementKind::Left => "chat-right",
            StatementKind::Narration => unreachable!(),
        };
        self.builder.push_generated(
            &format!("\n#mmt.{function}(\n  auto-continued: {auto_continued},\n"),
            GeneratedKind::StatementCallWrapper,
            Some(parent),
        );
        self.builder.push_generated(
            &format!("  reserve-avatar-space: {},\n", view.reserve_avatar_space),
            GeneratedKind::StatementCallWrapper,
            Some(parent),
        );
        if let Some(name) = view.display_name {
            self.builder.push_generated(
                &format!("  name: [#text(\"{}\")],\n", escape_typst_string(&name)),
                GeneratedKind::StatementCallWrapper,
                Some(parent),
            );
        }
        if let Some(path) = view.avatar_path {
            self.builder.push_generated(
                &format!(
                    "  avatar: mmt.avatar(image(\"{}\")),\n",
                    escape_typst_string(&path)
                ),
                GeneratedKind::ResourceCallWrapper,
                Some(parent),
            );
        }
        self.emit_patch(statement.patch.as_ref(), parent);
        self.builder
            .push_generated(")[", GeneratedKind::StatementCallWrapper, Some(parent));
        self.emit_body(&statement.body, parent);
        self.builder
            .push_generated("]\n", GeneratedKind::StatementCallWrapper, Some(parent));
    }

    fn speaker_view(
        &mut self,
        speaker: &crate::semantic::ResolvedStatementSpeaker,
        range: TextRange,
    ) -> Option<SpeakerView> {
        match &speaker.speaker {
            SpeakerIdentity::Actor(actor_id) => {
                let actor = self.actors.actors.get(actor_id.0 as usize)?;
                let revision_number = speaker.revision?;
                let revision = actor.revisions.get(revision_number as usize)?;
                let avatar_path = self
                    .materialized
                    .actor_avatars
                    .get(&(*actor_id, revision_number))
                    .cloned();
                if revision.state.avatar.is_some() && avatar_path.is_none() {
                    self.materialize_error("actor avatar has not been materialized", range);
                }
                Some(SpeakerView {
                    identity: speaker.speaker.clone(),
                    display_name: Some(revision.state.display_name.clone()),
                    avatar_path,
                    reserve_avatar_space: true,
                })
            }
            SpeakerIdentity::Builtin(id) => {
                let presentation = self.materialized.builtins.get(id);
                Some(SpeakerView {
                    identity: speaker.speaker.clone(),
                    display_name: presentation.and_then(|item| item.name.clone()),
                    avatar_path: presentation.and_then(|item| item.avatar_path.clone()),
                    reserve_avatar_space: presentation
                        .is_some_and(|item| item.reserve_avatar_space),
                })
            }
        }
    }

    fn emit_reply(&mut self, reply: &crate::syntax::ReplySyntax) {
        let parent = self.builder.register_origin(Origin::MmtRange {
            range: reply.range,
            kind: OriginKind::TextBody,
        });
        self.builder.push_generated(
            "\n#mmt.reply(",
            GeneratedKind::StatementCallWrapper,
            Some(parent),
        );
        self.emit_patch(reply.patch.as_ref(), parent);
        self.builder
            .push_generated(")", GeneratedKind::StatementCallWrapper, Some(parent));
        for item in &reply.items {
            self.builder
                .push_generated("[", GeneratedKind::StatementCallWrapper, Some(parent));
            self.emit_body(item, parent);
            self.builder
                .push_generated("]", GeneratedKind::StatementCallWrapper, Some(parent));
        }
        self.builder
            .push_generated("\n", GeneratedKind::StatementCallWrapper, Some(parent));
    }

    fn emit_content_call(
        &mut self,
        function: &str,
        patch: Option<&PatchSyntax>,
        body: &BodySyntax,
        node_range: TextRange,
    ) {
        let parent = self.builder.register_origin(Origin::MmtRange {
            range: node_range,
            kind: OriginKind::TextBody,
        });
        self.builder.push_generated(
            &format!("\n#mmt.{function}("),
            GeneratedKind::StatementCallWrapper,
            Some(parent),
        );
        self.emit_patch(patch, parent);
        self.builder
            .push_generated(")[", GeneratedKind::StatementCallWrapper, Some(parent));
        self.emit_body(body, parent);
        self.builder
            .push_generated("]\n", GeneratedKind::StatementCallWrapper, Some(parent));
    }

    fn emit_patch(&mut self, patch: Option<&PatchSyntax>, parent: usize) {
        let Some(patch) = patch else {
            return;
        };
        self.diagnostics
            .extend(check_typst_args(&patch.raw_args, patch.args_range));
        self.builder.push_mmt(
            &patch.raw_args,
            patch.args_range,
            OriginKind::StatementPatch,
        );
        if !patch.raw_args.trim_end().ends_with(',') {
            self.builder
                .push_generated(",", GeneratedKind::StatementCallWrapper, Some(parent));
        }
        self.builder
            .push_generated("\n", GeneratedKind::StatementCallWrapper, Some(parent));
    }

    fn emit_body(&mut self, body: &BodySyntax, parent: usize) {
        let mode = self
            .modes
            .get(&body.range)
            .copied()
            .unwrap_or(ResolvedBodyMode::TextMacro);
        match mode {
            ResolvedBodyMode::TextMacro => self.emit_text_parts(body, parent, true),
            ResolvedBodyMode::TextRaw => self.emit_text(body, parent),
            ResolvedBodyMode::TypstRaw => self.emit_checked_typst(body, OriginKind::TypstBody),
            ResolvedBodyMode::TypstMacro => self.emit_typst_overlay(body, parent),
        }
    }

    fn emit_typst_overlay(&mut self, body: &BodySyntax, parent: usize) {
        let scan = scan_typst_overlay_macros(&body.source, body.range);
        self.diagnostics.extend(scan.diagnostics);
        let mut cursor = 0;

        for marker in scan.macros {
            let marker_start = marker.range.start - body.range.start;
            let marker_end = marker.range.end - body.range.start;
            if cursor < marker_start {
                self.builder.push_mmt(
                    &body.source[cursor..marker_start],
                    TextRange::new(body.range.start + cursor, marker.range.start),
                    OriginKind::TypstBody,
                );
            }
            if let Some(typst) = self.materialized.inline_typst.get(&marker.range) {
                self.builder
                    .push_mmt(typst, marker.range, OriginKind::ResourceMarker);
            } else {
                self.materialize_error(
                    "inline resource marker has not been materialized",
                    marker.range,
                );
                self.emit_text_source("[missing resource]", marker.range, parent);
            }
            cursor = marker_end;
        }

        if cursor < body.source.len() {
            self.builder.push_mmt(
                &body.source[cursor..],
                TextRange::new(body.range.start + cursor, body.range.end),
                OriginKind::TypstBody,
            );
        }
    }

    fn emit_text_parts(&mut self, body: &BodySyntax, parent: usize, expand_macros: bool) {
        for part in &body.parts {
            match part {
                BodyPartSyntax::Text { source, range } => {
                    self.emit_text_source(source, *range, parent);
                }
                BodyPartSyntax::InlineMacro(marker) if expand_macros => {
                    if let Some(typst) = self.materialized.inline_typst.get(&marker.range) {
                        self.builder
                            .push_mmt(typst, marker.range, OriginKind::ResourceMarker);
                    } else {
                        self.materialize_error(
                            "inline resource marker has not been materialized",
                            marker.range,
                        );
                        self.emit_text_source("[missing resource]", marker.range, parent);
                    }
                }
                BodyPartSyntax::InlineMacro(marker) => {
                    self.emit_text_source(
                        &body.source[marker.range.start - body.range.start
                            ..marker.range.end - body.range.start],
                        marker.range,
                        parent,
                    );
                }
            }
        }
    }

    fn emit_text(&mut self, body: &BodySyntax, parent: usize) {
        self.emit_text_source(&body.source, body.range, parent);
    }

    fn emit_text_source(&mut self, source: &str, range: TextRange, parent: usize) {
        self.builder
            .push_generated("#text(\"", GeneratedKind::EscapedText, Some(parent));
        self.builder
            .push_mmt(&escape_typst_string(source), range, OriginKind::TextBody);
        self.builder
            .push_generated("\")", GeneratedKind::EscapedText, Some(parent));
    }

    fn emit_checked_typst(&mut self, body: &BodySyntax, kind: OriginKind) {
        self.diagnostics
            .extend(check_typst_source(&body.source, body.range));
        self.builder.push_mmt(&body.source, body.range, kind);
    }

    fn emit_typ_directive(&mut self, body: &BodySyntax) {
        self.diagnostics
            .extend(check_typst_source(&body.source, body.range));
        let parent = self.builder.register_origin(Origin::MmtRange {
            range: body.range,
            kind: OriginKind::TypDirective,
        });
        self.builder
            .push_generated("\n", GeneratedKind::TemplateWrapper, Some(parent));
        self.builder
            .push_mmt(&body.source, body.range, OriginKind::TypDirective);
        self.builder
            .push_generated("\n", GeneratedKind::TemplateWrapper, Some(parent));
    }

    fn semantic_error(&mut self, message: impl Into<String>, range: TextRange) {
        self.diagnostics.push(Diagnostic::new(
            Severity::Error,
            DiagnosticPhase::Semantic,
            message,
            Some(range),
        ));
    }

    fn materialize_error(&mut self, message: impl Into<String>, range: TextRange) {
        self.diagnostics.push(Diagnostic::new(
            Severity::Error,
            DiagnosticPhase::Materialize,
            message,
            Some(range),
        ));
    }
}

impl EmitBuilder {
    fn register_origin(&mut self, origin: Origin) -> usize {
        let id = self.origins.len();
        self.origins.push(origin);
        id
    }

    fn push(&mut self, text: &str, origin: Origin) {
        let start = self.source.len();
        self.source.push_str(text);
        let end = self.source.len();
        let origin_id = self.register_origin(origin);
        if start != end {
            self.source_map.push(SourceMapEntry {
                generated_range: TextRange::new(start, end),
                origin_id,
            });
        }
    }

    fn push_mmt(&mut self, text: &str, range: TextRange, kind: OriginKind) {
        self.push(text, Origin::MmtRange { range, kind });
    }

    fn push_generated(&mut self, text: &str, kind: GeneratedKind, parent: Option<usize>) {
        self.push(text, Origin::Generated { kind, parent });
    }
}

fn escape_typst_string(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::{CharacterPreset, StaticPresetCatalog, lower_actors, resolve_body_modes};
    use crate::{parse_text, typst_check::check_typst_source};

    fn lower(source: &str) -> (SyntaxDocument, BodyModeResolution, ActorLowering) {
        let document = parse_text(source);
        let catalog = StaticPresetCatalog::new(vec![CharacterPreset {
            id: "ba::柚子".to_string(),
            names: vec!["柚子".to_string()],
            display_name: None,
            avatar: None,
        }]);
        let modes = resolve_body_modes(&document);
        let actors = lower_actors(&document, &catalog);
        (document, modes, actors)
    }

    fn emit(source: &str) -> EmittedTypst {
        let (document, modes, actors) = lower(source);
        assert!(document.diagnostics.is_empty());
        assert!(modes.diagnostics.is_empty());
        assert!(actors.diagnostics.is_empty());
        emit_typst(
            &document,
            &modes,
            &actors,
            &MaterializedContent::default(),
            &EmitOptions::default(),
        )
    }

    #[test]
    fn emits_facade_calls_for_core_content_nodes() {
        let emitted = emit(
            "> 柚子: one\n\
             > two\n\
             < sensei\n\
             - narration\n\
             @reply: A | B\n\
             @bond: bond",
        );

        assert!(emitted.diagnostics.is_empty());
        assert!(emitted.source.contains("#mmt.chat-left("));
        assert!(emitted.source.contains("auto-continued: true"));
        assert!(emitted.source.contains("#mmt.chat-right("));
        assert!(emitted.source.contains("reserve-avatar-space: false"));
        assert!(emitted.source.contains("#mmt.narration("));
        assert!(
            emitted
                .source
                .contains("#mmt.reply()[#text(\"A\")][#text(\"B\")]")
        );
        assert!(emitted.source.contains("#mmt.bond()[#text(\"bond\")]"));
        assert!(
            check_typst_source(&emitted.source, TextRange::new(0, emitted.source.len())).is_empty()
        );
    }

    #[test]
    fn emits_typ_directives_and_checked_node_patches() {
        let emitted = emit(
            "@typ\n\
             #let accent = blue\n\
             @end\n\
             >(fill: accent) 柚子: hello",
        );

        assert!(emitted.diagnostics.is_empty());
        assert!(emitted.source.contains("#let accent = blue"));
        assert!(emitted.source.contains("fill: accent,"));
        assert!(emitted.origins.iter().any(|origin| matches!(
            origin,
            Origin::MmtRange {
                kind: OriginKind::StatementPatch,
                ..
            }
        )));
    }

    #[test]
    fn invalid_patch_reports_typst_diagnostic_with_original_range() {
        let (document, modes, actors) = lower(">(fill: ,) 柚子: hello");
        let emitted = emit_typst(
            &document,
            &modes,
            &actors,
            &MaterializedContent::default(),
            &EmitOptions::default(),
        );

        assert!(
            emitted
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.phase == DiagnosticPhase::Typst)
        );
    }

    #[test]
    fn source_map_tracks_generated_wrappers_and_mmt_bodies() {
        let emitted = emit("> 柚子: hello");

        assert!(!emitted.source_map.is_empty());
        assert!(emitted.source_map.iter().any(|entry| matches!(
            emitted.origins[entry.origin_id],
            Origin::MmtRange {
                kind: OriginKind::TextBody,
                ..
            }
        )));
        assert!(emitted.source_map.iter().any(|entry| matches!(
            emitted.origins[entry.origin_id],
            Origin::Generated {
                kind: GeneratedKind::StatementCallWrapper,
                ..
            }
        )));

        let body_offset = emitted
            .source
            .find("hello")
            .expect("body should be emitted");
        assert!(matches!(
            emitted.lookup_mmt_origin(TextRange::empty(body_offset)),
            Some(Origin::MmtRange {
                kind: OriginKind::TextBody,
                ..
            })
        ));
        assert!(
            emitted
                .lookup_origin(TextRange::empty(emitted.source.len()))
                .is_some()
        );
    }

    #[test]
    fn typst_macro_mode_only_expands_ast_markup_regions() {
        let source = "> 柚子: T\"\"\"before [:#1:] #text(\"[:#2:]\") [nested [:#3:]]\"\"\"";
        let (document, modes, actors) = lower(source);
        let SyntaxNode::Statement(statement) = &document.nodes[0] else {
            panic!("expected statement");
        };
        let scan = scan_typst_overlay_macros(&statement.body.source, statement.body.range);
        assert_eq!(scan.macros.len(), 2);

        let mut materialized = MaterializedContent::default();
        for marker in scan.macros {
            materialized.inline_typst.insert(
                marker.range,
                "#mmt.sticker(rect(width: 1em, height: 1em))".to_string(),
            );
        }
        let emitted = emit_typst(
            &document,
            &modes,
            &actors,
            &materialized,
            &EmitOptions::default(),
        );

        assert!(emitted.diagnostics.is_empty());
        assert_eq!(emitted.source.matches("#mmt.sticker(").count(), 2);
        assert!(emitted.source.contains("#text(\"[:#2:]\")"));
        assert!(emitted.origins.iter().any(|origin| matches!(
            origin,
            Origin::MmtRange {
                kind: OriginKind::ResourceMarker,
                ..
            }
        )));
        assert!(
            check_typst_source(&emitted.source, TextRange::new(0, emitted.source.len())).is_empty()
        );
    }
}
