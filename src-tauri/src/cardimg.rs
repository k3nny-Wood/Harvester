//! The Telegram summary, position and order lists as PICTURES: a phone shows text in a proportional font and wraps it, which scrambles
//! aligned columns; a picture looks the same everywhere. A card is a list of blocks (headings, lines, tables) that is laid out and drawn here.

use harvester_core::report::{money, price, signed, OrderRow, PositionRow, Summary};
use image::ImageEncoder;
use plotters::prelude::*;

const BG: RGBColor = RGBColor(10, 14, 20);
const TEXT: RGBColor = RGBColor(215, 221, 229);
const MUTED: RGBColor = RGBColor(150, 160, 175);
const GREEN: RGBColor = RGBColor(74, 222, 128);
const RED: RGBColor = RGBColor(255, 107, 107);
const AMBER: RGBColor = RGBColor(240, 185, 11);
const RULE: RGBColor = RGBColor(40, 48, 60);

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tone {
    Normal,
    Muted,
    Good,
    Bad,
    Warn,
}

impl Tone {
    fn color(self) -> RGBColor {
        match self {
            Tone::Normal => TEXT,
            Tone::Muted => MUTED,
            Tone::Good => GREEN,
            Tone::Bad => RED,
            Tone::Warn => AMBER,
        }
    }
}

