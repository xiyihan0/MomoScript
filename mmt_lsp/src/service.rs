use std::collections::HashMap;

use lsp_types::{
    CompletionItem, CompletionItemKind, CompletionTextEdit, Diagnostic,
    DiagnosticRelatedInformation, DiagnosticSeverity, DocumentSymbol, FoldingRange,
    FoldingRangeKind, Location, Position, PositionEncodingKind, SymbolKind, TextEdit, Url,
};
use mmt_rs::diag::{Diagnostic as MmtDiagnostic, Severity};
use mmt_rs::pack::{PackManifest, PackRegistry};
use mmt_rs::source::TextRange;
use mmt_rs::syntax::{SyntaxDocument, SyntaxNode};

use crate::position::LineIndex;

#[derive(Debug, Clone)]
pub struct DocumentSnapshot {
    pub version: i32,
    pub revision: u64,
    pub text: String,
    pub syntax: SyntaxDocument,
    pub lines: LineIndex,
}

impl DocumentSnapshot {
    fn new(version: i32, revision: u64, text: String) -> Self {
        let syntax = mmt_rs::parse_text(&text);
        let lines = LineIndex::new(&text);
        Self {
            version,
            revision,
            text,
            syntax,
            lines,
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
}

impl Default for LanguageService {
    fn default() -> Self {
        Self {
            documents: HashMap::new(),
            next_revision: 1,
            encoding: PositionEncodingKind::UTF16,
            pack_revision: 0,
            pack_registry: None,
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
        self.pack_registry = Some(registry);
        self.pack_revision = revision;
        Ok(true)
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
        self.documents
            .insert(uri.clone(), DocumentSnapshot::new(version, revision, text));
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
        document
            .syntax
            .diagnostics
            .iter()
            .filter_map(|diagnostic| self.diagnostic(uri, document, diagnostic))
            .collect()
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
        document
            .syntax
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
        document
            .syntax
            .nodes
            .iter()
            .filter_map(|node| self.folding_range(document, node))
            .collect()
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
                    ("@mode", "change the following content mode"),
                    ("@typ", "insert checked Typst content"),
                    ("@reply", "render reply options"),
                    ("@bond", "render a bond event"),
                    ("@end", "close the current block"),
                ],
                CompletionItemKind::KEYWORD,
            );
        }

        let Some(block_name) = document.syntax.nodes.iter().find_map(|node| match node {
            SyntaxNode::DirectiveBlock(block)
                if block.range.start <= offset && offset <= block.range.end =>
            {
                Some(block.name.as_str())
            }
            _ => None,
        }) else {
            return Vec::new();
        };
        if block_name == "actor"
            && let Some((field, value_prefix)) = trimmed.split_once(':')
            && field.trim() == "preset"
        {
            let replace_start = offset - value_prefix.trim_start().len();
            return self.preset_completions(document, replace_start, offset);
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
            _ => return Vec::new(),
        };
        let token_start = offset
            - before_cursor
                .chars()
                .rev()
                .take_while(|ch| ch.is_alphanumeric() || *ch == '-')
                .map(char::len_utf8)
                .sum::<usize>();
        completion_items(
            document,
            &self.encoding,
            token_start,
            offset,
            fields,
            CompletionItemKind::FIELD,
        )
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
}
