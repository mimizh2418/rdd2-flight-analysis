import * as THREE from 'three';
import type { Quat, Vec3 } from '../data/types';

/**
 * Apply sampled attitude and choose the drone body or its missing-attitude marker.
 * @param root Pose model group, including optional drone body/fallback children.
 * @param quaternion Sampled body-FLU-to-world-ENU x/y/z/w quaternion, or NaNs for missing attitude.
 * @param keepBodyVisible Keep a reference drone visible at a fixed level heading when attitude is unavailable.
 * @returns Whether the sampled attitude is valid; body-axis overlays can use this to avoid implying measured attitude.
 */
export function updateModelAttitude(root: THREE.Group, quaternion: Quat, keepBodyVisible = false): boolean {
  const oriented = quaternion.every(Number.isFinite);

  root.userData.oriented = oriented;
  root.quaternion.set(...(oriented ? quaternion : ([0, 0, 0, 1] as Quat)));

  if (root.userData.body) {
    root.userData.body.visible = oriented || keepBodyVisible;
    root.userData.fallback.visible = !root.userData.body.visible;
  }

  return oriented;
}

/**
 * Build an FLU procedural quadrotor, plus a position-only marker for samples without valid attitude.
 *
 * @param color Three.js numeric body/rotor color.
 * @param rotors Optional rotor-center offsets in body FLU metres; defaults to the nominal four-rotor layout.
 * @param ghost Enable translucent comparison/estimate styling; defaults to false.
 * @returns Group containing body geometry and a hidden fallback marker, exposed as userData.body and userData.fallback
 *   for pose updates.
 * @remarks The caller owns the returned geometries/materials and must dispose them when removing the scene.
 */
export function drone(color: number, rotors?: Vec3[], ghost = false) {
  const root = new THREE.Group();
  const g = new THREE.Group();

  root.add(g);

  // Keep a position-only marker beside the oriented body so missing attitude is visibly represented.
  const fallback = new THREE.Mesh(
    new THREE.SphereGeometry(0.085, 12, 8),
    new THREE.MeshBasicMaterial({ color, transparent: ghost, opacity: ghost ? 0.4 : 1 }),
  );

  fallback.visible = false;
  root.add(fallback);
  root.userData.body = g;
  root.userData.fallback = fallback;

  const material = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.3,
    roughness: 0.6,
    transparent: ghost,
    opacity: ghost ? 0.35 : 1,
  });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.17, 0.075), material);

  g.add(body);

  const positions = rotors ?? [
    [0.17678, -0.17678, 0],
    [-0.17678, -0.17678, 0],
    [-0.17678, 0.17678, 0],
    [0.17678, 0.17678, 0],
  ];

  for (const p of positions) {
    // Cylinder geometry points along local Y: rotate each arm toward its rotor offset and place it at the midpoint.
    const end = new THREE.Vector3(...p);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, end.length(), 8), material);

    arm.position.copy(end.clone().multiplyScalar(0.5));
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), end.clone().normalize());
    g.add(arm);

    const rotor = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.009, 6, 24), material);

    rotor.position.copy(end);
    rotor.position.z += 0.025;
    g.add(rotor);
  }

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.035, 0.09, 12),
    new THREE.MeshBasicMaterial({ color: 0xffad62, transparent: ghost, opacity: ghost ? 0.4 : 1 }),
  );

  nose.rotation.z = -Math.PI / 2;
  nose.position.x = 0.2;
  g.add(nose);
  g.add(new THREE.AxesHelper(0.33));

  return root;
}
