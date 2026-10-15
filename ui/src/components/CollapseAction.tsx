import type { IDockviewHeaderActionsProps } from 'dockview-react';
import { useState } from 'react';

/** The size a collapsed panel keeps: just its tab bar (a tall panel beside the charts keeps a narrow strip instead). */
const COLLAPSED_HEIGHT = 36;
const COLLAPSED_WIDTH = 44;
/** The least dockview lets a panel be while it is open. */
const OPEN_MINIMUM = 100;

interface Saved {
  axis: 'height' | 'width';
  size: number;
}

/** What each collapsed group was before, to bring it back. Not saved with the layout: a restart brings every panel back open. */
const collapsed = new Map<string, Saved>();

/**
 * A button at the right of every panel's tab bar that collapses the panel to its tab bar and opens it again. A panel that fills the height of
 * the window (the symbol list) collapses sideways, the others collapse downwards and hand their space to their neighbours.
 */
export function CollapseAction({ group, containerApi, activePanel }: IDockviewHeaderActionsProps) {
  const [, bump] = useState(0);
  // the charts keep their size: there is nothing to gain from collapsing one
  if (!activePanel || activePanel.id.startsWith('chart-')) return null;
  const saved = collapsed.get(group.id);
  const toggle = () => {
    const api = group.api;
    if (saved) {
      if (saved.axis === 'height') {
        api.setConstraints({ minimumHeight: OPEN_MINIMUM });
        api.setSize({ height: saved.size });
      } else {
        api.setConstraints({ minimumWidth: OPEN_MINIMUM });
        api.setSize({ width: saved.size });
      }
      collapsed.delete(group.id);
    } else {
      const sideways = api.height >= containerApi.height * 0.9;
      if (sideways) {
        collapsed.set(group.id, { axis: 'width', size: api.width });
        api.setConstraints({ minimumWidth: COLLAPSED_WIDTH });
        api.setSize({ width: COLLAPSED_WIDTH });
      } else {
        collapsed.set(group.id, { axis: 'height', size: api.height });
        api.setConstraints({ minimumHeight: COLLAPSED_HEIGHT });
        api.setSize({ height: COLLAPSED_HEIGHT });
      }
    }
    bump((n) => n + 1);
  };
  return (
    <button className="icon-btn collapse-btn" onClick={toggle} title={saved ? 'Open this panel again' : 'Collapse this panel to its tab bar'}>
      {saved ? '▸' : '▾'}
    </button>
  );
}
