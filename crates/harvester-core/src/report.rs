//! The texts of Harvester's Telegram bot: the periodic summary, the position and order lists, and the parsing of a command the user types.
//! Pure formatting (Telegram HTML); fetching the data and sending the messages is done in the app.

use crate::alerts::{parse_level, ExitKind, Level};

/// Telegram's HTML needs these three escaped.
pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

pub fn money(x: f64) -> String {
    format!("{}${:.2}", if x < 0.0 { "-" } else { "" }, x.abs())
}

pub fn signed(x: f64) -> String {
    format!("{}${:.2}", if x < 0.0 { "-" } else { "+" }, x.abs())
}

/// A price with about as many decimals as it needs: 83778.8, 1.2345, 0.012345.
pub fn price(x: f64) -> String {
    if x == 0.0 {
        "0".into()
    } else if x.abs() >= 1000.0 {
        format!("{x:.1}")
    } else if x.abs() >= 1.0 {
        format!("{x:.4}")
    } else if x.abs() >= 0.01 {
        format!("{x:.5}")
    } else {
        format!("{x:.7}")
    }
}

fn coin(symbol: &str) -> String {
    esc(symbol.strip_suffix("USDT").unwrap_or(symbol))
}

#[derive(Debug, Clone, PartialEq)]
pub struct PositionRow {
    pub symbol: String,
    /// signed: positive = long
    pub amount: f64,
    pub entry: f64,
    pub mark: f64,
    pub upnl: f64,
    pub leverage: f64,
    pub isolated: bool,
    pub liquidation: f64,
    pub stop: Option<f64>,
    pub take: Option<f64>,
}

