// Optimized Batch Feature Extraction
//
// Pre-computes all indicators across the entire candle array at once,
// avoiding redundant calculations for 10-20x speedup over per-candle extraction.
//
// IMPORTANT: All computations must match the Python training script
// (ml_training/train_15m_models.py) exactly to avoid training/inference mismatch.

use crate::candle::Candle;
use super::features::FeatureVector;

/// Pre-computed indicators for an entire candle series
pub struct BatchIndicators {
    pub len: usize,
    // Price changes
    pub price_change_1c: Vec<f64>,
    pub price_change_3c: Vec<f64>,
    pub price_change_5c: Vec<f64>,
    // RSI
    pub rsi_14: Vec<f64>,
    pub rsi_7: Vec<f64>,
    // Stochastic RSI
    pub stoch_rsi_k: Vec<f64>,
    pub stoch_rsi_d: Vec<f64>,
    // MACD
    pub macd_line: Vec<f64>,
    pub macd_signal: Vec<f64>,
    pub macd_histogram: Vec<f64>,
    // ADX
    pub adx_14: Vec<f64>,
    pub adx_plus_di: Vec<f64>,
    pub adx_minus_di: Vec<f64>,
    // Volume
    pub cmf_20: Vec<f64>,
    pub obv_normalized: Vec<f64>,
    pub obv_raw: Vec<f64>,  // Raw OBV for divergence computation
    pub volume_ratio: Vec<f64>,
    // Moving averages
    pub ema_9: Vec<f64>,
    pub ema_21: Vec<f64>,
    pub ema_20: Vec<f64>,  // For trend filter
    pub ema_50: Vec<f64>,  // For trend filter
    pub sma_50: Vec<f64>,
    pub sma_200: Vec<f64>,
    // Volatility
    pub atr_14: Vec<f64>,
    pub bollinger_upper: Vec<f64>,
    pub bollinger_lower: Vec<f64>,
    pub rolling_std_10: Vec<f64>,  // For volatility ratio (matches Python)
    pub rolling_std_50: Vec<f64>,  // For volatility ratio (matches Python)
    // Stiff Surge
    pub sma_100: Vec<f64>,
    pub tdfi: Vec<f64>,
    pub stiffness: Vec<f64>,
    // VWAP (rolling 96-candle = 24h on 15m)
    pub vwap: Vec<f64>,
}

impl BatchIndicators {
    /// Compute all indicators for the candle array
    pub fn compute(candles: &[Candle]) -> Self {
        let len = candles.len();
        let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
        let highs: Vec<f64> = candles.iter().map(|c| c.high).collect();
        let lows: Vec<f64> = candles.iter().map(|c| c.low).collect();
        let volumes: Vec<f64> = candles.iter().map(|c| c.volume).collect();

        // Price changes (vectorized)
        let price_change_1c = compute_price_changes(&closes, 1);
        let price_change_3c = compute_price_changes(&closes, 3);
        let price_change_5c = compute_price_changes(&closes, 5);

        // RSI (batch)
        let rsi_14 = compute_rsi_batch(&closes, 14);
        let rsi_7 = compute_rsi_batch(&closes, 7);

        // Stochastic RSI (K smoothed with 3-SMA to match Python)
        let (stoch_rsi_k, stoch_rsi_d) = compute_stoch_rsi_batch(&rsi_14, 14);

        // MACD
        let (macd_line, macd_signal, macd_histogram) = compute_macd_batch(&closes);

        // ADX (uses rolling SMA to match Python training)
        let (adx_14, adx_plus_di, adx_minus_di) = compute_adx_batch(&highs, &lows, &closes, 14);

        // CMF
        let cmf_20 = compute_cmf_batch(&highs, &lows, &closes, &volumes, 20);

        // OBV (50-period z-score normalization to match Python)
        let (obv_normalized, obv_raw) = compute_obv_normalized_batch(&closes, &volumes);

        // Volume ratio only (volume_change_pct dropped — too noisy)
        let volume_ratio = compute_volume_ratio_batch(&volumes, 20);

        // Moving averages
        let ema_9 = compute_ema_batch(&closes, 9);
        let ema_21 = compute_ema_batch(&closes, 21);
        let ema_20 = compute_ema_batch(&closes, 20);
        let ema_50 = compute_ema_batch(&closes, 50);
        let sma_50 = compute_sma_batch(&closes, 50);
        let sma_200 = compute_sma_batch(&closes, 200);

        // Volatility
        let atr_14 = compute_atr_batch(&highs, &lows, &closes, 14);
        let (bollinger_upper, bollinger_lower) = compute_bollinger_batch(&closes, 20, 2.0);
        let rolling_std_10 = compute_rolling_std_batch(&closes, 10);
        let rolling_std_50 = compute_rolling_std_batch(&closes, 50);

        // Stiff Surge
        let sma_100 = compute_sma_batch(&closes, 100);
        let rolling_std_100 = compute_rolling_std_batch(&closes, 100);
        let tdfi = compute_tdfi_batch(&closes, &volumes, &atr_14);
        let stiffness = compute_stiffness_batch(&closes, &sma_100, &rolling_std_100, 60);

        // Rolling VWAP (96-candle lookback = 24h on 15m)
        let vwap = compute_rolling_vwap_batch(candles, 96);

        Self {
            len,
            price_change_1c,
            price_change_3c,
            price_change_5c,
            rsi_14,
            rsi_7,
            stoch_rsi_k,
            stoch_rsi_d,
            macd_line,
            macd_signal,
            macd_histogram,
            adx_14,
            adx_plus_di,
            adx_minus_di,
            cmf_20,
            obv_normalized,
            obv_raw,
            volume_ratio,
            ema_9,
            ema_21,
            ema_20,
            ema_50,
            sma_50,
            sma_200,
            atr_14,
            bollinger_upper,
            bollinger_lower,
            rolling_std_10,
            rolling_std_50,
            sma_100,
            tdfi,
            stiffness,
            vwap,
        }
    }

