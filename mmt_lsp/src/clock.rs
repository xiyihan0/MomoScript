#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

pub(crate) struct StageTimer {
    #[cfg(not(target_arch = "wasm32"))]
    started: Instant,
    #[cfg(target_arch = "wasm32")]
    started_ms: f64,
}

impl StageTimer {
    pub(crate) fn start() -> Self {
        Self {
            #[cfg(not(target_arch = "wasm32"))]
            started: Instant::now(),
            #[cfg(target_arch = "wasm32")]
            started_ms: js_sys::Date::now(),
        }
    }

    pub(crate) fn elapsed_ms(&self) -> f64 {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.started.elapsed().as_secs_f64() * 1_000.0
        }
        #[cfg(target_arch = "wasm32")]
        {
            (js_sys::Date::now() - self.started_ms).max(0.0)
        }
    }
}
