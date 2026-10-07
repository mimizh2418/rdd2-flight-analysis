import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, findField } from '../../.test-build/src/workspace/fieldCatalog.js';
import {
  createTab,
  createBinding,
  validateWorkspace,
  reattachTabs,
} from '../../.test-build/src/workspace/workspaceState.js';
import { createRun } from './support.mjs';

test('follow workspaces retain binding selection, reject dangling references, and migrate retired targets', () => {
  const run = createRun();
  run.csvHash = 'a'.repeat(64);
  const tab = createTab('trajectory', 'Test');
  const pose = createBinding(findField(buildCatalog([run]), run.id, 'pose:position'), 'spatial', 0);

  tab.bindings = [pose];
  tab.camera = 'follow';
  tab.followPose = pose.id;

  const workspace = {
    schema: 'rdd2-workspace-v1',
    tabs: [tab],
    active: tab.id,
    runs: [{ id: run.id, name: run.name, fingerprint: run.csvHash, rows: 3, start: 0, end: 2 }],
    time: 1,
    window: [0, 2],
    alignment: 'absolute',
    browserWidth: 290,
    dockHeight: 250,
  };

  assert.equal(validateWorkspace(workspace).tabs[0].followPose, pose.id);
  const rebound = reattachTabs(workspace, [{ ...run, id: 'reimported' }])[0];
  assert.equal(rebound.followPose, rebound.bindings[0].id);
  assert.equal(rebound.bindings[0].runId, 'reimported');

  for (const patch of [{ followPose: 'missing' }, { followPose: 1 }, { followPose: undefined }, { type: 'vehicle' }]) {
    assert.throws(() => validateWorkspace({ ...workspace, tabs: [{ ...tab, ...patch }] }), /Invalid workspace tab/);
  }

  // Legacy orbit workspaces still need no follow selection.
  assert.equal(
    validateWorkspace({ ...workspace, tabs: [{ ...tab, camera: 'orbit', followPose: undefined }] }).tabs[0].camera,
    'orbit',
  );

  const migrated = validateWorkspace({
    ...workspace,
    runs: [{ ...workspace.runs[0], fingerprint: 'builtin:analytic-v1' }],
  });

  assert.equal(migrated.tabs[0].camera, 'orbit');
  assert.equal(migrated.tabs[0].followPose, undefined);
  assert.deepEqual(migrated.tabs[0].bindings, []);
});
