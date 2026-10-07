import test from 'node:test';
import assert from 'node:assert/strict';
import { bindingAttitude } from '../../.test-build/src/scene/WorkspaceScene.js';
import { drone, updateModelAttitude } from '../../.test-build/src/scene/models.js';
import { buildCatalog, findField } from '../../.test-build/src/workspace/fieldCatalog.js';
import { createBinding } from '../../.test-build/src/workspace/workspaceState.js';
import { fromRpy, toRpy } from '../../.test-build/src/math/rotation.js';
import { assertClose, createRun } from './support.mjs';

/** Create a reference whose heading changes at one second, alongside an independently tilted truth vehicle. */
function referenceRun(yaw = Float64Array.from([0.2, 1.2, -0.4])) {
  return createRun({
    'avionics.reference.position[1]': Float64Array.from([0, 1, 2]),
    'avionics.reference.position[2]': new Float64Array(3),
    'avionics.reference.position[3]': new Float64Array(3),
    'avionics.reference.yaw': yaw,
    roll_rad: Float64Array.from([0.3, 0.3, 0.3]),
    pitch_rad: Float64Array.from([-0.2, -0.2, -0.2]),
    yaw_rad: Float64Array.from([0.7, 0.7, 0.7]),
  });
}

test('reference models default to drones and use aligned held yaw without roll or pitch', () => {
  const run = referenceRun();
  const fields = buildCatalog([run]);
  const offsets = new Map([[run.id, 0.25]]);

  // Both the reference pose aggregate and its position child use the same orientation convention.
  for (const id of ['pose:reference.position', 'vector:reference.position']) {
    const field = findField(fields, run.id, id);
    const binding = createBinding(field, 'spatial', 0);

    assert.equal(binding.model, 'drone');

    for (const [time, expectedYaw] of [
      [0.5, 0.2],
      [0.75, 1.2],
    ]) {
      const angles = toRpy(bindingAttitude(binding, field, fields, [run], offsets, time));

      angles.forEach((value, axis) => assertClose(value, axis === 2 ? expectedYaw : 0));
    }
  }

  assert.equal(run.signals['reference.yaw'].kind, 'held');
  assert.deepEqual([...run.signals['reference.yaw'].values], [0.2, 1.2, -0.4]);
});

test('truth and independently aligned estimated attitude overrides take precedence over reference yaw', () => {
  const reference = referenceRun();
  const estimatedQuaternion = fromRpy([-0.5, 0.1, -0.8]);
  const estimate = createRun({
    'estimator.estimate.valid': Float64Array.from([1, 1, 1]),
    ...Object.fromEntries(
      [estimatedQuaternion[3], ...estimatedQuaternion.slice(0, 3)].map((value, axis) => [
        `estimator.estimate.quaternionWorldBody[${axis + 1}]`,
        Float64Array.from([value, value, value]),
      ]),
    ),
  });
  const runs = [reference, estimate];
  const fields = buildCatalog(runs);
  const field = findField(fields, reference.id, 'pose:reference.position');
  const binding = createBinding(field, 'spatial', 0);
  const offsets = new Map([
    [reference.id, 0],
    [estimate.id, 0.5],
  ]);

  for (const [runId, fieldId, expected] of [
    [reference.id, 'orientation:q', [0.3, -0.2, 0.7]],
    [estimate.id, 'orientation:estimate.q', [-0.5, 0.1, -0.8]],
  ]) {
    const angles = toRpy(
      bindingAttitude({ ...binding, orientation: { runId, fieldId } }, field, fields, runs, offsets, 0.5),
    );

    angles.forEach((value, axis) => assertClose(value, expected[axis]));
  }
});

test('reference drones stay visible when yaw is missing or an orientation override becomes unavailable', () => {
  const run = referenceRun(Float64Array.from([NaN, NaN, NaN]));
  const fields = buildCatalog([run]);
  const field = findField(fields, run.id, 'pose:reference.position');
  const binding = createBinding(field, 'spatial', 0);
  const offsets = new Map([[run.id, 0]]);

  assert.deepEqual(bindingAttitude(binding, field, fields, [run], offsets, 1), [0, 0, 0, 1]);
  delete run.signals['reference.yaw'];
  assert.deepEqual(bindingAttitude(binding, field, fields, [run], offsets, 1), [0, 0, 0, 1]);

  for (const ghost of [false, true]) {
    const model = drone(0x74dde3, undefined, ghost);
    const override = { ...binding, orientation: { runId: run.id, fieldId: 'none' } };
    const q = bindingAttitude(override, field, fields, [run], offsets, 1);

    assert.equal(updateModelAttitude(model, q, true), false);
    assert.equal(model.userData.body.visible, true);
    assert.equal(model.userData.fallback.visible, false);
    assert.deepEqual(model.quaternion.toArray(), [0, 0, 0, 1]);

    // Truth/estimate models retain their existing missing-attitude fallback.
    updateModelAttitude(model, q);
    assert.equal(model.userData.body.visible, false);
    assert.equal(model.userData.fallback.visible, true);
  }
});
