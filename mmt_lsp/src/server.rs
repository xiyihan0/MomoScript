use std::collections::HashMap;

use lsp_types::{
    CompletionItem, CompletionOptions, CompletionParams, Diagnostic, DidChangeTextDocumentParams,
    DidCloseTextDocumentParams, DidOpenTextDocumentParams, DocumentSymbolParams,
    FoldingRangeParams, FoldingRangeProviderCapability, Hover, HoverProviderCapability,
    InitializeParams, InitializeResult, Location, LogMessageParams, MessageType, OneOf, Position,
    PositionEncodingKind, PublishDiagnosticsParams, Range, SemanticTokenType,
    SemanticTokensFullOptions, SemanticTokensLegend, SemanticTokensOptions, SemanticTokensParams,
    SemanticTokensServerCapabilities, ServerCapabilities, ServerInfo, SignatureHelpOptions,
    TextDocumentIdentifier, TextDocumentSyncCapability, TextDocumentSyncKind, Url,
};
use mmt_rs::{
    ProjectedEditTarget, ProjectedEditTransaction, ProjectedTargetClass, ProjectionKey,
    SourceContentKey, TypstProjectSnapshotKey,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{
    LanguageService, ProjectionStore,
    position::{MmtClientPosition, PositionEncoding},
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
                        document.map_diagnostic(
                            diagnostic,
                            params.backend_encoding,
                            client_encoding,
                        )
                    })
                    .collect::<Result<Vec<_>, _>>();
                encode(mapped.ok())
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
                let update = self
                    .projections
                    .build_render_project(&params.uri, self.service.pack_revision(), timestamp)
                    .map_err(|error| {
                        ServerError::invalid_params(format!(
                            "failed to build render project: {error:?}"
                        ))
                    })?;
                encode(update)
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

    #[test]
    fn negotiates_utf8_and_emits_revision_bound_preview_requests() {
        let mut server = MmtLanguageServer::default();
        let result = server.request("initialize", initialize(true)).unwrap();
        assert_eq!(result["capabilities"]["positionEncoding"], "utf-8");
        assert_eq!(
            result["capabilities"]["completionProvider"]["triggerCharacters"],
            serde_json::json!(["_", "~", "[", ":", ",", "#"])
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

        let render: TypstRenderProjectUpdate = serde_json::from_value(
            server
                .request(
                    "mmt/getTypstRenderProject",
                    serde_json::json!({ "uri": uri }),
                )
                .unwrap(),
        )
        .unwrap();
        assert_eq!(render.source_version, 1);
        assert_eq!(render.revision, after.revision);
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
