import type { Columns, Kind, Manifest, Quat, Run, Signal, Vec3 } from './types';
import { coincident, eventIndex } from '../playback/time';
import {
  angleError,
  clamp,
  fromMatrix,
  fromRpy,
  normalize,
  quadraticForm,
  toMatrix,
  toRpy,
  transposeMultiply,
  wrap,
} from '../math/rotation';
import { PathDistance } from '../math/path';

// Exported estimator messages, controller references, and sensor flags are held between updates.
const heldSignalPattern = new RegExp(
  'estimator\\.|avionics\\.|reference|motorCommand|missionPhase|flightMode|armed|' +
    'Noise|Bias|fresh|valid|Period|trajectoryTime',
);

/**
 * Resolve an exact Modelica signal name or a unique qualified suffix; reject ambiguous suffix matches.
 *
 * @param names Available source headers, including any model-instance qualification.
 * @param requested Exact header or unqualified suffix to find.
 * @returns Exact match first, otherwise the unique header ending in '.' + requested, or undefined when absent.
 * @throws Error if more than one qualified suffix matches. Names and ordering are unchanged.
 */
export function resolve(names: string[], requested: string): string | undefined {
  if (names.includes(requested)) {
    return requested;
  }

  const matches = names.filter((n) => n.endsWith('.' + requested));

  if (matches.length > 1) {
    throw new Error(`Ambiguous signal ${requested}: ${matches.join(', ')}`);
  }

  return matches[0];
}

/**
 * Validate the bundle schema, coordinate conventions, mission geometry, and signal metadata.
 *
 * @param value Parsed JSON to inspect before normalization or rendering.
 * @returns The original object typed as Manifest; fields are not copied, defaulted, or modified.
 * @throws Error for an unsupported schema/frame, malformed digest, invalid filename/type, non-finite geometry, invalid
 *   ground plane, or unsupported interpolation kind.
 * @remarks Checks the fields consumed by the viewer; this is not a full JSON-schema validator and permits extra
 *   provenance fields.
 */
export function validateManifest(value: unknown): Manifest {
  const m = value as Manifest;

  if (!m || typeof m !== 'object' || m.schema !== 'rdd2-viewer-v1') {
    throw new Error('Expected an rdd2-viewer-v1 manifest');
  }

  if (
    (m.world_frame && m.world_frame !== 'ENU') ||
    (m.body_frame && m.body_frame !== 'FLU') ||
    (m.quaternion_order && m.quaternion_order !== 'wxyz')
  ) {
    throw new Error('Unsupported frame or quaternion convention');
  }

  if (m.csv_sha256 && !/^[0-9a-f]{64}$/.test(m.csv_sha256)) {
    throw new Error('Invalid CSV SHA-256 in manifest');
  }

  for (const key of ['trajectory', 'waypoints', 'rotor_positions'] as const) {
    if (
      m.mission?.[key] &&
      (!Array.isArray(m.mission[key]) ||
        !m.mission[key]!.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite)))
    ) {
      throw new Error(`Invalid mission ${key}`);
    }
  }

  if (m.name !== undefined && typeof m.name !== 'string') {
    throw new Error('Manifest name must be a string');
  }

  if (m.csv !== undefined && (typeof m.csv !== 'string' || m.csv.includes('/') || m.csv.includes('\\'))) {
    throw new Error('Manifest csv must be a filename, not a path');
  }

  if (m.model !== undefined && typeof m.model !== 'string') {
    throw new Error('Manifest model must be a string');
  }

  if (m.mission?.ground) {
    const { normal, offset } = m.mission.ground;

    if (
      !Array.isArray(normal) ||
      normal.length !== 3 ||
      !normal.every(Number.isFinite) ||
      Math.abs(Math.hypot(...normal) - 1) > 1e-6 ||
      !Number.isFinite(offset)
    ) {
      throw new Error('Ground plane requires a unit ENU normal and finite offset');
    }
  }

  if (m.signals) {
    for (const [name, meta] of Object.entries(m.signals)) {
      if (!meta || typeof meta !== 'object') {
        throw new Error(`Invalid signal metadata: ${name}`);
      }

      if (meta.kind && !['continuous', 'held', 'event'].includes(meta.kind)) {
        throw new Error(`Invalid signal kind: ${name}`);
      }
    }
  }

  return m;
}

/**
 * Build a typed signal registry, event-aware playback index, and derived diagnostics from raw columns.
 *
 * @param columns Numeric source columns with equal lengths and one unambiguous time/time_s column.
 * @param name Fallback display name, normally the CSV filename.
 * @param manifest Optional metadata already checked by validateManifest; its name and signal annotations take
 *   priority.
 * @param bytes Original CSV file size in bytes, used for the import summary; defaults to zero.
 * @returns New Run retaining raw columns and adding canonical aliases, derived channels, capabilities, and warnings.
 * @throws Error for missing/empty/invalid time, inconsistent column lengths, conflicting time columns, or ambiguous
 *   names.
 * @remarks Raw and aliased arrays are shared with columns and must be treated as immutable after normalization.
 *   Derived channels allocate new arrays. Missing optional sources omit diagnostics; missing validity flags are
 *   explicitly assumed only when the corresponding vector exists. Coordinates are expected to use the supported source
 *   profile's ENU/FLU conventions; this function does not guess alternative frames or unit conversions.
 */
