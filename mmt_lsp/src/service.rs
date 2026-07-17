use std::{collections::HashMap, sync::Arc};

use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionTextEdit, Diagnostic,
    DiagnosticRelatedInformation, DiagnosticSeverity, DocumentSymbol, FoldingRange,
    FoldingRangeKind, Hover, HoverContents, Location, MarkupContent, MarkupKind,
    ParameterInformation, ParameterLabel, Position, PositionEncodingKind, SemanticToken,
    SemanticTokens, SignatureHelp, SignatureInformation, SymbolKind, TextEdit, Url,
};
use mmt_rs::diag::{Diagnostic as MmtDiagnostic, Severity};
use mmt_rs::pack::{PackManifest, PackRegistry};
use mmt_rs::source::TextRange;
use mmt_rs::syntax::{
    DirectiveItemSyntax, SpeakerMarkerSyntax, StatementKind, SyntaxDocument, SyntaxNode,
};
use mmt_rs::{
    AnalyzedDocument, DocumentTimezone, EmitOptions, ResolvedResourceKind, SpeakerIdentity,
    StaticPresetCatalog, diagnose_analyzed, diagnose_analyzed_with_pack,
};

use crate::position::LineIndex;

#[derive(Debug, Clone)]
pub struct DocumentSnapshot {
    pub version: i32,
    pub revision: u64,
    pub text: String,
    pub analysis: Arc<AnalyzedDocument>,
    pub lines: Arc<LineIndex>,
    pub pack_revision: Option<u64>,
}

impl DocumentSnapshot {
    fn new(
        version: i32,
        revision: u64,
        text: String,
        analysis: AnalyzedDocument,
        pack_revision: Option<u64>,
    ) -> Self {
        let lines = Arc::new(LineIndex::new(&text));
        Self {
            version,
            revision,
            text,
            analysis: Arc::new(analysis),
            lines,
            pack_revision,
        }
    }
}

#[derive(Debug)]
pub struct LanguageService {
    documents: HashMap<Url, DocumentSnapshot>,
    next_revision: u64,
    encoding: PositionEncodingKind,
    pack_revision: u64,
    pack_registry: Option<PackRegistry>,
    pack_base_urls: HashMap<String, Url>,
    analysis_builds: u64,
    authored_line_index_builds: u64,
}

impl Default for LanguageService {
    fn default() -> Self {
        Self {
            documents: HashMap::new(),
            next_revision: 1,
            encoding: PositionEncodingKind::UTF16,
            pack_revision: 0,
            pack_registry: None,
            pack_base_urls: HashMap::new(),
            analysis_builds: 0,
            authored_line_index_builds: 0,
        }
    }
}

impl LanguageService {
    pub fn set_encoding(&mut self, encoding: PositionEncodingKind) {
        self.encoding = encoding;
    }

    pub fn encoding(&self) -> &PositionEncodingKind {
        &self.encoding
    }