    /// Extract feature vector at a specific index (38 features matching Python training)
    pub fn extract_at(&self, candles: &[Candle], idx: usize) -> FeatureVector {
        if idx >= self.len || idx < 100 {
            return FeatureVector::new();
        }

        let current_price = candles[idx].close;
        let mut features = FeatureVector::new();

        // Price changes (3)
        features.price_change_1c = Some(self.price_change_1c[idx]);
        features.price_change_3c = Some(self.price_change_3c[idx]);
        features.price_change_5c = Some(self.price_change_5c[idx]);

        // RSI (2)
        features.rsi_14 = Some(self.rsi_14[idx]);
        features.rsi_7 = Some(self.rsi_7[idx]);

        // Stochastic RSI (2) — K is 3-SMA smoothed to match Python
        features.stoch_rsi_k = Some(self.stoch_rsi_k[idx]);
        features.stoch_rsi_d = Some(self.stoch_rsi_d[idx]);

        // MACD (3)
        features.macd_line = Some(self.macd_line[idx]);
        features.macd_signal = Some(self.macd_signal[idx]);
        features.macd_histogram = Some(self.macd_histogram[idx]);

        // ADX (3) — uses rolling SMA to match Python
        features.adx_14 = Some(self.adx_14[idx]);
        features.adx_plus_di = Some(self.adx_plus_di[idx]);
        features.adx_minus_di = Some(self.adx_minus_di[idx]);

        // Volume (2) — dropped volume_change_pct (too noisy)
        features.cmf_20 = Some(self.cmf_20[idx]);
        features.obv_normalized = Some(self.obv_normalized[idx]);
        features.volume_ratio = Some(self.volume_ratio[idx]);

        // MA distances (4)
        if self.ema_9[idx] > 0.0 {
            features.ema_9_distance = Some(((current_price - self.ema_9[idx]) / self.ema_9[idx]) * 100.0);
        }
        if self.ema_21[idx] > 0.0 {
            features.ema_21_distance = Some(((current_price - self.ema_21[idx]) / self.ema_21[idx]) * 100.0);
        }
        if self.sma_50[idx] > 0.0 {
            features.sma_50_distance = Some(((current_price - self.sma_50[idx]) / self.sma_50[idx]) * 100.0);
        }
        if self.sma_200[idx] > 0.0 {
            features.sma_200_distance = Some(((current_price - self.sma_200[idx]) / self.sma_200[idx]) * 100.0);
        }

        // MA alignment — full 4-MA stack check to match Python training
        // Python: ema_9 > ema_21 > sma_50 > sma_200 = 1.0, reverse = -1.0
        let e9 = self.ema_9[idx];
        let e21 = self.ema_21[idx];
        let s50 = self.sma_50[idx];
        let s200 = self.sma_200[idx];
        if e9 > 0.0 && e21 > 0.0 && s50 > 0.0 && s200 > 0.0 {
            if e9 > e21 && e21 > s50 && s50 > s200 {
                features.ma_alignment = Some(1.0);
            } else if e9 < e21 && e21 < s50 && s50 < s200 {
                features.ma_alignment = Some(-1.0);
            } else {
                features.ma_alignment = Some(0.0);
            }
        } else {
            features.ma_alignment = Some(0.0);
        }

        // ATR percentage (1)
        if current_price > 0.0 {
            features.atr_pct = Some((self.atr_14[idx] / current_price) * 100.0);
        }

        // Bollinger position (1)
        let bb_range = self.bollinger_upper[idx] - self.bollinger_lower[idx];
        if bb_range > 0.0 {
            features.bollinger_position = Some((current_price - self.bollinger_lower[idx]) / bb_range);
        }

        // Volatility ratio — price std(10) / std(50) to match Python training
        // (was incorrectly using ATR ratio before)
        if idx >= 50 {
            let std_50 = self.rolling_std_50[idx];
            let std_10 = self.rolling_std_10[idx];
            if std_50 > 0.0 {
                features.volatility_ratio = Some(std_10 / std_50);
            }
        }

        // Candlestick patterns — thresholds match Python training
        let bullish_engulfing = detect_bullish_engulfing(candles, idx);
        let bearish_engulfing = detect_bearish_engulfing(candles, idx);
        features.engulfing = Some(if bullish_engulfing > 0.5 {
            1.0
        } else if bearish_engulfing > 0.5 {
            -1.0
        } else {
            0.0
        });
        features.hammer = Some(detect_hammer(candles, idx));
        features.shooting_star = Some(detect_shooting_star(candles, idx));
        features.doji = Some(detect_doji(candles, idx));
        features.morning_star = Some(detect_morning_star(candles, idx));
        features.evening_star = Some(detect_evening_star(candles, idx));

        // Candlestick score — DIRECTIONAL sum to match Python training
        // Python: bull_eng + hammer + morning_star - bear_eng - star - evening_star
        features.pattern_score = Some(
            bullish_engulfing
            + features.hammer.unwrap_or(0.0)
            + features.morning_star.unwrap_or(0.0)
            - bearish_engulfing
            - features.shooting_star.unwrap_or(0.0)
            - features.evening_star.unwrap_or(0.0)
        );

        // Divergence — 10-bar lookback matching Python training
        if idx >= 10 {
            let price_change = candles[idx].close - candles[idx - 10].close;
            let rsi_change = self.rsi_14[idx] - self.rsi_14[idx - 10];
            let macd_change = self.macd_histogram[idx] - self.macd_histogram[idx - 10];
            let obv_change = self.obv_raw[idx] - self.obv_raw[idx - 10];

            let mut score = 0.0f64;

            // RSI divergence
            if price_change > 0.0 && rsi_change < -5.0 {
                features.has_rsi_divergence = Some(1.0);
                score -= 1.0;
            } else if price_change < 0.0 && rsi_change > 5.0 {
                features.has_rsi_divergence = Some(1.0);
                score += 1.0;
            } else {
                features.has_rsi_divergence = Some(0.0);
            }

            // MACD divergence
            if price_change > 0.0 && macd_change < 0.0 {
                features.has_macd_divergence = Some(1.0);
                score -= 1.0;
            } else if price_change < 0.0 && macd_change > 0.0 {
                features.has_macd_divergence = Some(1.0);
                score += 1.0;
            } else {
                features.has_macd_divergence = Some(0.0);
            }

            // OBV/CMF divergence
            if (price_change > 0.0 && obv_change < 0.0) || (price_change < 0.0 && obv_change > 0.0) {
                features.has_obv_cmf_divergence = Some(1.0);
                if price_change < 0.0 { score += 1.0; } else { score -= 1.0; }
            } else {
                features.has_obv_cmf_divergence = Some(0.0);
            }

            features.divergence_score = Some(score);
        } else {
            features.divergence_score = Some(0.0);
            features.has_rsi_divergence = Some(0.0);
            features.has_macd_divergence = Some(0.0);
            features.has_obv_cmf_divergence = Some(0.0);
        }

        // Stiff Surge (2)
        features.tdfi = Some(self.tdfi[idx]);
        features.stiffness = Some(self.stiffness[idx]);

        features
    }

