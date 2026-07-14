use lsp_server::{Connection, Message, Notification, Response};
use mmt_lsp::{MmtLanguageServer, ServerEvent};

fn main() -> Result<(), Box<dyn std::error::Error + Sync + Send>> {
    let (connection, io_threads) = Connection::stdio();
    let (initialize_id, initialize_params) = connection.initialize_start()?;
    let mut server = MmtLanguageServer::default();
    let initialize_result = server
        .request("initialize", initialize_params)
        .map_err(|error| error.message)?;
    connection.initialize_finish(initialize_id, initialize_result)?;

    for message in &connection.receiver {
        match message {
            Message::Request(request) => {
                if request.method == "shutdown" {
                    let _ = server.request("shutdown", request.params.clone());
                }
                if connection.handle_shutdown(&request)? {
                    break;
                }
                let (response, events) = match server.request(&request.method, request.params) {
                    Ok(result) => {
                        let events = result
                            .get("events")
                            .cloned()
                            .and_then(|value| {
                                serde_json::from_value::<Vec<ServerEvent>>(value).ok()
                            })
                            .unwrap_or_default();
                        let events = if request.method == "mmt/updateDocument" {
                            events
                                .into_iter()
                                .filter(|event| event.method != "mmt/typstProjectUpdated")
                                .collect()
                        } else {
                            events
                        };
                        let response_result = if request.method == "mmt/updateDocument" {
                            result
                                .get("project")
                                .cloned()
                                .unwrap_or(serde_json::Value::Null)
                        } else {
                            result
                        };
                        (Response::new_ok(request.id, response_result), events)
                    }
                    Err(error) => (
                        Response::new_err(request.id, error.code, error.message),
                        Vec::new(),
                    ),
                };
                connection.sender.send(Message::Response(response))?;
                for event in events {
                    connection.sender.send(Message::Notification(Notification {
                        method: event.method,
                        params: event.params,
                    }))?;
                }
            }
            Message::Notification(notification) => {
                let method = notification.method;
                let outcome = server.notification_outcome(&method, notification.params);
                if let Some(error) = outcome.error {
                    eprintln!(
                        "{}",
                        serde_json::json!({
                            "level": "error",
                            "method": method,
                            "code": error.code,
                            "message": error.message,
                        })
                    );
                }
                for event in outcome.events {
                    connection.sender.send(Message::Notification(Notification {
                        method: event.method,
                        params: event.params,
                    }))?;
                }
            }
            Message::Response(_) => {}
        }
    }

    drop(connection);
    io_threads.join()?;
    Ok(())
}
