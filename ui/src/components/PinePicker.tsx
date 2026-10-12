import { useEffect, useMemo, useRef, useState } from 'react';
import { usePine } from '../chartStore';
import { ALL_PINE_LIBRARY } from '../pine/communityLibrary';
import { usePineStore } from '../pine/pineStore';

interface PickerItem {
  id: string;
  name: string;
  description: string;
  source: string;
  /** 'none' is not on the chart, 'on' is visible, 'off' is loaded but hidden. */
  state: 'none' | 'on' | 'off';
}

/**
 * Quick Pine Script chooser, opened with `/` while the pointer is over a chart.
 * It lists every preset plus any custom script already loaded, and toggles them.
 */
export function PinePicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = usePine();
  const scripts = usePineStore(store, (s) => s.scripts);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<PickerItem[]>(() => {
    const presets: PickerItem[] = ALL_PINE_LIBRARY.map((entry) => {
      const loaded = scripts.find((s) => s.id === entry.id);
      return { id: entry.id, name: entry.name, description: entry.category ?? 'Other', source: entry.source, state: loaded ? (loaded.enabled ? 'on' : 'off') : 'none' };
    });
    const custom: PickerItem[] = scripts
      .filter((s) => !ALL_PINE_LIBRARY.some((entry) => entry.id === s.id))
      .map((s) => ({ id: s.id, name: s.name, description: 'Custom script', source: s.source, state: s.enabled ? 'on' : 'off' }));
    return [...custom, ...presets];
  }, [scripts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => item.name.toLowerCase().includes(q) || item.description.toLowerCase().includes(q));
  }, [items, query]);

  const toggle = (item: PickerItem) => {
    if (item.state === 'none') {
      store.getState().addScript({ id: item.id, name: item.name, source: item.source, enabled: true });
      store.getState().setStatus(item.id, 'pending');
    } else {
      const script = scripts.find((s) => s.id === item.id);
      store.getState().updateScript(item.id, { enabled: !script?.enabled });
    }
  };

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (filtered.length === 0) return;
      const current = index < filtered.length ? index : 0;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setIndex((p) => (p + 1) % filtered.length);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setIndex((p) => (p - 1 + filtered.length) % filtered.length);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        toggle(filtered[current]);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, filtered, index, onClose]);

  if (!open) return null;

  return (
    <div className="pine-picker" role="dialog" aria-label="Choose a Pine Script" onPointerDown={(e) => e.stopPropagation()}>
      <div className="pine-head">
        <b>Pine Scripts</b>
        <span className="muted">Enter toggles · Esc closes</span>
      </div>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setIndex(0);
        }}
        placeholder="Filter scripts…"
        aria-label="Filter Pine Scripts"
      />
      {filtered.length === 0 ? (
        <p className="muted pine-desc">No script matches “{query}”.</p>
      ) : (
        <>
          <p className="muted pine-desc">
            {filtered.length} match{filtered.length === 1 ? '' : 'es'}
            {filtered.length > 40 ? ' - showing the first 40' : ''}
          </p>
          <ul>
            {filtered.slice(0, 40).map((item, position) => (
              <li key={item.id} className={`pine-picker-item ${position === index ? 'pine-picker-current' : ''}`}>
                <button type="button" onClick={() => toggle(item)} onMouseEnter={() => setIndex(position)} title={item.description}>
                  <span className={`pine-dot pine-dot-${item.state === 'none' ? 'idle' : item.state === 'on' ? 'running' : 'pending'}`} aria-hidden="true" />
                  <strong>{item.name}</strong>
                  <span className="muted">{item.state === 'none' ? item.description : item.state === 'on' ? 'on chart' : 'hidden'}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
