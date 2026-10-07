import test from 'node:test';
import assert from 'node:assert/strict';
import { fullPathTolerance, simplifyFullPath } from '../../.test-build/src/workspace/pathGeometry.js';
import { prepareField } from '../../.test-build/src/workspace/preparation.js';
import { buildCatalog, findField } from '../../.test-build/src/workspace/fieldCatalog.js';
import { sample } from '../../.test-build/src/playback/time.js';
import { createRun } from './support.mjs';

/** Pack a polyline into the endpoint pairs consumed by Three.js thick-line geometry. */
function segments(points) {
  return Float32Array.from(points.slice(1).flatMap((point, index) => [...points[index], ...point]));
}

/** Compute a point's distance from an output chord independently of the simplifier. */
function distance(point, start, end) {
  const direction = end.map((value, axis) => value - start[axis]);
  const relative = point.map((value, axis) => value - start[axis]);
  const squaredLength = direction.reduce((sum, value) => sum + value * value, 0);
  const fraction = squaredLength
    ? Math.max(0, Math.min(1, relative.reduce((sum, value, axis) => sum + value * direction[axis], 0) / squaredLength))
    : 0;

  return Math.hypot(...relative.map((value, axis) => value - direction[axis] * fraction));
}

test('stationary and GPU-identical samples produce no empty segments while telemetry and bounds remain exact', async () => {
  const positions = Float64Array.from([2, 2, 2 + 1e-9, 2.01, 2.01, 2.02]);
  const original = positions.slice();
  const run = createRun({
    time_s: Float64Array.from([0, 0.01, 0.02, 0.03, 0.04, 0.05]),
    'position_m[1]': positions,
    'position_m[2]': new Float64Array(6),
    'position_m[3]': new Float64Array(6),
    'avionics.reference.position[1]': positions,
    'avionics.reference.position[2]': new Float64Array(6),
    'avionics.reference.position[3]': new Float64Array(6),
  });
  const result = await prepareField(
    run,
    findField(buildCatalog([run]), run.id, 'vector:reference.position'),
    () => {},
    () => false,
  );

  assert.deepEqual([...result.path.times], [0.03, 0.05]);
  assert.deepEqual(
    result.path.positions,
    segments([
      [2, 0, 0],
      [2.01, 0, 0],
      [2.02, 0, 0],
    ]),
  );
  assert.deepEqual(
    result.path.fullPositions,
    segments([
      [2, 0, 0],
      [2.02, 0, 0],
    ]),
  );
  assert.deepEqual(result.path.bounds, { min: [2, 0, 0], max: [2.02, 0, 0] });
  assert.deepEqual(positions, original);
  assert.equal(sample(run, 'reference.position.0', 0.025), 2 + 1e-9);
  assert.equal(run.signals['reference.position.0'].kind, 'held');
});

test('full-path geometry retains corners, disconnected paths, and the spatial error bound', async () => {
  const curve = Array.from({ length: 1001 }, (_, index) => {
    const angle = (index / 1000) * Math.PI * 0.5;

    return [0.01 * Math.cos(angle), 0.01 * Math.sin(angle), 0];
  });
  const corner = [
    [3, 0, 0],
    [4, 0, 0],
    [4, 1, 0],
  ];
  const input = Float32Array.from([...segments(curve), ...segments(corner)]);
  const original = input.slice();
  const output = await simplifyFullPath(
    input,
    async () => {},
    () => {},
  );
  const chords = Array.from({ length: output.length / 6 }, (_, index) => [
    [...output.slice(index * 6, index * 6 + 3)],
    [...output.slice(index * 6 + 3, index * 6 + 6)],
  ]);

  assert.ok(output.length < input.length / 10);
  assert.deepEqual(input, original);
  assert.deepEqual([...output.slice(-12)], [...segments(corner)]);

  for (let index = 0; index < input.length; index += 3) {
    const point = [...input.slice(index, index + 3)];
    const error = Math.min(...chords.map(([start, end]) => distance(point, start, end)));

    assert.ok(error <= fullPathTolerance * 1.000001, `Geometry error ${error} exceeds ${fullPathTolerance}`);
  }

  assert.ok(
    chords.every(([start, end]) => start[0] < 1 === end[0] < 1),
    'Disconnected paths must not be joined',
  );
});

test('geometry reduction yields and cancels while indexing a long polyline', async () => {
  const input = segments(Array.from({ length: 10000 }, (_, index) => [index / 10000, 0, 0]));
  let yielded = 0;

  await assert.rejects(
    simplifyFullPath(
      input,
      async () => {
        yielded++;
        throw new DOMException('Cancelled', 'AbortError');
      },
      () => {},
    ),
    { name: 'AbortError' },
  );
  assert.equal(yielded, 1);
});
