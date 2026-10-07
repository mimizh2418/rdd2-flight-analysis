import { test, expect } from '@playwright/test';
import { uploadFile, poseCsv, flightCsv, createManifest } from './support/fixtures';
import { watchErrors, importFlight, downloadText, openAppearance, seekTime, zoomIn } from './support/actions';

test('verified bundle, independent export interval, full-resolution statistics and CSV', async ({ page }) => {
  const errors = watchErrors(page);

  await page.addInitScript(() => Object.defineProperty(window, 'showSaveFilePicker', { value: undefined }));
  await page.goto('/');
  await importFlight(page);

  await expect(page.locator('.binding[data-field-id="mission:plan"]')).toBeVisible();

  // Zooming the view must not silently narrow the independently selected export interval.
  await zoomIn(page);
  await page.getByRole('button', { name: 'Export', exact: true }).click();

  await expect(page.getByLabel('Interval start', { exact: true })).toHaveValue('0');
  await expect(page.getByLabel('Interval end', { exact: true })).toHaveValue('2');

  await page.getByLabel('Interval start', { exact: true }).fill('0.5');
  await page.getByLabel('Interval end', { exact: true }).fill('1.5');

  // Statistics integrate interpolated boundaries, while CSV export retains only original rows in the interval.
  const statistics = JSON.parse(await downloadText(page, 'Export statistics'));

  expect(statistics.simulation_interval).toEqual([0.5, 1.5]);
  expect(statistics.tracking.rmse).toBeCloseTo(Math.sqrt(13 / 12), 9);
  expect(statistics.tracking.coverage).toBe(1);

  const csv = await downloadText(page, 'Export selection CSV');

  expect(csv.trim().split('\n')).toHaveLength(2);
  expect(csv.split('\n')[1]).toMatch(/^1,1,0,1,/);
  expect(errors).toEqual([]);
});

test('malformed CSV, invalid workspace, and bad hash leave current data intact', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await page.getByTestId('trace-input').setInputFiles(uploadFile('broken.csv', 'time,x\n0'));

  // Every failed import must leave the previously loaded flight available.
  await expect(page.getByRole('alert')).toContainText('expected 2 fields');

  await page
    .getByTestId('trace-input')
    .setInputFiles([
      uploadFile('flight.csv', flightCsv),
      uploadFile('manifest.json', JSON.stringify({ ...createManifest(flightCsv), csv_sha256: '0'.repeat(64) })),
    ]);

  await expect(page.getByRole('alert')).toContainText('CSV SHA-256 does not match');

  await page.getByTestId('workspace-input').setInputFiles(uploadFile('workspace.json', '{"schema":"bad"}'));

  await expect(page.getByRole('alert')).toContainText('Expected an rdd2-workspace-v1');
  await expect(page.locator('.run-title')).toContainText('Analytic flight');
  expect(errors).toEqual([]);
});

test('native writer retains original rows and closes successfully', async ({ page }) => {
  const errors = watchErrors(page);

  await page.addInitScript(() => {
    const saved = { text: '', closed: false };

    Object.defineProperty(window, 'savedCsv', { value: saved });
    Object.defineProperty(window, 'showSaveFilePicker', {
      value: async () => ({
        createWritable: async () => ({
          write: async (data: Uint8Array) => {
            saved.text += new TextDecoder().decode(data);
          },
          close: async () => {
            saved.closed = true;
          },
        }),
      }),
    });
  });
  await page.goto('/');
  await page.getByTestId('trace-input').setInputFiles(uploadFile('pose.csv', poseCsv));

  await expect(page.locator('.run-title')).toHaveText('pose.csv');

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Interval start', { exact: true }).fill('0.5');
  await page.getByLabel('Interval end', { exact: true }).fill('1.5');
  await page.getByRole('button', { name: 'Export selection CSV', exact: true }).click();
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { savedCsv: { closed: boolean } }).savedCsv.closed))
    .toBe(true);

  const saved = await page.evaluate(() => (window as unknown as { savedCsv: { text: string } }).savedCsv.text);

  expect(saved).toBe('time_s,x_m,y_m,z_m,roll_rad,pitch_rad,yaw_rad\n1,1,0,1,0,0,0\n');
  expect(errors).toEqual([]);
});

test('workspace restoration reattaches content hashes and keeps per-tab styles', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await openAppearance(page, 'Truth vehicle pose');
  await page.getByLabel('Line style Truth vehicle pose').selectOption('dotted');
  await page.getByRole('button', { name: 'Top', exact: true }).click();
  await seekTime(page, 1);
  await page.waitForTimeout(400);
  await page.reload();

  await expect(
    page.getByText('Field unavailable; attach its original trace or remove this binding.').first(),
  ).toBeVisible();

  // A matching filename with different contents must not reattach a saved binding.
  await page
    .getByTestId('trace-input')
    .setInputFiles(uploadFile('flight.csv', flightCsv.replace('1,1,0,1', '1,9,0,1')));

  await expect(
    page.getByText('Field unavailable; attach its original trace or remove this binding.').first(),
  ).toBeVisible();

  await importFlight(page);

  await expect(page.getByText('Field unavailable; attach its original trace or remove this binding.')).toHaveCount(0);

  await openAppearance(page, 'Truth vehicle pose');

  await expect(page.getByLabel('Line style Truth vehicle pose')).toHaveValue('dotted');
  await expect(page.getByTestId('playback-time')).toContainText('1.000');

  await expect
    .poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('rdd2.workspace.v1')!).tabs[0].camera))
    .toBe('top');

  expect(errors).toEqual([]);
});