    /// Check trend direction at a given index using EMA20/EMA50 crossover
    /// Returns: 1 = uptrend, -1 = downtrend, 0 = neutral/sideways
    pub fn get_trend(&self, idx: usize) -> i32 {
        if idx >= self.len || idx < 50 {
            return 0;
        }

        let ema20 = self.ema_20[idx];
        let ema50 = self.ema_50[idx];

        if ema20 <= 0.0 || ema50 <= 0.0 {
            return 0;
        }

        let diff_pct = ((ema20 - ema50) / ema50) * 100.0;

        if diff_pct > 0.1 {
            1
        } else if diff_pct < -0.1 {
            -1
        } else {
            0
        }
    }

    /// Check if signal direction aligns with trend
    pub fn trend_allows_signal(&self, idx: usize, direction: &str) -> bool {
        let trend = self.get_trend(idx);
        match direction {
            "long" => trend >= 0,
            "short" => trend <= 0,
            _ => true,
        }
    }

    /// VWAP distance as % of price: (close - vwap) / vwap * 100
    /// Positive = price above VWAP, Negative = price below VWAP
    pub fn vwap_distance_pct_at(&self, idx: usize, close: f64) -> f64 {
        if idx >= self.len || self.vwap[idx] <= 0.0 {
            return 0.0;
        }
        ((close - self.vwap[idx]) / self.vwap[idx]) * 100.0
    }
}

