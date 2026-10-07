import type { Run, Vec3 } from '../data/types';
import { sample } from '../playback/time';
import { decimate, summarize } from '../math/statistics';
import type { Field, PlotSeries, PreparedField, PreparedPlot } from './types';
import { simplifyFullPath } from './pathGeometry';

export type Progress = (fraction: number, stage: string) => void;
export type Cancelled = () => boolean;

/**
 * Yield CPU work so worker message delivery, cancellation, and progress can run between batches.
 * @param cancelled Cancellation predicate for the current request.
 * @returns Promise resolved on the next task turn.
 * @throws DOMException when the request was cancelled.
 */
export async function checkpoint(cancelled: Cancelled): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  if (cancelled()) throw new DOMException('Preparation cancelled', 'AbortError');
}

/**
 * Read a raw channel while applying its recursive raw-row validity mask.
 * @param run Minimal worker-side run containing selected channels and validity dependencies.
 * @param id Scalar channel key.
 * @param row Original CSV row.
 * @param visited Recursion guard, fresh for each top-level call.
 * @returns Scalar value, or NaN for absent/cyclic/invalid data.
 */
export function rawValue(run: Run, id: string, row: number, visited = new Set<string>()): number {
  const signal = run.signals[id];

  if (!signal || visited.has(id)) return NaN;
  visited.add(id);

  if (signal.validity && !(rawValue(run, signal.validity, row, visited) > 0.5)) return NaN;
  return signal.values[row];
}

/**
 * Prepare immutable path geometry away from the UI thread.
 * @param run Selected source columns and the event-normalized index.
 * @param field Position/pose/mission descriptor; other types only require selected-column loading.
 * @param report Progress callback relative to the CPU preparation stage.
 * @param cancelled Cancellation predicate checked between bounded batches.
 * @returns Transferable segment positions, end times, and full-resolution bounds when a path is applicable.
 */
export async function prepareField(
  run: Run,
  field: Field,
  report: Progress,
  cancelled: Cancelled,
): Promise<PreparedField> {
  if (!['position', 'pose', 'plan'].includes(field.type)) {
    await checkpoint(cancelled);
    report(1, 'Ready');
    return {};
  }

  const positions: number[] = [];
  const times: number[] = [];
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  let previous: Vec3 | undefined;
  let previousTime = -Infinity;
  let previousClock = -Infinity;
  let previousSequence = NaN;
  const mission = run.manifest?.mission;
  const planned =
    field.type === 'plan' ? (mission?.trajectory?.length ? mission.trajectory : (mission?.waypoints ?? [])) : undefined;
  const rows = planned ? planned.length : run.index.length;

  for (let index = 0; index < rows; index++) {
    const row = run.index[index];
    const point = planned ? planned[index] : (field.signals.map((id) => rawValue(run, id, row)) as Vec3);
    const time = planned ? -Infinity : run.time[row];
    const clock = run.signals['reference.clock']?.values[row] ?? time;
    const sequence = run.signals['reference.sequence']?.values[row] ?? 0;
    const isReference = field.prefix === 'reference.position';

    // Reference resets are separate portions of the path, not imaginary connecting segments.
    if (
      !point?.every(Number.isFinite) ||
      (!planned && time - previousTime > run.gapLimit) ||
      (isReference && (clock < previousClock || sequence !== previousSequence))
    )
      previous = undefined;

    if (point?.every(Number.isFinite)) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }

      // Held messages and stationary samples often repeat a position for thousands of solver rows.
      // Thick-line shaders normalize segment direction: identical GPU endpoints contribute no visible path
      // and waste work (or produce an undefined direction). Compare at the Float32 precision used by geometry.
      const hasLength = previous && point.some((value, axis) => Math.fround(value) !== Math.fround(previous![axis]));

      if (previous && hasLength) {
        positions.push(...previous, ...point);
        times.push(time);
      }
      previous = point;
    }

    previousTime = time;
    previousClock = clock;
    previousSequence = sequence;

    if (index % 4096 === 0) {
      report((index / Math.max(1, rows)) * 0.7, 'Building path');
      await checkpoint(cancelled);
    }
  }

  const coordinates = Float32Array.from(positions);
  const fullPositions = planned
    ? undefined
    : await simplifyFullPath(
        coordinates,
        () => checkpoint(cancelled),
        (fraction) => report(0.7 + fraction * 0.3, 'Reducing drawing geometry'),
      );

  report(1, 'Ready');
  return {
    path: { positions: coordinates, fullPositions, times: Float64Array.from(times), bounds: { min, max } },
  };
}

/**
 * Pad an axis around its finite visible extrema, including a usable constant-value range.
 * @param min Lowest usable value.
 * @param max Highest usable value.
 * @returns Inclusive axis range; missing data produces [-1, 1].
 */
export function paddedRange(min: number, max: number): [number, number] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [-1, 1];

  const padding = max === min ? Math.max(Math.abs(min) * 0.05, 0.01) : (max - min) * 0.06;

  return [min - padding, max + padding];
}

