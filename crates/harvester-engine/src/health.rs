//! What the program knows about its own state, and its log file. A program with no window can only be checked through Telegram and this file.

use harvester_core::alerts::ymd;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// The log is cut in two when it passes this size (the older half is kept as `.old`).
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn log_path() -> PathBuf {
    let base = std::env::var("APPDATA").ok().filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf()))).unwrap_or_else(|| PathBuf::from("."));
    base.join("Harvester").join("harvester.log")
}

/// "2026-10-15 14:03:22" (UTC).
fn stamp(ms: u64) -> String {
    let s = ms / 1000;
    format!("{} {:02}:{:02}:{:02}", ymd(ms), (s / 3600) % 24, (s / 60) % 60, s % 60)
}

/// Print a line and append it, with the time, to the log file. A file that cannot be written is not an error: the line was still printed.
pub fn log(line: &str) {
    println!("{line}");
    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if std::fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, path.with_extension("log.old"));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{} {}", stamp(now_ms()), line);
    }
}

struct Inner {
    account_ok_ms: Option<u64>,
    last_error: Option<(u64, String)>,
}

pub struct Health {
    pub program: &'static str,
    started: Instant,
    inner: Mutex<Inner>,
}

impl Health {
    pub fn new(program: &'static str) -> Arc<Health> {
        Arc::new(Health { program, started: Instant::now(), inner: Mutex::new(Inner { account_ok_ms: None, last_error: None }) })
    }

    pub fn uptime_secs(&self) -> u64 {
        self.started.elapsed().as_secs()
    }

    pub fn record_ok(&self) {
        self.inner.lock().unwrap().account_ok_ms = Some(now_ms());
    }

    pub fn record_error(&self, text: &str) {
        self.inner.lock().unwrap().last_error = Some((now_ms(), text.chars().take(300).collect()));
    }

    /// Seconds since the account was last read successfully.
    pub fn account_ok_ago(&self) -> Option<u64> {
        self.inner.lock().unwrap().account_ok_ms.map(|t| now_ms().saturating_sub(t) / 1000)
    }

    /// (seconds ago, text) of the latest error.
    pub fn last_error(&self) -> Option<(u64, String)> {
        self.inner.lock().unwrap().last_error.clone().map(|(t, e)| (now_ms().saturating_sub(t) / 1000, e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn health_remembers_the_last_success_and_error() {
        let h = Health::new("test");
        assert_eq!(h.account_ok_ago(), None);
        assert_eq!(h.last_error(), None);
        h.record_ok();
        h.record_error("boom");
        assert!(h.account_ok_ago().unwrap() < 2);
        assert_eq!(h.last_error().unwrap().1, "boom");
        assert!(h.uptime_secs() < 2);
    }

    #[test]
    fn a_long_error_is_cut() {
        let h = Health::new("test");
        h.record_error(&"x".repeat(1000));
        assert_eq!(h.last_error().unwrap().1.len(), 300);
    }

    #[test]
    fn the_timestamp_is_utc() {
        assert_eq!(stamp(1_791_993_600_000 + 3_723_000), "2026-10-14 17:02:03");
    }
}
