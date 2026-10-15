#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Harvester's desktop window. Everything the window can ask for is answered by the engine (`harvester_engine::core::Core`): the window sends
//! every command through the single `rpc` command below, and the engine's events are forwarded to it. The web server (`harvester-server`)
//! offers the very same commands to a browser.

use harvester_engine::core::Core;
use harvester_engine::events::{Events, Sink};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

/// Forwards the engine's events to the window.
struct TauriSink(AppHandle);

impl Sink for TauriSink {
    fn emit(&self, event: &str, payload: Value) {
        let _ = self.0.emit(event, payload);
    }
}

/// Run one engine command: `name` and its arguments (a JSON object); the answer is JSON, an error is its message.
#[tauri::command]
async fn rpc(core: State<'_, Arc<Core>>, name: String, args: Option<Value>) -> Result<Value, String> {
    let core: Arc<Core> = core.inner().clone();
    core.dispatch(&name, &args.unwrap_or(Value::Null)).await
}

fn main() {
    let _ = dotenvy::dotenv(); // keys and limits from a .env file (searched upwards from the working directory)
    // the engine's background tasks run on Tauri's runtime
    match tauri::async_runtime::handle() {
        tauri::async_runtime::RuntimeHandle::Tokio(h) => harvester_engine::rt::init(h.clone()),
        #[allow(unreachable_patterns)]
        _ => {}
    }
    tauri::Builder::default()
        .setup(|app| {
            let core = Core::new(Events::new(TauriSink(app.handle().clone())), true);
            core.start_background(Some("desktop app"));
            app.manage(core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc])
        .run(tauri::generate_context!())
        .expect("error while running Harvester");
}
