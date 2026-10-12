import { useEffect, useRef } from 'react';

interface Props {
  /** [time, open, high, low, close] */
  candles: Array<[number, number, number, number, number]>;
  base?: number | null;
  crackLevel?: number | null;
  /** extra horizontal lines drawn over the thumbnail */
  levels?: Array<{ price: number; color: string; dash?: number[] }>;
  width?: number;
  height?: number;
  onClick?: () => void;
  title?: string;
}

/** A small candlestick picture of a signal: the base (blue), the crack level (amber, dashed) and the last price. */
export function Thumb({ candles, base, crackLevel, levels, width = 116, height = 68, onClick, title }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || candles.length === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.scale(dpr, dpr);
    g.fillStyle = '#0b0f15';
    g.fillRect(0, 0, width, height);

    let lo = Math.min(...candles.map((c) => c[3]));
    let hi = Math.max(...candles.map((c) => c[2]));
    for (const level of [base, crackLevel, ...(levels ?? []).map((l) => l.price)]) {
      if (level != null && level > 0) {
        lo = Math.min(lo, level);
        hi = Math.max(hi, level);
      }
    }
    const pad = (hi - lo) * 0.06 || hi * 0.001;
    lo -= pad;
    hi += pad;
    const y = (p: number) => 4 + (1 - (p - lo) / (hi - lo)) * (height - 8);
    const slot = (width - 8) / candles.length;
    const body = Math.max(1, slot * 0.62);

    const line = (price: number | null | undefined, color: string, dash: number[]) => {
      if (price == null || price <= 0) return;
      g.strokeStyle = color;
      g.lineWidth = 1;
      g.setLineDash(dash);
      g.beginPath();
      g.moveTo(0, y(price));
      g.lineTo(width, y(price));
      g.stroke();
      g.setLineDash([]);
    };
    line(base, '#4f8fdd', []);
    line(crackLevel, '#e0a33d', [4, 3]);
    levels?.forEach((l) => line(l.price, l.color, l.dash ?? []));

    candles.forEach((c, i) => {
      const x = 4 + i * slot + slot / 2;
      const up = c[4] >= c[1];
      g.strokeStyle = g.fillStyle = up ? '#2e9b6f' : '#d0454b';
      g.beginPath();
      g.moveTo(x, y(c[2]));
      g.lineTo(x, y(c[3]));
      g.stroke();
      const top = y(Math.max(c[1], c[4]));
      g.fillRect(x - body / 2, top, body, Math.max(1, y(Math.min(c[1], c[4])) - top));
    });

    const last = candles[candles.length - 1][4];
    g.fillStyle = '#f0b90b';
    g.fillRect(width - 5, y(last) - 1.5, 5, 3);
  }, [candles, base, crackLevel, levels, width, height]);

  return <canvas ref={ref} className="thumb" style={{ width, height }} onClick={onClick} title={title} />;
}
