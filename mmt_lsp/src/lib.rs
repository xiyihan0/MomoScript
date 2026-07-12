mod position;
mod server;
mod service;
mod typst_backend;

pub use server::{MmtLanguageServer, NotificationOutcome, ServerError, ServerEvent};
pub use service::{DocumentSnapshot, LanguageService};
pub use typst_backend::{
    ProjectedPosition, ProjectionDocument, ProjectionStore, TypstProjectUpdate, TypstVirtualFile,
};

#[cfg(target_arch = "wasm32")]
mod wasm {
    use wasm_bindgen::prelude::*;

    use crate::MmtLanguageServer;

    #[wasm_bindgen]
    pub struct WasmLanguageServer {
        inner: MmtLanguageServer,
    }

    #[wasm_bindgen]
    impl WasmLanguageServer {
        #[wasm_bindgen(constructor)]
        pub fn new() -> Self {
            Self {
                inner: MmtLanguageServer::default(),
            }
        }

        pub fn request(&mut self, method: &str, params: &str) -> String {
            self.inner.request_json(method, params)
        }

        pub fn notification(&mut self, method: &str, params: &str) -> String {
            self.inner.notification_json(method, params)
        }
    }
}
