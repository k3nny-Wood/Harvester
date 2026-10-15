//! Harvester's engine: everything that talks to Binance, Telegram and the news sources, without any window. See the crates that use it:
//! `src-tauri` (the desktop app) and `harvester-server` (the headless program).

pub mod ai;
pub mod brackets;
pub mod cardimg;
pub mod chartimg;
pub mod events;
pub mod held;
pub mod lab;
pub mod market;
pub mod marks;
pub mod movers;
pub mod news;
pub mod rt;
pub mod scanner;
pub mod stream;
pub mod telegram;
pub mod trading;
pub mod userstream;
