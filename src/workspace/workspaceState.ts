import type { Run } from '../data/types';
import type { Binding, Field, Lane, ViewTab, ViewType, WorkspaceDocument } from './types';
import { findField, incompatibility } from './fieldCatalog';

export const workspaceStorageKey = 'rdd2.workspace.v1';
export const colorPresets = [
  { name: 'Cyan', color: '#74dde3' },
  { name: 'Amber', color: '#f2b36f' },
  { name: 'Blue', color: '#6dacf8' },
  { name: 'Violet', color: '#b7a1f2' },
  { name: 'Rose', color: '#e88f9b' },
  { name: 'Silver', color: '#c6d3e1' },
];

/**
 * Create an independently configurable empty view.
 * @param type Visualization category.
 * @param name Initial tab label.
 * @returns A new tab with stable identity and fresh settings objects.
 */
export function createTab(type: ViewType, name: string): ViewTab {
  return {
    id: crypto.randomUUID(),
    name,
    type,
    bindings: [],
    camera: 'orbit',
    followOrientation: false,
    bodyAxes: true,
    worldAxes: false,
    angles: 'degrees',
    leftAxis: { auto: true, min: -1, max: 1, zero: false },
    rightAxis: { auto: true, min: -1, max: 1, zero: false },
  };
}

/**
 * Produce one binding referencing a catalog field without copying its data.
 * @param field Source descriptor.
 * @param lane Destination region.
 * @param index Palette position within this tab.
 * @returns Independent presentation settings suitable for the field's type.
 */
export function createBinding(field: Field, lane: Lane, index: number): Binding {
  return {
    id: crypto.randomUUID(),
    runId: field.runId,
    fieldId: field.id,
    label: field.label,
    lane,
    display:
      lane === 'spatial'
        ? field.type === 'pose'
          ? 'both'
          : ['position', 'plan'].includes(field.type)
            ? 'trajectory'
            : 'pose'
        : undefined,
    color: colorPresets[index % colorPresets.length].color,
    style: field.id.includes('reference') ? 'dashed' : 'solid',
    width: 1.5,
    model: field.orientation || field.type === 'orientation' ? 'drone' : 'ball',
    scale: 1,
    visible: true,
    fullPath: true,
    markers: false,
    componentArrows: false,
    frame: 'ENU',
  };
}

/**
 * Enforce view/lane and graph unit compatibility before mutating a tab.
 * @param tab Destination tab.
 * @param field Proposed source field.
 * @param lane Destination lane.
 * @param fields Current catalog used to inspect existing axis units.
 * @returns Empty string if accepted, otherwise an actionable reason; tab configuration is unchanged.
 */
export function dropReason(tab: ViewTab, field: Field, lane: Lane, fields: Field[]): string {
  const reason = incompatibility(field, tab.type, lane);

  if (reason) return reason;
  if (tab.type !== 'graph') return '';

  const existing = tab.bindings
    .filter((binding) => binding.lane === lane)
    .map((binding) => findField(fields, binding.runId, binding.fieldId))
    .filter((item): item is Field => !!item);
  const targetUnit = existing[0] ? graphUnit(existing[0]) : graphUnit(field);
  const unit = graphUnit(field);

  return unitFamily(targetUnit) === unitFamily(unit)
    ? ''
    : `This axis uses ${targetUnit || 'dimensionless values'}; ${unit || 'dimensionless values'} needs the other axis or another graph.`;
}

/**
 * Choose the canonical graph unit for an aggregate.
 * @param field Catalog field.
 * @returns Unit used after expanding the field into scalar plot channels.
 */
export function graphUnit(field: Field): string {
  return field.type === 'orientation' ? 'rad' : field.unit;
}

/**
 * Group explicitly convertible units without normalizing unrelated quantities.
 * @param unit Source unit.
 * @returns Stable family key; empty and '1' represent dimensionless channels.
 */
export function unitFamily(unit: string): string {
  if (!unit || unit === '1' || unit === 'boolean') return 'dimensionless';
  if (unit === 'rad' || unit === '°') return 'angle';
  return unit;
}

