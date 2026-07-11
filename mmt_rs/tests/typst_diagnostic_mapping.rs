use std::fs;
use std::path::Path;
use std::process::Command;

use mmt_rs::materialize::{MaterializeError, MaterializedImage, ResourceMaterializer};
use mmt_rs::pack::PackRegistry;
use mmt_rs::resolve::ResolvedResource;
use mmt_rs::source::{LineColumn, SourceFile, TextRange};
use mmt_rs::{EmitOptions, compile_text_strict};

struct NoResources;

impl ResourceMaterializer for NoResources {
    fn materialize(
        &mut self,
        _resource: &ResolvedResource,
    ) -> Result<MaterializedImage, MaterializeError> {
        panic!("fixture must not materialize resources")
    }
}

#[test]
fn real_typst_eval_diagnostic_maps_back_to_typ_directive() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_root = manifest_dir.parent().unwrap();
    let output_dir = manifest_dir.join("target/mmt-v2-diagnostic-map");
    fs::create_dir_all(&output_dir).unwrap();
    let generated_path = output_dir.join("generated.typ");
    let output_path = output_dir.join("generated.pdf");
    let source = "@typ\n#let broken = does-not-exist\n@end\n- ok";
    let registry = PackRegistry::new(Vec::new()).unwrap();
    let options = EmitOptions {
        template_import: "../../../mmt_rs/tests/fixtures/typst/mmt-test-lib.typ".to_string(),
        ..EmitOptions::default()
    };
    let compilation = compile_text_strict(source, &registry, &mut NoResources, &options).unwrap();
    fs::write(&generated_path, &compilation.typst.source).unwrap();

    let output = Command::new("typst")
        .args(["compile", "--diagnostic-format", "short"])
        .arg(&generated_path)
        .arg(&output_path)
        .arg("--root")
        .arg(repo_root)
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).unwrap();
    let first_line = stderr.lines().next().unwrap();
    let location = first_line.split_once(": error:").unwrap().0;
    let (location, column) = location.rsplit_once(':').unwrap();
    let (_, line) = location.rsplit_once(':').unwrap();
    let column = column.parse::<usize>().unwrap();
    let line = line.parse::<usize>().unwrap();
    let generated = SourceFile::anonymous(&compilation.typst.source);
    let offset = generated
        .byte_offset(LineColumn { line, column })
        .expect("Typst location must map into generated source");
    let mapped = compilation
        .typst
        .map_typst_diagnostic(first_line, TextRange::empty(offset));

    let body_start = source.find("#let broken").unwrap();
    let body_end = body_start + "#let broken = does-not-exist".len();
    assert_eq!(mapped.range, Some(TextRange::new(body_start, body_end)));
}
