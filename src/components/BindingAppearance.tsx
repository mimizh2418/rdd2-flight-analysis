import { colorPresets } from '../workspace/workspaceState';
import { findField } from '../workspace/fieldCatalog';
import { spatialLayers } from '../workspace/spatial';
import type { Binding, Field, ViewTab } from '../workspace/types';
import type { Run } from '../data/types';
import { DroneGlyph } from './DroneIcon';

/**
 * Preview a field's actual line style, color, model, and combined spatial representation.
 * @param props Field settings, optional attached metadata, and the active visualization type.
 * @returns Decorative SVG for the appearance button; its accessible name belongs to the enclosing button.
 */
export function AppearanceIcon({ binding, field, tab }: { binding: Binding; field?: Field; tab: ViewTab }) {
  const spatial = tab.type === 'trajectory';
  const layers = field ? spatialLayers(binding, field) : { trajectory: true, pose: false };
  const line = tab.type === 'graph' || (spatial && layers.trajectory);
  const model = binding.lane === 'vehicle' || (spatial && layers.pose);
  const combined = line && model;
  const center = combined ? 9 : 13;
  const dash = binding.style === 'dashed' ? '6 4' : binding.style === 'dotted' ? '1 4' : undefined;
  const weight = Math.max(0.5, Math.min(3, tab.type === 'graph' ? binding.width / 2 : binding.width));

  return (
    <svg viewBox="0 0 36 26" aria-hidden="true" focusable="false" fill="none" stroke={binding.color}>
      {line && (
        <>
          {field?.kind === 'event' ? (
            [7, 18, 29].map((x) => <circle key={x} cx={x} cy={13} r={2} fill={binding.color} />)
          ) : (
            <path
              data-appearance="line"
              d={combined ? 'M2 22 H34' : field?.kind === 'held' ? 'M2 19 H18 V7 H34' : 'M2 13 H34'}
              strokeWidth={weight}
              strokeDasharray={dash}
              strokeLinecap={binding.style === 'dotted' ? 'round' : 'butt'}
            />
          )}
          {binding.markers && <circle cx={18} cy={combined ? 22 : 13} r={2} fill={binding.color} />}
        </>
      )}
      {model &&
        (binding.model === 'ball' ? (
          <g data-appearance="ball">
            <circle cx={18} cy={center} r={combined ? 5 : 7} fill={binding.color} />
            <circle cx={16} cy={center - 2} r={1.5} fill="#ffffff" stroke="none" opacity={0.55} />
          </g>
        ) : (
          <g
            data-appearance={binding.model}
            transform={`translate(18 ${center}) scale(${combined ? 0.75 : 1})`}
            opacity={binding.model === 'ghost' ? 0.55 : 1}
            strokeDasharray={binding.model === 'ghost' ? '2 2' : undefined}
            strokeWidth={1.5}
          >
            <DroneGlyph color={binding.color} />
          </g>
        ))}
      {!line && !model && <path data-appearance="vector" d="M5 21 L30 6 M20 6 H30 V16" strokeWidth={2} />}
    </svg>
  );
}

/**
 * Draw the field's current visibility state without relying on text or color alone.
 * @param props Whether the field is currently enabled in the visualization.
 * @returns Decorative eye, crossed out when hidden; the button supplies its action and pressed state.
 */
export function VisibilityIcon({ visible }: { visible: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path d="M2 12 S6 5 12 5 S22 12 22 12 S18 19 12 19 S2 12 2 12Z" />
      <circle cx={12} cy={12} r={3} />
      {!visible && <path data-appearance="hidden" d="M3 3 L21 21" strokeWidth={2} />}
    </svg>
  );
}

/**
 * Configure one binding without adding permanent control rows to the dock.
 *
 * @param props Typed field, binding, active tab, available orientation/anchor sources, and mutation callback.
 * @returns Compatible appearance and display controls; changes reuse existing prepared source data.
 */
