import { useState } from 'react';
import { usePine } from '../chartStore';
import { ALL_PINE_LIBRARY, findPineEntry } from '../pine/communityLibrary';
import { newPineId, usePineStore, type PineScript } from '../pine/pineStore';
import { useApp } from '../store';

const STARTER = `//@version=5
indicator("My indicator", overlay=true)
plot(ta.sma(close, 20), "SMA 20", color.orange)`;

/**
 * The Pine Script workspace of one chart tab, opened from the chart's `Pine` button. It floats over the chart so the
 * indicators being edited stay visible. Choosing a preset activates it at once; the editor is for changing it or writing your own.
 */
export function PinePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = usePine();
  const scripts = usePineStore(store, (s) => s.scripts);
  const statusMap = usePineStore(store, (s) => s.status);
  const errors = usePineStore(store, (s) => s.errors);
  const readouts = usePineStore(store, (s) => s.readouts);
  const toast = useApp((s) => s.toast);
  const [name, setName] = useState('My indicator');
  const [source, setSource] = useState(STARTER);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [presetId, setPresetId] = useState('');

  const categories = new Map<string, typeof ALL_PINE_LIBRARY>();
  for (const entry of ALL_PINE_LIBRARY) {
    const category = entry.category ?? 'Other';
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category)!.push(entry);
  }

  const loadForEditing = (script: PineScript) => {
    setEditingId(script.id);
    setName(script.name);
    setSource(script.source);
  };

  const selectPreset = (id: string) => {
    setPresetId(id);
    const entry = findPineEntry(id);
    if (!entry) return;
    const script: PineScript = { id: entry.id, name: entry.name, source: entry.source, enabled: true };
    store.getState().addScript(script);
    store.getState().setStatus(entry.id, 'pending');
    loadForEditing(script);
    toast(`${entry.name} added to the chart`, 'info');
  };

  const run = () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    const id = editingId ?? newPineId();
    store.getState().addScript({ id, name: name.trim() || 'Untitled', source: trimmed, enabled: true });
    store.getState().setStatus(id, 'pending');
    setEditingId(id);
  };

  const preset = findPineEntry(presetId);
  if (!open) return null;

  return (
    <div className="pine-popup" role="dialog" aria-label="Pine Scripts" onPointerDown={(e) => e.stopPropagation()}>
      <div className="pine-head">
        <b>Pine Scripts</b>
        <span className="muted">{scripts.length} on this chart</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close Pine Scripts">
          ×
        </button>
      </div>

      <div className="pine-body">
        <label className="pine-field">
          Preset ({ALL_PINE_LIBRARY.length})
          <select value={presetId} onChange={(e) => selectPreset(e.target.value)} aria-label="Pine Script preset">
            <option value="">choose a preset…</option>
            {[...categories.entries()].map(([category, entries]) => (
              <optgroup key={category} label={category}>
                {entries.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        {preset?.description && (
          <p className="muted pine-desc">
            {preset.description}
            {preset.sourceUrl && (
              <>
                {' '}
                <a href={preset.sourceUrl} target="_blank" rel="noopener noreferrer">
                  source
                </a>
              </>
            )}
          </p>
        )}

        <label className="pine-field">
          Name
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Indicator name" />
        </label>
        <textarea className="pine-editor" value={source} onChange={(e) => setSource(e.target.value)} spellCheck={false} aria-label="Pine Script source" />
        <div className="pine-actions">
          <button className="primary" onClick={run}>
            {editingId ? 'Update' : 'Run on chart'}
          </button>
          {editingId && (
            <button
              onClick={() => {
                setEditingId(null);
                setName('My indicator');
                setSource(STARTER);
              }}
            >
              New script
            </button>
          )}
        </div>

        {scripts.length > 0 && (
          <ul className="pine-list">
            {scripts.map((script) => {
              const status = statusMap[script.id] ?? 'pending';
              const readout = readouts[script.id] ?? [];
              return (
                <li key={script.id} className={`pine-item ${script.enabled ? '' : 'pine-item-off'}`}>
                  <div className="pine-item-row">
                    <span className={`pine-dot pine-dot-${status}`} aria-hidden="true" />
                    <strong>{script.name}</strong>
                    <span className="muted">{status}</span>
                    <div className="pine-item-actions">
                      <button onClick={() => store.getState().updateScript(script.id, { enabled: !script.enabled })}>{script.enabled ? 'hide' : 'show'}</button>
                      <button onClick={() => loadForEditing(script)}>edit</button>
                      <button onClick={() => store.getState().removeScript(script.id)}>remove</button>
                    </div>
                  </div>
                  {status === 'error' && errors[script.id] && <p className="warn pine-desc">{errors[script.id]}</p>}
                  {readout.length > 0 && (
                    <div className="pine-readout">
                      {readout.map((row) => (
                        <span key={row.label}>
                          {row.label}: <b>{row.value}</b>
                        </span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
