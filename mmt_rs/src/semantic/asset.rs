use std::collections::HashMap;

use crate::diag::{Diagnostic, DiagnosticPhase, Severity};
use crate::inline::{DeclarationValueSyntax, parse_declaration_value};
use crate::source::TextRange;
use crate::syntax::{
    DirectiveBlockSyntax, DirectiveItemSyntax, DirectiveLineSyntax, FieldSyntax, SyntaxDocument,
    SyntaxNode,
};

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct AssetId {
    pub namespace: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetSource {
    Url(String),
    LocalFile(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptAsset {
    pub id: AssetId,
    pub source: AssetSource,
    pub range: TextRange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetLowering {
    pub assets: Vec<ScriptAsset>,
    pub diagnostics: Vec<Diagnostic>,
}

impl AssetLowering {
    pub fn resolve(&self, name: &str) -> Option<&ScriptAsset> {
        self.assets.iter().find(|asset| asset.id.name == name)
    }
}

pub fn lower_assets(document: &SyntaxDocument) -> AssetLowering {
    AssetLowerer::default().lower(document)
}

#[derive(Default)]
struct AssetLowerer {
    assets: Vec<ScriptAsset>,
    names: HashMap<String, TextRange>,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Default)]
struct AssetDraft {
    name: Option<(String, TextRange)>,
    namespace: Option<(String, TextRange)>,
    source: Option<(String, TextRange)>,
}

impl AssetLowerer {
    fn lower(mut self, document: &SyntaxDocument) -> AssetLowering {
        for node in &document.nodes {
            let draft = match node {
                SyntaxNode::DirectiveBlock(block) if block.name == "asset" => {
                    self.parse_block(block)
                }
                SyntaxNode::DirectiveLine(line) if line.name == "asset" => self.parse_line(line),
                _ => continue,
            };
            if let Some(draft) = draft {
                self.register(draft);
            }
        }
        AssetLowering {
            assets: self.assets,
            diagnostics: self.diagnostics,
        }
    }

    fn parse_block(&mut self, block: &DirectiveBlockSyntax) -> Option<AssetDraft> {
        let start = self.diagnostics.len();
        let name = match block.head_args.as_slice() {
            [name] => self.parse_scalar(&name.raw, name.range, "asset name"),
            [] => {
                self.error("@asset block requires one asset name", block.range);
                None
            }
            _ => {
                self.error("@asset block accepts exactly one asset name", block.range);
                None
            }
        };
        let mut draft = AssetDraft {
            name,
            ..AssetDraft::default()
        };
        let mut fields = HashMap::new();

        for item in &block.items {
            let DirectiveItemSyntax::Field(field) = item else {
                if let DirectiveItemSyntax::Body(body) = item {
                    self.error("@asset block accepts fields only", body.range);
                }
                continue;
            };
            if fields
                .insert(field.name.clone(), field.name_range)
                .is_some()
            {
                self.error(
                    format!("duplicate @asset field '{}'", field.name),
                    field.name_range,
                );
                continue;
            }
            self.apply_field(&mut draft, field);
        }

        (self.diagnostics.len() == start).then_some(draft)
    }

    fn parse_line(&mut self, line: &DirectiveLineSyntax) -> Option<AssetDraft> {
        let start = self.diagnostics.len();
        let Some(payload) = &line.payload else {
            self.error("@asset: requires a name and source", line.range);
            return None;
        };
        let tokens = tokenize_short_asset(&payload.source, payload.range.start);
        let Some(first) = tokens.first() else {
            self.error("@asset: requires an asset name", payload.range);
            return None;
        };
        let mut draft = AssetDraft {
            name: self.parse_scalar(&first.raw, first.range, "asset name"),
            ..AssetDraft::default()
        };
        let mut index = 1;
        while index < tokens.len() {
            let token = &tokens[index];
            let field = token
                .raw
                .split_once(':')
                .filter(|(key, _)| matches!(*key, "src" | "ns"));
            if let Some((key, inline_value)) = field {
                let (raw, range) = if inline_value.is_empty() {
                    index += 1;
                    let Some(value) = tokens.get(index) else {
                        self.error(
                            format!("@asset field '{key}' requires a value"),
                            token.range,
                        );
                        break;
                    };
                    (value.raw.as_str(), value.range)
                } else {
                    let value_start = token.range.end - inline_value.len();
                    (inline_value, TextRange::new(value_start, token.range.end))
                };
                self.apply_short_field(&mut draft, key, raw, range);
            } else if draft.source.is_none() && index == 1 {
                draft.source = self.parse_scalar(&token.raw, token.range, "asset source");
            } else if let Some((key, _)) = token.raw.split_once(':') {
                self.error(format!("unknown @asset field '{key}'"), token.range);
            } else {
                self.error("unexpected @asset short-form argument", token.range);
            }
            index += 1;
        }
        (self.diagnostics.len() == start).then_some(draft)
    }

    fn apply_field(&mut self, draft: &mut AssetDraft, field: &FieldSyntax) {
        match field.name.as_str() {
            "src" => {
                draft.source = self.parse_scalar(&field.value, field.value_range, "asset source")
            }
            "ns" => {
                draft.namespace =
                    self.parse_scalar(&field.value, field.value_range, "asset namespace")
            }
            _ => self.error(
                format!("unknown @asset field '{}'", field.name),
                field.name_range,
            ),
        }
    }

    fn apply_short_field(
        &mut self,
        draft: &mut AssetDraft,
        key: &str,
        raw: &str,
        range: TextRange,
    ) {
        let target = match key {
            "src" => &mut draft.source,
            "ns" => &mut draft.namespace,
            _ => unreachable!(),
        };
        if target.is_some() {
            self.error(format!("duplicate @asset field '{key}'"), range);
        } else {
            *target = self.parse_scalar(raw, range, "asset field");
        }
    }

    fn parse_scalar(
        &mut self,
        raw: &str,
        range: TextRange,
        description: &str,
    ) -> Option<(String, TextRange)> {
        let parsed = parse_declaration_value(raw, range.start);
        self.diagnostics.extend(
            parsed
                .diagnostics
                .into_iter()
                .map(|diagnostic| semantic_error(diagnostic.message, diagnostic.range)),
        );
        match parsed.value {
            Some(DeclarationValueSyntax::Scalar(value)) if !value.value.is_empty() => {
                Some((value.value, value.range))
            }
            Some(DeclarationValueSyntax::List { .. }) => {
                self.error(format!("{description} must be a scalar"), range);
                None
            }
            _ => None,
        }
    }

    fn register(&mut self, draft: AssetDraft) {
        let Some((name, name_range)) = draft.name else {
            return;
        };
        let Some((raw_source, source_range)) = draft.source else {
            self.error("@asset requires a src field", name_range);
            return;
        };
        let namespace = draft
            .namespace
            .map(|(namespace, _)| namespace)
            .unwrap_or_else(|| "custom".to_string());
        if !valid_namespace(&namespace) {
            self.error("invalid asset namespace", name_range);
            return;
        }
        if !valid_asset_name(&name) {
            self.error("invalid asset name", name_range);
            return;
        }
        if let Some(previous) = self.names.get(&name) {
            self.diagnostics.push(
                semantic_error(format!("duplicate asset name '{name}'"), name_range)
                    .with_label(*previous, "first declaration is here"),
            );
            return;
        }
        let Some(source) = parse_asset_source(&raw_source, source_range, &mut self.diagnostics)
        else {
            return;
        };
        self.names.insert(name.clone(), name_range);
        self.assets.push(ScriptAsset {
            id: AssetId { namespace, name },
            source,
            range: TextRange::new(name_range.start, source_range.end),
        });
    }

    fn error(&mut self, message: impl Into<String>, range: TextRange) {
        self.diagnostics.push(semantic_error(message, range));
    }
}

#[derive(Debug)]
struct ShortToken {
    raw: String,
    range: TextRange,
}

fn tokenize_short_asset(text: &str, absolute_start: usize) -> Vec<ShortToken> {
    let mut tokens = Vec::new();
    let mut start = None;
    let mut quote = None;
    let mut escaped = false;
    for (offset, ch) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            start.get_or_insert(offset);
            escaped = true;
            continue;
        }
        if let Some(active) = quote {
            if ch == active {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            start.get_or_insert(offset);
            quote = Some(ch);
        } else if ch.is_whitespace() {
            if let Some(token_start) = start.take() {
                push_token(text, absolute_start, token_start, offset, &mut tokens);
            }
        } else {
            start.get_or_insert(offset);
        }
    }
    if let Some(token_start) = start {
        push_token(text, absolute_start, token_start, text.len(), &mut tokens);
    }
    tokens
}

fn push_token(
    text: &str,
    absolute_start: usize,
    start: usize,
    end: usize,
    tokens: &mut Vec<ShortToken>,
) {
    tokens.push(ShortToken {
        raw: text[start..end].to_string(),
        range: TextRange::new(absolute_start + start, absolute_start + end),
    });
}

fn parse_asset_source(
    raw: &str,
    range: TextRange,
    diagnostics: &mut Vec<Diagnostic>,
) -> Option<AssetSource> {
    if raw.starts_with("https://") || raw.starts_with("http://") {
        return Some(AssetSource::Url(raw.to_string()));
    }
    if raw.contains('/') || raw.contains('\\') || raw == "." || raw == ".." {
        diagnostics.push(semantic_error(
            "local asset src must be a sanitized basename",
            range,
        ));
        return None;
    }
    Some(AssetSource::LocalFile(raw.to_string()))
}

fn valid_namespace(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_alphanumeric() || ch == '_' || ch == '-')
}

fn valid_asset_name(value: &str) -> bool {
    !value.is_empty()
        && !value.chars().any(char::is_whitespace)
        && !value.contains('/')
        && !value.contains(':')
}

fn semantic_error(message: impl Into<String>, range: TextRange) -> Diagnostic {
    Diagnostic::new(
        Severity::Error,
        DiagnosticPhase::Semantic,
        message,
        Some(range),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_text;

    #[test]
    fn block_assets_default_to_custom_namespace() {
        let document = parse_text(
            "@asset hero\n\
             src: https://example.com/hero.png\n\
             @end",
        );
        let lowered = lower_assets(&document);

        assert!(
            lowered.diagnostics.is_empty(),
            "diagnostics: {:?}",
            lowered.diagnostics
        );
        assert_eq!(lowered.assets.len(), 1);
        assert_eq!(lowered.assets[0].id.namespace, "custom");
        assert_eq!(lowered.assets[0].id.name, "hero");
        assert!(matches!(lowered.assets[0].source, AssetSource::Url(_)));
    }

    #[test]
    fn short_asset_forms_share_the_block_semantics() {
        let document = parse_text(
            "@asset: first https://example.com/1.png\n\
             @asset: second ns:project src:\"https://example.com/a b.png\"",
        );
        let lowered = lower_assets(&document);

        assert!(
            lowered.diagnostics.is_empty(),
            "diagnostics: {:?}",
            lowered.diagnostics
        );
        assert_eq!(lowered.assets.len(), 2);
        assert_eq!(lowered.assets[1].id.namespace, "project");
        assert!(matches!(
            &lowered.assets[1].source,
            AssetSource::Url(url) if url.ends_with("a b.png")
        ));
    }

    #[test]
    fn duplicate_names_missing_sources_and_unknown_fields_are_errors() {
        let document = parse_text(
            "@asset same\n\
             src: one.png\n\
             @end\n\
             @asset same\n\
             src: two.png\n\
             @end\n\
             @asset missing\n\
             ns: custom\n\
             @end\n\
             @asset bad\n\
             source: nope.png\n\
             @end",
        );
        let lowered = lower_assets(&document);

        assert_eq!(lowered.assets.len(), 1);
        assert_eq!(lowered.diagnostics.len(), 3);
    }

    #[test]
    fn local_asset_sources_reject_paths_and_traversal() {
        let document = parse_text(
            "@asset nested\n\
             src: images/a.png\n\
             @end\n\
             @asset traversal\n\
             src: ../secret.png\n\
             @end",
        );
        let lowered = lower_assets(&document);

        assert!(lowered.assets.is_empty());
        assert_eq!(lowered.diagnostics.len(), 2);
    }
}
