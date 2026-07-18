use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};

use lsp_types::{Hover, Range, Url};
use mmt_lsp::position::PositionEncoding;
use mmt_lsp::{LanguageService, ProjectionStore};
use mmt_rs::{EmitOptions, StaticPresetCatalog, project_text};
use serde_json::{Value, json};

fn send(stdin: &mut ChildStdin, message: &Value) {
    let body = serde_json::to_vec(message).unwrap();
    write!(stdin, "Content-Length: {}\r\n\r\n", body.len()).unwrap();
    stdin.write_all(&body).unwrap();
    stdin.flush().unwrap();
}

fn receive(stdout: &mut BufReader<ChildStdout>) -> Value {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        assert!(!line.is_empty(), "Tinymist closed before a response");
        if line == "\r\n" {
            break;
        }
        if let Some(length) = line.strip_prefix("Content-Length: ") {
            content_length = Some(length.trim().parse::<usize>().unwrap());
        }
    }
    let mut body = vec![0; content_length.expect("Content-Length header")];
    stdout.read_exact(&mut body).unwrap();
    serde_json::from_slice(&body).unwrap()
}

fn response_for_server_request(message: &Value) -> Value {
    let result = match message["method"].as_str() {
        Some("workspace/configuration") => {
            let count = message["params"]["items"].as_array().map_or(0, Vec::len);
            Value::Array(vec![Value::Null; count])
        }
        _ => Value::Null,
    };
    json!({"jsonrpc": "2.0", "id": message["id"], "result": result})
}

fn receive_response(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    expected_id: i64,
) -> Value {
    loop {
        let message = receive(stdout);
        if message.get("method").is_some() && message.get("id").is_some() {
            send(stdin, &response_for_server_request(&message));
            continue;
        }
        if message["id"].as_i64() == Some(expected_id) {
            return message;
        }
    }
}

fn utf16_position(source: &str, offset: usize) -> Value {
    let prefix = &source[..offset];
    let line = prefix.bytes().filter(|byte| *byte == b'\n').count();
    let line_start = prefix.rfind('\n').map_or(0, |newline| newline + 1);
    json!({
        "line": line,
        "character": source[line_start..offset].encode_utf16().count()
    })
}

