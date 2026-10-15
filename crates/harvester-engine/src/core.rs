//! The whole engine behind one object, and every command a user interface can give it. The desktop window and the web server both call
//! `Core::dispatch(name, args)`, so they offer exactly the same things. Arguments are a JSON object with camelCase keys (as the UI sends
//! them) and the answer is JSON; an error is the message as text.

use crate::ai::{self, AiHub};
use crate::brackets::{self, BracketStore};
use crate::events::Events;
use crate::held::{self, HeldStore};
use crate::lab::{Lab, LabRequest};
use crate::market::{Env, Market};
use crate::marks::{self, Marks};
use crate::movers::{self, SharedDetector};
use crate::news::{self, NewsHub};
use crate::scanner::{Scanner, ScannerConfig, Sources};
use crate::stream::Streams;
use crate::trading::{OrderRequest, Trading};
use crate::{telegram, userstream};
use harvester_core::ladder::{build_ladder, LadderSpec};
use harvester_core::movers::{MoverDetector, MoverParams};
use harvester_core::qfl::{base_zones, QflParams};
use harvester_core::smc::{smc_zones, SmcParams};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub struct Core {
    pub events: Events,
    pub market: Arc<Market>,
    pub trading: Arc<Trading>,
    pub scanner: Scanner,
    pub news: Arc<NewsHub>,
    pub ai: Arc<AiHub>,
    pub held: Arc<HeldStore>,
    pub brackets: Arc<BracketStore>,
    pub marks: Marks,
    pub movers: SharedDetector,
    pub lab: Lab,
    pub streams: Streams,
    /// true when the user interface runs on this computer, so a link may be opened in its default browser
    pub local_ui: bool,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// One argument by name; a missing one is `null`, so an `Option` argument is simply absent.
fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(args.get(key).cloned().unwrap_or(Value::Null)).map_err(|e| format!("bad argument '{key}': {e}"))
}

fn out<T: Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| format!("could not answer: {e}"))
}

fn candles_of(rows: &[crate::market::Kline]) -> Vec<harvester_core::candle::Candle> {
    rows.iter().map(|k| harvester_core::candle::Candle::new(k.time, k.open, k.high, k.low, k.close, k.volume)).collect()
}

impl Core {
    /// Build everything from the environment (HARVESTER_ENV and the keys); nothing runs until `start_background`.
    pub fn new(events: Events, local_ui: bool) -> Arc<Core> {
        let env = Env::from_name(&std::env::var("HARVESTER_ENV").unwrap_or_default());
        let market = Arc::new(Market::new(env));
        Arc::new(Core {
            events,
            trading: Arc::new(Trading::new(market.clone())),
            market,
            scanner: Scanner::default(),
            news: Arc::new(NewsHub::new(news::default_names_path())),
            ai: Arc::new(AiHub::open(ai::default_path())),
            held: Arc::new(HeldStore::open(held::default_path())),
            brackets: Arc::new(BracketStore::open(brackets::default_path())),
            marks: Default::default(),
            movers: Arc::new(Mutex::new(MoverDetector::new(MoverParams::default()))),
            lab: Lab::default(),
            streams: Streams::default(),
            local_ui,
        })
    }

    /// The background work: the scanner, the account stream, armed and held orders, live prices, the pump / dump watcher, the news names and
    /// (with a program name) the Telegram bot.
    pub fn start_background(self: &Arc<Core>, telegram_program: Option<&'static str>) {
        self.scanner.start(self.events.clone(), self.market.clone(), ScannerConfig::default());
        userstream::start(self.events.clone(), self.trading.clone());
        brackets::start(self.events.clone(), self.trading.clone(), self.brackets.clone());
        marks::start(self.trading.clone(), self.marks.clone());
        {
            let hub = self.news.clone();
            crate::rt::spawn(async move { hub.load_names().await });
        }
        held::start(self.events.clone(), self.trading.clone(), self.held.clone());
        movers::start(self.events.clone(), self.market.clone(), self.scanner.injector(), self.movers.clone());
        if let Some(program) = telegram_program {
            telegram::start(self.trading.clone(), self.market.clone(), self.scanner.reader(), self.news.clone(), program);
        }
    }

