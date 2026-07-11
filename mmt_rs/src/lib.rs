pub mod diag;
pub mod emit;
pub mod inline;
pub mod pack;
pub mod parser;
pub mod semantic;
pub mod source;
pub mod syntax;
pub mod typst_check;

pub use emit::{
    BuiltinPresentation, EmitOptions, EmittedTypst, MaterializedContent, SourceMapEntry, emit_typst,
};
pub use parser::{parse_document, parse_text};
pub use semantic::{
    ActorId, ActorLowering, ActorLoweringOptions, ActorRevision, ActorState, BodyModeResolution,
    BuiltinSpeakerId, CharacterPreset, CharacterPresetCatalog, PresetLookup, ResolvedBodyMode,
    ResolvedBodyModeEntry, ResolvedStatementSpeaker, ScriptActor, SpeakerIdentity,
    StaticPresetCatalog, lower_actors, lower_actors_with_options, resolve_body_modes,
};
pub use typst_check::{
    TypstCheckConfig, TypstOverlayScan, check_typst_args, check_typst_source,
    scan_typst_overlay_macros,
};
