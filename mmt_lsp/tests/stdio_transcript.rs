use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};

use mmt_lsp::MmtLanguageServer;
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/basic-session.json")).unwrap()
}

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
        assert!(!line.is_empty(), "language server closed before a response");
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

#[test]
fn native_stdio_matches_the_shared_server_transcript() {
    let fixture = fixture();
    let mut shared = MmtLanguageServer::default();
    let expected_initialize = shared
        .request("initialize", fixture["initialize"].clone())
        .unwrap();
    shared
        .notification("textDocument/didOpen", fixture["open"].clone())
        .unwrap();
    let expected_symbols = shared
        .request("textDocument/documentSymbol", fixture["query"].clone())
        .unwrap();
    let expected_folding = shared
        .request("textDocument/foldingRange", fixture["query"].clone())
        .unwrap();
    let expected_completion = shared
        .request("textDocument/completion", fixture["completion"].clone())
        .unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_mmt-lsp"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());

    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": fixture["initialize"]}),
    );
    assert_eq!(receive(&mut stdout)["result"], expected_initialize);
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "method": "initialized", "params": {}}),
    );
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "method": "textDocument/didOpen", "params": fixture["open"]}),
    );
    assert_eq!(
        receive(&mut stdout)["method"],
        "textDocument/publishDiagnostics"
    );
    let projection_update = receive(&mut stdout);
    assert_eq!(projection_update["method"], "mmt/typstProjectUpdated");
    assert_eq!(projection_update["params"]["revision"], 1);
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didChange",
            "params": {
                "textDocument": {
                    "uri": "file:///workspace/session.mmt",
                    "version": 2
                },
                "contentChanges": [
                    { "text": "- invalid first change" },
                    { "text": "- invalid second change" }
                ]
            }
        }),
    );
    let notification_error = receive(&mut stdout);
    assert_eq!(notification_error["method"], "window/logMessage");
    assert!(
        notification_error["params"]["message"]
            .as_str()
            .unwrap()
            .contains("exactly one content change")
    );

    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "id": 2, "method": "textDocument/documentSymbol", "params": fixture["query"]}),
    );
    assert_eq!(receive(&mut stdout)["result"], expected_symbols);
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "id": 3, "method": "textDocument/foldingRange", "params": fixture["query"]}),
    );
    assert_eq!(receive(&mut stdout)["result"], expected_folding);
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "id": 4, "method": "textDocument/completion", "params": fixture["completion"]}),
    );
    assert_eq!(receive(&mut stdout)["result"], expected_completion);

    let manifest = json!({
        "schema": "mmt-pack.v3",
        "pack": {"namespace": "ba", "name": "BA fixture", "version": "1", "type": "base"},
        "entities": {"柚子": {"names": ["柚子", "Yuzu"], "display_name": "柚子"}}
    })
    .to_string();
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "mmt/updatePackManifests",
            "params": {"revision": 1, "sources": [{"json": manifest}]}
        }),
    );
    let pack_update = receive(&mut stdout);
    assert_eq!(pack_update["result"]["revision"], 1);
    assert_eq!(pack_update["result"]["updated"], true);
    assert_eq!(
        receive(&mut stdout)["method"],
        "textDocument/publishDiagnostics"
    );
    assert_eq!(receive(&mut stdout)["method"], "mmt/typstProjectUpdated");
    let preset_uri = "file:///workspace/preset.mmt";
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {"textDocument": {
                "uri": preset_uri,
                "languageId": "mmt",
                "version": 1,
                "text": "@actor yuzu\npreset: ba::柚\n@end"
            }}
        }),
    );
    assert_eq!(
        receive(&mut stdout)["method"],
        "textDocument/publishDiagnostics"
    );
    assert_eq!(receive(&mut stdout)["method"], "mmt/typstProjectUpdated");
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "textDocument/completion",
            "params": {"textDocument": {"uri": preset_uri}, "position": {"line": 1, "character": 15}}
        }),
    );
    let preset_completion = receive(&mut stdout);
    assert!(
        preset_completion["result"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["label"] == "ba::柚子")
    );

    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "id": 7, "method": "shutdown", "params": null}),
    );
    assert_eq!(receive(&mut stdout)["result"], Value::Null);
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "method": "exit", "params": null}),
    );
    drop(stdin);
    assert!(child.wait().unwrap().success());
}
