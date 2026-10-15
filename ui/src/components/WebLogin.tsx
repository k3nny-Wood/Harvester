import { useEffect, useState } from 'react';
import { inTauri, onAuthNeeded, setToken } from '../transport';

/** In a browser: asks for the access token the server needs (HARVESTER_WEB_TOKEN in its .env file) and remembers it in this browser. */
export function WebLogin() {
  const [needed, setNeeded] = useState(false);
  const [value, setValue] = useState('');
  useEffect(() => onAuthNeeded(setNeeded), []);
  if (inTauri || !needed) return null;
  const submit = () => {
    if (!value.trim()) return;
    setToken(value);
    // everything is asked again with the new token
    window.location.reload();
  };
  return (
    <div className="size-backdrop">
      <div className="size-modal">
        <div className="quick-title">
          <b>Harvester</b>
        </div>
        <div className="muted quick-note">This page needs the access token of the Harvester server (HARVESTER_WEB_TOKEN in its .env file). It is remembered in this browser.</div>
        <input
          type="password"
          autoFocus
          placeholder="Access token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          style={{ width: '100%' }}
        />
        <div className="quick-actions">
          <button className="primary" disabled={!value.trim()} onClick={submit}>
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
