use std::collections::{HashMap, HashSet};

use crate::diag::{Diagnostic, DiagnosticPhase, Severity};
use crate::inline::{DeclarationValueSyntax, parse_declaration_value};
use crate::source::TextRange;
use crate::syntax::{
    DirectiveBlockSyntax, DirectiveItemSyntax, FieldSyntax, SpeakerMarkerSyntax, StatementKind,
    StatementSyntax, SyntaxDocument, SyntaxNode,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CharacterPreset {
    pub id: String,
    pub names: Vec<String>,
    pub display_name: Option<String>,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PresetLookup {
    Found(CharacterPreset),
    Missing,
    Ambiguous { preset_ids: Vec<String> },
}

pub trait CharacterPresetCatalog {
    fn resolve(&self, reference: &str) -> PresetLookup;
}

#[derive(Debug, Clone, Default)]
pub struct StaticPresetCatalog {
    presets: Vec<CharacterPreset>,
}

impl StaticPresetCatalog {
    pub fn new(presets: Vec<CharacterPreset>) -> Self {
        Self { presets }
    }
}

impl CharacterPresetCatalog for StaticPresetCatalog {
    fn resolve(&self, reference: &str) -> PresetLookup {
        if let Some(preset) = self.presets.iter().find(|preset| preset.id == reference) {
            return PresetLookup::Found(preset.clone());
        }

        let matches = self
            .presets
            .iter()
            .filter(|preset| preset.names.iter().any(|name| name == reference))
            .collect::<Vec<_>>();
        match matches.as_slice() {
            [] => PresetLookup::Missing,
            [preset] => PresetLookup::Found((*preset).clone()),
            _ => PresetLookup::Ambiguous {
                preset_ids: matches.iter().map(|preset| preset.id.clone()).collect(),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ActorId(pub u32);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorState {
    pub display_name: String,
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorRevision {
    pub number: u32,
    pub state: ActorState,
    pub origin: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptActor {
    pub id: ActorId,
    pub preset_id: String,
    pub primary_name: String,
    pub names: Vec<String>,
    pub revisions: Vec<ActorRevision>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct BuiltinSpeakerId(pub String);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SpeakerIdentity {
    Actor(ActorId),
    Builtin(BuiltinSpeakerId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedStatementSpeaker {
    pub statement_range: TextRange,
    pub speaker: SpeakerIdentity,
    pub revision: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorLowering {
    pub actors: Vec<ScriptActor>,
    pub speakers: Vec<ResolvedStatementSpeaker>,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActorLoweringOptions {
    pub left_fallback: Option<BuiltinSpeakerId>,
    pub right_fallback: Option<BuiltinSpeakerId>,
}

impl Default for ActorLoweringOptions {
    fn default() -> Self {
        Self {
            left_fallback: Some(BuiltinSpeakerId("__Sensei".to_string())),
            right_fallback: None,
        }
    }
}

pub fn lower_actors(
    document: &SyntaxDocument,
    catalog: &impl CharacterPresetCatalog,
) -> ActorLowering {
    lower_actors_with_options(document, catalog, &ActorLoweringOptions::default())
}

pub fn lower_actors_with_options(
    document: &SyntaxDocument,
    catalog: &impl CharacterPresetCatalog,
    options: &ActorLoweringOptions,
) -> ActorLowering {
    ActorLowerer::new(catalog, options).lower(document)
}

struct ActorLowerer<'a, C> {
    catalog: &'a C,
    options: &'a ActorLoweringOptions,
    actors: Vec<ScriptActor>,
    names: HashMap<String, ActorId>,
    default_actors: HashMap<String, ActorId>,
    right_history: SpeakerHistory,
    left_history: SpeakerHistory,
    speakers: Vec<ResolvedStatementSpeaker>,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Default)]
struct SpeakerHistory {
    current: Option<ActorId>,
    messages: Vec<ActorId>,
    unique: Vec<ActorId>,
}

#[derive(Default)]
struct ActorPatch {
    preset: Option<(String, TextRange)>,
    display_name: Option<(String, TextRange)>,
    avatar: Option<(String, TextRange)>,
    additional_names: Vec<(String, TextRange)>,
}

impl<'a, C: CharacterPresetCatalog> ActorLowerer<'a, C> {
    fn new(catalog: &'a C, options: &'a ActorLoweringOptions) -> Self {
        Self {
            catalog,
            options,
            actors: Vec::new(),
            names: HashMap::new(),
            default_actors: HashMap::new(),
            right_history: SpeakerHistory::default(),
            left_history: SpeakerHistory::default(),
            speakers: Vec::new(),
            diagnostics: Vec::new(),
        }
    }

    fn lower(mut self, document: &SyntaxDocument) -> ActorLowering {
        for node in &document.nodes {
            match node {
                SyntaxNode::DirectiveBlock(block) if block.name == "actor" => {
                    self.lower_actor_block(block);
                }
                SyntaxNode::Statement(statement) => self.lower_statement(statement),
                _ => {}
            }
        }
        ActorLowering {
            actors: self.actors,
            speakers: self.speakers,
            diagnostics: self.diagnostics,
        }
    }

    fn lower_actor_block(&mut self, block: &DirectiveBlockSyntax) {
        let diagnostic_start = self.diagnostics.len();
        let primary_name = match block.head_args.as_slice() {
            [] => None,
            [name] => self.parse_head_name(&name.raw, name.range),
            _ => {
                self.error(
                    "@actor accepts at most one positional actor name; use also-as for additional names",
                    block.range,
                );
                None
            }
        };
        let patch = self.parse_actor_patch(block);
        if self.diagnostics.len() != diagnostic_start {
            return;
        }

        match (primary_name, patch.preset.as_ref()) {
            (None, None) => {
                self.error("headless @actor requires a preset field", block.range);
            }
            (None, Some((preset_ref, range))) => {
                let Some(preset) = self.resolve_preset(preset_ref, *range) else {
                    return;
                };
                let actor_id = if let Some(actor_id) = self.default_actors.get(&preset.id) {
                    *actor_id
                } else {
                    let Some(primary) = preset.names.first().cloned() else {
                        self.error("character preset has no deterministic names", *range);
                        return;
                    };
                    let names = preset.names.clone();
                    let Some(actor_id) =
                        self.create_actor(&preset, primary, names, block.range, &patch)
                    else {
                        return;
                    };
                    self.default_actors.insert(preset.id.clone(), actor_id);
                    return;
                };
                self.apply_patch(actor_id, block.range, &patch, true);
            }
            (Some((name, name_range)), preset) => {
                if let Some(actor_id) = self.names.get(&name).copied() {
                    if preset.is_some() {
                        self.error(
                            format!(
                                "actor '{name}' already exists; preset replacement is unsupported"
                            ),
                            preset.expect("checked as some").1,
                        );
                        return;
                    }
                    self.apply_patch(actor_id, block.range, &patch, false);
                    return;
                }

                let Some((preset_ref, preset_range)) = preset else {
                    self.error(format!("unknown actor name '{name}'"), name_range);
                    return;
                };
                let Some(preset) = self.resolve_preset(preset_ref, *preset_range) else {
                    return;
                };
                let mut names = vec![name.clone()];
                names.extend(patch.additional_names.iter().map(|(name, _)| name.clone()));
                self.create_actor(&preset, name, names, block.range, &patch);
            }
        }
    }

    fn parse_head_name(&mut self, raw: &str, range: TextRange) -> Option<(String, TextRange)> {
        let parsed = parse_declaration_value(raw, range.start);
        self.extend_literal_diagnostics(parsed.diagnostics);
        match parsed.value {
            Some(DeclarationValueSyntax::Scalar(value)) if !value.value.is_empty() => {
                Some((value.value, value.range))
            }
            _ => {
                self.error("actor name must be a non-empty scalar", range);
                None
            }
        }
    }

    fn parse_actor_patch(&mut self, block: &DirectiveBlockSyntax) -> ActorPatch {
        let mut patch = ActorPatch::default();
        let mut seen = HashSet::new();
        for item in &block.items {
            let DirectiveItemSyntax::Field(field) = item else {
                if let DirectiveItemSyntax::Body(body) = item {
                    self.error("@actor body accepts fields only", body.range);
                }
                continue;
            };
            if !seen.insert(field.name.as_str()) {
                self.error(
                    format!("duplicate @actor field '{}'", field.name),
                    field.name_range,
                );
                continue;
            }
            match field.name.as_str() {
                "preset" => patch.preset = self.parse_scalar_field(field),
                "display-name" => patch.display_name = self.parse_scalar_field(field),
                "avatar" => patch.avatar = self.parse_scalar_field(field),
                "also-as" => patch.additional_names = self.parse_name_list(field),
                _ => self.error(
                    format!("unknown @actor field '{}'", field.name),
                    field.name_range,
                ),
            }
        }
        patch
    }

    fn parse_scalar_field(&mut self, field: &FieldSyntax) -> Option<(String, TextRange)> {
        let parsed = parse_declaration_value(&field.value, field.value_range.start);
        self.extend_literal_diagnostics(parsed.diagnostics);
        match parsed.value {
            Some(DeclarationValueSyntax::Scalar(value)) if !value.value.is_empty() => {
                Some((value.value, value.range))
            }
            Some(DeclarationValueSyntax::List { .. }) => {
                self.error(
                    format!("@actor field '{}' requires a scalar value", field.name),
                    field.value_range,
                );
                None
            }
            _ => None,
        }
    }

    fn parse_name_list(&mut self, field: &FieldSyntax) -> Vec<(String, TextRange)> {
        let parsed = parse_declaration_value(&field.value, field.value_range.start);
        self.extend_literal_diagnostics(parsed.diagnostics);
        match parsed.value {
            Some(DeclarationValueSyntax::List { items, .. }) => items
                .into_iter()
                .filter_map(|item| {
                    if item.value.is_empty() {
                        self.error("actor name cannot be empty", item.range);
                        None
                    } else {
                        Some((item.value, item.range))
                    }
                })
                .collect(),
            Some(DeclarationValueSyntax::Scalar(_)) => {
                self.error("also-as requires an explicit [...] list", field.value_range);
                Vec::new()
            }
            None => Vec::new(),
        }
    }

    fn resolve_preset(&mut self, reference: &str, range: TextRange) -> Option<CharacterPreset> {
        match self.catalog.resolve(reference) {
            PresetLookup::Found(preset) => Some(preset),
            PresetLookup::Missing => {
                self.error(format!("unknown character preset '{reference}'"), range);
                None
            }
            PresetLookup::Ambiguous { preset_ids } => {
                self.error(
                    format!(
                        "ambiguous character preset '{reference}'; matches {}",
                        preset_ids.join(", ")
                    ),
                    range,
                );
                None
            }
        }
    }

    fn create_actor(
        &mut self,
        preset: &CharacterPreset,
        primary_name: String,
        names: Vec<String>,
        origin: TextRange,
        patch: &ActorPatch,
    ) -> Option<ActorId> {
        let names = deduplicate_names(names);
        if !self.validate_names_available(&names, None, origin) {
            return None;
        }
        let id = ActorId(self.actors.len() as u32);
        let state = ActorState {
            display_name: patch
                .display_name
                .as_ref()
                .map(|(value, _)| value.clone())
                .or_else(|| preset.display_name.clone())
                .unwrap_or_else(|| primary_name.clone()),
            avatar: patch
                .avatar
                .as_ref()
                .map(|(value, _)| value.clone())
                .or_else(|| preset.avatar.clone()),
        };
        for name in &names {
            self.names.insert(name.clone(), id);
        }
        self.actors.push(ScriptActor {
            id,
            preset_id: preset.id.clone(),
            primary_name,
            names,
            revisions: vec![ActorRevision {
                number: 0,
                state,
                origin,
            }],
        });
        Some(id)
    }

    fn apply_patch(
        &mut self,
        actor_id: ActorId,
        origin: TextRange,
        patch: &ActorPatch,
        allow_creation_preset: bool,
    ) {
        if patch.preset.is_some() && !allow_creation_preset {
            self.error(
                "preset can only be specified when creating an actor",
                origin,
            );
            return;
        }
        let additional_names = deduplicate_names(
            patch
                .additional_names
                .iter()
                .map(|(name, _)| name.clone())
                .collect(),
        );
        if !self.validate_names_available(&additional_names, Some(actor_id), origin) {
            return;
        }

        for name in additional_names {
            if !self.actors[actor_id.0 as usize].names.contains(&name) {
                self.names.insert(name.clone(), actor_id);
                self.actors[actor_id.0 as usize].names.push(name);
            }
        }

        if patch.display_name.is_none() && patch.avatar.is_none() {
            return;
        }
        let actor = &mut self.actors[actor_id.0 as usize];
        let mut state = actor
            .revisions
            .last()
            .expect("actors always have an initial revision")
            .state
            .clone();
        if let Some((display_name, _)) = &patch.display_name {
            state.display_name = display_name.clone();
        }
        if let Some((avatar, _)) = &patch.avatar {
            state.avatar = Some(avatar.clone());
        }
        actor.revisions.push(ActorRevision {
            number: actor.revisions.len() as u32,
            state,
            origin,
        });
    }

    fn validate_names_available(
        &mut self,
        names: &[String],
        expected_actor: Option<ActorId>,
        range: TextRange,
    ) -> bool {
        let conflicts = names
            .iter()
            .filter(|name| {
                self.names
                    .get(*name)
                    .is_some_and(|actor_id| Some(*actor_id) != expected_actor)
            })
            .cloned()
            .collect::<Vec<_>>();
        if conflicts.is_empty() {
            true
        } else {
            self.error(
                format!("actor name conflict: {}", conflicts.join(", ")),
                range,
            );
            false
        }
    }

    fn lower_statement(&mut self, statement: &StatementSyntax) {
        if statement.kind == StatementKind::Narration {
            return;
        }
        let Some(marker) = &statement.marker else {
            if let Some(actor_id) = self.history(statement.kind).current {
                self.capture_actor_speaker(statement, actor_id);
            } else if let Some(builtin) = self.fallback_speaker(statement.kind).cloned() {
                self.speakers.push(ResolvedStatementSpeaker {
                    statement_range: statement.range,
                    speaker: SpeakerIdentity::Builtin(builtin),
                    revision: None,
                });
            } else {
                self.error(
                    "right-side dialogue requires a current speaker",
                    statement.range,
                );
            }
            return;
        };

        let actor_id = match marker {
            SpeakerMarkerSyntax::Explicit { raw, range } => {
                self.resolve_explicit_speaker(raw, *range)
            }
            SpeakerMarkerSyntax::BackRef { n, range } => {
                self.resolve_history_reference(statement.kind, *n, false, *range)
            }
            SpeakerMarkerSyntax::UniqueIndex { n, range } => {
                self.resolve_history_reference(statement.kind, *n, true, *range)
            }
        };
        let Some(actor_id) = actor_id else {
            return;
        };
        self.capture_actor_speaker(statement, actor_id);
    }

    fn capture_actor_speaker(&mut self, statement: &StatementSyntax, actor_id: ActorId) {
        let revision = self.actors[actor_id.0 as usize]
            .revisions
            .last()
            .expect("actors always have an initial revision")
            .number;
        self.speakers.push(ResolvedStatementSpeaker {
            statement_range: statement.range,
            speaker: SpeakerIdentity::Actor(actor_id),
            revision: Some(revision),
        });
        self.history_mut(statement.kind).record(actor_id);
    }

    fn resolve_explicit_speaker(&mut self, name: &str, range: TextRange) -> Option<ActorId> {
        if let Some(actor_id) = self.names.get(name) {
            return Some(*actor_id);
        }
        let preset = self.resolve_preset(name, range)?;
        if let Some(actor_id) = self.default_actors.get(&preset.id) {
            return Some(*actor_id);
        }
        let Some(primary_name) = preset.names.first().cloned() else {
            self.error("character preset has no deterministic names", range);
            return None;
        };
        let names = preset.names.clone();
        let actor_id =
            self.create_actor(&preset, primary_name, names, range, &ActorPatch::default())?;
        self.default_actors.insert(preset.id.clone(), actor_id);
        Some(actor_id)
    }

    fn resolve_history_reference(
        &mut self,
        kind: StatementKind,
        n: u32,
        unique: bool,
        range: TextRange,
    ) -> Option<ActorId> {
        if n == 0 {
            self.error("speaker reference index must be at least 1", range);
            return None;
        }
        let history = self.history(kind);
        let actor_id = if unique {
            history.unique.get(n as usize - 1).copied()
        } else {
            history.messages.iter().rev().nth(n as usize - 1).copied()
        };
        if actor_id.is_none() {
            self.error(
                format!(
                    "invalid {} speaker reference {}{}",
                    side_name(kind),
                    if unique { "~" } else { "_" },
                    n
                ),
                range,
            );
        }
        actor_id
    }

    fn history(&self, kind: StatementKind) -> &SpeakerHistory {
        match kind {
            StatementKind::Right => &self.right_history,
            StatementKind::Left => &self.left_history,
            StatementKind::Narration => unreachable!("narration has no speaker history"),
        }
    }

    fn history_mut(&mut self, kind: StatementKind) -> &mut SpeakerHistory {
        match kind {
            StatementKind::Right => &mut self.right_history,
            StatementKind::Left => &mut self.left_history,
            StatementKind::Narration => unreachable!("narration has no speaker history"),
        }
    }

    fn fallback_speaker(&self, kind: StatementKind) -> Option<&BuiltinSpeakerId> {
        match kind {
            StatementKind::Left => self.options.left_fallback.as_ref(),
            StatementKind::Right => self.options.right_fallback.as_ref(),
            StatementKind::Narration => None,
        }
    }

    fn extend_literal_diagnostics(
        &mut self,
        diagnostics: Vec<crate::inline::InlineMacroDiagnostic>,
    ) {
        self.diagnostics
            .extend(diagnostics.into_iter().map(|diagnostic| {
                Diagnostic::new(
                    Severity::Error,
                    DiagnosticPhase::Semantic,
                    diagnostic.message,
                    Some(diagnostic.range),
                )
            }));
    }

    fn error(&mut self, message: impl Into<String>, range: TextRange) {
        self.diagnostics.push(Diagnostic::new(
            Severity::Error,
            DiagnosticPhase::Semantic,
            message,
            Some(range),
        ));
    }
}

impl SpeakerHistory {
    fn record(&mut self, actor_id: ActorId) {
        self.current = Some(actor_id);
        self.messages.push(actor_id);
        if !self.unique.contains(&actor_id) {
            self.unique.push(actor_id);
        }
    }
}

fn deduplicate_names(names: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    names
        .into_iter()
        .filter(|name| seen.insert(name.clone()))
        .collect()
}

fn side_name(kind: StatementKind) -> &'static str {
    match kind {
        StatementKind::Right => "right-side",
        StatementKind::Left => "left-side",
        StatementKind::Narration => "narration",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_text;

    fn preset(id: &str, names: &[&str]) -> CharacterPreset {
        CharacterPreset {
            id: id.to_string(),
            names: names.iter().map(|name| (*name).to_string()).collect(),
            display_name: None,
            avatar: Some(format!("{id}/avatar/default")),
        }
    }

    fn catalog() -> StaticPresetCatalog {
        StaticPresetCatalog::new(vec![
            preset("ba::日富美", &["日富美"]),
            preset("ba::柚子", &["柚子", "花冈柚子"]),
            preset("ba::桃井", &["桃井"]),
        ])
    }

    #[test]
    fn lazy_actor_aliases_and_revisions_share_one_identity() {
        let document = parse_text(
            "> 日富美: first\n\
             @actor 日富美\n\
             display-name: \"小鸟游日富美\"\n\
             avatar: ba::日富美/avatar/smile\n\
             also-as: [hifumi]\n\
             @end\n\
             > hifumi: second\n\
             > _: third",
        );
        assert!(document.diagnostics.is_empty());

        let lowered = lower_actors(&document, &catalog());
        assert!(lowered.diagnostics.is_empty());
        assert_eq!(lowered.actors.len(), 1);
        assert_eq!(lowered.actors[0].names, vec!["日富美", "hifumi"]);
        assert_eq!(lowered.actors[0].revisions.len(), 2);
        assert_eq!(
            lowered.actors[0].revisions[1].state.display_name,
            "小鸟游日富美"
        );
        assert_eq!(
            lowered
                .speakers
                .iter()
                .map(|speaker| (speaker.speaker.clone(), speaker.revision))
                .collect::<Vec<_>>(),
            vec![
                (SpeakerIdentity::Actor(ActorId(0)), Some(0)),
                (SpeakerIdentity::Actor(ActorId(0)), Some(1)),
                (SpeakerIdentity::Actor(ActorId(0)), Some(1)),
            ]
        );
    }

    #[test]
    fn named_actors_from_one_preset_are_independent() {
        let document = parse_text(
            "@actor first\n\
             preset: ba::日富美\n\
             display-name: First\n\
             @end\n\
             @actor second\n\
             preset: ba::日富美\n\
             display-name: Second\n\
             @end\n\
             > first: one\n\
             > second: two",
        );
        let lowered = lower_actors(&document, &catalog());

        assert!(lowered.diagnostics.is_empty());
        assert_eq!(lowered.actors.len(), 2);
        assert_ne!(lowered.speakers[0].speaker, lowered.speakers[1].speaker);
        assert_eq!(lowered.actors[0].revisions[0].state.display_name, "First");
        assert_eq!(lowered.actors[1].revisions[0].state.display_name, "Second");
    }

    #[test]
    fn headless_actor_uses_preset_default_names() {
        let document = parse_text(
            "@actor\n\
             preset: ba::柚子\n\
             avatar: custom::yuzu\n\
             @end\n\
             > 花冈柚子: hello",
        );
        let lowered = lower_actors(&document, &catalog());

        assert!(lowered.diagnostics.is_empty());
        assert_eq!(lowered.actors.len(), 1);
        assert_eq!(lowered.actors[0].primary_name, "柚子");
        assert_eq!(lowered.actors[0].names, vec!["柚子", "花冈柚子"]);
        assert_eq!(
            lowered.actors[0].revisions[0].state.avatar.as_deref(),
            Some("custom::yuzu")
        );
    }

    #[test]
    fn backrefs_and_unique_indexes_are_side_local() {
        let document = parse_text(
            "> 柚子: one\n\
             > 桃井: two\n\
             > _2: right backref\n\
             > ~2: right unique\n\
             < 桃井: left one\n\
             < _: left backref\n\
             < ~2: invalid left unique",
        );
        let lowered = lower_actors(&document, &catalog());

        assert_eq!(lowered.diagnostics.len(), 1);
        assert!(
            lowered.diagnostics[0]
                .message
                .contains("invalid left-side speaker reference ~2")
        );
        assert_eq!(
            lowered
                .speakers
                .iter()
                .map(|speaker| speaker.speaker.clone())
                .collect::<Vec<_>>(),
            vec![
                SpeakerIdentity::Actor(ActorId(0)),
                SpeakerIdentity::Actor(ActorId(1)),
                SpeakerIdentity::Actor(ActorId(0)),
                SpeakerIdentity::Actor(ActorId(1)),
                SpeakerIdentity::Actor(ActorId(1)),
                SpeakerIdentity::Actor(ActorId(1)),
            ]
        );
    }

    #[test]
    fn invalid_actor_declarations_do_not_rebind_or_merge_names() {
        let document = parse_text(
            "@actor a\n\
             preset: ba::柚子\n\
             @end\n\
             @actor b\n\
             preset: ba::桃井\n\
             @end\n\
             @actor a\n\
             also-as: [b]\n\
             @end\n\
             @actor a\n\
             preset: ba::日富美\n\
             @end\n\
             > a: yuzu\n\
             > b: momoi",
        );
        let lowered = lower_actors(&document, &catalog());

        assert_eq!(lowered.diagnostics.len(), 2);
        assert_eq!(lowered.actors.len(), 2);
        assert_eq!(lowered.actors[0].preset_id, "ba::柚子");
        assert_eq!(lowered.actors[1].preset_id, "ba::桃井");
        assert_eq!(lowered.actors[0].names, vec!["a"]);
        assert_eq!(lowered.actors[1].names, vec!["b"]);
    }

    #[test]
    fn malformed_actor_shapes_report_semantic_errors() {
        let document = parse_text(
            "@actor unknown\n\
             @end\n\
             @actor one two\n\
             preset: ba::柚子\n\
             @end\n\
             @actor alias\n\
             preset: ba::桃井\n\
             also-as: a, b\n\
             @end\n\
             > body without speaker",
        );
        let lowered = lower_actors(&document, &catalog());

        assert_eq!(lowered.actors.len(), 0);
        assert_eq!(lowered.diagnostics.len(), 4);
        assert!(
            lowered
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.phase == DiagnosticPhase::Semantic)
        );
    }

    #[test]
    fn ambiguous_catalog_names_do_not_lazily_create_an_actor() {
        let catalog =
            StaticPresetCatalog::new(vec![preset("ba::梦", &["梦"]), preset("gf2::梦", &["梦"])]);
        let document = parse_text("> 梦: hello");
        let lowered = lower_actors(&document, &catalog);

        assert!(lowered.actors.is_empty());
        assert!(lowered.speakers.is_empty());
        assert_eq!(lowered.diagnostics.len(), 1);
        assert!(lowered.diagnostics[0].message.contains("ambiguous"));
    }

    #[test]
    fn omitted_speakers_reuse_current_actor_or_default_left_side_to_sensei() {
        let document = parse_text(
            "> 柚子: first\n\
             > continues current actor\n\
             < implicit Sensei\n\
             < still Sensei",
        );
        let lowered = lower_actors(&document, &catalog());

        assert!(lowered.diagnostics.is_empty());
        assert_eq!(
            lowered
                .speakers
                .iter()
                .map(|speaker| speaker.speaker.clone())
                .collect::<Vec<_>>(),
            vec![
                SpeakerIdentity::Actor(ActorId(0)),
                SpeakerIdentity::Actor(ActorId(0)),
                SpeakerIdentity::Builtin(BuiltinSpeakerId("__Sensei".to_string())),
                SpeakerIdentity::Builtin(BuiltinSpeakerId("__Sensei".to_string())),
            ]
        );
        assert_eq!(lowered.speakers[2].revision, None);
    }

    #[test]
    fn fallback_builtin_speakers_are_configurable_by_side() {
        let options = ActorLoweringOptions {
            left_fallback: Some(BuiltinSpeakerId("narrator-left".to_string())),
            right_fallback: Some(BuiltinSpeakerId("narrator-right".to_string())),
        };
        let document = parse_text("> right fallback\n< left fallback");
        let lowered = lower_actors_with_options(&document, &catalog(), &options);

        assert!(lowered.diagnostics.is_empty());
        assert_eq!(
            lowered
                .speakers
                .iter()
                .map(|speaker| speaker.speaker.clone())
                .collect::<Vec<_>>(),
            vec![
                SpeakerIdentity::Builtin(BuiltinSpeakerId("narrator-right".to_string())),
                SpeakerIdentity::Builtin(BuiltinSpeakerId("narrator-left".to_string())),
            ]
        );
    }
}