// ============================================================================
// Batch computation functions
// ============================================================================

fn compute_price_changes(closes: &[f64], period: usize) -> Vec<f64> {
    let mut result = vec![0.0; closes.len()];
    for i in period..closes.len() {
        if closes[i - period] != 0.0 {
            result[i] = ((closes[i] - closes[i - period]) / closes[i - period]) * 100.0;
        }
    }
    result
}

fn compute_rsi_batch(closes: &[f64], period: usize) -> Vec<f64> {
    let mut result = vec![50.0; closes.len()];
    if closes.len() < period + 1 {
        return result;
    }

    let mut avg_gain = 0.0;
    let mut avg_loss = 0.0;

    for i in 1..=period {
        let change = closes[i] - closes[i - 1];
        if change > 0.0 {
            avg_gain += change;
        } else {
            avg_loss -= change;
        }
    }
    avg_gain /= period as f64;
    avg_loss /= period as f64;

    if avg_loss == 0.0 {
        result[period] = 100.0;
    } else {
        let rs = avg_gain / avg_loss;
        result[period] = 100.0 - (100.0 / (1.0 + rs));
    }

    for i in (period + 1)..closes.len() {
        let change = closes[i] - closes[i - 1];
        let (gain, loss) = if change > 0.0 {
            (change, 0.0)
        } else {
            (0.0, -change)
        };

        avg_gain = (avg_gain * (period - 1) as f64 + gain) / period as f64;
        avg_loss = (avg_loss * (period - 1) as f64 + loss) / period as f64;

        if avg_loss == 0.0 {
            result[i] = 100.0;
        } else {
            let rs = avg_gain / avg_loss;
            result[i] = 100.0 - (100.0 / (1.0 + rs));
        }
    }

    result
}

/// Stochastic RSI with K smoothed by 3-SMA (matches Python training)
fn compute_stoch_rsi_batch(rsi: &[f64], period: usize) -> (Vec<f64>, Vec<f64>) {
    let len = rsi.len();
    let mut raw_stoch = vec![50.0; len];

    // Compute raw stochastic of RSI
    for i in period..len {
        let window = &rsi[i - period + 1..=i];
        let min_rsi = window.iter().cloned().fold(f64::INFINITY, f64::min);
        let max_rsi = window.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        if max_rsi != min_rsi {
            raw_stoch[i] = ((rsi[i] - min_rsi) / (max_rsi - min_rsi)) * 100.0;
        }
    }

    // K = 3-period SMA of raw stochastic (matches Python: rolling(3, min_periods=1).mean())
    let mut k = vec![50.0; len];
    for i in 0..len {
        if i == 0 {
            k[i] = raw_stoch[i];
        } else if i == 1 {
            k[i] = (raw_stoch[i] + raw_stoch[i - 1]) / 2.0;
        } else {
            k[i] = (raw_stoch[i] + raw_stoch[i - 1] + raw_stoch[i - 2]) / 3.0;
        }
    }

    // D = 3-period SMA of K (matches Python: rolling(3, min_periods=1).mean())
    let mut d = vec![50.0; len];
    for i in 0..len {
        if i == 0 {
            d[i] = k[i];
        } else if i == 1 {
            d[i] = (k[i] + k[i - 1]) / 2.0;
        } else {
            d[i] = (k[i] + k[i - 1] + k[i - 2]) / 3.0;
        }
    }

    (k, d)
}

