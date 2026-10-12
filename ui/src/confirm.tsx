import { useEffect, useRef } from 'react';
import { create } from 'zustand';

interface ConfirmState {
  open: boolean;
  text: string;
  danger: boolean;
  confirmLabel: string;
}

const useConfirm = create<ConfirmState>(() => ({ open: false, text: '', danger: false, confirmLabel: 'Confirm' }));
let resolver: ((ok: boolean) => void) | null = null;

/** An in-app confirmation (the browser's confirm() shows "localhost says" and is not wanted). Resolves true on Confirm. */
export function confirmDialog(text: string, opts: { danger?: boolean; confirmLabel?: string } = {}): Promise<boolean> {
  resolver?.(false); // a second dialog replaces the first
  return new Promise<boolean>((resolve) => {
    resolver = resolve;
    useConfirm.setState({ open: true, text, danger: !!opts.danger, confirmLabel: opts.confirmLabel ?? 'Confirm' });
  });
}

function answer(ok: boolean) {
  const r = resolver;
  resolver = null;
  useConfirm.setState({ open: false });
  r?.(ok);
}

export function ConfirmHost() {
  const { open, text, danger, confirmLabel } = useConfirm();
  const okRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') answer(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!open) return null;
  return (
    <div className="modal-back" onClick={() => answer(false)}>
      <div className={`modal${danger ? ' danger' : ''}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-text">{text}</div>
        <div className="modal-actions">
          <button onClick={() => answer(false)}>Cancel</button>
          <button ref={okRef} className="primary" style={danger ? { background: 'var(--down)', borderColor: 'var(--down)', color: '#fff' } : undefined} onClick={() => answer(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
