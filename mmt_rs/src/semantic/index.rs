use std::collections::HashMap;

use crate::inline::{DeclarationValueSyntax, MacroValueSyntax, parse_declaration_value};
use crate::resolve::{ResolvedResourceKind, ResourceResolution};
use crate::source::TextRange;
use crate::syntax::{
    BodyMode, BodyPartSyntax, BodySyntax, DirectiveItemSyntax, SpeakerMarkerSyntax, SyntaxDocument,
    SyntaxNode,
};
use crate::typst_check::scan_typst_overlay_macros;

use super::actor::{ActorId, ActorLowering};
use super::asset::{AssetId, AssetLowering, short_asset_name_range};
use super::resource::{ResourceArgumentReplacement, ResourceLowering, ResourceOccurrenceCandidate};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SemanticSymbolKey {
    Actor(ActorId),
    Asset(AssetId),
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RenameBindingKey {
    ActorName { actor: ActorId, name: String },
    Asset(AssetId),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SemanticOccurrenceRole {
    Definition,
    Reference,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OccurrenceSyntax {
    DeclarationLiteral,
    RawExplicitSpeaker,
    HistoryMarker,
    ResourceMacroArgument {
        value: MacroValueSyntax,
        replacement: ResourceArgumentReplacement,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticOccurrence {
    pub symbol: SemanticSymbolKey,
    pub range: TextRange,
    pub role: SemanticOccurrenceRole,
    pub binding: Option<RenameBindingKey>,
    pub syntax: OccurrenceSyntax,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SemanticIndex {
    occurrences: Vec<SemanticOccurrence>,
    primary_actor_bindings: HashMap<ActorId, RenameBindingKey>,
    native_zones: Vec<TextRange>,
}

impl SemanticIndex {
    pub fn occurrences(&self) -> &[SemanticOccurrence] {
        &self.occurrences
    }

    pub fn symbol_at(&self, offset: usize) -> Option<&SemanticOccurrence> {
        let mut candidates = self
            .occurrences
            .iter()
            .filter(|occurrence| occurrence.range.start <= offset && offset < occurrence.range.end)
            .collect::<Vec<_>>();
        candidates.sort_by_key(|occurrence| occurrence.range.end - occurrence.range.start);
        let selected = candidates.first().copied()?;
        let selected_len = selected.range.end - selected.range.start;
        if candidates
            .iter()
            .skip(1)
            .any(|candidate| candidate.range.end - candidate.range.start == selected_len)
        {
            return None;
        }
        Some(selected)
    }

    pub fn native_zone_at(&self, offset: usize) -> bool {
        self.native_zones
            .iter()
            .any(|range| range.start <= offset && offset < range.end)
    }

    pub fn definition_for(&self, occurrence: &SemanticOccurrence) -> Option<&SemanticOccurrence> {
        let binding = occurrence
            .binding
            .as_ref()
            .or_else(|| match occurrence.symbol {
                SemanticSymbolKey::Actor(actor) => self.primary_actor_bindings.get(&actor),
                SemanticSymbolKey::Asset(_) => None,
            })?;
        self.occurrences.iter().find(|candidate| {
            candidate.role == SemanticOccurrenceRole::Definition
                && candidate.binding.as_ref() == Some(binding)
        })
    }

    pub fn references(
        &self,
        symbol: &SemanticSymbolKey,
        include_declaration: bool,
    ) -> Vec<&SemanticOccurrence> {
        self.occurrences
            .iter()
            .filter(|occurrence| {
                &occurrence.symbol == symbol
                    && (include_declaration
                        || occurrence.role != SemanticOccurrenceRole::Definition)
            })
            .collect()
    }

    pub fn rename_occurrences(&self, binding: &RenameBindingKey) -> Vec<&SemanticOccurrence> {
        self.occurrences
            .iter()
            .filter(|occurrence| occurrence.binding.as_ref() == Some(binding))
            .collect()
    }

    pub fn has_binding(&self, binding: &RenameBindingKey) -> bool {
        self.occurrences.iter().any(|occurrence| {
            occurrence.role == SemanticOccurrenceRole::Definition
                && occurrence.binding.as_ref() == Some(binding)
        })
    }

    pub fn definition_bindings(&self) -> impl Iterator<Item = &RenameBindingKey> {
        self.occurrences.iter().filter_map(|occurrence| {
            (occurrence.role == SemanticOccurrenceRole::Definition)
                .then_some(occurrence.binding.as_ref())
                .flatten()
        })
    }
}

pub(crate) fn build_semantic_index(
    document: &SyntaxDocument,
    actors: &ActorLowering,
    assets: &AssetLowering,
    resources: &ResourceLowering,
    resolution: Option<&ResourceResolution>,
) -> SemanticIndex {
    let mut occurrences = actors.semantic_occurrences.clone();
    occurrences.extend(assets.assets.iter().map(|asset| {
        let symbol = SemanticSymbolKey::Asset(asset.id.clone());
        let binding = RenameBindingKey::Asset(asset.id.clone());
        SemanticOccurrence {
            symbol,
            range: asset.name_range,
            role: SemanticOccurrenceRole::Definition,
            binding: Some(binding),
            syntax: OccurrenceSyntax::DeclarationLiteral,
        }
    }));

    for candidate in &resources.semantic_occurrences {
        match candidate {
            ResourceOccurrenceCandidate::Actor {
                actor,
                name,
                range,
                value,
                replacement,
                ..
            } => occurrences.push(SemanticOccurrence {
                symbol: SemanticSymbolKey::Actor(*actor),
                range: *range,
                role: SemanticOccurrenceRole::Reference,
                binding: actors.rename_binding(*actor, name),
                syntax: OccurrenceSyntax::ResourceMacroArgument {
                    value: value.clone(),
                    replacement: replacement.clone(),
                },
            }),
            ResourceOccurrenceCandidate::Asset {
                name,
                range,
                marker_range,
                value,
                replacement,
            } => {
                let id = assets
                    .resolve(name)
                    .map(|asset| asset.id.clone())
                    .or_else(|| {
                        resolution.and_then(|resolution| {
                            resolution.resources.iter().find_map(|resource| {
                                if resource.range != *marker_range {
                                    return None;
                                }
                                match &resource.kind {
                                    ResolvedResourceKind::PackAsset { name, source } => {
                                        Some(AssetId {
                                            namespace: source.pack_namespace.clone(),
                                            name: name.clone(),
                                        })
                                    }
                                    _ => None,
                                }
                            })
                        })
                    });
                let Some(id) = id else {
                    continue;
                };
                let binding = assets
                    .resolve(name)
                    .map(|_| RenameBindingKey::Asset(id.clone()));
                occurrences.push(SemanticOccurrence {
                    symbol: SemanticSymbolKey::Asset(id),
                    range: *range,
                    role: SemanticOccurrenceRole::Reference,
                    binding,
                    syntax: OccurrenceSyntax::ResourceMacroArgument {
                        value: value.clone(),
                        replacement: replacement.clone(),
                    },
                });
            }
        }
    }

    occurrences.sort_by_key(|occurrence| {
        (
            occurrence.range.start,
            occurrence.range.end,
            match occurrence.role {
                SemanticOccurrenceRole::Definition => 0,
                SemanticOccurrenceRole::Reference => 1,
            },
        )
    });
    let primary_actor_bindings = actors
        .actors
        .iter()
        .filter_map(|actor| {
            let binding = RenameBindingKey::ActorName {
                actor: actor.id,
                name: actor.primary_name.clone(),
            };
            occurrences
                .iter()
                .any(|occurrence| {
                    occurrence.role == SemanticOccurrenceRole::Definition
                        && occurrence.binding.as_ref() == Some(&binding)
                })
                .then_some((actor.id, binding))
        })
        .collect();
    let mut native_zones = semantic_native_zones(document);
    native_zones.extend(occurrences.iter().map(|occurrence| occurrence.range));
    native_zones.sort_by_key(|range| (range.start, range.end));
    native_zones.dedup();

    SemanticIndex {
        occurrences,
        primary_actor_bindings,
        native_zones,
    }
}

fn semantic_native_zones(document: &SyntaxDocument) -> Vec<TextRange> {
    let mut ranges = Vec::new();
    for node in &document.nodes {
        match node {
            SyntaxNode::Statement(statement) => {
                if let Some(marker) = &statement.marker {
                    ranges.push(match marker {
                        SpeakerMarkerSyntax::Explicit { range, .. }
                        | SpeakerMarkerSyntax::BackRef { range, .. }
                        | SpeakerMarkerSyntax::UniqueIndex { range, .. } => *range,
                    });
                }
                body_native_zones(&statement.body, &mut ranges);
            }
            SyntaxNode::DirectiveLine(line) => {
                if line.name == "asset" {
                    ranges.extend(short_asset_name_range(line));
                }
                if let Some(body) = &line.payload {
                    body_native_zones(body, &mut ranges);
                }
            }
            SyntaxNode::DirectiveBlock(block) => {
                if matches!(block.name.as_str(), "actor" | "asset") {
                    ranges.extend(block.head_args.first().map(|argument| argument.range));
                }
                if block.name == "actor" {
                    for item in &block.items {
                        let DirectiveItemSyntax::Field(field) = item else {
                            continue;
                        };
                        if field.name != "also-as" {
                            continue;
                        }
                        let parsed = parse_declaration_value(&field.value, field.value_range.start);
                        match parsed.value {
                            Some(DeclarationValueSyntax::Scalar(literal)) => {
                                ranges.push(literal.range);
                            }
                            Some(DeclarationValueSyntax::List { items, .. }) => {
                                ranges.extend(items.into_iter().map(|literal| literal.range));
                            }
                            None => {}
                        }
                    }
                }
                for item in &block.items {
                    if let DirectiveItemSyntax::Body(body) = item {
                        body_native_zones(body, &mut ranges);
                    }
                }
            }
            SyntaxNode::Reply(reply) => {
                for body in &reply.items {
                    body_native_zones(body, &mut ranges);
                }
            }
            SyntaxNode::Bond(bond) => body_native_zones(&bond.body, &mut ranges),
            SyntaxNode::Blank(_) | SyntaxNode::Error(_) => {}
        }
    }
    ranges
}

fn body_native_zones(body: &BodySyntax, ranges: &mut Vec<TextRange>) {
    for part in &body.parts {
        if let BodyPartSyntax::InlineMacro(marker) = part {
            ranges.extend(marker.args.iter().map(|argument| argument.range));
        }
    }
    if body.mode == BodyMode::TypstMacro {
        let scan = scan_typst_overlay_macros(&body.source, body.range);
        for marker in scan.macros {
            ranges.extend(marker.args.into_iter().map(|argument| argument.range));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::semantic::{CharacterPreset, StaticPresetCatalog};

    fn catalog() -> StaticPresetCatalog {
        StaticPresetCatalog::new(vec![CharacterPreset {
            id: "ba::柚子".to_string(),
            names: vec!["柚子".to_string()],
            display_name: None,
            avatar: None,
        }])
    }
    #[test]
    fn symbol_at_rejects_equal_smallest_ranges() {
        let range = TextRange::new(1, 4);
        let occurrence = |name: &str| SemanticOccurrence {
            symbol: SemanticSymbolKey::Asset(AssetId {
                namespace: "custom".to_string(),
                name: name.to_string(),
            }),
            range,
            role: SemanticOccurrenceRole::Reference,
            binding: None,
            syntax: OccurrenceSyntax::HistoryMarker,
        };
        let index = SemanticIndex {
            occurrences: vec![occurrence("a"), occurrence("b")],
            primary_actor_bindings: HashMap::new(),
            native_zones: Vec::new(),
        };

        assert!(index.symbol_at(2).is_none());
    }

    #[test]
    fn actor_alias_history_resource_and_script_asset_occurrences_keep_resolved_identity() {
        let source = "@actor main\n\
                      preset: ba::柚子\n\
                      also-as: [alias]\n\
                      @end\n\
                      @actor alias\n\
                      display-name: Alias\n\
                      @end\n\
                      > main: one\n\
                      > alias: [:main, happy:]\n\
                      > 柚子: other\n\
                      > _: history\n\
                      > ~1: unique\n\
                      @asset: hero src:hero.png\n\
                      - [:asset, hero:]\n\
                      - [:asset::hero:]";
        let analysis = crate::analyze_text(source, &catalog());
        assert!(analysis.document.diagnostics.is_empty());
        assert!(
            analysis.actors.diagnostics.is_empty(),
            "{:?}",
            analysis.actors.diagnostics
        );
        assert!(
            analysis.assets.diagnostics.is_empty(),
            "{:?}",
            analysis.assets.diagnostics
        );
        assert!(
            analysis.resource_markers.diagnostics.is_empty(),
            "{:?}",
            analysis.resource_markers.diagnostics
        );

        let alias_speaker = source.rfind("> alias:").unwrap() + 3;
        let alias_occurrence = analysis.semantic_index.symbol_at(alias_speaker).unwrap();
        let alias_definition = analysis
            .semantic_index
            .definition_for(alias_occurrence)
            .unwrap();
        assert_eq!(
            &source[alias_definition.range.start..alias_definition.range.end],
            "alias"
        );
        let binding = alias_occurrence.binding.as_ref().unwrap();
        let alias_edits = analysis.semantic_index.rename_occurrences(binding);
        assert_eq!(alias_edits.len(), 3);
        assert!(alias_edits.iter().all(|occurrence| {
            &source[occurrence.range.start..occurrence.range.end] == "alias"
        }));

        let history_offset = source.find("> _:").unwrap() + 2;
        let history = analysis.semantic_index.symbol_at(history_offset).unwrap();
        assert!(history.binding.is_none());
        let primary = analysis.semantic_index.definition_for(history).unwrap();
        assert_eq!(&source[primary.range.start..primary.range.end], "main");

        let unique_offset = source.find("> ~1:").unwrap() + 2;
        let unique = analysis.semantic_index.symbol_at(unique_offset).unwrap();
        assert!(unique.binding.is_none());
        assert_eq!(unique.symbol, history.symbol);

        let resource_subject_offset = source.find("[:main").unwrap() + 2;
        let resource_subject = analysis
            .semantic_index
            .symbol_at(resource_subject_offset)
            .unwrap();
        assert_eq!(resource_subject.symbol, history.symbol);
        assert_eq!(resource_subject.binding, primary.binding);
        assert!(matches!(
            resource_subject.syntax,
            OccurrenceSyntax::ResourceMacroArgument { .. }
        ));

        let asset_definition_offset = source.find("hero src:").unwrap();
        let asset_definition = analysis
            .semantic_index
            .symbol_at(asset_definition_offset)
            .unwrap();
        let asset_references = analysis
            .semantic_index
            .references(&asset_definition.symbol, false);
        assert_eq!(asset_references.len(), 2);
        assert_eq!(
            analysis
                .semantic_index
                .rename_occurrences(asset_definition.binding.as_ref().unwrap())
                .len(),
            3
        );
    }

    #[test]
    fn pack_asset_occurrence_is_read_only() {
        let manifest = crate::pack::PackManifest::from_json(
            r#"{
              "schema":"mmt-pack.v3",
              "pack":{"namespace":"ba","name":"BA","version":"1","type":"base"},
              "assets":{"logo":{"source":{"storage":"images","path":"logo.png"}}},
              "storage":{"images":{"kind":"image-dir","base":"images"}}
            }"#,
        )
        .unwrap();
        let packs = crate::pack::PackRegistry::new(vec![manifest]).unwrap();
        let source = "- [:asset::logo:]";
        let analysis = crate::analyze_text_with_pack(source, &packs);
        let offset = source.find("asset::logo").unwrap() + "asset::".len();
        let occurrence = analysis.semantic_index.symbol_at(offset).unwrap();

        assert_eq!(
            occurrence.symbol,
            SemanticSymbolKey::Asset(AssetId {
                namespace: "ba".to_string(),
                name: "logo".to_string(),
            })
        );
        assert!(occurrence.binding.is_none());
        assert!(analysis.semantic_index.definition_for(occurrence).is_none());
        assert_eq!(
            analysis
                .semantic_index
                .references(&occurrence.symbol, true)
                .len(),
            1
        );
    }

    #[test]
    fn lazy_pack_actor_reference_has_no_authored_binding() {
        let source = "> 柚子: hello";
        let analysis = crate::analyze_text(source, &catalog());
        let offset = source.find("柚子").unwrap();
        let occurrence = analysis.semantic_index.symbol_at(offset).unwrap();

        assert!(matches!(occurrence.symbol, SemanticSymbolKey::Actor(_)));
        assert!(occurrence.binding.is_none());
        assert!(analysis.semantic_index.definition_for(occurrence).is_none());
    }

    #[test]
    fn builtin_and_omitted_speakers_do_not_create_occurrences() {
        let source = "< builtin fallback\n\
                      @actor main\n\
                      preset: ba::柚子\n\
                      @end\n\
                      > main: explicit\n\
                      > omitted";
        let analysis = crate::analyze_text(source, &catalog());
        assert!(analysis.actors.diagnostics.is_empty());
        let slices = analysis
            .semantic_index
            .occurrences()
            .iter()
            .map(|occurrence| &source[occurrence.range.start..occurrence.range.end])
            .collect::<Vec<_>>();

        assert_eq!(slices, vec!["main", "main"]);
    }

    #[test]
    fn native_zones_cover_unresolved_semantic_syntax_without_claiming_typst_body() {
        let source = "@actor missing\n\
                      unknown: field\n\
                      @end\n\
                      > unresolved: hello\n\
                      @asset: broken src:../bad.png\n\
                      - [:asset, unknown:]\n\
                      - T\"\"\"#let projected = 1\"\"\"";
        let analysis = crate::analyze_text(source, &catalog());
        for needle in ["missing", "unresolved", "broken", "unknown:]"] {
            let offset = source.find(needle).unwrap();
            assert!(
                analysis.semantic_index.native_zone_at(offset),
                "{needle} must remain owned by native semantic routing"
            );
        }
        let typst_offset = source.find("projected").unwrap();
        assert!(!analysis.semantic_index.native_zone_at(typst_offset));
    }
}
