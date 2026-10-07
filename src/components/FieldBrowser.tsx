import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Run } from '../data/types';
import { usePlayback } from '../playback/PlaybackProvider';
import { fieldValue, incompatibility } from '../workspace/fieldCatalog';
import { fieldTree, filterFieldTree, type FieldNode } from '../workspace/fieldTree';
import type { Field, Lane, ViewTab } from '../workspace/types';

export const fieldMime = 'application/x-rdd2-field';

/**
 * Render a grouped, virtualized browser of available scalar and aggregate fields.
 * @param props Source descriptors/runs, active tab, source filter, and accessible Add/drag callbacks.
 * @returns Field menu whose visible values use the global effective timestamp; large raw catalogs stay virtualized.
 * @remarks The Add menu stays beside its trigger outside the scrolling browser's clipped content.
 */
export function FieldBrowser({
  fields,
  runs,
  tab,
  runId,
  setRunId,
  onAdd,
  onDrag,
  collapsed,
  toggle,
}: {
  fields: Field[];
  runs: Run[];
  tab?: ViewTab;
  runId: string;
  setRunId: (id: string) => void;
  onAdd: (field: Field, lane: Lane) => void;
  onDrag: (field: Field | null) => void;
  collapsed: boolean;
  toggle: () => void;
}) {
  const playback = usePlayback();
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState(new Set<string>());
  const [addField, setAddField] = useState<Field | null>(null);
  const [addPosition, setAddPosition] = useState({ top: 0, left: 0 });
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(500);
  const container = useRef<HTMLDivElement>(null);
  const addMenu = useRef<HTMLDivElement>(null);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const trees = useMemo(
    () =>
      runs
        .filter((run) => runId === 'all' || run.id === runId)
        .map((run) => ({
          run,
          nodes: filterFieldTree(
            fieldTree(fields.filter((field) => field.runId === run.id)),
            query.trim().toLowerCase(),
          ),
        })),
    [fields, runs, runId, query],
  );
  const rows = useMemo(() => {
    const result: { node: FieldNode; key: string; depth: number; expanded: boolean }[] = [];

    /**
     * Flatten expanded metadata only; numeric values are sampled just for visible virtual rows.
     * @param nodes Child nodes within one source hierarchy.
     * @param prefix Run-qualified ancestor key.
     * @param depth Indentation level.
     * @returns Nothing; appends visible nodes in display order.
     */
    const visit = (nodes: FieldNode[], prefix: string, depth: number) => {
      for (const node of nodes) {
        const key = `${prefix}/${node.key}`;
        const expanded =
          !!query ||
          opened.has(key) ||
          (!node.field && depth === 0 && node.label !== 'All source channels' && !opened.has(`closed:${key}`));
        result.push({ node, key, depth, expanded });
        if (expanded) visit(node.children, key, depth + 1);
      }
    };

    for (const { run, nodes } of trees) {
      if (runId === 'all' && trees.length > 1) {
        visit([{ key: run.id, label: run.name, children: nodes }], run.id, 0);
      } else visit(nodes, run.id, 0);
    }
    return result;
  }, [trees, query, opened, runId]);
  const rowHeight = 30;

  /**
   * Toggle a heading or selectable aggregate independently of its Add action.
   * @param key Run-qualified tree path.
   * @param expanded Current effective expansion state.
   * @returns Nothing; records the user's expansion choice, including default-open headings.
   */
  const toggleNode = (key: string, expanded: boolean) =>
    setOpened((current) => {
      const next = new Set(current);
      if (expanded) {
        next.delete(key);
        next.add(`closed:${key}`);
      } else {
        next.add(key);
        next.delete(`closed:${key}`);
      }
      return next;
    });
  const start = Math.max(0, Math.floor(scroll / rowHeight) - 4);
  const end = Math.min(rows.length, Math.ceil((scroll + height) / rowHeight) + 4);
  const lanes: Lane[] =
    tab?.type === 'graph' ? ['left', 'right'] : tab?.type === 'trajectory' ? ['spatial'] : ['vehicle', 'overlays'];
  const names: Record<Lane, string> = {
    spatial: '3D fields',
    left: 'Left Y axis',
    right: 'Right Y axis',
    paths: 'Trajectories',
    poses: 'Poses',
    vehicle: 'Vehicle',
    overlays: 'Overlays',
  };

  useEffect(() => {
    const element = container.current;

    if (!element) return;

    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [collapsed]);

  useEffect(() => {
    setScroll(0);
    if (container.current) container.current.scrollTop = 0;
  }, [query, runId]);

  useLayoutEffect(() => {
    if (!addField || collapsed) return;

    /**
     * Anchor the menu beside the Add button, flipping left and clamping vertically at viewport edges.
     * @returns Nothing; updates viewport coordinates or closes the menu when its virtualized row leaves view.
     */
    const place = () => {
      const trigger = addTrigger.current;
      const menu = addMenu.current;
      const list = container.current;

      if (!trigger?.isConnected || !menu || !list) {
        setAddField(null);
        return;
      }

      const anchor = trigger.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();

      // A scrolled-away row can remain mounted in the virtualization overscan, so check its visible bounds too.
      if (anchor.bottom <= bounds.top || anchor.top >= bounds.bottom) {
        setAddField(null);
        return;
      }

      const size = menu.getBoundingClientRect();
      const preferred = anchor.right + 6;
      const left = preferred + size.width <= innerWidth - 8 ? preferred : anchor.left - size.width - 6;
      const position = {
        top: Math.max(8, Math.min(anchor.top, innerHeight - size.height - 8)),
        left: Math.max(8, Math.min(left, innerWidth - size.width - 8)),
      };

      setAddPosition((current) =>
        current.top === position.top && current.left === position.left ? current : position,
      );
    };

    /**
     * Close the Add popup on an outside pointer press while preserving normal field and menu interactions.
     * @param event Document pointer press, including another field's Add button.
     * @returns Nothing; clicks inside the popup or on its own trigger leave dismissal to the control's handler.
     */
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!addMenu.current?.contains(target) && !addTrigger.current?.contains(target)) setAddField(null);
    };

    /**
     * Dismiss the Add popup from the keyboard and return focus to the field's Add button.
     * @param event Document key press while the popup is open.
     * @returns Nothing; consumes Escape and restores the trigger when it is still rendered.
     */
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setAddField(null);
      addTrigger.current?.focus();
    };

    place();
    addMenu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const observer = new ResizeObserver(place);
    if (addMenu.current) observer.observe(addMenu.current);
    if (container.current) observer.observe(container.current);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [addField, collapsed]);

  if (collapsed)
    return (
      <aside className="field-browser collapsed">
        <button aria-label="Expand fields" onClick={toggle}>
          Fields ›
        </button>
      </aside>
    );

  return (
    <aside className="field-browser" aria-label="Available telemetry fields">
      <div className="browser-head">
        <div className="browser-title">
          <strong>Fields</strong>
          <output className="mono" data-testid="field-time">
            t = {playback.effectiveTime.toFixed(3)} s
          </output>
          <button className="flat icon" aria-label="Collapse fields" onClick={toggle}>
            ‹
          </button>
        </div>
        <input
          className="search"
          type="search"
          aria-label="Search fields"
          placeholder="Search fields…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select aria-label="Field source run" value={runId} onChange={(event) => setRunId(event.target.value)}>
          <option value="all">All runs</option>
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field-list" ref={container} onScroll={(event) => setScroll(event.currentTarget.scrollTop)}>
        <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
          {rows.slice(start, end).map((row, index) => {
            const style = {
              position: 'absolute' as const,
              top: (start + index) * rowHeight,
              height: rowHeight,
              width: '100%',
            };

            if (!row.node.field)
              return (
                <button
                  key={row.key}
                  className="field-group"
                  style={{ ...style, paddingLeft: 8 + row.depth * 12 }}
                  aria-expanded={row.expanded}
                  onClick={() => toggleNode(row.key, row.expanded)}
                >
                  <span>
                    <span className="field-group-arrow">{row.expanded ? '▾' : '▸'}</span> {row.node.label}
                  </span>
                </button>
              );

            const field = row.node.field;
            const run = runs.find((item) => item.id === field.runId);
            const offset = playback.offsets.get(field.runId) ?? NaN;
            const value = fieldValue(
              field,
              run,
              playback.effectiveTime + offset,
              tab?.angles !== 'radians',
              field.signals.length > 1 ? 2 : 3,
            );

            return (
              <div
                key={row.key}
                style={{ ...style, paddingLeft: 8 + row.depth * 12 }}
                className={`field-row ${field.type !== 'scalar' ? 'aggregate' : ''}`}
                data-field-id={field.id}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.setData(fieldMime, JSON.stringify({ runId: field.runId, fieldId: field.id }));
                  event.dataTransfer.effectAllowed = 'copy';
                  onDrag(field);
                }}
                onDragEnd={() => onDrag(null)}
                title={`${run?.name}\n${field.signals.join('\n')}\n${field.frame} · ${field.unit || 'dimensionless'}\n${run?.signals[field.signals[0]]?.derived ?? ''}`}
              >
                {row.node.children.length ? (
                  <button
                    className="flat field-expand"
                    aria-label={`Expand ${field.label}`}
                    aria-expanded={row.expanded}
                    onClick={() => toggleNode(row.key, row.expanded)}
                  >
                    {row.expanded ? '▾' : '▸'}
                  </button>
                ) : (
                  <span className="field-leaf" aria-hidden="true">
                    ·
                  </span>
                )}
                <div className="field-content">
                  <div className="field-label">
                    {row.node.label}
                    {field.type !== 'scalar' && <span className="field-type">{field.type}</span>}
                  </div>
                  <div className="field-value mono" data-testid="field-value" title={value}>
                    {value}
                  </div>
                </div>
                <button
                  className="flat icon"
                  aria-label={`Add ${field.label}`}
                  aria-haspopup="dialog"
                  aria-expanded={addField?.runId === field.runId && addField.id === field.id}
                  disabled={!tab}
                  onClick={(event) => {
                    addTrigger.current = event.currentTarget;
                    setAddField((current) =>
                      current?.runId === field.runId && current.id === field.id ? null : field,
                    );
                  }}
                >
                  ＋
                </button>
              </div>
            );
          })}
        </div>
        {!rows.length && <div className="empty-note">{runs.length ? 'No matching fields' : 'No data available'}</div>}
      </div>
      <div className="browser-foot">
        ENU world · FLU body{' '}
        <span>{fields.filter((field) => runId === 'all' || field.runId === runId).length} fields</span>
      </div>
      {addField &&
        tab &&
        createPortal(
          <div
            className="browser-add"
            ref={addMenu}
            role="dialog"
            aria-label={`Add ${addField.label}`}
            style={addPosition}
          >
            <strong>{addField.label}</strong>
            {lanes.map((lane) => (
              <button
                key={lane}
                disabled={!!incompatibility(addField, tab.type, lane)}
                title={incompatibility(addField, tab.type, lane)}
                onClick={() => {
                  onAdd(addField, lane);
                  setAddField(null);
                }}
              >
                Add to {names[lane]}
              </button>
            ))}
            <button onClick={() => setAddField(null)}>Cancel</button>
          </div>,
          document.body,
        )}
    </aside>
  );
}
