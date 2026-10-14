import type { Vela } from '@luxalgo/vela';

/** A JPEG of the chart, at most `maxWidth` wide, as base64 without the `data:` prefix (null when the chart cannot be captured). */
export function chartJpeg(chart: Vela, maxWidth = 1400, quality = 0.85): string | null {
  const source = chart.renderer.screenshotCanvas();
  if (!source || source.width === 0 || source.height === 0) return null;
  const scale = Math.min(1, maxWidth / source.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(source.width * scale);
  canvas.height = Math.round(source.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  // the chart is drawn with a transparent background: put it on the dark chart colour, or it would arrive black-on-black
  ctx.fillStyle = '#0b0f15';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL('image/jpeg', quality);
  const i = url.indexOf(',');
  return i > 0 ? url.slice(i + 1) : null;
}
