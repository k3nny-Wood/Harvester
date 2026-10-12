// ML Feature Vector - 38 features for entry signal prediction
// (36 base + 2 Stiff Surge: TDFI, Stiffness)

use serde::{Deserialize, Serialize};

/// Complete feature vector for ML model input (38 features)
/// Note: candle_direction is stored but NOT included in to_array() — model doesn't use it.
///
/// Dropped features (were constant, broken, or redundant):
///   volume_change_pct, vwap_distance, dist_to_fvg, dist_to_ob, dist_to_qfl,
///   near_support, near_resistance, wyckoff_accumulation, wyckoff_markup,
///   wyckoff_distribution, wyckoff_markdown
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FeatureVector {
    // Price Action (4)
    pub candle_direction: Option<f64>,  // 1=bullish, -1=bearish (NOT in model input)
    pub price_change_1c: Option<f64>,
    pub price_change_3c: Option<f64>,
    pub price_change_5c: Option<f64>,

    // Momentum (8)
    pub rsi_14: Option<f64>,
    pub rsi_7: Option<f64>,
    pub stoch_rsi_k: Option<f64>,
    pub stoch_rsi_d: Option<f64>,
    pub macd_line: Option<f64>,
    pub macd_signal: Option<f64>,
    pub macd_histogram: Option<f64>,
    pub adx_14: Option<f64>,

    // Trend Strength (2)
    pub adx_plus_di: Option<f64>,
    pub adx_minus_di: Option<f64>,

    // Volume (2)
    pub cmf_20: Option<f64>,
    pub obv_normalized: Option<f64>,
    pub volume_ratio: Option<f64>,

    // Trend (4)
    pub ema_9_distance: Option<f64>,
    pub ema_21_distance: Option<f64>,
    pub sma_50_distance: Option<f64>,
    pub sma_200_distance: Option<f64>,
    pub ma_alignment: Option<f64>,  // 1.0 = bullish stack, -1.0 = bearish stack, 0.0 = mixed

    // Volatility (3)
    pub atr_pct: Option<f64>,
    pub bollinger_position: Option<f64>,  // 0 to 1 (lower to upper band)
    pub volatility_ratio: Option<f64>,    // std(10) / std(50) of closes

    // Candlestick Patterns (7)
    pub engulfing: Option<f64>,  // 1=bullish, -1=bearish, 0=none
    pub hammer: Option<f64>,
    pub shooting_star: Option<f64>,
    pub doji: Option<f64>,
    pub morning_star: Option<f64>,
    pub evening_star: Option<f64>,
    pub pattern_score: Option<f64>,  // directional sum: bull-bear (-3 to +3)

    // Divergence (4)
    pub divergence_score: Option<f64>,
    pub has_rsi_divergence: Option<f64>,
    pub has_macd_divergence: Option<f64>,
    pub has_obv_cmf_divergence: Option<f64>,

    // Stiff Surge indicators (2)
    pub tdfi: Option<f64>,        // Trend Direction Force Index: volume-weighted momentum [-1, 1]
    pub stiffness: Option<f64>,   // Trend persistence: % of bars above SMA(100)-0.2*StdDev [0, 100]
}

impl FeatureVector {
    /// Create a new empty feature vector
    pub fn new() -> Self {
        Self::default()
    }

