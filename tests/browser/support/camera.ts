import { expect, type Page } from '@playwright/test';

/** World camera pose reconstructed from the view matrix actually submitted to WebGL. */
export interface CameraSnapshot {
  position: number[];
  forward: number[];
}

/**
 * Observe the rendered trajectory camera without adding production-only test hooks.
 * @param page Browser page before navigation initializes Three.js or WebGL.
 * @param canvasLabel Accessible name of the trajectory or centered-vehicle canvas to observe.
 * @returns Promise after installing uniform interception for the trajectory canvas only.
 * @remarks The inverse rigid view transform gives camera position and its world-facing direction.
 */
export async function observeTrajectoryCamera(page: Page, canvasLabel = 'Trajectory 3D view'): Promise<void> {
  await page.addInitScript((label) => {
    const names = new WeakMap<WebGLUniformLocation, string>();
    const prototype = WebGL2RenderingContext.prototype;
    const location = prototype.getUniformLocation;
    const matrix = prototype.uniformMatrix4fv;
    const shaderSource = prototype.shaderSource;

    prototype.shaderSource = function (shader, source) {
      if (source.includes('uniform mat4 viewMatrix;') && source.includes('gl_Position')) {
        // Some materials optimize away viewMatrix. A negligible vertex contribution keeps the actual camera
        // uniform observable, without changing the rendered geometry at useful floating-point precision.
        source = source.replace(/}\s*$/, '\n gl_Position.x += 1e-20 * viewMatrix[0][0];\n}');
      }

      shaderSource.call(this, shader, source);
    };

    prototype.getUniformLocation = function (program, name) {
      const result = location.call(this, program, name);

      if (result) names.set(result, name);

      return result;
    };

    prototype.uniformMatrix4fv = function (...args: Parameters<typeof matrix>) {
      const canvas = this.canvas as HTMLCanvasElement;

      if (args[0] && names.get(args[0]) === 'viewMatrix' && canvas.getAttribute('aria-label') === label) {
        const offset = args[3] ?? 0;
        const values = Array.from(args[2]).slice(offset, offset + 16);
        const [x, y, z] = values.slice(12, 15);

        // Invert the rotation/translation of the view matrix, rather than inspecting app camera state.
        (window as unknown as { trajectoryCamera: CameraSnapshot }).trajectoryCamera = {
          position: [
            -(values[0] * x + values[1] * y + values[2] * z),
            -(values[4] * x + values[5] * y + values[6] * z),
            -(values[8] * x + values[9] * y + values[10] * z),
          ],
          forward: [-values[2], -values[6], -values[10]],
        };
      }

      matrix.call(this, ...args);
    };
  }, canvasLabel);
}

/**
 * Read the most recent rendered trajectory camera, waiting for the first submitted view matrix.
 * @param page Page instrumented by observeTrajectoryCamera.
 * @returns World camera position and direction after at least one rendered trajectory frame.
 */
export async function trajectoryCamera(page: Page): Promise<CameraSnapshot> {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { trajectoryCamera?: CameraSnapshot }).trajectoryCamera))
    .toBeTruthy();

  return page.evaluate(() => (window as unknown as { trajectoryCamera: CameraSnapshot }).trajectoryCamera);
}

/**
 * Wait for a rendered camera to reach a known world position within GPU float precision.
 * @param page Instrumented trajectory page.
 * @param position Expected camera location in ENU metres.
 * @returns Promise once the rendered location agrees within 0.0001 m.
 */
export async function expectCameraPosition(page: Page, position: number[]): Promise<void> {
  await expect
    .poll(async () => {
      const camera = await trajectoryCamera(page);

      return Math.max(...camera.position.map((value, axis) => Math.abs(value - position[axis])));
    })
    .toBeLessThan(0.0001);
}
