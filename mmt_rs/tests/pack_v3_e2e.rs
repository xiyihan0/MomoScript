use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use mmt_rs::materialize::{MaterializeError, MaterializedImage, ResourceMaterializer};
use mmt_rs::pack::{PackManifest, PackRegistry};
use mmt_rs::resolve::{ResolvedResource, ResolvedResourceKind};
use mmt_rs::{
    DocumentOverrides, EmitOptions, compile_text_strict, lower_actors, lower_assets,
    lower_resource_markers, parse_text, resolve_body_modes, resolve_resources,
};

const BASE_MANIFEST: &str = include_str!("fixtures/pack-v3/base-manifest.json");
const EXTENSION_MANIFEST: &str = include_str!("fixtures/pack-v3/extension-manifest.json");

fn base_registry() -> PackRegistry {
    PackRegistry::new(vec![PackManifest::from_json(BASE_MANIFEST).unwrap()]).unwrap()
}

fn full_registry() -> PackRegistry {
    PackRegistry::new(vec![
        PackManifest::from_json(BASE_MANIFEST).unwrap(),
        PackManifest::from_json(EXTENSION_MANIFEST).unwrap(),
    ])
    .unwrap()
}

struct FixtureMaterializer {
    typst_path: String,
}

impl ResourceMaterializer for FixtureMaterializer {
    fn materialize(
        &mut self,
        resource: &ResolvedResource,
    ) -> Result<MaterializedImage, MaterializeError> {
        assert!(matches!(
            resource.kind,
            ResolvedResourceKind::Avatar { .. } | ResolvedResourceKind::Sticker { .. }
        ));
        Ok(MaterializedImage {
            typst_path: self.typst_path.clone(),
        })
    }
}

#[test]
fn fixture_registry_resolves_base_sets_and_explicit_contribution() {
    let registry = full_registry();
    let source = "> 佳代子: [:ba_fixture_ext::#1:] [:佳代子, 领航服差分/#1:]";
    let document = parse_text(source);
    let modes = resolve_body_modes(&document);
    let actors = lower_actors(&document, &registry);
    let assets = lower_assets(&document);
    let markers = lower_resource_markers(&document, &modes, &actors);
    let resolution = resolve_resources(&markers, &actors, &assets, &registry);

    assert!(
        resolution.diagnostics.is_empty(),
        "{:?}",
        resolution.diagnostics
    );
    assert!(matches!(
        &resolution.resources[0].kind,
        ResolvedResourceKind::Sticker {
            contribution_namespace,
            variant_id,
            ..
        } if contribution_namespace == "ba_fixture_ext" && variant_id == "festival_001"
    ));
    assert!(matches!(
        &resolution.resources[1].kind,
        ResolvedResourceKind::Sticker { set_id, variant_id, .. }
            if set_id == "set_02" && variant_id == "set_02_001"
    ));
}

#[test]
fn fixture_registry_rejects_unscoped_cross_pack_ordinal() {
    let registry = full_registry();
    let document = parse_text("> 佳代子: [:#1:]");
    let modes = resolve_body_modes(&document);
    let actors = lower_actors(&document, &registry);
    let assets = lower_assets(&document);
    let markers = lower_resource_markers(&document, &modes, &actors);
    let resolution = resolve_resources(&markers, &actors, &assets, &registry);

    assert!(resolution.resources.is_empty());
    assert!(resolution.diagnostics[0].message.contains("ambiguous"));
}

#[test]
fn strict_pipeline_generated_typst_compiles_with_typst_015() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().unwrap();
    let version = Command::new("typst")
        .arg("--version")
        .output()
        .expect("Typst 0.15 must be installed for the Rust v2 e2e test");
    assert!(version.status.success());
    assert!(
        String::from_utf8_lossy(&version.stdout).starts_with("typst 0.15."),
        "expected Typst 0.15.x, got {}",
        String::from_utf8_lossy(&version.stdout).trim()
    );
    let output_dir = manifest_dir.join("target/mmt-v2-e2e");
    fs::create_dir_all(&output_dir).unwrap();
    let generated_path = output_dir.join("generated.typ");
    let pdf_path = output_dir.join("generated.pdf");

    let mut materializer = FixtureMaterializer {
        typst_path: "../../../mmt_rs/tests/fixtures/pack-v3/materialized.svg".to_string(),
    };
    let options = EmitOptions {
        template_import: "../../../mmt_rs/tests/fixtures/typst/mmt-test-lib.typ".to_string(),
        document_overrides: DocumentOverrides {
            title: Some("Pack v3 E2E".to_string()),
            ..DocumentOverrides::default()
        },
        ..EmitOptions::default()
    };
    let source = "> 佳代子: first [:#1:](width: 2em)\n\
                  > _0: continued\n\
                  < sensei side\n\
                  > _0: resumed\n\
                  - narration\n\
                  @reply: option a | option b\n\
                  @bond: bond";
    let compilation = compile_text_strict(source, &base_registry(), &mut materializer, &options)
        .expect("strict pipeline should succeed");
    fs::write(&generated_path, &compilation.typst.source).unwrap();

    let output = Command::new("typst")
        .args(["compile"])
        .arg(&generated_path)
        .arg(&pdf_path)
        .arg("--root")
        .arg(repo_root)
        .output()
        .expect("Typst 0.15 must be installed for the Rust v2 e2e test");
    assert!(
        output.status.success(),
        "Typst failed:\n{}\nGenerated source:\n{}",
        String::from_utf8_lossy(&output.stderr),
        compilation.typst.source
    );
    assert!(pdf_path.is_file());
}

#[test]
fn fixture_paths_are_stable_from_the_crate_root() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    assert!(
        manifest_dir
            .join("tests/fixtures/pack-v3/materialized.svg")
            .is_file()
    );
}
