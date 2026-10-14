import { api } from '../api';
import { confirmDialog } from '../confirm';
import { useApp } from '../store';
import { refreshTrading } from '../trade';

/**
 * The per-order safety cap (MAX_ORDER_NOTIONAL): a guard against typing too many zeros. This button switches it off for the session, which also
 * lifts the limit on the size sliders; every start of Harvester has it on again.
 */
export function CapToggle() {
  const trading = useApp((s) => s.trading);
  const env = useApp((s) => s.env);
  const toast = useApp((s) => s.toast);
  if (!trading?.hasCredentials) return null;
  const off = trading.capOverride;

  const flip = async () => {
    if (!off) {
      const ok = await confirmDialog(
        `Switch the safety cap off?\n\nNow a single order is limited to ${trading.configuredCap} USDT. Without the cap any size is accepted (up to what Binance and your balance allow) and the size sliders are no longer limited.${env === 'live' ? '\n\nThis is the LIVE account: real money.' : ''}`,
        { danger: true, confirmLabel: 'Switch the cap off' },
      );
      if (!ok) return;
    }
    try {
      await api.setCapOverride(!off);
      toast(off ? `Safety cap back on: ${trading.configuredCap} USDT per order` : 'Safety cap OFF for this session: order size is no longer limited', off ? 'info' : 'warn');
      await refreshTrading();
    } catch (e) {
      toast(`Safety cap: ${e}`, 'warn');
    }
  };

  return (
    <button
      className={`cap-toggle${off ? ' off' : ''}`}
      onClick={() => void flip()}
      title={off ? 'The per-order safety cap is OFF (until Harvester is closed). Click to switch it back on.' : `Each order is limited to ${trading.configuredCap} USDT (MAX_ORDER_NOTIONAL). Click to switch the cap off.`}
    >
      Cap {off ? 'OFF' : 'on'}
    </button>
  );
}
