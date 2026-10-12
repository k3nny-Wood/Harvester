//! Harvester core: exchange-independent trading logic. No I/O, no clock; everything here is pure and tested.

pub mod decimal;
pub mod filters;
pub mod ladder;
pub mod candle;
pub mod qfl;
pub mod signals;