export function normalizeRun(columns: Columns, name: string, manifest?: Manifest, bytes = 0): Run {
  // Validate the raw timeline and column shapes before publishing any normalized signals.
  const names = Object.keys(columns);
  const timeName = resolve(names, 'time') ?? resolve(names, 'time_s');

  if (!timeName) {
    throw new Error('Missing time or time_s column');
  }

  const time = columns[timeName];
  const index = eventIndex(time);
  const sampleCount = time.length;

  if (!sampleCount) {
    throw new Error('No time samples');
  }

  for (const [key, values] of Object.entries(columns)) {
    if (values.length !== sampleCount) {
      throw new Error(`Column length mismatch: ${key}`);
    }
  }

  const alternateTime = resolve(names, timeName === 'time' ? 'time_s' : 'time');

  if (alternateTime && columns[alternateTime].some((t, i) => !coincident(t, time[i]))) {
    throw new Error('The time and time_s columns disagree');
  }

  // Estimate typical cadence from distinct event groups; raw near-equal event rows must not shrink the gap limit.
  const deltas: number[] = [];

  for (let k = 1; k < index.length; k++) {
    deltas.push(time[index[k]] - time[index[k - 1]]);
  }

  deltas.sort((a, b) => a - b);

  const medianStep = deltas[Math.floor(deltas.length / 2)] ?? 0.005;
  const run: Run = {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${name}-${Date.now()}`,
    name: manifest?.name ?? name,
    profile: names.includes('x_m')
      ? 'trajectory'
      : names.some((n) => n.endsWith('velocity_m_s[1]'))
        ? 'qualification'
        : 'selected / generic',
    time,
    index,
    signals: {},
    raw: names.filter((n) => n !== timeName && n !== 'time' && n !== 'time_s'),
    warnings: [],
    manifest,
    capabilities: [],
    gapLimit: Math.max(0.05, medianStep * 20),
    bytes,
    importMs: 0,
    eventGroups: sampleCount - index.length,
  };

  /**
   * Register a raw, aliased, or derived signal together with units, interpolation, and validity metadata.
   *
   * @param id Registry key; an existing entry with this ID is replaced.
   * @param label Display name for legends and the signal browser.
   * @param unit Display unit, or an empty string if unknown.
   * @param frame Coordinate frame hint, or an empty string if unspecified.
   * @param values Numeric values aligned with the enclosing raw timeline; retained by reference, not copied.
   * @param kind Playback interpolation policy; defaults to continuous.
   * @param source Source column or signal IDs used to obtain these values; defaults to an empty list.
   * @param derived Optional human-readable calculation or interpretation.
   * @param validity Optional signal ID that must sample above 0.5 for this signal to be valid.
   * @returns Nothing; writes one entry to the enclosing run.signals registry.
   */
  const add = (
    id: string,
    label: string,
    unit: string,
    frame: string,
    values: Float64Array,
    kind: Kind = 'continuous',
    source: string[] = [],
    derived?: string,
    validity?: string,
  ) => {
    run.signals[id] = { id, label, unit, frame, values, kind, source, derived, validity };
  };

  /**
   * Infer whether an unannotated source signal is continuously interpolated or held between samples.
   *
   * @param n Original Modelica source header.
   * @returns 'held' for known estimator/reference/command/status naming patterns, otherwise 'continuous'. Manifest
   *   annotations override this heuristic.
   */
  const rawKind = (n: string): Kind => (heldSignalPattern.test(n) ? 'held' : 'continuous');

  // Preserve every raw channel for inspection. Manifest annotations override inferred display metadata.
  names.forEach((n) => {
    if (n !== timeName) {
      const meta = manifest?.signals?.[n];

      add(
        n,
        meta?.label ?? n,
        meta?.unit ?? inferUnit(n),
        meta?.frame ?? inferFrame(n),
        columns[n],
        meta?.kind ?? rawKind(n),
        [n],
        undefined,
        meta?.validity,
      );
    }
  });

  /**
   * Bind the first available source candidate to a stable viewer signal ID without copying its values.
   *
   * @param id Canonical viewer signal key to register.
   * @param label Human-readable display name.
   * @param unit Canonical unit expected from the supported source profile; no numerical conversion is applied.
   * @param frame Canonical coordinate frame expected from the supported source profile.
   * @param candidates Source names in priority order, resolved by exact name or unique qualified suffix.
   * @param kind Playback interpolation policy; defaults to continuous.
   * @param validity Optional validity signal dependency.
   * @returns True if a candidate was registered, false if none exists; mutates the enclosing run on success.
   * @throws Error when a candidate has ambiguous qualified suffix matches.
   */
  const alias = (
    id: string,
    label: string,
    unit: string,
    frame: string,
    candidates: string[],
    kind: Kind = 'continuous',
    validity?: string,
  ) => {
    for (const requested of candidates) {
      const key = resolve(names, requested);

      if (key) {
        add(id, label, unit, frame, columns[key], kind, [key], undefined, validity);

        return true;
      }
    }

    return false;
  };
  // Translate supported Modelica column names into stable viewer IDs. Modelica arrays are one-based;
  // viewer component IDs are zero-based and ordered East, North, Up.
  const axes = ['East', 'North', 'Up'];

  for (let a = 0; a < 3; a++) {
    const i = a + 1;

    alias(`position.${a}`, `${axes[a]} position`, 'm', 'ENU', [
      `position_m[${i}]`,
      `plant.truth.positionWorldEnu_m[${i}]`,
      ['x_m', 'y_m', 'z_m'][a],
    ]);
    alias(`velocity.${a}`, `${axes[a]} velocity`, 'm/s', 'ENU', [
      `velocity_m_s[${i}]`,
      `plant.truth.velocityWorldEnu_m_s[${i}]`,
    ]);
    alias(`rpy.${a}`, ['Roll', 'Pitch', 'Yaw'][a], 'rad', 'body→ENU', [
      `euler_rad[${i}]`,
      `plant.truth.eulerRpy_rad[${i}]`,
      ['roll_rad', 'pitch_rad', 'yaw_rad'][a],
    ]);
    alias(
      `reference.position.${a}`,
      `${axes[a]} reference`,
      'm',
      'ENU',
      [`referencePositionWorldEnu_m[${i}]`, `avionics.reference.position[${i}]`],
      'held',
      'reference.valid',
    );
    alias(
      `reference.velocity.${a}`,
      `${axes[a]} reference velocity`,
      'm/s',
      'ENU',
      [`referenceVelocityWorldEnu_m_s[${i}]`, `avionics.reference.velocity[${i}]`],
      'held',
      'reference.valid',
    );
    alias(
      `estimate.position.${a}`,
      `${axes[a]} estimate`,
      'm',
      'ENU',
      [`estimator.estimate.positionWorldEnu_m[${i}]`],
      'held',
      'estimate.valid',
    );
    alias(
      `estimate.velocity.${a}`,
      `${axes[a]} estimated velocity`,
      'm/s',
      'ENU',
      [`estimator.estimate.velocityWorldEnu_m_s[${i}]`],
      'held',
      'estimate.valid',
    );
    alias(`acceleration.${a}`, `${axes[a]} acceleration`, 'm/s²', 'ENU', [
      `plant.truth.accelerationWorldEnu_m_s2[${i}]`,
    ]);
    alias(`bodyRate.${a}`, ['Body roll rate', 'Body pitch rate', 'Body yaw rate'][a], 'rad/s', 'FLU', [
      `plant.truth.angularVelocityBodyFlu_rad_s[${i}]`,
    ]);

    for (const derivative of ['acceleration', 'jerk', 'snap']) {
      alias(
        `reference.${derivative}.${a}`,
        `${axes[a]} reference ${derivative}`,
        derivative === 'acceleration' ? 'm/s²' : derivative === 'jerk' ? 'm/s³' : 'm/s⁴',
        'ENU',
        [`avionics.reference.${derivative}[${i}]`],
        'held',
        'reference.valid',
      );
    }
  }

  // Register explicit validity/status channels separately from the position and orientation data they qualify.
  alias('estimate.valid', 'Estimate valid', 'boolean', '', [`estimator.estimate.valid`], 'held');
  alias('reference.valid', 'Reference valid', 'boolean', '', ['avionics.reference.valid'], 'held');

  for (const [id, candidate, label] of [
    ['phase', 'missionPhase', 'Mission phase'],
    ['armed', 'armed', 'Armed'],
    ['flightMode', 'flightMode', 'Flight mode'],
    ['reference.clock', 'avionics.reference.trajectoryTime', 'Reference clock'],
    ['reference.segment', 'avionics.reference.activeSegment', 'Active segment'],
    ['reference.sequence', 'avionics.reference.sequence', 'Reference sequence'],
    ['navigation.error', 'navigationError_m', 'Guidance feedback navigation error'],
    ['feedback.error', 'controllerEstimatorFeedbackError_m', 'Feedback-to-estimator routing error'],
    ['thrust', 'thrust_N', 'Commanded collective thrust'],
  ]) {
    alias(
      id,
      label,
      id.includes('error') ? 'm' : id === 'thrust' ? 'N' : id.includes('clock') ? 's' : '',
      '',
      [candidate],
      'held',
    );
  }

  alias(
    'reference.yaw',
    'Reference yaw',
    'rad',
    'ENU',
    ['referenceYaw_rad', 'avionics.reference.yaw'],
    'held',
    'reference.valid',
  );

  // Expose motor command and actual rotor speed separately: they represent different physical quantities.
  for (let i = 0; i < 4; i++) {
    alias(`motor.${i}`, `Motor ${i + 1} command`, '1', '', [`motorCommand[${i + 1}]`], 'held');
    alias(`rotor.${i}`, `Rotor ${i + 1} speed`, 'rad/s', '', [`plant.motorOmega_rad_s[${i + 1}]`]);
  }

  /**
   * Check that every component of a vector or quaternion prefix is present in the signal registry.
   *
   * @param prefix Canonical prefix for numbered component IDs.
   * @param n Number of required components; defaults to three, use four for quaternions.
   * @returns Whether all IDs prefix.0 through prefix.(n-1) exist. This checks availability, not sample finiteness.
   */
  const has = (prefix: string, n = 3) =>
    Array.from({ length: n }, (_, a) => `${prefix}.${a}`).every((id) => !!run.signals[id]);

  /**
   * Return the numeric column for a signal ID, or undefined when the source was not exported.
   *
   * @param id Canonical or raw source key in the enclosing registry.
   * @returns Shared Float64Array by reference, or undefined; no allocation or interpolation occurs.
   */
  const arr = (id: string) => run.signals[id]?.values;

  /**
   * Read a vector or quaternion from one raw row, representing absent components as NaN.
   *
   * @param prefix Registry prefix for numbered components.
   * @param i Raw CSV row index, not an event-index position.
   * @param n Component count, defaulting to three.
   * @returns New component array in numbered order, with NaN for absent values. Validity flags are not evaluated here.
   */
  const values = (prefix: string, i: number, n = 3) =>
    Array.from({ length: n }, (_, a) => arr(`${prefix}.${a}`)?.[i] ?? NaN);

  /**
   * Calculate a scalar column on the raw timeline and record its sources, formula, and validity.
   *
   * @param id Canonical key for the generated channel.
   * @param label Display name for legends and signal inspection.
   * @param unit Unit of the calculated values.
   * @param frame Coordinate frame of the calculated values.
   * @param fn Scalar calculation receiving each raw row index; return NaN when unavailable.
   * @param source Input column or signal IDs to record as provenance.
   * @param formula Human-readable explanation shown during signal inspection.
   * @param kind Playback interpolation policy; defaults to continuous.
   * @param validity Optional validity dependency used during sampling.
   * @returns Nothing; allocates a full-length Float64Array and registers it on the enclosing run.
   */
  const derived = (
    id: string,
    label: string,
    unit: string,
    frame: string,
    fn: (i: number) => number,
    source: string[],
    formula: string,
    kind: Kind = 'continuous',
    validity?: string,
  ) =>
    add(
      id,
      label,
      unit,
      frame,
      Float64Array.from({ length: sampleCount }, (_, i) => fn(i)),
      kind,
      source,
      formula,
      validity,
    );

  /**
   * Supply an explicit assumption when a vector exists but its validity flag was not exported.
   *
   * @param id Validity channel key, such as reference.valid or estimate.valid.
   * @param prefix Three-component vector whose presence permits this fallback.
   * @returns Nothing; may register an all-ones held flag and append a warning to the enclosing run.
   * @remarks Existing flags are preserved. Finite-value checks elsewhere still reject unavailable samples.
   */
  const defaultValidity = (id: string, prefix: string) => {
    if (!arr(id) && has(prefix)) {
      add(
        id,
        `${prefix} assumed valid`,
        'boolean',
        '',
        new Float64Array(sampleCount).fill(1),
        'held',
        [],
        'Validity not exported; finite samples assumed valid',
      );
      run.warnings.push(`${prefix}: validity was not exported; finite samples are assumed valid.`);
    }
  };

  // Only synthesize a validity flag when its vector exists; record this assumption in both metadata and warnings.
  defaultValidity('reference.valid', 'reference.position');
  defaultValidity('estimate.valid', 'estimate.position');

  if (has('position')) {
    run.capabilities.push('position');
  } else {
    run.warnings.push('No complete truth position vector: 3D pose and path metrics unavailable.');
  }

  // Prefer native scalar-first Modelica quaternions. Reorder them for Three.js, then fall back to public
  // roll/pitch/yaw for truth or a rotation matrix for estimated attitude when the quaternion was not exported.
  for (const [prefix, source] of [
    ['q', 'plant.truth.quaternionWorldBody'],
    ['estimate.q', 'estimator.estimate.quaternionWorldBody'],
  ]) {
    const keys = [1, 2, 3, 4].map((i) => resolve(names, `${source}[${i}]`));
    let quats: Quat[] | undefined;

    if (keys.every(Boolean)) {
      quats = Array.from({ length: sampleCount }, (_, i) =>
        normalize([columns[keys[1]!][i], columns[keys[2]!][i], columns[keys[3]!][i], columns[keys[0]!][i]]),
      );
    } else if (prefix === 'q' && has('rpy')) {
      quats = Array.from({ length: sampleCount }, (_, i) => fromRpy(values('rpy', i) as Vec3));
    } else if (prefix === 'estimate.q') {
      const mkeys = [1, 2, 3].flatMap((r) =>
        [1, 2, 3].map((c) => resolve(names, `estimator.estimate.rotationWorldBody[${r},${c}]`)),
      );

      if (mkeys.every(Boolean)) {
        quats = Array.from({ length: sampleCount }, (_, i) => fromMatrix(mkeys.map((k) => columns[k!][i])));
      }
    }

    if (quats) {
      // Adjacent q and -q samples describe the same attitude. Make their signs consistent before creating
      // component channels so interpolation follows a continuous quaternion representation.
      for (let i = 1; i < sampleCount; i++) {
        if (quats[i].reduce((s, x, a) => s + x * quats![i - 1][a], 0) < 0) {
          quats[i] = quats[i].map((x) => -x) as Quat;
        }
      }

      for (let a = 0; a < 4; a++) {
        derived(
          `${prefix}.${a}`,
          `${prefix} ${'xyzw'[a]}`,
          '1',
          'FLU→ENU',
          (i) => quats![i][a],
          keys.filter(Boolean) as string[],
          'Normalized quaternion; x,y,z,w',
          prefix === 'q' ? 'continuous' : 'held',
          prefix === 'q' ? undefined : 'estimate.valid',
        );
      }

      const rpy = quats.map(toRpy);

      for (let a = 0; a < 3; a++) {
        if (prefix !== 'q' || !arr(`rpy.${a}`)) {
          derived(
            prefix === 'q' ? `rpy.${a}` : `estimate.rpy.${a}`,
            `${prefix === 'q' ? '' : 'Estimated '}${['roll', 'pitch', 'yaw'][a]}`,
            'rad',
            'body→ENU',
            (i) => rpy[i][a],
            [],
            'Quaternion to intrinsic ZYX roll/pitch/yaw',
            prefix === 'q' ? 'continuous' : 'held',
            prefix === 'q' ? undefined : 'estimate.valid',
          );
        }
      }
    }
  }

  if (has('q', 4) && has('position')) {
    run.capabilities.push('pose');
  }

  if (has('reference.position')) {
    run.capabilities.push('reference');
  }

  if (has('estimate.position')) {
    run.capabilities.push('estimate');
  }

  /**
   * Estimate a derivative on distinct event groups, masking gaps and unavailable endpoints.
   *
   * @param src Existing scalar source channel ID.
   * @param id Output derivative channel ID.
   * @param label Display label identifying this value as derived.
   * @param unit Derivative unit, such as m/s or m/s².
   * @returns Nothing; registers a centered-difference column in the enclosing run if the source exists.
   * @remarks Uses neighboring event representatives rather than epsilon-separated raw rows. Endpoints and long gaps
   *   remain NaN; each group's derivative is copied to its raw event rows. Frame is ENU.
   */
  const differentiate = (src: string, id: string, label: string, unit: string) => {
    const v = arr(src);

    if (!v) {
      return;
    }

    // Leave endpoints unavailable. Interior central differences require finite neighbors and no long gaps.
    const out = new Float64Array(sampleCount).fill(NaN);

    for (let k = 1; k < index.length - 1; k++) {
      const i = index[k];
      const a = index[k - 1];
      const b = index[k + 1];
      const dt = time[b] - time[a];

      if (
        time[i] - time[a] <= run.gapLimit &&
        time[b] - time[i] <= run.gapLimit &&
        Number.isFinite(v[a]) &&
        Number.isFinite(v[b])
      ) {
        out[i] = (v[b] - v[a]) / dt;
      }
    }

    // Carry the normalized derivative to near-coincident raw event rows.
    let k = 0;

    for (let i = 0; i < sampleCount; i++) {
      while (k < index.length - 1 && i > index[k]) {
        k++;
      }

      out[i] = out[index[k]];
    }

    add(
      id,
      label,
      unit,
      'ENU',
      out,
      'continuous',
      [src],
      'Central difference on event-normalized times; gaps/endpoints unavailable',
    );
  };

  // Keep native velocity/acceleration whenever available; numerical derivatives are a fallback only.
  for (let a = 0; a < 3; a++) {
    if (!arr(`velocity.${a}`) && has('position')) {
      differentiate(`position.${a}`, `velocity.${a}`, `${axes[a]} velocity (derived)`, 'm/s');
    }

    if (!arr(`acceleration.${a}`) && has('velocity')) {
      differentiate(`velocity.${a}`, `acceleration.${a}`, `${axes[a]} acceleration (derived)`, 'm/s²');
    }
  }

  if (has('velocity')) {
    run.capabilities.push('velocity');
    derived(
      'speed',
      'Speed',
      'm/s',
      'ENU',
      (i) => Math.hypot(...values('velocity', i)),
      ['velocity.0', 'velocity.1', 'velocity.2'],
      'norm(v)',
    );
    derived(
      'groundSpeed',
      'Ground speed',
      'm/s',
      'ENU',
      (i) => Math.hypot(...values('velocity', i, 2)),
      ['velocity.0', 'velocity.1'],
      'hypot(vE,vN)',
    );
  }

  // Tracking compares truth against the time-aligned command; estimation compares filter output against truth.
  // Keep these distinct so a guidance-feedback diagnostic is not mistaken for actual flight-path error.
  for (const [id, a, b, label, validity] of [
    ['tracking', 'position', 'reference.position', 'Tracking error', 'reference.valid'],
    ['estimation', 'estimate.position', 'position', 'Estimation error', 'estimate.valid'],
    ['velocityError', 'velocity', 'reference.velocity', 'Velocity tracking error', 'reference.valid'],
    ['velocityEstimation', 'estimate.velocity', 'velocity', 'Velocity estimation error', 'estimate.valid'],
  ]) {
    if (!has(a) || !has(b)) {
      continue;
    }

    const unit = id.startsWith('velocity') ? 'm/s' : 'm';

    for (let c = 0; c < 3; c++) {
      derived(
        `${id}.${c}`,
        `${axes[c]} ${label.toLowerCase()}`,
        unit,
        'ENU',
        (i) => (arr(validity)![i] > 0.5 ? arr(`${a}.${c}`)![i] - arr(`${b}.${c}`)![i] : NaN),
        [`${a}.${c}`, `${b}.${c}`],
        `${a} - ${b}`,
        'continuous',
        validity,
      );
    }

    derived(
      `${id}.norm`,
      label,
      unit,
      'ENU',
      (i) => Math.hypot(...values(id, i)),
      [`${id}.0`, `${id}.1`, `${id}.2`],
      'Euclidean norm',
      'continuous',
      validity,
    );
    derived(
      `${id}.horizontal`,
      `${label} · horizontal`,
      unit,
      'ENU',
      (i) => Math.hypot(...values(id, i, 2)),
      [`${id}.0`, `${id}.1`],
      'Horizontal norm',
      'continuous',
      validity,
    );
  }

  if (has('q', 4)) {
    derived(
      'tilt',
      'Tilt from vertical',
      'rad',
      'body→ENU',
      (i) => Math.acos(clamp(toMatrix(values('q', i, 4) as Quat)[8])),
      ['q.0', 'q.1', 'q.2', 'q.3'],
      'acos(R33)',
    );
  }

  if (has('q', 4) && has('estimate.q', 4)) {
    derived(
      'attitudeError',
      'Attitude estimation error',
      'rad',
      '',
      (i) => angleError(values('q', i, 4) as Quat, values('estimate.q', i, 4) as Quat),
      ['q', 'estimate.q'],
      '2 acos(abs(dot(q,q_est)))',
      'held',
      'estimate.valid',
    );
  }

  if (arr('rpy.2') && arr('reference.yaw')) {
    derived(
      'headingError',
      'Heading tracking error',
      'rad',
      '',
      (i) => wrap(arr('rpy.2')![i] - arr('reference.yaw')![i]),
      ['rpy.2', 'reference.yaw'],
      'wrapped yaw - reference yaw',
      'continuous',
      'reference.valid',
    );
  }

  // Accumulate physical distance from consecutive valid positions. Missing data breaks connectivity
  // without resetting the distance already traveled.
  if (has('position')) {
    let total = 0;
    let previous: Vec3 | undefined;
    const d = new Float64Array(sampleCount).fill(NaN);

    for (let i = 0; i < sampleCount; i++) {
      const p = values('position', i) as Vec3;

      if (!p.every(Number.isFinite)) {
        previous = undefined;
        continue;
      }

      if (previous && time[i] - time[Math.max(0, i - 1)] <= run.gapLimit) {
        total += Math.hypot(...p.map((v, a) => v - previous![a]));
      }

      d[i] = total;
      previous = p;
    }

    add(
      'distance',
      'Distance traveled',
      'm',
      'ENU',
      d,
      'continuous',
      ['position'],
      'Sum of valid consecutive truth position increments',
    );
  }

  if (has('reference.position') && has('position')) {
    const points: (Vec3 | null)[] = [];
    let lastClock = -Infinity;
    let lastSequence = NaN;
    let lastTime = -Infinity;

    // Separate reference polyline portions when a mission restarts, its sequence changes, or the trace has a gap.
    // This prevents nearest-path queries from inventing a connecting segment across unrelated flight portions.
    for (const i of index) {
      const clock = arr('reference.clock')?.[i] ?? time[i];
      const seq = arr('reference.sequence')?.[i] ?? 0;

      if (clock < lastClock || seq !== lastSequence || time[i] - lastTime > run.gapLimit) {
        points.push(null);
      }

      points.push(arr('reference.valid')![i] > 0.5 ? (values('reference.position', i) as Vec3) : null);
      lastClock = clock;
      lastSequence = seq;
      lastTime = time[i];
    }

    // Build one spatial index from the complete recorded reference; query it without time alignment or decimation.
    const path = new PathDistance(points);

    derived(
      'pathDistance',
      'Global nearest recorded-path distance',
      'm',
      'ENU',
      (i) => path.distance(values('position', i) as Vec3),
      ['position', 'reference.position'],
      'Nearest recorded reference polyline; timing independent',
    );
    derived(
      'pathDistance.horizontal',
      'Horizontal nearest-path distance',
      'm',
      'ENU',
      (i) => path.distance(values('position', i) as Vec3, true),
      ['position', 'reference.position'],
      'Nearest recorded reference polyline in EN plane',
    );
    run.pathApproximation = 'Distances use the complete recorded reference polyline, not an inferred future plan.';

    // A direction is only defined during motion. Along-track uses the 3D tangent; signed cross-track uses
    // the horizontal left normal. Both remain unavailable at hover rather than dividing by near-zero speed.
    if (has('reference.velocity')) {
      derived(
        'alongTrack',
        'Along-track error',
        'm',
        'ENU',
        (i) => {
          const v = values('reference.velocity', i);
          const speed = Math.hypot(...v);

          return speed > 1e-5 ? values('tracking', i).reduce((s, x, a) => s + (x * v[a]) / speed, 0) : NaN;
        },
        ['tracking', 'reference.velocity'],
        'dot(error, normalized reference velocity); unavailable at hover',
      );
      derived(
        'crossTrack',
        'Signed lateral error',
        'm',
        'ENU',
        (i) => {
          const [e, n] = values('reference.velocity', i);
          const speed = Math.hypot(e, n);

          return speed > 1e-5 ? (-n * arr('tracking.0')![i] + e * arr('tracking.1')![i]) / speed : NaN;
        },
        ['tracking', 'reference.velocity'],
        'Horizontal left-normal projection; unavailable at hover',
      );
    }
  }

  // Add estimator diagnostics after canonical pose/error channels exist, then collect import caveats for the UI.
  addConsistency(run, columns, names, add);

  if (run.eventGroups) {
    run.warnings.push(
      `${run.eventGroups.toLocaleString()} adjacent event rows grouped for playback; raw rows retained.`,
    );
  }

  if (!manifest) {
    run.warnings.push('No manifest: producing compiler/model revision is unverified.');
  }

  const invalid = names.reduce((sum, n) => sum + columns[n].reduce((s, v) => s + Number(!Number.isFinite(v)), 0), 0);

  if (invalid) {
    run.warnings.push(`${invalid.toLocaleString()} non-finite values are retained as gaps.`);
  }

  return run;
}

/**
 * Infer a display unit from conventional Modelica signal suffixes when metadata is absent.
 *
 * @param n Original source header, possibly including array indices.
 * @returns Recognized angular, distance, time, or force unit; an empty string means unknown. Specific rate/power
 *   suffixes are tested before their shorter base suffixes.
 */
function inferUnit(n: string) {
  if (/_rad2/.test(n)) {
    return 'rad²';
  }

  if (/_rad_s/.test(n)) {
    return 'rad/s';
  }

  if (/_rad/.test(n)) {
    return 'rad';
  }

  if (/_m_s2/.test(n)) {
    return 'm/s²';
  }

  if (/_m_s/.test(n)) {
    return 'm/s';
  }

  if (/_m(?:\[|$)/.test(n)) {
    return 'm';
  }

  if (/_s$/.test(n)) {
    return 's';
  }

  if (/_N$/.test(n)) {
    return 'N';
  }

  return '';
}

/**
 * Infer an ENU or FLU frame hint from a source name, leaving unknown frames unspecified.
 *
 * @param n Original Modelica source header.
 * @returns 'ENU' for Enu/World names, 'FLU' for Flu/Body names, or an empty string when unknown. This labels
 *   coordinates; it does not rotate values.
 */
function inferFrame(n: string) {
  return /Enu|World/.test(n) ? 'ENU' : /Flu|Body/.test(n) ? 'FLU' : '';
}

/**
 * Derive ENU covariance bands and native-cadence NEES/NIS without treating held values as new samples.
 *
 * @param run Normalized run containing estimator validity, pose, and estimation-error channels.
 * @param columns Original source arrays aligned with run.time.
 * @param names Available source headers used for qualified-name resolution.
 * @param add Registration callback that writes generated values and metadata into the run.
 * @returns Nothing; registers available diagnostic channels and adds the covariance capability when its required
 *   inputs exist.
 * @remarks Missing inputs simply omit the corresponding diagnostic. NIS is split by attempted correction source; NEES
 *   uses the six-state local covariance and local-frame error. Display bands rotate position/velocity covariance
 *   blocks into ENU and use ±1.96 sigma; they do not describe attitude uncertainty.
 * @throws Error if a required source name resolves ambiguously.
 */
function addConsistency(
  run: Run,
  columns: Columns,
  names: string[],
  add: (
    id: string,
    label: string,
    unit: string,
    frame: string,
    values: Float64Array,
    kind?: Kind,
    source?: string[],
    derived?: string,
    validity?: string,
  ) => void,
) {
  const sampleCount = run.time.length;

  /**
   * Locate a source column by exact name or unique qualified suffix.
   *
   * @param n Requested Modelica source name.
   * @returns Shared source Float64Array or undefined when absent.
   * @throws Error if qualified suffix resolution is ambiguous.
   */
  const find = (n: string) => {
    const k = resolve(names, n);

    return k ? columns[k] : undefined;
  };
  const period = find('estimatorUpdatePeriod_s');
  const source = find('estimator.status.correctionSource');
  const nis = find('estimator.status.normalizedInnovationSquared');
  const native = new Set<number>();
  const ticks = new Map<number, number>();

  // Retain the last post-event row at each native estimator tick, not every held value in the CSV.
  if (period) {
    for (const i of run.index) {
      const p = period[i];
      const tick = Math.round(run.time[i] / p);

      if (p > 0 && Math.abs(run.time[i] / p - tick) < 1e-7) {
        ticks.set(tick, i);
      }
    }
  }

  for (const i of ticks.values()) {
    native.add(i);
  }

  // Each attempted correction has one source code. Place its innovation statistic only on the matching
  // sensor channel and native tick; intervening held CSV values are not additional statistical samples.
  if (nis && source && period) {
    for (const [code, label] of [
      [1, 'Mocap (6 dof)'],
      [2, 'GPS (6 dof)'],
      [3, 'Optical flow (2 dof)'],
      [4, 'Magnetometer (3 dof)'],
      [5, 'Barometer (1 dof)'],
    ] as const) {
      const v = new Float64Array(sampleCount).fill(NaN);

      for (const i of native) {
        if (Math.round(source[i]) === code && run.signals['estimate.valid']?.values[i] > 0.5) {
          v[i] = nis[i];
        }
      }

      add(
        `nis.${code}`,
        `NIS · ${label}`,
        '1',
        '',
        v,
        'event',
        ['estimator.status.normalizedInnovationSquared'],
        'Attempted correction ticks only',
      );
    }
  }

  // Read the full row-major six-state covariance: local position followed by local velocity, including cross terms.
  const covariance = [1, 2, 3, 4, 5, 6].flatMap((r) =>
    [1, 2, 3, 4, 5, 6].map((c) => find(`estimator.navigationCovarianceLocal[${r},${c}]`)),
  );

  if (!covariance.every(Boolean) || !run.signals['estimate.q.0'] || !run.signals['velocityEstimation.0']) {
    return;
  }

  const nees = new Float64Array(sampleCount).fill(NaN);
  const bands = Array.from({ length: 6 }, () => new Float64Array(sampleCount).fill(NaN));

  for (let i = 0; i < sampleCount; i++) {
    if (!(run.signals['estimate.valid']?.values[i] > 0.5)) {
      continue;
    }

    const rotation = toMatrix([0, 1, 2, 3].map((a) => run.signals[`estimate.q.${a}`].values[i]) as Quat);
    const localCovariance = covariance.map((c) => c![i]);

    // Covariance is local-tangent position then velocity; rotate each 3×3 block into ENU for display bands.
    for (let axis = 0; axis < 6; axis++) {
      const row = axis % 3;
      const offset = axis < 3 ? 0 : 3;
      let variance = 0;

      for (let a = 0; a < 3; a++) {
        for (let b = 0; b < 3; b++) {
          variance += rotation[row * 3 + a] * localCovariance[(a + offset) * 6 + b + offset] * rotation[row * 3 + b];
        }
      }

      bands[axis][i] = variance >= 0 ? Math.sqrt(variance) : NaN;
    }

    if (native.has(i)) {
      // NEES uses the original local covariance, so rotate truth-minus-estimate errors back into its frame.
      const dp = [0, 1, 2].map((a) => -run.signals[`estimation.${a}`].values[i]);
      const dv = [0, 1, 2].map((a) => -run.signals[`velocityEstimation.${a}`].values[i]);

      nees[i] = quadraticForm(localCovariance, [
        ...transposeMultiply(rotation, dp),
        ...transposeMultiply(rotation, dv),
      ]);
    }
  }

  add(
    'nees',
    'Navigation NEES (6 dof)',
    '1',
    'local tangent',
    nees,
    'event',
    [],
    'e_localᵀ solve(P,e_local); native estimator ticks',
  );
  // Create symmetric Gaussian marginal bounds for the error plots; these are offsets about zero, not estimated states.
  bands.forEach((v, a) => {
    add(
      `uncertainty.lower.${a}`,
      `95% lower bound ${a}`,
      a < 3 ? 'm' : 'm/s',
      'ENU',
      Float64Array.from(v, (x) => -1.96 * x),
      'held',
      [],
      '-1.96 sigma; Gaussian marginal interval',
      'estimate.valid',
    );
    add(
      `uncertainty.upper.${a}`,
      `95% upper bound ${a}`,
      a < 3 ? 'm' : 'm/s',
      'ENU',
      Float64Array.from(v, (x) => 1.96 * x),
      'held',
      [],
      '+1.96 sigma; Gaussian marginal interval',
      'estimate.valid',
    );
  });
  bands.forEach((v, a) =>
    add(
      `sigma.${a}`,
      `${['East', 'North', 'Up'][a % 3]} ${a < 3 ? 'position' : 'velocity'} σ`,
      a < 3 ? 'm' : 'm/s',
      'ENU',
      v,
      'held',
      [],
      'sqrt(diag(R Pblock Rᵀ))',
      'estimate.valid',
    ),
  );
  run.capabilities.push('covariance');
}