fn compute_ema_batch(data: &[f64], period: usize) -> Vec<f64> {
    let mut result = vec![0.0; data.len()];
    if data.len() < period {
        return result;
    }

    let multiplier = 2.0 / (period + 1) as f64;

    // Initial SMA
    let sma: f64 = data[..period].iter().sum::<f64>() / period as f64;
    result[period - 1] = sma;

    for i in period..data.len() {
        result[i] = (data[i] - result[i - 1]) * multiplier + result[i - 1];
    }

    result
}

fn compute_macd_batch(closes: &[f64]) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let ema_12 = compute_ema_batch(closes, 12);
    let ema_26 = compute_ema_batch(closes, 26);

    let mut macd_line = vec![0.0; closes.len()];
    for i in 25..closes.len() {
        macd_line[i] = ema_12[i] - ema_26[i];
    }

    let signal = compute_ema_batch(&macd_line, 9);

    let mut histogram = vec![0.0; closes.len()];
    for i in 33..closes.len() {
        histogram[i] = macd_line[i] - signal[i];
    }

    (macd_line, signal, histogram)
}

/// ADX using rolling SMA smoothing (matches Python training)
/// Python uses pd.Series(tr).rolling(14, min_periods=1).mean() — NOT Wilder's smoothing
fn compute_adx_batch(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let len = closes.len();
    let mut adx = vec![25.0; len];
    let mut plus_di = vec![25.0; len];
    let mut minus_di = vec![25.0; len];

    if len < period + 1 {
        return (adx, plus_di, minus_di);
    }

    // True Range and Directional Movement
    let mut tr = vec![0.0; len];
    let mut plus_dm = vec![0.0; len];
    let mut minus_dm = vec![0.0; len];

    for i in 1..len {
        tr[i] = (highs[i] - lows[i])
            .max((highs[i] - closes[i - 1]).abs())
            .max((lows[i] - closes[i - 1]).abs());

        let high_diff = highs[i] - highs[i - 1];
        let low_diff = lows[i - 1] - lows[i];

        if high_diff > low_diff && high_diff > 0.0 {
            plus_dm[i] = high_diff;
        }
        if low_diff > high_diff && low_diff > 0.0 {
            minus_dm[i] = low_diff;
        }
    }

    // Rolling SMA smoothing (matches Python's pd.rolling().mean())
    let atr = compute_rolling_mean_batch(&tr, period);
    let smoothed_plus_dm = compute_rolling_mean_batch(&plus_dm, period);
    let smoothed_minus_dm = compute_rolling_mean_batch(&minus_dm, period);

    // Calculate DI
    let mut dx = vec![0.0; len];
    for i in 0..len {
        if atr[i] > 1e-10 {
            plus_di[i] = (smoothed_plus_dm[i] / atr[i]) * 100.0;
            minus_di[i] = (smoothed_minus_dm[i] / atr[i]) * 100.0;
        }

        let di_sum = plus_di[i] + minus_di[i];
        if di_sum > 1e-10 {
            dx[i] = ((plus_di[i] - minus_di[i]).abs() / di_sum) * 100.0;
        }
    }

    // ADX = rolling SMA of DX
    let smoothed_dx = compute_rolling_mean_batch(&dx, period);
    for i in 0..len {
        adx[i] = smoothed_dx[i];
    }

    (adx, plus_di, minus_di)
}

/// Rolling mean with min_periods=1 (matches Python's pd.rolling(period, min_periods=1).mean())
fn compute_rolling_mean_batch(data: &[f64], period: usize) -> Vec<f64> {
    let len = data.len();
    let mut result = vec![0.0; len];

    for i in 0..len {
        let start = if i >= period { i - period + 1 } else { 0 };
        let window = &data[start..=i];
        let count = window.len() as f64;
        if count > 0.0 {
            result[i] = window.iter().sum::<f64>() / count;
        }
    }

    result
}

