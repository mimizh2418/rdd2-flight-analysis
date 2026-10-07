import type { Run, Quat, Vec3 } from '../data/types';
import { slerp } from '../math/rotation';

/**
 * Compare timestamps with a scale-aware floating-point tolerance rather than a fixed time rounding rule.
 *
 * @param a First finite timestamp in seconds.
 * @param b Second finite timestamp in seconds.
 * @returns Whether their difference is within eight machine epsilons scaled by max(1, |a|, |b|).
 */
export const coincident = (a: number, b: number) =>
  Math.abs(a - b) <= 8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b));

/**
 * Retain each event group's final row for playback while validating finite, nondecreasing raw time.
 *
 * @param time Raw timestamps in simulation seconds; equal and near-equal event times are allowed.
 * @returns Raw row indices for the final, post-transition sample of every event group. Empty input yields an empty
 *   index.
 * @throws Error if a timestamp is non-finite or decreases; messages use the original CSV row number.
 * @remarks Group membership is measured against the group's first time to prevent tolerance from chaining across a
 *   meaningful interval. The input is not sorted or changed.
 */
export function eventIndex(time: Float64Array): Uint32Array {
  const indices: number[] = [];
  let groupStartRow = 0;

  for (let i = 0; i < time.length; i++) {
    if (!Number.isFinite(time[i])) {
      throw new Error(`Non-finite time at row ${i + 2}`);
    }

    if (i && time[i] < time[i - 1]) {
      throw new Error(`Time moves backwards at row ${i + 2}; input was not sorted.`);
    }

    // Compare to the start of a group so repeated epsilon steps cannot chain
    // a whole meaningful time interval into one event.
    if (indices.length && coincident(time[i], time[groupStartRow])) {
      indices[indices.length - 1] = i;
    } else {
      groupStartRow = i;
      indices.push(i);
    }
  }

  return Uint32Array.from(indices);
}

/**
 * Return the first index whose sorted value is greater than the query.
 *
 * @param sortedValues Ascending values, such as timestamps; duplicates are allowed.
 * @param query Query in the same units as sortedValues.
 * @returns Insertion index after all values <= query, between zero and sortedValues.length inclusive.
 */
export function upperBound(sortedValues: ArrayLike<number>, query: number): number {
  let lower = 0;
  let upper = sortedValues.length;

  while (lower < upper) {
    const midpoint = (lower + upper) >>> 1;

    if (sortedValues[midpoint] <= query) {
      lower = midpoint + 1;
    } else {
      upper = midpoint;
    }
  }

  return lower;
}

/**
 * Last post-event row on the left, first pre-event row on the right.
 *
 * @param run Run with nondecreasing raw time, final-row event indices, and a gapLimit in seconds.
 * @param simulationTime Query in original simulation seconds, not the comparison clock.
 * @returns [leftRawRow, rightRawRow, fraction], with fraction in [0, 1], or null outside coverage, for a non-finite
 *   query, or across a long gap. At an event, both rows are the final event row and fraction is zero.
 * @remarks The interpolation duration ends at the next group's representative time; the right value comes from that
 *   group's first row so a discrete transition is not smeared backward in time.
 */
export function bracket(run: Run, simulationTime: number): [number, number, number] | null {
  const eventRows = run.index;
  const times = run.time;

  if (
    !Number.isFinite(simulationTime) ||
    !eventRows.length ||
    (simulationTime < times[eventRows[0]] && !coincident(simulationTime, times[eventRows[0]])) ||
    (simulationTime > times[eventRows[eventRows.length - 1]] &&
      !coincident(simulationTime, times[eventRows[eventRows.length - 1]]))
  ) {
    return null;
  }

  // Binary-search the event representatives for the first group strictly after the requested clock time.
  let lower = 0;
  let upper = eventRows.length;

  while (lower < upper) {
    const midpoint = (lower + upper) >>> 1;

    if (times[eventRows[midpoint]] <= simulationTime || coincident(times[eventRows[midpoint]], simulationTime)) {
      lower = midpoint + 1;
    } else {
      upper = midpoint;
    }
  }

  const leftRow = eventRows[Math.max(0, lower - 1)];

  if (coincident(simulationTime, times[leftRow]) || lower >= eventRows.length) {
    return [leftRow, leftRow, 0];
  }

  const endTime = times[eventRows[lower]];
  const intervalDuration = endTime - times[leftRow];

  if (intervalDuration > run.gapLimit) {
    return null;
  }

  // Groups partition consecutive raw rows: immediately after the left post-event row is the next
  // group's first pre-transition row. Interpolate toward that value, not the next post-transition value.
  return [leftRow, leftRow + 1, Math.max(0, Math.min(1, (simulationTime - times[leftRow]) / intervalDuration))];
}

/**
 * Sample a scalar using its interpolation kind and validity dependencies, leaving gaps as NaN.
 *
 * @param run Normalized source run.
 * @param id Registry key of the scalar channel to sample.
 * @param simulationTime Original simulation time in seconds.
 * @param visited Mutable recursion guard for validity dependencies; a fresh set is created for each top-level call.
 * @returns Value in the channel's units, or NaN for missing signals, invalid data, cyclic validity, or uncovered time.
 *   Event channels exist only at their event timestamp; held channels use the left sample.
 * @remarks Continuous interpolation requires validity at both endpoints. No extrapolation or gap filling is performed.
 */