    pub fn update_pack_manifests(
        &mut self,
        revision: u64,
        sources: &[String],
    ) -> Result<bool, String> {
        if revision <= self.pack_revision {
            return Ok(false);
        }
        let manifests = sources
            .iter()
            .enumerate()
            .map(|(index, source)| {
                PackManifest::from_json(source)
                    .map_err(|error| format!("pack manifest {index} is invalid JSON: {error}"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let registry = PackRegistry::new(manifests).map_err(|errors| {
            errors
                .into_iter()
                .map(|error| error.message)
                .collect::<Vec<_>>()
                .join("; ")
        })?;
        for document in self.documents.values_mut() {
            document.analysis = Arc::new(mmt_rs::analyze_text_with_pack(&document.text, &registry));
            document.pack_revision = Some(revision);
            self.analysis_builds += 1;
        }
        self.pack_registry = Some(registry);
        self.pack_revision = revision;
        Ok(true)
    }

    pub fn set_pack_base_urls(
        &mut self,
        revision: u64,
        mut base_urls: HashMap<String, Url>,
    ) -> bool {
        if revision != self.pack_revision {
            return false;
        }
        base_urls.retain(|_, url| url.scheme() == "https");
        self.pack_base_urls = base_urls;
        true
    }

    pub fn pack_revision(&self) -> u64 {
        self.pack_revision
    }

    pub fn pack_registry(&self) -> Option<&PackRegistry> {
        self.pack_registry.as_ref()
    }

    pub fn document_uris(&self) -> Vec<Url> {
        self.documents.keys().cloned().collect()
    }

    pub fn open(&mut self, uri: Url, version: i32, text: String) -> &DocumentSnapshot {
        self.upsert(uri, version, text)
    }

    pub fn change(&mut self, uri: Url, version: i32, text: String) -> Option<&DocumentSnapshot> {
        if self
            .documents
            .get(&uri)
            .is_some_and(|document| version <= document.version)
        {
            return None;
        }
        Some(self.upsert(uri, version, text))
    }

    fn upsert(&mut self, uri: Url, version: i32, text: String) -> &DocumentSnapshot {
        let revision = self.next_revision;
        self.next_revision += 1;
        let (analysis, pack_revision) = if let Some(registry) = &self.pack_registry {
            (
                mmt_rs::analyze_text_with_pack(&text, registry),
                Some(self.pack_revision),
            )
        } else {
            (
                mmt_rs::analyze_text(&text, &StaticPresetCatalog::default()),
                None,
            )
        };
        self.analysis_builds += 1;
        self.authored_line_index_builds += 1;
        self.documents.insert(
            uri.clone(),
            DocumentSnapshot::new(version, revision, text, analysis, pack_revision),
        );
        &self.documents[&uri]
    }

    pub fn close(&mut self, uri: &Url) {
        self.documents.remove(uri);
    }

    pub fn snapshot(&self, uri: &Url) -> Option<&DocumentSnapshot> {
        self.documents.get(uri)
    }

    pub fn diagnostics(&self, uri: &Url) -> Vec<Diagnostic> {
        let Some(document) = self.snapshot(uri) else {
            return Vec::new();
        };
        let diagnostics = if document.pack_revision.is_some() {
            diagnose_analyzed_with_pack(&document.analysis, &EmitOptions::default()).expect(
                "document with a pack revision must contain pack resource analysis",
            )
        } else {
            diagnose_analyzed(&document.analysis, &EmitOptions::default())
        };
        diagnostics
            .iter()
            .filter_map(|diagnostic| self.diagnostic(uri, document, diagnostic))
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn analysis_cache_counts(&self) -> (u64, u64) {
        (self.analysis_builds, self.authored_line_index_builds)
    }

    fn diagnostic(
        &self,
        uri: &Url,
        document: &DocumentSnapshot,
        diagnostic: &MmtDiagnostic,
    ) -> Option<Diagnostic> {
        let range = document.lines.range(
            &document.text,
            diagnostic.range.unwrap_or(TextRange::empty(0)),
            &self.encoding,
        )?;
        let related_information = diagnostic
            .labels
            .iter()
            .filter_map(|label| {
                Some(DiagnosticRelatedInformation {
                    location: Location {
                        uri: uri.clone(),
                        range: document
                            .lines
                            .range(&document.text, label.range, &self.encoding)?,
                    },
                    message: label
                        .message
                        .clone()
                        .unwrap_or_else(|| "related location".to_string()),
                })
            })
            .collect::<Vec<_>>();
        Some(Diagnostic {
            range,
            severity: Some(match diagnostic.severity {
                Severity::Error => DiagnosticSeverity::ERROR,
                Severity::Warning => DiagnosticSeverity::WARNING,
                Severity::Info => DiagnosticSeverity::INFORMATION,
            }),
            code: None,
            code_description: None,
            source: Some("mmt".to_string()),
            message: diagnostic.message.clone(),
            related_information: (!related_information.is_empty()).then_some(related_information),
            tags: None,
            data: Some(serde_json::json!({ "phase": diagnostic.phase })),
        })
    }

    pub fn document_symbols(&self, uri: &Url) -> Vec<DocumentSymbol> {
        let Some(document) = self.snapshot(uri) else {
            return Vec::new();
        };
        document.analysis.document
            .nodes
            .iter()
            .filter_map(|node| self.symbol(document, node))
            .collect()
    }

    #[allow(deprecated)]
    fn symbol(&self, document: &DocumentSnapshot, node: &SyntaxNode) -> Option<DocumentSymbol> {
        let (name, detail, kind, range, selection) = match node {
            SyntaxNode::DirectiveBlock(block) => {
                let subject = block.head_args.first().map(|arg| arg.raw.as_str());
                let name = subject
                    .map(|subject| format!("@{} {subject}", block.name))
                    .unwrap_or_else(|| format!("@{}", block.name));
                let kind = match block.name.as_str() {
                    "actor" => SymbolKind::CLASS,
                    "asset" => SymbolKind::VARIABLE,
                    "typ" => SymbolKind::NAMESPACE,
                    _ => SymbolKind::OBJECT,
                };
                (
                    name,
                    Some("directive block".to_string()),
                    kind,
                    block.range,
                    block.name_range,
                )
            }
            SyntaxNode::Reply(reply) => (
                "@reply".to_string(),
                Some(format!("{} item(s)", reply.items.len())),
                SymbolKind::EVENT,
                reply.range,
                reply.range,
            ),
            SyntaxNode::Bond(bond) => (
                "@bond".to_string(),
                None,
                SymbolKind::EVENT,
                bond.range,
                bond.range,
            ),
            _ => return None,
        };
        Some(DocumentSymbol {
            name,
            detail,
            kind,
            tags: None,
            deprecated: None,
            range: document
                .lines
                .range(&document.text, range, &self.encoding)?,
            selection_range: document
                .lines
                .range(&document.text, selection, &self.encoding)?,
            children: None,
        })
    }

    pub fn folding_ranges(&self, uri: &Url) -> Vec<FoldingRange> {
        let Some(document) = self.snapshot(uri) else {
            return Vec::new();
        };
        document.analysis.document
            .nodes
            .iter()
            .filter_map(|node| self.folding_range(document, node))
            .collect()
    }
    pub fn semantic_tokens(&self, uri: &Url) -> Option<SemanticTokens> {
        let document = self.snapshot(uri)?;
        let mut ranges = Vec::<(TextRange, u32)>::new();
        for node in &document.analysis.document.nodes {
            match node {
                SyntaxNode::DirectiveLine(directive) => ranges.push((directive.name_range, 0)),
                SyntaxNode::DirectiveBlock(block) => {
                    ranges.push((block.name_range, 0));
                    if block.name == "document" {
                        for item in &block.items {
                            let DirectiveItemSyntax::Field(field) = item else {
                                continue;
                            };
                            ranges.push((field.name_range, 3));
                            let value = field.value.trim();
                            let is_enum = match field.name.as_str() {
                                "show-header" => matches!(value, "true" | "false"),
                                "compiled-at" => value == "auto",
                                "timezone" => value.parse::<DocumentTimezone>().is_ok(),
                                _ => false,
                            };
                            if is_enum {
                                ranges.push((field.value_range, 2));
                            }
                        }
                    }
                }
                SyntaxNode::Statement(statement) => {
                    if let Some(marker) = &statement.marker {
                        let range = match marker {
                            SpeakerMarkerSyntax::Explicit { range, .. }
                            | SpeakerMarkerSyntax::BackRef { range, .. }
                            | SpeakerMarkerSyntax::UniqueIndex { range, .. } => *range,
                        };
                        ranges.push((range, 1));
                    }
                }
                SyntaxNode::Reply(reply) => {
                    ranges.push((TextRange::new(reply.range.start, reply.range.start + 6), 0));
                }
                SyntaxNode::Bond(bond) => {
                    ranges.push((TextRange::new(bond.range.start, bond.range.start + 5), 0));
                }
                _ => {}
            }
        }
        for marker in &document.analysis.resource_markers.markers {
            let marker_end = marker
                .render_patch
                .as_ref()
                .map_or(marker.range.end, |patch| patch.range.start);
            if marker_end >= marker.range.start + 4 {
                ranges.push((TextRange::new(marker.range.start + 2, marker_end - 2), 2));
            }
        }
        ranges.sort_by_key(|(range, _)| range.start);

        let mut previous_line = 0;
        let mut previous_start = 0;
        let mut data = Vec::with_capacity(ranges.len());
        for (range, token_type) in ranges {
            let mapped = document
                .lines
                .range(&document.text, range, &self.encoding)?;
            if mapped.start.line != mapped.end.line || mapped.start == mapped.end {
                continue;
            }
            let delta_line = mapped.start.line - previous_line;
            let delta_start = if delta_line == 0 {
                mapped.start.character - previous_start
            } else {
                mapped.start.character
            };
            data.push(SemanticToken {
                delta_line,
                delta_start,
                length: mapped.end.character - mapped.start.character,
                token_type,
                token_modifiers_bitset: 0,
            });
            previous_line = mapped.start.line;
            previous_start = mapped.start.character;
        }
        Some(SemanticTokens {
            result_id: None,
            data,
        })
    }

    pub fn completions(&self, uri: &Url, position: Position) -> Vec<CompletionItem> {
        let Some(document) = self.snapshot(uri) else {
            return Vec::new();
        };
        let Some(offset) = document
            .lines
            .offset(&document.text, position, &self.encoding)
        else {
            return Vec::new();
        };
        let line_start = document.text[..offset]
            .rfind('\n')
            .map_or(0, |newline| newline + 1);
        let before_cursor = &document.text[line_start..offset];
        let trimmed = before_cursor.trim_start();

        if let Some((contract, patch)) = facade_patch_at(&document.analysis.document, offset) {
            let prefix = &document.text[patch.args_range.start..offset];
            let context = patch_context(prefix);
            if context.depth == 0 && !context.has_colon {
                let segment = &prefix[context.segment_start..];
                let leading = segment.len() - segment.trim_start().len();
                let replace_start = patch.args_range.start + context.segment_start + leading;
                return completion_items(
                    document,
                    &self.encoding,
                    replace_start,
                    offset,
                    contract.parameters,
                    CompletionItemKind::FIELD,
                );
            }
        }

        if let Some(value_prefix) = trimmed.strip_prefix("@mode:") {
            let replace_start = offset - value_prefix.trim_start().len();
            return completion_items(
                document,
                &self.encoding,
                replace_start,
                offset,
                &[
                    ("t", "text with inline macro expansion"),
                    ("text", "text with inline macro expansion"),
                    ("T", "Typst markup with inline macro expansion"),
                    ("typst", "Typst markup with inline macro expansion"),
                    ("rt", "raw text without inline macro expansion"),
                    ("raw-text", "raw text without inline macro expansion"),
                    ("rT", "raw Typst without inline macro expansion"),
                    ("raw-typst", "raw Typst without inline macro expansion"),
                ],
                CompletionItemKind::VALUE,
            );
        }

        let statement_start = line_start + before_cursor.len() - trimmed.len();
        let statement_patch = document.analysis.document.nodes.iter().find_map(|node| match node {
            SyntaxNode::Statement(statement) if statement.range.start == statement_start => {
                statement.patch.as_ref().map(|patch| patch.range)
            }
            _ => None,
        });
        if let Some(speaker_prefix) =
            statement_speaker_prefix(trimmed, statement_start, offset, statement_patch)
        {
            let replace_start = offset - speaker_prefix.len();
            return self.speaker_completions(document, replace_start, offset);
        }

        if trimmed.starts_with('@') && !trimmed.chars().any(char::is_whitespace) {
            let replace_start = line_start + before_cursor.len() - trimmed.len();
            return completion_items(
                document,
                &self.encoding,
                replace_start,
                offset,
                &[
                    ("@actor", "open or create a script actor"),
                    ("@asset", "declare a script-local asset"),
                    ("@document", DOCUMENT_DIRECTIVE_DESCRIPTION),
                    ("@mode", "change the following content mode"),
                    ("@typ", TYP_DIRECTIVE_DESCRIPTION),
                    ("@reply", "render reply options"),
                    ("@bond", "render a bond event"),
                    ("@end", "close the current block"),
                ],
                CompletionItemKind::KEYWORD,
            );
        }

        if let Some(marker_start) = before_cursor.rfind("[:") {
            let marker_prefix = &before_cursor[marker_start + 2..];
            if !marker_prefix.contains(":]") {
                let inferred_subject = self.resource_speaker_subject(document, offset);
                if let Some((head, value)) = marker_prefix.split_once(',') {
                    let value_prefix = value.trim_start();
                    let replace_start = offset - value_prefix.len();
                    let head = head.trim();
                    match head {
                        "asset" => {
                            return self.resource_completions(
                                document,
                                replace_start,
                                offset,
                                Some("asset"),
                            );
                        }
                        "sticker" => {
                            return self.resource_completions(
                                document,
                                replace_start,
                                offset,
                                inferred_subject.as_deref(),
                            );
                        }
                        "tmp" | "file" | "url" => return Vec::new(),
                        _ => {
                            let actor_subject = self.resource_actor_subject(document, head);
                            return self.resource_completions(
                                document,
                                replace_start,
                                offset,
                                Some(actor_subject.as_deref().unwrap_or(head)),
                            );
                        }
                    }
                }
                let replace_start = offset - marker_prefix.len();
                let mut items = self.resource_completions(document, replace_start, offset, None);
                if let Some(subject) = inferred_subject.as_deref() {
                    items.extend(self.resource_completions(
                        document,
                        replace_start,
                        offset,
                        Some(subject),
                    ));
                    items.sort_by(|left, right| left.label.cmp(&right.label));
                    items.dedup_by(|left, right| left.label == right.label);
                }
                return items;
            }
        }

        let Some(block) = document.analysis.document.nodes.iter().find_map(|node| match node {
            SyntaxNode::DirectiveBlock(block)
                if block.range.start <= offset && offset <= block.range.end =>
            {
                Some(block)
            }
            _ => None,
        }) else {
            return Vec::new();
        };
        let block_name = block.name.as_str();
        if block_name == "actor"
            && let Some((field, value_prefix)) = trimmed.split_once(':')
            && field.trim() == "preset"
        {
            let replace_start = offset - value_prefix.trim_start().len();
            return self.preset_completions(document, replace_start, offset);
        }
        if block_name == "document"
            && let Some((field, value_prefix)) = trimmed.split_once(':')
        {
            let values: &[(&str, &str)] = match field.trim() {
                "show-header" => &[
                    ("true", "show the document title bar"),
                    ("false", "hide the document title bar"),
                ],
                "compiled-at" => &[("auto", "format the host-provided compilation instant")],
                "compiled-at-format" => &[(
                    "\"[year]-[month]-[day] [hour]:[minute]:[second]\"",
                    "default Rust time format description",
                )],
                "timezone" => &[
                    ("local", "use the host local UTC offset"),
                    ("utc", "use UTC"),
                    ("Z", "use UTC"),
                    ("+08:00", "fixed UTC offset; edit HH:MM as needed"),
                ],
                _ => &[],
            };
            if !values.is_empty() {
                let replace_start = offset - value_prefix.trim_start().len();
                return completion_items(
                    document,
                    &self.encoding,
                    replace_start,
                    offset,
                    values,
                    CompletionItemKind::VALUE,
                );
            }
        }
        // Once a field separator is present, the cursor is in the value. Resource
        // and Typst-aware backends own completion there; field names must not
        // replace a partially written selector such as `ba::...`.
        if before_cursor.contains(':') {
            return Vec::new();
        }
        let fields: &[(&str, &str)] = match block_name {
            "actor" => &[
                (
                    "preset",
                    "read-only character preset used when creating the actor",
                ),
                ("display-name", "name shown by the renderer"),
                ("avatar", "avatar used by following messages"),
                ("also-as", "additional writable names for this actor"),
            ],
            "asset" => &[
                ("src", "required asset source"),
                ("ns", "asset namespace; defaults to custom"),
            ],
            "document" => DOCUMENT_FIELDS,
            _ => return Vec::new(),
        };
        let token_start = offset
            - before_cursor
                .chars()
                .rev()
                .take_while(|ch| ch.is_alphanumeric() || *ch == '-')
                .map(char::len_utf8)
                .sum::<usize>();
        let mut items = completion_items(
            document,
            &self.encoding,
            token_start,
            offset,
            fields,
            CompletionItemKind::FIELD,
        );
        if block_name == "document" {
            items.retain(|completion| {
                !block.items.iter().any(|item| {
                    matches!(
                        item,
                        DirectiveItemSyntax::Field(field) if field.name == completion.label
                    )
                })
            });
        }
        items
    }

    pub fn hover(&self, uri: &Url, position: Position) -> Option<Hover> {
        let document = self.snapshot(uri)?;
        let offset = document
            .lines
            .offset(&document.text, position, &self.encoding)?;

        if let Some((statement, marker, marker_range)) =
            document.analysis.document.nodes.iter().find_map(|node| {
                let SyntaxNode::Statement(statement) = node else {
                    return None;
                };
                let marker = statement.marker.as_ref()?;
                let marker_range = match marker {
                    SpeakerMarkerSyntax::Explicit { range, .. }
                    | SpeakerMarkerSyntax::BackRef { range, .. }
                    | SpeakerMarkerSyntax::UniqueIndex { range, .. } => *range,
                };
                (marker_range.start <= offset && offset < marker_range.end).then_some((
                    statement,
                    marker,
                    marker_range,
                ))
            })
        {
            let actors = &document.analysis.actors;
            let speaker = actors
                .speakers
                .iter()
                .find(|speaker| speaker.statement_range == statement.range)?;
            let SpeakerIdentity::Actor(actor_id) = speaker.speaker else {
                return None;
            };
            let actor = actors.actors.iter().find(|actor| actor.id == actor_id)?;
            let revision = actor
                .revisions
                .iter()
                .find(|revision| Some(revision.number) == speaker.revision)?;
            let mut value = format!(
                "**{}**\n\nActor {} · preset {} · revision {}",
                markdown_text(&revision.state.display_name),
                markdown_code(&actor.primary_name),
                markdown_code(&actor.preset_id),
                revision.number,
            );
            if !matches!(marker, SpeakerMarkerSyntax::Explicit { .. }) {
                value.push_str(&format!(
                    "\n\nReference {} → {}",
                    markdown_code(&document.text[marker_range.start..marker_range.end]),
                    markdown_code(&revision.state.display_name),
                ));
            }
            if let Some(avatar) = &revision.state.avatar {
                value.push_str(&format!("\n\nAvatar {}", markdown_code(avatar)));
            }
            if let Some(url) = revision
                .state
                .avatar
                .as_deref()
                .and_then(|avatar| self.avatar_preview_url(avatar))
            {
                value.push_str(&format!("\n\n![Actor avatar]({url})"));
            }
            let range = document
                .lines
                .range(&document.text, marker_range, &self.encoding)?;
            return Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value,
                }),
                range: Some(range),
            });
        }

        if let Some((hover_range, value)) =
            directive_hover_at(&document.analysis.document, &document.text, offset)
        {
            let range = document
                .lines
                .range(&document.text, hover_range, &self.encoding)?;
            return Some(Hover {
                contents: HoverContents::Markup(MarkupContent {
                    kind: MarkupKind::Markdown,
                    value,
                }),
                range: Some(range),
            });
        }

        if let Some(resolution) = &document.analysis.resolution {
            if let Some(resource) = resolution
                .resources
                .iter()
                .find(|resource| resource.range.start <= offset && offset < resource.range.end)
            {
                let range = document
                    .lines
                    .range(&document.text, resource.range, &self.encoding)?;
                return Some(Hover {
                    contents: HoverContents::Markup(MarkupContent {
                        kind: MarkupKind::Markdown,
                        value: resource_hover_markdown(
                            &document.text[resource.range.start..resource.range.end],
                            &resource.kind,
                        ),
                    }),
                    range: Some(range),
                });
            }
        }

        let (contract, marker_range) = facade_marker_at(&document.analysis.document, offset)?;
        let range = document
            .lines
            .range(&document.text, marker_range, &self.encoding)?;
        Some(Hover {
            contents: HoverContents::Markup(MarkupContent {
                kind: MarkupKind::Markdown,
                value: format!(
                    "```typst\n{}\n```\n\n{}",
                    contract.signature, contract.summary
                ),
            }),
            range: Some(range),
        })
    }

    fn avatar_preview_url(&self, avatar: &str) -> Option<Url> {
        let (entity_id, variant) = avatar.split_once("/avatar/")?;
        let registry = self.pack_registry.as_ref()?;
        let resolved = registry.resolve_avatar(entity_id, None, variant).ok()?;
        let storage = registry.storage(&resolved.storage_pack_namespace, &resolved.storage_id)?;
        if storage.kind != "image-dir" {
            return None;
        }
        let path = resolved.path.as_deref()?;
        let mut url = self
            .pack_base_urls
            .get(&resolved.storage_pack_namespace)?
            .clone();
        if let Some(base) = storage.base.as_deref() {
            url = url.join(&format!("{}/", base.trim_end_matches('/'))).ok()?;
        }
        url.join(path).ok()
    }

    fn sticker_preview_documentation(
        &self,
        manifest: &PackManifest,
        resource_id: &str,
    ) -> Option<lsp_types::Documentation> {
        let thumbnail = manifest.thumbnails.get(resource_id)?;
        let storage = manifest.storage.get(&thumbnail.storage)?;
        if storage.kind != "image-dir" {
            return None;
        }
        let mut url = self.pack_base_urls.get(&manifest.pack.namespace)?.clone();
        if let Some(base) = storage.base.as_deref() {
            url = url.join(&format!("{}/", base.trim_end_matches('/'))).ok()?;
        }
        let url = url.join(&thumbnail.path).ok()?;
        Some(lsp_types::Documentation::MarkupContent(MarkupContent {
            kind: MarkupKind::Markdown,
            value: format!("![Sticker preview]({url})"),
        }))
    }

    pub fn signature_help(&self, uri: &Url, position: Position) -> Option<SignatureHelp> {
        let document = self.snapshot(uri)?;
        let offset = document
            .lines
            .offset(&document.text, position, &self.encoding)?;
        let (contract, patch) = facade_patch_at(&document.analysis.document, offset)?;
        let context = patch_context(&document.text[patch.args_range.start..offset]);
        if context.depth != 0 {
            return None;
        }
        let segment = document.text[patch.args_range.start + context.segment_start..offset].trim();
        let active_parameter = segment
            .split_once(':')
            .and_then(|(name, _)| {
                contract
                    .parameters
                    .iter()
                    .position(|(candidate, _)| *candidate == name.trim())
                    .map(|index| index as u32)
            })
            .or_else(|| {
                (context.parameter_index < contract.parameters.len() as u32)
                    .then_some(context.parameter_index)
            });
        Some(SignatureHelp {
            signatures: vec![SignatureInformation {
                label: contract.signature.to_string(),
                documentation: None,
                parameters: Some(
                    contract
                        .parameters
                        .iter()
                        .map(|(name, detail)| ParameterInformation {
                            label: ParameterLabel::Simple(format!("{name}:")),
                            documentation: Some(lsp_types::Documentation::String(
                                (*detail).to_string(),
                            )),
                        })
                        .collect(),
                ),
                active_parameter,
            }],
            active_signature: Some(0),
            active_parameter,
        })
    }

    fn resource_speaker_subject(
        &self,
        document: &DocumentSnapshot,
        offset: usize,
    ) -> Option<String> {
        let actors = &document.analysis.actors;
        let speaker = actors.speakers.iter().find(|speaker| {
            speaker.statement_range.start <= offset && offset <= speaker.statement_range.end
        })?;
        let SpeakerIdentity::Actor(actor_id) = speaker.speaker else {
            return None;
        };
        actors
            .actors
            .iter()
            .find(|actor| actor.id == actor_id)
            .map(|actor| actor.preset_id.clone())
    }

    fn resource_actor_subject(&self, document: &DocumentSnapshot, name: &str) -> Option<String> {
        let actors = &document.analysis.actors;
        actors
            .actors
            .iter()
            .find(|actor| actor.names.iter().any(|candidate| candidate == name))
            .map(|actor| actor.preset_id.clone())
    }

    fn resource_completions(
        &self,
        document: &DocumentSnapshot,
        start: usize,
        end: usize,
        subject: Option<&str>,
    ) -> Vec<CompletionItem> {
        let Some(range) =
            document
                .lines
                .range(&document.text, TextRange::new(start, end), &self.encoding)
        else {
            return Vec::new();
        };
        let mut items = HashMap::<String, CompletionItem>::new();
        for asset in &document.analysis.assets.assets {
            let selector = match subject {
                Some("asset") => asset.id.name.clone(),
                None => format!("asset, {}", asset.id.name),
                Some(_) => continue,
            };
            items
                .entry(selector.clone())
                .or_insert_with(|| CompletionItem {
                    label: selector.clone(),
                    kind: Some(CompletionItemKind::FILE),
                    detail: Some(format!("script asset · {}", asset.id.namespace)),
                    text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(range, selector))),
                    ..CompletionItem::default()
                });
        }
        let Some(registry) = &self.pack_registry else {
            let mut items = items.into_values().collect::<Vec<_>>();
            items.sort_by(|left, right| left.label.cmp(&right.label));
            return items;
        };
        if subject == Some("asset") {
            for manifest in registry.manifests() {
                for asset_id in manifest.assets.keys() {
                    items
                        .entry(asset_id.clone())
                        .or_insert_with(|| CompletionItem {
                            label: asset_id.clone(),
                            kind: Some(CompletionItemKind::FILE),
                            detail: Some(format!("pack asset · {}", manifest.pack.name)),
                            text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(
                                range,
                                asset_id.clone(),
                            ))),
                            ..CompletionItem::default()
                        });
                }
            }
            let mut items = items.into_values().collect::<Vec<_>>();
            items.sort_by(|left, right| left.label.cmp(&right.label));
            return items;
        }
        if let Some(subject) = subject {
            for manifest in registry.manifests() {
                for (local_id, entity) in &manifest.entities {
                    let canonical_id = if local_id.contains("::") {
                        local_id.clone()
                    } else {
                        format!("{}::{local_id}", manifest.pack.namespace)
                    };
                    if subject != local_id
                        && subject != canonical_id
                        && !entity.names.iter().any(|name| name == subject)
                    {
                        continue;
                    }
                    if let Some(sticker) = &entity.slots.sticker {
                        for (set_id, set) in &sticker.sets {
                            for variant in &set.variants {
                                let implicit_set = sticker.sets.len() == 1
                                    || sticker.default.as_deref() == Some(set_id);
                                let selector = if implicit_set {
                                    variant.id.clone()
                                } else {
                                    format!("{set_id}/{}", variant.id)
                                };
                                let preview = self.sticker_preview_documentation(
                                    manifest,
                                    &format!("{local_id}/sticker/{set_id}/{}", variant.id),
                                );
                                items
                                    .entry(selector.clone())
                                    .or_insert_with(|| CompletionItem {
                                        label: selector.clone(),
                                        kind: Some(CompletionItemKind::REFERENCE),
                                        detail: Some(format!("sticker · {canonical_id}")),
                                        documentation: preview.clone(),
                                        filter_text: Some(
                                            std::iter::once(variant.id.as_str())
                                                .chain(variant.handles.iter().map(String::as_str))
                                                .collect::<Vec<_>>()
                                                .join(" "),
                                        ),
                                        text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(
                                            range, selector,
                                        ))),
                                        ..CompletionItem::default()
                                    });
                                if let Some(ordinal) = variant.ordinal {
                                    let ordinal_selector = if implicit_set {
                                        format!("#{ordinal}")
                                    } else {
                                        format!("{set_id}/#{ordinal}")
                                    };
                                    items.entry(ordinal_selector.clone()).or_insert_with(|| {
                                        CompletionItem {
                                            label: ordinal_selector.clone(),
                                            kind: Some(CompletionItemKind::REFERENCE),
                                            detail: Some(format!(
                                                "sticker · {canonical_id} · {}",
                                                variant.id
                                            )),
                                            documentation: preview.clone(),
                                            text_edit: Some(CompletionTextEdit::Edit(
                                                TextEdit::new(range, ordinal_selector),
                                            )),
                                            ..CompletionItem::default()
                                        }
                                    });
                                }
                            }
                        }
                    }
                    for contribution_manifest in registry.manifests() {
                        for contribution in &contribution_manifest.contributions {
                            if contribution.target != canonical_id
                                && contribution.target != *local_id
                            {
                                continue;
                            }
                            let Some(sticker) = &contribution.slots.sticker else {
                                continue;
                            };
                            for (set_id, set) in &sticker.sets {
                                for variant in &set.variants {
                                    let implicit_set = sticker.sets.len() == 1
                                        || sticker.default.as_deref() == Some(set_id);
                                    let variant_path = if implicit_set {
                                        variant.id.clone()
                                    } else {
                                        format!("{set_id}/{}", variant.id)
                                    };
                                    let preview = self.sticker_preview_documentation(
                                        contribution_manifest,
                                        &format!(
                                            "{}/sticker/{set_id}/{}",
                                            contribution.target, variant.id
                                        ),
                                    );
                                    let selector = format!(
                                        "{}::{variant_path}",
                                        contribution_manifest.pack.namespace
                                    );
                                    items.entry(selector.clone()).or_insert_with(|| {
                                        CompletionItem {
                                            label: selector.clone(),
                                            kind: Some(CompletionItemKind::REFERENCE),
                                            detail: Some(format!(
                                                "contributed sticker · {canonical_id}"
                                            )),
                                            documentation: preview.clone(),
                                            filter_text: Some(
                                                std::iter::once(variant.id.as_str())
                                                    .chain(
                                                        variant.handles.iter().map(String::as_str),
                                                    )
                                                    .collect::<Vec<_>>()
                                                    .join(" "),
                                            ),
                                            text_edit: Some(CompletionTextEdit::Edit(
                                                TextEdit::new(range, selector),
                                            )),
                                            ..CompletionItem::default()
                                        }
                                    });
                                    if let Some(ordinal) = variant.ordinal {
                                        let ordinal_path = if implicit_set {
                                            format!("#{ordinal}")
                                        } else {
                                            format!("{set_id}/#{ordinal}")
                                        };
                                        let ordinal_selector = format!(
                                            "{}::{ordinal_path}",
                                            contribution_manifest.pack.namespace
                                        );
                                        items.entry(ordinal_selector.clone()).or_insert_with(
                                            || CompletionItem {
                                                label: ordinal_selector.clone(),
                                                kind: Some(CompletionItemKind::REFERENCE),
                                                detail: Some(format!(
                                                    "contributed sticker · {canonical_id} · {}",
                                                    variant.id
                                                )),
                                                documentation: preview.clone(),
                                                text_edit: Some(CompletionTextEdit::Edit(
                                                    TextEdit::new(range, ordinal_selector),
                                                )),
                                                ..CompletionItem::default()
                                            },
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else {
            for manifest in registry.manifests() {
                for asset_id in manifest.assets.keys() {
                    let selector = format!("asset, {asset_id}");
                    items
                        .entry(selector.clone())
                        .or_insert_with(|| CompletionItem {
                            label: selector.clone(),
                            kind: Some(CompletionItemKind::FILE),
                            detail: Some(format!("pack asset · {}", manifest.pack.name)),
                            text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(
                                range, selector,
                            ))),
                            ..CompletionItem::default()
                        });
                }
            }
        }
        let mut items = items.into_values().collect::<Vec<_>>();
        items.sort_by(|left, right| left.label.cmp(&right.label));
        items
    }

    fn preset_completions(
        &self,
        document: &DocumentSnapshot,
        start: usize,
        end: usize,
    ) -> Vec<CompletionItem> {
        let Some(registry) = &self.pack_registry else {
            return Vec::new();
        };
        let Some(range) =
            document
                .lines
                .range(&document.text, TextRange::new(start, end), &self.encoding)
        else {
            return Vec::new();
        };
        let mut items = registry
            .manifests()
            .iter()
            .flat_map(|manifest| {
                manifest.entities.iter().map(|(local_id, entity)| {
                    let canonical_id = if local_id.contains("::") {
                        local_id.clone()
                    } else {
                        format!("{}::{local_id}", manifest.pack.namespace)
                    };
                    let display_name = entity
                        .display_name
                        .as_deref()
                        .or_else(|| entity.names.first().map(String::as_str))
                        .unwrap_or(local_id);
                    CompletionItem {
                        label: canonical_id.clone(),
                        kind: Some(CompletionItemKind::CLASS),
                        detail: Some(format!("{display_name} · {}", manifest.pack.name)),
                        filter_text: Some(
                            std::iter::once(canonical_id.as_str())
                                .chain(entity.names.iter().map(String::as_str))
                                .collect::<Vec<_>>()
                                .join(" "),
                        ),
                        text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(
                            range,
                            canonical_id,
                        ))),
                        ..CompletionItem::default()
                    }
                })
            })
            .collect::<Vec<_>>();
        items.sort_by(|left, right| left.label.cmp(&right.label));
        items
    }

    fn speaker_completions(
        &self,
        document: &DocumentSnapshot,
        start: usize,
        end: usize,
    ) -> Vec<CompletionItem> {
        let Some(range) =
            document
                .lines
                .range(&document.text, TextRange::new(start, end), &self.encoding)
        else {
            return Vec::new();
        };
        let mut items = HashMap::<String, CompletionItem>::new();
        let actors = &document.analysis.actors;

        let statement_kind = document.analysis.document.nodes.iter().find_map(|node| match node {
            SyntaxNode::Statement(statement)
                if statement.range.start <= start && start <= statement.range.end =>
            {
                Some(statement.kind)
            }
            _ => None,
        });
        if let Some(statement_kind) =
            statement_kind.filter(|kind| *kind != StatementKind::Narration)
        {
            let history = actors
                .speakers
                .iter()
                .filter(|speaker| speaker.statement_range.start < start)
                .filter(|speaker| {
                    document.analysis.document.nodes.iter().any(|node| matches!(
                        node,
                        SyntaxNode::Statement(statement)
                            if statement.range == speaker.statement_range && statement.kind == statement_kind
                    ))
                })
                .filter_map(|speaker| match speaker.speaker {
                    SpeakerIdentity::Actor(actor_id) => Some(actor_id),
                    SpeakerIdentity::Builtin(_) => None,
                })
                .collect::<Vec<_>>();
            let mut add_reference = |label: String, actor_id| {
                let Some(actor) = actors.actors.iter().find(|actor| actor.id == actor_id) else {
                    return;
                };
                let Some(state) = actor
                    .revisions
                    .iter()
                    .rev()
                    .find(|revision| revision.origin.start < start)
                    .map(|revision| &revision.state)
                else {
                    return;
                };
                items
                    .entry(label.clone())
                    .or_insert_with(|| CompletionItem {
                        label: label.clone(),
                        kind: Some(CompletionItemKind::REFERENCE),
                        detail: Some(format!(
                            "speaker reference → {} · {}",
                            state.display_name, actor.primary_name
                        )),
                        text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(range, label))),
                        ..CompletionItem::default()
                    });
            };
            if let Some(&actor_id) = history.last() {
                add_reference("_0".to_string(), actor_id);
                let current = actor_id;
                let mut recent_distinct = Vec::new();
                for &candidate in history.iter().rev() {
                    if candidate != current && !recent_distinct.contains(&candidate) {
                        recent_distinct.push(candidate);
                    }
                }
                for (index, candidate) in recent_distinct.into_iter().enumerate() {
                    if index == 0 {
                        add_reference("_".to_string(), candidate);
                    }
                    add_reference(format!("_{}", index + 1), candidate);
                }
            }
            let mut unique = Vec::new();
            for &actor_id in &history {
                if !unique.contains(&actor_id) {
                    unique.push(actor_id);
                }
            }
            for (index, actor_id) in unique.into_iter().enumerate() {
                if index == 0 {
                    add_reference("~".to_string(), actor_id);
                }
                add_reference(format!("~{}", index + 1), actor_id);
            }
        }

        for actor in &actors.actors {
            let detail = format!("script actor · {}", actor.preset_id);
            let names = std::iter::once(&actor.primary_name).chain(actor.names.iter());
            for name in names {
                items.entry(name.clone()).or_insert_with(|| CompletionItem {
                    label: name.clone(),
                    kind: Some(CompletionItemKind::VARIABLE),
                    detail: Some(detail.clone()),
                    text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(range, name.clone()))),
                    ..CompletionItem::default()
                });
            }
        }
        if let Some(registry) = &self.pack_registry {
            for manifest in registry.manifests() {
                for (local_id, entity) in &manifest.entities {
                    let canonical_id = if local_id.contains("::") {
                        local_id.clone()
                    } else {
                        format!("{}::{local_id}", manifest.pack.namespace)
                    };
                    let display_name = entity
                        .display_name
                        .as_deref()
                        .or_else(|| entity.names.first().map(String::as_str))
                        .unwrap_or(local_id);
                    for label in
                        std::iter::once(canonical_id.clone()).chain(entity.names.iter().cloned())
                    {
                        items
                            .entry(label.clone())
                            .or_insert_with(|| CompletionItem {
                                label: label.clone(),
                                kind: Some(CompletionItemKind::CLASS),
                                detail: Some(format!("{display_name} · {canonical_id}")),
                                filter_text: Some(
                                    std::iter::once(canonical_id.as_str())
                                        .chain(entity.names.iter().map(String::as_str))
                                        .collect::<Vec<_>>()
                                        .join(" "),
                                ),
                                text_edit: Some(CompletionTextEdit::Edit(TextEdit::new(
                                    range, label,
                                ))),
                                ..CompletionItem::default()
                            });
                    }
                }
            }
        }
        let mut items = items.into_values().collect::<Vec<_>>();
        items.sort_by(|left, right| left.label.cmp(&right.label));
        items
    }

    fn folding_range(
        &self,
        document: &DocumentSnapshot,
        node: &SyntaxNode,
    ) -> Option<FoldingRange> {
        let range = match node {
            SyntaxNode::DirectiveBlock(block) => block.range,
            SyntaxNode::Reply(reply) => reply.range,
            SyntaxNode::Bond(bond) => bond.range,
            SyntaxNode::Statement(statement) => statement.range,
            _ => return None,
        };
        let start = document
            .lines
            .position(&document.text, range.start, &self.encoding)?;
        let end_offset = range.end.saturating_sub(1).max(range.start);
        let end = document
            .lines
            .position(&document.text, end_offset, &self.encoding)?;
        (start.line < end.line).then_some(FoldingRange {
            start_line: start.line,
            start_character: Some(start.character),
            end_line: end.line,
            end_character: Some(end.character),
            kind: Some(FoldingRangeKind::Region),
            collapsed_text: None,
        })
    }
}

