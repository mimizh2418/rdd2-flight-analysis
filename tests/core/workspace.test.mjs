import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, findField, incompatibility } from '../../.test-build/src/workspace/fieldCatalog.js';
import { prepareField } from '../../.test-build/src/workspace/preparation.js';
import {
  createTab,
  createBinding,
  validateWorkspace,
  reattachTabs,
} from '../../.test-build/src/workspace/workspaceState.js';
import { fieldTree, filterFieldTree } from '../../.test-build/src/workspace/fieldTree.js';
import { createRun } from './support.mjs';

test('path preparation preserves gaps and reference resets instead of connecting them', async () => {
  const run = createRun({
    time_s: Float64Array.from([0, 1, 2, 10]),
    'position_m[1]': Float64Array.from([0, 1, NaN, 10]),
    'position_m[2]': new Float64Array(4),
    'position_m[3]': new Float64Array(4),
  });

  run.gapLimit = 2;

  const field = findField(buildCatalog([run]), run.id, 'vector:position');
  const result = await prepareField(
    run,
    field,
    () => {},
    () => false,
  );

  assert.deepEqual([...result.path.times], [1]);
  assert.deepEqual([...result.path.positions], [0, 0, 0, 1, 0, 0]);
  assert.deepEqual(result.path.bounds.max, [10, 0, 0]);

  const reference = createRun({
    'avionics.reference.position[1]': Float64Array.from([0, 1, 2]),
    'avionics.reference.position[2]': new Float64Array(3),
    'avionics.reference.position[3]': new Float64Array(3),
    'avionics.reference.trajectoryTime': Float64Array.from([0, 1, 0]),
  });
  const history = await prepareField(
    reference,
    findField(buildCatalog([reference]), reference.id, 'vector:reference.position'),
    () => {},
    () => false,
  );

  assert.deepEqual([...history.path.times], [1]);
});

test('static mission path falls back to waypoints and field jobs yield and cancel', async () => {
  const run = createRun();

  run.manifest = {
    schema: 'rdd2-viewer-v1',
    mission: {
      trajectory: [],
      waypoints: [
        [0, 0, 0],
        [2, 0, 1],
      ],
    },
  };

  const field = findField(buildCatalog([run]), run.id, 'mission:plan');
  const plan = await prepareField(
    run,
    field,
    () => {},
    () => false,
  );

  assert.deepEqual([...plan.path.positions], [0, 0, 0, 2, 0, 1]);
  assert.equal(plan.path.times[0], -Infinity);

  // A queued timer must run during preparation, proving that a field job yields to the event loop.
  let ticked = false;

  setTimeout(() => {
    ticked = true;
  }, 0);
  await prepareField(
    run,
    findField(buildCatalog([run]), run.id, 'position.0'),
    () => {},
    () => false,
  );

  assert.equal(ticked, true);

  // Cancellation must reject the job rather than publish a partially prepared field.
  await assert.rejects(
    prepareField(
      run,
      field,
      () => {},
      () => true,
    ),
    { name: 'AbortError' },
  );
});

test('workspace identities reattach exact content and reject malformed configuration', () => {
  const run = createRun();

  run.csvHash = 'a'.repeat(64);

  const tab = createTab('trajectory', 'Test');

  tab.bindings.push(createBinding(findField(buildCatalog([run]), run.id, 'vector:position'), 'paths', 0));

  const document = {
    schema: 'rdd2-workspace-v1',
    runs: [{ id: run.id, name: run.name, fingerprint: run.csvHash, rows: 3, start: 0, end: 2 }],
    tabs: [tab],
    active: tab.id,
    time: 1,
    window: [0, 2],
    alignment: 'absolute',
    browserWidth: 290,
    dockHeight: 250,
  };

  assert.equal(validateWorkspace(document).tabs[0].id, tab.id);

  const reimport = { ...run, id: 'reimported' };

  // Content hashes reconnect a new import identity; identical metadata with different bytes cannot reattach.
  assert.equal(reattachTabs(document, [reimport])[0].bindings[0].runId, 'reimported');
  assert.equal(reattachTabs(document, [{ ...reimport, csvHash: 'b'.repeat(64) }])[0].bindings[0].runId, run.id);
  assert.throws(() => validateWorkspace({ ...document, window: [2, 0] }), /clock/);
  assert.throws(
    () =>
      validateWorkspace({ ...document, tabs: [{ ...tab, bindings: [{ ...tab.bindings[0], display: 'invalid' }] }] }),
    /binding/,
  );
  assert.throws(
    () => validateWorkspace({ ...document, tabs: [{ ...tab, bindings: [{ ...tab.bindings[0], scale: NaN }] }] }),
    /binding/,
  );
});