/**
 * Build useful initial views for a source run while leaving subsequently created tabs empty.
 * @param run Initial attached run, or undefined for an empty startup workspace.
 * @param fields Its catalog and any other loaded source descriptors.
 * @returns Trajectory, one dual-axis graph, and a centered vehicle view populated only with available fields.
 */
export function initialTabs(run: Run | undefined, fields: Field[]): ViewTab[] {
  const trajectory = createTab('trajectory', 'Trajectory 1');
  const graph = createTab('graph', 'Graph 1');
  const vehicle = createTab('vehicle', 'Vehicle 1');

  for (const [tab, id, lane] of [
    [trajectory, 'pose:position', 'spatial'],
    [trajectory, 'vector:reference.position', 'spatial'],
    [trajectory, 'mission:plan', 'spatial'],
    [graph, 'position.0', 'left'],
    [graph, 'reference.position.0', 'left'],
    [graph, 'velocity.0', 'right'],
    [vehicle, 'pose:position', 'vehicle'],
    [vehicle, 'vector:velocity', 'overlays'],
    [vehicle, 'motors', 'overlays'],
  ] as [ViewTab, string, Lane][]) {
    const field = run ? findField(fields, run.id, id) : undefined;

    if (field) tab.bindings.push(createBinding(field, lane, tab.bindings.length));
  }

  return [trajectory, graph, vehicle];
}

/**
 * Derive a reattachment identity without claiming simulator provenance for plain CSVs.
 * @param run Imported source run.
 * @returns Content hash for imported files, or an empty string when provenance has no content digest.
 */
export function fingerprint(run: Run): string {
  return run.csvHash ?? run.manifest?.csv_sha256 ?? '';
}

/**
 * Validate a persisted workspace before restoring UI controls or source references.
 * @param value Parsed JSON from local storage or a user-supplied workspace file.
 * @returns Typed versioned configuration; source arrays are deliberately absent.
 * @throws Error if settings, identities, or numeric bounds are malformed.
 */