    pub async fn dispatch(self: &Arc<Core>, cmd: &str, a: &Value) -> Result<Value, String> {
        match cmd {
            // ---- market data
            "environment" => out(self.market.env()),
            "set_environment" => {
                self.market.set_env(arg(a, "env")?);
                out(())
            }
            "list_symbols" => out(self.market.symbols().await?),
            "symbol_filters" => out(self.market.symbol_filters(&arg::<String>(a, "symbol")?).await?),
            "get_klines" => {
                let (symbol, interval): (String, String) = (arg(a, "symbol")?, arg(a, "interval")?);
                let limit: Option<u32> = arg(a, "limit")?;
                out(self.market.klines(&symbol, &interval, limit.unwrap_or(500), arg(a, "start")?, arg(a, "end")?).await?)
            }
            "subscribe_klines" => {
                let (symbol, interval): (String, String) = (arg(a, "symbol")?, arg(a, "interval")?);
                self.streams.subscribe(self.events.clone(), self.market.env(), &symbol, &interval);
                out(())
            }
            "unsubscribe_klines" => {
                let (symbol, interval): (String, String) = (arg(a, "symbol")?, arg(a, "interval")?);
                self.streams.unsubscribe(&symbol, &interval);
                out(())
            }
            "preview_ladder" => {
                let spec: LadderSpec = arg(a, "spec")?;
                let reference: f64 = arg(a, "referencePrice")?;
                let filters = self.market.symbol_filters(&spec.symbol).await?;
                out(build_ladder(&spec, &filters, reference))
            }
            "mark_prices" => {
                let symbols: Vec<String> = arg(a, "symbols")?;
                let m = self.marks.read().unwrap();
                out(marks::fresh(&m, &symbols, now_ms()))
            }
            "qfl_zones" => {
                let (symbol, interval): (String, String) = (arg(a, "symbol")?, arg(a, "interval")?);
                let (vf, crack, merge): (Option<f64>, Option<f64>, Option<f64>) = (arg(a, "volatilityFactor")?, arg(a, "crackPct")?, arg(a, "mergePct")?);
                let rows = self.market.klines(&symbol, &interval, 1000, None, None).await?;
                let params = QflParams { volatility_factor: vf.unwrap_or(1.0).clamp(0.1, 20.0), crack_pct: crack.unwrap_or(0.5).clamp(0.05, 20.0) / 100.0, ..QflParams::default() };
                out(base_zones(&candles_of(&rows), &params, merge.unwrap_or(0.5).clamp(0.0, 5.0), 60))
            }
            "smc_zones_cmd" => {
                let (symbol, interval): (String, String) = (arg(a, "symbol")?, arg(a, "interval")?);
                let (min_fvg, max_each): (Option<f64>, Option<usize>) = (arg(a, "minFvgPct")?, arg(a, "maxEach")?);
                let rows = self.market.klines(&symbol, &interval, 1000, None, None).await?;
                let params = SmcParams { min_fvg_size_pct: min_fvg.unwrap_or(0.5).clamp(0.05, 10.0), ..SmcParams::default() };
                out(smc_zones(&candles_of(&rows), &params, max_each.unwrap_or(6).clamp(1, 60)))
            }

            // ---- scanner
            "scanner_signals" => out(self.scanner.signals()),
            "scanner_status" => out(self.scanner.status()),
            "scanner_config" => out(self.scanner.config()),
            "scanner_sources" => {
                self.scanner.set_sources(&self.events, arg::<Sources>(a, "sources")?);
                out(())
            }
            "scanner_params" => {
                self.scanner.set_params(&self.events, arg(a, "params")?);
                out(())
            }
            "scanner_configure" => {
                self.scanner.start(self.events.clone(), self.market.clone(), arg::<ScannerConfig>(a, "config")?);
                out(())
            }
            "movers_config" => out(self.movers.lock().unwrap().params().clone()),
            "movers_configure" => {
                self.movers.lock().unwrap().set_params(arg(a, "params")?);
                out(())
            }

            // ---- trading
            "trading_status" => out(self.trading.status()),
            "account_overview" => out(self.trading.account().await?),
            "open_orders" => out(self.trading.open_orders(arg::<Option<String>>(a, "symbol")?.as_deref()).await?),
            "place_order" => out(held::place_or_hold(&self.trading, &self.held, arg::<OrderRequest>(a, "order")?).await?),
            "place_orders" => out(held::place_many_or_hold(&self.trading, &self.held, arg::<Vec<OrderRequest>>(a, "orders")?).await?),
            "cancel_order" => out(self.trading.cancel(&arg::<String>(a, "symbol")?, arg(a, "orderId")?, arg::<Option<bool>>(a, "conditional")?.unwrap_or(false)).await?),
            "modify_order" => {
                let symbol: String = arg(a, "symbol")?;
                out(self.trading.modify(&symbol, arg(a, "orderId")?, arg::<Option<bool>>(a, "conditional")?.unwrap_or(false), arg(a, "price")?, arg(a, "stopPrice")?, arg(a, "quantity")?).await?)
            }
            "resize_exits" => out(self.trading.resize_exits(&arg::<String>(a, "symbol")?, arg(a, "expected")?).await?),
            "order_history" => out(self.trading.order_history(&arg::<String>(a, "symbol")?, arg::<Option<u32>>(a, "limit")?.unwrap_or(100)).await?),
            "trade_history" => out(self.trading.trade_history(&arg::<String>(a, "symbol")?, arg::<Option<u32>>(a, "limit")?.unwrap_or(200)).await?),
            "leverage_brackets" => out(self.trading.leverage_brackets(&arg::<String>(a, "symbol")?).await?),
            "symbol_leverage" => out(self.trading.leverage(&arg::<String>(a, "symbol")?).await?),
            "cancel_all_orders" => out(self.trading.cancel_all(&arg::<String>(a, "symbol")?).await?),
            "close_position" => out(self.trading.close_position(&arg::<String>(a, "symbol")?, arg::<Option<f64>>(a, "fraction")?.unwrap_or(1.0)).await?),
            "set_cap_override" => {
                self.trading.set_cap_override(arg(a, "off")?);
                out(())
            }
            "set_margin_type" => out(self.trading.set_margin_type(&arg::<String>(a, "symbol")?, arg(a, "isolated")?).await?),
            "set_leverage" => out(self.trading.set_leverage(&arg::<String>(a, "symbol")?, arg(a, "leverage")?).await?),

            // ---- held and armed orders
            "held_list" => out(self.held.list(self.trading.env())),
            "held_cancel" => out(self.held.cancel(&arg::<String>(a, "id")?)),
            "held_move" => out(self.held.set_price(&arg::<String>(a, "id")?, arg(a, "price")?)?),
            "move_to_held" => out(held::move_to_held(&self.trading, &self.held, &arg::<String>(a, "symbol")?, arg(a, "orderId")?, arg(a, "price")?).await?),
            "bracket_add" => out(self.brackets.add(
                self.trading.env(),
                arg(a, "symbol")?,
                arg(a, "long")?,
                arg(a, "takeProfit")?,
                arg(a, "stopLoss")?,
                arg(a, "entryOrderId")?,
                arg(a, "entryConditional")?,
                arg::<Option<f64>>(a, "quantity")?.unwrap_or(0.0),
            )?),
            "bracket_list" => out(self.brackets.list(self.trading.env())),
            "bracket_cancel" => out(self.brackets.cancel(&arg::<String>(a, "id")?)),

            // ---- AI, news
            "ai_models" => out(ai::models()),
            "ai_analyze" => out(self.ai.analyze(arg(a, "request")?).await?),
            "ai_history" => out(self.ai.history(arg::<Option<String>>(a, "symbol")?.as_deref(), 50)),
            "ai_market" => out(self.ai.market(&arg::<String>(a, "symbol")?).await?),
            "ai_track" => out(self.ai.track().await?),
            "news_for" => out(self.news.news_for(&arg::<String>(a, "symbol")?, arg::<Option<bool>>(a, "force")?.unwrap_or(false)).await),
            "delistings" => out(self.news.delistings(arg::<Option<bool>>(a, "force")?.unwrap_or(false)).await),
            "open_url" => {
                // a link is opened by the user's own computer: from a remote window the page itself opens it
                if !self.local_ui {
                    return Err("Links are opened by the browser you are using.".into());
                }
                out(news::open_in_browser(&arg::<String>(a, "url")?)?)
            }

            // ---- Lab
            "lab_default_config" => out(harvester_core::lab::LabConfig::default()),
            "lab_run" => out(self.lab.run(self.events.clone(), self.market.clone(), arg::<LabRequest>(a, "request")?).await?),
            "lab_cancel" => {
                self.lab.cancel();
                out(())
            }
            other => Err(format!("unknown command '{other}'")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn arguments_are_read_by_name_and_a_missing_option_is_none() {
        assert_eq!(arg::<String>(&json!({"symbol": "BTCUSDT"}), "symbol").unwrap(), "BTCUSDT");
        assert_eq!(arg::<Option<u32>>(&json!({}), "limit").unwrap(), None);
        assert_eq!(arg::<Option<u32>>(&json!({"limit": null}), "limit").unwrap(), None);
        assert_eq!(arg::<Option<u32>>(&json!({"limit": 5}), "limit").unwrap(), Some(5));
        assert!(arg::<String>(&json!({}), "symbol").unwrap_err().contains("bad argument 'symbol'"));
        assert!(arg::<u32>(&json!({"limit": "x"}), "limit").is_err());
    }

    #[tokio::test]
    async fn local_commands_answer_without_any_network() {
        let core = Core::new(Events::none(), false);
        assert!(core.dispatch("scanner_status", &json!({})).await.is_ok());
        assert!(core.dispatch("scanner_config", &Value::Null).await.is_ok());
        assert!(core.dispatch("ai_models", &json!({})).await.unwrap().as_array().map_or(false, |m| m.len() == 2));
        assert!(core.dispatch("lab_default_config", &json!({})).await.is_ok());
        assert!(core.dispatch("environment", &json!({})).await.is_ok());
        assert!(core.dispatch("movers_config", &json!({})).await.is_ok());
        assert!(core.dispatch("trading_status", &json!({})).await.unwrap()["hasCredentials"].is_boolean());
        assert_eq!(core.dispatch("mark_prices", &json!({"symbols": ["BTCUSDT"]})).await.unwrap(), json!({}));
    }

    #[tokio::test]
    async fn a_bad_call_is_an_error_message_not_a_crash() {
        let core = Core::new(Events::none(), false);
        assert!(core.dispatch("no_such_command", &json!({})).await.unwrap_err().contains("unknown command"));
        assert!(core.dispatch("symbol_filters", &json!({})).await.unwrap_err().contains("bad argument 'symbol'"));
        assert!(core.dispatch("close_position", &json!({"symbol": 5})).await.is_err());
        // a window that is not on this computer cannot make it open a browser
        assert!(core.dispatch("open_url", &json!({"url": "https://example.com"})).await.unwrap_err().contains("browser you are using"));
    }
}
