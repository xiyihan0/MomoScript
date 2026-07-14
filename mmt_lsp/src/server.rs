use std::collections::HashMap;

use lsp_types::{
    CompletionItem, CompletionOptions, CompletionParams, Diagnostic, DidChangeTextDocumentParams,
    DidCloseTextDocumentParams, DidOpenTextDocumentParams, DocumentSymbolParams,
    FoldingRangeParams, FoldingRangeProviderCapability, Hover, HoverProviderCapability,
    InitializeParams, InitializeResult, LogMessageParams, MessageType, OneOf, Position,
    PositionEncodingKind, PublishDiagnosticsParams, SemanticTokenType, SemanticTokensFullOptions,
    SemanticTokensLegend, SemanticTokensOptions, SemanticTokensParams,
    SemanticTokensServerCapabilities, ServerCapabilities, ServerInfo, SignatureHelpOptions,
    TextDocumentIdentifier, TextDocumentSyncCapability, TextDocumentSyncKind, Url,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{LanguageService, ProjectionStore, build_render_project};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypstPositionParams {
    text_document: TextDocumentIdentifier,
    position: Position,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapTypstCompletionParams {
    source_uri: Url,
    revision: u64,
    items: Vec<CompletionItem>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapTypstHoverParams {
    source_uri: Url,
    revision: u64,
    hover: Hover,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MapTypstDiagnosticsParams {
    source_uri: Url,
    revision: u64,
    diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetTypstProjectParams {
    uri: Url,
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
                encode(self.projections.project_position(
                    &params.text_document.uri,
                    params.position,
                    self.service.encoding(),
                ))
            }
            "mmt/mapTypstCompletion" => {
                let params: MapTypstCompletionParams = decode(params)?;
                let Some(document) = self.projections.get(&params.source_uri) else {
                    return Ok(Value::Null);
                };
                if document.revision != params.revision {
                    return Ok(Value::Null);
                }
                encode(
                    params
                        .items
                        .into_iter()
                        .filter_map(|item| {
                            document.map_completion_item(item, self.service.encoding())
                        })
                        .collect::<Vec<_>>(),
                )
            }
            "mmt/mapTypstHover" => {
                let mut params: MapTypstHoverParams = decode(params)?;
                let Some(document) = self.projections.get(&params.source_uri) else {
                    return Ok(Value::Null);
                };
                if document.revision != params.revision {
                    return Ok(Value::Null);
                }
                if let Some(range) = params.hover.range {
                    let Some(mapped) = document.typst_range_to_mmt(range, self.service.encoding())
                    else {
                        return Ok(Value::Null);
                    };
                    params.hover.range = Some(mapped);
                }
                encode(params.hover)
            }
            "mmt/mapTypstDiagnostics" => {
                let params: MapTypstDiagnosticsParams = decode(params)?;
                let Some(document) = self.projections.get(&params.source_uri) else {
                    return Ok(Value::Null);
                };
                if document.revision != params.revision {
                    return Ok(Value::Null);
                }
                encode(
                    params
                        .diagnostics
                        .into_iter()
                        .filter_map(|diagnostic| {
                            document.map_diagnostic(diagnostic, self.service.encoding())
                        })
                        .collect::<Vec<_>>(),
                )
            }
            "mmt/updateDocument" => {
                let params: DidChangeTextDocumentParams = decode(params)?;
                let uri = params.text_document.uri.clone();
                let include_template = !self.published_project_entries.contains_key(&uri);
                let events = self.notification(
                    "textDocument/didChange",
                    serde_json::to_value(params).expect("didChange params are serializable"),
                )?;
                let project = self.projections.get(&uri).map(|document| {
                    if include_template {
                        document.project_update()
                    } else {
                        document.project_delta()
                    }
                });
                encode(serde_json::json!({ "project": project, "events": events }))
            }
            "mmt/getTypstProject" => {
                let params: GetTypstProjectParams = decode(params)?;
                let Some(document) = self.projections.get(&params.uri) else {
                    return Ok(Value::Null);
                };
                let update = document.project_update();
                self.published_project_entries
                    .insert(params.uri, update.entry_uri.clone());
                encode(update)
            }
            "mmt/getTypstRenderProject" => {
                let params: GetTypstProjectParams = decode(params)?;
                let Some(document) = self.service.snapshot(&params.uri) else {
                    return Ok(Value::Null);
                };
                let Some(projection) = self.projections.get(&params.uri) else {
                    return Ok(Value::Null);
                };
                let projection_revision = projection.revision;
                let projection_entry_uri = projection.entry_uri.clone();
                let Some(packs) = self.service.pack_registry() else {
                    return Ok(Value::Null);
                };
                encode(
                    build_render_project(
                        params.uri,
                        document.version,
                        projection_revision,
                        projection_entry_uri,
                        &document.text,
                        packs,
                    )
                    .map_err(|error| {
                        ServerError::invalid_params(format!(
                            "failed to build render project: {error:?}"
                        ))
                    })?,
                )
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

        encode(InitializeResult {
            capabilities: ServerCapabilities {
                position_encoding: Some(encoding),
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                document_symbol_provider: Some(OneOf::Left(true)),
                folding_range_provider: Some(FoldingRangeProviderCapability::Simple(true)),
                completion_provider: Some(CompletionOptions {
                    trigger_characters: Some(vec![
                        "_".to_string(),
                        "~".to_string(),
                        "[".to_string(),
                        ":".to_string(),
                        ",".to_string(),
                        "#".to_string(),
                    ]),
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
        let version = document.version;
        let text = document.text.clone();
        let result = if let Some(catalog) = self.service.pack_registry() {
            self.projections.upsert(uri.clone(), version, text, catalog)
        } else {
            self.projections.upsert(
                uri.clone(),
                version,
                text,
                &mmt_rs::StaticPresetCatalog::default(),
            )
        };
        if let Err(error) = result {
            self.projections.remove(uri);
            return Some(
                ServerError {
                    code: -32603,
                    message: format!("failed to build Typst projection: {error:?}"),
                    data: Some(serde_json::json!({"uri": uri, "revision": document.revision})),
                }
                .log_event("mmt/projection"),
            );
        }
        None
    }
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
        let delta = server
            .request(
                "mmt/updateDocument",
                serde_json::json!({
                    "textDocument": {"uri": uri.clone(), "version": 8},
                    "contentChanges": [{"text": "@typ: #let x = 2"}]
                }),
            )
            .unwrap();
        assert_eq!(delta["project"]["full"], false);
        assert_eq!(delta["project"]["files"].as_array().unwrap().len(), 1);
        assert_eq!(
            delta["project"]["files"][0]["uri"],
            delta["project"]["entryUri"]
        );
        let events = delta["events"].as_array().unwrap();
        assert!(
            events
                .iter()
                .any(|event| event["method"] == "textDocument/publishDiagnostics")
        );
        assert!(
            events
                .iter()
                .any(|event| event["method"] == "mmt/typstProjectUpdated")
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
    fn atomic_update_returns_full_bundle_before_project_fetch() {
        let mut server = MmtLanguageServer::default();
        server.request("initialize", initialize(false)).unwrap();
        let uri = lsp_types::Url::parse("file:///workspace/atomic.mmt").unwrap();
        server
            .service
            .open(uri.clone(), 1, "@typ: #let x = 1".to_string());
        server.refresh_projection(&uri);

        let project = server
            .request(
                "mmt/updateDocument",
                serde_json::json!({
                    "textDocument": {"uri": uri, "version": 2},
                    "contentChanges": [{"text": "@typ: #let x = 2"}]
                }),
            )
            .unwrap();
        assert_eq!(project["project"]["full"], true);
        assert!(
            project["project"]["files"]
                .as_array()
                .unwrap()
                .iter()
                .any(|file| file.get("dataBase64").is_some())
        );
        assert!(
            project["events"]
                .as_array()
                .is_some_and(|events| !events.is_empty())
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
                    "position": {"line": 1, "character": 8}
                }),
            )
            .unwrap();
        assert_eq!(route["revision"], 1);
        let mapped = server
            .request(
                "mmt/mapTypstCompletion",
                serde_json::json!({
                    "sourceUri": uri.clone(),
                    "revision": route["revision"],
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
                    "sourceUri": uri,
                    "revision": route["revision"],
                    "items": []
                }),
            )
            .unwrap();
        assert!(stale.is_null());
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