    /// Convert to a flat Vec for model input (replaces None with sensible defaults)
    /// Feature order matches model_config JSON exactly (38 features).
    pub fn to_array(&self) -> Vec<f64> {
        vec![
            // Price changes (3)
            self.price_change_1c.unwrap_or(0.0),         //  0
            self.price_change_3c.unwrap_or(0.0),         //  1
            self.price_change_5c.unwrap_or(0.0),         //  2
            // RSI (2)
            self.rsi_14.unwrap_or(50.0),                 //  3
            self.rsi_7.unwrap_or(50.0),                  //  4
            // Stochastic RSI (2)
            self.stoch_rsi_k.unwrap_or(50.0),            //  5
            self.stoch_rsi_d.unwrap_or(50.0),            //  6
            // MACD (3)
            self.macd_line.unwrap_or(0.0),               //  7
            self.macd_signal.unwrap_or(0.0),             //  8
            self.macd_histogram.unwrap_or(0.0),          //  9
            // ADX (3)
            self.adx_14.unwrap_or(25.0),                 // 10
            self.adx_plus_di.unwrap_or(25.0),            // 11
            self.adx_minus_di.unwrap_or(25.0),           // 12
            // Volume (2)
            self.cmf_20.unwrap_or(0.0),                  // 13
            self.obv_normalized.unwrap_or(0.0),          // 14
            self.volume_ratio.unwrap_or(1.0),            // 15
            // Trend (5)
            self.ema_9_distance.unwrap_or(0.0),          // 16
            self.ema_21_distance.unwrap_or(0.0),         // 17
            self.sma_50_distance.unwrap_or(0.0),         // 18
            self.sma_200_distance.unwrap_or(0.0),        // 19
            self.ma_alignment.unwrap_or(0.0),            // 20
            // Volatility (3)
            self.atr_pct.unwrap_or(0.0),                 // 21
            self.bollinger_position.unwrap_or(0.5),      // 22
            self.volatility_ratio.unwrap_or(1.0),        // 23
            // Candlestick (8 — engulfing split into bullish/bearish for model)
            if self.engulfing.unwrap_or(0.0) > 0.0 { 1.0 } else { 0.0 },  // 24 has_bullish_engulfing
            if self.engulfing.unwrap_or(0.0) < 0.0 { 1.0 } else { 0.0 },  // 25 has_bearish_engulfing
            self.hammer.unwrap_or(0.0),                  // 26
            self.shooting_star.unwrap_or(0.0),           // 27
            self.morning_star.unwrap_or(0.0),            // 28
            self.evening_star.unwrap_or(0.0),            // 29
            self.doji.unwrap_or(0.0),                    // 30
            self.pattern_score.unwrap_or(0.0),           // 31 candlestick_score
            // Divergence (4)
            self.divergence_score.unwrap_or(0.0),        // 32
            self.has_rsi_divergence.unwrap_or(0.0),      // 33
            self.has_macd_divergence.unwrap_or(0.0),     // 34
            self.has_obv_cmf_divergence.unwrap_or(0.0),  // 35
            // Stiff Surge (2)
            self.tdfi.unwrap_or(0.0),                    // 36
            self.stiffness.unwrap_or(50.0),              // 37
        ]
    }

    /// Get feature names in order (38 features matching model_config JSON)
    pub fn feature_names() -> Vec<&'static str> {
        vec![
            // Price changes (3)
            "price_change_1c", "price_change_3c", "price_change_5c",
            // RSI (2)
            "rsi_14", "rsi_7",
            // Stochastic RSI (2)
            "stoch_rsi_k", "stoch_rsi_d",
            // MACD (3)
            "macd_line", "macd_signal", "macd_histogram",
            // ADX (3)
            "adx_14", "adx_plus_di", "adx_minus_di",
            // Volume (2)
            "cmf_20", "obv_normalized", "volume_ratio",
            // Trend (5)
            "ema_9_distance", "ema_21_distance", "sma_50_distance", "sma_200_distance",
            "ma_alignment",
            // Volatility (3)
            "atr_pct", "bollinger_position", "volatility_ratio",
            // Candlestick (8)
            "has_bullish_engulfing", "has_bearish_engulfing",
            "has_hammer", "has_shooting_star", "has_morning_star", "has_evening_star",
            "has_doji", "candlestick_score",
            // Divergence (4)
            "divergence_score", "has_rsi_divergence", "has_macd_divergence", "has_obv_cmf_divergence",
            // Stiff Surge (2)
            "tdfi", "stiffness",
        ]
    }
}

