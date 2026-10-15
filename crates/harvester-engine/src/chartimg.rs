//! Chart pictures for Telegram: candles with the trader's position (entry, stop-loss, take-profit, liquidation) and open orders drawn on them.
//! Drawn here as a PNG, so it works whether or not a chart is open in the app.

use image::ImageEncoder;
use plotters::prelude::*;

pub struct Line {
    pub price: f64,
    pub label: String,
    pub color: (u8, u8, u8),
    pub dashed: bool,
}

pub struct ChartData {
    pub title: String,
    /// (open time ms, open, high, low, close)
    pub candles: Vec<[f64; 5]>,
    pub lines: Vec<Line>,
}

fn px(x: f64) -> String {
    if x >= 1000.0 {
        format!("{x:.1}")
    } else if x >= 1.0 {
        format!("{x:.4}")
    } else if x >= 0.01 {
        format!("{x:.5}")
    } else {
        format!("{x:.7}")
    }
}

pub fn render(d: &ChartData, w: u32, h: u32) -> Result<Vec<u8>, String> {
    if d.candles.len() < 3 {
        return Err("not enough candles".into());
    }
    let cs = &d.candles[d.candles.len().saturating_sub(160)..];
    let n = cs.len();
    let (mut lo, mut hi) = (f64::MAX, f64::MIN);
    for c in cs {
        lo = lo.min(c[3]);
        hi = hi.max(c[2]);
    }
    // a level is kept in view when it is within a candle-range of the price; a far-away liquidation price does not squash the candles
    let span = hi - lo;
    let (view_lo, view_hi) = (lo - span * 0.9, hi + span * 0.9);
    for l in &d.lines {
        if l.price >= view_lo && l.price <= view_hi {
            lo = lo.min(l.price);
            hi = hi.max(l.price);
        }
    }
    let pad = (hi - lo).max(hi * 1e-4) * 0.06;
    let (lo, hi) = (lo - pad, hi + pad);

    let mut buf = vec![0u8; (w * h * 3) as usize];
    {
        let root = BitMapBackend::with_buffer(&mut buf, (w, h)).into_drawing_area();
        root.fill(&RGBColor(10, 14, 20)).map_err(|e| e.to_string())?;
        let mut chart = ChartBuilder::on(&root)
            .margin(10)
            .caption(&d.title, ("sans-serif", 20).into_font().color(&RGBColor(215, 221, 229)))
            .x_label_area_size(0)
            .y_label_area_size(80)
            .build_cartesian_2d(0f64..n as f64, lo..hi)
            .map_err(|e| e.to_string())?;
        chart
            .configure_mesh()
            .disable_x_mesh()
            .y_labels(8)
            .y_label_formatter(&|v| px(*v))
            .y_label_style(("sans-serif", 12).into_font().color(&RGBColor(150, 160, 175)))
            .axis_style(RGBColor(50, 56, 66))
            .light_line_style(RGBColor(24, 30, 40))
            .draw()
            .map_err(|e| e.to_string())?;

        for (i, c) in cs.iter().enumerate() {
            let col = if c[4] >= c[1] { RGBColor(38, 166, 154) } else { RGBColor(239, 83, 80) };
            let x = i as f64 + 0.5;
            chart.draw_series(std::iter::once(PathElement::new(vec![(x, c[3]), (x, c[2])], col.stroke_width(1)))).map_err(|e| e.to_string())?;
            let (b0, b1) = (c[1].min(c[4]), c[1].max(c[4]).max(c[1].min(c[4]) + (hi - lo) * 0.0008));
            chart.draw_series(std::iter::once(Rectangle::new([(x - 0.32, b0), (x + 0.32, b1)], col.filled()))).map_err(|e| e.to_string())?;
        }

        // the last price
        let last = cs[n - 1][4];
        chart.draw_series(std::iter::once(PathElement::new(vec![(0.0, last), (n as f64, last)], RGBColor(150, 200, 255).stroke_width(1)))).map_err(|e| e.to_string())?;
        chart.draw_series(std::iter::once(Text::new(format!("price {}", px(last)), (n as f64 * 0.62, last + (hi - lo) * 0.006), ("sans-serif", 12).into_font().color(&RGBColor(150, 200, 255))))).map_err(|e| e.to_string())?;

        for l in &d.lines {
            if l.price < lo || l.price > hi {
                continue;
            }
            let col = RGBColor(l.color.0, l.color.1, l.color.2);
            if l.dashed {
                let step = (n as f64 / 80.0).max(0.6);
                let mut x = 0.0;
                while x < n as f64 {
                    chart.draw_series(std::iter::once(PathElement::new(vec![(x, l.price), ((x + step * 0.55).min(n as f64), l.price)], col.stroke_width(1)))).map_err(|e| e.to_string())?;
                    x += step;
                }
            } else {
                chart.draw_series(std::iter::once(PathElement::new(vec![(0.0, l.price), (n as f64, l.price)], col.stroke_width(2)))).map_err(|e| e.to_string())?;
            }
            chart.draw_series(std::iter::once(Text::new(format!("{} {}", l.label, px(l.price)), (1.0, l.price + (hi - lo) * 0.006), ("sans-serif", 12).into_font().color(&col)))).map_err(|e| e.to_string())?;
        }
        root.present().map_err(|e| e.to_string())?;
    }
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png).write_image(&buf, w, h, image::ExtendedColorType::Rgb8).map_err(|e| e.to_string())?;
    Ok(png)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candles(n: usize) -> Vec<[f64; 5]> {
        (0..n)
            .map(|i| {
                let p = 100.0 - (i as f64 * 0.05) + ((i % 7) as f64) * 0.1;
                [(i as u64 * 900_000) as f64, p, p + 0.4, p - 0.5, p - 0.1]
            })
            .collect()
    }

    #[test]
    fn renders_a_png_with_position_lines() {
        let d = ChartData {
            title: "TESTUSDT 15m".into(),
            candles: candles(120),
            lines: vec![
                Line { price: 99.0, label: "entry".into(), color: (230, 233, 239), dashed: false },
                Line { price: 96.0, label: "stop".into(), color: (239, 83, 80), dashed: true },
                Line { price: 5.0, label: "liquidation (far away, left out of view)".into(), color: (240, 160, 40), dashed: true },
            ],
        };
        let png = render(&d, 900, 520).expect("render");
        assert_eq!(&png[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A], "PNG signature");
        assert!(png.len() > 5_000, "{} bytes", png.len());
    }

    #[test]
    fn too_few_candles_is_an_error() {
        let d = ChartData { title: String::new(), candles: candles(2), lines: vec![] };
        assert!(render(&d, 400, 300).is_err());
    }
}
