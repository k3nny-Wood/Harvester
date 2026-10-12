import { registerRendererLayer } from '@luxalgo/vela/plugin';

interface WatermarkData {
  symbol: string;
  enabled: boolean;
}

/**
 * The instrument's ticker painted as a large, faded watermark *behind* the candles
 * (`placement: 'below-data'`), so the bars are drawn on top of it. Registered once,
 * before any chart is created; the chart pushes the current symbol through the
 * layer's data channel whenever it changes.
 */
export function registerTickerWatermarkLayer(): void {
  registerRendererLayer({
    id: 'ticker-watermark',
    placement: 'below-data',
    create: () => {
      let canvas: HTMLCanvasElement | null = null;
      let ctx: CanvasRenderingContext2D | null = null;
      return {
        mount(c: HTMLCanvasElement) {
          canvas = c;
          ctx = c.getContext('2d');
        },
        render(args: {
          data: unknown;
          bounds: { top: number; height: number };
          theme: { textColor: string; fontFamily: string };
        }) {
          if (!ctx || !canvas) return;
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const config = args.data as WatermarkData | undefined;
          const symbol = config?.symbol ?? '';
          if (!config?.enabled || !symbol) return;

          const width = canvas.width;
          const height = args.bounds.height;
          if (width < 120 || height < 60) return;

          // Fit the ticker to the pane: at most ~45% of its height, and never wider
          // than 80% of it.
          let size = Math.max(24, Math.min(height * 0.45, (width * 0.8) / (symbol.length * 0.72)));
          const font = (px: number) => `700 ${px}px ${args.theme.fontFamily || 'system-ui, sans-serif'}`;
          ctx.save();
          ctx.globalAlpha = 0.035;
          ctx.fillStyle = args.theme.textColor;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const measured = ctx.measureText(symbol).width;
          const limit = width * 0.8;
          if (measured > limit) size = (size * limit) / measured;
          ctx.font = font(size);
          ctx.fillText(symbol, width / 2, args.bounds.top + height / 2);
          ctx.restore();
        },
        destroy() {
          ctx = null;
          canvas = null;
        },
      };
    },
  });
}
