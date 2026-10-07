import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CameraTransition, cameraTransitionDuration } from '../../.test-build/src/scene/cameraTransition.js';
import { assertClose } from './support.mjs';

/** Construct a camera at a known position and heading without requiring a browser or WebGL. */
function viewpoint(x, yaw) {
  const camera = new THREE.PerspectiveCamera();

  camera.position.set(x, 0, 0);
  camera.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
  return camera;
}

test('camera transitions retain the displayed first frame, ease through the midpoint, and finish exactly', () => {
  const transition = new CameraTransition();
  const start = viewpoint(0, 0);
  const destination = viewpoint(10, Math.PI / 2);

  transition.start(start);

  for (const [fraction, expectedX, expectedYaw] of [
    [0, 0, 0],
    [0.5, 5, Math.PI / 4],
    [1, 10, Math.PI / 2],
  ]) {
    const rendered = destination.clone();

    transition.apply(rendered, 1000 + fraction * cameraTransitionDuration);
    assertClose(rendered.position.x, expectedX);
    assertClose(rendered.quaternion.angleTo(viewpoint(0, expectedYaw).quaternion), 0, 1e-7);
  }

  assert.equal(destination.position.x, 10);
});

test('moving follow destinations remain live during a transition and are never filtered afterward', () => {
  const transition = new CameraTransition();

  transition.start(viewpoint(0, 0));
  transition.apply(viewpoint(10, 0), 0);

  const moving = viewpoint(13, 0.2);

  transition.apply(moving, cameraTransitionDuration / 2);
  assertClose(moving.position.x, 8);
  assertClose(moving.quaternion.angleTo(viewpoint(0, 0.2).quaternion), 0, 1e-7);

  const finished = viewpoint(20, 0.7);

  transition.apply(finished, cameraTransitionDuration);
  assert.equal(finished.position.x, 20);

  const next = viewpoint(30, 1);

  transition.apply(next, cameraTransitionDuration + 1);
  assert.equal(next.position.x, 30);
});

test('replacement camera commands start from the displayed pose and reduced motion applies immediately', () => {
  const transition = new CameraTransition();

  transition.start(viewpoint(0, 0));
  transition.apply(viewpoint(10, 0), 0);

  const midway = viewpoint(10, 0);

  transition.apply(midway, cameraTransitionDuration / 2);
  transition.start(midway);

  const replacement = viewpoint(-10, 1);

  transition.apply(replacement, 500);
  assert.equal(replacement.position.x, 5);
  assertClose(replacement.quaternion.angleTo(midway.quaternion), 0, 1e-7);

  const reduced = viewpoint(-10, 1);

  transition.apply(reduced, 501, 0);
  assert.equal(reduced.position.x, -10);
  assertClose(reduced.quaternion.angleTo(viewpoint(0, 1).quaternion), 0, 1e-7);
});
