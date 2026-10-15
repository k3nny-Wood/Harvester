import type { ReactNode } from 'react';

/** A panel that slides up from the bottom of the screen; tapping outside it closes it. */
export function Sheet({ title, tone, onClose, children }: { title: string; tone?: 'up' | 'down'; onClose: () => void; children: ReactNode }) {
  return (
    <div className="m-backdrop" onPointerDown={onClose}>
      <div className="m-sheet" onPointerDown={(e) => e.stopPropagation()}>
        <div className="m-sheet-head">
          <b className={tone}>{title}</b>
          <button className="m-x" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
