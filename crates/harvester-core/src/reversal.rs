//! A reversal score for a sharp move: does the price action disagree with the move? Ported from the MarketScanner "divergence" module, which
//! ranked its rapid-move scan by it.
//!
//! The last (up to) 20 candles are split in halves and compared. After a fall (price lower at the end than at the start) the score looks for
//! BULLISH signs: a lower price low with a higher RSI / MACD / CMF low, rising volume, an oversold RSI, and OBV falling while CMF rises (selling
//! by the crowd, buying by "smart money"). After a rise it looks for the mirror image (bearish). Each part contributes up to 20 / 25 / 20 / 15 /
//! 15 / 25 points, 0..100 in total. It is a heuristic about whether the move might be ending, not a prediction.

use crate::candle::Candle;

#[derive(Debug, Clone, PartialEq)]
pub struct Reversal {
    /// 0..100
    pub score: f64,
    /// what contributed, e.g. "RSI bullish divergence (35%)"
    pub notes: Vec<String>,
}

/// The reversal score of the candles (oldest first), looking for the signs that fit the recent direction of price; None with fewer than 50 candles.
pub fn analyse(candles: &[Candle]) -> Option<Reversal> {
    analyse_for(candles, None)
}

/// The same, for a move whose direction is known: `rising` true looks for signs that a rise is ending (bearish), false for a fall (bullish). The
/// direction matters because a pump of a few seconds can sit at the end of candles that fell, and the signs must be those of the pump.
pub fn analyse_for(candles: &[Candle], rising: Option<bool>) -> Option<Reversal> {
    if candles.len() < 50 {
        return None;
    }
    let rsi = rsi_series(candles, 14);
    let macd = macd_line(candles);
    let cmf = cmf_series(candles, 20);
    let obv = obv_series(candles);
    let n = 20.min(candles.len()).min(rsi.len()).min(macd.len()).min(cmf.len()).min(obv.len());
    if n < 10 {
        return None;
    }
    let (c, r, m, f, o) = (&candles[candles.len() - n..], &rsi[rsi.len() - n..], &macd[macd.len() - n..], &cmf[cmf.len() - n..], &obv[obv.len() - n..]);
    let trend = match rising {
        Some(true) => 1.0,
        Some(false) => -1.0,
        None => (c[n - 1].close - c[0].close) / c[0].close,
    };
    let mut score = 0.0;
    let mut notes = Vec::new();
    let mut add = |points: f64, strength: Option<f64>, label: &str| {
        if let Some(s) = strength {
            score += points * s;
            notes.push(format!("{label} ({:.0}%)", s * 100.0));
        }
    };
    if trend > 0.0 {
        add(20.0, rsi_div(r, c, true), "RSI bearish divergence");
        add(25.0, macd_div(m, c, true), "MACD bearish divergence");
        add(20.0, cmf_div(f, c, true), "CMF bearish divergence");
        add(15.0, volume_div(c, true), "Volume declining");
        if let Some(&last) = r.last() {
            if last > 70.0 {
                add(15.0, Some(((last - 70.0) / 30.0).min(1.0)), &format!("RSI overbought {last:.0}"));
            }
        }
        add(25.0, obv_cmf_div(o, f, true), "OBV rising but CMF falling");
    } else if trend < 0.0 {
        add(20.0, rsi_div(r, c, false), "RSI bullish divergence");
        add(25.0, macd_div(m, c, false), "MACD bullish divergence");
        add(20.0, cmf_div(f, c, false), "CMF bullish divergence");
        add(15.0, volume_div(c, false), "Volume increasing");
        if let Some(&last) = r.last() {
            if last < 30.0 {
                add(15.0, Some(((30.0 - last) / 30.0).min(1.0)), &format!("RSI oversold {last:.0}"));
            }
        }
        add(25.0, obv_cmf_div(o, f, false), "OBV falling but CMF rising");
    }
    Some(Reversal { score: score.min(100.0), notes })
}

fn fold_max(v: &[f64]) -> f64 {
    v.iter().copied().fold(f64::MIN, f64::max)
}
fn fold_min(v: &[f64]) -> f64 {
    v.iter().copied().fold(f64::MAX, f64::min)
}