fn markdown_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if character == '\n' || character == '\r' {
            escaped.push(' ');
        } else if "\\`*_{}[]<>()#+-.!|".contains(character) {
            escaped.push('\\');
            escaped.push(character);
        } else {
            escaped.push(character);
        }
    }
    escaped
}

fn markdown_code(value: &str) -> String {
    let longest = value
        .split(|character| character != '`')
        .map(str::len)
        .max()
        .unwrap_or(0);
    let delimiter = "`".repeat(longest + 1);
    let content = value.replace(['\n', '\r'], " ");
    format!("{delimiter} {content} {delimiter}")
}

const DOCUMENT_DIRECTIVE_DESCRIPTION: &str =
    "Configure document title, author, title-bar visibility, and compilation time.";
const TYP_DIRECTIVE_DESCRIPTION: &str = "Insert raw Typst content that is checked with the generated document and mapped back to this source.";

const DOCUMENT_FIELDS: &[(&str, &str)] = &[
    ("title", "document title; defaults to 无题"),
    ("author", "optional document author"),
    ("show-header", "show or hide the document title bar"),
    (
        "compiled-at",
        "fixed compilation label or auto for a host-provided instant",
    ),
    (
        "compiled-at-format",
        "Rust time format description used with compiled-at: auto",
    ),
    (
        "timezone",
        "local, utc, Z, or a fixed UTC offset such as +08:00",
    ),
];

