//! The async runtime the engine's background tasks run on. The program that hosts the engine hands over a handle once at start-up (the desktop
//! app gives Tauri's runtime, the server its own), so tasks can be started from any thread, including ones with no runtime of their own.

use std::future::Future;
use std::sync::OnceLock;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

static HANDLE: OnceLock<Handle> = OnceLock::new();

/// Call once, before anything is started. A second call is ignored.
pub fn init(handle: Handle) {
    let _ = HANDLE.set(handle);
}

pub fn spawn<F>(future: F) -> JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    match HANDLE.get() {
        Some(h) => h.spawn(future),
        // no handle given: the runtime of the calling thread (tests, and tasks started from inside other tasks)
        None => tokio::spawn(future),
    }
}

pub fn spawn_blocking<F, R>(f: F) -> JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    match HANDLE.get() {
        Some(h) => h.spawn_blocking(f),
        None => tokio::task::spawn_blocking(f),
    }
}
