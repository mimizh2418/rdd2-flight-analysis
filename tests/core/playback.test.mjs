import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRun } from '../../.test-build/src/data/normalize.js';
import { eventIndex, sample, attitude } from '../../.test-build/src/playback/time.js';
import { summarize } from '../../.test-build/src/math/statistics.js';
import { assertClose, createRun } from './support.mjs';

test('events preserve final near-equal row; reverse and non-finite time rejected', () => {
  // Roundoff-separated event rows share one playback instant; its last raw row wins.
  assert.deepEqual([...eventIndex(Float64Array.from([0, 0.0012499999999999998, 0.00125, 0.0025]))], [0, 2, 3]);
  assert.throws(() => eventIndex(Float64Array.from([1, 0])));
  assert.throws(() => eventIndex(Float64Array.from([0, NaN])));
});

test('continuous interpolation, held commands, no extrapolation', () => {
  const run = createRun({ 'motorCommand[1]': Float64Array.from([0, 1, 0]) });

  assertClose(sample(run, 'position.0', 0.5), 0.5);
  assertClose(sample(run, 'motor.0', 0.5), 0);
  assert.ok(Number.isNaN(sample(run, 'position.0', -1)));
});

test('invalid quaternions do not become identity', () => {
  const run = createRun(
    Object.fromEntries(
      [1, 2, 3, 4].map((component) => [`plant.truth.quaternionWorldBody[${component}]`, new Float64Array(3)]),
    ),
  );

  assert.ok(attitude(run, 'q', 1).every(Number.isNaN));
});

test('invalid-data gap is excluded from summary and playback', () => {
  const run = createRun();

  run.gapLimit = 0.1;

  assert.ok(Number.isNaN(sample(run, 'position.0', 0.5)));
  assertClose(summarize(run, 'position.0', 0, 2).coverage, 0);
});

test('continuous interpolation respects both sides of an event', () => {
  const run = normalizeRun(
    {
      time: Float64Array.from([0, 1, 1, 2]),
      'position_m[1]': Float64Array.from([0, 1, 10, 11]),
      'position_m[2]': new Float64Array(4),
      'position_m[3]': new Float64Array(4),
    },
    'events',
  );

  // Interpolate up to the pre-event value, select the post-event value at the jump, then resume interpolation.
  assertClose(sample(run, 'position.0', 0.5), 0.5);
  assertClose(sample(run, 'position.0', 1), 10);
  assertClose(sample(run, 'position.0', 1.5), 10.5);

  const result = summarize(run, 'position.0', 0, 2);

  assertClose(result.mean, 5.5);
  assertClose(result.rmse, Math.sqrt(166 / 3));
});
