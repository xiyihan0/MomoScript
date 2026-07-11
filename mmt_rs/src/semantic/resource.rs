use std::collections::HashMap;

use crate::diag::{Diagnostic, DiagnosticPhase, Severity};
use crate::inline::{InlineMacroSyntax, MacroArgSyntax, MacroValueSyntax};
use crate::semantic::{
    ActorId, ActorLowering, BodyModeResolution, ResolvedBodyMode, SpeakerIdentity,
};
use crate::source::TextRange;
use crate::syntax::{BodyPartSyntax, BodySyntax, PatchSyntax, SyntaxDocument, SyntaxNode};
use crate::typst_check::{check_typst_args, scan_typst_overlay_macros};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SubjectRef {
    Actor(ActorId),
    Entity {
        namespace: Option<String>,
        name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VariantSelector {
    Name(String),
    Ordinal(u32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResourceSelector {
    Sticker {
        subject: SubjectRef,
        contribution: Option<String>,
        set: Option<String>,
        variant: VariantSelector,
    },
    Asset {
        name: String,
    },
    Temporary {
        name: String,
    },
    File {
        path: String,
    },
    Url {
        url: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedResourceMarker {
    pub range: TextRange,
    pub selector: ResourceSelector,
    pub render_patch: Option<PatchSyntax>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceLowering {
    pub markers: Vec<ResolvedResourceMarker>,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn lower_resource_markers(
    document: &SyntaxDocument,
    modes: &BodyModeResolution,
    actors: &ActorLowering,
) -> ResourceLowering {
    ResourceLowerer::new(modes, actors).lower(document)
}

struct ResourceLowerer<'a> {
    modes: HashMap<TextRange, ResolvedBodyMode>,
    speakers: HashMap<TextRange, SpeakerIdentity>,
    actor_names: HashMap<String, ActorId>,
    markers: Vec<ResolvedResourceMarker>,
    diagnostics: Vec<Diagnostic>,
    _actors: &'a ActorLowering,
}

#[derive(Debug)]
struct SelectorAtom {
    namespace: Option<String>,
    value: String,
    ordinal: Option<u32>,
    quoted: bool,
}

impl<'a> ResourceLowerer<'a> {
    fn new(modes: &BodyModeResolution, actors: &'a ActorLowering) -> Self {
        let actor_names = actors
            .actors
            .iter()
            .flat_map(|actor| {
                actor
                    .names
                    .iter()
                    .cloned()
                    .map(move |name| (name, actor.id))
            })
            .collect();
        Self {
            modes: modes
                .bodies
                .iter()
                .map(|entry| (entry.range, entry.mode))
                .collect(),
            speakers: actors
                .speakers
                .iter()
                .map(|speaker| (speaker.statement_range, speaker.speaker.clone()))
                .collect(),
            actor_names,
            markers: Vec::new(),
            diagnostics: Vec::new(),
            _actors: actors,
        }
    }

    fn lower(mut self, document: &SyntaxDocument) -> ResourceLowering {
        for node in &document.nodes {
            match node {
                SyntaxNode::Statement(statement) => {
                    let speaker = self.speakers.get(&statement.range).cloned();
                    self.lower_body(&statement.body, speaker.as_ref());
                }
                SyntaxNode::Reply(reply) => {
                    for body in &reply.items {
                        self.lower_body(body, None);
                    }
                }
                SyntaxNode::Bond(bond) => self.lower_body(&bond.body, None),
                _ => {}
            }
        }
        ResourceLowering {
            markers: self.markers,
            diagnostics: self.diagnostics,
        }
    }

    fn lower_body(&mut self, body: &BodySyntax, speaker: Option<&SpeakerIdentity>) {
        match self
            .modes
            .get(&body.range)
            .copied()
            .unwrap_or(ResolvedBodyMode::TextMacro)
        {
            ResolvedBodyMode::TextMacro => {
                let markers = body
                    .parts
                    .iter()
                    .filter_map(|part| match part {
                        BodyPartSyntax::InlineMacro(marker) => Some(marker.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                for marker in markers {
                    self.lower_marker(&marker, speaker);
                }
            }
            ResolvedBodyMode::TypstMacro => {
                let scan = scan_typst_overlay_macros(&body.source, body.range);
                self.diagnostics.extend(scan.diagnostics);
                for marker in scan.macros {
                    self.lower_marker(&marker, speaker);
                }
            }
            ResolvedBodyMode::TextRaw | ResolvedBodyMode::TypstRaw => {}
        }
    }

    fn lower_marker(&mut self, marker: &InlineMacroSyntax, speaker: Option<&SpeakerIdentity>) {
        if let Some(patch) = &marker.render_patch {
            self.diagnostics
                .extend(check_typst_args(&patch.raw_args, patch.args_range));
        }
        let Some(selector) = self.parse_marker_selector(marker, speaker) else {
            return;
        };
        self.markers.push(ResolvedResourceMarker {
            range: marker.range,
            selector,
            render_patch: marker.render_patch.clone(),
        });
    }

    fn parse_marker_selector(
        &mut self,
        marker: &InlineMacroSyntax,
        speaker: Option<&SpeakerIdentity>,
    ) -> Option<ResourceSelector> {
        match marker.args.as_slice() {
            [] => {
                self.error(
                    "resource marker requires at least one argument",
                    marker.args_range,
                );
                None
            }
            [only] => self.parse_single_arg(only, speaker),
            [first, second] => self.parse_two_args(first, second, speaker),
            _ => {
                self.error(
                    "resource marker accepts at most two selector arguments",
                    marker.args_range,
                );
                None
            }
        }
    }

    fn parse_single_arg(
        &mut self,
        arg: &MacroArgSyntax,
        speaker: Option<&SpeakerIdentity>,
    ) -> Option<ResourceSelector> {
        let mut atom = self.atom(arg)?;
        if atom.namespace.as_deref() == Some("asset") {
            atom.namespace = None;
            return self.named_space(ResourceSpace::Asset, atom, arg.range);
        }
        if atom.namespace.as_deref() == Some("tmp") {
            atom.namespace = None;
            return self.named_space(ResourceSpace::Temporary, atom, arg.range);
        }
        if atom.namespace.is_none() && is_url(&atom.value) {
            return Some(ResourceSelector::Url { url: atom.value });
        }
        if !atom.quoted && looks_like_full_sticker_path(&atom) {
            return self.parse_full_sticker_path(atom, arg.range);
        }

        let subject = self.implicit_subject(speaker, arg.range)?;
        let (contribution, set, variant) = self.parse_sticker_atom(atom, arg.range)?;
        Some(ResourceSelector::Sticker {
            subject,
            contribution,
            set,
            variant,
        })
    }

    fn parse_two_args(
        &mut self,
        first: &MacroArgSyntax,
        second: &MacroArgSyntax,
        speaker: Option<&SpeakerIdentity>,
    ) -> Option<ResourceSelector> {
        if let Some(space) = explicit_resource_space(&first.value) {
            let atom = self.atom(second)?;
            return match space {
                ResourceSpace::Sticker => {
                    let subject = self.implicit_subject(speaker, first.range)?;
                    let (contribution, set, variant) =
                        self.parse_sticker_atom(atom, second.range)?;
                    Some(ResourceSelector::Sticker {
                        subject,
                        contribution,
                        set,
                        variant,
                    })
                }
                other => self.named_space(other, atom, second.range),
            };
        }

        let subject = self.parse_subject(first)?;
        let atom = self.atom(second)?;
        let (contribution, set, variant) = self.parse_sticker_atom(atom, second.range)?;
        Some(ResourceSelector::Sticker {
            subject,
            contribution,
            set,
            variant,
        })
    }

    fn named_space(
        &mut self,
        space: ResourceSpace,
        atom: SelectorAtom,
        range: TextRange,
    ) -> Option<ResourceSelector> {
        if atom.ordinal.is_some() || atom.value.is_empty() {
            self.error("resource-space value must be a non-empty name", range);
            return None;
        }
        if atom.namespace.is_some() {
            self.error(
                "resource-space value cannot contain another namespace",
                range,
            );
            return None;
        }
        match space {
            ResourceSpace::Asset => Some(ResourceSelector::Asset { name: atom.value }),
            ResourceSpace::Temporary => Some(ResourceSelector::Temporary { name: atom.value }),
            ResourceSpace::File => Some(ResourceSelector::File { path: atom.value }),
            ResourceSpace::Url if is_url(&atom.value) => {
                Some(ResourceSelector::Url { url: atom.value })
            }
            ResourceSpace::Url => {
                self.error("url resource requires an http:// or https:// URL", range);
                None
            }
            ResourceSpace::Sticker => unreachable!("sticker is handled with subject context"),
        }
    }

    fn parse_full_sticker_path(
        &mut self,
        atom: SelectorAtom,
        range: TextRange,
    ) -> Option<ResourceSelector> {
        let segments = atom.value.split('/').collect::<Vec<_>>();
        let slot_index = segments
            .iter()
            .position(|segment| *segment == "sticker" || segment.ends_with("::sticker"))?;
        if slot_index != 1 || segments.len() < 3 || segments.len() > 4 {
            self.error("invalid full sticker resource path", range);
            return None;
        }
        let subject = self.subject_from_parts(atom.namespace, segments[0], range)?;
        let contribution = segments[1]
            .strip_suffix("::sticker")
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        let (set, variant_raw) = if segments.len() == 3 {
            (None, segments[2])
        } else {
            (Some(segments[2].to_string()), segments[3])
        };
        let variant = parse_variant_literal(variant_raw, range, &mut self.diagnostics)?;
        Some(ResourceSelector::Sticker {
            subject,
            contribution,
            set,
            variant,
        })
    }

    fn parse_sticker_atom(
        &mut self,
        atom: SelectorAtom,
        range: TextRange,
    ) -> Option<(Option<String>, Option<String>, VariantSelector)> {
        if atom.value.starts_with('?') {
            self.error("natural-language resource queries are not supported", range);
            return None;
        }
        if !atom.quoted && (atom.value.contains('(') || atom.value.contains(')')) {
            self.error(
                "resource selector cannot contain Typst call syntax; use the marker suffix patch",
                range,
            );
            return None;
        }
        if let Some(ordinal) = atom.ordinal {
            if ordinal == 0 {
                self.error("resource ordinal must be at least 1", range);
                return None;
            }
            return Some((atom.namespace, None, VariantSelector::Ordinal(ordinal)));
        }
        if atom.quoted {
            return Some((atom.namespace, None, VariantSelector::Name(atom.value)));
        }

        let segments = atom.value.split('/').collect::<Vec<_>>();
        match segments.as_slice() {
            [variant] => Some((
                atom.namespace,
                None,
                parse_variant_literal(variant, range, &mut self.diagnostics)?,
            )),
            [set, variant] if !set.is_empty() => Some((
                atom.namespace,
                Some((*set).to_string()),
                parse_variant_literal(variant, range, &mut self.diagnostics)?,
            )),
            _ => {
                self.error("invalid sticker selector path", range);
                None
            }
        }
    }

    fn parse_subject(&mut self, arg: &MacroArgSyntax) -> Option<SubjectRef> {
        let atom = self.atom(arg)?;
        if atom.ordinal.is_some() || atom.value.contains('/') || atom.value.is_empty() {
            self.error("invalid resource subject", arg.range);
            return None;
        }
        self.subject_from_parts(atom.namespace, &atom.value, arg.range)
    }

    fn subject_from_parts(
        &mut self,
        namespace: Option<String>,
        name: &str,
        range: TextRange,
    ) -> Option<SubjectRef> {
        if namespace.is_none()
            && let Some(actor_id) = self.actor_names.get(name)
        {
            return Some(SubjectRef::Actor(*actor_id));
        }
        if name.is_empty() {
            self.error("resource subject cannot be empty", range);
            return None;
        }
        Some(SubjectRef::Entity {
            namespace,
            name: name.to_string(),
        })
    }

    fn implicit_subject(
        &mut self,
        speaker: Option<&SpeakerIdentity>,
        range: TextRange,
    ) -> Option<SubjectRef> {
        match speaker {
            Some(SpeakerIdentity::Actor(actor_id)) => Some(SubjectRef::Actor(*actor_id)),
            Some(SpeakerIdentity::Builtin(_)) | None => {
                self.error(
                    "bare sticker selector requires an explicit actor speaker or subject",
                    range,
                );
                None
            }
        }
    }

    fn atom(&mut self, arg: &MacroArgSyntax) -> Option<SelectorAtom> {
        match atom_from_value(&arg.value) {
            Ok(atom) => Some(atom),
            Err(message) => {
                self.error(message, arg.range);
                None
            }
        }
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

#[derive(Debug, Clone, Copy)]
enum ResourceSpace {
    Sticker,
    Asset,
    Temporary,
    File,
    Url,
}

fn explicit_resource_space(value: &MacroValueSyntax) -> Option<ResourceSpace> {
    let MacroValueSyntax::Bare(value) = value else {
        return None;
    };
    match value.as_str() {
        "sticker" => Some(ResourceSpace::Sticker),
        "asset" => Some(ResourceSpace::Asset),
        "tmp" => Some(ResourceSpace::Temporary),
        "file" => Some(ResourceSpace::File),
        "url" => Some(ResourceSpace::Url),
        _ => None,
    }
}

fn atom_from_value(value: &MacroValueSyntax) -> Result<SelectorAtom, &'static str> {
    match value {
        MacroValueSyntax::Bare(value) => Ok(SelectorAtom {
            namespace: None,
            value: value.clone(),
            ordinal: None,
            quoted: false,
        }),
        MacroValueSyntax::Quoted { value, .. } => Ok(SelectorAtom {
            namespace: None,
            value: value.clone(),
            ordinal: None,
            quoted: true,
        }),
        MacroValueSyntax::Ordinal { n } => Ok(SelectorAtom {
            namespace: None,
            value: format!("#{n}"),
            ordinal: Some(*n),
            quoted: false,
        }),
        MacroValueSyntax::Namespaced { namespace, value } => {
            let mut atom = atom_from_value(value)?;
            if atom.namespace.is_some() {
                return Err("resource selector contains nested namespaces");
            }
            atom.namespace = Some(namespace.clone());
            Ok(atom)
        }
    }
}

fn looks_like_full_sticker_path(atom: &SelectorAtom) -> bool {
    atom.value
        .split('/')
        .any(|segment| segment == "sticker" || segment.ends_with("::sticker"))
}

fn parse_variant_literal(
    raw: &str,
    range: TextRange,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<VariantSelector> {
    if let Some(value) = raw.strip_prefix('#') {
        let Ok(n) = value.parse::<u32>() else {
            diagnostics.push(semantic_error("invalid resource ordinal", range));
            return None;
        };
        if n == 0 {
            diagnostics.push(semantic_error("resource ordinal must be at least 1", range));
            return None;
        }
        Some(VariantSelector::Ordinal(n))
    } else if raw.is_empty() {
        diagnostics.push(semantic_error("resource variant cannot be empty", range));
        None
    } else if raw.starts_with('?') {
        diagnostics.push(semantic_error(
            "natural-language resource queries are not supported",
            range,
        ));
        None
    } else {
        Some(VariantSelector::Name(raw.to_string()))
    }
}

fn semantic_error(message: impl Into<String>, range: TextRange) -> Diagnostic {
    Diagnostic::new(
        Severity::Error,
        DiagnosticPhase::Semantic,
        message,
        Some(range),
    )
}

fn is_url(value: &str) -> bool {
    value.starts_with("https://") || value.starts_with("http://")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_text;
    use crate::semantic::{CharacterPreset, StaticPresetCatalog, lower_actors, resolve_body_modes};

    fn lower(source: &str) -> ResourceLowering {
        let document = parse_text(source);
        let catalog = StaticPresetCatalog::new(vec![CharacterPreset {
            id: "ba::柚子".to_string(),
            names: vec!["柚子".to_string()],
            display_name: None,
            avatar: None,
        }]);
        let modes = resolve_body_modes(&document);
        let actors = lower_actors(&document, &catalog);
        assert!(document.diagnostics.is_empty());
        assert!(modes.diagnostics.is_empty());
        assert!(actors.diagnostics.is_empty());
        lower_resource_markers(&document, &modes, &actors)
    }

    #[test]
    fn normalizes_current_and_explicit_subject_stickers() {
        let lowered = lower(
            "> 柚子: [:happy:] [:ba_extpack::#1:]\n\
             - [:柚子, 战损/#2:] [:ba::晴_露营, ba_extpack::\">_<笑\":]",
        );

        assert!(
            lowered.diagnostics.is_empty(),
            "diagnostics: {:?}",
            lowered.diagnostics
        );
        assert_eq!(lowered.markers.len(), 4);
        assert!(matches!(
            &lowered.markers[0].selector,
            ResourceSelector::Sticker {
                subject: SubjectRef::Actor(ActorId(0)),
                contribution: None,
                set: None,
                variant: VariantSelector::Name(name),
            } if name == "happy"
        ));
        assert!(matches!(
            &lowered.markers[1].selector,
            ResourceSelector::Sticker {
                contribution: Some(namespace),
                variant: VariantSelector::Ordinal(1),
                ..
            } if namespace == "ba_extpack"
        ));
        assert!(matches!(
            &lowered.markers[2].selector,
            ResourceSelector::Sticker {
                subject: SubjectRef::Actor(ActorId(0)),
                set: Some(set),
                variant: VariantSelector::Ordinal(2),
                ..
            } if set == "战损"
        ));
        assert!(matches!(
            &lowered.markers[3].selector,
            ResourceSelector::Sticker {
                subject: SubjectRef::Entity { namespace: Some(namespace), name },
                contribution: Some(contribution),
                variant: VariantSelector::Name(variant),
                ..
            } if namespace == "ba" && name == "晴_露营"
                && contribution == "ba_extpack" && variant == ">_<笑"
        ));
    }

    #[test]
    fn normalizes_full_paths_and_explicit_resource_spaces() {
        let lowered = lower(
            "> 柚子: [:ba::晴_露营/ba_extpack::sticker/default/#1:]\n\
             - [:asset, hero:] [:tmp::upload_1:] [:file, images/a.png:]\n\
             - [:url, https://example.com/a.png:] [:https://example.com/b.png:]",
        );

        assert!(
            lowered.diagnostics.is_empty(),
            "diagnostics: {:?}",
            lowered.diagnostics
        );
        assert_eq!(lowered.markers.len(), 6);
        assert!(matches!(
            &lowered.markers[0].selector,
            ResourceSelector::Sticker {
                contribution: Some(contribution),
                set: Some(set),
                variant: VariantSelector::Ordinal(1),
                ..
            } if contribution == "ba_extpack" && set == "default"
        ));
        assert!(matches!(
            &lowered.markers[1].selector,
            ResourceSelector::Asset { name } if name == "hero"
        ));
        assert!(matches!(
            &lowered.markers[2].selector,
            ResourceSelector::Temporary { name } if name == "upload_1"
        ));
        assert!(matches!(
            &lowered.markers[3].selector,
            ResourceSelector::File { path } if path == "images/a.png"
        ));
        assert!(matches!(
            &lowered.markers[4].selector,
            ResourceSelector::Url { url } if url.ends_with("a.png")
        ));
        assert!(matches!(
            &lowered.markers[5].selector,
            ResourceSelector::Url { url } if url.ends_with("b.png")
        ));
    }

    #[test]
    fn rejects_implicit_subjects_queries_calls_and_bad_ordinals() {
        let lowered = lower(
            "- [:happy:]\n\
             > 柚子: [:?smile:] [:happy(width: 2em):] [:#0:]",
        );

        assert!(lowered.markers.is_empty());
        assert_eq!(lowered.diagnostics.len(), 4);
        assert!(
            lowered
                .diagnostics
                .iter()
                .all(|diagnostic| diagnostic.phase == DiagnosticPhase::Semantic)
        );
    }

    #[test]
    fn raw_modes_ignore_markers_and_typst_mode_uses_overlay_context() {
        let lowered = lower(
            "> 柚子: rt\"\"\"[:raw:]\"\"\"\n\
             > T\"\"\"[:#1:] #text(\"[:#2:]\")\"\"\"",
        );

        assert!(lowered.diagnostics.is_empty());
        assert_eq!(lowered.markers.len(), 1);
        assert!(matches!(
            lowered.markers[0].selector,
            ResourceSelector::Sticker {
                variant: VariantSelector::Ordinal(1),
                ..
            }
        ));
    }

    #[test]
    fn validates_resource_render_patch_as_typst_arguments() {
        let lowered = lower("> 柚子: [:happy:](width: )");

        assert_eq!(lowered.markers.len(), 1);
        assert!(
            lowered
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.phase == DiagnosticPhase::Typst)
        );
    }
}
