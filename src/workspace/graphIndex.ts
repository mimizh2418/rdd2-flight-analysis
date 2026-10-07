import type { Run } from '../data/types';
import { sample, upperBound } from '../playback/time';
import { checkpoint, paddedRange, rawValue, type Cancelled, type Progress } from './preparation';
import type { PlotSeries, PreparedPlot } from './types';

/** Immutable raw values and extrema lookup tables for one selected scalar channel. */
export interface GraphIndex {
  values: Float64Array;
  min: Uint32Array;
  max: Uint32Array;
  leaves: number;
  /** Native discontinuities: invalid-data boundaries, held transitions, and duplicate event rows. */
  boundaries: Uint32Array;
  /** Midpoints of long time gaps; these must remain null in display geometry. */
  gaps: Float64Array;
}

/**
 * Return the first raw timestamp greater than or equal to a query.
 * @param time Ascending raw simulation times.
 * @param query Original simulation seconds.
 * @returns Insertion position before all duplicate timestamps equal to the query.
 */
function lowerBound(time: Float64Array, query: number): number {
  let low = 0;
  let high = time.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (time[middle] < query) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Compare two indexed samples, ignoring missing values and resolving ties deterministically.
 * @param values Masked native measurements.
 * @param a First raw row, or values.length for an empty node.
 * @param b Second raw row, or values.length for an empty node.
 * @param minimum Select a minimum when true, otherwise a maximum.
 * @returns Raw row containing the selected finite extremum, or the empty sentinel.
 */
function choose(values: Float64Array, a: number, b: number, minimum: boolean): number {
  if (!Number.isFinite(values[a])) return b;
  if (!Number.isFinite(values[b])) return a;
  return (minimum ? values[a] <= values[b] : values[a] > values[b]) ? a : b;
}

/**
 * Build a reusable scalar index in the preparation worker, yielding for cancellation/progress.
 * @param run Selected source columns, including validity dependencies.
 * @param id Canonical scalar identity.
 * @param report Initial field-loading progress callback.
 * @param cancelled Operation cancellation predicate.
 * @returns Transferable masked values, extrema trees, and discontinuity coordinates; no display conversions applied.
 */
export async function buildGraphIndex(
  run: Run,
  id: string,
  report: Progress,
  cancelled: Cancelled,
): Promise<GraphIndex> {
  const length = run.time.length;
  const leaves = 2 ** Math.ceil(Math.log2(Math.max(1, length)));
  const values = new Float64Array(length);
  const min = new Uint32Array(leaves * 2).fill(length);
  const max = new Uint32Array(leaves * 2).fill(length);
  const boundaries = new Set<number>();
  const gaps: number[] = [];
  const kind = run.signals[id].kind;

  for (let row = 0; row < length; row++) {
    values[row] = rawValue(run, id, row);
    if (Number.isFinite(values[row])) min[leaves + row] = max[leaves + row] = row;
    if (row) {
      const invalidBoundary = Number.isFinite(values[row]) !== Number.isFinite(values[row - 1]);
      const duplicate = run.time[row] === run.time[row - 1] && !Object.is(values[row], values[row - 1]);
      const transition = kind === 'held' && values[row] !== values[row - 1] && Number.isFinite(values[row]);
      if (invalidBoundary || duplicate || transition) {
        boundaries.add(row - 1);
        boundaries.add(row);
      }
      if (run.time[row] - run.time[row - 1] > run.gapLimit) {
        gaps.push((run.time[row] + run.time[row - 1]) / 2);
        boundaries.add(row - 1);
        boundaries.add(row);
      }
    }
    if (kind === 'event' && Number.isFinite(values[row])) boundaries.add(row);
    if (row % 8192 === 0) {
      report((row / Math.max(1, length)) * 0.6, 'Indexing graph samples');
      await checkpoint(cancelled);
    }
  }

  // Each internal node stores original row identities, so spikes survive pixel decimation at every zoom level.
  for (let node = leaves - 1; node > 0; node--) {
    min[node] = choose(values, min[node * 2], min[node * 2 + 1], true);
    max[node] = choose(values, max[node * 2], max[node * 2 + 1], false);
    if (node % 8192 === 0) {
      report(0.6 + 0.4 * (1 - node / leaves), 'Building graph range cache');
      await checkpoint(cancelled);
    }
  }
  report(1, 'Ready');
  return {
    values,
    min,
    max,
    leaves,
    boundaries: Uint32Array.from([...boundaries].sort((a, b) => a - b)),
    gaps: Float64Array.from(gaps),
  };
}

/**
 * Query exact raw extrema without scanning the selected interval.
 * @param index Immutable scalar index.
 * @param first First included raw row.
 * @param end Exclusive final raw row.
 * @returns Minimum/maximum raw row identities; values.length indicates no finite data.
 */
export function rangeRows(index: GraphIndex, first: number, end: number): [number, number] {
  let low = first + index.leaves;
  let high = end + index.leaves;
  let min = index.values.length;
  let max = min;
  while (low < high) {
    if (low & 1) {
      min = choose(index.values, min, index.min[low], true);
      max = choose(index.values, max, index.max[low++], false);
    }
    if (high & 1) {
      --high;
      min = choose(index.values, min, index.min[high], true);
      max = choose(index.values, max, index.max[high], false);
    }
    low >>>= 1;
    high >>>= 1;
  }
  return [min, max];
}

/**
 * Produce pixel-budgeted graph geometry from cached channel indices during navigation.
 * @param runs Shared immutable source registry.
 * @param series Visible styles, time offsets, and angle conversion factors.
 * @param indices Cached scalar indices in matching series order.
 * @param window Displayed simulation seconds.
 * @param pixels Horizontal geometry budget; native events/discontinuities are preserved beyond this budget.
 * @returns Gap-aware display samples and exact visible axis bounds. No worker reload or full-column scan is required.
 */
export function indexedPlot(
  runs: Run[],
  series: PlotSeries[],
  indices: GraphIndex[],
  window: [number, number],
  pixels: number,
): PreparedPlot {
  const registry = new Map(runs.map((run) => [run.id, run]));
  const records = new Map<string, { time: number; occurrence: number }>();
  const lookups = new Map<string, Map<string, number>>();
  const extrema = { left: [Infinity, -Infinity], right: [Infinity, -Infinity] };
  const buckets = Math.max(20, Math.min(1200, Math.floor(pixels / Math.max(1, Math.sqrt(series.length)))));

  /**
   * Add a display coordinate, retaining separate rows at identical native event times.
   * @param time Aligned seconds.
   * @param occurrence Native row position within an exact-time event group.
   * @returns Stable shared-coordinate key.
   */
  const add = (time: number, occurrence = 0) => {
    const key = `${time}:${occurrence}`;
    records.set(key, { time, occurrence });
    return key;
  };
  add(window[0]);
  add(window[1]);

  for (let channel = 0; channel < series.length; channel++) {
    const item = series[channel];
    const run = registry.get(item.runId)!;
    const index = indices[channel];
    const from = window[0] + item.offset;
    const to = window[1] + item.offset;
    const first = lowerBound(run.time, from);
    const end = upperBound(run.time, to);
    const retained = new Set<number>();
    const axis = extrema[item.lane];

    for (const row of rangeRows(index, first, end)) {
      const value = index.values[row] * item.factor;
      if (Number.isFinite(value)) {
        axis[0] = Math.min(axis[0], value);
        axis[1] = Math.max(axis[1], value);
      }
    }
    for (const boundary of window) {
      const value = sample(run, item.signalId, boundary + item.offset) * item.factor;
      if (Number.isFinite(value)) {
        axis[0] = Math.min(axis[0], value);
        axis[1] = Math.max(axis[1], value);
      }
    }

    // Index queries cost logarithmic time even when zooming out over millions of original samples.
    const width = (to - from) / buckets;
    let left = first;
    for (let bucket = 0; bucket < buckets && left < end; bucket++) {
      const right = bucket === buckets - 1 ? end : Math.min(end, lowerBound(run.time, from + (bucket + 1) * width));
      if (right > left) {
        retained.add(left);
        retained.add(right - 1);
        for (const row of rangeRows(index, left, right)) if (row < index.values.length) retained.add(row);
      }
      left = right;
    }
    // Binary-search discontinuity indices as well, rather than visiting off-screen events.
    let boundary = upperBound(index.boundaries, first - 1);
    while (boundary < index.boundaries.length && index.boundaries[boundary] < end)
      retained.add(index.boundaries[boundary++]);

    const lookup = lookups.get(run.id) ?? new Map<string, number>();
    lookups.set(run.id, lookup);
    for (const row of retained) {
      const time = run.time[row];
      lookup.set(add(time - item.offset, row - lowerBound(run.time, time)), row);
    }
    let gap = upperBound(index.gaps, from);
    while (gap < index.gaps.length && index.gaps[gap] < to) add(index.gaps[gap++] - item.offset);
  }

  const coordinates = [...records.entries()].sort((a, b) => a[1].time - b[1].time || a[1].occurrence - b[1].occurrence);
  const y = series.map((item, channel) => {
    const run = registry.get(item.runId)!;
    const lookup = lookups.get(run.id)!;
    return coordinates.map(([key, coordinate]) => {
      const row = lookup.get(key);
      const value =
        (row === undefined ? sample(run, item.signalId, coordinate.time + item.offset) : indices[channel].values[row]) *
        item.factor;
      return Number.isFinite(value) ? value : null;
    });
  });
  return {
    x: coordinates.map(([, coordinate]) => coordinate.time),
    y,
    ranges: {
      left: paddedRange(...(extrema.left as [number, number])),
      right: paddedRange(...(extrema.right as [number, number])),
    },
  };
}