export function validateWorkspace(value: unknown): WorkspaceDocument {
  const document = structuredClone(value) as WorkspaceDocument;

  if (
    !document ||
    document.schema !== 'rdd2-workspace-v1' ||
    !Array.isArray(document.tabs) ||
    !Array.isArray(document.runs)
  ) {
    throw new Error('Expected an rdd2-workspace-v1 workspace.');
  }

  /**
   * Validate numeric workspace settings.
   *
   * @param values Numeric settings to inspect.
   * @returns True only when every setting is a finite number.
   */
  const finite = (values: number[]) => values.every(Number.isFinite);
  /**
   * Validate serialized identities and labels.
   *
   * @param values Potential identity or label values to inspect.
   * @returns True only when every value is a string.
   */
  const strings = (values: unknown[]) => values.every((item) => typeof item === 'string');

  if (
    !strings([document.active, document.alignment]) ||
    !['absolute', 'armed', 'mission'].includes(document.alignment) ||
    !Array.isArray(document.window) ||
    document.window.length !== 2 ||
    !finite([...document.window, document.time, document.browserWidth, document.dockHeight]) ||
    document.window[1] <= document.window[0] ||
    document.browserWidth < 180 ||
    document.browserWidth > 600 ||
    document.dockHeight < 120 ||
    document.dockHeight > 600
  )
    throw new Error('Invalid workspace clock or layout.');

  const tabIds = new Set<string>();
  const bindingIds = new Set<string>();

  for (const tab of document.tabs) {
    if (
      !strings([tab.id, tab.name]) ||
      tabIds.has(tab.id) ||
      !['trajectory', 'graph', 'vehicle'].includes(tab.type) ||
      !Array.isArray(tab.bindings) ||
      !['orbit', 'top', 'side', 'follow'].includes(tab.camera) ||
      (tab.camera === 'follow' && (tab.type !== 'trajectory' || !tab.followPose)) ||
      (tab.followPose !== undefined &&
        (typeof tab.followPose !== 'string' || !tab.bindings.some((binding) => binding.id === tab.followPose))) ||
      !['degrees', 'radians'].includes(tab.angles) ||
      [tab.followOrientation, tab.bodyAxes, tab.worldAxes].some((item) => typeof item !== 'boolean')
    )
      throw new Error('Invalid workspace tab.');
    tabIds.add(tab.id);

    for (const axis of [tab.leftAxis, tab.rightAxis]) {
      if (
        !axis ||
        !finite([axis.min, axis.max]) ||
        axis.max <= axis.min ||
        typeof axis.auto !== 'boolean' ||
        typeof axis.zero !== 'boolean'
      )
        throw new Error('Invalid graph axis settings.');
    }

    for (const binding of tab.bindings) {
      const lanes =
        tab.type === 'graph'
          ? ['left', 'right']
          : tab.type === 'trajectory'
            ? ['spatial', 'paths', 'poses']
            : ['vehicle', 'overlays'];

      if (
        !strings([binding.id, binding.runId, binding.fieldId, binding.label]) ||
        bindingIds.has(binding.id) ||
        !lanes.includes(binding.lane) ||
        (binding.display !== undefined && !['trajectory', 'pose', 'both'].includes(binding.display)) ||
        !/^#[0-9a-f]{6}$/i.test(binding.color) ||
        !['solid', 'dashed', 'dotted'].includes(binding.style) ||
        !['drone', 'ghost', 'ball'].includes(binding.model) ||
        !['ENU', 'FLU'].includes(binding.frame) ||
        !finite([binding.width, binding.scale]) ||
        binding.width < 1 ||
        binding.width > 8 ||
        binding.scale <= 0 ||
        binding.scale > 100 ||
        [binding.visible, binding.fullPath, binding.markers, binding.componentArrows].some(
          (item) => typeof item !== 'boolean',
        ) ||
        (binding.attachTo !== undefined && typeof binding.attachTo !== 'string') ||
        (binding.orientation && !strings([binding.orientation.runId, binding.orientation.fieldId]))
      )
        throw new Error('Invalid field binding.');
      bindingIds.add(binding.id);
    }
  }

  if (document.tabs.length && !tabIds.has(document.active)) throw new Error('Active workspace tab does not exist.');

  const runIds = new Set<string>();

  for (const run of document.runs) {
    if (
      !strings([run.id, run.name, run.fingerprint]) ||
      !run.fingerprint ||
      runIds.has(run.id) ||
      !finite([run.rows, run.start, run.end]) ||
      run.rows < 1 ||
      run.end < run.start
    )
      throw new Error('Invalid workspace source identity.');
    runIds.add(run.id);
  }

  // Older workspaces may still reference the retired built-in demo. Keep real trace references and view settings.
  const retired = new Set(
    document.runs.filter((run) => run.fingerprint === 'builtin:analytic-v1').map((run) => run.id),
  );
  if (retired.size) {
    document.runs = document.runs.filter((run) => !retired.has(run.id));
    document.tabs = document.tabs.map((tab) => ({
      ...tab,
      bindings: tab.bindings
        .filter((binding) => !retired.has(binding.runId))
        .map((binding) => ({
          ...binding,
          orientation: binding.orientation && retired.has(binding.orientation.runId) ? undefined : binding.orientation,
        })),
    }));
    for (const tab of document.tabs) {
      if (tab.followPose && !tab.bindings.some((binding) => binding.id === tab.followPose)) {
        tab.followPose = undefined;
        if (tab.camera === 'follow') tab.camera = 'orbit';
      }
    }
    if (!document.runs.length) {
      document.time = 0;
      document.window = [0, 1];
    }
  }
  return document;
}

/**
 * Reattach persisted source references only when their content fingerprints match a loaded file.
 * @param document Saved workspace, including sources still awaiting reattachment.
 * @param runs Currently loaded runs.
 * @returns Tab copies with matched run IDs remapped; unresolved bindings retain their saved identities.
 */
export function reattachTabs(document: WorkspaceDocument, runs: Run[]): ViewTab[] {
  const mapping = new Map(
    document.runs.map((source) => [
      source.id,
      runs.find((run) => fingerprint(run) === source.fingerprint)?.id ?? source.id,
    ]),
  );

  return document.tabs.map((tab) => ({
    ...tab,
    bindings: tab.bindings.map((binding) => ({
      ...binding,
      runId: mapping.get(binding.runId) ?? binding.runId,
      orientation: binding.orientation
        ? { ...binding.orientation, runId: mapping.get(binding.orientation.runId) ?? binding.orientation.runId }
        : undefined,
    })),
  }));
}