fn compute_cmf_batch(highs: &[f64], lows: &[f64], closes: &[f64], volumes: &[f64], period: usize) -> Vec<f64> {
    let len = closes.len();
    let mut result = vec![0.0; len];

    let mut mfv = vec![0.0; len];
    for i in 0..len {
        let hl_range = highs[i] - lows[i];
        if hl_range > 0.0 {
            let mfm = ((closes[i] - lows[i]) - (highs[i] - closes[i])) / hl_range;
            mfv[i] = mfm * volumes[i];
        }
    }

    for i in period..len {
        let mfv_sum: f64 = mfv[i - period + 1..=i].iter().sum();
        let vol_sum: f64 = volumes[i - period + 1..=i].iter().sum();
        if vol_sum > 0.0 {
            result[i] = mfv_sum / vol_sum;
        }
    }

    result
}

/// OBV with 50-period z-score normalization (matches Python training)
/// Python uses rolling(50, min_periods=1) for mean and std
fn compute_obv_normalized_batch(closes: &[f64], volumes: &[f64]) -> (Vec<f64>, Vec<f64>) {
    let len = closes.len();
    let mut obv = vec![0.0; len];
    let mut result = vec![0.0; len];

    // Compute raw OBV
    for i in 1..len {
        if closes[i] > closes[i - 1] {
            obv[i] = obv[i - 1] + volumes[i];
        } else if closes[i] < closes[i - 1] {
            obv[i] = obv[i - 1] - volumes[i];
        } else {
            obv[i] = obv[i - 1];
        }
    }

    // Normalize with rolling 50-period z-score (matches Python)
    for i in 0..len {
        let start = if i >= 49 { i - 49 } else { 0 };
        let window = &obv[start..=i];
        let count = window.len() as f64;
        let mean: f64 = window.iter().sum::<f64>() / count;
        let variance: f64 = window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / count;
        let std = variance.sqrt();
        if std > 1e-10 {
            result[i] = (obv[i] - mean) / std;
        }
    }

    (result, obv)
}

/// Volume ratio only (dropped volume_change_pct — noise with std=746%)
fn compute_volume_ratio_batch(volumes: &[f64], period: usize) -> Vec<f64> {
    let len = volumes.len();
    let mut ratio = vec![1.0; len];

    for i in period..len {
        let avg: f64 = volumes[i - period..i].iter().sum::<f64>() / period as f64;
        if avg > 0.0 {
            ratio[i] = volumes[i] / avg;
        }
    }

    ratio
}

fn compute_sma_batch(data: &[f64], period: usize) -> Vec<f64> {
    let mut result = vec![0.0; data.len()];
    if data.len() < period {
        return result;
    }

    let mut sum: f64 = data[..period].iter().sum();
    result[period - 1] = sum / period as f64;

    for i in period..data.len() {
        sum = sum - data[i - period] + data[i];
        result[i] = sum / period as f64;
    }

    result
}

