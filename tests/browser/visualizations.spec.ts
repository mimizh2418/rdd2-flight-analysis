import { test, expect } from '@playwright/test';
import { uploadFile, poseCsv } from './support/fixtures';
import { watchErrors, importFlight, createView, openAppearance, seekTime, zoomIn } from './support/actions';

test('keyboard playback, graphs and exports remain usable without WebGL', async ({ page }) => {
  const errors = watchErrors(page);

  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;

    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<typeof original>) {
      if (String(args[0]).includes('webgl')) return null;
      return original.apply(this, args);
    } as typeof original;
  });
  await page.goto('/');
  await page.getByTestId('trace-input').setInputFiles(uploadFile('pose.csv', poseCsv));

  await expect(page.locator('.run-title')).toHaveText('pose.csv');

  await page.locator('.app-bar > strong').click();
  await page.keyboard.press('ArrowRight');

  await expect(page.getByTestId('playback-time')).toContainText('1.000');

  await page.keyboard.press('ArrowLeft');

  await expect(page.getByTestId('playback-time')).toContainText('0.000');

  await page.keyboard.press('Space');

  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

  await page.keyboard.press('Space');
  await page.getByRole('tab', { name: '⌁ Graph 1' }).click();

  await expect(page.locator('.uplot')).toBeVisible();
  expect(errors).toEqual([]);
});

test('one trajectory dock accepts a pose and switches path, model, and both without reloading its data', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await createView(page, '3D trajectory');

  await expect(page.locator('.binding-lane')).toHaveCount(1);
  await expect(page.getByTestId('drop-paths')).toHaveCount(0);
  await expect(page.getByTestId('drop-poses')).toHaveCount(0);

  await page.getByLabel('Search fields', { exact: true }).fill('Truth vehicle pose');
  await page.locator('.field-row[data-field-id="pose:position"]').dragTo(page.getByTestId('drop-spatial'));

  const row = page.locator('.binding[data-field-id="pose:position"]');

  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.scene-canvas canvas')).toBeVisible();

  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await seekTime(page, 1);

  // Appearance edits should reuse prepared data; count any worker requests that would reload a field.
  await page.evaluate(() => {
    const messages: string[] = [];

    Object.defineProperty(window, 'appearanceLoads', { value: messages });

    const send = Worker.prototype.postMessage;

    Worker.prototype.postMessage = function (this: Worker, message: { type?: string }, transfer?: Transferable[]) {
      if (message.type === 'field' || message.type === 'column') messages.push(message.type);
      return send.call(this, message, transfer ?? []);
    } as typeof send;
  });

  const display = row.locator('.binding-head').getByLabel('Display Truth vehicle pose', { exact: true });

  await expect(display).toBeVisible();
  await expect(display).toHaveValue('both');
  await expect(page.getByRole('dialog', { name: 'Appearance settings for Truth vehicle pose' })).toHaveCount(0);

  // The same binding can switch between path, model, and both without disappearing from its dock.
  await display.selectOption('trajectory');

  await expect(row.locator('[data-appearance=line]')).toHaveCount(1);
  await expect(row.locator('[data-appearance=drone]')).toHaveCount(0);

  await page.screenshot({ path: 'artifacts/validation/workspace-pose-path.png' });
  await display.selectOption('pose');
  await openAppearance(page, 'Truth vehicle pose');

  await expect(
    page.getByRole('dialog', { name: 'Appearance settings for Truth vehicle pose' }).getByRole('combobox', {
      name: 'Display Truth vehicle pose',
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(page.getByLabel('Line style Truth vehicle pose', { exact: true })).toHaveCount(0);

  await page.getByLabel('Model Truth vehicle pose', { exact: true }).selectOption('ghost');

  await expect(row.locator('[data-appearance=ghost]')).toHaveCount(1);

  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'artifacts/validation/workspace-pose-model.png' });
  await display.selectOption('both');
  await openAppearance(page, 'Truth vehicle pose');
  await page.getByLabel('Model Truth vehicle pose', { exact: true }).selectOption('ball');

  await expect(row.locator('[data-appearance=line]')).toHaveCount(1);
  await expect(row.locator('[data-appearance=ball]')).toHaveCount(1);
  await expect(
    page.getByRole('dialog', { name: 'Appearance settings for Truth vehicle pose', exact: true }),
  ).toBeInViewport();

  await page.keyboard.press('Escape');

  await expect(row.getByRole('button', { name: 'Appearance Truth vehicle pose', exact: true })).toBeFocused();

  await page.screenshot({ path: 'artifacts/validation/workspace-pose-both.png' });

  expect(await page.evaluate(() => (window as unknown as { appearanceLoads: string[] }).appearanceLoads)).toEqual([]);
  await expect(page.getByTestId('playback-time')).toContainText('1.000');

  await createView(page, '3D trajectory');

  await expect(page.locator('.binding')).toHaveCount(0);

  await page.getByRole('tab', { name: '◇ Trajectory 2', exact: true }).click();
  await openAppearance(page, 'Truth vehicle pose');

  await expect(page.getByLabel('Display Truth vehicle pose', { exact: true })).toHaveValue('both');
  await expect(page.getByLabel('Model Truth vehicle pose', { exact: true })).toHaveValue('ball');
  expect(errors).toEqual([]);
});

