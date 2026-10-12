//! Exact decimal helpers. Prices and quantities are rounded to the exchange's tick / step with
//! `rust_decimal`, never with floats, so rounding cannot drift (1.005 -> 1.01, not 1.00).

use rust_decimal::prelude::*;
use rust_decimal::RoundingStrategy;

#[derive(Debug, thiserror::Error)]
pub enum DecimalError {
    #[error("not a decimal number: {0}")]
    Parse(String),
}

pub fn parse(s: &str) -> Result<Decimal, DecimalError> {
    Decimal::from_str(s.trim()).map_err(|_| DecimalError::Parse(s.to_string()))
}

/// A float as a decimal, via a fixed 12-place string so `0.1 + 0.2` style noise is dropped.
pub fn from_f64(v: f64) -> Decimal {
    if !v.is_finite() {
        return Decimal::ZERO;
    }
    let s = format!("{v:.12}");
    Decimal::from_str(s.trim_end_matches('0').trim_end_matches('.')).unwrap_or(Decimal::ZERO)
}

pub fn to_f64(d: Decimal) -> f64 {
    d.to_f64().unwrap_or(0.0)
}

/// Round to the nearest multiple of `step`, half away from zero. The result carries exactly the
/// step's number of decimal places. A zero / negative step returns the value unchanged.
pub fn round_to_step(value: Decimal, step: Decimal) -> Decimal {
    if step <= Decimal::ZERO {
        return value;
    }
    let n = (value / step).round_dp_with_strategy(0, RoundingStrategy::MidpointAwayFromZero);
    let mut out = n * step;
    out.rescale(step.scale());
    out
}

/// `round_to_step` on strings; the result keeps the step's decimal places.
pub fn round_to_step_str(value: &str, step: &str) -> Result<String, DecimalError> {
    Ok(round_to_step(parse(value)?, parse(step)?).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(v: &str, s: &str) -> String {
        round_to_step_str(v, s).unwrap()
    }

    #[test]
    fn rounds_to_the_nearest_tick_size() {
        assert_eq!(r("101.237", "0.01"), "101.24");
        assert_eq!(r("101.234", "0.01"), "101.23");
        assert_eq!(r("101.235", "0.01"), "101.24"); // half away from zero
    }

    #[test]
    fn tiny_steps_have_no_float_drift() {
        assert_eq!(r("1.005", "0.01"), "1.01");
        assert_eq!(r("1.00005", "0.0001"), "1.0001");
        assert_eq!(r("0.00004999999999999999", "0.0001"), "0.0000");
    }

    #[test]
    fn negative_values_round_away_from_zero() {
        assert_eq!(r("-1.234", "0.01"), "-1.23");
        assert_eq!(r("-1.235", "0.01"), "-1.24");
    }

    #[test]
    fn keeps_the_steps_decimal_places() {
        assert_eq!(round_to_step(from_f64(10.0), parse("0.1").unwrap()).to_string(), "10.0");
        assert_eq!(round_to_step(from_f64(1.0), parse("1").unwrap()).to_string(), "1");
    }

    #[test]
    fn floats_become_clean_decimals() {
        assert_eq!(from_f64(0.1 + 0.2).to_string(), "0.3");
        assert_eq!(from_f64(2975.0).to_string(), "2975");
    }

    #[test]
    fn rejects_non_numeric_input() {
        assert!(parse("abc").is_err());
    }

    #[test]
    fn zero_step_leaves_the_value_alone() {
        assert_eq!(round_to_step(parse("1.23456").unwrap(), Decimal::ZERO).to_string(), "1.23456");
    }
}
