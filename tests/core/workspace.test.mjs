import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, findField, incompatibility, fieldValue } from '../../.test-build/src/workspace/fieldCatalog.js';
import { spatialDisplay, spatialLayers } from '../../.test-build/src/workspace/spatial.js';
import { prepareField } from '../../.test-build/src/workspace/preparation.js';
import {
  createTab,
  createBinding,
  dropReason,
  validateWorkspace,
  reattachTabs,
  initialTabs,
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

test('typed field drops reject incompatible units without partially mutating the tab', () => {
  const run = createRun();
  const fields = buildCatalog([run]);
  const position = findField(fields, run.id, 'vector:position');
  const velocity = findField(fields, run.id, 'vector:velocity');
  const graph = createTab('graph', 'Test');

  graph.bindings.push(createBinding(position, 'left', 0));

  assert.match(dropReason(graph, velocity, 'left', fields), /other axis/);
  assert.equal(dropReason(graph, velocity, 'right', fields), '');
  assert.equal(graph.bindings.length, 1);
  assert.match(incompatibility(findField(fields, run.id, 'position.0'), 'trajectory', 'paths'), /position vector/);
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

test('diagnostic hierarchy separates motion, tracking, and estimation with graph-only ENU error vectors', () => {
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
  const tree = fieldTree(fields);
  const diagnostics = tree.find((node) => node.label === 'Derived diagnostics');
  const tracking = diagnostics.children.find((node) => node.label === 'Tracking');
  const estimation = diagnostics.children.find((node) => node.label === 'Estimation');

  assert.ok(diagnostics.children.some((node) => node.label === 'Motion'));
  assert.ok(tracking.children.some((node) => node.label === 'Recorded path distance'));

  for (const [parent, prefix, category, unit] of [
    [tracking, 'tracking', 'Position error', 'm'],
    [tracking, 'velocityError', 'Velocity error', 'm/s'],
    [estimation, 'estimation', 'Position error', 'm'],
    [estimation, 'velocityEstimation', 'Velocity error', 'm/s'],
  ]) {
    const group = parent.children.find((node) => node.label === category);
    const vector = group.children.find((node) => node.field?.id === `vector:${prefix}`);

    assert.equal(vector.field.unit, unit);
    assert.deepEqual(
      vector.children.map((node) => node.field.id),
      [0, 1, 2].map((axis) => `${prefix}.${axis}`),
    );
    assert.ok(group.children.some((node) => node.field.id === `${prefix}.norm`));
    assert.ok(group.children.some((node) => node.field.id === `${prefix}.horizontal`));
    assert.equal(incompatibility(vector.field, 'graph', 'left'), '');
    assert.notEqual(incompatibility(vector.field, 'trajectory', 'spatial'), '');
    assert.notEqual(incompatibility(vector.field, 'vehicle', 'overlays'), '');
  }

  const error = findField(fields, run.id, 'vector:tracking');

  assert.equal(fieldValue(error, run, 1), '[1.000, 0.000, 0.000] m');
  assert.ok(filterFieldTree(tree, 'east tracking error').length > 0);

  // Partial data keeps available components selectable without fabricating a complete vector.
  delete run.signals['tracking.2'];

  const partial = buildCatalog([run]);

  assert.equal(findField(partial, run.id, error.id), undefined);
  assert.ok(findField(partial, run.id, 'tracking.0'));
});

test('retired demo references are migrated out of saved workspaces', () => {
  const run = createRun();
  const tab = createTab('trajectory', 'Trajectory 1');

  tab.bindings.push(createBinding(findField(buildCatalog([run]), run.id, 'vector:position'), 'paths', 0));

  const migrated = validateWorkspace({
    schema: 'rdd2-workspace-v1',
    runs: [{ id: run.id, name: 'Synthetic example', fingerprint: 'builtin:analytic-v1', rows: 3, start: 0, end: 2 }],
    tabs: [tab],
    active: tab.id,
    time: 1,
    window: [0, 2],
    alignment: 'absolute',
    browserWidth: 290,
    dockHeight: 250,
  });

  assert.deepEqual(migrated.runs, []);
  assert.deepEqual(migrated.tabs[0].bindings, []);
  assert.equal(migrated.tabs[0].id, tab.id);
});

test('spatial fields independently select path and pose layers while retaining legacy workspace roles', () => {
  const run = createRun();
  const fields = buildCatalog([run]);
  const pose = findField(fields, run.id, 'pose:position');
  const position = findField(fields, run.id, 'vector:position');
  const binding = createBinding(pose, 'spatial', 0);

  assert.equal(spatialDisplay(binding, pose), 'both');
  assert.deepEqual(spatialLayers(binding, pose), { trajectory: true, pose: true });
  assert.deepEqual(spatialLayers({ ...binding, display: 'trajectory' }, pose), { trajectory: true, pose: false });
  assert.deepEqual(spatialLayers({ ...binding, display: 'pose' }, pose), { trajectory: false, pose: true });
  assert.deepEqual(spatialLayers(createBinding(position, 'paths', 0), position), { trajectory: true, pose: false });
  assert.deepEqual(spatialLayers(createBinding(pose, 'poses', 0), pose), { trajectory: false, pose: true });
  assert.equal(incompatibility(pose, 'trajectory', 'spatial'), '');
  assert.equal(incompatibility(findField(fields, run.id, 'vector:velocity'), 'trajectory', 'spatial'), '');
  assert.match(incompatibility(findField(fields, run.id, 'position.0'), 'trajectory', 'spatial'), /position vector/);

  const initial = initialTabs(run, fields)[0].bindings;

  assert.equal(initial.filter((item) => item.fieldId === 'pose:position').length, 1);
  assert.equal(
    initial.some((item) => item.fieldId === 'vector:position'),
    false,
  );
  assert.ok(initial.every((item) => item.lane === 'spatial'));
});

test('dock scalar readouts round to six places, trim fractional zeros, and preserve invalid-data gaps', () => {
  const run = createRun({ 'position_m[1]': Float64Array.from([0.123456789, 1.2, NaN]) });
  const field = findField(buildCatalog([run]), run.id, 'position.0');

  assert.equal(fieldValue(field, run, 0, true, 6, true), '0.123457 m');
  assert.equal(fieldValue(field, run, 1, true, 6, true), '1.2 m');
  assert.equal(fieldValue(field, run, 2, true, 6, true), '—');
  assert.equal(fieldValue(field, run, -1, true, 6, true), '—');
  assert.equal(fieldValue(field, run, 1), '1.200 m');
  assert.equal(run.signals['position.0'].values[0], 0.123456789);
});
