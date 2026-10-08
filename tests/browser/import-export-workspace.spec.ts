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

test('import failures preserve current data and stack independently dismissible errors', async ({ page }) => {
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

  await expect(page.getByRole('alert').filter({ hasText: 'CSV SHA-256 does not match' })).toBeVisible();

  await page.getByTestId('workspace-input').setInputFiles(uploadFile('workspace.json', '{"schema":"bad"}'));

  await expect(page.getByRole('alert').filter({ hasText: 'Expected an rdd2-workspace-v1' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(3);

  // Dismissing the middle notification must not remove earlier or later failures.
  await page
    .locator('.error-toast')
    .filter({ hasText: 'CSV SHA-256 does not match' })
    .getByRole('button', { name: 'Dismiss error' })
    .click();

  await expect(page.getByRole('alert')).toHaveCount(2);
  await expect(page.getByRole('alert').filter({ hasText: 'expected 2 fields' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Expected an rdd2-workspace-v1' })).toBeVisible();
  await expect(page.locator('.run-title')).toContainText('Analytic flight');
  expect(errors).toEqual([]);
});

test('import toasts suppress quick flashes and retain stable, cancellable feedback for longer batches', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.addInitScript(() => {
    const original = Worker.prototype.postMessage;

    Worker.prototype.postMessage = function (this: Worker, message: { file?: File }, transfer?: Transferable[]) {
      if (!message.file) return original.call(this, message, transfer ?? []);

      // Control notification timing independently of machine speed; normal imports still use the real worker.
      if (message.file.name === 'quick.csv') {
        setTimeout(() => {
          this.dispatchEvent(
            new MessageEvent('message', { data: { type: 'progress', fraction: 0.5, stage: 'Parsing' } }),
          );
          this.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Quick import failure' } }));
        }, 0);
      } else setTimeout(() => original.call(this, message, transfer ?? []), 1000);
    } as typeof original;

    const observed = { mounts: 0, element: null as Element | null };
    Object.defineProperty(window, 'importToastObserver', { value: observed });
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof Element && node.matches('.import-toast')) observed.mounts++;
    }).observe(document, { childList: true, subtree: true });
  });
  await page.goto('/');
  await page.getByTestId('trace-input').setInputFiles(uploadFile('quick.csv', poseCsv));

  await expect(page.getByRole('alert')).toContainText('Quick import failure');
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(
      () => (window as unknown as { importToastObserver: { mounts: number } }).importToastObserver.mounts,
    ),
  ).toBe(0);

  await page.getByTestId('trace-input').setInputFiles(uploadFile('pose.csv', poseCsv));
  await expect(page.getByRole('button', { name: 'Cancel import' })).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { importToastObserver: { element: Element | null } }).importToastObserver.element =
      document.querySelector('.import-toast');
  });
  await expect(page.locator('.run-title')).toHaveText('pose.csv');
  await expect(page.locator('.import-toast')).toContainText('Log imported');
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { importToastObserver: { element: Element | null } }).importToastObserver.element ===
        document.querySelector('.import-toast'),
    ),
  ).toBe(true);

  // A new pending batch stacks with the retained completion and previous failure; cancellation removes only it.
  await page.getByTestId('trace-input').setInputFiles(uploadFile('later.csv', poseCsv));
  await expect(page.locator('.import-toast')).toHaveCount(2);
  await page.getByRole('button', { name: 'Cancel import' }).click();
  await expect(page.locator('.import-toast')).toHaveCount(1);
  await expect(page.locator('.import-toast')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('Quick import failure');
  await expect(page.locator('.run-title')).toHaveText('pose.csv');
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
  await zoomIn(page);
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
  await expect(page.getByRole('slider', { name: 'Timeline' })).toHaveAttribute('aria-valuemin', '0');
  await expect(page.getByRole('slider', { name: 'Timeline' })).toHaveAttribute('aria-valuemax', '2');

  await expect
    .poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('rdd2.workspace.v1')!).tabs[0].camera))
    .toBe('top');

  expect(errors).toEqual([]);
});
