import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ViewTab, ViewType } from '../workspace/types';
import { DropdownMenu } from './DropdownMenu';
import { DroneIcon } from './DroneIcon';

export const tabSymbols: Record<ViewType, string> = { trajectory: '◇', graph: '⌁', vehicle: '✧' };
type TabAction = 'new' | 'duplicate' | 'rename' | 'left' | 'right' | 'close';

/**
 * Draw a familiar toolbar pictogram for a tab action.
 * @param props Action represented by the surrounding labeled button.
 * @returns Decorative SVG; the control supplies its accessible name and tooltip.
 */
export function TabActionIcon({ action }: { action: TabAction }) {
  const shapes = {
    new: <path d="M12 5 V19 M5 12 H19" />,
    duplicate: (
      <>
        <path d="M7 15 H4 V4 H15 V7" />
        <rect x={8} y={8} width={12} height={12} rx={1.5} />
      </>
    ),
    rename: (
      <>
        <path d="M4 16 L15 5 L19 9 L8 20 L3 21 Z M13 7 L17 11" />
        <path d="M15 5 L17 3 Q18 2 19 3 L21 5 Q22 6 21 7 L19 9" />
      </>
    ),
    left: <path d="M19 5 V19 M16 12 H4 M9 7 L4 12 L9 17" />,
    right: <path d="M5 5 V19 M8 12 H20 M15 7 L20 12 L15 17" />,
    close: <path d="M6 6 L18 18 M18 6 L6 18" />,
  };

  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {shapes[action]}
    </svg>
  );
}

/**
 * Use one outline icon style for visualization labels and creation choices.
 * @param props Visualization category.
 * @returns Decorative SVG with a consistent width across tab types; controls supply accessible labels.
 */
export function VisualizationIcon({ type }: { type: ViewType }) {
  return (
    <span className="tab-type-icon" aria-hidden="true">
      {type === 'vehicle' ? (
        <DroneIcon />
      ) : (
        <svg viewBox="0 0 24 24" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.5}>
          {type === 'graph' ? (
            <path d="M3 3 V21 H21 M5 16 L10 8 L15 13 L21 4" />
          ) : (
            <>
              <path d="M4 17 C7 20 8 7 13 8 S14 18 20 13 M8 4 L12 2 L16 4 L12 6 Z" />
              <circle cx={4} cy={17} r={2} />
            </>
          )}
        </svg>
      )}
    </span>
  );
}

/**
 * Offer new visualization types and dismiss the popup when users interact elsewhere.
 * @param props Active tab identity and callback that creates and activates the requested type.
 * @returns Icon-only New control and labeled choices sharing the existing visualization symbols.
 * @remarks Pointer presses outside, Escape, tab changes, and successful selections close the menu.
 */
export function NewTabMenu({ active, onNew }: { active: string; onNew: (type: ViewType) => void }) {
  return (
    <DropdownMenu
      className="new-tab"
      summaryClassName="tab-control"
      label="New visualization"
      title="New visualization"
      contextKey={active}
      closeOnSelect
      summary={
        <>
          <TabActionIcon action="new" />
          <svg className="menu-chevron" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M3 4 L6 7 L9 4" fill="none" stroke="currentColor" strokeWidth={1.5} />
          </svg>
        </>
      }
    >
      {(['trajectory', 'graph', 'vehicle'] as ViewType[]).map((type) => (
        <button key={type} onClick={() => onNew(type)}>
          <VisualizationIcon type={type} />
          {type === 'trajectory' ? '3D trajectory' : type === 'graph' ? 'Graph' : 'Vehicle'}
        </button>
      ))}
    </DropdownMenu>
  );
}

/**
 * Render a tab label with an inline name editor that preserves its icon and current dimensions.
 * @param props Tab metadata, selected/editing state, shared editor ref, and label interaction callbacks.
 * @returns Tab button with a name-only editing overlay when renaming.
 * @remarks The label width is captured before paint and held until editing ends, including while text changes.
 */
export function TabLabel({
  tab,
  selected,
  editing,
  inputRef,
  onSelect,
  onRename,
  onChange,
  onFinish,
}: {
  tab: ViewTab;
  selected: boolean;
  editing: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onSelect: () => void;
  onRename: () => void;
  onChange: (name: string) => void;
  onFinish: () => void;
}) {
  const label = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>();

  useLayoutEffect(() => {
    // The editor is absolutely positioned, so measuring here includes the original icon and name only.
    setWidth(editing ? label.current!.getBoundingClientRect().width : undefined);
  }, [editing]);

  return (
    <div className={`tab-label ${editing ? 'editing' : ''}`} ref={label} style={editing ? { width } : undefined}>
      <button
        role="tab"
        aria-selected={selected}
        aria-label={`${tabSymbols[tab.type]} ${tab.name}`}
        title={tab.name}
        tabIndex={editing ? -1 : undefined}
        onClick={onSelect}
        onDoubleClick={onRename}
      >
        <VisualizationIcon type={tab.type} /> <span className="tab-name">{tab.name}</span>
      </button>
      {editing && (
        <input
          ref={inputRef}
          aria-label="Tab name"
          value={tab.name}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onFinish}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === 'Escape') {
              event.preventDefault();
              onFinish();
            }
          }}
        />
      )}
    </div>
  );
}
