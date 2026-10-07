import type { Run } from '../data/types';
import { attitude, sample, vector } from '../playback/time';
import { toRpy } from '../math/rotation';
import type { Field, FieldType, Lane, ViewTab } from './types';

/** Canonical diagnostic families; raw source channels retain their original hierarchy. */
const diagnosticGroups: [RegExp, string][] = [
  [/^(speed|groundSpeed)$/, 'Motion / Speed'],
  [/^distance$/, 'Motion / Distance'],
  [/^tilt$/, 'Motion / Attitude'],
  [/^tracking\./, 'Tracking / Position error'],
  [/^velocityError\./, 'Tracking / Velocity error'],
  [/^headingError$/, 'Tracking / Heading error'],
  [/^(alongTrack|crossTrack)$/, 'Tracking / Path frame'],
  [/^pathDistance($|\.)/, 'Tracking / Recorded path distance'],
  [/^navigation\.error$/, 'Tracking / Guidance feedback'],
  [/^estimation\./, 'Estimation / Position error'],
  [/^velocityEstimation\./, 'Estimation / Velocity error'],
  [/^attitudeError$/, 'Estimation / Attitude error'],
  [/^(sigma\.[0-2]|uncertainty\.(lower|upper)\.[0-2])$/, 'Uncertainty / Position'],
  [/^(sigma\.[3-5]|uncertainty\.(lower|upper)\.[3-5])$/, 'Uncertainty / Velocity'],
  [/^nees$/, 'Consistency / NEES'],
  [/^nis\./, 'Consistency / Innovation (NIS)'],
];

/**
 * Classify a diagnostic by its meaning rather than its position in the signal registry.
 * @param id Canonical scalar signal identity.
 * @returns Nested browser path, with unknown diagnostics retained under Other.
 */
function diagnosticGroup(id: string): string {
  const family = diagnosticGroups.find(([pattern]) => pattern.test(id));

  return `Derived diagnostics / ${family?.[1] ?? 'Other'}`;
}

/**
 * Build scalar and known aggregate descriptors without copying telemetry arrays.
 * @param runs Imported runs whose canonical groups and original channels should be exposed.
 * @returns A catalog with stable run-qualified identities; arbitrary raw names are never guessed into vectors.
 */
