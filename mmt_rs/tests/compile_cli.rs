use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

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
fn serve_remote_pack(svg: Vec<u8>) -> (String, thread::JoinHandle<usize>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    let base_url = format!("http://{address}/");
    let digest = format!("{:x}", Sha256::digest(&svg));
    let file_name = format!("{digest}.svg");
    let svg_path = format!("blobs/{file_name}");
    let manifest = serde_json::to_vec(&serde_json::json!({
        "schema": "mmt-pack.v3",
        "pack": {
            "namespace": "remote_fixture",
            "name": "Remote fixture",
            "version": "1.0.0",
            "type": "base",
            "base_url": base_url.clone()
        },
        "entities": {
            "remote": {
                "names": ["Remote"],
                "slots": {
                    "avatar": {
                        "default": "default",
                        "items": {
                            "default": {
                                "storage": "avatars",
                                "path": file_name
                            }
                        }
                    }
                }
            }
        },
        "storage": {
            "avatars": {
                "kind": "image-dir",
                "base": "blobs"
            }
        }
    }))
    .unwrap();
    let handle = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut served = 0;
        while served < 2 && Instant::now() < deadline {
            let (mut stream, _) = match listener.accept() {
                Ok(connection) => connection,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10));
                    continue;
                }
                Err(error) => panic!("remote pack server failed: {error}"),
            };
            let mut request = [0_u8; 2048];
            let length = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..length]);
            let path = request
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("");
            let (status, content_type, body) = if path == "/manifest.json" {
                ("200 OK", "application/json", manifest.as_slice())
            } else if path == format!("/{svg_path}") {
                ("200 OK", "image/svg+xml", svg.as_slice())
            } else {
                ("404 Not Found", "text/plain", &b"not found"[..])
            };
            write!(
                stream,
                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
            served += 1;
        }
        served
    });
    (base_url, handle)
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
fn template_emits_semantic_svg_labels_without_visual_changes() {
    let output_dir = temp_dir("semantic-labels");
    copy_dir_all(&template_dir(), &output_dir.join("template"));
    let source = r#"
#import "template/lib.typ" as mmt
#set page(width: 360pt, height: auto, margin: 12pt)

#mmt.chat-left(
  composer-key: $CHAT_KEY,
  name: [Name],
  avatar: circle(radius: 12pt, fill: red),
  reserve-avatar-space: true,
)[Body]
#mmt.chat-right(
  composer-key: $RIGHT_KEY,
  name: [Sensei],
)[Right]
#mmt.narration(composer-key: $NARRATION_KEY)[Narration]
#mmt.reply(composer-key: $REPLY_KEY)[A][B]
#mmt.bond(composer-key: $BOND_KEY)[Bond]
"#;
    let labelled = source
        .replace("$CHAT_KEY", "\"t00000000\"")
        .replace("$RIGHT_KEY", "\"t00000001\"")
        .replace("$NARRATION_KEY", "\"t00000002\"")
        .replace("$REPLY_KEY", "\"t00000003\"")
        .replace("$BOND_KEY", "\"t00000004\"");
    let unlabelled = source
        .replace("$CHAT_KEY", "none")
        .replace("$RIGHT_KEY", "none")
        .replace("$NARRATION_KEY", "none")
        .replace("$REPLY_KEY", "none")
        .replace("$BOND_KEY", "none");
    fs::write(output_dir.join("labelled.typ"), labelled).unwrap();
    fs::write(output_dir.join("unlabelled.typ"), unlabelled).unwrap();

    for (input, output) in [
        ("labelled.typ", "labelled.svg"),
        ("labelled.typ", "labelled.png"),
        ("unlabelled.typ", "unlabelled.png"),
    ] {
        let typst = Command::new("typst")
            .args(["compile", input, output, "--root", "."])
            .current_dir(&output_dir)
            .output()
            .unwrap();
        assert!(
            typst.status.success(),
            "{}",
            String::from_utf8_lossy(&typst.stderr)
        );
    }

    let svg = fs::read_to_string(output_dir.join("labelled.svg")).unwrap();
    for label in [
        "mmt:avatar:t00000000",
        "mmt:display-name:t00000000",
        "mmt:bubble:t00000000",
        "mmt:display-name:t00000001",
        "mmt:bubble:t00000001",
        "mmt:narration:t00000002",
        "mmt:reply:t00000003",
        "mmt:reply-item:t00000003",
        "mmt:bond:t00000004",
        "mmt:bond-body:t00000004",
    ] {
        assert!(svg.contains(&format!("data-typst-label=\"{label}\"")));
    }
    assert_eq!(
        fs::read(output_dir.join("labelled.png")).unwrap(),
        fs::read(output_dir.join("unlabelled.png")).unwrap(),
    );
    fs::remove_dir_all(output_dir).unwrap();
}
#[test]
fn cli_reports_unknown_directives_as_non_fatal_warnings() {
    let output_dir = temp_dir("cli-unknown-directive");
    let mut child = Command::new(env!("CARGO_BIN_EXE_mmt-compile"))
        .args(["--output-dir"])
        .arg(&output_dir)
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
        .write_all("@expr: actor | expression | action | 0.8\n- hello".as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    let warning = &report["diagnostics"][0];
    assert_eq!(warning["severity"], "warning");
    assert_eq!(warning["phase"], "semantic");
    assert_eq!(
        warning["message"],
        "unknown directive '@expr'; it is ignored"
    );
    assert_eq!(warning["span"]["range"]["start"], 1);
    assert_eq!(warning["span"]["range"]["end"], 5);
    fs::remove_dir_all(output_dir).unwrap();
}

#[test]
fn cli_fetches_remote_pack_resources_and_compiles_pdf_in_process() {
    let output_dir = temp_dir("cli-remote-pdf");
    let cache_dir = temp_dir("cli-remote-pdf-cache");
    let pdf_path = output_dir.with_extension("pdf");
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>"#.to_vec();
    let (base_url, server) = serve_remote_pack(svg);

    let manifest_url = format!("{base_url}manifest.json");
    let mut child = Command::new(env!("CARGO_BIN_EXE_mmt-compile"))
        .args(["--output-dir"])
        .arg(&output_dir)
        .arg("--pdf")
        .arg(&pdf_path)
        .arg("--manifest")
        .arg(&manifest_url)
        .arg("--allow-insecure-http")
        .arg("--cache-dir")
        .arg(&cache_dir)
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
        .write_all(
            "@actor remote\npreset: remote_fixture::remote\n@end\n> remote: hello".as_bytes(),
        )
        .unwrap();
    let output = child.wait_with_output().unwrap();
    let served = server.join().unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert_eq!(served, 2, "compiler did not request manifest and resource");
    let report: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["success"], true);
    assert_eq!(report["pdf"], pdf_path.display().to_string());
    assert!(fs::read(&pdf_path).unwrap().starts_with(b"%PDF-"));
    assert!(output_dir.join("assets/000000.svg").is_file());
    assert!(cache_dir.join("remote-packs").is_dir());

    fs::remove_dir_all(output_dir).unwrap();
    fs::remove_dir_all(cache_dir).unwrap();
    fs::remove_file(pdf_path).unwrap();
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