test('zoom fits visible full-resolution extrema and hidden series no longer influence an axis', async ({ page }) => {
  const errors = watchErrors(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  const rows = Array.from({ length: 101 }, (_, index) => {
    const time = index / 10;
    const east = index === 85 ? 100 : time / 10;

    return `${time},${east},0,1,0.1,0,0`;
  });
  const csv = 'time_s,x_m,y_m,z_m,velocity_m_s[1],velocity_m_s[2],velocity_m_s[3]\n' + rows.join('\n') + '\n';

  await page.getByTestId('trace-input').setInputFiles(uploadFile('spike.csv', csv));

  await expect(page.locator('.run-title')).toHaveText('spike.csv');

  await page.getByRole('tab', { name: '⌁ Graph 1' }).click();
  await expect
    .poll(async () => Number((await page.getByTestId('axis-ranges').innerText()).match(/L \S+ … (\S+)/)?.[1]))
    .toBeGreaterThan(100);
  await zoomIn(page);
  await expect
    .poll(async () => Number((await page.getByTestId('axis-ranges').innerText()).match(/L \S+ … (\S+)/)?.[1]))
    .toBeLessThan(1);
  await page
    .locator('.binding[data-field-id="position.0"]')
    .getByRole('button', { name: 'Hide East position', exact: true })
    .click();

  await expect(page.getByTestId('axis-ranges')).toContainText('L -1.000 … 1.000');
  expect(errors).toEqual([]);
});

test('repeated graph zoom reuses channel indices and the same chart canvas without loading', async ({ page }) => {
  const errors = watchErrors(page);

  await page.addInitScript(() => {
    const traffic = { indices: 0, columns: 0 };

    Object.defineProperty(window, 'graphTraffic', { value: traffic });

    const original = Worker.prototype.postMessage;

    Worker.prototype.postMessage = function (this: Worker, message: unknown, transfer?: Transferable[]) {
      const type = (message as { type?: string }).type;

      if (type === 'graph-index') traffic.indices++;
      if (type === 'column') traffic.columns++;
      original.call(this, message, transfer ?? []);
    } as typeof original;
  });
  await page.goto('/');

  const rows = Array.from({ length: 100001 }, (_, row) => `${row / 10000},${row === 85000 ? 100 : row / 100000},0,1`);

  await page.getByTestId('trace-input').setInputFiles(uploadFile('zoom.csv', 'time_s,x_m,y_m,z_m\n' + rows.join('\n')));

  await expect(page.locator('.run-title')).toHaveText('zoom.csv');

  await page.getByRole('tab', { name: '⌁ Graph 1' }).click();

  await expect(page.locator('.uplot canvas').first()).toBeVisible();
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);

  // Repeated zoom gestures should keep the same canvas, avoid preparation jobs, and finish within a frame budget.
  const result = await page.evaluate(async () => {
    const traffic = (window as unknown as { graphTraffic: { indices: number; columns: number } }).graphTraffic;
    const before = { ...traffic };
    const overlay = document.querySelector('.u-over')!;
    const canvas = document.querySelector('.uplot canvas');
    const box = overlay.getBoundingClientRect();
    let maxFrame = 0;
    let loads = 0;
    const observer = new MutationObserver(() => {
      if (document.querySelector('.binding[aria-busy=true]')) loads++;
    });

    observer.observe(document.querySelector('.binding-dock')!, { subtree: true, attributes: true });
    for (let gesture = 0; gesture < 16; gesture++) {
      const started = performance.now();

      overlay.dispatchEvent(
        new WheelEvent('wheel', { clientX: box.x + box.width / 2, deltaY: gesture < 8 ? -125 : 125, cancelable: true }),
      );
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      maxFrame = Math.max(maxFrame, performance.now() - started);
    }
    observer.disconnect();
    return {
      before,
      after: { ...traffic },
      sameCanvas: canvas === document.querySelector('.uplot canvas'),
      loads,
      maxFrame,
    };
  });

  expect(result.after).toEqual(result.before);
  expect(result.sameCanvas).toBe(true);
  expect(result.loads).toBe(0);
  expect(result.maxFrame).toBeLessThan(300);

  console.log('Cached 100k-row graph navigation:', result);

  expect(errors).toEqual([]);
});
