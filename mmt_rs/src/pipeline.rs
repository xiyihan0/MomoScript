//! End-to-end language-core orchestration without platform-specific I/O.

use crate::diag::{Diagnostic, Severity};
use crate::emit::{EmitOptions, EmittedTypst, emit_typst};
use crate::materialize::{Materialization, ResourceMaterializer, materialize_resources};
use crate::pack::PackRegistry;
use crate::resolve::{ResourceResolution, resolve_actor_avatars, resolve_resources};
use crate::semantic::{
    ActorLowering, AssetLowering, BodyModeResolution, CharacterPresetCatalog, DocumentLowering,
    ResourceLowering, lower_actors, lower_assets, lower_document, lower_resource_markers,
    resolve_body_modes,
};
use crate::source::TextRange;
use crate::syntax::SyntaxDocument;
use crate::typst_check::check_typst_source;

#[derive(Debug, Clone)]
pub struct AnalyzedDocument {
    pub document: SyntaxDocument,
    pub document_config: DocumentLowering,
    pub modes: BodyModeResolution,
    pub actors: ActorLowering,
    pub assets: AssetLowering,
    pub resource_markers: ResourceLowering,
    pub resolution: Option<ResourceResolution>,
}

pub fn analyze_text(source: &str, catalog: &impl CharacterPresetCatalog) -> AnalyzedDocument {
    let document = crate::parse_text(source);
    let document_config = lower_document(&document);
    let modes = resolve_body_modes(&document);
    let actors = lower_actors(&document, catalog);
    let assets = lower_assets(&document);
    let resource_markers = lower_resource_markers(&document, &modes, &actors);
    AnalyzedDocument {
        document,
        document_config,
        modes,
        actors,
        assets,
        resource_markers,
        resolution: None,
    }
}

pub fn analyze_text_with_pack(source: &str, packs: &PackRegistry) -> AnalyzedDocument {
    let mut analysis = analyze_text(source, packs);
    let mut resolution = resolve_resources(
        &analysis.resource_markers,
        &analysis.actors,
        &analysis.assets,
        packs,
    );
    let avatars = resolve_actor_avatars(&analysis.actors, &analysis.assets, packs);
    resolution.resources.extend(avatars.resources);
    resolution.failures.extend(avatars.failures);
    resolution.diagnostics.extend(avatars.diagnostics);
    analysis.resolution = Some(resolution);
    analysis
}

pub(crate) struct AnalyzedCompilation {
    pub materialization: Materialization,
    pub typst: EmittedTypst,
    pub diagnostics: Vec<Diagnostic>,
}