export function buildCatalog(runs: Run[]): Field[] {
  const fields: Field[] = [];

  for (const run of runs) {
    /**
     * Append one field descriptor if all of its source channels exist.
     * @param id Canonical field ID within the source run.
     * @param label Browser label.
     * @param group Browser dropdown path.
     * @param type Compatibility category.
     * @param signals Scalar source IDs in component order.
     * @param prefix Optional vector or quaternion sampling prefix.
     * @param orientation Optional pose attitude prefix.
     * @returns Nothing; appends metadata referencing the existing run.
     */
    const add = (
      id: string,
      label: string,
      group: string,
      type: FieldType,
      signals: string[],
      prefix?: string,
      orientation?: string,
    ) => {
      if (!signals.length || !signals.every((key) => run.signals[key])) return;

      const first = run.signals[signals[0]];
      fields.push({
        id,
        runId: run.id,
        label,
        group,
        type,
        signals,
        prefix,
        orientation,
        unit: first.unit,
        frame: first.frame,
        kind: first.kind,
        search: [
          label,
          group,
          run.name,
          ...signals,
          ...signals.flatMap((key) => run.signals[key].source),
          first.unit,
          first.frame,
        ]
          .join(' ')
          .toLowerCase(),
      });
    };

    for (const [prefix, label, group, type] of [
      ['position', 'Position ENU', 'Truth / Position', 'position'],
      ['velocity', 'Velocity ENU', 'Truth / Velocity', 'velocity'],
      ['acceleration', 'Acceleration ENU', 'Truth / Acceleration', 'velocity'],
      ['reference.position', 'Reference position', 'Reference / Position', 'position'],
      ['reference.velocity', 'Reference velocity', 'Reference / Velocity', 'velocity'],
      ['estimate.position', 'Estimated position', 'Estimator / Position', 'position'],
      ['estimate.velocity', 'Estimated velocity', 'Estimator / Velocity', 'velocity'],
    ] as const) {
      add(
        `vector:${prefix}`,
        label,
        group,
        type,
        [0, 1, 2].map((axis) => `${prefix}.${axis}`),
        prefix,
      );
    }

    for (const [prefix, label, group] of [
      ['q', 'Truth orientation', 'Truth / Orientation'],
      ['estimate.q', 'Estimated orientation', 'Estimator / Orientation'],
    ]) {
      add(
        `orientation:${prefix}`,
        label,
        group,
        'orientation',
        [0, 1, 2, 3].map((axis) => `${prefix}.${axis}`),
        prefix,
      );
    }

    for (const [prefix, orientation, label, group] of [
      ['position', 'q', 'Truth vehicle pose', 'Truth / Orientation'],
      ['estimate.position', 'estimate.q', 'Estimated vehicle pose', 'Estimator / Orientation'],
      ['reference.position', '', 'Reference position marker', 'Reference / Position'],
    ]) {
      const hasOrientation = [0, 1, 2, 3].every((axis) => run.signals[`${orientation}.${axis}`]);
      add(
        `pose:${prefix}`,
        label,
        group,
        'pose',
        [0, 1, 2].map((axis) => `${prefix}.${axis}`),
        prefix,
        hasOrientation ? orientation : undefined,
      );
    }

    add(
      'motors',
      'Motor effort commands',
      'Actuation / Motor commands',
      'motors',
      [0, 1, 2, 3].map((axis) => `motor.${axis}`),
    );
    add(
      'rotors',
      'Actual rotor speeds',
      'Actuation / Rotor speed',
      'rotors',
      [0, 1, 2, 3].map((axis) => `rotor.${axis}`),
    );
    add('thrust', 'Collective thrust command', 'Actuation / Thrust', 'thrust', ['thrust']);

    if (run.manifest?.mission?.trajectory?.length || run.manifest?.mission?.waypoints?.length) {
      fields.push({
        id: 'mission:plan',
        runId: run.id,
        label: 'Intended mission path',
        group: 'Reference / Mission',
        type: 'plan',
        signals: [],
        unit: 'm',
        frame: 'ENU',
        kind: 'continuous',
        search: `intended mission path ${run.name}`.toLowerCase(),
      });
    }

    // Errors are ENU component vectors, but must never be interpreted as vehicle positions or attitudes.
    for (const [prefix, label] of [
      ['tracking', 'Position tracking error ENU'],
      ['velocityError', 'Velocity tracking error ENU'],
      ['estimation', 'Position estimation error ENU'],
      ['velocityEstimation', 'Velocity estimation error ENU'],
    ]) {
      add(
        `vector:${prefix}`,
        label,
        diagnosticGroup(`${prefix}.0`),
        'vector',
        [0, 1, 2].map((axis) => `${prefix}.${axis}`),
      );
    }

    // The six-state covariance uses position followed by velocity. Keep those units in separate ENU vectors.
    for (const [quantity, offset] of [
      ['position', 0],
      ['velocity', 3],
    ] as const) {
      const group = `Derived diagnostics / Uncertainty / ${quantity === 'position' ? 'Position' : 'Velocity'}`;
      add(
        `vector:sigma.${quantity}`,
        `${quantity === 'position' ? 'Position' : 'Velocity'} standard deviation ENU`,
        group,
        'vector',
        [0, 1, 2].map((axis) => `sigma.${offset + axis}`),
      );

      for (const bound of ['lower', 'upper']) {
        add(
          `vector:uncertainty.${bound}.${quantity}`,
          `95% ${quantity} error ${bound} bound ENU`,
          group,
          'vector',
          [0, 1, 2].map((axis) => `uncertainty.${bound}.${offset + axis}`),
        );
      }
    }

    const rawIds = new Set(run.raw);

    for (const signal of Object.values(run.signals)) {
      const isRaw = rawIds.has(signal.id);
      const id = signal.id;
      let group = isRaw ? 'All source channels' : diagnosticGroup(id);

      if (isRaw) group = 'All source channels';
      else if (id.startsWith('position.')) group = 'Truth / Position';
      else if (id.startsWith('velocity.')) group = 'Truth / Velocity';
      else if (id.startsWith('rpy.') || id.startsWith('q.')) group = 'Truth / Orientation';
      else if (id.startsWith('reference.')) group = 'Reference / Other';
      else if (id.startsWith('estimate.')) group = 'Estimator / Diagnostics';
      else if (id.startsWith('motor.') || id.startsWith('rotor.') || id === 'thrust') group = 'Actuation / Channels';
      else if (id.startsWith('acceleration.') || id.startsWith('bodyRate.')) group = 'Truth / Dynamics';
      else if (['armed', 'phase', 'flightMode'].includes(id)) group = 'Health';

      // Bound indices 0–5 encode two ENU vectors. Use physical component names when displayed individually.
      const bound = isRaw ? null : /^uncertainty\.(lower|upper)\.([0-5])$/.exec(id);
      let label = signal.label;

      if (bound) {
        const axis = Number(bound[2]);
        const direction = ['East', 'North', 'Up'][axis % 3];
        const quantity = axis < 3 ? 'position' : 'velocity';
        label = `${direction} ${quantity} error · 95% ${bound[1]} bound`;
      }

      add(id, label, group, 'scalar', [id]);
    }
  }

  return fields;
}

