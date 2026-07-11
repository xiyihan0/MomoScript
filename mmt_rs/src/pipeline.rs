//! End-to-end language-core orchestration without platform-specific I/O.

use crate::diag::Diagnostic;
use crate::emit::{EmitOptions, EmittedTypst, emit_typst};
use crate::materialize::{Materialization, ResourceMaterializer, materialize_resources};
use crate::pack::PackRegistry;
use crate::resolve::{ResourceResolution, resolve_actor_avatars, resolve_resources};
use crate::semantic::{
    ActorLowering, AssetLowering, BodyModeResolution, ResourceLowering, lower_actors, lower_assets,
    lower_resource_markers, resolve_body_modes,
};
use crate::syntax::SyntaxDocument;

#[derive(Debug, Clone)]
pub struct Compilation {
    pub document: SyntaxDocument,
    pub modes: BodyModeResolution,
    pub actors: ActorLowering,
    pub assets: AssetLowering,
    pub resource_markers: ResourceLowering,
    pub resolution: ResourceResolution,
    pub materialization: Materialization,
    pub typst: EmittedTypst,
    pub diagnostics: Vec<Diagnostic>,
}

pub fn compile_text(
    source: &str,
    packs: &PackRegistry,
    materializer: &mut impl ResourceMaterializer,
    emit_options: &EmitOptions,
) -> Compilation {
    let document = crate::parse_text(source);
    let modes = resolve_body_modes(&document);
    let actors = lower_actors(&document, packs);
    let assets = lower_assets(&document);
    let resource_markers = lower_resource_markers(&document, &modes, &actors);
    let mut resolution = resolve_resources(&resource_markers, &actors, &assets, packs);
    let avatars = resolve_actor_avatars(&actors, &assets, packs);
    resolution.resources.extend(avatars.resources);
    resolution.failures.extend(avatars.failures);
    resolution.diagnostics.extend(avatars.diagnostics);
    let materialization = materialize_resources(&resolution, materializer);
    let typst = emit_typst(
        &document,
        &modes,
        &actors,
        &materialization.content,
        emit_options,
    );

    let diagnostics = [
        document.diagnostics.as_slice(),
        modes.diagnostics.as_slice(),
        actors.diagnostics.as_slice(),
        assets.diagnostics.as_slice(),
        resource_markers.diagnostics.as_slice(),
        resolution.diagnostics.as_slice(),
        materialization.diagnostics.as_slice(),
        typst.diagnostics.as_slice(),
    ]
    .into_iter()
    .flatten()
    .cloned()
    .collect();

    Compilation {
        document,
        modes,
        actors,
        assets,
        resource_markers,
        resolution,
        materialization,
        typst,
        diagnostics,
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
}