#[test]
fn fixed_tinymist_sidecar_handles_a_virtual_document_transcript() {
    let Ok(binary) = std::env::var("TINYMIST_BIN") else {
        eprintln!("TINYMIST_BIN is not set; skipping external sidecar transcript");
        return;
    };
    let mmt_source = "@typ\n#let greet(name) = [Hello #name]\n#gre\n@end";
    let projection = project_text(
        mmt_source,
        &StaticPresetCatalog::default(),
        &EmitOptions::default(),
    )
    .unwrap();
    let completion_mmt_offset = mmt_source.rfind("#gre").unwrap() + "#gre".len();
    let completion_typst_offset = projection
        .index
        .mmt_to_typst(completion_mmt_offset)
        .unwrap();
    let hover_mmt_offset = mmt_source.find("greet").unwrap() + 2;
    let hover_typst_offset = projection.index.mmt_to_typst(hover_mmt_offset).unwrap();
    let completion_position = utf16_position(&projection.emitted.source, completion_typst_offset);
    let hover_position = utf16_position(&projection.emitted.source, hover_typst_offset);
    let mut child = Command::new(binary)
        .arg("lsp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": null,
                "rootUri": null,
                "capabilities": {
                    "workspace": {"configuration": true},
                    "general": {"positionEncodings": ["utf-16"]},
                    "textDocument": {
                        "completion": {"completionItem": {"snippetSupport": true}},
                        "hover": {"contentFormat": ["markdown", "plaintext"]},
                        "rename": {"prepareSupport": true},
                    }
                },
                "clientInfo": {"name": "mmt-lsp-sidecar-test", "version": "0.1.0"}
            }
        }),
    );
    let initialize = receive_response(&mut stdin, &mut stdout, 1);
    assert!(initialize.get("error").is_none(), "{initialize}");
    assert!(initialize["result"]["capabilities"]["completionProvider"].is_object());
    assert!(initialize["result"]["capabilities"]["hoverProvider"].as_bool() == Some(true));

    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": "untitled:/mmt-projection/main.typ",
                    "languageId": "typst",
                    "version": 1,
                    "text": projection.emitted.source
                }
            }
        }),
    );
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "textDocument/completion",
            "params": {
                "textDocument": {"uri": "untitled:/mmt-projection/main.typ"},
                "position": completion_position
            }
        }),
    );
    let completion = receive_response(&mut stdin, &mut stdout, 2);
    assert!(completion.get("error").is_none(), "{completion}");
    let completion_text = completion["result"].to_string();
    assert!(completion_text.contains("greet"), "{completion}");

    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "textDocument/hover",
            "params": {
                "textDocument": {"uri": "untitled:/mmt-projection/main.typ"},
                "position": hover_position.clone()
            }
        }),
    );
    let hover = receive_response(&mut stdin, &mut stdout, 3);
    assert!(hover.get("error").is_none(), "{hover}");
    assert!(!hover["result"].is_null(), "{hover}");
    let hover_result: Hover = serde_json::from_value(hover["result"].clone()).unwrap();
    let mut store = ProjectionStore::default();
    let mut service = LanguageService::default();
    let source_uri = Url::parse("file:///workspace/sidecar.mmt").unwrap();
    let snapshot = service
        .open(source_uri.clone(), 1, mmt_source.to_string())
        .clone();
    let document = store.upsert(source_uri, &snapshot).unwrap();
    if let Some(range) = hover_result.range {
        assert!(
            document
                .typst_range_to_mmt(range, PositionEncoding::Utf16, PositionEncoding::Utf16,)
                .is_ok(),
            "Tinymist hover range is not safely mappable: {range:?}"
        );
    }

    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "textDocument/prepareRename",
            "params": {
                "textDocument": {"uri": "untitled:/mmt-projection/main.typ"},
                "position": hover_position.clone()
            }
        }),
    );
    let prepare_rename = receive_response(&mut stdin, &mut stdout, 4);
    assert!(prepare_rename.get("error").is_none(), "{prepare_rename}");
    assert_eq!(prepare_rename["result"]["placeholder"], "greet");

    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "textDocument/rename",
            "params": {
                "textDocument": {"uri": "untitled:/mmt-projection/main.typ"},
                "position": hover_position,
                "newName": "salute"
            }
        }),
    );
    let rename = receive_response(&mut stdin, &mut stdout, 5);
    assert!(rename.get("error").is_none(), "{rename}");
    let changes = rename["result"]["changes"]
        .as_object()
        .expect("Tinymist rename must return a changes map");
    assert_eq!(changes.len(), 1, "{rename}");
    let (target_uri, edits) = changes.iter().next().unwrap();
    assert_eq!(
        target_uri, "untitled:mmt-projection/main.typ",
        "pinned Tinymist edit URI serialization changed"
    );
    let edits = edits.as_array().expect("rename edits");
    assert_eq!(edits.len(), 1, "{rename}");
    for edit in edits {
        assert_eq!(edit["newText"], "salute");
        let range: Range = serde_json::from_value(edit["range"].clone()).unwrap();
        assert!(
            document
                .typst_range_to_mmt(range, PositionEncoding::Utf16, PositionEncoding::Utf16)
                .is_ok(),
            "real Tinymist rename range is not safely mappable: {range:?}"
        );
    }

    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "id": 6, "method": "shutdown", "params": null}),
    );
    assert!(receive_response(&mut stdin, &mut stdout, 6)["result"].is_null());
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "method": "exit", "params": null}),
    );
    drop(stdin);
    assert!(child.wait().unwrap().success());
}