pub(crate) fn compile_analyzed(
    analysis: &AnalyzedDocument,
    materializer: &mut impl ResourceMaterializer,
    emit_options: &EmitOptions,
) -> Option<AnalyzedCompilation> {
    let resolution = analysis.resolution.as_ref()?;
    let materialization = materialize_resources(resolution, materializer);
    let mut typst = emit_typst(
        &analysis.document,
        &analysis.document_config.config,
        &analysis.modes,
        &analysis.actors,
        &materialization.content,
        emit_options,
    );
    validate_generated_typst(&mut typst);
    let diagnostics = [
        analysis.document.diagnostics.as_slice(),
        analysis.document_config.diagnostics.as_slice(),
        analysis.modes.diagnostics.as_slice(),
        analysis.actors.diagnostics.as_slice(),
        analysis.assets.diagnostics.as_slice(),
        analysis.resource_markers.diagnostics.as_slice(),
        resolution.diagnostics.as_slice(),
        materialization.diagnostics.as_slice(),
        typst.diagnostics.as_slice(),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .collect();
    Some(AnalyzedCompilation {
        materialization,
        typst,
        diagnostics,
    })
}

#[derive(Debug, Clone)]
pub struct Compilation {
    pub document: SyntaxDocument,
    pub document_config: DocumentLowering,
    pub modes: BodyModeResolution,
    pub actors: ActorLowering,
    pub assets: AssetLowering,
    pub resource_markers: ResourceLowering,
    pub resolution: ResourceResolution,
    pub materialization: Materialization,
    pub typst: EmittedTypst,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompilationFailure {
    pub diagnostics: Vec<Diagnostic>,
}

pub fn compile_text(
    source: &str,
    packs: &PackRegistry,
    materializer: &mut impl ResourceMaterializer,
    emit_options: &EmitOptions,
) -> Compilation {
    let analysis = analyze_text_with_pack(source, packs);
    let compiled = compile_analyzed(&analysis, materializer, emit_options)
        .expect("pack analysis always contains resource resolution");
    let AnalyzedDocument {
        document,
        document_config,
        modes,
        actors,
        assets,
        resource_markers,
        resolution,
    } = analysis;
    Compilation {
        document,
        document_config,
        modes,
        actors,
        assets,
        resource_markers,
        resolution: resolution.expect("pack analysis always contains resource resolution"),
        materialization: compiled.materialization,
        typst: compiled.typst,
        diagnostics: compiled.diagnostics,
    }
}

pub fn compile_text_strict(
    source: &str,
    packs: &PackRegistry,
    materializer: &mut impl ResourceMaterializer,
    emit_options: &EmitOptions,
) -> Result<Compilation, CompilationFailure> {
    let analysis = analyze_text_with_pack(source, packs);
    fail_if_errors(analysis.document.diagnostics.clone())?;
    fail_if_errors(
        [
            analysis.document_config.diagnostics.as_slice(),
            analysis.modes.diagnostics.as_slice(),
            analysis.actors.diagnostics.as_slice(),
            analysis.assets.diagnostics.as_slice(),
            analysis.resource_markers.diagnostics.as_slice(),
        ]
        .into_iter()
        .flatten()
        .cloned()
        .collect(),
    )?;
    let resolution = analysis
        .resolution
        .as_ref()
        .expect("pack analysis always contains resource resolution");
    fail_if_errors(resolution.diagnostics.clone())?;
    let materialization = materialize_resources(resolution, materializer);
    fail_if_errors(materialization.diagnostics.clone())?;
    let mut typst = emit_typst(
        &analysis.document,
        &analysis.document_config.config,
        &analysis.modes,
        &analysis.actors,
        &materialization.content,
        emit_options,
    );
    validate_generated_typst(&mut typst);
    fail_if_errors(typst.diagnostics.clone())?;
    let diagnostics = [
        analysis.document.diagnostics.as_slice(),
        analysis.document_config.diagnostics.as_slice(),
        analysis.modes.diagnostics.as_slice(),
        analysis.actors.diagnostics.as_slice(),
        analysis.assets.diagnostics.as_slice(),
        analysis.resource_markers.diagnostics.as_slice(),
        resolution.diagnostics.as_slice(),
        materialization.diagnostics.as_slice(),
        typst.diagnostics.as_slice(),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .collect();
    let AnalyzedDocument {
        document,
        document_config,
        modes,
        actors,
        assets,
        resource_markers,
        resolution,
    } = analysis;
    Ok(Compilation {
        document,
        document_config,
        modes,
        actors,
        assets,
        resource_markers,
        resolution: resolution.expect("pack analysis always contains resource resolution"),
        materialization,
        typst,
        diagnostics,
    })
}

fn fail_if_errors(diagnostics: Vec<Diagnostic>) -> Result<(), CompilationFailure> {
    if diagnostics
        .iter()
        .any(|diagnostic| diagnostic.severity == Severity::Error)
    {
        Err(CompilationFailure { diagnostics })
    } else {
        Ok(())
    }
}

fn validate_generated_typst(typst: &mut EmittedTypst) {
    let generated_range = TextRange::new(0, typst.source.len());
    let diagnostics = check_typst_source(&typst.source, generated_range);
    for diagnostic in diagnostics {
        let mapped = diagnostic
            .range
            .map(|range| typst.map_typst_diagnostic(diagnostic.message.clone(), range))
            .unwrap_or(diagnostic);
        if !typst.diagnostics.contains(&mapped) {
            typst.diagnostics.push(mapped);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::materialize::{MaterializeError, MaterializedImage};
    use crate::pack::PackManifest;
    use crate::resolve::{ResolvedResource, ResolvedResourceKind};

    const PACK: &str = r#"{
      "schema":"mmt-pack.v3",
      "pack":{"namespace":"ba","name":"BA","version":"1","type":"base"},
      "entities":{"柚子":{"names":["柚子"],"slots":{"sticker":{"default":"default","sets":{"default":{"storage":"stickers","variants":[{"id":"happy","ordinal":1,"frame":0}]}}}}}},
      "storage":{"stickers":{"kind":"image-sequence","path":"stickers.avifs","container":"avifs","codec":"av1","alpha":true,"frame_count":1,"size":[512,512],"sha256":"hash","profile":{"qcolor":80,"keyframe_interval":30}}}
    }"#;

    struct FakeMaterializer;

    impl ResourceMaterializer for FakeMaterializer {
        fn materialize(
            &mut self,
            resource: &ResolvedResource,
        ) -> Result<MaterializedImage, MaterializeError> {
            assert!(matches!(
                resource.kind,
                ResolvedResourceKind::Sticker { .. }
            ));
            Ok(MaterializedImage {
                typst_path: "cache/happy.png".to_string(),
            })
        }
    }

    struct CountingMaterializer {
        calls: usize,
    }

    impl ResourceMaterializer for CountingMaterializer {
        fn materialize(
            &mut self,
            _resource: &ResolvedResource,
        ) -> Result<MaterializedImage, MaterializeError> {
            self.calls += 1;
            Ok(MaterializedImage {
                typst_path: "cache/image.png".to_string(),
            })
        }
    }

    #[test]
    fn compiles_resource_marker_through_all_core_stages() {
        let packs = PackRegistry::new(vec![PackManifest::from_json(PACK).unwrap()]).unwrap();
        let result = compile_text(
            "> 柚子: 你好 [:#1:](width: 2em)",
            &packs,
            &mut FakeMaterializer,
            &EmitOptions::default(),
        );

        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
        assert!(result.typst.source.contains("image(\"cache/happy.png\")"));
        assert!(result.typst.source.contains("width: 2em"));
        assert_eq!(result.resolution.resources.len(), 1);
    }

    #[test]
    fn resolve_failure_is_not_duplicated_by_emitter() {
        let packs = PackRegistry::new(vec![PackManifest::from_json(PACK).unwrap()]).unwrap();
        let result = compile_text(
            "- [:asset::missing:]",
            &packs,
            &mut FakeMaterializer,
            &EmitOptions::default(),
        );

        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(
            result.diagnostics[0].phase,
            crate::diag::DiagnosticPhase::Resolve
        );
        assert!(result.typst.source.contains("missing resource"));
    }

    #[test]
    fn strict_compilation_stops_before_io_on_syntax_or_resolve_errors() {
        let packs = PackRegistry::new(vec![PackManifest::from_json(PACK).unwrap()]).unwrap();
        let mut materializer = CountingMaterializer { calls: 0 };

        let syntax =
            compile_text_strict("@end", &packs, &mut materializer, &EmitOptions::default());
        assert!(syntax.is_err());
        assert_eq!(materializer.calls, 0);

        let resolve = compile_text_strict(
            "- [:asset::missing:]",
            &packs,
            &mut materializer,
            &EmitOptions::default(),
        );
        assert!(resolve.is_err());
        assert_eq!(materializer.calls, 0);
    }

    #[test]
    fn strict_compilation_returns_complete_valid_pipeline() {
        let packs = PackRegistry::new(vec![PackManifest::from_json(PACK).unwrap()]).unwrap();
        let mut materializer = CountingMaterializer { calls: 0 };
        let result = compile_text_strict(
            "> 柚子: [:#1:]",
            &packs,
            &mut materializer,
            &EmitOptions::default(),
        )
        .expect("valid strict compilation");

        assert_eq!(materializer.calls, 1);
        assert!(result.diagnostics.is_empty());
        assert!(result.typst.source.contains("cache/image.png"));
    }
}
