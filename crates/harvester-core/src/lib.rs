//! Harvester core: exchange-independent trading logic. No I/O, no clock; everything here is pure and tested.

pub mod crossover;
pub mod decimal;
pub mod filters;
pub mod held;
pub mod lab;
pub mod ladder;
pub mod movers;
pub mod delist;
pub mod news;
pub mod candle;
pub mod qfl;
pub mod smc;
pub mod signals;
