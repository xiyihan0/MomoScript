pub mod analysis;
pub mod diag;
pub mod emit;
pub mod inline;
pub mod identity;
pub mod materialize;
pub mod pack;
pub mod parser;
pub mod pipeline;
pub mod project;
pub mod projection;
pub mod resolve;
pub mod semantic;
pub mod source;
pub mod syntax;
pub mod typst_check;

pub use analysis::{
    ANALYSIS_SCHEMA, AnalysisDiagnostic, AnalysisLabel, AnalysisReport, AstReport, SourceSpan,
    analyze_text_json, analyze_text_wasm,
};
pub use emit::{
    BuiltinPresentation, EmitOptions, EmittedTypst, MaterializedContent, SourceMapEntry, emit_typst,
};
pub use identity::{
    CanonicalIdentityError, LogicalProjectFileId, LogicalSourceId, MaterializationKey,
    ProjectDigestInput, ProjectionKey, RenderKey, RuntimeArtifactKey, SourceContentKey,
    SourceStaleToken, TypstProjectSnapshotKey, canonical_relative_path, derived_key,
    project_snapshot_key, runtime_artifact_key, source_content_key,
};
pub use materialize::{
    Materialization, MaterializeError, MaterializedImage, ResourceMaterializer,
    materialize_resources,
};
pub use parser::{parse_document, parse_text};
pub use pipeline::{
    AnalyzedDocument, Compilation, CompilationFailure, analyze_text, analyze_text_with_pack,
    compile_text, compile_text_strict,
};
pub use project::{ProjectMaterializer, ProjectMaterializerOptions, export_template_library};
pub use projection::{
    MappingMode, PROJECTION_PLACEHOLDER_IMAGE, ProjectedResource, ProjectedResourceSource,
    ProjectionEdit, ProjectionError, ProjectionIndex, ProjectionKind, ProjectionSegment,
    TypstProjection, diagnose_analyzed, diagnose_analyzed_with_pack, diagnose_text,
    diagnose_text_with_pack, project_analyzed, project_analyzed_with_pack, project_text,
    project_text_with_pack,
};
pub use resolve::{
    PackStorageSource, ResolvedResource, ResolvedResourceKind, ResourceFailure, ResourceResolution,
    ResourceTarget, resolve_actor_avatars, resolve_resources,
};
pub use semantic::{
    ActorId, ActorLowering, ActorLoweringOptions, ActorRevision, ActorState, AssetId,
    AssetLowering, AssetSource, BodyModeResolution, BuiltinSpeakerId, CharacterPreset,
    CharacterPresetCatalog, CompiledAtConfig, DEFAULT_COMPILED_AT_FORMAT, DocumentConfig,
    DocumentLowering, DocumentOverrides, DocumentPresentation, DocumentTimezone, HostTimestamp,
    PresetLookup, ResolvedBodyMode, ResolvedBodyModeEntry, ResolvedResourceMarker,
    ResolvedStatementSpeaker, ResourceLowering, ResourceSelector, ScriptActor, ScriptAsset,
    SpeakerIdentity, StaticPresetCatalog, SubjectRef, VariantSelector, lower_actors,
    lower_actors_with_options, lower_assets, lower_document, lower_resource_markers,
    resolve_body_modes, resolve_document_presentation,
};
pub use typst_check::{
    TypstCheckConfig, TypstOverlayScan, check_typst_args, check_typst_source,
    scan_typst_overlay_macros,
};
