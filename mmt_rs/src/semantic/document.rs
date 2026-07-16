use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, UtcOffset, format_description};

use crate::diag::{Diagnostic, DiagnosticPhase, Severity};
use crate::inline::{DeclarationLiteralSyntax, DeclarationValueSyntax, parse_declaration_value};
use crate::source::TextRange;
use crate::syntax::{
    DirectiveBlockSyntax, DirectiveItemSyntax, FieldSyntax, SyntaxDocument, SyntaxNode,
};

pub const DEFAULT_COMPILED_AT_FORMAT: &str = "[year]-[month]-[day] [hour]:[minute]:[second]";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentConfig {
    pub title: String,
    pub author: Option<String>,
    pub show_header: bool,
    pub compiled_at: CompiledAtConfig,
}

impl Default for DocumentConfig {
    fn default() -> Self {
        Self {
            title: "无题".to_string(),
            author: None,
            show_header: true,
            compiled_at: CompiledAtConfig::Hidden,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompiledAtConfig {
    Hidden,
    Manual(String),
    Auto {
        format: String,
        timezone: DocumentTimezone,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocumentTimezone {
    Local,
    FixedOffsetMinutes(i16),
}

impl std::str::FromStr for DocumentTimezone {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "local" => Ok(Self::Local),
            "utc" | "Z" => Ok(Self::FixedOffsetMinutes(0)),
            raw => parse_fixed_offset(raw).map(Self::FixedOffsetMinutes),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentLowering {
    pub config: DocumentConfig,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTimestamp {
    pub unix_millis: i64,
    pub local_offset_minutes: i16,
}

impl HostTimestamp {
    pub fn new(unix_millis: i64, local_offset_minutes: i16) -> Result<Self, String> {
        validate_offset_minutes(local_offset_minutes)?;
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(unix_millis) * 1_000_000)
            .map_err(|error| format!("host timestamp is out of range: {error}"))?;
        Ok(Self {
            unix_millis,
            local_offset_minutes,
        })
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DocumentOverrides {
    pub title: Option<String>,
    pub author: Option<String>,
    pub show_header: Option<bool>,
    pub compiled_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DocumentPresentation {
    pub title: String,
    pub author: Option<String>,
    pub show_header: bool,
    pub compiled_at: Option<String>,
}

pub fn lower_document(document: &SyntaxDocument) -> DocumentLowering {
    DocumentLowerer::default().lower(document)
}

pub fn resolve_document_presentation(
    config: &DocumentConfig,
    overrides: &DocumentOverrides,
    timestamp: Option<HostTimestamp>,
) -> Result<DocumentPresentation, String> {
    let compiled_at = if let Some(value) = &overrides.compiled_at {
        Some(value.clone())
    } else {
        match &config.compiled_at {
            CompiledAtConfig::Hidden => None,
            CompiledAtConfig::Manual(value) => Some(value.clone()),
            CompiledAtConfig::Auto { format, timezone } => timestamp
                .map(|timestamp| format_timestamp(timestamp, format, *timezone))
                .transpose()?,
        }
    };

    Ok(DocumentPresentation {
        title: overrides
            .title
            .clone()
            .unwrap_or_else(|| config.title.clone()),
        author: overrides.author.clone().or_else(|| config.author.clone()),
        show_header: overrides.show_header.unwrap_or(config.show_header),
        compiled_at,
    })
}

fn format_timestamp(
    timestamp: HostTimestamp,
    format: &str,
    timezone: DocumentTimezone,
) -> Result<String, String> {
    let datetime =
        OffsetDateTime::from_unix_timestamp_nanos(i128::from(timestamp.unix_millis) * 1_000_000)
            .map_err(|error| format!("host timestamp is out of range: {error}"))?;
    let offset_minutes = match timezone {
        DocumentTimezone::Local => timestamp.local_offset_minutes,
        DocumentTimezone::FixedOffsetMinutes(minutes) => minutes,
    };
    let offset = UtcOffset::from_whole_seconds(i32::from(offset_minutes) * 60)
        .map_err(|error| format!("host timezone offset is invalid: {error}"))?;
    let description = format_description::parse_borrowed::<2>(format)
        .map_err(|error| format!("compiled-at format is invalid: {error}"))?;
    datetime
        .to_offset(offset)
        .format(&description)
        .map_err(|error| format!("could not format compiled-at: {error}"))
}

#[derive(Default)]
struct DocumentLowerer {
    config: DocumentConfig,
    diagnostics: Vec<Diagnostic>,
    first_document: Option<TextRange>,
    seen_renderable: bool,
}

impl DocumentLowerer {
    fn lower(mut self, document: &SyntaxDocument) -> DocumentLowering {
        for node in &document.nodes {
            match node {
                SyntaxNode::DirectiveBlock(block) if block.name == "document" => {
                    self.lower_block(block);
                }
                SyntaxNode::DirectiveLine(line) if line.name == "document" => {
                    self.diagnostics.push(semantic_error(
                        "@document requires an aggregated block ending with @end",
                        line.range,
                    ));
                }
                SyntaxNode::Statement(_) | SyntaxNode::Reply(_) | SyntaxNode::Bond(_) => {
                    self.seen_renderable = true;
                }
                SyntaxNode::DirectiveLine(line) if line.name == "typ" => {
                    self.seen_renderable = true;
                }
                SyntaxNode::DirectiveBlock(block) if block.name == "typ" => {
                    self.seen_renderable = true;
                }
                _ => {}
            }
        }
        DocumentLowering {
            config: self.config,
            diagnostics: self.diagnostics,
        }
    }

    fn lower_block(&mut self, block: &DirectiveBlockSyntax) {
        if let Some(first) = self.first_document {
            self.diagnostics.push(
                semantic_error("duplicate @document declaration", block.name_range)
                    .with_label(first, "first @document declaration is here"),
            );
            return;
        }
        self.first_document = Some(block.name_range);

        if self.seen_renderable {
            self.diagnostics.push(semantic_error(
                "@document must appear before renderable content",
                block.name_range,
            ));
        }
        if let Some(argument) = block.head_args.first() {
            self.diagnostics.push(semantic_error(
                "@document does not accept positional arguments",
                argument.range,
            ));
        }
        if let Some(patch) = &block.patch {
            self.diagnostics.push(semantic_error(
                "@document does not accept a patch",
                patch.range,
            ));
        }

        let mut fields = HashMap::<String, TextRange>::new();
        let mut compiled_at = None;
        let mut compiled_at_format = None;
        let mut timezone = None;

        for item in &block.items {
            let DirectiveItemSyntax::Field(field) = item else {
                if let DirectiveItemSyntax::Body(body) = item {
                    self.diagnostics.push(semantic_error(
                        "@document accepts only key: value fields",
                        body.range,
                    ));
                }
                continue;
            };
            if let Some(first) = fields.get(&field.name) {
                self.diagnostics.push(
                    semantic_error(
                        format!("duplicate @document field '{}'", field.name),
                        field.name_range,
                    )
                    .with_label(*first, "first field is here"),
                );
                continue;
            }
            fields.insert(field.name.clone(), field.name_range);

            match field.name.as_str() {
                "title" => {
                    if let Some(value) = self.parse_scalar(field, "document title") {
                        if value.value.is_empty() {
                            self.diagnostics.push(semantic_error(
                                "document title cannot be empty",
                                value.range,
                            ));
                        } else {
                            self.config.title = value.value;
                        }
                    }
                }
                "author" => {
                    if let Some(value) = self.parse_scalar(field, "document author") {
                        if value.value.is_empty() {
                            self.diagnostics.push(semantic_error(
                                "document author cannot be empty",
                                value.range,
                            ));
                        } else {
                            self.config.author = Some(value.value);
                        }
                    }
                }
                "show-header" => {
                    if let Some(value) = self.parse_scalar(field, "show-header") {
                        if value.quote.is_some() {
                            self.diagnostics.push(semantic_error(
                                "show-header must be the unquoted boolean true or false",
                                value.range,
                            ));
                        } else {
                            match value.value.as_str() {
                                "true" => self.config.show_header = true,
                                "false" => self.config.show_header = false,
                                _ => self.diagnostics.push(semantic_error(
                                    "show-header must be true or false",
                                    value.range,
                                )),
                            }
                        }
                    }
                }
                "compiled-at" => {
                    compiled_at = self.parse_scalar(field, "compiled-at");
                }
                "compiled-at-format" => {
                    compiled_at_format = self.parse_scalar(field, "compiled-at-format");
                }
                "timezone" => {
                    timezone = self.parse_scalar(field, "timezone");
                }
                _ => self.diagnostics.push(semantic_error(
                    format!("unknown @document field '{}'", field.name),
                    field.name_range,
                )),
            }
        }

        self.finish_compiled_at(compiled_at, compiled_at_format, timezone);
    }

    fn finish_compiled_at(
        &mut self,
        compiled_at: Option<DeclarationLiteralSyntax>,
        format: Option<DeclarationLiteralSyntax>,
        timezone: Option<DeclarationLiteralSyntax>,
    ) {
        let auto = compiled_at
            .as_ref()
            .is_some_and(|value| value.quote.is_none() && value.value == "auto");

        if !auto {
            if let Some(value) = &format {
                self.diagnostics.push(semantic_error(
                    "compiled-at-format requires compiled-at: auto",
                    value.range,
                ));
            }
            if let Some(value) = &timezone {
                self.diagnostics.push(semantic_error(
                    "timezone requires compiled-at: auto",
                    value.range,
                ));
            }
        }

        let Some(compiled_at) = compiled_at else {
            self.config.compiled_at = CompiledAtConfig::Hidden;
            return;
        };
        if compiled_at.quote.is_none() && compiled_at.value == "none" {
            self.config.compiled_at = CompiledAtConfig::Hidden;
            return;
        }
        if !auto {
            if compiled_at.value.is_empty() {
                self.diagnostics.push(semantic_error(
                    "compiled-at text cannot be empty",
                    compiled_at.range,
                ));
                return;
            }
            self.config.compiled_at = CompiledAtConfig::Manual(compiled_at.value);
            return;
        }

        let format = format
            .map(|value| {
                if let Err(error) = format_description::parse_borrowed::<2>(&value.value) {
                    self.diagnostics.push(semantic_error(
                        format!("invalid compiled-at format: {error}"),
                        value.range,
                    ));
                }
                value.value
            })
            .unwrap_or_else(|| DEFAULT_COMPILED_AT_FORMAT.to_string());
        let timezone = timezone
            .as_ref()
            .and_then(|value| self.parse_timezone(value))
            .unwrap_or(DocumentTimezone::Local);
        self.config.compiled_at = CompiledAtConfig::Auto { format, timezone };
    }

    fn parse_timezone(&mut self, value: &DeclarationLiteralSyntax) -> Option<DocumentTimezone> {
        if value.quote.is_some() {
            self.diagnostics.push(semantic_error(
                "timezone must be an unquoted control value",
                value.range,
            ));
            return None;
        }
        match value.value.parse() {
            Ok(timezone) => Some(timezone),
            Err(message) => {
                self.diagnostics.push(semantic_error(message, value.range));
                None
            }
        }
    }

    fn parse_scalar(
        &mut self,
        field: &FieldSyntax,
        description: &str,
    ) -> Option<DeclarationLiteralSyntax> {
        let parsed = parse_declaration_value(&field.value, field.value_range.start);
        self.diagnostics.extend(
            parsed
                .diagnostics
                .into_iter()
                .map(|diagnostic| semantic_error(diagnostic.message, diagnostic.range)),
        );
        match parsed.value {
            Some(DeclarationValueSyntax::Scalar(value)) => Some(value),
            Some(DeclarationValueSyntax::List { range, .. }) => {
                self.diagnostics.push(semantic_error(
                    format!("{description} must be a scalar value"),
                    range,
                ));
                None
            }
            None => None,
        }
    }
}

fn parse_fixed_offset(raw: &str) -> Result<i16, String> {
    let bytes = raw.as_bytes();
    if bytes.len() != 6 || !matches!(bytes[0], b'+' | b'-') || bytes[3] != b':' {
        return Err("timezone must be local, utc, Z, or a fixed +HH:MM/-HH:MM offset".to_string());
    }
    let hours = raw[1..3]
        .parse::<i16>()
        .map_err(|_| "timezone hour must be numeric".to_string())?;
    let minutes = raw[4..6]
        .parse::<i16>()
        .map_err(|_| "timezone minute must be numeric".to_string())?;
    if hours > 23 || minutes > 59 {
        return Err("timezone offset is outside the supported range".to_string());
    }
    let total = hours * 60 + minutes;
    let total = if bytes[0] == b'-' { -total } else { total };
    validate_offset_minutes(total)?;
    Ok(total)
}

fn validate_offset_minutes(minutes: i16) -> Result<(), String> {
    UtcOffset::from_whole_seconds(i32::from(minutes) * 60)
        .map(|_| ())
        .map_err(|_| "timezone offset is outside the supported range".to_string())
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
    fn lowers_document_fields_and_preserves_quoted_control_words() {
        let document = parse_text(
            "@document\n\
             title: Story\n\
             author: Author\n\
             show-header: false\n\
             compiled-at: \"auto\"\n\
             @end\n\
             - hello",
        );
        assert!(document.diagnostics.is_empty());
        let lowered = lower_document(&document);
        assert!(lowered.diagnostics.is_empty());
        assert_eq!(lowered.config.title, "Story");
        assert_eq!(lowered.config.author.as_deref(), Some("Author"));
        assert!(!lowered.config.show_header);
        assert_eq!(
            lowered.config.compiled_at,
            CompiledAtConfig::Manual("auto".to_string())
        );
    }

    #[test]
    fn automatic_time_uses_fixed_host_input_and_document_timezone() {
        let document = parse_text(
            "@document\n\
             compiled-at: auto\n\
             timezone: +08:00\n\
             @end\n\
             - hello",
        );
        let lowered = lower_document(&document);
        assert!(lowered.diagnostics.is_empty());
        let timestamp = HostTimestamp::new(0, -300).unwrap();
        let presentation = resolve_document_presentation(
            &lowered.config,
            &DocumentOverrides::default(),
            Some(timestamp),
        )
        .unwrap();
        assert_eq!(
            presentation.compiled_at.as_deref(),
            Some("1970-01-01 08:00:00")
        );
        assert_eq!(
            resolve_document_presentation(&lowered.config, &DocumentOverrides::default(), None,)
                .unwrap()
                .compiled_at,
            None
        );
    }

    #[test]
    fn host_overrides_replace_only_explicit_fields() {
        let config = DocumentConfig {
            title: "Source".to_string(),
            author: Some("Source Author".to_string()),
            show_header: true,
            compiled_at: CompiledAtConfig::Auto {
                format: DEFAULT_COMPILED_AT_FORMAT.to_string(),
                timezone: DocumentTimezone::Local,
            },
        };
        let presentation = resolve_document_presentation(
            &config,
            &DocumentOverrides {
                title: Some("CLI".to_string()),
                compiled_at: Some("release build".to_string()),
                ..DocumentOverrides::default()
            },
            Some(HostTimestamp::new(0, 480).unwrap()),
        )
        .unwrap();
        assert_eq!(presentation.title, "CLI");
        assert_eq!(presentation.author.as_deref(), Some("Source Author"));
        assert!(presentation.show_header);
        assert_eq!(presentation.compiled_at.as_deref(), Some("release build"));
    }

    #[test]
    fn rejects_invalid_document_shape_fields_and_time_combinations() {
        let document = parse_text(
            "- content\n\
             @document\n\
             title: [bad]\n\
             title: duplicate\n\
             unknown: value\n\
             compiled-at: manual\n\
             compiled-at-format: [year]\n\
             timezone: +25:00\n\
             body\n\
             @end\n\
             @document\n\
             @end",
        );
        let lowered = lower_document(&document);
        let messages = lowered
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.message.as_str())
            .collect::<Vec<_>>();
        assert!(
            messages
                .iter()
                .any(|message| message.contains("before renderable"))
        );
        assert!(
            messages
                .iter()
                .any(|message| message.contains("must be a scalar"))
        );
        assert!(
            messages
                .iter()
                .any(|message| message.contains("duplicate @document field"))
        );
        assert!(
            messages
                .iter()
                .any(|message| message.contains("unknown @document field"))
        );
        assert!(
            messages
                .iter()
                .any(|message| message.contains("requires compiled-at: auto"))
        );
        assert!(
            messages
                .iter()
                .any(|message| message.contains("only key: value"))
        );
        assert!(
            messages
                .iter()
                .any(|message| message.contains("duplicate @document declaration"))
        );
    }

    #[test]
    fn rejects_invalid_auto_format_and_timezone() {
        let document = parse_text(
            "@document\n\
             compiled-at: auto\n\
             compiled-at-format: \"[unknown]\"\n\
             timezone: +24:00\n\
             @end",
        );
        let lowered = lower_document(&document);
        assert!(
            lowered
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message.contains("invalid compiled-at format"))
        );
        assert!(
            lowered
                .diagnostics
                .iter()
                .any(|diagnostic| diagnostic.message.contains("outside the supported range"))
        );
    }
}