fn tone_of(x: f64) -> Tone {
    if x > 0.0 {
        Tone::Good
    } else if x < 0.0 {
        Tone::Bad
    } else {
        Tone::Normal
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Cell {
    pub text: String,
    pub tone: Tone,
}

fn cell(text: impl Into<String>, tone: Tone) -> Cell {
    Cell { text: text.into(), tone }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Block {
    /// the card's title
    Title(String),
    /// one large figure
    Big(String, Tone),
    Line(String, Tone),
    Gap,
    Table { headers: Vec<String>, rows: Vec<Vec<Cell>> },
}

const PAD: i32 = 24;
const LOGO: i32 = 72;
const LOGO_PNG: &[u8] = include_bytes!("../icons/icon.png");
const TITLE: u32 = 36;
const BIG: u32 = 54;
const BODY: u32 = 27;
const COL_GAP: i32 = 30;

fn text_width(text: &str, size: u32) -> i32 {
    ("sans-serif", size).into_font().box_size(text).map(|(w, _)| w as i32).unwrap_or(text.chars().count() as i32 * size as i32 / 2)
}

fn block_height(b: &Block) -> i32 {
    match b {
        Block::Title(_) => LOGO + 14,
        Block::Big(..) => 76,
        Block::Line(..) => 42,
        Block::Gap => 18,
        Block::Table { rows, .. } => 44 + rows.len() as i32 * 42 + 10,
    }
}

/// Column widths of a table, from its widest cell.
fn column_widths(headers: &[String], rows: &[Vec<Cell>]) -> Vec<i32> {
    (0..headers.len()).map(|c| rows.iter().filter_map(|r| r.get(c)).map(|x| text_width(&x.text, BODY)).chain(std::iter::once(text_width(&headers[c], BODY - 4))).max().unwrap_or(0)).collect()
}

pub fn render(blocks: &[Block]) -> Result<Vec<u8>, String> {
    // the width: the widest thing on the card, at least a phone-friendly 760
    let mut content_w = 760;
    for b in blocks {
        let w = match b {
            Block::Title(t) => text_width(t, TITLE),
            Block::Big(t, _) => text_width(t, BIG),
            Block::Line(t, _) => text_width(t, BODY),
            Block::Gap => 0,
            Block::Table { headers, rows } => column_widths(headers, rows).iter().sum::<i32>() + COL_GAP * (headers.len() as i32 - 1).max(0),
        };
        content_w = content_w.max(w);
    }
    let width = (content_w + PAD * 2) as u32;
    let height = (blocks.iter().map(block_height).sum::<i32>() + PAD * 2) as u32;
    let mut buf = vec![0u8; (width * height * 3) as usize];
    {
        let root = BitMapBackend::with_buffer(&mut buf, (width, height)).into_drawing_area();
        root.fill(&BG).map_err(|e| e.to_string())?;
        let mut y = PAD;
        let put = |text: &str, x: i32, y: i32, size: u32, color: RGBColor| -> Result<(), String> {
            root.draw(&Text::new(text.to_string(), (x, y), ("sans-serif", size).into_font().color(&color))).map_err(|e| e.to_string())
        };
        for b in blocks {
            match b {
                Block::Title(t) => put(t, PAD + LOGO + 18, y + (LOGO - TITLE as i32) / 2 - 4, TITLE, TEXT)?,
                Block::Big(t, tone) => put(t, PAD, y, BIG, tone.color())?,
                Block::Line(t, tone) => put(t, PAD, y + 3, BODY, tone.color())?,
                Block::Gap => {}
                Block::Table { headers, rows } => {
                    let widths = column_widths(headers, rows);
                    let xs: Vec<i32> = widths.iter().scan(PAD, |x, w| { let here = *x; *x += w + COL_GAP; Some(here) }).collect();
                    for (h, x) in headers.iter().zip(&xs) {
                        put(h, *x, y + 4, BODY - 4, MUTED)?;
                    }
                    let rule_y = y + 40;
                    root.draw(&PathElement::new(vec![(PAD, rule_y), (width as i32 - PAD, rule_y)], RULE.stroke_width(1))).map_err(|e| e.to_string())?;
                    for (i, row) in rows.iter().enumerate() {
                        let ry = y + 48 + i as i32 * 42;
                        for (c, x) in row.iter().zip(&xs) {
                            put(&c.text, *x, ry, BODY, c.tone.color())?;
                        }
                    }
                }
            }
            y += block_height(b);
        }
        root.present().map_err(|e| e.to_string())?;
    }
    if matches!(blocks.first(), Some(Block::Title(_))) {
        draw_logo(&mut buf, width, PAD, PAD);
    }
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png).write_image(&buf, width, height, image::ExtendedColorType::Rgb8).map_err(|e| e.to_string())?;
    Ok(png)
}

/// The Harvester logo, scaled to LOGO pixels, blended onto the card at (x0, y0). A logo that cannot be read is left out.
fn draw_logo(buf: &mut [u8], width: u32, x0: i32, y0: i32) {
    let Ok(img) = image::load_from_memory_with_format(LOGO_PNG, image::ImageFormat::Png) else { return };
    let logo = image::imageops::resize(&img.to_rgba8(), LOGO as u32, LOGO as u32, image::imageops::FilterType::Lanczos3);
    for (lx, ly, px) in logo.enumerate_pixels() {
        let (x, y) = (x0 as u32 + lx, y0 as u32 + ly);
        let i = ((y * width + x) * 3) as usize;
        if i + 2 >= buf.len() {
            continue;
        }
        let a = px[3] as u32;
        for c in 0..3 {
            buf[i + c] = ((px[c] as u32 * a + buf[i + c] as u32 * (255 - a)) / 255) as u8;
        }
    }
}

fn coin(symbol: &str) -> String {
    symbol.strip_suffix("USDT").unwrap_or(symbol).to_string()
}

fn position_table(positions: &[PositionRow], limit: usize) -> Vec<Block> {
    let mut sorted: Vec<&PositionRow> = positions.iter().collect();
    sorted.sort_by(|a, b| a.upnl.partial_cmp(&b.upnl).unwrap_or(std::cmp::Ordering::Equal));
    let headers = ["Coin", "Side", "Lev", "P&L", "ROE", "Entry", "Now", "Stop", "Target", "Liq"].map(String::from).to_vec();
    let rows = sorted
        .iter()
        .take(limit)
        .map(|p| {
            let long = p.amount > 0.0;
            vec![
                cell(coin(&p.symbol), Tone::Normal),
                cell(if long { "LONG" } else { "SHORT" }, if long { Tone::Good } else { Tone::Bad }),
                cell(format!("{}x{}", p.leverage, if p.isolated { " iso" } else { "" }), Tone::Muted),
                cell(signed(p.upnl), tone_of(p.upnl)),
                cell(format!("{:+.1}%", p.roe_pct()), tone_of(p.upnl)),
                cell(price(p.entry), Tone::Normal),
                cell(price(p.mark), Tone::Normal),
                p.stop.map_or(cell("none", Tone::Warn), |s| cell(price(s), Tone::Normal)),
                p.take.map_or(cell("none", Tone::Muted), |t| cell(price(t), Tone::Normal)),
                if p.liquidation > 0.0 { cell(price(p.liquidation), Tone::Muted) } else { cell("-", Tone::Muted) },
            ]
        })
        .collect();
    let mut blocks = vec![Block::Table { headers, rows }];
    if sorted.len() > limit {
        blocks.push(Block::Line(format!("... and {} more (/positions shows all)", sorted.len() - limit), Tone::Muted));
    }
    blocks
}

/// The periodic summary / `/status`; `all` lists every position instead of the 10 doing worst.
pub fn summary_card(s: &Summary, all: bool) -> Vec<Block> {
    let equity = s.wallet + s.upnl;
    let mut b = vec![Block::Title(format!("Harvester  -  {}  -  {}", s.env, s.time)), Block::Big(format!("Equity {}", money(equity)), Tone::Normal)];
    let mut change = Vec::new();
    if let Some(start) = s.session_start {
        change.push(format!("{} since the bot started", signed(equity - start)));
    }
    if let Some(prev) = s.previous {
        change.push(format!("{} since the last report", signed(equity - prev)));
    }
    if !change.is_empty() {
        let net = s.previous.or(s.session_start).map_or(0.0, |x| equity - x);
        b.push(Block::Line(change.join("   -   "), tone_of(net)));
    }
    b.push(Block::Line(format!("Wallet {}     Unrealised {}     Available {}", money(s.wallet), signed(s.upnl), money(s.available)), Tone::Muted));
    b.push(Block::Gap);
    if s.positions.is_empty() {
        b.push(Block::Line("No open positions".into(), Tone::Muted));
    } else {
        let value: f64 = s.positions.iter().map(|p| p.value()).sum();
        b.push(Block::Line(format!("{} open position(s)   -   value {} ({:.2}x equity)", s.positions.len(), money(value), if equity > 0.0 { value / equity } else { 0.0 }), Tone::Normal));
        b.extend(position_table(s.positions, if all { usize::MAX } else { 10 }));
        let naked: Vec<String> = s.positions.iter().filter(|p| p.stop.is_none()).map(|p| coin(&p.symbol)).collect();
        if !naked.is_empty() {
            b.push(Block::Line(format!("WARNING: no stop-loss on {}", naked.join(", ")), Tone::Warn));
        }
    }
    b.push(Block::Gap);
    b.push(Block::Line(format!("Open orders: {}", s.open_orders), Tone::Muted));
    if !s.signals.is_empty() {
        b.push(Block::Line(format!("Scanner: {}", s.signals.iter().map(|(sym, kind, score)| format!("{} {} {}", coin(sym), kind, score)).collect::<Vec<_>>().join("   ")), Tone::Muted));
    }
    b
}

pub fn orders_card(env: &str, time: &str, orders: &[OrderRow]) -> Vec<Block> {
    let mut b = vec![Block::Title(format!("Open orders  -  {env}  -  {time}"))];
    if orders.is_empty() {
        b.push(Block::Line("No open orders".into(), Tone::Muted));
        return b;
    }
    let headers = ["Coin", "Side", "Type", "Qty", "Price", ""].map(String::from).to_vec();
    let rows = orders
        .iter()
        .take(40)
        .map(|o| {
            let level = if o.stop_price > 0.0 && o.price == 0.0 { o.stop_price } else { o.price };
            vec![
                cell(coin(&o.symbol), Tone::Normal),
                cell(o.side.clone(), if o.side == "BUY" { Tone::Good } else { Tone::Bad }),
                cell(o.kind.replace('_', " ").to_lowercase(), Tone::Muted),
                cell(format!("{}", o.qty), Tone::Normal),
                cell(price(level), Tone::Normal),
                cell(if o.reduce_only { "reduce-only" } else { "" }, Tone::Muted),
            ]
        })
        .collect();
    b.push(Block::Table { headers, rows });
    if orders.len() > 40 {
        b.push(Block::Line(format!("... and {} more", orders.len() - 40), Tone::Muted));
    }
    b
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pos(symbol: &str, amount: f64, upnl: f64, stop: Option<f64>) -> PositionRow {
        PositionRow { symbol: symbol.into(), amount, entry: 100.0, mark: 101.0, upnl, leverage: 10.0, isolated: true, liquidation: 91.0, stop, take: None }
    }

    fn lines(blocks: &[Block]) -> String {
        blocks
            .iter()
            .map(|b| match b {
                Block::Title(t) | Block::Big(t, _) | Block::Line(t, _) => t.clone(),
                Block::Gap => String::new(),
                Block::Table { rows, .. } => rows.iter().map(|r| r.iter().map(|c| c.text.clone()).collect::<Vec<_>>().join("|")).collect::<Vec<_>>().join("\n"),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_summary_card_has_the_numbers_and_the_worst_position_first() {
        let positions = vec![pos("ETHUSDT", 2.0, 2.0, Some(95.0)), pos("SOLUSDT", -1.0, -5.0, None)];
        let s = Summary { env: "testnet", time: "14:30 UTC", wallet: 1000.0, available: 800.0, upnl: -3.0, session_start: Some(990.0), previous: Some(1010.0), positions: &positions, open_orders: 3, signals: &[("BTCUSDT".into(), "crack".into(), 82)] };
        let t = lines(&summary_card(&s, false));
        assert!(t.contains("Equity $997.00") && t.contains("+$7.00 since the bot started") && t.contains("-$13.00 since the last report"), "{t}");
        assert!(t.contains("WARNING: no stop-loss on SOL") && t.contains("Open orders: 3") && t.contains("Scanner: BTC crack 82"), "{t}");
        assert!(t.find("SOL|SHORT").unwrap() < t.find("ETH|LONG").unwrap(), "{t}");
    }

    #[test]
    fn a_long_list_is_cut_unless_all_are_asked_for() {
        let positions: Vec<PositionRow> = (0..14).map(|i| pos(&format!("C{i}USDT"), 1.0, i as f64, Some(90.0))).collect();
        let s = Summary { env: "live", time: "t", wallet: 1.0, available: 1.0, upnl: 0.0, session_start: None, previous: None, positions: &positions, open_orders: 0, signals: &[] };
        assert!(lines(&summary_card(&s, false)).contains("and 4 more"));
        assert!(!lines(&summary_card(&s, true)).contains("and 4 more"));
    }

    #[test]
    fn cards_render_to_png() {
        let positions = vec![pos("ETHUSDT", 2.0, 2.0, Some(95.0)), pos("SOLUSDT", -1.0, -5.0, None)];
        let s = Summary { env: "testnet", time: "14:30 UTC", wallet: 1000.0, available: 800.0, upnl: -3.0, session_start: Some(990.0), previous: None, positions: &positions, open_orders: 1, signals: &[] };
        let png = render(&summary_card(&s, false)).expect("render");
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        assert!(png.len() > 3_000, "{} bytes", png.len());
        // for looking at the result: HARVESTER_CARD_OUT=file.png cargo test cards_render
        if let Ok(path) = std::env::var("HARVESTER_CARD_OUT") {
            std::fs::write(path, &png).unwrap();
        }
        let none = Summary { positions: &[], ..s };
        assert!(render(&summary_card(&none, false)).is_ok());
        let orders = vec![OrderRow { symbol: "ETHUSDT".into(), side: "SELL".into(), kind: "STOP_MARKET".into(), price: 0.0, stop_price: 95.0, qty: 2.0, reduce_only: true }];
        assert!(render(&orders_card("testnet", "t", &orders)).is_ok());
        assert!(render(&orders_card("testnet", "t", &[])).is_ok());
    }
}