export function sample(run: Run, id: string, simulationTime: number, visited = new Set<string>()): number {
  const signal = run.signals[id];
  const interval = bracket(run, simulationTime);

  if (!signal || !interval || visited.has(id)) {
    return NaN;
  }

  // Validity channels can themselves depend on another validity channel. Record this ID before recursing
  // to reject cycles instead of overflowing the call stack.
  visited.add(id);

  const [i, j, f] = interval;

  if (signal.validity && !(sample(run, signal.validity, simulationTime, visited) > 0.5)) {
    return NaN;
  }

  // An event is a marker at its own timestamp, not a value that persists until the next event.
  if (signal.kind === 'event') {
    return coincident(run.time[i], simulationTime) ? signal.values[i] : NaN;
  }

  // Exact timestamps use the post-event value. Discrete channels retain that value until their next update.
  if (signal.kind === 'held' || f === 0) {
    return signal.values[i];
  }

  // The right endpoint must also be valid before interpolating a continuous channel through the interval.
  if (signal.validity && !(run.signals[signal.validity]?.values[j] > 0.5)) {
    return NaN;
  }

  return signal.values[i] + f * (signal.values[j] - signal.values[i]);
}

/**
 * Sample three numbered components of a signal prefix on the shared simulation timeline.
 *
 * @param run Normalized source run.
 * @param prefix Registry prefix whose components are prefix.0, prefix.1, and prefix.2.
 * @param simulationTime Original simulation time in seconds.
 * @returns Three values in component order; unavailable components are NaN independently. Position and velocity
 *   prefixes use East, North, Up order.
 */
export function vector(run: Run, prefix: string, simulationTime: number): Vec3 {
  return [0, 1, 2].map((i) => sample(run, `${prefix}.${i}`, simulationTime)) as Vec3;
}

/**
 * Sample truth attitude with SLERP or hold a valid estimated quaternion between estimator updates.
 *
 * @param run Normalized source run.
 * @param prefix Quaternion registry prefix, normally 'q' for truth or 'estimate.q' for the estimator.
 * @param simulationTime Original simulation time in seconds.
 * @returns Hamilton quaternion [x, y, z, w] mapping body FLU into world ENU, or four NaNs when unavailable.
 * @remarks Estimated attitude requires estimate.valid and is held at the left row. Truth attitude uses shortest-arc
 *   SLERP between event-aware endpoints.
 */
export function attitude(run: Run, prefix: string, simulationTime: number): Quat {
  const invalid: Quat = [NaN, NaN, NaN, NaN];
  const interval = bracket(run, simulationTime);

  if (!interval) {
    return invalid;
  }

  const [i, j, f] = interval;

  /**
   * Read quaternion components in the viewer's x/y/z/w order from one raw row.
   *
   * @param k Raw CSV row index in the enclosing run.
   * @returns [x, y, z, w] from the enclosing prefix; missing components are NaN. No normalization is performed here.
   */
  const q = (k: number) => [0, 1, 2, 3].map((a) => run.signals[`${prefix}.${a}`]?.values[k] ?? NaN) as Quat;

  // Estimator outputs are sampled messages: holding their attitude avoids implying intermediate filter updates.
  if (prefix === 'estimate.q') {
    return sample(run, 'estimate.valid', simulationTime) > 0.5 ? q(i) : invalid;
  }

  return f === 0 ? q(i) : slerp(q(i), q(j), f);
}

/**
 * Return the first arm or mission event time, or NaN when the requested event is unavailable.
 *
 * @param run Normalized run to inspect.
 * @param mode 'absolute' uses zero, 'armed' uses the first armed value > 0.5, and other modes use the first phase
 *   value > 0.5.
 * @returns Offset in original simulation seconds, or NaN if the selected event never appears.
 * @remarks Subtract this offset to obtain the displayed comparison time; it does not stretch the timeline.
 */
export function alignmentOffset(run: Run, mode: string): number {
  if (mode === 'absolute') {
    return 0;
  }

  const signal = run.signals[mode === 'armed' ? 'armed' : 'phase'];

  if (!signal) {
    return NaN;
  }

  for (const i of run.index) {
    if (signal.values[i] > 0.5) {
      return run.time[i];
    }
  }

  return NaN;
}

/**
 * Find a neighboring event-normalized timestamp for forward or backward sample stepping.
 *
 * @param run Run with a nonempty event index.
 * @param simulationTime Current cursor in original simulation seconds, possibly between samples.
 * @param direction Negative selects the previous sample; zero or positive selects the next sample.
 * @returns Neighbor timestamp in seconds, clamped to the first or last playback sample.
 */
export function adjacentSample(run: Run, simulationTime: number, direction: number): number {
  const eventRows = run.index;
  let lower = 0;
  let upper = eventRows.length;

  while (lower < upper) {
    const midpoint = (lower + upper) >>> 1;

    if (run.time[eventRows[midpoint]] < simulationTime && !coincident(run.time[eventRows[midpoint]], simulationTime)) {
      lower = midpoint + 1;
    } else {
      upper = midpoint;
    }
  }

  // At an exact sample, forward stepping skips that sample; between samples it chooses the next one.
  // Backward stepping always chooses the representative immediately before the insertion position.
  const atSample = lower < eventRows.length && coincident(run.time[eventRows[lower]], simulationTime);
  const index = direction < 0 ? lower - 1 : lower + Number(atSample);

  return run.time[eventRows[Math.max(0, Math.min(eventRows.length - 1, index))]];
}
