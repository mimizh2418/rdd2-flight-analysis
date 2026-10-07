import * as THREE from 'three';

/** Duration of explicit camera-view changes, in wall-clock milliseconds rather than simulation time. */
export const cameraTransitionDuration = 350;

/** Ease explicit view changes while retaining live motion of the destination camera. */
export class CameraTransition {
  private startPose?: { position: THREE.Vector3; quaternion: THREE.Quaternion };
  private residual?: { position: THREE.Vector3; quaternion: THREE.Quaternion; started: number };

  /**
   * Capture the last displayed viewpoint, replacing any unfinished transition.
   * @param camera Camera whose current world pose was displayed to the user.
   * @returns Nothing; the destination is captured when the next complete scene frame is ready.
   */
  start(camera: THREE.Camera): void {
    this.startPose = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
    this.residual = undefined;
  }

  /**
   * Ease a destination camera from the captured viewpoint, in place.
   * @param camera Fully updated destination camera, including this frame's follow position/orientation.
   * @param now Monotonic browser wall-clock timestamp in milliseconds.
   * @param duration Transition duration; zero applies the destination immediately for reduced-motion preferences.
   * @returns Nothing; changes only the displayed camera pose, never the scene or telemetry samples.
   * @remarks The initial position and rotation errors decay with smoothstep easing. Destination motion is applied
   *   immediately each frame, so normal follow playback is not filtered or delayed.
   */
  apply(camera: THREE.Camera, now: number, duration = cameraTransitionDuration): void {
    if (!this.startPose) return;

    if (!this.residual) {
      this.residual = {
        position: this.startPose.position.clone().sub(camera.position),
        quaternion: camera.quaternion.clone().invert().multiply(this.startPose.quaternion),
        started: now,
      };
    }

    const fraction = duration > 0 ? Math.max(0, Math.min(1, (now - this.residual.started) / duration)) : 1;

    if (fraction === 1) {
      this.startPose = undefined;
      this.residual = undefined;
      return;
    }

    // Smoothstep has zero slope at both ends. Quaternion slerp follows the shortest rotational arc.
    const remaining = 1 - fraction * fraction * (3 - 2 * fraction);
    camera.position.addScaledVector(this.residual.position, remaining);
    camera.quaternion.multiply(new THREE.Quaternion().slerp(this.residual.quaternion, remaining));
  }
}
