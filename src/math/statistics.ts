import type { Run, Summary } from '../data/types';

// Norm metrics must integrate their component vectors, rather than a linear approximation of sampled norms.
const vectorMetricPrefixes: Record<string, string> = {
  'tracking.norm': 'tracking',
  'tracking.horizontal': 'tracking',
  'estimation.norm': 'estimation',
  'estimation.horizontal': 'estimation',
  'velocityError.norm': 'velocityError',
  'velocityError.horizontal': 'velocityError',
  'velocityEstimation.norm': 'velocityEstimation',
  'velocityEstimation.horizontal': 'velocityEstimation',
};

/**
 * Piecewise-linear continuous signals, right-held discrete signals; no weighting of event row multiplicity.
 *
 * Continuous scalar RMS and mean integrate linear segments analytically. Vector-norm RMS integrates the squared
 * component interpolants exactly; its mean uses Simpson integration. P95 is an approximation using duration-weighted
 * interval midpoints. Peaks also inspect raw event rows so instantaneous jumps are retained.
 *
 * @param run Normalized run; values and time remain indexed by raw CSV row.
 * @param id Signal ID in run.signals. Known vector-norm IDs use their component channels for integration.
 * @param start Inclusive interval start in simulation seconds, before any comparison-time alignment.
 * @param end Inclusive interval end in simulation seconds.
 * @returns Statistics in the signal's units, maxTime in seconds, duration in seconds, and coverage as a fraction of
 *   the requested interval. Unavailable metrics are NaN; initial coverage and duration are zero.
 * @remarks Missing components, failed validity flags, event-only signals, and intervals beyond gapLimit contribute no
 *   duration. Input arrays are not changed.
 */
export function summarize(run: Run, id: string, start: number, end: number): Summary {
  const signal = run.signals[id];
  const result: Summary = {
    rmse: NaN,
    mean: NaN,
    max: NaN,
    maxTime: NaN,
    p95: NaN,
    coverage: 0,
    duration: 0,
  };

  if (!signal || end <= start) {
    return result;
  }

  let squaredIntegral = 0;
  let valueIntegral = 0;
  let validDuration = 0;
  let peakValue = -Infinity;
  const weightedMidpoints: [number, number][] = [];

  // A jump can have several raw values at essentially the same time. Inspect all of them for peaks,
  // even though only one representative row from each event group contributes to interval integration.
  for (let rawRow = 0; rawRow < run.time.length; rawRow++) {
    const t = run.time[rawRow];
    const v = signal.values[rawRow];

    if (
      t >= start &&
      t <= end &&
      Number.isFinite(v) &&
      (!signal.validity || run.signals[signal.validity]?.values[rawRow] > 0.5) &&
      v > peakValue
    ) {
      peakValue = v;
      result.maxTime = t;
    }
  }

  // Integrate distinct-time segments, clipping their endpoints to the requested analysis interval.
  for (let groupIndex = 0; groupIndex < run.index.length - 1; groupIndex++) {
    const leftRow = run.index[groupIndex];
    const nextGroupRow = run.index[groupIndex + 1];
    const intervalStart = Math.max(start, run.time[leftRow]);
    const intervalEnd = Math.min(end, run.time[nextGroupRow]);

    if (intervalEnd <= intervalStart || run.time[nextGroupRow] - run.time[leftRow] > run.gapLimit) {
      continue;
    }

    // Integrate to the next group's first pre-transition sample, not its jump.
    const rightRow = leftRow + 1;

    if (
      signal.validity &&
      (!(run.signals[signal.validity]?.values[leftRow] > 0.5) ||
        !(run.signals[signal.validity]?.values[rightRow] > 0.5))
    ) {
      continue;
    }

    if (signal.kind === 'event') {
      continue;
    }

    // Fractions locate the clipped endpoints inside the original segment; duration supplies their time weight.
    const segmentDuration = run.time[nextGroupRow] - run.time[leftRow];
    const startFraction = (intervalStart - run.time[leftRow]) / segmentDuration;
    const endFraction = (intervalEnd - run.time[leftRow]) / segmentDuration;
    const intervalDuration = intervalEnd - intervalStart;
    const vectorPrefix = vectorMetricPrefixes[id];

    if (vectorPrefix) {
      const componentCount = id.endsWith('.horizontal') ? 2 : 3;
      let startSquaredNorm = 0;
      let endSquaredNorm = 0;
      let midpointSquaredNorm = 0;
      let valid = true;

      // Reconstruct each component at the clipped endpoints before taking a magnitude. A missing axis
      // invalidates the entire vector interval so coverage cannot overstate how much data was usable.
      for (let axis = 0; axis < componentCount; axis++) {
        const component = run.signals[`${vectorPrefix}.${axis}`];

        if (!component) {
          valid = false;
          break;
        }

        const leftComponent = component.values[leftRow];
        const rightComponent = component.values[rightRow];

        if (!Number.isFinite(leftComponent) || !Number.isFinite(rightComponent)) {
          valid = false;
          break;
        }

        const startValue = leftComponent + (rightComponent - leftComponent) * startFraction;
        const endValue = leftComponent + (rightComponent - leftComponent) * endFraction;

        startSquaredNorm += startValue * startValue;
        endSquaredNorm += endValue * endValue;
        midpointSquaredNorm += ((startValue + endValue) / 2) ** 2;
      }

      if (!valid) {
        continue;
      }

      const startValue = Math.sqrt(startSquaredNorm);
      const endValue = Math.sqrt(endSquaredNorm);
      const midpoint = Math.sqrt(midpointSquaredNorm);

      if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) {
        continue;
      }

      validDuration += intervalDuration;

      // Squared vector magnitude is quadratic in time, so Simpson's rule is exact for its integral.
      // Magnitude itself is generally not polynomial: the corresponding mean is a Simpson approximation.
      squaredIntegral += (intervalDuration * (startSquaredNorm + 4 * midpointSquaredNorm + endSquaredNorm)) / 6;
      valueIntegral += (intervalDuration * (startValue + 4 * midpoint + endValue)) / 6;
      weightedMidpoints.push([midpoint, intervalDuration]);

      if (startValue > peakValue) {
        peakValue = startValue;
        result.maxTime = intervalStart;
      }

      if (endValue > peakValue) {
        peakValue = endValue;
        result.maxTime = intervalEnd;
      }

      continue;
    }

    // Scalar continuous channels use a linear segment. Held channels set both endpoints to the left value,
    // so commands and status do not become artificial ramps between updates.
    const leftValue = signal.values[leftRow];
    const rightValue = signal.kind === 'continuous' ? signal.values[rightRow] : leftValue;
    const startValue = leftValue + (rightValue - leftValue) * startFraction;
    const endValue = leftValue + (rightValue - leftValue) * endFraction;

    if (!Number.isFinite(startValue) || !Number.isFinite(endValue)) {
      continue;
    }

    validDuration += intervalDuration;

    // Exact integral of the squared linear scalar: duration * (start² + start*end + end²) / 3.
    squaredIntegral += (intervalDuration * (startValue * startValue + startValue * endValue + endValue * endValue)) / 3;
    valueIntegral += (intervalDuration * (startValue + endValue)) / 2;
    weightedMidpoints.push([(startValue + endValue) / 2, intervalDuration]);

    for (const [t, v] of [
      [intervalStart, startValue],
      [intervalEnd, endValue],
    ]) {
      if (v > peakValue) {
        peakValue = v;
        result.maxTime = t;
      }
    }
  }

  // Normalize by usable duration, not requested duration; coverage reports the excluded portion separately.
  if (validDuration) {
    result.rmse = Math.sqrt(squaredIntegral / validDuration);
    result.mean = valueIntegral / validDuration;
    result.duration = validDuration;
    result.coverage = validDuration / (end - start);

    // Approximate the time distribution with one midpoint per interval, weighted by that interval's duration.
    weightedMidpoints.sort((left, right) => left[0] - right[0]);

    let weight = 0;

    for (const [v, w] of weightedMidpoints) {
      weight += w;

      if (weight >= validDuration * 0.95) {
        result.p95 = v;
        break;
      }
    }
  }

  result.max = peakValue === -Infinity ? NaN : peakValue;

  return result;
}