/// Price makes a new extreme in the second half while the indicator does not: the strength is how much weaker the indicator is.
fn rsi_div(rsi: &[f64], c: &[Candle], up: bool) -> Option<f64> {
    let m = c.len() / 2;
    if up {
        let (p1, p2) = (fold_max(&c[..m].iter().map(|x| x.high).collect::<Vec<_>>()), fold_max(&c[m..].iter().map(|x| x.high).collect::<Vec<_>>()));
        let (r1, r2) = (fold_max(&rsi[..m]), fold_max(&rsi[m..]));
        (p2 > p1 && r2 < r1 && r1 > 0.0).then(|| ((r1 - r2) / r1).min(1.0))
    } else {
        let (p1, p2) = (fold_min(&c[..m].iter().map(|x| x.low).collect::<Vec<_>>()), fold_min(&c[m..].iter().map(|x| x.low).collect::<Vec<_>>()));
        let (r1, r2) = (fold_min(&rsi[..m]), fold_min(&rsi[m..]));
        (p2 < p1 && r2 > r1).then(|| ((r2 - r1) / 100.0).min(1.0))
    }
}

fn macd_div(macd: &[f64], c: &[Candle], up: bool) -> Option<f64> {
    let m = c.len() / 2;
    if up {
        let (p1, p2) = (fold_max(&c[..m].iter().map(|x| x.high).collect::<Vec<_>>()), fold_max(&c[m..].iter().map(|x| x.high).collect::<Vec<_>>()));
        let (d1, d2) = (fold_max(&macd[..m]), fold_max(&macd[m..]));
        (p2 > p1 && d2 < d1).then(|| if d1 > 0.0 { ((d1 - d2) / d1.abs()).min(1.0) } else { 0.5 })
    } else {
        let (p1, p2) = (fold_min(&c[..m].iter().map(|x| x.low).collect::<Vec<_>>()), fold_min(&c[m..].iter().map(|x| x.low).collect::<Vec<_>>()));
        let (d1, d2) = (fold_min(&macd[..m]), fold_min(&macd[m..]));
        (p2 < p1 && d2 > d1).then(|| if d1 < 0.0 { ((d2 - d1) / d1.abs()).min(1.0) } else { 0.5 })
    }
}

fn cmf_div(cmf: &[f64], c: &[Candle], up: bool) -> Option<f64> {
    let m = c.len() / 2;
    if up {
        let (p1, p2) = (fold_max(&c[..m].iter().map(|x| x.high).collect::<Vec<_>>()), fold_max(&c[m..].iter().map(|x| x.high).collect::<Vec<_>>()));
        (p2 > p1 && fold_max(&cmf[m..]) < fold_max(&cmf[..m])).then_some(0.7)
    } else {
        let (p1, p2) = (fold_min(&c[..m].iter().map(|x| x.low).collect::<Vec<_>>()), fold_min(&c[m..].iter().map(|x| x.low).collect::<Vec<_>>()));
        (p2 < p1 && fold_min(&cmf[m..]) > fold_min(&cmf[..m])).then_some(0.7)
    }
}

fn volume_div(c: &[Candle], up: bool) -> Option<f64> {
    let m = c.len() / 2;
    let a = c[..m].iter().map(|x| x.volume).sum::<f64>() / m as f64;
    let b = c[m..].iter().map(|x| x.volume).sum::<f64>() / (c.len() - m) as f64;
    if a <= 0.0 {
        return None;
    }
    if up && b < a {
        Some(((a - b) / a).min(1.0))
    } else if !up && b > a {
        Some(((b - a) / a).min(1.0))
    } else {
        None
    }
}

/// OBV and CMF move in opposite directions (the crowd and the money flow disagree).
fn obv_cmf_div(obv: &[f64], cmf: &[f64], up: bool) -> Option<f64> {
    let m = obv.len() / 2;
    let avg = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let (ot, ct) = (avg(&obv[m..]) - avg(&obv[..m]), avg(&cmf[m..]) - avg(&cmf[..m]));
    let ok = if up { ot > 0.0 && ct < 0.0 } else { ot < 0.0 && ct > 0.0 };
    ok.then(|| ((ot.abs() + ct.abs()) / 2.0).min(1.0))
}

fn rsi_series(c: &[Candle], period: usize) -> Vec<f64> {
    let mut out = vec![50.0; period.min(c.len())];
    for i in period..c.len() {
        let (mut gain, mut loss) = (0.0, 0.0);
        for j in i + 1 - period..=i {
            let d = c[j].close - c[j - 1].close;
            if d > 0.0 {
                gain += d;
            } else {
                loss -= d;
            }
        }
        let rs = if loss == 0.0 { 100.0 } else { gain / loss };
        out.push(100.0 - 100.0 / (1.0 + rs));
    }
    out
}

