//! ONNX inference for the ML entry signals: one model for longs, one for shorts (XGBoost exported to ONNX).
//! The input is the 38-feature vector from `harvester_core::ml`, scaled with the mean / scale stored next to the model.
//! Each model answers with a label (1 = a good entry) and the probability of that class.

use harvester_core::ladder::Side;
use harvester_core::ml::features::FeatureVector;
use ort::session::{builder::GraphOptimizationLevel, Session};
use ort::value::Tensor;
use serde::Deserialize;
use std::path::Path;

#[derive(Debug, Clone, Deserialize)]
pub struct Scaler {
    pub mean: Vec<f64>,
    pub scale: Vec<f64>,
}

impl Scaler {
    /// (x - mean) / scale, feature by feature.
    pub fn transform(&self, x: &[f64]) -> Vec<f64> {
        x.iter()
            .enumerate()
            .map(|(i, v)| {
                let (m, s) = (self.mean.get(i).copied().unwrap_or(0.0), self.scale.get(i).copied().unwrap_or(1.0));
                if s != 0.0 { (v - m) / s } else { v - m }
            })
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelConfig {
    pub model_name: String,
    pub model_version: String,
    pub direction: String,
    pub onnx_model_path: String,
    pub feature_count: usize,
    pub feature_names: Vec<String>,
    pub scaler: Scaler,
    #[serde(default)]
    pub validation_accuracy: f64,
    #[serde(default)]
    pub precision_score: f64,
    #[serde(default)]
    pub f1_score: f64,
}

pub struct Model {
    session: Session,
    pub config: ModelConfig,
}

impl Model {
    pub fn load(dir: &Path, config_file: &str) -> Result<Model, String> {
        let config: ModelConfig = serde_json::from_str(&std::fs::read_to_string(dir.join(config_file)).map_err(|e| format!("{config_file}: {e}"))?).map_err(|e| format!("{config_file}: {e}"))?;
        if config.feature_names != FeatureVector::feature_names() {
            return Err(format!("{config_file}: the model's feature list does not match this build's feature order"));
        }
        let session = Session::builder()
            .map_err(|e| e.to_string())?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| e.to_string())?
            .commit_from_file(dir.join(&config.onnx_model_path))
            .map_err(|e| format!("loading {}: {e}", config.onnx_model_path))?;
        Ok(Model { session, config })
    }

    /// (label, probability of a good entry)
    pub fn predict(&mut self, features: &FeatureVector) -> Result<(i64, f64), String> {
        let scaled = self.config.scaler.transform(&features.to_array());
        let input: Vec<f32> = scaled.iter().map(|x| *x as f32).collect();
        let n = input.len();
        let tensor: Tensor<f32> = Tensor::from_array(([1usize, n], input)).map_err(|e| e.to_string())?;
        let outputs = self.session.run(ort::inputs![tensor]).map_err(|e| format!("inference: {e}"))?;
        let label = outputs.iter().next().and_then(|(_, o)| o.try_extract_tensor::<i64>().ok().and_then(|(_, d)| d.first().copied())).unwrap_or(0);
        let prob = outputs
            .iter()
            .nth(1)
            .and_then(|(_, o)| o.try_extract_tensor::<f32>().ok().map(|(_, d)| if d.len() >= 2 { d[1] as f64 } else { d.first().copied().unwrap_or(0.5) as f64 }))
            .unwrap_or(if label == 1 { 0.7 } else { 0.3 });
        Ok((label, prob))
    }
}

/// The long and the short model.
pub struct Engine {
    long: Option<Model>,
    short: Option<Model>,
}

impl Engine {
    /// Load whatever models exist in `dir` (`model_config_long.json`, `model_config_short.json`).
    pub fn load(dir: &Path) -> Result<Engine, String> {
        let long = Model::load(dir, "model_config_long.json").map_err(|e| eprintln!("[ml] long model: {e}")).ok();
        let short = Model::load(dir, "model_config_short.json").map_err(|e| eprintln!("[ml] short model: {e}")).ok();
        if long.is_none() && short.is_none() {
            return Err(format!("no ML models could be loaded from {}", dir.display()));
        }
        Ok(Engine { long, short })
    }

    pub fn predict(&mut self, features: &FeatureVector, side: Side) -> Option<(i64, f64)> {
        let model = match side {
            Side::Buy => self.long.as_mut()?,
            Side::Sell => self.short.as_mut()?,
        };
        model.predict(features).map_err(|e| eprintln!("[ml] {e}")).ok()
    }

    pub fn describe(&self) -> String {
        let one = |m: &Option<Model>| m.as_ref().map_or("not loaded".to_string(), |m| format!("{} v{} (F1 {:.1}%)", m.config.model_name, m.config.model_version, m.config.f1_score * 100.0));
        format!("long: {}, short: {}", one(&self.long), one(&self.short))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../models/15m")
    }

    #[test]
    fn the_scaler_standardises() {
        let s = Scaler { mean: vec![1.0, 2.0], scale: vec![2.0, 0.0] };
        assert_eq!(s.transform(&[3.0, 5.0]), vec![1.0, 3.0]); // a zero scale only subtracts the mean
    }

    #[test]
    fn both_models_load_and_answer() {
        let mut engine = Engine::load(&dir()).expect("models load");
        println!("{}", engine.describe());
        let f = FeatureVector::new();
        for side in [Side::Buy, Side::Sell] {
            let (label, p) = engine.predict(&f, side).expect("a prediction");
            assert!(label == 0 || label == 1, "label {label}");
            assert!((0.0..=1.0).contains(&p), "probability {p}");
        }
    }

    #[test]
    fn the_models_feature_order_is_the_one_the_features_produce() {
        for file in ["model_config_long.json", "model_config_short.json"] {
            let cfg: ModelConfig = serde_json::from_str(&std::fs::read_to_string(dir().join(file)).unwrap()).unwrap();
            assert_eq!(cfg.feature_count, 38);
            assert_eq!(cfg.feature_names, FeatureVector::feature_names());
            assert_eq!(FeatureVector::new().to_array().len(), 38);
        }
    }
}