fn directive_hover_at(
    document: &SyntaxDocument,
    source: &str,
    offset: usize,
) -> Option<(TextRange, String)> {
    document.nodes.iter().find_map(|node| {
        let (name, name_range, items) = match node {
            SyntaxNode::DirectiveLine(directive) => {
                (directive.name.as_str(), directive.name_range, None)
            }
            SyntaxNode::DirectiveBlock(block) => {
                (block.name.as_str(), block.name_range, Some(&block.items))
            }
            _ => return None,
        };

        if name == "document"
            && let Some(items) = items
            && let Some((field, description)) = items.iter().find_map(|item| {
                let DirectiveItemSyntax::Field(field) = item else {
                    return None;
                };
                let description = DOCUMENT_FIELDS.iter().find_map(|(name, description)| {
                    (*name == field.name).then_some(*description)
                })?;
                (field.name_range.start <= offset && offset < field.name_range.end)
                    .then_some((field, description))
            })
        {
            return Some((
                field.name_range,
                format!("**{}**\n\n{}", markdown_code(&field.name), description),
            ));
        }

        let marker_range = directive_marker_range(source, name_range)?;
        if !(marker_range.start <= offset && offset < marker_range.end) {
            return None;
        }
        match name {
            "document" => {
                let fields = DOCUMENT_FIELDS
                    .iter()
                    .map(|(name, description)| {
                        format!("- {} — {}", markdown_code(name), description)
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                Some((
                    marker_range,
                    format!(
                        "**@document**\n\n{}\n\n{}",
                        DOCUMENT_DIRECTIVE_DESCRIPTION, fields
                    ),
                ))
            }
            "typ" => Some((
                marker_range,
                format!("**@typ**\n\n{TYP_DIRECTIVE_DESCRIPTION}"),
            )),
            _ => None,
        }
    })
}

fn directive_marker_range(source: &str, name_range: TextRange) -> Option<TextRange> {
    let marker_start = name_range.start.checked_sub(1)?;
    (source.as_bytes().get(marker_start) == Some(&b'@'))
        .then_some(TextRange::new(marker_start, name_range.end))
}

#[derive(Clone, Copy)]
struct FacadeContract {
    signature: &'static str,
    summary: &'static str,
    parameters: &'static [(&'static str, &'static str)],
}

const CHAT_PARAMETERS: &[(&str, &str)] = &[
    ("continued", "override consecutive-message grouping"),
    ("fill", "bubble fill"),
    ("text-fill", "message text fill"),
    ("inset", "bubble inset"),
    ("radius", "bubble corner radius"),
    ("tip", "show the bubble tip"),
    ("image-only", "render image-only bubble content"),
    ("reserve-avatar-space", "reserve the avatar column"),
];
const NARRATION_PARAMETERS: &[(&str, &str)] = &[
    ("fill", "panel fill"),
    ("text-fill", "narration text fill"),
    ("inset", "panel inset"),
    ("radius", "panel corner radius"),
];
const REPLY_PARAMETERS: &[(&str, &str)] = &[
    ("label", "reply panel label"),
    ("fill", "panel fill"),
    ("accent", "accent and item text color"),
    ("decoration", "top-right decoration or none"),
];
const BOND_PARAMETERS: &[(&str, &str)] = &[
    ("label", "bond panel label"),
    ("fill", "panel fill"),
    ("text-fill", "bond event text fill"),
    ("decoration", "top-right decoration or none"),
];
const CHAT_CONTRACT: FacadeContract = FacadeContract {
    signature: "mmt.chat-left/right(continued: auto, fill: auto, text-fill: auto, inset: auto, radius: auto, tip: auto, image-only: false, reserve-avatar-space: auto)",
    summary: "Render a left or right MomoTalk message. Speaker identity, avatar and body are managed by MomoScript.",
    parameters: CHAT_PARAMETERS,
};
const NARRATION_CONTRACT: FacadeContract = FacadeContract {
    signature: "mmt.narration(fill: auto, text-fill: auto, inset: auto, radius: auto)",
    summary: "Render a centered narration panel.",
    parameters: NARRATION_PARAMETERS,
};
const REPLY_CONTRACT: FacadeContract = FacadeContract {
    signature: "mmt.reply(label: [回复], fill: rgb(\"e1edf0\"), accent: rgb(\"4b6989\"), decoration: image(...))",
    summary: "Render reply options. List items are supplied by the MMT body.",
    parameters: REPLY_PARAMETERS,
};
const BOND_CONTRACT: FacadeContract = FacadeContract {
    signature: "mmt.bond(label: [羁绊事件], fill: rgb(\"fc879b\"), text-fill: white, decoration: image(...))",
    summary: "Render a bond-event panel.",
    parameters: BOND_PARAMETERS,
};

fn facade_marker_at(
    document: &SyntaxDocument,
    offset: usize,
) -> Option<(FacadeContract, TextRange)> {
    document.nodes.iter().find_map(|node| match node {
        SyntaxNode::Statement(statement)
            if statement.range.start <= offset && offset < statement.range.start + 1 =>
        {
            let contract = match statement.kind {
                mmt_rs::syntax::StatementKind::Narration => NARRATION_CONTRACT,
                mmt_rs::syntax::StatementKind::Left | mmt_rs::syntax::StatementKind::Right => {
                    CHAT_CONTRACT
                }
            };
            Some((
                contract,
                TextRange::new(statement.range.start, statement.range.start + 1),
            ))
        }
        SyntaxNode::Reply(reply)
            if reply.range.start <= offset && offset < reply.range.start + "@reply".len() =>
        {
            Some((
                REPLY_CONTRACT,
                TextRange::new(reply.range.start, reply.range.start + "@reply".len()),
            ))
        }
        SyntaxNode::Bond(bond)
            if bond.range.start <= offset && offset < bond.range.start + "@bond".len() =>
        {
            Some((
                BOND_CONTRACT,
                TextRange::new(bond.range.start, bond.range.start + "@bond".len()),
            ))
        }
        _ => None,
    })
}

fn facade_patch_at(
    document: &SyntaxDocument,
    offset: usize,
) -> Option<(FacadeContract, &mmt_rs::syntax::PatchSyntax)> {
    document.nodes.iter().find_map(|node| {
        let (contract, patch) = match node {
            SyntaxNode::Statement(statement) => {
                let contract = match statement.kind {
                    mmt_rs::syntax::StatementKind::Narration => NARRATION_CONTRACT,
                    mmt_rs::syntax::StatementKind::Left | mmt_rs::syntax::StatementKind::Right => {
                        CHAT_CONTRACT
                    }
                };
                (contract, statement.patch.as_ref()?)
            }
            SyntaxNode::Reply(reply) => (REPLY_CONTRACT, reply.patch.as_ref()?),
            SyntaxNode::Bond(bond) => (BOND_CONTRACT, bond.patch.as_ref()?),
            _ => return None,
        };
        (patch.args_range.start <= offset && offset <= patch.args_range.end)
            .then_some((contract, patch))
    })
}

#[derive(Debug, Default)]
struct PatchContext {
    depth: usize,
    segment_start: usize,
    has_colon: bool,
    parameter_index: u32,
}
fn resource_hover_markdown(source: &str, kind: &ResolvedResourceKind) -> String {
    let source = markdown_code(source);
    match kind {
        ResolvedResourceKind::Sticker {
            entity_id,
            contribution_namespace,
            set_id,
            variant_id,
            source: storage,
        } => format!(
            "**Sticker `{}`**\n\n{} → entity `{}` · set `{}` · contribution `{}`\n\nStorage `{}` / `{}`",
            markdown_text(variant_id),
            source,
            markdown_text(entity_id),
            markdown_text(set_id),
            markdown_text(contribution_namespace),
            markdown_text(&storage.pack_namespace),
            markdown_text(&storage.storage_id),
        ),
        ResolvedResourceKind::PackAsset {
            name,
            source: storage,
        } => format!(
            "**Pack asset `{}`**\n\n{}\n\nStorage `{}` / `{}`",
            markdown_text(name),
            source,
            markdown_text(&storage.pack_namespace),
            markdown_text(&storage.storage_id),
        ),
        ResolvedResourceKind::ScriptAsset {
            namespace, name, ..
        } => format!(
            "**Script asset `{}`**\n\n{} · namespace `{}`",
            markdown_text(name),
            source,
            markdown_text(namespace),
        ),
        ResolvedResourceKind::Temporary { name } => {
            format!(
                "**Temporary resource `{}`**\n\n{}",
                markdown_text(name),
                source
            )
        }
        ResolvedResourceKind::WorkspaceFile { path } => {
            format!(
                "**Workspace file**\n\n{} → `{}`",
                source,
                markdown_text(path)
            )
        }
        ResolvedResourceKind::RemoteUrl { url } => {
            format!(
                "**Remote resource**\n\n{} → `{}`",
                source,
                markdown_text(url)
            )
        }
        ResolvedResourceKind::Avatar {
            entity_id,
            variant_id,
            ..
        } => format!(
            "**Avatar `{}`**\n\n{} · entity `{}`",
            markdown_text(variant_id),
            source,
            markdown_text(entity_id),
        ),
    }
}

fn patch_context(prefix: &str) -> PatchContext {
    let mut context = PatchContext::default();
    let mut quote = None;
    let mut escaped = false;
    for (index, character) in prefix.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' {
            escaped = true;
            continue;
        }
        if let Some(delimiter) = quote {
            if character == delimiter {
                quote = None;
            }
            continue;
        }
        if character == '"' || character == '\'' {
            quote = Some(character);
        } else if matches!(character, '(' | '[' | '{') {
            context.depth += 1;
        } else if matches!(character, ')' | ']' | '}') {
            context.depth = context.depth.saturating_sub(1);
        } else if context.depth == 0 && character == ',' {
            context.segment_start = index + character.len_utf8();
            context.has_colon = false;
            context.parameter_index += 1;
        } else if context.depth == 0 && character == ':' {
            context.has_colon = true;
        }
    }
    context
}

