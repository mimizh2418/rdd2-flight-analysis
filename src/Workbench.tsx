import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Run, Summary } from './data/types';
import { download, exportCsv } from './data/export';
import { useRunImport } from './data/useRunImport';
import { usePlayback } from './playback/PlaybackProvider';
import { TimeStrip, TransportControls } from './components/TimeStrip';
import { ViewSettingsMenu } from './components/ViewSettingsMenu';
import { DropdownMenu } from './components/DropdownMenu';
import { NewTabMenu, TabActionIcon, TabLabel } from './components/VisualizationTabs';
import { FieldBrowser } from './components/FieldBrowser';
import { BindingDock } from './components/BindingDock';
import { DroneIcon } from './components/DroneIcon';
import { SimulationPanel } from './components/SimulationPanel';
import { WorkspaceScene } from './scene/WorkspaceScene';
import { GraphView } from './charts/GraphView';
import { buildCatalog, findField, graphSignalIds } from './workspace/fieldCatalog';
import {
  createBinding,
  createTab,
  dropReason,
  fingerprint,
  initialTabs,
  reattachTabs,
  validateWorkspace,
  workspaceStorageKey,
} from './workspace/workspaceState';
import { usePreparation } from './workspace/usePreparation';
import type { Binding, Field, Lane, LoadingState, ViewTab, ViewType, WorkspaceDocument } from './workspace/types';

/**
 * Coordinate independent tabs, asynchronous fields, imports, and full-resolution exports.
 * @param props Loaded immutable runs, registry setter, and optional restored document.
 * @returns Resizable workbench with a field browser, one active visualization, and its configuration dock.
 */
