pub mod diag;
pub mod emit;
pub mod inline;
pub mod pack;
pub mod parser;
pub mod semantic;
pub mod source;
pub mod syntax;
pub mod typst_check;

pub use parser::{parse_document, parse_text};
pub use semantic::{
    ActorId, ActorLowering, ActorRevision, ActorState, BodyModeResolution, CharacterPreset,
    CharacterPresetCatalog, PresetLookup, ResolvedBodyMode, ResolvedBodyModeEntry,
    ResolvedStatementSpeaker, ScriptActor, StaticPresetCatalog, lower_actors, resolve_body_modes,
};
