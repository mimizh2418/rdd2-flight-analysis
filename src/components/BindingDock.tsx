import type { Run } from '../data/types';
import { usePlayback } from '../playback/PlaybackProvider';
import { fieldValue, findField } from '../workspace/fieldCatalog';
import { dropReason } from '../workspace/workspaceState';
import { spatialDisplay } from '../workspace/spatial';
import type { Binding, Field, Lane, LoadingState, ViewTab } from '../workspace/types';
import { fieldMime } from './FieldBrowser';
import { AppearancePopover } from './AppearancePopover';
import { AppearanceControls, AppearanceIcon, VisibilityIcon } from './BindingAppearance';

/**
 * Edit per-tab field bindings and expose compatible, typed drop lanes.
 * @param props Tab settings, catalog, source runs, loading progress, and mutation/drop callbacks.
 * @returns Compact field rows in one spatial lane or two graph/vehicle lanes, with per-field appearance popups.
 * @remarks Pending fields retain a loading bar at the bottom of the row; popups do not clip to the scrolling dock.
 */
export function BindingDock({
  tab,
  fields,
  runs,
  loading,
  dragged,
  onAdd,
  onPatch,
  onRemove,
  onTabPatch,
  collapsed,
  toggle,
}: {
  tab: ViewTab;
  fields: Field[];
  runs: Run[];
  loading: Record<string, LoadingState>;
  dragged: Field | null;
  onAdd: (field: Field, lane: Lane) => void;
  onPatch: (id: string, patch: Partial<Binding>) => void;
  onRemove: (id: string) => void;
  onTabPatch: (patch: Partial<ViewTab>) => void;
  collapsed: boolean;
  toggle: () => void;
}) {
  const playback = usePlayback();
  const lanes: Lane[] =
    tab.type === 'graph' ? ['left', 'right'] : tab.type === 'trajectory' ? ['spatial'] : ['vehicle', 'overlays'];
  const titles: Record<Lane, string> = {
    spatial: '3D fields',
    left: 'Left Y axis',
    right: 'Right Y axis',
    paths: 'Trajectories',
    poses: 'Poses',
    vehicle: 'Vehicle',
    overlays: 'Overlays',
  };

  return (
    <section className={`binding-dock ${collapsed ? 'collapsed' : ''}`} aria-label="Visualized fields">
      <div className="dock-title">
        <span>Visualized fields · {tab.name}</span>
        <button
          className="flat icon"
          aria-label={collapsed ? 'Expand field settings' : 'Collapse field settings'}
          onClick={toggle}
        >
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <div className={`binding-lanes ${tab.type === 'trajectory' ? 'single' : ''}`}>
          {lanes.map((lane) => {
            const bindings = tab.bindings.filter((binding) => lane === 'spatial' || binding.lane === lane);
            const reason = dragged ? dropReason(tab, dragged, lane, fields) : '';
            const axis = lane === 'left' ? tab.leftAxis : tab.rightAxis;
            const axisKey = lane === 'left' ? 'leftAxis' : 'rightAxis';

            return (
              <div
                key={lane}
                className={`binding-lane ${dragged ? (reason ? 'incompatible' : 'compatible') : ''}`}
                data-lane={lane}
                onDragOver={(event) => {
                  if (event.dataTransfer.types.includes(fieldMime)) {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = reason ? 'none' : 'copy';
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  try {
                    const reference = JSON.parse(event.dataTransfer.getData(fieldMime));
                    const field = findField(fields, reference.runId, reference.fieldId);

                    if (field) onAdd(field, lane);
                  } catch {
                    /* Ignore unrelated drag payloads without changing any bindings. */
                  }
                }}
              >
                <div className="lane-header">
                  <strong>{titles[lane]}</strong>
                  {tab.type === 'graph' && (
                    <div className="axis-settings">
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`${titles[lane]} auto scale`}
                          checked={axis.auto}
                          onChange={(event) => onTabPatch({ [axisKey]: { ...axis, auto: event.target.checked } })}
                        />
                        Auto
                      </label>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`${titles[lane]} include zero`}
                          checked={axis.zero}
                          onChange={(event) => onTabPatch({ [axisKey]: { ...axis, zero: event.target.checked } })}
                        />
                        Zero
                      </label>
                      {!axis.auto && (
                        <>
                          <input
                            type="number"
                            step="any"
                            aria-label={`${titles[lane]} minimum`}
                            value={axis.min}
                            onChange={(event) => {
                              const min = Number(event.target.value);

                              if (Number.isFinite(min) && min < axis.max) onTabPatch({ [axisKey]: { ...axis, min } });
                            }}
                          />
                          <input
                            type="number"
                            step="any"
                            aria-label={`${titles[lane]} maximum`}
                            value={axis.max}
                            onChange={(event) => {
                              const max = Number(event.target.value);

                              if (Number.isFinite(max) && max > axis.min) onTabPatch({ [axisKey]: { ...axis, max } });
                            }}
                          />
                        </>
                      )}
                    </div>
                  )}
                </div>
                {tab.type === 'vehicle' && lane === 'vehicle' && (
                  <div className="vehicle-settings">
                    <label>
                      <input
                        type="checkbox"
                        checked={tab.followOrientation}
                        onChange={(event) => onTabPatch({ followOrientation: event.target.checked })}
                      />
                      Follow orientation
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={tab.bodyAxes}
                        onChange={(event) => onTabPatch({ bodyAxes: event.target.checked })}
                      />
                      Body axes
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={tab.worldAxes}
                        onChange={(event) => onTabPatch({ worldAxes: event.target.checked })}
                      />
                      World axes
                    </label>
                  </div>
                )}
                {bindings.map((binding) => {
                  const field = findField(fields, binding.runId, binding.fieldId);
                  const run = runs.find((item) => item.id === binding.runId);
                  const state = loading[binding.id];
                  const missingAnchor = binding.attachTo && !tab.bindings.some((item) => item.id === binding.attachTo);
                  const offset = playback.offsets.get(binding.runId) ?? NaN;
                  const isPose =
                    lane === 'vehicle' ||
                    (lane === 'spatial' && ['pose', 'position', 'orientation'].includes(field?.type ?? ''));

                  return (
                    <article
                      className="binding"
                      key={binding.id}
                      data-binding-id={binding.id}
                      data-field-id={binding.fieldId}
                      aria-busy={!!state && !state.ready && !state.error}
                      onDragOver={(event) => {
                        if (isPose && dragged?.type === 'orientation') event.preventDefault();
                      }}
                      onDrop={(event) => {
                        if (!isPose) return;
                        try {
                          const reference = JSON.parse(event.dataTransfer.getData(fieldMime));
                          const source = findField(fields, reference.runId, reference.fieldId);

                          if (source?.type === 'orientation') {
                            event.preventDefault();
                            event.stopPropagation();
                            onPatch(binding.id, { orientation: { runId: source.runId, fieldId: source.id } });
                          }
                        } catch {
                          /* Unrelated drops continue to the typed lane. */
                        }
                      }}
                    >
                      <div className="binding-head">
                        <AppearancePopover
                          label={binding.label}
                          icon={<AppearanceIcon binding={binding} field={field} tab={tab} />}
                        >
                          <AppearanceControls
                            binding={binding}
                            field={field}
                            tab={tab}
                            fields={fields}
                            runs={runs}
                            onPatch={onPatch}
                          />
                        </AppearancePopover>
                        <div className="binding-name-value">
                          <div className="binding-title">
                            {/* Match the editable label's width to its text so the source sits beside the name. */}
                            <div className="binding-label-wrap">
                              <span className="binding-label-size" aria-hidden="true">
                                {binding.label || ' '}
                              </span>
                              <input
                                className="binding-label"
                                aria-label={`Label ${binding.label}`}
                                value={binding.label}
                                onChange={(event) => onPatch(binding.id, { label: event.target.value })}
                              />
                            </div>
                            {runs.length > 1 && run && (
                              <span className="binding-source" title={run.name}>
                                ({run.name})
                              </span>
                            )}
                          </div>
                          <span className="binding-value mono">
                            {field
                              ? fieldValue(
                                  field,
                                  run,
                                  playback.effectiveTime + offset,
                                  tab.angles === 'degrees',
                                  field.type === 'scalar' ? 6 : 3,
                                  field.type === 'scalar',
                                )
                              : '—'}
                          </span>
                        </div>
                        {tab.type === 'trajectory' && ['pose', 'position'].includes(field?.type ?? '') && (
                          <select
                            className="binding-display"
                            aria-label={`Display ${binding.label}`}
                            title="Display as trajectory, pose, or both"
                            value={spatialDisplay(binding, field)}
                            onChange={(event) =>
                              onPatch(binding.id, { display: event.target.value as Binding['display'] })
                            }
                          >
                            <option value="trajectory">Trajectory</option>
                            <option value="pose">Pose</option>
                            <option value="both">Both</option>
                          </select>
                        )}
                        <button
                          className={`flat visibility ${binding.visible ? '' : 'hidden'}`}
                          aria-label={`${binding.visible ? 'Hide' : 'Show'} ${binding.label}`}
                          aria-pressed={binding.visible}
                          title={binding.visible ? 'Hide field' : 'Show field'}
                          onClick={() => onPatch(binding.id, { visible: !binding.visible })}
                        >
                          <VisibilityIcon visible={binding.visible} />
                        </button>
                        <button
                          className="flat remove"
                          aria-label={`Remove ${binding.label}`}
                          onClick={() => onRemove(binding.id)}
                        >
                          ×
                        </button>
                      </div>
                      {state && !state.ready && !state.error && (
                        <div className="field-loading">
                          <div className="loading-label">
                            <span>{state.stage}</span>
                            <span>{Math.round(state.fraction * 100)}%</span>
                          </div>
                          <progress aria-label={`Loading ${binding.label}`} max={1} value={state.fraction} />
                        </div>
                      )}
                      {(state?.error || !field || missingAnchor) && (
                        <div className="binding-error" role="status">
                          {state?.error ??
                            (missingAnchor
                              ? 'Attached pose unavailable; choose another pose or World origin.'
                              : 'Field unavailable; attach its original trace or remove this binding.')}
                        </div>
                      )}
                    </article>
                  );
                })}
                <div className="drop-target" data-testid={`drop-${lane}`}>
                  {dragged && reason
                    ? reason
                    : `＋ Drop ${tab.type === 'graph' ? 'scalar or vector field' : lane === 'spatial' ? 'pose, position, mission path, or vector' : lane === 'vehicle' ? 'vehicle pose or orientation' : 'velocity, orientation, or actuation'}`}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