impl PositionRow {
    pub fn value(&self) -> f64 {
        self.amount.abs() * self.mark
    }
    /// P&L in percent of the margin put in
    pub fn roe_pct(&self) -> f64 {
        let margin = self.amount.abs() * self.entry / self.leverage.max(1.0);
        if margin > 0.0 {
            self.upnl / margin * 100.0
        } else {
            0.0
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct OrderRow {
    pub symbol: String,
    pub side: String,
    pub kind: String,
    pub price: f64,
    pub stop_price: f64,
    pub qty: f64,
    pub reduce_only: bool,
}

/// Which open order is the stop-loss and which the take-profit of a position of `symbol` (`long` = the position is long): the exits are
/// reduce-only orders on the other side, a stop type for the stop-loss and a take-profit type or a plain limit for the take-profit.
pub fn exits_of(orders: &[OrderRow], symbol: &str, long: bool) -> (Option<f64>, Option<f64>) {
    let exit_side = if long { "SELL" } else { "BUY" };
    let (mut stop, mut take) = (None, None);
    for o in orders.iter().filter(|o| o.symbol == symbol && o.side == exit_side && o.reduce_only) {
        let level = if o.stop_price > 0.0 { o.stop_price } else { o.price };
        if o.kind.starts_with("STOP") {
            stop = Some(level);
        } else if o.kind.starts_with("TAKE_PROFIT") || o.kind == "LIMIT" {
            take = Some(level);
        }
    }
    (stop, take)
}

pub struct Summary<'a> {
    pub env: &'a str,
    pub time: &'a str,
    pub wallet: f64,
    pub available: f64,
    pub upnl: f64,
    /// equity when the bot started, and at the previous report
    pub session_start: Option<f64>,
    pub previous: Option<f64>,
    pub positions: &'a [PositionRow],
    pub open_orders: usize,
    /// the best entries the scanner shows: (symbol, kind, score)
    pub signals: &'a [(String, String, u8)],
}

fn position_line(p: &PositionRow) -> String {
    let side = if p.amount > 0.0 { "LONG" } else { "SHORT" };
    let mut s = format!("<b>{}</b> {} {}x {}  {} ({:+.1}%)", coin(&p.symbol), side, p.leverage, if p.isolated { "iso" } else { "cross" }, signed(p.upnl), p.roe_pct());
    s.push_str(&format!("\n   entry {} · now {}", price(p.entry), price(p.mark)));
    s.push_str(&format!(" · SL {} · TP {}", p.stop.map_or("none".into(), price), p.take.map_or("none".into(), price)));
    if p.liquidation > 0.0 {
        s.push_str(&format!(" · liq {}", price(p.liquidation)));
    }
    s
}

/// The summary sent every half hour and on /status.
pub fn format_summary(s: &Summary) -> String {
    let equity = s.wallet + s.upnl;
    let mut m = format!("<b>Harvester</b> · {} · {}\n", esc(s.env), esc(s.time));
    m.push_str(&format!("<b>Equity {}</b>", money(equity)));
    if let Some(b) = s.session_start {
        m.push_str(&format!("  ({} since the bot started)", signed(equity - b)));
    }
    m.push('\n');
    if let Some(p) = s.previous {
        m.push_str(&format!("Since the last report: {}\n", signed(equity - p)));
    }
    m.push_str(&format!("Wallet {} · unrealised {} · available {}\n", money(s.wallet), signed(s.upnl), money(s.available)));
    if s.positions.is_empty() {
        m.push_str("\nNo open positions.");
    } else {
        let value: f64 = s.positions.iter().map(|p| p.value()).sum();
        m.push_str(&format!("\n<b>{} open position(s)</b> · value {} ({:.2}x equity)\n", s.positions.len(), money(value), if equity > 0.0 { value / equity } else { 0.0 }));
        let mut sorted: Vec<&PositionRow> = s.positions.iter().collect();
        sorted.sort_by(|a, b| a.upnl.partial_cmp(&b.upnl).unwrap_or(std::cmp::Ordering::Equal));
        for p in sorted.iter().take(10) {
            m.push_str(&position_line(p));
            m.push('\n');
        }
        if sorted.len() > 10 {
            m.push_str(&format!("… and {} more (/positions)\n", sorted.len() - 10));
        }
        let naked: Vec<String> = s.positions.iter().filter(|p| p.stop.is_none()).map(|p| coin(&p.symbol)).collect();
        if !naked.is_empty() {
            m.push_str(&format!("\n⚠️ No stop-loss: {}\n", naked.join(", ")));
        }
    }
    m.push_str(&format!("\nOpen orders: {}", s.open_orders));
    if !s.signals.is_empty() {
        m.push_str("\n\n<b>Scanner</b>: ");
        m.push_str(&s.signals.iter().map(|(sym, kind, score)| format!("{} {} {}", coin(sym), esc(kind), score)).collect::<Vec<_>>().join(" · "));
    }
    m
}

pub fn format_positions(positions: &[PositionRow]) -> String {
    if positions.is_empty() {
        return "No open positions.".into();
    }
    let total: f64 = positions.iter().map(|p| p.upnl).sum();
    let mut m = format!("<b>{} open position(s)</b> · unrealised {}\n", positions.len(), signed(total));
    let mut sorted: Vec<&PositionRow> = positions.iter().collect();
    sorted.sort_by(|a, b| a.upnl.partial_cmp(&b.upnl).unwrap_or(std::cmp::Ordering::Equal));
    for p in sorted {
        m.push_str(&position_line(p));
        m.push('\n');
    }
    m
}

pub fn format_orders(orders: &[OrderRow]) -> String {
    if orders.is_empty() {
        return "No open orders.".into();
    }
    let mut m = format!("<b>{} open order(s)</b>\n", orders.len());
    for o in orders.iter().take(40) {
        let level = if o.stop_price > 0.0 && o.price == 0.0 { o.stop_price } else { o.price };
        m.push_str(&format!("{} {} {} {} @ {}{}\n", coin(&o.symbol), esc(&o.side), esc(&o.kind.replace('_', " ").to_lowercase()), o.qty, price(level), if o.reduce_only { " (reduce-only)" } else { "" }));
    }
    if orders.len() > 40 {
        m.push_str(&format!("… and {} more\n", orders.len() - 40));
    }
    m
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    Help,
    Status,
    Positions,
    Orders,
    Signals,
    /// a chart picture of one symbol, on this timeframe (None = the default)
    Chart { symbol: String, timeframe: Option<String> },
    /// a picture of every open position
    Charts,
    /// close the whole position of this symbol at market
    Close(String),
    /// set (or move) the stop-loss or take-profit of a position
    Exit { kind: ExitKind, symbol: String, level: Level },
    /// open a position at market with this much margin (asks to be confirmed first)
    Open { long: bool, symbol: String, margin: f64 },
    Confirm,
    Cancel,
    /// the command was not understood; the text is what was typed
    Unknown(String),
    /// a usage problem the user should be told about
    Usage(&'static str),
    /// not a command at all (plain chat): stay quiet
    NotACommand,
}

pub const HELP: &str = "<b>Harvester commands</b>\n\
/status - the summary now\n\
/positions - open positions with entry, stop, target and liquidation\n\
/orders - open orders\n\
/signals - the scanner's best entries\n\
/chart SYMBOL [timeframe] - a chart picture (e.g. /chart BTC 1h), with your position and orders drawn on it\n\
/charts - a picture of every open position\n\
/close SYMBOL - close that position at market, at once (e.g. /close BTC)\n\
/stop SYMBOL LEVEL - set or move the stop-loss: a price or a distance (/stop BTC 95000, /stop BTC 2%)\n\
/tp SYMBOL LEVEL - the same for the take-profit\n\
/long SYMBOL USDT, /short SYMBOL USDT - open a position at market with that much margin; asks for /confirm first\n\
/cancel - drop a pending /long or /short\n\
\nAlerts arrive by themselves: a position opened or closed (stop-loss / take-profit hit), close to liquidation, a delisting of a coin you hold, a very strong scanner entry. The summary comes every 30 minutes.";

const TIMEFRAMES: &[&str] = &["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d"];

/// Turn a `SYMBOL` the way people type it (btc, BTC, btcusdt) into Binance's name.
pub fn normalize_symbol(raw: &str) -> Option<String> {
    let up = raw.trim().to_uppercase();
    if up.is_empty() || up.len() > 20 || !up.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(if up.ends_with("USDT") { up } else { format!("{up}USDT") })
}

pub fn parse_command(text: &str) -> Command {
    let mut parts = text.split_whitespace();
    let Some(first) = parts.next() else { return Command::NotACommand };
    if !first.starts_with('/') {
        return Command::NotACommand;
    }
    let name = first.trim_start_matches('/').split('@').next().unwrap_or("").to_lowercase();
    let args: Vec<&str> = parts.collect();
    match name.as_str() {
        "help" | "start" => Command::Help,
        "status" => Command::Status,
        "positions" | "pos" => Command::Positions,
        "orders" => Command::Orders,
        "signals" => Command::Signals,
        "charts" => Command::Charts,
        "stop" | "tp" => {
            let kind = if name == "stop" { ExitKind::Stop } else { ExitKind::Take };
            match args.as_slice() {
                [sym, lvl] => match (normalize_symbol(sym), parse_level(lvl)) {
                    (Some(symbol), Some(level)) => Command::Exit { kind, symbol, level },
                    _ => Command::Usage("Use a symbol and a price or a percentage, for example /stop BTC 95000 or /stop BTC 2%"),
                },
                _ => Command::Usage("Usage: /stop SYMBOL LEVEL or /tp SYMBOL LEVEL. LEVEL is a price (95000) or a distance from the price (2%)."),
            }
        }
        "long" | "short" => match args.as_slice() {
            [sym, amount] => match (normalize_symbol(sym), amount.parse::<f64>().ok().filter(|a| a.is_finite() && *a > 0.0)) {
                (Some(symbol), Some(margin)) => Command::Open { long: name == "long", symbol, margin },
                _ => Command::Usage("Use a symbol and the margin in USDT, for example /long BTC 100"),
            },
            _ => Command::Usage("Usage: /long SYMBOL USDT or /short SYMBOL USDT (the margin to put in; the position is that times the leverage)"),
        },
        "confirm" => Command::Confirm,
        "cancel" => Command::Cancel,
        "close" => match args.as_slice() {
            [sym] => match normalize_symbol(sym) {
                Some(symbol) => Command::Close(symbol),
                None => Command::Usage("That does not look like a symbol. Example: /close BTC"),
            },
            _ => Command::Usage("Usage: /close SYMBOL, for example /close BTC (closes that whole position at market)"),
        },
        "chart" => {
            let Some(sym) = args.first() else { return Command::Usage("Usage: /chart SYMBOL [timeframe], for example /chart BTC 1h") };
            let Some(symbol) = normalize_symbol(sym) else { return Command::Usage("That does not look like a symbol. Example: /chart BTC 1h") };
            let timeframe = match args.get(1) {
                Some(t) => {
                    let t = t.to_lowercase();
                    if !TIMEFRAMES.contains(&t.as_str()) {
                        return Command::Usage("Timeframes: 1m 3m 5m 15m 30m 1h 2h 4h 6h 12h 1d");
                    }
                    Some(t)
                }
                None => None,
            };
            Command::Chart { symbol, timeframe }
        }
        other => Command::Unknown(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(symbol: &str, amount: f64, upnl: f64, stop: Option<f64>) -> PositionRow {
        PositionRow { symbol: symbol.into(), amount, entry: 100.0, mark: 101.0, upnl, leverage: 10.0, isolated: true, liquidation: 91.0, stop, take: Some(110.0) }
    }

    #[test]
    fn the_summary_carries_the_key_numbers_and_flags_a_missing_stop() {
        let positions = vec![pos("ETHUSDT", 2.0, 2.0, Some(95.0)), pos("A<B>USDT", -1.0, -5.0, None)];
        let signals = vec![("SOLUSDT".to_string(), "crack".to_string(), 82u8)];
        let m = format_summary(&Summary { env: "testnet", time: "14:30 UTC", wallet: 1000.0, available: 800.0, upnl: -3.0, session_start: Some(990.0), previous: Some(1010.0), positions: &positions, open_orders: 3, signals: &signals });
        assert!(m.contains("Equity $997.00"), "{m}");
        assert!(m.contains("+$7.00 since the bot started"), "{m}");
        assert!(m.contains("Since the last report: -$13.00"), "{m}");
        assert!(m.contains("2 open position(s)"), "{m}");
        assert!(m.contains("A&lt;B&gt;</b> SHORT"), "markup is escaped: {m}");
        assert!(m.contains("No stop-loss: A&lt;B&gt;"), "{m}");
        assert!(m.contains("SOL crack 82") && m.contains("Open orders: 3"), "{m}");
        // the loser is listed first
        assert!(m.find("A&lt;B&gt;</b> SHORT").unwrap() < m.find("<b>ETH</b>").unwrap(), "{m}");
    }

    #[test]
    fn no_positions_is_said_plainly() {
        let m = format_summary(&Summary { env: "live", time: "t", wallet: 50.0, available: 50.0, upnl: 0.0, session_start: None, previous: None, positions: &[], open_orders: 0, signals: &[] });
        assert!(m.contains("No open positions.") && !m.contains("since the bot started") && !m.contains("Scanner"), "{m}");
        assert_eq!(format_positions(&[]), "No open positions.");
        assert_eq!(format_orders(&[]), "No open orders.");
    }

    #[test]
    fn roe_is_pnl_over_the_margin() {
        let p = pos("ETHUSDT", 2.0, 2.0, None);
        // margin = 2 * 100 / 10 = 20, so 2.0 of profit is 10 percent
        assert!((p.roe_pct() - 10.0).abs() < 1e-9);
        assert!((p.value() - 202.0).abs() < 1e-9);
    }

    fn order(side: &str, kind: &str, price: f64, stop: f64, reduce: bool) -> OrderRow {
        OrderRow { symbol: "ETHUSDT".into(), side: side.into(), kind: kind.into(), price, stop_price: stop, qty: 1.0, reduce_only: reduce }
    }

    #[test]
    fn stops_and_targets_are_found_among_the_orders() {
        let orders = vec![order("SELL", "STOP_MARKET", 0.0, 95.0, true), order("SELL", "TAKE_PROFIT_MARKET", 0.0, 110.0, true), order("BUY", "LIMIT", 90.0, 0.0, false)];
        assert_eq!(exits_of(&orders, "ETHUSDT", true), (Some(95.0), Some(110.0)));
        // for a short the exits are buys: the sell orders above are not its exits
        assert_eq!(exits_of(&orders, "ETHUSDT", false), (None, None));
        assert_eq!(exits_of(&orders, "BTCUSDT", true), (None, None));
        // a reduce-only limit counts as the target
        assert_eq!(exits_of(&[order("SELL", "LIMIT", 120.0, 0.0, true)], "ETHUSDT", true), (None, Some(120.0)));
    }

    #[test]
    fn commands_are_parsed_loosely() {
        assert_eq!(parse_command("/help"), Command::Help);
        assert_eq!(parse_command("/start"), Command::Help);
        assert_eq!(parse_command("/Status@my_bot"), Command::Status);
        assert_eq!(parse_command("/positions"), Command::Positions);
        assert_eq!(parse_command("/orders"), Command::Orders);
        assert_eq!(parse_command("/signals"), Command::Signals);
        assert_eq!(parse_command("/charts"), Command::Charts);
        assert_eq!(parse_command("/chart btc"), Command::Chart { symbol: "BTCUSDT".into(), timeframe: None });
        assert_eq!(parse_command("/chart ethusdt 4H"), Command::Chart { symbol: "ETHUSDT".into(), timeframe: Some("4h".into()) });
        assert!(matches!(parse_command("/chart"), Command::Usage(_)));
        assert!(matches!(parse_command("/chart btc 7x"), Command::Usage(_)));
        assert!(matches!(parse_command("/chart b;tc"), Command::Usage(_)));
        assert_eq!(parse_command("/close eth"), Command::Close("ETHUSDT".into()));
        assert_eq!(parse_command("/close ETHUSDT"), Command::Close("ETHUSDT".into()));
        assert!(matches!(parse_command("/close"), Command::Usage(_)));
        assert!(matches!(parse_command("/close btc eth"), Command::Usage(_)), "two symbols is ambiguous: nothing is closed");
        assert!(matches!(parse_command("/close b;tc"), Command::Usage(_)));
        assert_eq!(parse_command("/stop btc 2%"), Command::Exit { kind: ExitKind::Stop, symbol: "BTCUSDT".into(), level: Level::Pct(2.0) });
        assert_eq!(parse_command("/tp ETH 3500.5"), Command::Exit { kind: ExitKind::Take, symbol: "ETHUSDT".into(), level: Level::Price(3500.5) });
        assert!(matches!(parse_command("/stop btc"), Command::Usage(_)));
        assert!(matches!(parse_command("/stop btc -5"), Command::Usage(_)));
        assert!(matches!(parse_command("/tp btc abc"), Command::Usage(_)));
        assert_eq!(parse_command("/long btc 100"), Command::Open { long: true, symbol: "BTCUSDT".into(), margin: 100.0 });
        assert_eq!(parse_command("/short eth 25.5"), Command::Open { long: false, symbol: "ETHUSDT".into(), margin: 25.5 });
        assert!(matches!(parse_command("/long btc"), Command::Usage(_)));
        assert!(matches!(parse_command("/long btc 0"), Command::Usage(_)));
        assert!(matches!(parse_command("/long btc -5"), Command::Usage(_)));
        assert!(matches!(parse_command("/short btc ten"), Command::Usage(_)));
        assert_eq!(parse_command("/confirm"), Command::Confirm);
        assert_eq!(parse_command("/cancel"), Command::Cancel);
        assert_eq!(parse_command("/nope"), Command::Unknown("nope".into()));
        assert_eq!(parse_command("hello there"), Command::NotACommand);
        assert_eq!(parse_command("   "), Command::NotACommand);
    }

    #[test]
    fn prices_keep_a_sensible_number_of_decimals() {
        assert_eq!(price(83778.84), "83778.8");
        assert_eq!(price(1.23456789), "1.2346");
        assert_eq!(price(0.0123456), "0.01235");
        assert_eq!(price(0.00012345678), "0.0001235");
        assert_eq!(price(0.0), "0");
    }
}
