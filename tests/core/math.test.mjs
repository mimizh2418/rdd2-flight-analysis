import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fromRpy,
  toRpy,
  toMatrix,
  fromMatrix,
  slerp,
  angleError,
  quadraticForm,
} from '../../.test-build/src/math/rotation.js';
import { summarize, decimate } from '../../.test-build/src/math/statistics.js';
import { PathDistance } from '../../.test-build/src/math/path.js';
import { assertClose, createRun } from './support.mjs';

test('basis rotations and public RPY ordering', () => {
  for (const [rpy, expected] of [
    [
      [0, 0, Math.PI / 2],
      [0, 1, 0],
    ],
    [
      [0, Math.PI / 2, 0],
      [0, 0, -1],
    ],
    [
      [Math.PI / 2, 0, 0],
      [1, 0, 0],
    ],
  ]) {
    const matrix = toMatrix(fromRpy(rpy));

    // The first rotation-matrix column is the body X axis expressed in world coordinates.
    [matrix[0], matrix[3], matrix[6]].forEach((component, index) => assertClose(component, expected[index]));

    assertClose(angleError(fromRpy(rpy), fromMatrix(matrix)), 0);
  }
});

test('quaternion sign flip and wrapped yaw interpolation', () => {
  const beforeWrap = fromRpy([0, 0, Math.PI - 0.1]);
  const afterWrap = fromRpy([0, 0, -Math.PI + 0.1]);

  // Interpolation must take the short arc across the yaw wrap; opposite quaternion signs describe one rotation.
  assertClose(Math.abs(toRpy(slerp(beforeWrap, afterWrap, 0.5))[2]), Math.PI);
  assertClose(
    angleError(
      beforeWrap,
      beforeWrap.map((component) => -component),
    ),
    0,
  );
});

test('time-weighted analytic RMSE, interval clipping, duplicate event peak', () => {
  const run = createRun();
  const result = summarize(run, 'position.0', 0.5, 1.5);

  // The fixture is x(t) = t, so integrating x² over this one-second interval gives 13/12.
  assertClose(result.mean, 1);
  assertClose(result.rmse, Math.sqrt(13 / 12));
  assertClose(result.coverage, 1);
  assertClose(result.max, 1.5);
});

test('discrete jumps integrate held left value, not ramp', () => {
  const run = createRun({ 'motorCommand[1]': Float64Array.from([0, 1, 0]) });

  assertClose(summarize(run, 'motor.0', 0, 2).mean, 0.5);
});

test('vector summaries exclude intervals with a missing axis', () => {
  const run = createRun({
    'position_m[2]': Float64Array.from([NaN, 0, 0]),
    ...Object.fromEntries([1, 2, 3].map((axis) => [`avionics.reference.position[${axis}]`, new Float64Array(3)])),
  });
  const result = summarize(run, 'tracking.norm', 0, 2);

  assertClose(result.coverage, 0.5);
  assertClose(result.duration, 1);
  assertClose(result.rmse, Math.sqrt(7 / 3));

  // Removing one complete axis leaves no valid interval for a vector magnitude.
  run.signals['tracking.1'].values.fill(NaN);

  const missing = summarize(run, 'tracking.norm', 0, 2);

  assertClose(missing.coverage, 0);
  assert.ok(Number.isNaN(missing.rmse));
});

test('path geometry handles zero segments, gaps, crossings, and horizontal distance', () => {
  const path = new PathDistance([[0, 0, 0], [0, 0, 0], [2, 0, 0], null, [100, 0, 0], [100, 1, 0]]);

  assertClose(path.distance([1, 1, 2]), Math.sqrt(5));
  assertClose(path.distance([1, 1, 2], true), 1);
  assertClose(path.distance([50, 0, 0]), 48);
});

test('Cholesky quadratic form rejects singular and indefinite covariance', () => {
  assertClose(quadraticForm([4, 0, 0, 9], [2, 3]), 2);
  assert.ok(Number.isNaN(quadraticForm([0, 0, 0, 1], [1, 1])));
  assert.ok(Number.isNaN(quadraticForm([-1, 0, 0, 1], [1, 1])));
});

test('decimation preserves spike and discrete transitions', () => {
  const times = Float64Array.from({ length: 100 }, (_, row) => row);
  const values = new Float64Array(100);

  values[42] = 100;

  assert.ok(decimate(times, [values], 0, 99, 5).includes(42));

  // A held signal needs both samples surrounding a transition to retain the step after decimation.
  values.fill(0);
  values.fill(1, 23);

  const retainedRows = decimate(times, [values], 0, 99, 5, ['held']);

  assert.ok(retainedRows.includes(22) && retainedRows.includes(23));
});
