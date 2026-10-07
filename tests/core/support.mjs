import assert from 'node:assert/strict';
import { normalizeRun } from '../../.test-build/src/data/normalize.js';

/** @typedef {import('../../src/data/types').Run} Run */
/** @typedef {import('../../src/workspace/types').PlotSeries} PlotSeries */

/**
 * Assert numerical agreement within an absolute tolerance, including a useful mismatch message.
 *
 * @param {number} actual Calculated value.
 * @param {number} expected Expected value in the same unit.
 * @param {number} tolerance Absolute error tolerance; defaults to 1e-9.
 * @returns {void} Passes silently when values agree.
 * @throws {AssertionError} If the absolute difference exceeds tolerance or either value is NaN.
 */
export function assertClose(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}

/**
 * Create a small constant-velocity ENU run, allowing individual source columns to be overridden.
 *
 * @param {Record<string, Float64Array>} columns Additional/replacement source columns aligned to the three-row fixture.
 * @returns {Run} Fresh normalized fixture at 0, 1, and 2 seconds with Eastward motion and zero North/Up coordinates.
 * @remarks Supply every coordinate column when overriding the fixture with a different row count.
 */
export function createRun(columns = {}) {
  return normalizeRun(
    {
      time_s: Float64Array.from([0, 1, 2]),
      'position_m[1]': Float64Array.from([0, 1, 2]),
      'position_m[2]': new Float64Array(3),
      'position_m[3]': new Float64Array(3),
      ...columns,
    },
    'test',
  );
}

/**
 * Expand one fixture scalar into the worker graph-request contract.
 * @param {Run} run Normalized immutable fixture.
 * @param {string} signalId Scalar key in the source registry.
 * @param {'left' | 'right'} lane Independently scaled destination axis.
 * @param {number} factor Explicit display conversion multiplier.
 * @returns {PlotSeries} Series metadata without copied telemetry arrays.
 */
export const createPlotSeries = (run, signalId, lane = 'left', factor = 1) => ({
  bindingId: 'fixture',
  runId: run.id,
  signalId,
  label: signalId,
  lane,
  color: '#ffffff',
  style: 'solid',
  width: 2,
  markers: false,
  unit: run.signals[signalId].unit,
  kind: run.signals[signalId].kind,
  offset: 0,
  factor,
});
