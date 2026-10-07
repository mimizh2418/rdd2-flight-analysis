import test from 'node:test';
import assert from 'node:assert/strict';
import { parseText } from '../../.test-build/src/data/csv.js';
import { normalizeRun, resolve } from '../../.test-build/src/data/normalize.js';
import { fromRpy, toMatrix } from '../../.test-build/src/math/rotation.js';
import { buildCatalog, findField, fieldValue } from '../../.test-build/src/workspace/fieldCatalog.js';
import { createTab, createBinding, dropReason } from '../../.test-build/src/workspace/workspaceState.js';
import { fieldTree } from '../../.test-build/src/workspace/fieldTree.js';
import { assertClose, createRun } from './support.mjs';

test('suffix resolution is deterministic and ambiguous suffixes fail', () => {
  assert.equal(resolve(['x.p', 'p'], 'p'), 'p');
  assert.throws(() => resolve(['x.p', 'y.p'], 'p'));
});

test('canonical trajectory derives velocity without dividing by epsilon time', () => {
  const run = normalizeRun(
    parseText(
      [
        'time_s,x_m,y_m,z_m,roll_rad,pitch_rad,yaw_rad',
        '0,0,0,1,0,0,0',
        '1,1,0,1,0,0,0',
        '1.0000000000000002,1,0,1,0,0,0',
        '2,2,0,1,0,0,0',
      ].join('\n'),
    ),
    'pose',
  );

  assertClose(run.signals['velocity.0'].values[2], 1);
  assert.ok(run.capabilities.includes('pose'));
});

test('tracking is distinct from estimator feedback error', () => {
  const run = createRun({
    'avionics.reference.position[1]': new Float64Array(3),
    'avionics.reference.position[2]': new Float64Array(3),
    'avionics.reference.position[3]': new Float64Array(3),
    navigationError_m: new Float64Array(3),
  });

  assertClose(run.signals['tracking.norm'].values[2], 2);
  assertClose(run.signals['navigation.error'].values[2], 0);
});

test('rotated anisotropic covariance bands use ENU frame and NEES native ticks', () => {
  const fixture = createRun();
  const columns = {
    time_s: fixture.time,
    estimatorUpdatePeriod_s: Float64Array.from([1, 1, 1]),
    'estimator.estimate.valid': Float64Array.from([1, 1, 0]),
  };

  for (let row = 1; row <= 3; row++) {
    columns[`position_m[${row}]`] = new Float64Array(3);
    columns[`velocity_m_s[${row}]`] = new Float64Array(3);
    columns[`estimator.estimate.positionWorldEnu_m[${row}]`] = Float64Array.from([
      row === 2 ? 2 : 0,
      row === 2 ? 2 : 0,
      row === 2 ? 2 : 0,
    ]);
    columns[`estimator.estimate.velocityWorldEnu_m_s[${row}]`] = new Float64Array(3);
  }

  const rotation = toMatrix(fromRpy([0, 0, Math.PI / 2]));

  // A quarter-turn yaw swaps the anisotropic East/North position variances when transformed into ENU.
  for (let row = 1; row <= 3; row++) {
    for (let column = 1; column <= 3; column++) {
      columns[`estimator.estimate.rotationWorldBody[${row},${column}]`] = new Float64Array(3).fill(
        rotation[(row - 1) * 3 + column - 1],
      );
    }
  }

  // Navigation covariance stores position followed by velocity in a 6×6 matrix.
  for (let row = 1; row <= 6; row++) {
    for (let column = 1; column <= 6; column++) {
      columns[`estimator.navigationCovarianceLocal[${row},${column}]`] = new Float64Array(3).fill(
        row === column ? [4, 9, 16, 1, 1, 1][row - 1] : 0,
      );
    }
  }

  const result = normalizeRun(columns, 'covariance');

  assertClose(result.signals['sigma.0'].values[1], 3);
  assertClose(result.signals['sigma.1'].values[1], 2);
  assertClose(result.signals.nees.values[1], 1);

  // Covariance vectors must preserve ENU axis order and separate metre and metre/second quantities.
  const fields = buildCatalog([result]);
  const position = findField(fields, result.id, 'vector:sigma.position');
  const velocity = findField(fields, result.id, 'vector:sigma.velocity');
  const upper = findField(fields, result.id, 'vector:uncertainty.upper.position');
  const lower = findField(fields, result.id, 'vector:uncertainty.lower.velocity');

  assert.equal(fieldValue(position, result, 1), '[3.000, 2.000, 4.000] m');
  assert.equal(fieldValue(velocity, result, 1), '[1.000, 1.000, 1.000] m/s');
  assert.equal(fieldValue(upper, result, 1), '[5.880, 3.920, 7.840] m');
  assert.equal(fieldValue(lower, result, 1), '[-1.960, -1.960, -1.960] m/s');
  assert.equal(fieldValue(position, result, 2), '—');
  assert.equal(fieldValue(lower, result, 2), '—');

  const graph = createTab('graph');

  graph.bindings.push(createBinding(position, 'left', 0));

  assert.notEqual(dropReason(graph, velocity, 'left', fields), '');
  assert.equal(dropReason(graph, velocity, 'right', fields), '');

  const diagnostics = fieldTree(fields).find((node) => node.label === 'Derived diagnostics');
  const uncertainty = diagnostics.children.find((node) => node.label === 'Uncertainty');
  const positionGroup = uncertainty.children.find((node) => node.label === 'Position');
  const velocityGroup = uncertainty.children.find((node) => node.label === 'Velocity');

  assert.ok(positionGroup.children.every((node) => node.field.unit === 'm'));
  assert.ok(velocityGroup.children.every((node) => node.field.unit === 'm/s'));
  assert.deepEqual(
    velocityGroup.children.find((node) => node.field.id === velocity.id).children.map((node) => node.field.id),
    ['sigma.3', 'sigma.4', 'sigma.5'],
  );
});
