use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_dir(name: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!("mmt-rs-{name}-{}-{nonce}", std::process::id()))
}

fn template_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("typst_sandbox/mmt_render")
}

fn copy_dir_all(source: &std::path::Path, destination: &std::path::Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir_all(&source_path, &destination_path);
        } else {
            fs::copy(source_path, destination_path).unwrap();
        }
    }
}

#[test]
fn cli_exports_a_self_contained_typst_project_from_stdin() {
    let output_dir = temp_dir("cli-success");
    let mut child = Command::new(env!("CARGO_BIN_EXE_mmt-compile"))
        .args(["--output-dir"])
        .arg(&output_dir)
        .arg("--template-dir")
        .arg(template_dir())
        .args(["--title", "CLI fixture"])
        .arg("--no-header")
        .args(["--compiled-at", "CLI build"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all("- hello\n@reply: A | B".as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["success"], true);
    assert!(output_dir.join("main.typ").is_file());
    assert!(
        fs::read_to_string(output_dir.join("main.typ"))
            .unwrap()
            .contains("show-header: false")
    );
    let generated = fs::read_to_string(output_dir.join("main.typ")).unwrap();
    assert!(generated.contains("title: \"CLI fixture\""));
    assert!(generated.contains("compiled-at: \"CLI build\""));
    assert!(output_dir.join("source.mmt").is_file());
    let source_map: serde_json::Value =
        serde_json::from_slice(&fs::read(output_dir.join("source-map.json")).unwrap()).unwrap();
    assert_eq!(source_map["schema"], "mmt.source-map.v1");
    assert!(source_map["source_map"].as_array().unwrap().len() > 1);
    assert!(output_dir.join("template/lib.typ").is_file());
    assert!(output_dir.join("template/mmt_options.webp").is_file());
    assert!(output_dir.join("template/mmt_favor.webp").is_file());

    let typst = Command::new("typst")
        .args(["compile", "main.typ", "output.pdf", "--root", "."])
        .current_dir(&output_dir)
        .output()
        .unwrap();
    assert!(
        typst.status.success(),
        "{}",
        String::from_utf8_lossy(&typst.stderr)
    );
    assert!(output_dir.join("output.pdf").is_file());
    fs::remove_dir_all(output_dir).unwrap();
}

#[test]
fn cli_can_reference_an_installed_local_template_package() {
    let fixture_root = temp_dir("cli-local-template");
    let output_dir = fixture_root.join("project");
    let package_root = fixture_root.join(".typst/packages");
    let package_dir = package_root.join("local/mmt-render/0.1.0");
    copy_dir_all(&template_dir(), &package_dir);

    let mut child = Command::new(env!("CARGO_BIN_EXE_mmt-compile"))
        .args(["--output-dir"])
        .arg(&output_dir)
        .arg("--use-local-template-package")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all("- local package".as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );

    let generated = fs::read_to_string(output_dir.join("main.typ")).unwrap();
    assert!(generated.contains("#import \"@local/mmt-render:0.1.0\" as mmt"));
    assert!(!output_dir.join("template").exists());

    let typst = Command::new("typst")
        .args([
            "compile",
            "main.typ",
            "output.pdf",
            "--root",
            ".",
            "--package-path",
        ])
        .arg(&package_root)
        .current_dir(&output_dir)
        .output()
        .unwrap();
    assert!(
        typst.status.success(),
        "{}",
        String::from_utf8_lossy(&typst.stderr)
    );
    assert!(output_dir.join("output.pdf").is_file());
    fs::remove_dir_all(fixture_root).unwrap();
}

#[test]
fn cli_formats_document_auto_time_from_reproducible_rfc3339_clock() {
    let output_dir = temp_dir("cli-document-clock");
    let mut child = Command::new(env!("CARGO_BIN_EXE_mmt-compile"))
        .args(["--output-dir"])
        .arg(&output_dir)
        .arg("--template-dir")
        .arg(template_dir())
        .args(["--clock", "1970-01-01T00:00:00-05:00"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(
            "@document\n\
             title: Source title\n\
             compiled-at: auto\n\
             timezone: local\n\
             @end\n\
             - hello"
                .as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let generated = fs::read_to_string(output_dir.join("main.typ")).unwrap();
    assert!(generated.contains("title: \"Source title\""));
    assert!(generated.contains("compiled-at: \"1970-01-01 00:00:00\""));
    fs::remove_dir_all(output_dir).unwrap();
}

#[test]
fn cli_reports_structured_utf8_source_diagnostics() {
    let output_dir = temp_dir("cli-error");
    let source_path = output_dir.with_extension("mmt");
    fs::write(&source_path, "- 中文\n@end").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_mmt-compile"))
        .args(["--input"])
        .arg(&source_path)
        .args(["--output-dir"])
        .arg(&output_dir)
        .arg("--template-dir")
        .arg(template_dir())
        .output()
        .unwrap();

    assert!(!output.status.success());
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["success"], false);
    assert_eq!(report["diagnostics"][0]["phase"], "syntax");
    assert_eq!(report["diagnostics"][0]["span"]["start"]["line"], 2);
    assert_eq!(report["diagnostics"][0]["span"]["start"]["column"], 1);
    assert_eq!(report["diagnostics"][0]["span"]["range"]["start"], 9);

    fs::remove_file(source_path).unwrap();
    if output_dir.exists() {
        fs::remove_dir_all(output_dir).unwrap();
    }
}

#[test]
fn cli_decodes_pack_avifs_with_dav1d_and_compiles_the_project() {
    let output_dir = temp_dir("cli-avifs");
    let cache_dir = temp_dir("cli-avifs-cache");
    let fixture_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/avifs");
    let mut child = Command::new(env!("CARGO_BIN_EXE_mmt-compile"))
        .args(["--output-dir"])
        .arg(&output_dir)
        .arg("--cache-dir")
        .arg(&cache_dir)
        .arg("--manifest")
        .arg(fixture_dir.join("manifest.json"))
        .arg("--template-dir")
        .arg(template_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all("> 透明测试: [:#1:](width: 2em)".as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let pngs = fs::read_dir(output_dir.join("assets"))
        .unwrap()
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "png"))
        .collect::<Vec<_>>();
    assert_eq!(pngs.len(), 1);
    let png = fs::read(pngs[0].path()).unwrap();
    assert_eq!(png[25], 6, "decoded sticker must preserve transparency");
    assert_eq!(fs::read_dir(&cache_dir).unwrap().count(), 1);

    let typst = Command::new("typst")
        .args(["compile", "main.typ", "output.pdf", "--root", "."])
        .current_dir(&output_dir)
        .output()
        .unwrap();
    assert!(
        typst.status.success(),
        "{}",
        String::from_utf8_lossy(&typst.stderr)
    );
    assert!(output_dir.join("output.pdf").is_file());
    fs::remove_dir_all(output_dir).unwrap();
    fs::remove_dir_all(cache_dir).unwrap();
}
