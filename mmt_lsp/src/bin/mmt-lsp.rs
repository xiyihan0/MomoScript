use lsp_server::{Connection, Message, Notification, Response};
use mmt_lsp::MmtLanguageServer;

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
                let response = match server.request(&request.method, request.params) {
                    Ok(result) => Response::new_ok(request.id, result),
                    Err(error) => Response::new_err(request.id, error.code, error.message),
                };
                connection.sender.send(Message::Response(response))?;
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
