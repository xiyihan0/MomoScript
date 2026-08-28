use std::io::{BufRead, BufReader, Read, Write};
use std::process::{ChildStdin, ChildStdout, Command, Stdio};

use lsp_types::PositionEncodingKind;
use mmt_lsp::{MmtLanguageServer, position::LineIndex};
use serde_json::{Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/basic-session.json")).unwrap()
}

fn preview_target_params(update: &Value) -> Value {
    let entry_uri = update["entryUri"].as_str().unwrap();
    let generated = update["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["uri"].as_str() == Some(entry_uri))
        .and_then(|file| file["text"].as_str())
        .unwrap();
    let glyph = generated.find("#text(\"").unwrap() + 1;
    let lines = LineIndex::new(generated);
    let start = lines
        .position(generated, glyph, &PositionEncodingKind::UTF8)
        .unwrap();
    let end = lines
        .position(generated, glyph + 1, &PositionEncodingKind::UTF8)
        .unwrap();
    json!({
        "sourceUri": update["sourceUri"],
        "revision": update["revision"],
        "sourceContent": update["sourceContent"],
        "projectDigest": update["projectDigest"],
        "projectionKey": update["projectionKey"],
        "entryUri": update["entryUri"],
        "backendEncoding": "utf-8",
        "location": {
            "uri": update["entryUri"],
            "range": {"start": start, "end": end}
        }
    })
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
    let shared_events = shared
        .notification("textDocument/didOpen", fixture["open"].clone())
        .unwrap();
    let shared_update = shared_events
        .iter()
        .find(|event| event.method == "mmt/typstProjectUpdated")
        .unwrap()
        .params
        .clone();
    let expected_target = shared
        .request(
            "mmt/previewComposerTarget",
            preview_target_params(&shared_update),
        )
        .unwrap();
    assert_eq!(
        expected_target["properties"]["statementText"],
        json!({
            "current":"hello",
            "mode":"inherit",
            "resolvedMode":"textMacro",
            "inheritedMode":"textMacro"
        })
    );
    let composer_edit_params = json!({
        "textDocument": expected_target["textDocument"],
        "target": expected_target["target"],
        "command": {"kind": "setStatementContinued", "value": "true"}
    });
    let expected_edit = shared
        .request("mmt/composerEdit", composer_edit_params.clone())
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
    let native_target_params = preview_target_params(&projection_update["params"]);
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

    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "mmt/previewComposerTarget",
            "params": native_target_params
        }),
    );
    assert_eq!(receive(&mut stdout)["result"], expected_target);
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "mmt/composerEdit",
            "params": composer_edit_params
        }),
    );
    assert_eq!(receive(&mut stdout)["result"], expected_edit);
    let manifest = json!({
        "schema": "mmt-pack.v3",
        "pack": {"namespace": "ba", "name": "BA fixture", "version": "1", "type": "base"},
        "entities": {
            "柚子": {"names": ["柚子", "Yuzu"], "display_name": "柚子", "slots": {
                "avatar": {"default": "default", "items": {
                    "default": {"storage": "avatars", "path": "yuzu.png"}
                }}
            }},
            "佳代子": {"names": ["佳代子"], "display_name": "佳代子", "slots": {
                "avatar": {"default": "default", "items": {
                    "default": {"storage": "avatars", "path": "kayoko.png"}
                }}
            }}
        },
        "storage": {"avatars": {"kind": "image-dir", "base": "assets/avatar"}}
    })
    .to_string();
    let avatar_uri = "file:///workspace/avatar.mmt";
    let avatar_open = json!({"textDocument":{
        "uri":avatar_uri,"languageId":"mmt","version":1,
        "text":"> 柚子: before\n> _0: target"
    }});
    shared
        .request(
            "mmt/updatePackManifests",
            json!({"revision":1,"sources":[{"json":manifest.clone()}]}),
        )
        .unwrap();
    let shared_avatar_events = shared
        .notification("textDocument/didOpen", avatar_open.clone())
        .unwrap();
    let shared_avatar_projection = shared_avatar_events
        .iter()
        .find(|event| event.method == "mmt/typstProjectUpdated")
        .unwrap()
        .params
        .clone();
    let expected_avatar_target = shared
        .request(
            "mmt/previewComposerTarget",
            preview_target_params(&shared_avatar_projection),
        )
        .unwrap();
    let avatar_command = json!({
        "textDocument":expected_avatar_target["textDocument"],
        "target":expected_avatar_target["target"],
        "command":{"kind":"setActorAvatarFromStatement","avatar":{
            "kind":"packAvatar","entityId":"ba::佳代子",
            "contributionNamespace":"ba","variantId":"default"
        }}
    });
    let expected_avatar_edit = shared
        .request("mmt/composerEdit", avatar_command.clone())
        .unwrap();
    assert_eq!(
        expected_avatar_edit["kind"], "Edit",
        "{expected_avatar_edit}"
    );
    assert_eq!(
        expected_avatar_target["properties"]["statementText"],
        json!({
            "current":"before",
            "mode":"inherit",
            "resolvedMode":"textMacro",
            "inheritedMode":"textMacro"
        })
    );
    let message_command = json!({
        "textDocument":expected_avatar_target["textDocument"],
        "target":expected_avatar_target["target"],
        "command":{"kind":"setStatementText","value":"native 正文😀 \\\\path"}
    });
    let expected_message_edit = shared
        .request("mmt/composerEdit", message_command.clone())
        .unwrap();
    assert_eq!(
        expected_message_edit["kind"], "Edit",
        "{expected_message_edit}"
    );
    send(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 7,
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
            "id": 8,
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
        &json!({
            "jsonrpc":"2.0",
            "method":"textDocument/didOpen",
            "params":avatar_open
        }),
    );
    assert_eq!(
        receive(&mut stdout)["method"],
        "textDocument/publishDiagnostics"
    );
    let avatar_projection = receive(&mut stdout);
    assert_eq!(avatar_projection["method"], "mmt/typstProjectUpdated");
    send(
        &mut stdin,
        &json!({
            "jsonrpc":"2.0","id":9,"method":"mmt/previewComposerTarget",
            "params":preview_target_params(&avatar_projection["params"])
        }),
    );
    let avatar_target = receive(&mut stdout)["result"].clone();
    assert_eq!(avatar_target, expected_avatar_target);
    assert_eq!(
        avatar_target["properties"]["actorAvatar"],
        json!({
            "scope":"fromStatement",
            "actorPresetId":"ba::柚子",
            "current":{
                "kind":"packAvatar","entityId":"ba::柚子",
                "contributionNamespace":"ba","variantId":"default"
            }
        })
    );
    send(
        &mut stdin,
        &json!({
            "jsonrpc":"2.0","id":10,"method":"mmt/composerEdit",
            "params":avatar_command
        }),
    );
    let avatar_edit = receive(&mut stdout)["result"].clone();
    assert_eq!(avatar_edit, expected_avatar_edit);
    assert_eq!(avatar_edit["kind"], "Edit", "{avatar_edit}");
    assert!(
        avatar_edit["edit"]["documentChanges"][0]["edits"][0]["newText"]
            .as_str()
            .unwrap()
            .contains("avatar: ba::佳代子/ba::avatar/default")
    );

    send(
        &mut stdin,
        &json!({
            "jsonrpc":"2.0","id":11,"method":"mmt/composerEdit",
            "params":message_command
        }),
    );
    let message_edit = receive(&mut stdout)["result"].clone();
    assert_eq!(message_edit, expected_message_edit);
    assert_eq!(
        message_edit["edit"]["documentChanges"][0]["edits"][0]["newText"],
        "native 正文😀 \\\\path"
    );

    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "id": 12, "method": "shutdown", "params": null}),
    );
    assert_eq!(receive(&mut stdout)["result"], Value::Null);
    send(
        &mut stdin,
        &json!({"jsonrpc": "2.0", "method": "exit", "params": null}),
    );
    drop(stdin);
    assert!(child.wait().unwrap().success());
}