fn statement_speaker_prefix(
    line: &str,
    statement_start: usize,
    offset: usize,
    patch_range: Option<TextRange>,
) -> Option<&str> {
    let mut rest = line
        .strip_prefix('>')
        .or_else(|| line.strip_prefix('<'))?
        .trim_start();
    if rest.starts_with('(') {
        let patch_range = patch_range?;
        if offset < patch_range.end {
            return None;
        }
        let patch_end = patch_range.end.checked_sub(statement_start)?;
        rest = line.get(patch_end..)?.trim_start();
    }
    for (offset, character) in rest.char_indices() {
        if character != ':' {
            continue;
        }
        let before = rest[..offset].chars().next_back();
        let after = rest[offset + 1..].chars().next();
        if before != Some(':') && after != Some(':') {
            return None;
        }
    }
    Some(rest)
}

fn completion_items(
    document: &DocumentSnapshot,
    encoding: &PositionEncodingKind,
    start: usize,
    end: usize,
    values: &[(&str, &str)],
    kind: CompletionItemKind,
) -> Vec<CompletionItem> {
    let Some(range) = document
        .lines
        .range(&document.text, TextRange::new(start, end), encoding)
    else {
        return Vec::new();
    };
    values
        .iter()
        .map(|(label, detail)| CompletionItem {
            label: (*label).to_string(),
            kind: Some(kind),
            detail: Some((*detail).to_string()),
            text_edit: Some(CompletionTextEdit::Edit(TextEdit {
                range,
                new_text: (*label).to_string(),
            })),
            ..CompletionItem::default()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use lsp_types::Position;
    use mmt_rs::diag::{DiagnosticPhase, Severity};

    fn uri() -> Url {
        Url::parse("file:///workspace/example.mmt").unwrap()
    }

    fn markdown_hover(
        service: &LanguageService,
        line: u32,
        character: u32,
    ) -> (String, lsp_types::Range) {
        let hover = service
            .hover(&uri(), Position::new(line, character))
            .expect("expected hover");
        let HoverContents::Markup(contents) = hover.contents else {
            panic!("expected markdown hover");
        };
        (contents.value, hover.range.expect("expected hover range"))
    }

    #[test]
    fn snapshots_increment_and_publish_utf16_diagnostics() {
        let mut service = LanguageService::default();
        let first = service.open(uri(), 1, "- 😀\n@end".to_string()).revision;
        let diagnostics = service.diagnostics(&uri());
        assert_eq!(diagnostics[0].range.start, Position::new(1, 0));
        let second = service
            .change(uri(), 2, "- fixed".to_string())
            .unwrap()
            .revision;
        assert!(second > first);
        assert!(service.diagnostics(&uri()).is_empty());
        assert!(service.change(uri(), 1, "- stale".to_string()).is_none());
        assert_eq!(service.snapshot(&uri()).unwrap().version, 2);
    }

    #[test]
    fn publishes_resource_lowering_diagnostics_without_pack_manifests() {
        let mut service = LanguageService::default();
        service.open(uri(), 1, "- [:happy:]".to_string());

        let diagnostics = service.diagnostics(&uri());

        let diagnostic = diagnostics
            .iter()
            .find(|diagnostic| {
                diagnostic.data == Some(serde_json::json!({ "phase": "semantic" }))
                    && diagnostic.message
                        == "bare sticker selector requires an explicit actor speaker or subject"
            })
            .expect("resource-lowering diagnostic");
        assert_eq!(diagnostic.range.start, Position::new(0, 4));
        assert_eq!(diagnostic.range.end, Position::new(0, 9));
    }

    #[test]
    fn publishes_complete_live_diagnostic_pipeline_without_duplicates() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"花子":{"names":["花子"]}}
        }"#;
        let mut service = LanguageService::default();
        service.update_pack_manifests(1, &[manifest.to_string()]).unwrap();
        service.open(
            uri(),
            1,
            "@mode: nonsense\n@actor broken\nunknown: x\n@end\n@asset bad\nsrc: ../bad.png\n@end\n- [:#0:]\n@actor hanako\npreset: ba::花子\n@end\n> hanako: [:missing:]\n@typ: #let =\n@end".to_string(),
        );
        let diagnostics = service.diagnostics(&uri());
        let has_phase = |phase: &str| diagnostics.iter().any(|diagnostic| {
            diagnostic.data.as_ref().and_then(|data| data.get("phase")).and_then(|value| value.as_str()) == Some(phase)
        });
        assert!(has_phase("syntax"), "syntax diagnostics must be published: {diagnostics:#?}");
        assert!(has_phase("semantic"), "semantic diagnostics must be published: {diagnostics:#?}");
        assert!(has_phase("resolve"), "pack resolve/planning diagnostics must be published: {diagnostics:#?}");
        assert!(has_phase("typst"), "placeholder Typst-check diagnostics must be published: {diagnostics:#?}");
        for expected in [
            "unknown body mode",
            "unknown @actor field",
            "local asset src must be a sanitized basename",
            "bare sticker selector requires an explicit actor speaker or subject",
        ] {
            assert!(diagnostics.iter().any(|diagnostic| diagnostic.message.contains(expected)), "missing {expected:?} diagnostic: {diagnostics:#?}");
        }
        let unique = diagnostics
            .iter()
            .map(|diagnostic| (
                diagnostic.range.start.line,
                diagnostic.range.start.character,
                diagnostic.range.end.line,
                diagnostic.range.end.character,
                diagnostic.message.as_str(),
                diagnostic.data.as_ref().and_then(|data| data.get("phase")).and_then(|phase| phase.as_str()),
            ))
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(unique.len(), diagnostics.len(), "live diagnostics must not be duplicated");
    }

    #[test]
    fn exposes_directive_symbols_and_multiline_folding() {
        let mut service = LanguageService::default();
        service.open(
            uri(),
            1,
            "@actor yuzu\npreset: ba::柚子\n@end\n@reply\n- A\n- B\n@end".to_string(),
        );
        let symbols = service.document_symbols(&uri());
        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0].name, "@actor yuzu");
        assert_eq!(service.folding_ranges(&uri()).len(), 2);
    }

    #[test]
    fn maps_diagnostic_labels_to_related_information() {
        let mut service = LanguageService::default();
        service.open(uri(), 1, "first\nsecond".to_string());
        let document = service.snapshot(&uri()).unwrap();
        let diagnostic = MmtDiagnostic::new(
            Severity::Error,
            DiagnosticPhase::Semantic,
            "duplicate declaration",
            Some(TextRange::new(6, 12)),
        )
        .with_label(TextRange::new(0, 5), "first declaration is here");
        let mapped = service.diagnostic(&uri(), document, &diagnostic).unwrap();
        let related = mapped.related_information.unwrap();
        assert_eq!(related.len(), 1);
        assert_eq!(related[0].location.uri, uri());
        assert_eq!(related[0].location.range.start, Position::new(0, 0));
        assert_eq!(related[0].message, "first declaration is here");
    }

    #[test]
    fn completes_directives_modes_and_actor_fields_with_prefix_edits() {
        let mut service = LanguageService::default();
        service.open(uri(), 1, "@a".to_string());
        let directives = service.completions(&uri(), Position::new(0, 2));
        let actor = directives
            .iter()
            .find(|completion| completion.label == "@actor")
            .unwrap();
        let Some(CompletionTextEdit::Edit(edit)) = &actor.text_edit else {
            panic!("expected a text edit");
        };
        assert_eq!(edit.range.start, Position::new(0, 0));
        assert_eq!(edit.new_text, "@actor");

        service.open(uri(), 2, "@mode: raw".to_string());
        let modes = service.completions(&uri(), Position::new(0, 10));
        assert!(
            modes
                .iter()
                .any(|completion| completion.label == "raw-text")
        );

        service.open(
            uri(),
            3,
            "@actor yuzu\npreset: ba::柚子\ndispl\n@end".to_string(),
        );
        let fields = service.completions(&uri(), Position::new(2, 5));
        assert!(
            fields
                .iter()
                .any(|completion| completion.label == "display-name")
        );
    }

    #[test]
    fn completes_document_directive_fields_and_values_in_incomplete_blocks() {
        let mut service = LanguageService::default();
        service.open(uri(), 1, "@doc".to_string());
        let directives = service.completions(&uri(), Position::new(0, 4));
        assert!(
            directives
                .iter()
                .any(|completion| completion.label == "@document")
        );

        service.open(uri(), 2, "@document\nti".to_string());
        let incomplete_fields = service.completions(&uri(), Position::new(1, 2));
        assert!(
            incomplete_fields
                .iter()
                .any(|completion| completion.label == "title")
        );

        service.open(
            uri(),
            3,
            "@document\ntitle: Story\nauthor: Author\nsh\n@end".to_string(),
        );
        let remaining_fields = service.completions(&uri(), Position::new(3, 2));
        assert!(
            remaining_fields
                .iter()
                .any(|completion| completion.label == "show-header")
        );
        assert!(
            remaining_fields
                .iter()
                .all(|completion| !matches!(completion.label.as_str(), "title" | "author"))
        );

        service.open(uri(), 4, "@document\nshow-header: \n@end".to_string());
        let booleans = service.completions(&uri(), Position::new(1, 13));
        assert!(booleans.iter().any(|completion| completion.label == "true"));
        assert!(
            booleans
                .iter()
                .any(|completion| completion.label == "false")
        );

        service.open(uri(), 5, "@document\ntimezone: \n@end".to_string());
        let timezones = service.completions(&uri(), Position::new(1, 10));
        for expected in ["local", "utc", "Z", "+08:00"] {
            assert!(
                timezones
                    .iter()
                    .any(|completion| completion.label == expected),
                "missing timezone completion {expected}"
            );
        }
    }

    #[test]
    fn semantically_highlights_document_fields_and_enum_values() {
        let mut service = LanguageService::default();
        service.open(
            uri(),
            1,
            "@document\nshow-header: true\ncompiled-at: auto\ntimezone: +08:00\n@end".to_string(),
        );

        let tokens = service.semantic_tokens(&uri()).unwrap();
        assert_eq!(
            tokens
                .data
                .iter()
                .filter(|token| token.token_type == 3)
                .count(),
            3
        );
        assert_eq!(
            tokens
                .data
                .iter()
                .filter(|token| token.token_type == 2)
                .count(),
            3
        );
    }

    #[test]
    fn does_not_complete_field_names_inside_a_field_value() {
        let mut service = LanguageService::default();
        service.open(uri(), 1, "@actor yuzu\npreset: ba::柚\n@end".to_string());

        let completions = service.completions(&uri(), Position::new(1, 14));
        assert!(completions.is_empty());
    }

    #[test]
    fn installs_pack_registry_and_completes_actor_presets() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"柚子":{"names":["柚子","Yuzu"],"display_name":"柚子"}}
        }"#;
        let mut service = LanguageService::default();
        assert!(
            service
                .update_pack_manifests(1, &[manifest.to_string()])
                .unwrap()
        );
        service.open(uri(), 1, "@actor\npreset: ba::柚\n@end".to_string());
        let completions = service.completions(&uri(), Position::new(1, 13));
        let preset = completions
            .iter()
            .find(|completion| completion.label == "ba::柚子")
            .unwrap();
        assert_eq!(preset.detail.as_deref(), Some("柚子 · BA fixture"));
        let Some(CompletionTextEdit::Edit(edit)) = &preset.text_edit else {
            panic!("expected a preset text edit");
        };
        assert_eq!(edit.range.start, Position::new(1, 8));
        assert_eq!(edit.new_text, "ba::柚子");
    }

    #[test]
    fn completes_inline_resource_subjects_assets_and_sticker_variants() {
        let base = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"柚子":{"names":["柚子","Yuzu"],"slots":{"sticker":{"default":"default","sets":{"default":{"storage":"stickers","variants":[{"id":"smile","handles":["微笑"]}]}}}}}},
            "assets":{"logo":{"source":{"storage":"stickers","path":"logo.png"}}},
            "storage":{"stickers":{"kind":"image-dir","base":"assets"}}
        }"#;
        let extension = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba_ext","name":"BA extension","version":"1","type":"extension","requires":["ba"]},
            "contributions":[{"target":"ba::柚子","slots":{"sticker":{"default":"extra","sets":{"extra":{"storage":"stickers","variants":[{"id":"wink","handles":["眨眼"]}]}}}}}],
            "storage":{"stickers":{"kind":"image-dir","base":"assets"}}
        }"#;
        let mut service = LanguageService::default();
        service
            .update_pack_manifests(1, &[base.to_string(), extension.to_string()])
            .unwrap();

        let asset_source = "> 柚子: [:asset, lo";
        service.open(uri(), 2, asset_source.to_string());
        let assets = service.completions(
            &uri(),
            Position::new(0, asset_source.encode_utf16().count() as u32),
        );
        assert!(assets.iter().any(|item| item.label == "logo"));

        let inferred_source = "@actor yuzu\npreset: ba::柚子\n@end\n> yuzu: [:smi";
        service.open(uri(), 3, inferred_source.to_string());
        let inferred = service.completions(
            &uri(),
            Position::new(3, "> yuzu: [:smi".encode_utf16().count() as u32),
        );
        assert!(inferred.iter().any(|item| item.label == "smile"));
        assert!(inferred.iter().any(|item| item.label == "asset, logo"));
        assert!(inferred.iter().all(|item| item.label != "ba::柚子"));

        let alias_source = "@actor yuzu\npreset: ba::柚子\n@end\n> yuzu: [:yuzu, smi";
        service.open(uri(), 4, alias_source.to_string());
        let alias_variants = service.completions(
            &uri(),
            Position::new(3, "> yuzu: [:yuzu, smi".encode_utf16().count() as u32),
        );
        assert!(alias_variants.iter().any(|item| item.label == "smile"));

        let variant_source = "> 柚子: [:ba::柚子, smi";
        service.open(uri(), 2, variant_source.to_string());
        let variants = service.completions(
            &uri(),
            Position::new(0, variant_source.encode_utf16().count() as u32),
        );
        assert!(variants.iter().any(|item| item.label == "smile"));
        assert!(variants.iter().any(|item| item.label == "ba_ext::wink"));
        let smile = variants.iter().find(|item| item.label == "smile").unwrap();
        let Some(CompletionTextEdit::Edit(edit)) = &smile.text_edit else {
            panic!("expected resource completion text edit");
        };
        assert_eq!(edit.new_text, "smile");
        assert_eq!(
            edit.range.start.character,
            variant_source[..variant_source.rfind("smi").unwrap()]
                .encode_utf16()
                .count() as u32
        );
    }

    #[test]
    fn completes_script_assets_without_a_pack_registry() {
        let source =
            "@asset hero\nsrc: \"https://example.test/hero.png\"\n@end\n> narrator: [:asset, he";
        let mut service = LanguageService::default();
        service.open(uri(), 1, source.to_string());
        let completions = service.completions(
            &uri(),
            Position::new(3, "> narrator: [:asset, he".encode_utf16().count() as u32),
        );
        let hero = completions
            .iter()
            .find(|item| item.label == "hero")
            .expect("missing script-local asset completion");
        assert_eq!(hero.detail.as_deref(), Some("script asset · custom"));
    }

    #[test]
    fn does_not_complete_pack_entities_in_actor_identity_head() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"柚子":{"names":["柚子"]}}
        }"#;
        let mut service = LanguageService::default();
        service
            .update_pack_manifests(1, &[manifest.to_string()])
            .unwrap();
        service.open(uri(), 1, "@actor ba::柚".to_string());
        let completions = service.completions(&uri(), Position::new(0, 12));
        assert!(completions.is_empty());
    }

    #[test]
    fn invalid_pack_update_preserves_last_valid_registry() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"柚子":{"names":["柚子"]}}
        }"#;
        let mut service = LanguageService::default();
        service
            .update_pack_manifests(4, &[manifest.to_string()])
            .unwrap();
        assert!(
            service
                .update_pack_manifests(5, &["{".to_string()])
                .is_err()
        );
        assert_eq!(service.pack_revision(), 4);
        service.open(uri(), 1, "@actor yuzu\npreset: \n@end".to_string());
        assert!(
            service
                .completions(&uri(), Position::new(1, 8))
                .iter()
                .any(|completion| completion.label == "ba::柚子")
        );
    }

    #[test]
    fn diagnoses_unknown_statement_speaker_semantically() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"花子":{"names":["花子"]}}
        }"#;
        let mut service = LanguageService::default();
        service
            .update_pack_manifests(1, &[manifest.to_string()])
            .unwrap();
        service.open(uri(), 1, "> 未知人物: hello".to_string());
        let diagnostics = service.diagnostics(&uri());
        assert!(diagnostics.iter().any(|diagnostic| {
            diagnostic.severity == Some(DiagnosticSeverity::ERROR)
                && diagnostic
                    .message
                    .contains("unknown character preset '未知人物'")
                && diagnostic.range
                    == lsp_types::Range::new(Position::new(0, 2), Position::new(0, 6))
        }));
    }

    #[test]
    fn completes_pack_names_ids_and_script_actor_aliases_as_speakers() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"花子":{"names":["花子","Hanako"],"display_name":"浦和花子"}}
        }"#;
        let mut service = LanguageService::default();
        service
            .update_pack_manifests(1, &[manifest.to_string()])
            .unwrap();
        service.open(
            uri(),
            1,
            "@actor hana\npreset: ba::花子\nalso-as: [小花]\n@end\n> 花".to_string(),
        );
        let completions = service.completions(&uri(), Position::new(4, 3));
        for expected in ["花子", "Hanako", "ba::花子", "hana", "小花"] {
            assert!(
                completions
                    .iter()
                    .any(|completion| completion.label == expected),
                "missing {expected}"
            );
        }
        let name = completions
            .iter()
            .find(|completion| completion.label == "花子")
            .unwrap();
        let Some(CompletionTextEdit::Edit(edit)) = &name.text_edit else {
            panic!("expected a speaker text edit");
        };
        assert_eq!(
            edit.range,
            lsp_types::Range::new(Position::new(4, 2), Position::new(4, 3))
        );
    }

    #[test]
    fn completes_speaker_after_balanced_statement_patch() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"花子":{"names":["花子"]}}
        }"#;
        let mut service = LanguageService::default();
        service
            .update_pack_manifests(1, &[manifest.to_string()])
            .unwrap();
        let statement = r#"> (inset: (left: 1pt), fill: rgb(")")) ha"#;
        service.open(
            uri(),
            1,
            format!("@actor hana\npreset: ba::花子\n@end\n{statement}"),
        );

        let inside_patch = statement.find("left").unwrap() + 2;
        assert!(
            service
                .completions(&uri(), Position::new(3, inside_patch as u32))
                .iter()
                .all(|completion| completion.label != "hana")
        );

        let patch_end = statement.rfind("))").unwrap() + 2;
        assert!(
            service
                .completions(&uri(), Position::new(3, patch_end as u32))
                .iter()
                .any(|completion| completion.label == "hana"),
            "missing script actor at the exclusive patch end",
        );

        let completions = service.completions(&uri(), Position::new(3, statement.len() as u32));
        let actor = completions
            .iter()
            .find(|completion| completion.label == "hana")
            .expect("missing script actor after statement patch");
        let Some(CompletionTextEdit::Edit(edit)) = &actor.text_edit else {
            panic!("expected a speaker text edit");
        };
        assert_eq!(
            edit.range,
            lsp_types::Range::new(
                Position::new(3, (statement.len() - 2) as u32),
                Position::new(3, statement.len() as u32),
            )
        );
    }

    #[test]
    fn hovers_document_directive_fields_and_typ_directive_at_ast_ranges() {
        let mut service = LanguageService::default();
        service.open(
            uri(),
            1,
            concat!(
                "@document\n",
                "title: \"Story\"\n",
                "author: \"xiyihan\"\n",
                "show-header: true\n",
                "compiled-at: auto\n",
                "compiled-at-format: \"[year]\"\n",
                "timezone: +08:00\n",
                "@end\n",
                "@typ\n",
                "#let x = 1\n",
                "@end\n",
                "@typ: #text(\"inline\")",
            )
            .to_string(),
        );

        for character in [0, 4, 8] {
            let (markdown, range) = markdown_hover(&service, 0, character);
            assert!(markdown.contains(DOCUMENT_DIRECTIVE_DESCRIPTION));
            assert!(markdown.contains("` timezone `"));
            assert_eq!(
                range,
                lsp_types::Range::new(Position::new(0, 0), Position::new(0, 9))
            );
        }

        for (line, (field, description)) in DOCUMENT_FIELDS.iter().enumerate() {
            for character in [0, field.len() / 2, field.len() - 1] {
                let (markdown, range) = markdown_hover(&service, line as u32 + 1, character as u32);
                assert!(markdown.contains(description));
                assert_eq!(
                    range,
                    lsp_types::Range::new(
                        Position::new(line as u32 + 1, 0),
                        Position::new(line as u32 + 1, field.len() as u32),
                    )
                );
            }
        }

        for line in [8, 11] {
            for character in [0, 2, 3] {
                let (markdown, range) = markdown_hover(&service, line, character);
                assert!(markdown.contains(TYP_DIRECTIVE_DESCRIPTION));
                assert_eq!(
                    range,
                    lsp_types::Range::new(Position::new(line, 0), Position::new(line, 4))
                );
            }
        }

        for (line, character) in [(0, 9), (1, 5), (1, 7), (6, 8), (6, 10), (8, 4)] {
            assert!(
                service
                    .hover(&uri(), Position::new(line, character))
                    .is_none(),
                "unexpected hover at {line}:{character}",
            );
        }
    }

    #[test]
    fn exposes_facade_hover_signature_and_top_level_parameter_completion() {
        let mut service = LanguageService::default();
        let source = "<(fill: rgb(1, 2, 3), ) hello";
        service.open(uri(), 1, source.to_string());

        let hover = service.hover(&uri(), Position::new(0, 0)).unwrap();
        let HoverContents::Markup(contents) = hover.contents else {
            panic!("expected markdown hover");
        };
        assert!(contents.value.contains("mmt.chat-left/right"));

        let nested = source.find("2, ").unwrap() + 3;
        assert!(
            service
                .completions(&uri(), Position::new(0, nested as u32))
                .is_empty(),
            "nested expression commas must not trigger façade fields",
        );

        let top_level = source.rfind(", ").unwrap() + 2;
        let completions = service.completions(&uri(), Position::new(0, top_level as u32));
        assert!(completions.iter().any(|item| item.label == "continued"));

        let signature = service
            .signature_help(&uri(), Position::new(0, top_level as u32))
            .unwrap();
        assert_eq!(signature.active_parameter, Some(1));

        service.open(uri(), 2, "<(radius: 4pt, tip: ) hello".to_string());
        let named = service
            .signature_help(&uri(), Position::new(0, 20))
            .unwrap();
        assert_eq!(named.active_parameter, Some(5));
    }

    #[test]
    fn speaker_hover_uses_the_statement_actor_revision() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"日富美":{"names":["日富美"],"slots":{"avatar":{"default":"default","items":{"default":{"storage":"avatars","path":"日富美.png"}}}}}},
            "storage":{"avatars":{"kind":"image-dir","base":"assets/avatar"}}
        }"#;
        let mut service = LanguageService::default();
        service
            .update_pack_manifests(1, &[manifest.to_string()])
            .unwrap();
        service.set_pack_base_urls(
            1,
            HashMap::from([(
                "ba".to_string(),
                Url::parse("file:///tmp/untrusted/").unwrap(),
            )]),
        );
        assert!(service.pack_base_urls.is_empty());
        service.set_pack_base_urls(
            1,
            HashMap::from([(
                "ba".to_string(),
                Url::parse("https://example.test/ba_kivo/").unwrap(),
            )]),
        );
        service.open(
            uri(),
            1,
            "> 日富美: first\n@actor 日富美\ndisplay-name: \"小鸟游日富美](https://evil.test/pixel)![\"\nalso-as: [hifumi]\n@end\n> hifumi: second".to_string(),
        );

        let first = service.hover(&uri(), Position::new(0, 3)).unwrap();
        let second = service.hover(&uri(), Position::new(5, 3)).unwrap();
        let HoverContents::Markup(first) = first.contents else {
            panic!()
        };
        let HoverContents::Markup(second) = second.contents else {
            panic!()
        };
        assert!(first.value.contains("**日富美**"));
        assert!(first.value.contains("revision 0"));
        assert!(
            second
                .value
                .contains("**小鸟游日富美\\]\\(https://evil\\.test/pixel\\)\\!\\[**")
        );
        assert!(second.value.contains("revision 1"));
        assert!(
            second
                .value
                .contains("https://example.test/ba_kivo/assets/avatar/")
        );
        assert!(second.value.contains("%E6%97%A5%E5%AF%8C%E7%BE%8E.png"));
        assert_eq!(
            second.value.matches("](").count(),
            1,
            "only the fixed avatar target is allowed"
        );
    }

    #[test]
    fn speaker_references_complete_and_hover_with_the_current_revision() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{
                "A":{"names":["A"],"display_name":"Actor A"},
                "B":{"names":["B"],"display_name":"Actor B"}
            }
        }"#;
        let mut service = LanguageService::default();
        service
            .update_pack_manifests(1, &[manifest.to_string()])
            .unwrap();
        let prefix = "> A: first\n> B: second\n@actor A\ndisplay-name: \"Revised A\"\n@end\n";
        let future = "\n@actor A\ndisplay-name: \"Future A\"\n@end";
        service.open(uri(), 1, format!("{prefix}> _{future}"));
        let completions = service.completions(&uri(), Position::new(5, 3));
        let back_ref = completions
            .iter()
            .find(|item| item.label == "_")
            .expect("missing recent-distinct reference");
        assert_eq!(
            back_ref.detail.as_deref(),
            Some("speaker reference → Revised A · A")
        );
        assert_eq!(
            completions
                .iter()
                .find(|item| item.label == "_1")
                .and_then(|item| item.detail.as_deref()),
            Some("speaker reference → Revised A · A")
        );
        assert_eq!(
            completions
                .iter()
                .find(|item| item.label == "_0")
                .and_then(|item| item.detail.as_deref()),
            Some("speaker reference → Actor B · B")
        );
        assert_eq!(
            completions
                .iter()
                .find(|item| item.label == "~")
                .and_then(|item| item.detail.as_deref()),
            Some("speaker reference → Revised A · A")
        );

        service.change(uri(), 2, format!("{prefix}> _: third{future}"));
        let hover = service.hover(&uri(), Position::new(5, 2)).unwrap();
        let HoverContents::Markup(contents) = hover.contents else {
            panic!("expected markdown hover");
        };
        assert!(contents.value.contains("**Revised A**"));
        assert!(contents.value.contains("Reference ` _ ` → ` Revised A `"));
    }
    #[test]
    fn completes_and_hovers_resolved_ordinal_resource_markers() {
        let manifest = r#"{
            "schema":"mmt-pack.v3",
            "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
            "entities":{"晴_露营":{"names":["晴_露营"],"slots":{"sticker":{"default":"default","sets":{"default":{"storage":"stickers","variants":[{"id":"default_001","ordinal":1,"path":"001.png"}]}}}}}},
            "thumbnails":{"晴_露营/sticker/default/default_001":{"storage":"thumbnail_images","path":"晴_露营/default/001.webp"}},
            "storage":{"stickers":{"kind":"image-dir","base":"assets"},"thumbnail_images":{"kind":"image-dir","base":"thumbnails"}}
        }"#;
        let mut service = LanguageService::default();
        service
            .update_pack_manifests(1, &[manifest.to_string()])
            .unwrap();
        assert!(service.set_pack_base_urls(
            1,
            HashMap::from([(
                "ba".to_string(),
                Url::parse("https://packs.example.test/ba/").unwrap(),
            )]),
        ));

        let partial = "> 晴_露营: [:晴_露营,#";
        service.open(uri(), 1, partial.to_string());
        let completions = service.completions(
            &uri(),
            Position::new(0, partial.encode_utf16().count() as u32),
        );
        let ordinal = completions
            .iter()
            .find(|item| item.label == "#1")
            .expect("missing ordinal resource completion");
        assert_eq!(
            ordinal.detail.as_deref(),
            Some("sticker · ba::晴_露营 · default_001")
        );
        let Some(lsp_types::Documentation::MarkupContent(documentation)) = &ordinal.documentation
        else {
            panic!("expected markdown sticker preview");
        };
        assert_eq!(
            documentation.value,
            "![Sticker preview](https://packs.example.test/ba/thumbnails/%E6%99%B4_%E9%9C%B2%E8%90%A5/default/001.webp)"
        );

        let complete = "> 晴_露营: [:晴_露营,#1:]";
        service.change(uri(), 2, complete.to_string());
        let hover_character = complete[..complete.find("#1").unwrap() + 1]
            .encode_utf16()
            .count() as u32;
        let hover = service
            .hover(&uri(), Position::new(0, hover_character))
            .unwrap();
        let HoverContents::Markup(contents) = hover.contents else {
            panic!("expected markdown hover");
        };
        assert!(contents.value.contains("Sticker `default\\_001`"));
        assert!(contents.value.contains("entity `ba::晴\\_露营`"));
    }

    #[test]
    fn emits_semantic_tokens_for_mmt_identities_without_tokenizing_typst() {
        let mut service = LanguageService::default();
        service
            .update_pack_manifests(
                1,
                &[r#"{
                    "schema":"mmt-pack.v3",
                    "pack":{"namespace":"ba","name":"BA fixture","version":"1","type":"base"},
                    "entities":{"晴":{"names":["晴"]}}
                }"#
                .to_string()],
            )
            .unwrap();
        service.open(
            uri(),
            1,
            "@mode: typst\n- #box[Typst]\n@mode: text\n> 晴: [:#1:](width: 1em)".to_string(),
        );
        let tokens = service.semantic_tokens(&uri()).unwrap();
        assert!(tokens.data.iter().any(|token| token.token_type == 0));
        assert!(tokens.data.iter().any(|token| token.token_type == 1));
        assert!(tokens.data.iter().any(|token| token.token_type == 2));
        let resource = tokens
            .data
            .iter()
            .find(|token| token.token_type == 2)
            .unwrap();
        assert_eq!(
            resource.length, 2,
            "resource token must stop before the Typst patch"
        );
        assert_eq!(
            tokens.data.len(),
            4,
            "Typst tokens remain owned by TextMate/Tinymist"
        );
    }
}
