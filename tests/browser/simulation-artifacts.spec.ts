import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { watchErrors, addField, createView, seekTime } from './support/actions';

test('large GPS trace loads fields asynchronously with progress and cancellation', async ({ page }) => {
  test.skip(!process.env.RDD2_GPS_TRACE, 'Set RDD2_GPS_TRACE to the qualification CSV');
  test.setTimeout(120000);

  const errors = watchErrors(page);

  await page.goto('/');
  await page.getByTestId('trace-input').setInputFiles(resolve(process.env.RDD2_GPS_TRACE!));

  await expect(page.locator('.run-title')).toHaveText('waypoint-eskf_gps.csv', { timeout: 90000 });
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0, { timeout: 30000 });

  await seekTime(page, 8.38);
  await createView(page, 'Graph');
  await page.getByLabel('Search fields', { exact: true }).fill('nees');
  // Slow only worker responses to guarantee the progress bar is observable; source transfer/CPU work remains real.
  await page.evaluate(() => {
    const responsiveness = { ticks: 0, maxGap: 0, previous: performance.now() };

    Object.defineProperty(window, 'responsiveness', { value: responsiveness });
    setInterval(() => {
      const now = performance.now();

      responsiveness.maxGap = Math.max(responsiveness.maxGap, now - responsiveness.previous);
      responsiveness.previous = now;
      responsiveness.ticks++;
    }, 20);

    const original = Worker.prototype.postMessage;

    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      if ((message as { type?: string }).type === 'field')
        setTimeout(() => original.call(this, message, transfer ?? []), 500);
      else original.call(this, message, transfer ?? []);
    } as typeof original;
  });
  await page.locator('.field-row[data-field-id="nees"]').getByRole('button', { name: /^Add / }).click();
  await page.getByRole('button', { name: 'Add to Left Y axis', exact: true }).click();

  await expect(page.locator('.binding progress')).toBeVisible();

  const initialTime = await page.getByTestId('playback-time').innerText();

  await page.getByRole('button', { name: 'Play', exact: true }).click();

  await expect.poll(async () => page.getByTestId('playback-time').innerText()).not.toBe(initialTime);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.locator('.binding .remove').click();

  await expect(page.locator('.binding')).toHaveCount(0);

  await page.waitForTimeout(800);

  await expect(page.locator('.binding')).toHaveCount(0);

  await addField(page, 'nees', 'nees', 'Left Y axis');

  await expect(page.locator('.uplot')).toBeVisible({ timeout: 30000 });
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByTestId('axis-ranges')).not.toContainText('Infinity');

  const responsiveness = await page.evaluate(
    () => (window as unknown as { responsiveness: { ticks: number; maxGap: number } }).responsiveness,
  );

  expect(responsiveness.ticks).toBeGreaterThan(20);
  expect(responsiveness.maxGap).toBeLessThan(500);

  console.log('GPS field-loading responsiveness:', responsiveness);

  expect(errors).toEqual([]);
});

test('fresh Rumoca export verifies and renders trajectory and centered vehicle', async ({ page }) => {
  test.skip(!process.env.RDD2_RUMOCA_BUNDLE, 'Set RDD2_RUMOCA_BUNDLE to an exported bundle');

  const errors = watchErrors(page);

  await page.goto('/');

  const root = resolve(process.env.RDD2_RUMOCA_BUNDLE!);

  await page.getByTestId('trace-input').setInputFiles([resolve(root, 'trace.csv'), resolve(root, 'manifest.json')]);

  await expect(page.locator('.run-title')).toHaveText('rumoca-scenario.waypoint-global');
  await expect(page.locator('.scene-canvas canvas')).toBeVisible();

  await seekTime(page, 0.01);

  await expect(page.getByTestId('playback-time')).toContainText('0.010');

  await page.getByRole('tab', { name: '✧ Vehicle 1' }).click();
  await page.getByLabel('Follow orientation', { exact: true }).check();

  await expect(page.getByText('Camera follows body orientation')).toBeVisible();
  await expect(page.locator('.webgl-fallback')).toHaveCount(0);

  expect(errors).toEqual([]);
});