export function AppearanceControls({
  binding,
  field,
  tab,
  fields,
  runs,
  onPatch,
}: {
  binding: Binding;
  field?: Field;
  tab: ViewTab;
  fields: Field[];
  runs: Run[];
  onPatch: (id: string, patch: Partial<Binding>) => void;
}) {
  const spatial = tab.type === 'trajectory';
  const layers = field ? spatialLayers(binding, field) : { trajectory: false, pose: false };
  const isLine = tab.type === 'graph' || (spatial && layers.trajectory);
  const isPose = binding.lane === 'vehicle' || (spatial && layers.pose);
  const vector =
    tab.type !== 'graph' && (field?.type === 'velocity' || (binding.lane === 'overlays' && field?.type === 'scalar'));
  const orientations = fields.filter((candidate) => candidate.type === 'orientation');

  return (
    <div className="appearance-controls">
      <div className="color-presets" role="group" aria-label={`Color ${binding.label}`}>
        {colorPresets.map((preset) => (
          <button
            key={preset.color}
            className="color-swatch"
            title={preset.name}
            aria-label={`${preset.name} color for ${binding.label}`}
            aria-pressed={binding.color.toLowerCase() === preset.color}
            style={{ background: preset.color }}
            onClick={() => onPatch(binding.id, { color: preset.color })}
          />
        ))}
      </div>
      {isLine && (
        <>
          <label>
            Line
            <select
              aria-label={`Line style ${binding.label}`}
              value={binding.style}
              onChange={(event) => onPatch(binding.id, { style: event.target.value as Binding['style'] })}
            >
              <option value="solid">Solid</option>
              <option value="dashed">Dashed</option>
              <option value="dotted">Dotted</option>
            </select>
          </label>
          <label>
            {tab.type === 'graph' ? 'Weight' : 'Width'}
            <input
              aria-label={`Line ${tab.type === 'graph' ? 'weight' : 'width'} ${binding.label}`}
              type="number"
              min={1}
              max={8}
              step={0.5}
              value={binding.width}
              onChange={(event) => onPatch(binding.id, { width: Math.max(1, Math.min(8, Number(event.target.value))) })}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={field?.type === 'plan' || tab.type === 'graph' ? binding.markers : binding.fullPath}
              onChange={(event) =>
                onPatch(
                  binding.id,
                  field?.type === 'plan' || tab.type === 'graph'
                    ? { markers: event.target.checked }
                    : { fullPath: event.target.checked },
                )
              }
            />
            {tab.type === 'graph' ? 'Points' : field?.type === 'plan' ? 'Waypoints' : 'Full path'}
          </label>
        </>
      )}
      {isPose && (
        <>
          <label>
            Model
            <select
              aria-label={`Model ${binding.label}`}
              value={binding.model}
              onChange={(event) => onPatch(binding.id, { model: event.target.value as Binding['model'] })}
            >
              <option value="drone">Drone</option>
              <option value="ghost">Ghost drone</option>
              <option value="ball">Ball</option>
            </select>
          </label>
          <label>
            Scale
            <input
              aria-label={`Model scale ${binding.label}`}
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={binding.scale}
              onChange={(event) =>
                onPatch(binding.id, { scale: Math.max(0.1, Math.min(10, Number(event.target.value))) })
              }
            />
          </label>
          <label>
            Orientation
            <select
              aria-label={`Orientation ${binding.label}`}
              value={
                binding.orientation?.fieldId === 'none'
                  ? 'none'
                  : binding.orientation
                    ? `${binding.orientation.runId}|${binding.orientation.fieldId}`
                    : 'auto'
              }
              onChange={(event) => {
                const value = event.target.value;
                if (value === 'auto') onPatch(binding.id, { orientation: undefined });
                else if (value === 'none')
                  onPatch(binding.id, { orientation: { runId: binding.runId, fieldId: 'none' } });
                else {
                  const [runId, fieldId] = value.split('|');
                  onPatch(binding.id, { orientation: { runId, fieldId } });
                }
              }}
            >
              <option value="auto">
                {field?.orientation || field?.type === 'orientation' ? 'Native attitude' : 'No native attitude'}
              </option>
              <option value="none">No attitude</option>
              {orientations.map((candidate) => (
                <option key={`${candidate.runId}:${candidate.id}`} value={`${candidate.runId}|${candidate.id}`}>
                  {candidate.label} · {runs.find((item) => item.id === candidate.runId)?.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {tab.type === 'graph' && (
        <label>
          Axis
          <select
            aria-label={`Axis ${binding.label}`}
            value={binding.lane}
            onChange={(event) => onPatch(binding.id, { lane: event.target.value as Binding['lane'] })}
          >
            <option value="left">Left Y</option>
            <option value="right">Right Y</option>
          </select>
        </label>
      )}
      {spatial && ['velocity', 'orientation'].includes(field?.type ?? '') && (
        <label>
          Attach
          <select
            aria-label={`Attach ${binding.label}`}
            value={binding.attachTo ?? ''}
            onChange={(event) => onPatch(binding.id, { attachTo: event.target.value || undefined })}
          >
            <option value="">World origin</option>
            {tab.bindings
              .filter(
                (item) =>
                  item.id !== binding.id &&
                  ['pose', 'position'].includes(findField(fields, item.runId, item.fieldId)?.type ?? ''),
              )
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
          </select>
        </label>
      )}
      {vector && (
        <>
          <label>
            Scale
            <input
              aria-label={`Vector scale ${binding.label}`}
              type="number"
              step={0.1}
              min={0.01}
              max={100}
              value={binding.scale}
              onChange={(event) =>
                onPatch(binding.id, { scale: Math.max(0.01, Math.min(100, Number(event.target.value))) })
              }
            />
          </label>
          <label>
            Frame
            <select
              aria-label={`Frame ${binding.label}`}
              value={binding.frame}
              onChange={(event) => onPatch(binding.id, { frame: event.target.value as Binding['frame'] })}
            >
              <option value="ENU">World ENU</option>
              <option value="FLU">Body FLU</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={binding.componentArrows}
              onChange={(event) => onPatch(binding.id, { componentArrows: event.target.checked })}
            />
            Components
          </label>
        </>
      )}
      {binding.lane === 'overlays' && ['motors', 'rotors', 'thrust', 'orientation'].includes(field?.type ?? '') && (
        <label>
          Display scale
          <input
            aria-label={`Overlay scale ${binding.label}`}
            type="number"
            min={0.01}
            max={100}
            step={0.1}
            value={binding.scale}
            onChange={(event) =>
              onPatch(binding.id, { scale: Math.max(0.01, Math.min(100, Number(event.target.value))) })
            }
          />
        </label>
      )}
      {field && field.kind !== 'continuous' && (
        <span className="kind-label">{field.kind === 'held' ? 'Held / step' : 'Event markers'}</span>
      )}
    </div>
  );
}