fn ema_series(v: &[f64], period: usize) -> Vec<f64> {
    let k = 2.0 / (period as f64 + 1.0);
    let mut out: Vec<f64> = Vec::with_capacity(v.len());
    for (i, &x) in v.iter().enumerate() {
        if i + 1 < period {
            out.push(x);
        } else if i + 1 == period {
            out.push(v[..period].iter().sum::<f64>() / period as f64);
        } else {
            out.push((x - out[i - 1]) * k + out[i - 1]);
        }
    }
    out
}

fn macd_line(c: &[Candle]) -> Vec<f64> {
    if c.len() < 26 {
        return vec![];
    }
    let closes: Vec<f64> = c.iter().map(|x| x.close).collect();
    ema_series(&closes, 12).iter().zip(ema_series(&closes, 26).iter()).map(|(a, b)| a - b).collect()
}

fn cmf_series(c: &[Candle], period: usize) -> Vec<f64> {
    (0..c.len())
        .map(|i| {
            if i + 1 < period {
                return 0.0;
            }
            let (mut mfv, mut vol) = (0.0, 0.0);
            for x in &c[i + 1 - period..=i] {
                let m = if x.high != x.low { ((x.close - x.low) - (x.high - x.close)) / (x.high - x.low) } else { 0.0 };
                mfv += m * x.volume;
                vol += x.volume;
            }
            if vol != 0.0 {
                mfv / vol
            } else {
                0.0
            }
        })
        .collect()
}

fn obv_series(c: &[Candle]) -> Vec<f64> {
    let mut total = 0.0;
    let mut out = Vec::with_capacity(c.len());
    for (i, x) in c.iter().enumerate() {
        if i > 0 {
            if x.close > c[i - 1].close {
                total += x.volume;
            } else if x.close < c[i - 1].close {
                total -= x.volume;
            }
        }
        out.push(total);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candle(i: usize, o: f64, h: f64, l: f64, c: f64, v: f64) -> Candle {
        Candle::new(i as u64 * 60_000, o, h, l, c, v)
    }

    #[test]
    fn needs_fifty_candles() {
        let c: Vec<Candle> = (0..49).map(|i| candle(i, 1.0, 1.1, 0.9, 1.0, 10.0)).collect();
        assert!(analyse(&c).is_none());
    }

    #[test]
    fn a_fall_that_loses_steam_scores_as_a_bullish_reversal() {
        // 40 flat candles, then a fall: the first leg is violent (big red candles, big volume), the second makes a lower low but with small candles
        // that close high (the sellers are tiring) and more volume
        let mut c: Vec<Candle> = (0..40).map(|i| candle(i, 100.0, 100.5, 99.5, 100.0, 100.0)).collect();
        let mut p = 100.0;
        for i in 40..50 {
            let next = p - 2.0;
            c.push(candle(i, p, p + 0.1, next - 0.2, next, 100.0));
            p = next;
        }
        for i in 50..60 {
            let next = p - 0.4;
            c.push(candle(i, p, p + 0.1, next - 0.6, next + 0.3, 300.0));
            p = next;
        }
        let r = analyse(&c).expect("enough candles");
        assert!(r.score > 20.0, "{r:?}");
        assert!(r.notes.iter().any(|n| n.contains("bullish") || n.contains("oversold") || n.contains("increasing")), "{r:?}");
    }

    #[test]
    fn the_known_direction_decides_which_side_is_scored() {
        // a market that has been falling, the last move being a pump: asked about a rise, the notes must be bearish ones
        let mut c: Vec<Candle> = (0..30).map(|i| candle(i, 100.0, 100.5, 99.5, 100.0, 100.0)).collect();
        let mut p = 100.0;
        for i in 30..60 {
            let next = p - 0.3;
            c.push(candle(i, p, p + 0.1, next - 0.1, next, 100.0));
            p = next;
        }
        let fall = analyse_for(&c, Some(false)).unwrap();
        let rise = analyse_for(&c, Some(true)).unwrap();
        assert!(fall.notes.iter().all(|n| !n.contains("bearish")), "{fall:?}");
        assert!(rise.notes.iter().all(|n| !n.contains("bullish") && !n.contains("oversold")), "{rise:?}");
    }

    #[test]
    fn a_calm_market_scores_low() {
        let c: Vec<Candle> = (0..60).map(|i| candle(i, 100.0, 100.2, 99.8, 100.0 + if i % 2 == 0 { 0.05 } else { -0.05 }, 100.0)).collect();
        assert!(analyse(&c).unwrap().score < 40.0);
    }
}
