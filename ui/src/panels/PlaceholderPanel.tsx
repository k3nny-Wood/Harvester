import type { IDockviewPanelProps } from 'dockview-react';

/** A panel that is on the roadmap: it already docks, floats and persists like the real ones. */
export function PlaceholderPanel({ params }: IDockviewPanelProps<{ note: string }>) {
  return (
    <div className="panel pad">
      <p className="muted">{params?.note ?? 'Coming soon.'}</p>
    </div>
  );
}