export function Workbench({
  runs,
  setRuns,
  initial,
}: {
  runs: Run[];
  setRuns: (runs: Run[]) => void;
  initial?: WorkspaceDocument;
}) {
  // Source descriptors reference shared arrays; tabs contain presentation choices and stable binding identities.
  const playback = usePlayback();
  const fields = useMemo(() => buildCatalog(runs), [runs]);
  const [tabs, setTabs] = useState<ViewTab[]>(() =>
    initial ? reattachTabs(initial, runs) : initialTabs(runs[0], fields),
  );
  const [active, setActive] = useState(initial?.active ?? tabs[0]?.id ?? '');
  const tab = tabs.find((item) => item.id === active);
  const [runId, setRunId] = useState(runs[0]?.id ?? 'all');
  const [panel, setPanel] = useState<'runs' | 'simulation' | 'export' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dragged, setDragged] = useState<Field | null>(null);

  // Panel dimensions are workspace settings; collapsing a panel preserves its expanded size.
  const [browserWidth, setBrowserWidth] = useState(initial?.browserWidth ?? 290);
  const [dockHeight, setDockHeight] = useState(initial?.dockHeight ?? 250);
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const [dockCollapsed, setDockCollapsed] = useState(false);

  // Analysis selection is deliberately independent of the playback cursor and visible time window.
  const [interval, setInterval] = useState<[number, number]>([0, 30]);
  const [intervalMode, setIntervalMode] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [exportAll, setExportAll] = useState(true);
  const [graphLoading, setGraphLoading] = useState<Record<string, LoadingState>>({});

  // Keep unresolved source fingerprints until users reattach their files; never persist the telemetry arrays.
  const sourceIdentities = useRef(initial?.runs ?? []);
  const pendingRestore = useRef(initial);
  const csvInput = useRef<HTMLInputElement>(null);
  const workspaceInput = useRef<HTMLInputElement>(null);
  const renaming = useRef<HTMLInputElement>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const tabDrag = useRef<string | null>(null);

  // One worker cache serves every tab; only the active chart/scene mounts its rendering resources.
  const { service, prepared, loading } = usePreparation(runs, fields, tabs);
  const selectedRun = runs.find((run) => run.id === runId) ?? runs[0];
  const offset = selectedRun ? (playback.offsets.get(selectedRun.id) ?? NaN) : NaN;

  /**
   * Create the versioned configuration document; no source arrays are serialized.
   * @returns Workspace including unresolved source identities so their exact files can be reattached later.
   */
  const document = useCallback((): WorkspaceDocument => {
    const identities = new Map(sourceIdentities.current.map((source) => [source.id, source]));

    for (const run of runs)
      identities.set(run.id, {
        id: run.id,
        name: run.name,
        fingerprint: fingerprint(run),
        rows: run.time.length,
        start: run.time[run.index[0]],
        end: run.time[run.index[run.index.length - 1]],
      });

    const used = new Set(
      tabs.flatMap((item) =>
        item.bindings.flatMap((binding) => [binding.runId, binding.orientation?.runId ?? binding.runId]),
      ),
    );

    return {
      schema: 'rdd2-workspace-v1',
      runs: [...identities.values()].filter(
        (source) => used.has(source.id) || runs.some((run) => run.id === source.id),
      ),
      tabs,
      active,
      time: playback.time,
      window: playback.window,
      alignment: playback.alignment,
      browserWidth,
      dockHeight,
    };
  }, [runs, tabs, active, playback.time, playback.window, playback.alignment, browserWidth, dockHeight]);

  useEffect(() => {
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(workspaceStorageKey, JSON.stringify(document()));
      } catch {
        /* Storage is optional. */
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [document]);

  // A restored clock is applied after matching source coverage/alignment exists, rather than inventing offsets.
  useEffect(() => {
    const restore = pendingRestore.current;

    if (restore && restore.runs.every((source) => runs.some((run) => fingerprint(run) === source.fingerprint))) {
      if (playback.alignment !== restore.alignment) {
        playback.setAlignment(restore.alignment);
        return;
      }
      playback.seek(restore.time);
      playback.setWindow(restore.window);
      pendingRestore.current = undefined;
    }
  }, [runs, playback.alignment, playback.seek, playback.setAlignment, playback.setWindow]);

  useEffect(() => {
    playback.hover(null);
    setGraphLoading({});
  }, [active, playback.hover]);
  useEffect(() => {
    if (renameId) {
      renaming.current?.focus();
      renaming.current?.select();
    }
  }, [renameId]);
  useEffect(() => {
    if (!selectedRun || !Number.isFinite(offset)) return;
    setInterval([selectedRun.time[0] - offset, selectedRun.time[selectedRun.time.length - 1] - offset]);
    setSummary(null);
  }, [selectedRun, offset]);

  /**
   * Publish successful imports and reattach saved bindings only by matching their content fingerprint.
   *
   * @param batch Successful atomic import batch; existing traces remain unchanged on import failure.
   * @returns Nothing; updates source identities, bindings, source filter, and pauses playback.
   */
  const imported = (batch: Run[]) => {
    const next = [...runs, ...batch];
    const saved = document();

    // Reattachment uses CSV content. Untouched starter tabs receive useful defaults only after a log arrives.
    sourceIdentities.current = saved.runs;
    setTabs((current) => {
      const rebound = reattachTabs({ ...saved, tabs: current }, next);

      if (runs.length || saved.runs.length || current.some((item) => item.bindings.length)) return rebound;

      const defaults = initialTabs(batch[0], buildCatalog(next));
      return rebound.map((item, index) =>
        index < 3 && item.name === defaults[index]?.name && item.type === defaults[index]?.type
          ? { ...item, bindings: defaults[index].bindings }
          : item,
      );
    });
    setRuns(next);
    setRunId(batch[batch.length - 1].id);
    playback.setPlaying(false);
    setNotice(`${batch.length} run${batch.length === 1 ? '' : 's'} imported`);
  };
  const importer = useRunImport(imported, setError);

  /**
   * Update active-tab settings without modifying any other tab's configuration.
   * @param patch Partial configuration; bindings, when supplied, remain local to the active tab.
   * @returns Nothing; applies one immutable tab update.
   */
  const patchTab = (patch: Partial<ViewTab>) =>
    setTabs((current) => current.map((item) => (item.id === active ? { ...item, ...patch } : item)));

  /**
   * Reject incompatible drops before creating cancellable, independently configured bindings.
   *
   * @param field Catalog descriptor referencing immutable source columns.
   * @param lane Typed destination lane in the active tab.
   * @returns Nothing; queues one field, or separate scalar components for any list added to a graph.
   */
  const addField = (field: Field, lane: Lane) => {
    if (!tab) return;

    const reason = dropReason(tab, field, lane, fields);
    setDragged(null);
    if (reason) {
      setError(reason);
      return;
    }

    const signalIds = graphSignalIds(field);

    if (tab.type === 'graph' && signalIds.length > 1) {
      // Resolve all components from the same run before adding anything. Each row references existing columns.
      const components = signalIds
        .map((signal) => findField(fields, field.runId, signal))
        .filter((component): component is Field => component?.type === 'scalar');

      if (components.length !== signalIds.length) {
        setError('The field components are unavailable; reimport its source log.');
        return;
      }

      // Advance the palette for every component; each line gets its own color and appearance controls.
      const bindings = components.map((component, index) =>
        createBinding(component, lane, tab.bindings.length + index),
      );
      patchTab({ bindings: [...tab.bindings, ...bindings] });
      setError('');
      return;
    }

    if (tab.type === 'trajectory' && ['spatial', 'poses'].includes(lane) && field.type === 'orientation') {
      const pose =
        tab.bindings.find(
          (binding) =>
            binding.runId === field.runId &&
            ['pose', 'position'].includes(findField(fields, binding.runId, binding.fieldId)?.type ?? ''),
        ) ??
        tab.bindings.find((binding) =>
          ['pose', 'position'].includes(findField(fields, binding.runId, binding.fieldId)?.type ?? ''),
        );

      if (!pose) {
        setError('Add a position or pose before attaching an orientation source.');
        return;
      }
      patchTab({
        bindings: tab.bindings.map((binding) =>
          binding.id === pose.id ? { ...binding, orientation: { runId: field.runId, fieldId: field.id } } : binding,
        ),
      });
      setError('');
      return;
    }
    if (tab.type === 'vehicle' && lane === 'vehicle' && tab.bindings.some((binding) => binding.lane === 'vehicle')) {
      setError('Remove the current vehicle field before choosing a different centered vehicle.');
      return;
    }
    if (
      tab.type === 'trajectory' &&
      ['spatial', 'poses'].includes(lane) &&
      field.type === 'velocity' &&
      !tab.bindings.some((binding) =>
        ['position', 'pose'].includes(findField(fields, binding.runId, binding.fieldId)?.type ?? ''),
      )
    ) {
      setError('Add a pose before attaching its velocity vector.');
      return;
    }

    // A binding owns styles and cancellation state; adding it never copies an entire run.
    const binding = createBinding(field, lane, tab.bindings.length);

    if (['spatial', 'poses'].includes(lane) && ['velocity', 'orientation'].includes(field.type)) {
      binding.attachTo =
        tab.bindings.find(
          (item) =>
            item.runId === field.runId &&
            ['pose', 'position'].includes(findField(fields, item.runId, item.fieldId)?.type ?? ''),
        )?.id ??
        tab.bindings.find((item) =>
          ['pose', 'position'].includes(findField(fields, item.runId, item.fieldId)?.type ?? ''),
        )?.id;
    }
    patchTab({ bindings: [...tab.bindings, binding] });
    setError('');
  };

  /**
   * Validate a requested axis change before changing one binding's settings.
   *
   * @param id Stable binding identity in the active tab.
   * @param patch Presentation settings to update, including a validated axis destination.
   * @returns Nothing; invalid axis changes leave the original binding intact.
   */
  const patchBinding = (id: string, patch: Partial<Binding>) => {
    if (!tab) return;
    setDragged(null);
    const binding = tab.bindings.find((item) => item.id === id);

    if (patch.lane && binding) {
      const field = findField(fields, binding.runId, binding.fieldId);
      const reason = field
        ? dropReason({ ...tab, bindings: tab.bindings.filter((item) => item.id !== id) }, field, patch.lane, fields)
        : '';

      if (reason) {
        setError(reason);
        return;
      }
    }
    patchTab({ bindings: tab.bindings.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  };

  /**
   * Create another empty visualization of the requested type.
   *
   * @param type Requested visualization category.
   * @returns Nothing; creates and activates an empty tab without changing global time.
   */
  const newTab = (type: ViewType) => {
    const name = `${type === 'trajectory' ? 'Trajectory' : type === 'graph' ? 'Graph' : 'Vehicle'} ${tabs.filter((item) => item.type === type).length + 1}`;
    const next = createTab(type, name);
    setTabs((current) => [...current, next]);
    setActive(next.id);
  };

  /**
   * Duplicate settings with fresh tab/binding identities while keeping shared immutable source references.
   *
   * @returns Nothing; creates independent configuration identities while sharing source arrays.
   */
  const duplicate = () => {
    if (!tab) return;

    const copy = structuredClone(tab);
    copy.id = crypto.randomUUID();
    copy.name += ' copy';
    const identities = new Map(copy.bindings.map((binding) => [binding.id, crypto.randomUUID()]));
    copy.bindings.forEach((binding) => {
      binding.id = identities.get(binding.id)!;
      if (binding.attachTo) binding.attachTo = identities.get(binding.attachTo);
    });
    setTabs((current) => [...current, copy]);
    setActive(copy.id);
  };

  /**
   * Close a view; its binding jobs are cancelled by the preparation coordinator.
   *
   * @param id Stable identity of the tab to close.
   * @returns Nothing; selects a neighboring tab and cancels work owned by the removed tab.
   */
  const closeTab = (id: string) => {
    const index = tabs.findIndex((item) => item.id === id);
    const next = tabs.filter((item) => item.id !== id);
    setTabs(next);
    if (id === active) setActive(next[Math.min(index, next.length - 1)]?.id ?? '');
  };

  /**
   * Move one tab before another by drag-and-drop, preserving configuration and global time.
   *
   * @param id Identity of the tab being moved.
   * @param target Identity of the tab before which it should be inserted.
   * @returns Nothing; preserves settings, source references, and the global clock.
   */
  const reorder = (id: string, target: string) => {
    const next = tabs.filter((item) => item.id !== id);
    const item = tabs.find((candidate) => candidate.id === id);

    if (item) {
      next.splice(
        Math.max(
          0,
          next.findIndex((candidate) => candidate.id === target),
        ),
        0,
        item,
      );
      setTabs(next);
    }
  };

  /**
   * Resize the field browser or bottom dock while enforcing useful minimum viewport sizes.
   *
   * @param event Pointer-down event on a captured resize separator.
   * @param direction Panel dimension being resized.
   * @returns Nothing; installs temporary drag handlers and clamps usable dimensions in CSS pixels.
   */
  const resize = (event: PointerEvent<HTMLDivElement>, direction: 'browser' | 'dock') => {
    const origin = direction === 'browser' ? event.clientX : event.clientY;
    const size = direction === 'browser' ? browserWidth : dockHeight;
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    /**
     * Apply a captured pointer movement.
     *
     * @param pointer Current captured-pointer position in CSS pixels.
     * @returns Nothing; updates drag feedback or panel dimensions, or previews time when not dragging.
     */
    const move = (pointer: globalThis.PointerEvent) => {
      if (direction === 'browser')
        setBrowserWidth(Math.max(180, Math.min(600, innerWidth * 0.45, size + pointer.clientX - origin)));
      else setDockHeight(Math.max(120, Math.min(600, innerHeight * 0.55, size + origin - pointer.clientY)));
    };
    /**
     * Release temporary resources for the enclosing operation.
     *
     * @returns Nothing; removes captured-pointer listeners after a resize ends.
     */
    const finish = () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', finish);
      element.removeEventListener('pointercancel', finish);
    };
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerup', finish);
    element.addEventListener('pointercancel', finish);
  };

  /**
   * Update progress bars for active graph fields without restarting their underlying column upload jobs.
   *
   * @param ids Binding identities affected by this visible-window request.
   * @param fraction Completed fraction from zero to one.
   * @param stage Human-readable worker/transfer stage.
   * @param message Optional failure description to show in the field row.
   * @returns Nothing; updates row progress without restarting column-loading jobs.
   */
  const graphProgress = useCallback((ids: string[], fraction: number, stage: string, message?: string) => {
    setGraphLoading((old) => {
      const next = { ...old };

      for (const id of ids) next[id] = { fraction, stage, ready: fraction === 1, error: message };
      return next;
    });
  }, []);
  const rowLoading = useMemo(() => {
    const result = { ...loading };

    for (const [id, state] of Object.entries(graphLoading)) if (loading[id]?.ready) result[id] = state;
    return result;
  }, [loading, graphLoading]);

  /**
   * Validate a workspace file before replacing presentation settings; source files remain independently attached.
   *
   * @param file Local configuration JSON file, without telemetry arrays.
   * @returns Promise after validation/restoration or a displayed recoverable error.
   */
  const loadWorkspace = async (file: File) => {
    try {
      const restored = validateWorkspace(JSON.parse(await file.text()));
      sourceIdentities.current = restored.runs;
      pendingRestore.current = restored;
      setTabs(reattachTabs(restored, runs));
      setActive(restored.active);
      setBrowserWidth(restored.browserWidth);
      setDockHeight(restored.dockHeight);
      playback.setPlaying(false);
      playback.setAlignment(restored.alignment);
      if (
        playback.alignment === restored.alignment &&
        restored.runs.every((source) => runs.some((run) => fingerprint(run) === source.fingerprint))
      ) {
        playback.seek(restored.time);
        playback.setWindow(restored.window);
        pendingRestore.current = undefined;
      }
      setNotice('Workspace loaded. Reattach missing source files by importing their original CSVs.');
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  /**
   * Export the independent analysis interval using raw rows or worker-computed full-resolution statistics.
   *
   * @param statistics Export full-resolution statistics when true; otherwise export original CSV rows.
   * @returns Promise after a completed/cancelled save or displayed failure; restores the export button state.
   */
  const exportSelection = async (statistics = false) => {
    if (!selectedRun || !service || !Number.isFinite(offset)) return;
    setExporting(true);
    try {
      const simulationInterval = interval.map((value) => value + offset) as [number, number];

      if (statistics) {
        const result = await service.summary(selectedRun, simulationInterval);
        setSummary(result);
        download(
          'rdd2-statistics.json',
          new Blob(
            [
              JSON.stringify(
                {
                  run: selectedRun.name,
                  simulation_interval: simulationInterval,
                  tracking: result,
                  p95_method: 'Time-weighted interval midpoints',
                  provenance: selectedRun.manifest ?? null,
                  csv_sha256: fingerprint(selectedRun),
                  display_interval: interval,
                  alignment: playback.alignment,
                  alignment_offset_s: offset,
                },
                null,
                2,
              ),
            ],
            { type: 'application/json' },
          ),
        );
      } else {
        const selected =
          tab?.bindings
            .filter((binding) => binding.runId === selectedRun.id)
            .flatMap((binding) => findField(fields, binding.runId, binding.fieldId)?.signals ?? []) ?? [];
        const ids = [...new Set(exportAll ? selectedRun.raw : selected)];

        if (!ids.length) throw new Error('This tab has no fields from the selected export run.');
        await exportCsv(selectedRun, ids, simulationInterval);
      }
      setError('');
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === 'AbortError')) setError(String(failure));
    } finally {
      setExporting(false);
    }
  };

  const unaligned = runs.filter((run) => !Number.isFinite(playback.offsets.get(run.id)));
  const layout = {
    '--browser-width': `${browserCollapsed ? 42 : browserWidth}px`,
    '--dock-height': `${dockCollapsed ? 32 : dockHeight}px`,
  } as CSSProperties;

  return (
    <div
      className="workbench"
      style={layout}
      onDragEnd={() => setDragged(null)}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) {
          event.preventDefault();
          playback.setPlaying(false);
          void importer.load([...event.dataTransfer.files]);
        }
      }}
    >
      <header className="app-bar">
        <strong className="app-brand">
          <DroneIcon className="app-logo" />
          <span className="app-wordmark">RDD2</span>
          <span className="app-subtitle">Flight analysis</span>
        </strong>
        <div className="app-actions">
          <DropdownMenu className="workspace-menu" label="Workspace" summary="Workspace ▾" closeOnSelect>
            <button onClick={() => workspaceInput.current?.click()}>Open workspace</button>
            <button
              onClick={() =>
                download(
                  'rdd2-workspace.json',
                  new Blob([JSON.stringify(document(), null, 2)], { type: 'application/json' }),
                )
              }
            >
              Save workspace
            </button>
          </DropdownMenu>
          <button onClick={() => csvInput.current?.click()}>Import</button>
          <button onClick={() => setPanel('simulation')}>Simulation</button>
          <button onClick={() => setPanel('runs')}>
            Runs <span className="count">{runs.length}</span>
          </button>
          <button onClick={() => setPanel('export')}>Export</button>
        </div>
        <div className="app-bar-right">
          <span className="run-title" title={selectedRun?.name}>
            {selectedRun?.name ?? 'No source attached'}
          </span>
          <ViewSettingsMenu
            tab={tab}
            onTabPatch={patchTab}
            intervalMode={intervalMode}
            onIntervalMode={setIntervalMode}
          />
        </div>
        <input
          ref={csvInput}
          data-testid="trace-input"
          type="file"
          accept=".csv,.json"
          multiple
          hidden
          onChange={(event) => {
            playback.setPlaying(false);
            void importer.load([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
        <input
          ref={workspaceInput}
          data-testid="workspace-input"
          type="file"
          accept=".json"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];

            if (file) void loadWorkspace(file);
            event.target.value = '';
          }}
        />
      </header>
      <nav className="tab-bar" aria-label="Visualization tabs">
        <div className="tabs" role="tablist">
          {tabs.map((item) => (
            <div
              className={`tab ${item.id === active ? 'active' : ''}`}
              key={item.id}
              draggable={renameId !== item.id}
              onDragStart={(event) => {
                tabDrag.current = item.id;
                event.dataTransfer.setData('text/rdd2-tab', item.id);
              }}
              onDragOver={(event) => {
                if (event.dataTransfer.types.includes('text/rdd2-tab')) event.preventDefault();
              }}
              onDrop={(event) => {
                if (tabDrag.current) {
                  event.preventDefault();
                  reorder(tabDrag.current, item.id);
                  tabDrag.current = null;
                }
              }}
            >
              <TabLabel
                tab={item}
                selected={item.id === active}
                editing={renameId === item.id}
                inputRef={renaming}
                onSelect={() => setActive(item.id)}
                onRename={() => setRenameId(item.id)}
                onChange={(name) =>
                  setTabs((current) =>
                    current.map((candidate) => (candidate.id === item.id ? { ...candidate, name } : candidate)),
                  )
                }
                onFinish={() => setRenameId(null)}
              />
              <button
                className="tab-close flat"
                aria-label={`Close ${item.name}`}
                title={`Close ${item.name}`}
                onClick={() => closeTab(item.id)}
              >
                <TabActionIcon action="close" />
              </button>
            </div>
          ))}
        </div>
        <NewTabMenu active={active} onNew={newTab} />
        <button
          className="tab-control"
          disabled={!tab}
          onClick={duplicate}
          aria-label="Duplicate"
          title="Duplicate active tab"
        >
          <TabActionIcon action="duplicate" />
        </button>
        <button
          className="tab-control"
          disabled={!tab}
          onClick={() => setRenameId(active)}
          aria-label="Rename"
          title="Rename active tab"
        >
          <TabActionIcon action="rename" />
        </button>
        <button
          className="tab-control"
          disabled={!tab || tabs[0]?.id === active}
          aria-label="Move tab left"
          title="Move tab left"
          onClick={() => {
            const index = tabs.findIndex((item) => item.id === active);

            if (index > 0) reorder(active, tabs[index - 1].id);
          }}
        >
          <TabActionIcon action="left" />
        </button>
        <button
          className="tab-control"
          disabled={!tab || tabs[tabs.length - 1]?.id === active}
          aria-label="Move tab right"
          title="Move tab right"
          onClick={() => {
            const index = tabs.findIndex((item) => item.id === active);

            if (index < tabs.length - 1) {
              const next = [...tabs];
              [next[index], next[index + 1]] = [next[index + 1], next[index]];
              setTabs(next);
            }
          }}
        >
          <TabActionIcon action="right" />
        </button>
        <TransportControls disabled={!runs.length} />
      </nav>
      {importer.status && (
        <div className="import-status" role="status">
          <span>{importer.status.stage}</span>
          <progress max={1} value={importer.status.fraction} />
          <button onClick={importer.cancel}>Cancel import</button>
        </div>
      )}
      {error && (
        <div className="message error" role="alert">
          {error}
          <button className="flat" aria-label="Dismiss error" onClick={() => setError('')}>
            ×
          </button>
        </div>
      )}
      {!!unaligned.length && (
        <div className="message" role="status">
          Missing alignment event: {unaligned.map((run) => run.name).join(', ')}. Choose Absolute time or another
          exported alignment.
        </div>
      )}
      <div className="workspace-body">
        <FieldBrowser
          fields={fields}
          runs={runs}
          tab={tab}
          runId={runId}
          setRunId={setRunId}
          onAdd={addField}
          onDrag={setDragged}
          collapsed={browserCollapsed}
          toggle={() => setBrowserCollapsed(!browserCollapsed)}
        />
        <div
          className="browser-resizer resizer"
          role="separator"
          aria-label="Resize field browser"
          aria-orientation="vertical"
          onPointerDown={(event) => resize(event, 'browser')}
        />
        <main className="main-view">
          {tab && tab.type !== 'graph' && (
            <div className="clock-row">
              {runs.length ? <TimeStrip /> : <div className="time-placeholder mono">—</div>}
            </div>
          )}
          <div className="visualization" role="tabpanel" aria-label={tab?.name ?? 'Empty workspace'}>
            {!runs.length ? (
              <div className="empty-view">Import a log to view telemetry.</div>
            ) : tab?.type === 'graph' ? (
              <GraphView
                key={tab.id}
                tab={tab}
                fields={fields}
                runs={runs}
                service={service}
                onProgress={graphProgress}
                onToggle={(id) => {
                  const binding = tab.bindings.find((item) => item.id === id);

                  if (binding) patchBinding(id, { visible: !binding.visible });
                }}
                intervalMode={intervalMode}
                onInterval={(range) => {
                  setInterval(range);
                  setIntervalMode(false);
                  setNotice(`Analysis interval ${range[0].toFixed(3)} … ${range[1].toFixed(3)} s`);
                }}
              />
            ) : tab ? (
              <WorkspaceScene
                key={tab.id}
                tab={tab}
                fields={fields}
                runs={runs}
                prepared={prepared}
                onCameraMode={(camera) => patchTab({ camera })}
              />
            ) : (
              <div className="empty-view">Create a visualization from ＋ New.</div>
            )}
          </div>
          <div
            className="dock-resizer resizer"
            role="separator"
            aria-label="Resize field settings"
            aria-orientation="horizontal"
            onPointerDown={(event) => resize(event, 'dock')}
          />
          {tab && (
            <BindingDock
              tab={tab}
              fields={fields}
              runs={runs}
              loading={rowLoading}
              dragged={dragged}
              onAdd={addField}
              onPatch={patchBinding}
              onRemove={(id) => patchTab({ bindings: tab.bindings.filter((binding) => binding.id !== id) })}
              onTabPatch={patchTab}
              collapsed={dockCollapsed}
              toggle={() => setDockCollapsed(!dockCollapsed)}
            />
          )}
        </main>
      </div>
      <footer className="status-bar">
        <span>
          {notice ||
            `${runs.length} run${runs.length === 1 ? '' : 's'} · ${selectedRun?.time.length.toLocaleString() ?? 0} source rows`}
        </span>
        <span>
          {tabs.length} views · ENU / FLU · {playback.playing ? 'Playing' : 'Paused'}
        </span>
        <button className="flat" onClick={() => setPanel('runs')}>
          {runs.reduce((count, run) => count + run.warnings.length, 0)} source warnings
        </button>
      </footer>
      {panel && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setPanel(null);
          }}
        >
          <section
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={
              panel === 'runs' ? 'Source runs' : panel === 'export' ? 'Export interval' : 'Simulation service'
            }
          >
            <div className="dialog-title">
              <h2>
                {panel === 'runs' ? 'Source runs' : panel === 'export' ? 'Export interval' : 'Simulation service'}
              </h2>
              <button aria-label="Close dialog" onClick={() => setPanel(null)}>
                ×
              </button>
            </div>
            {panel === 'simulation' && <SimulationPanel load={(files) => void importer.load(files)} />}
            {panel === 'runs' && (
              <div className="run-list">
                {runs.map((run) => (
                  <article key={run.id}>
                    <div className="run-heading">
                      <strong>{run.name}</strong>
                      <button
                        onClick={() => {
                          sourceIdentities.current = document().runs;
                          setRuns(runs.filter((item) => item.id !== run.id));
                          if (runId === run.id) setRunId('all');
                        }}
                      >
                        Remove source
                      </button>
                    </div>
                    <dl>
                      <dt>Model</dt>
                      <dd>{run.manifest?.model ?? 'Unknown (plain CSV)'}</dd>
                      <dt>Rows / playback samples</dt>
                      <dd>
                        {run.time.length.toLocaleString()} / {run.index.length.toLocaleString()}
                      </dd>
                      <dt>Coverage</dt>
                      <dd>
                        {run.time[0]} … {run.time[run.time.length - 1]} s ·{' '}
                        {run.manifest?.coverage_status ?? 'From trace'}
                      </dd>
                      <dt>Termination</dt>
                      <dd>{JSON.stringify(run.manifest?.termination ?? 'Unknown')}</dd>
                      <dt>CSV SHA-256</dt>
                      <dd className="hash">{fingerprint(run)}</dd>
                      <dt>Import</dt>
                      <dd>
                        {(run.bytes / 1048576).toFixed(2)} MiB · {(run.importMs / 1000).toFixed(2)} s
                      </dd>
                    </dl>
                    {run.pathApproximation && <p>{run.pathApproximation}</p>}
                    {run.warnings.map((warning, index) => (
                      <p className="source-warning" key={index}>
                        {warning}
                      </p>
                    ))}
                    <details>
                      <summary>Provenance</summary>
                      <pre>
                        {JSON.stringify(run.manifest ?? { provenance: 'Unknown; no manifest supplied' }, null, 2)}
                      </pre>
                    </details>
                  </article>
                ))}
                {sourceIdentities.current
                  .filter((source) => !runs.some((run) => fingerprint(run) === source.fingerprint))
                  .map((source) => (
                    <p key={source.id}>Missing: {source.name} · reimport matching CSV content to reattach fields.</p>
                  ))}
              </div>
            )}
            {panel === 'export' && (
              <div className="export-panel">
                <label>
                  Source
                  <select
                    aria-label="Export source"
                    value={selectedRun?.id ?? ''}
                    onChange={(event) => setRunId(event.target.value)}
                  >
                    {runs.map((run) => (
                      <option key={run.id} value={run.id}>
                        {run.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="interval-inputs">
                  <label>
                    Start (s)
                    <input
                      aria-label="Interval start"
                      type="number"
                      step="any"
                      value={interval[0]}
                      onChange={(event) => {
                        const start = Number(event.target.value);

                        if (Number.isFinite(start) && start < interval[1]) setInterval([start, interval[1]]);
                      }}
                    />
                  </label>
                  <label>
                    End (s)
                    <input
                      aria-label="Interval end"
                      type="number"
                      step="any"
                      value={interval[1]}
                      onChange={(event) => {
                        const end = Number(event.target.value);

                        if (Number.isFinite(end) && end > interval[0]) setInterval([interval[0], end]);
                      }}
                    />
                  </label>
                  <button onClick={() => setInterval([...playback.window])}>Use visible range</button>
                </div>
                <p>Interval is independent of time zoom. CSV retains original timestamps and event rows.</p>
                <label>
                  <input type="checkbox" checked={exportAll} onChange={(event) => setExportAll(event.target.checked)} />
                  All original source channels (uncheck for this tab's selected fields)
                </label>
                <div className="dialog-actions">
                  <button
                    disabled={exporting || !selectedRun || !Number.isFinite(offset)}
                    onClick={() => void exportSelection()}
                  >
                    Export selection CSV
                  </button>
                  <button
                    disabled={exporting || !selectedRun || !service || !Number.isFinite(offset)}
                    onClick={() => void exportSelection(true)}
                  >
                    Export statistics
                  </button>
                </div>
                {exporting && <p role="status">Preparing export…</p>}
                {summary && (
                  <dl>
                    {Object.entries(summary).map(([key, value]) => (
                      <div key={key}>
                        <dt>{key}</dt>
                        <dd>{Number.isFinite(value) ? value.toFixed(6) : 'Unavailable'}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
