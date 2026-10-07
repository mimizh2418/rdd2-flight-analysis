import { test, expect } from '@playwright/test';
import { importFlight, watchErrors } from './support/actions';
import { observeTrajectoryCamera, trajectoryCamera, expectCameraPosition, type CameraSnapshot } from './support/camera';

for (const vehicle of [false, true]) {
  test(`${vehicle ? 'vehicle' : 'trajectory'} camera presets ease between rendered viewpoints`, async ({ page }) => {
    const errors = watchErrors(page);

    await observeTrajectoryCamera(page, vehicle ? 'Centered vehicle 3D view' : 'Trajectory 3D view');
    await page.addInitScript(() => {
      let latest: CameraSnapshot;
      const samples: CameraSnapshot[] = [];

      Object.defineProperty(window, 'cameraSamples', { value: samples });
      Object.defineProperty(window, 'trajectoryCamera', {
        get: () => latest,
        set: (value: CameraSnapshot) => {
          latest = value;
          samples.push(value);
        },
      });
    });
    await page.goto('/');
    await importFlight(page);
    if (vehicle) await page.getByRole('tab', { name: '✧ Vehicle 1' }).click();

    const center = vehicle ? [0, 0, 0] : [1, 0, 1];
    const radius = vehicle ? 0.6 : 1;
    const top = [center[0], center[1] - 0.001 * radius, center[2] + 2.8 * radius];

    // Import can also refit the bounds. Start this check only once that initial fit has settled.
    await expectCameraPosition(page, [center[0] + 1.4 * radius, center[1] - 1.8 * radius, center[2] + 1.25 * radius]);
    const start = await trajectoryCamera(page);

    await page.evaluate(() => {
      (window as unknown as { cameraSamples: CameraSnapshot[] }).cameraSamples.length = 0;
      const canvas = document.querySelector<HTMLCanvasElement>('.scene-canvas canvas')!;
      const context = canvas.getContext('webgl2')!;
      const frames: boolean[] = [];
      const pixels = new Uint8Array(context.drawingBufferWidth * context.drawingBufferHeight * 4);
      const draw = context.drawElements.bind(context);
      const schedule = window.requestAnimationFrame.bind(window);
      let submitted = 0;

      Object.defineProperty(window, 'transitionCanvas', { value: canvas });
      Object.defineProperty(window, 'sceneFrames', { value: frames });
      context.drawElements = (...args: Parameters<typeof draw>) => {
        submitted++;
        draw(...args);
      };
      window.requestAnimationFrame = (callback) =>
        schedule((time) => {
          const before = submitted;

          callback(time);
          if (submitted === before || !canvas.isConnected) return;

          // Read inside the rendering frame, before the compositor discards the default drawing buffer.
          // A solid background has identical pixels; a visible vehicle/path contributes different RGB values.
          context.readPixels(
            0,
            0,
            context.drawingBufferWidth,
            context.drawingBufferHeight,
            context.RGBA,
            context.UNSIGNED_BYTE,
            pixels,
          );
          let visible = false;

          for (let index = 4; index < pixels.length; index += 4) {
            if ([0, 1, 2].some((channel) => Math.abs(pixels[index + channel] - pixels[channel]) > 3)) {
              visible = true;
              break;
            }
          }
          frames.push(visible);
        });
    });
    await page.getByRole('button', { name: 'Top', exact: true }).click();
    expect(
      await page.evaluate(
        () =>
          document.querySelector('.scene-canvas canvas') ===
          (window as unknown as { transitionCanvas: Element }).transitionCanvas,
      ),
      'Changing a camera preset must preserve the canvas and its live WebGL context',
    ).toBe(true);
    await expectCameraPosition(page, top);

    const samples = await page.evaluate(() => (window as unknown as { cameraSamples: CameraSnapshot[] }).cameraSamples);
    const intermediate = samples.filter((sample) => {
      const fraction = (sample.position[1] - start.position[1]) / (top[1] - start.position[1]);

      return fraction > 0.1 && fraction < 0.9;
    });

    // Observe actual WebGL camera uniforms: an instantaneous preset jump would have no intermediate views.
    expect(intermediate.length).toBeGreaterThan(1);

    // A second command during a transition must still reach the latest requested preset.
    await page.getByRole('button', { name: 'Orbit', exact: true }).click();
    await page.getByRole('button', { name: 'Side', exact: true }).click();
    await expectCameraPosition(page, [center[0], center[1] - 2.8 * radius, center[2] + 0.1 * radius]);
    await page.getByRole('button', { name: 'Fit', exact: true }).click();
    await expectCameraPosition(page, start.position);
    const frames = await page.evaluate(() => (window as unknown as { sceneFrames: boolean[] }).sceneFrames);

    expect(frames.length).toBeGreaterThan(2);
    expect(frames.every(Boolean), 'Every rendered transition frame must contain visible scene content').toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as { transitionCanvas: Element }).transitionCanvas.isConnected),
      'The original canvas must stay connected throughout all camera transitions',
    ).toBe(true);
    expect(errors).toEqual([]);
  });
}