/**
 * Resolve a run-qualified catalog reference.
 * @param fields Current descriptors.
 * @param runId Imported source identity.
 * @param fieldId Canonical field identity.
 * @returns Matching descriptor, or undefined when a workspace source has not been reattached.
 */
export function findField(fields: Field[], runId: string, fieldId: string): Field | undefined {
  return fields.find((field) => field.runId === runId && field.id === fieldId);
}

/**
 * Determine whether a field can be dropped into a particular view lane.
 * @param field Source descriptor.
 * @param type Active view type.
 * @param lane Destination region.
 * @returns An empty string when supported, otherwise a concise explanation for the rejected drop.
 */
export function incompatibility(field: Field, type: ViewTab['type'], lane: Lane): string {
  if (type === 'graph') {
    return field.type === 'plan' ? 'This mission geometry has no exported time axis.' : '';
  }

  if (type === 'trajectory') {
    if (lane === 'spatial') {
      return ['position', 'pose', 'plan', 'orientation', 'velocity'].includes(field.type)
        ? ''
        : 'Choose a pose, position vector, mission path, orientation, or velocity vector.';
    }
    if (lane === 'paths' && ['position', 'pose', 'plan'].includes(field.type)) return '';
    if (lane === 'poses' && ['position', 'pose', 'orientation', 'velocity'].includes(field.type)) return '';
    return lane === 'paths'
      ? 'A trajectory requires an ENU position vector or mission path.'
      : 'A pose requires position or orientation; velocity attaches to a pose.';
  }

  if (lane === 'vehicle') {
    return ['pose', 'orientation', 'position'].includes(field.type) ? '' : 'Choose a vehicle pose or orientation.';
  }

  if (['velocity', 'orientation', 'motors', 'rotors', 'thrust'].includes(field.type)) return '';
  return field.type === 'scalar' && /^(motor\.|rotor\.|thrust$|rpy\.|bodyRate\.|velocity\.)/.test(field.id)
    ? ''
    : 'This overlay requires orientation, velocity, motor effort, rotor speed, or thrust.';
}

/**
 * Format catalog values at the same effective time used by the renderer.
 * @param field Scalar or aggregate descriptor.
 * @param run Its imported source, if attached.
 * @param time Original simulation seconds.
 * @param degrees Display angles in degrees when true.
 * @param precision Decimal places for compact browser rows; configuration readouts default to three.
 * @param trimZeros Remove trailing fractional zeros, treating precision as a maximum rather than a fixed width.
 * @returns Compact values with units, or an em dash outside coverage/validity.
 */
export function fieldValue(
  field: Field,
  run: Run | undefined,
  time: number,
  degrees = true,
  precision = 3,
  trimZeros = false,
): string {
  if (!run || !Number.isFinite(time)) return '—';
  if (field.type === 'plan')
    return `${run.manifest?.mission?.trajectory?.length || run.manifest?.mission?.waypoints?.length || 0} points`;

  let values: number[];
  let unit = field.unit;

  if (field.type === 'orientation' && field.prefix) {
    values = toRpy(attitude(run, field.prefix, time));
    unit = degrees ? '°' : 'rad';
    if (degrees) values = values.map((value) => (value * 180) / Math.PI);
  } else if (field.prefix && ['pose', 'position', 'velocity'].includes(field.type)) {
    values = vector(run, field.prefix, time);
  } else {
    values = field.signals.map((id) => sample(run, id, time));
    if (degrees && unit === 'rad') {
      values = values.map((value) => (value * 180) / Math.PI);
      unit = '°';
    }
  }

  if (values.some((value) => !Number.isFinite(value))) return '—';
  const formatted = values.map((value) => {
    const text = value.toFixed(precision);
    return trimZeros ? text.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1') : text;
  });

  return `${values.length > 1 ? '[' : ''}${formatted.join(', ')}${values.length > 1 ? ']' : ''}${unit ? ` ${unit}` : ''}`;
}