/**
 * Shared min/max buckets preserve spikes of every visible series, plus transitions and gaps.
 *
 * Bucket the selected time interval into horizontal pixel columns. Keep each bucket's first and last row and each
 * series' minimum and maximum, plus both sides of held-value and finite/non-finite transitions.
 *
 * @param time Nondecreasing raw timestamps in simulation seconds.
 * @param values Series arrays aligned one-to-one with time.
 * @param start Inclusive visible interval start in seconds.
 * @param end Inclusive visible interval end in seconds.
 * @param pixels Positive bucket count, normally the chart width; defaults to 900.
 * @param kinds Interpolation kind per series; 'held' causes every value transition to be retained.
 * @returns Unique raw row indices in ascending order. Transition preservation can exceed the pixel budget.
 * @remarks This reduces display geometry only; statistical calculations continue to use full-resolution data. Inputs
 *   are not modified.
 */
export function decimate(
  time: Float64Array,
  values: Float64Array[],
  start: number,
  end: number,
  pixels = 900,
  kinds: string[] = [],
): number[] {
  const retainedRows = new Set<number>();
  const bucketExtrema = new Map<number, number[]>();
  const span = end - start || 1;

  for (let i = 0; i < time.length; i++) {
    if (time[i] < start || time[i] > end) {
      continue;
    }

    const bucketIndex = Math.min(pixels - 1, Math.floor(((time[i] - start) / span) * pixels));
    let extrema = bucketExtrema.get(bucketIndex);

    // Bucket storage layout: [firstRow, lastRow, series0MinRow, series0MaxRow, series1MinRow, ...].
    if (!extrema) {
      extrema = [i, i, ...values.flatMap(() => [i, i])];
      bucketExtrema.set(bucketIndex, extrema);
    }

    extrema[1] = i;

    // Keep a shared row set for every plotted channel so the chart uses a single synchronized time array.
    values.forEach((seriesValues, seriesIndex) => {
      const minSlot = 2 + seriesIndex * 2;
      const maxSlot = 3 + seriesIndex * 2;

      if (seriesValues[i] < seriesValues[extrema![minSlot]] || !Number.isFinite(seriesValues[extrema![minSlot]])) {
        extrema![minSlot] = i;
      }

      if (seriesValues[i] > seriesValues[extrema![maxSlot]] || !Number.isFinite(seriesValues[extrema![maxSlot]])) {
        extrema![maxSlot] = i;
      }

      // Retain both sides of gaps and held-value jumps even when they occur between bucket extrema.
      if (
        i &&
        (!Number.isFinite(seriesValues[i]) !== !Number.isFinite(seriesValues[i - 1]) ||
          (kinds[seriesIndex] === 'held' && seriesValues[i] !== seriesValues[i - 1]))
      ) {
        retainedRows.add(i);
        retainedRows.add(i - 1);
      }
    });
  }

  // Merge the extrema with transition rows, then sort once to preserve the original sample order.
  for (const extremaRows of bucketExtrema.values()) {
    for (const i of extremaRows) {
      retainedRows.add(i);
    }
  }

  return [...retainedRows].sort((leftRow, rightRow) => leftRow - rightRow);
}