/**
 * Build a shared graph time array, gap-aware samples, and exact visible raw extrema in a worker.
 * @param runs Worker run registry, populated only with selected columns.
 * @param series Visible scalar series with alignment/display conversions.
 * @param window Displayed-time interval in seconds.
 * @param pixels Horizontal decimation budget; transitions and events may exceed it.
 * @param report Progress callback.
 * @param cancelled Cancellation predicate.
 * @returns Display data and independently fitted axis ranges; original numeric arrays are unchanged.
 */
export async function preparePlot(
  runs: Map<string, Run>,
  series: PlotSeries[],
  window: [number, number],
  pixels: number,
  report: Progress,
  cancelled: Cancelled,
): Promise<PreparedPlot> {
  const records = new Map<string, { time: number; occurrence: number }>();
  const rawRows = new Map<string, Map<string, number>>();
  const masked: Float64Array[] = [];
  const extrema = { left: [Infinity, -Infinity], right: [Infinity, -Infinity] };

  /**
   * Add one graph coordinate while retaining distinct raw rows at identical event timestamps.
   * @param time Displayed time in seconds.
   * @param occurrence Position inside an exact duplicate-time group.
   * @returns Stable coordinate key shared between run lookups and the graph.
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
    const run = runs.get(item.runId)!;
    const values = new Float64Array(run.time.length).fill(NaN);
    masked.push(values);
    let occurrence = 0;

    for (let row = 0; row < run.time.length; row++) {
      values[row] = rawValue(run, item.signalId, row) * item.factor;
      const time = run.time[row] - item.offset;
      occurrence = row && run.time[row] === run.time[row - 1] ? occurrence + 1 : 0;

      // Axis extrema inspect every usable raw row, including both sides of instantaneous events.
      if (time >= window[0] && time <= window[1] && Number.isFinite(values[row])) {
        const axis = extrema[item.lane];
        axis[0] = Math.min(axis[0], values[row]);
        axis[1] = Math.max(axis[1], values[row]);
      }

      if (row % 8192 === 0) {
        report(((channel + row / run.time.length) / Math.max(1, series.length)) * 0.55, 'Finding visible extrema');
        await checkpoint(cancelled);
      }
    }

    const retained = decimate(
      run.time,
      [values],
      window[0] + item.offset,
      window[1] + item.offset,
      Math.max(100, pixels),
      [item.kind],
    );
    const lookup = rawRows.get(run.id) ?? new Map<string, number>();
    rawRows.set(run.id, lookup);

    for (const row of retained) {
      let low = 0;
      let high = row;

      while (low < high) {
        const middle = (low + high) >>> 1;

        if (run.time[middle] < run.time[row]) low = middle + 1;
        else high = middle;
      }

      const first = low;
      const key = add(run.time[row] - item.offset, row - first);
      lookup.set(key, row);
    }

    for (const boundary of window) {
      const value = sample(run, item.signalId, boundary + item.offset) * item.factor;

      if (Number.isFinite(value)) {
        extrema[item.lane][0] = Math.min(extrema[item.lane][0], value);
        extrema[item.lane][1] = Math.max(extrema[item.lane][1], value);
      }
    }

    // A midpoint in each long gap prevents the plotting library from bridging finite endpoints.
    for (let group = 1; group < run.index.length; group++) {
      const start = run.time[run.index[group - 1]];
      const end = run.time[run.index[group]];
      const midpoint = (start + end) / 2 - item.offset;

      if (end - start > run.gapLimit && midpoint > window[0] && midpoint < window[1]) add(midpoint);
    }
  }

  const coordinates = [...records.entries()].sort((a, b) => a[1].time - b[1].time || a[1].occurrence - b[1].occurrence);
  const y: (number | null)[][] = [];

  for (let channel = 0; channel < series.length; channel++) {
    const item = series[channel];
    const run = runs.get(item.runId)!;
    const values: (number | null)[] = [];
    const lookup = rawRows.get(run.id)!;

    for (let index = 0; index < coordinates.length; index++) {
      const [key, coordinate] = coordinates[index];
      const rawRow = lookup.get(key);
      const value =
        rawRow === undefined
          ? sample(run, item.signalId, coordinate.time + item.offset) * item.factor
          : masked[channel][rawRow];
      values.push(Number.isFinite(value) ? value : null);

      if (index % 8192 === 0) {
        report(0.55 + (0.45 * (channel + index / coordinates.length)) / Math.max(1, series.length), 'Preparing graph');
        await checkpoint(cancelled);
      }
    }
    y.push(values);
  }

  report(1, 'Ready');
  return {
    x: coordinates.map(([, coordinate]) => coordinate.time),
    y,
    ranges: {
      left: paddedRange(...(extrema.left as [number, number])),
      right: paddedRange(...(extrema.right as [number, number])),
    },
  };
}

/**
 * Calculate full-resolution tracking statistics in the worker rather than blocking an export click.
 * @param run Source with tracking components and their validity dependencies loaded.
 * @param interval Original simulation seconds.
 * @returns Existing time-weighted summary contract.
 */
export function prepareSummary(run: Run, interval: [number, number]) {
  return summarize(run, 'tracking.norm', interval[0], interval[1]);
}