fn compute_atr_batch(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> Vec<f64> {
    let len = closes.len();
    let mut tr = vec![0.0; len];
    let mut atr = vec![0.0; len];

    tr[0] = highs[0] - lows[0];
    for i in 1..len {
        tr[i] = (highs[i] - lows[i])
            .max((highs[i] - closes[i - 1]).abs())
            .max((lows[i] - closes[i - 1]).abs());
    }

    let first_atr: f64 = tr[..period].iter().sum::<f64>() / period as f64;
    atr[period - 1] = first_atr;

    for i in period..len {
        atr[i] = (atr[i - 1] * (period - 1) as f64 + tr[i]) / period as f64;
    }

    atr
}

fn compute_bollinger_batch(closes: &[f64], period: usize, std_dev: f64) -> (Vec<f64>, Vec<f64>) {
    let len = closes.len();
    let mut upper = vec![0.0; len];
    let mut lower = vec![0.0; len];

    let sma = compute_sma_batch(closes, period);

    for i in period..len {
        let window = &closes[i - period + 1..=i];
        let mean = sma[i];
        let variance: f64 = window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / period as f64;
        let std = variance.sqrt();
        upper[i] = mean + std_dev * std;
        lower[i] = mean - std_dev * std;
    }

    (upper, lower)
}

/// Rolling standard deviation (matches Python's pd.rolling(period, min_periods=1).std())
fn compute_rolling_std_batch(data: &[f64], period: usize) -> Vec<f64> {
    let len = data.len();
    let mut result = vec![0.0; len];

    for i in 0..len {
        let start = if i >= period { i - period + 1 } else { 0 };
        let window = &data[start..=i];
        let count = window.len() as f64;
        if count > 1.0 {
            let mean: f64 = window.iter().sum::<f64>() / count;
            // Use ddof=1 to match pandas default std
            let variance: f64 = window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / (count - 1.0);
            result[i] = variance.sqrt();
        }
    }

    result
}

// ============================================================================
// Candlestick pattern detection — thresholds match Python training exactly
// ============================================================================

/// Bullish engulfing with 1.5x body size requirement (matches Python)
fn detect_bullish_engulfing(candles: &[Candle], idx: usize) -> f64 {
    if idx < 1 { return 0.0; }
    let c = &candles[idx];
    let p = &candles[idx - 1];
    let curr_body = (c.close - c.open).abs();
    let prev_body = (p.close - p.open).abs();
    let curr_bullish = c.close > c.open;
    let prev_bearish = p.close < p.open;
    // Python: body[i] > prev_body * 1.5
    if curr_bullish && prev_bearish && curr_body > prev_body * 1.5 { 1.0 } else { 0.0 }
}

/// Bearish engulfing with 1.5x body size requirement (matches Python)
fn detect_bearish_engulfing(candles: &[Candle], idx: usize) -> f64 {
    if idx < 1 { return 0.0; }
    let c = &candles[idx];
    let p = &candles[idx - 1];
    let curr_body = (c.close - c.open).abs();
    let prev_body = (p.close - p.open).abs();
    let curr_bearish = c.close < c.open;
    let prev_bullish = p.close > p.open;
    // Python: body[i] > prev_body * 1.5
    if curr_bearish && prev_bullish && curr_body > prev_body * 1.5 { 1.0 } else { 0.0 }
}

/// Hammer with 0.3x upper wick threshold (matches Python)
fn detect_hammer(candles: &[Candle], idx: usize) -> f64 {
    let c = &candles[idx];
    let body = (c.close - c.open).abs();
    let lower_wick = c.open.min(c.close) - c.low;
    let upper_wick = c.high - c.open.max(c.close);
    // Python: lower_wick > body * 2, upper_wick < body * 0.3
    if body > 0.0 && lower_wick > body * 2.0 && upper_wick < body * 0.3 { 1.0 } else { 0.0 }
}

/// Shooting star with 0.3x lower wick threshold (matches Python)
fn detect_shooting_star(candles: &[Candle], idx: usize) -> f64 {
    let c = &candles[idx];
    let body = (c.close - c.open).abs();
    let lower_wick = c.open.min(c.close) - c.low;
    let upper_wick = c.high - c.open.max(c.close);
    // Python: upper_wick > body * 2, lower_wick < body * 0.3
    if body > 0.0 && upper_wick > body * 2.0 && lower_wick < body * 0.3 { 1.0 } else { 0.0 }
}

fn detect_doji(candles: &[Candle], idx: usize) -> f64 {
    let c = &candles[idx];
    let body = (c.close - c.open).abs();
    let total_range = c.high - c.low;
    if total_range > 0.0 && body / total_range < 0.1 { 1.0 } else { 0.0 }
}

/// Morning star: 3-candle bullish reversal pattern (matches Python training)
/// Day1: bearish, Day2: small body (<0.3x Day1), Day3: bullish closes above Day1 midpoint
fn detect_morning_star(candles: &[Candle], idx: usize) -> f64 {
    if idx < 2 { return 0.0; }
    let d1 = &candles[idx - 2];
    let d2 = &candles[idx - 1];
    let d3 = &candles[idx];

    let d1_body = (d1.close - d1.open).abs();
    let d2_body = (d2.close - d2.open).abs();
    let d1_bearish = d1.close < d1.open;
    let d3_bullish = d3.close > d3.open;
    let d1_midpoint = (d1.open + d1.close) / 2.0;

    if d1_bearish && d2_body < d1_body * 0.3 && d3_bullish && d3.close > d1_midpoint {
        1.0
    } else {
        0.0
    }
}

// ============================================================================
// Stiff Surge indicators
// ============================================================================

/// TDFI: Trend Direction Force Index
/// Raw = (close - prev_close) * volume / ATR → z-score(50) → EMA(13) → tanh → [-1, 1]
fn compute_tdfi_batch(closes: &[f64], volumes: &[f64], atr: &[f64]) -> Vec<f64> {
    let len = closes.len();
    let mut raw = vec![0.0; len];
    for i in 1..len {
        if atr[i] > 1e-10 {
            raw[i] = (closes[i] - closes[i - 1]) * volumes[i] / atr[i];
        }
    }

    // Z-score normalize with 50-bar rolling window
    let mut normalized = vec![0.0; len];
    for i in 0..len {
        let start = if i >= 49 { i - 49 } else { 0 };
        let window = &raw[start..=i];
        let count = window.len() as f64;
        let mean: f64 = window.iter().sum::<f64>() / count;
        let variance: f64 = window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / count;
        let std = variance.sqrt();
        if std > 1e-10 {
            normalized[i] = (raw[i] - mean) / std;
        }
    }

    // EMA(13) smoothing then tanh
    let smoothed = compute_ema_batch(&normalized, 13);
    smoothed.iter().map(|&x| x.tanh()).collect()
}

/// Stiffness: % of bars where close > SMA(100) - 0.2*StdDev(100) over lookback period → EMA(3)
fn compute_stiffness_batch(closes: &[f64], sma_100: &[f64], rolling_std_100: &[f64], lookback: usize) -> Vec<f64> {
    let len = closes.len();
    let mut raw = vec![50.0; len];

    for i in lookback..len {
        if sma_100[i] <= 0.0 { continue; }
        let mut count_above = 0u32;
        for j in (i - lookback + 1)..=i {
            let threshold = sma_100[j] - 0.2 * rolling_std_100[j];
            if closes[j] > threshold {
                count_above += 1;
            }
        }
        raw[i] = (count_above as f64 / lookback as f64) * 100.0;
    }

    compute_ema_batch(&raw, 3)
}

/// Rolling VWAP: sum(TP * vol) / sum(vol) over lookback window
/// TP = (high + low + close) / 3
fn compute_rolling_vwap_batch(candles: &[Candle], lookback: usize) -> Vec<f64> {
    let len = candles.len();
    let mut result = vec![0.0; len];

    // Pre-compute typical price * volume and volume for rolling sum
    let tpv: Vec<f64> = candles.iter()
        .map(|c| ((c.high + c.low + c.close) / 3.0) * c.volume)
        .collect();
    let vols: Vec<f64> = candles.iter().map(|c| c.volume).collect();

    // Cumulative sums for O(1) rolling window
    let mut cum_tpv = vec![0.0; len + 1];
    let mut cum_vol = vec![0.0; len + 1];
    for i in 0..len {
        cum_tpv[i + 1] = cum_tpv[i] + tpv[i];
        cum_vol[i + 1] = cum_vol[i] + vols[i];
    }

    for i in 0..len {
        let start = if i >= lookback { i - lookback + 1 } else { 0 };
        let window_tpv = cum_tpv[i + 1] - cum_tpv[start];
        let window_vol = cum_vol[i + 1] - cum_vol[start];
        result[i] = if window_vol > 0.0 {
            window_tpv / window_vol
        } else {
            candles[i].close
        };
    }

    result
}

/// Evening star: 3-candle bearish reversal pattern (matches Python training)
/// Day1: bullish, Day2: small body (<0.3x Day1), Day3: bearish closes below Day1 midpoint
fn detect_evening_star(candles: &[Candle], idx: usize) -> f64 {
    if idx < 2 { return 0.0; }
    let d1 = &candles[idx - 2];
    let d2 = &candles[idx - 1];
    let d3 = &candles[idx];

    let d1_body = (d1.close - d1.open).abs();
    let d2_body = (d2.close - d2.open).abs();
    let d1_bullish = d1.close > d1.open;
    let d3_bearish = d3.close < d3.open;
    let d1_midpoint = (d1.open + d1.close) / 2.0;

    if d1_bullish && d2_body < d1_body * 0.3 && d3_bearish && d3.close < d1_midpoint {
        1.0
    } else {
        0.0
    }
}