test('field hierarchy nests pose vectors and their selectable scalar components without duplication', () => {
  const run = createRun({
    roll_rad: new Float64Array(3),
    pitch_rad: new Float64Array(3),
    yaw_rad: new Float64Array(3),
  });
  const fields = buildCatalog([run]);
  const tree = fieldTree(fields);
  const truth = tree.find((node) => node.label === 'Truth');
  const pose = truth.children.find((node) => node.field?.id === 'pose:position');

  assert.deepEqual(
    pose.children.map((node) => node.field.id),
    ['vector:position', 'orientation:q'],
  );
  assert.deepEqual(
    pose.children[0].children.map((node) => node.field.id),
    ['position.0', 'position.1', 'position.2'],
  );
  assert.ok(pose.children[1].children.some((node) => node.field.id === 'rpy.2'));

  /**
   * Collect selectable identities from the complete metadata hierarchy.
   * @param {FieldNode[]} nodes Current children.
   * @returns {string[]} Catalog identities in traversal order.
   */
  const identities = (nodes) =>
    nodes.flatMap((node) => [...(node.field ? [node.field.id] : []), ...identities(node.children)]);
  const ids = identities(tree);

  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, new Set(fields.map((field) => field.id)).size);
  assert.ok(identities(filterFieldTree(tree, 'east position')).includes('position.0'));
  assert.ok(filterFieldTree(tree, 'no-such-channel').length === 0);
});

test('diagnostic vectors retain component order and units without fabricating missing components', () => {
  const columns = {};

  for (let axis = 1; axis <= 3; axis++) {
    columns[`velocity_m_s[${axis}]`] = new Float64Array(3).fill(axis === 1 ? 1 : 0);
    columns[`avionics.reference.position[${axis}]`] = new Float64Array(3);
    columns[`avionics.reference.velocity[${axis}]`] = new Float64Array(3);
    columns[`estimator.estimate.positionWorldEnu_m[${axis}]`] = new Float64Array(3).fill(3);
    columns[`estimator.estimate.velocityWorldEnu_m_s[${axis}]`] = new Float64Array(3).fill(2);
  }

  const run = createRun(columns);
  const fields = buildCatalog([run]);
  for (const [prefix, unit] of [
    ['tracking', 'm'],
    ['velocityError', 'm/s'],
    ['estimation', 'm'],
    ['velocityEstimation', 'm/s'],
  ]) {
    const vector = findField(fields, run.id, `vector:${prefix}`);

    assert.equal(vector.unit, unit);
    assert.deepEqual(
      vector.signals,
      [0, 1, 2].map((axis) => `${prefix}.${axis}`),
    );
    assert.equal(incompatibility(vector, 'graph', 'left'), '');
    assert.notEqual(incompatibility(vector, 'trajectory', 'spatial'), '');
  }
  const error = findField(fields, run.id, 'vector:tracking');

  // Partial data keeps available components selectable without fabricating a complete vector.
  delete run.signals['tracking.2'];

  const partial = buildCatalog([run]);

  assert.equal(findField(partial, run.id, error.id), undefined);
  assert.ok(findField(partial, run.id, 'tracking.0'));
});
