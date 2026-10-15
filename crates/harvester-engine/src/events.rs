//! How the engine tells a user interface that something happened (a candle, a new signal, an order that changed). The desktop app forwards
//! these to its window; the headless server has no window and drops them.

use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

pub trait Sink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

struct Nowhere;

impl Sink for Nowhere {
    fn emit(&self, _event: &str, _payload: Value) {}
}

/// Cheap to clone; every clone sends to the same place.
#[derive(Clone)]
pub struct Events(Arc<dyn Sink>);

impl Events {
    pub fn new(sink: impl Sink + 'static) -> Events {
        Events(Arc::new(sink))
    }

    /// Events that nobody listens to.
    pub fn none() -> Events {
        Events(Arc::new(Nowhere))
    }

    pub fn emit<S: Serialize>(&self, event: &str, payload: S) {
        if let Ok(v) = serde_json::to_value(payload) {
            self.0.emit(event, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Collect(Arc<Mutex<Vec<(String, Value)>>>);

    impl Sink for Collect {
        fn emit(&self, event: &str, payload: Value) {
            self.0.lock().unwrap().push((event.to_string(), payload));
        }
    }

    #[test]
    fn events_reach_the_sink_as_json_and_none_drops_them() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let ev = Events::new(Collect(seen.clone()));
        ev.emit("kline", serde_json::json!({"a": 1}));
        ev.clone().emit("signals", vec![1, 2]);
        let got = seen.lock().unwrap().clone();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], ("kline".to_string(), serde_json::json!({"a": 1})));
        assert_eq!(got[1].1, serde_json::json!([1, 2]));
        Events::none().emit("x", 1); // does nothing, does not panic
    }
}
