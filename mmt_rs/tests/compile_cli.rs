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

#[test]
fn cli_exports_a_self_contained_typst_project_from_stdin() {
    let output_dir = temp_dir("cli-success");
    let mut child = Command::new(env!("CARGO_BIN_EXE_mmt-compile"))
        .args(["--output-dir"])
        .arg(&output_dir)
        .arg("--template-dir")
        .arg(template_dir())
        .args(["--title", "CLI fixture"])
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
