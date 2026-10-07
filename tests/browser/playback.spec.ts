import { test, expect } from '@playwright/test';
import { uploadFile, poseCsv, flightCsv } from './support/fixtures';
import { watchErrors, importFlight, seekTime, zoomIn } from './support/actions';

test('shared paused preview, leave, seek during playback, graph cursor and time zoom', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await seekTime(page, 0.25);

  const strip = page.getByRole('slider', { name: 'Timeline' });
  const box = (await strip.boundingBox())!;

  // A paused hover changes telemetry readouts while leaving the selected playback time untouched.
  await page.mouse.move(box.x + box.width * 0.75, box.y + 20);

  await expect(page.locator('.time-cursor.preview')).toContainText('1.500');
  await expect(page.getByTestId('field-time')).toContainText('1.500');
  await expect(page.getByTestId('playback-time')).toContainText('0.250');

  await page.mouse.move(10, 10);

  await expect(page.locator('.time-cursor.preview')).toHaveCount(0);
  await expect(page.getByTestId('field-time')).toContainText('0.250');

  // Clicking during playback pauses and commits the clicked timestamp.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await strip.click({ position: { x: box.width / 2, y: 20 } });

  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByTestId('playback-time')).toContainText('1.000');

  // The graph replaces the timeline and participates in the same global preview, seek, and zoom state.
  await page.getByRole('tab', { name: '⌁ Graph 1' }).click();

  await expect(page.getByRole('slider', { name: 'Timeline' })).toHaveCount(0);
  await expect(page.locator('.uplot')).toHaveCount(1);

  const plot = page.locator('.u-over');
  const graph = (await plot.boundingBox())!;

  await page.mouse.move(graph.x + graph.width / 4, graph.y + graph.height / 2);

  await expect(page.locator('.graph-time-cursor.preview')).toContainText('0.500');

  await plot.click({ position: { x: graph.width / 4, y: graph.height / 2 } });

  await expect(page.getByTestId('playback-time')).toContainText('0.500');

  await expect
    .poll(async () => {
      const cursor = (await page.locator('.graph-time-cursor').boundingBox())!;

      return Math.abs(cursor.x - (graph.x + graph.width / 4));
    })
    .toBeLessThan(2);
  await page.mouse.move(graph.x + graph.width / 4, graph.y + graph.height / 2);
  await page.mouse.down();
  await plot.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.up();
  await page.mouse.move(graph.x + graph.width * 0.75, graph.y + graph.height / 2);

  await expect(page.locator('.graph-time-cursor.preview')).toContainText('1.500');

  await page.mouse.move(graph.x + graph.width / 4, graph.y + graph.height / 2);
  await page.mouse.down();
  await page.mouse.move(graph.x + graph.width * 0.75, graph.y + graph.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect(page.getByTestId('playback-time')).toContainText('0.500');
  await expect(page.locator('.graph-time-cursor.preview')).toContainText('1.250');

  await page.getByRole('tab', { name: '✧ Vehicle 1' }).click();

  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuemin', '0.5');
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuemax', '1.5');
  expect(errors).toEqual([]);
});

test('paused previews stay under the pointer through timeline and graph zoom, wheel pan, and drag pan', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await seekTime(page, 0.25);

  for (const graph of [false, true]) {
    if (graph) await page.getByRole('tab', { name: '⌁ Graph 1' }).click();

    const surface = graph ? page.locator('.u-over') : page.getByRole('slider', { name: 'Timeline' });
    const preview = page.locator(graph ? '.graph-time-cursor.preview' : '.time-cursor.preview');
    const box = (await surface.boundingBox())!;
    const x = box.x + box.width * 0.75;
    const y = box.y + box.height / 2;

    /**
     * Verify a paused hover updates both the cursor and telemetry without seeking.
     * @param expected Preview seconds, allowing subpixel rounding in browser wheel coordinates.
     * @returns Resolves when both readouts agree within five milliseconds.
     */
    const expectPreviewTime = async (expected: number) => {
      await expect.poll(async () => parseFloat((await preview.textContent()) ?? '')).toBeCloseTo(expected, 2);

      await expect
        .poll(async () => parseFloat((await page.getByTestId('field-time').textContent())!.split('=')[1]))
        .toBeCloseTo(expected, 2);

      await expect(page.getByTestId('playback-time')).toContainText('0.250');
    };

    await page.mouse.move(x, y);
    await expectPreviewTime(1.5);

    const navigation = [
      { deltaY: Math.log(0.5) / 0.002, expected: 1.5 },
      { deltaX: box.width * 0.5, expected: 1.75 },
      { deltaY: Math.log(0.5) / 0.002, expected: 1.75 },
      { shiftKey: true, deltaY: box.width * 0.25, expected: 1.875 },
      { deltaY: Math.log(8) / 0.002, expected: 1.5 },
    ];

    // Deliberately leave the pointer stationary between events, including pans/zooms clamped at coverage edges.
    for (const { expected, ...wheel } of navigation) {
      await surface.dispatchEvent('wheel', { clientX: x, clientY: y, ...wheel });
      await expectPreviewTime(expected);

      await expect.poll(async () => Math.abs((await preview.boundingBox())!.x - x)).toBeLessThan(2);
    }

    await surface.dispatchEvent('wheel', { clientX: x, clientY: y, deltaY: Math.log(0.5) / 0.002 });
    await expectPreviewTime(1.5);
    if (graph) await page.keyboard.down('Shift');
    await page.mouse.down();

    const middle = box.x + box.width / 2;

    await page.mouse.move(middle, y, { steps: 4 });
    await page.mouse.up();
    if (graph) await page.keyboard.up('Shift');
    await expectPreviewTime(1.5);

    await expect.poll(async () => Math.abs((await preview.boundingBox())!.x - middle)).toBeLessThan(2);

    // Restore full coverage for the next view, then verify leaving still restores the selected timestamp.
    await surface.dispatchEvent('wheel', { clientX: middle, clientY: y, deltaY: Math.log(8) / 0.002 });
    await expectPreviewTime(1);
    await page.mouse.move(10, 10);

    await expect(preview).toHaveCount(0);
    await expect(page.getByTestId('field-time')).toContainText('0.250');
  }

  // Navigating while playback runs keeps the hover cursor visible without pausing the clock.
  await page.getByRole('button', { name: 'Play', exact: true }).click();

  const graph = page.locator('.u-over');
  const box = (await graph.boundingBox())!;

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -125);

  await expect(page.locator('.graph-time-cursor.preview')).toBeVisible();

  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  expect(errors).toEqual([]);
});

test('playback autoscroll follows continuously in every view and preserves stationary hover positions', async ({
  page,
}) => {
  const errors = watchErrors(page);
  const csv = [
    flightCsv.split('\n')[0],
    '0,0,0,1,0,0,0,1,0,0,0,0,1',
    '10,10,0,1,0,0,0,1,0,0,0,0,1',
    '20,20,0,1,0,0,1,1,0,0,0,0,1',
    '',
  ].join('\n');

  await page.goto('/');
  await page.getByTestId('trace-input').setInputFiles(uploadFile('scroll-flight.csv', csv));

  await expect(page.locator('.run-title')).toHaveText('scroll-flight.csv');
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);

  const timeline = page.getByRole('slider', { name: 'Timeline' });
  const strip = (await timeline.boundingBox())!;

  // Zoom the twenty-second log to a one-second window using two bounded wheel gestures.
  for (const factor of [0.25, 0.2]) {
    await timeline.dispatchEvent('wheel', {
      clientX: strip.x + strip.width / 2,
      deltaY: Math.log(factor) / 0.002,
    });
  }

  await expect(timeline).toHaveAttribute('aria-valuemin', '9.5');
  await expect(timeline).toHaveAttribute('aria-valuemax', '10.5');

  await seekTime(page, 10.4);
  await page.getByRole('button', { name: 'Play', exact: true }).click();

  /**
   * Observe committed cursor positions in successive rendered frames, using the active view's real geometry.
   * @param graph Whether the active view uses the chart's time axis instead of a timeline bar.
   * @returns Clock times, cursor fractions, and timeline starts for 24 animation frames.
   */
  const recordFrames = (graph: boolean) =>
    page.evaluate(async (isGraph) => {
      const samples: { time: number; fraction: number; start: number | null }[] = [];

      for (let index = 0; index < 24; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

        const surface = document.querySelector(isGraph ? '.u-over' : '.time-strip')!;
        const cursor = document.querySelector(isGraph ? '.graph-time-cursor.committed' : '.time-cursor.committed')!;
        const bounds = surface.getBoundingClientRect();

        samples.push({
          time: parseFloat(document.querySelector('[data-testid=playback-time]')!.textContent!),
          fraction: (cursor.getBoundingClientRect().x - bounds.x) / bounds.width,
          start: isGraph ? null : Number(surface.getAttribute('aria-valuemin')),
        });
      }

      return samples;
    }, graph);

  for (const name of ['◇ Trajectory 1', '⌁ Graph 1', '✧ Vehicle 1']) {
    await page.getByRole('tab', { name, exact: true }).click();

    const graph = name.includes('Graph');
    const surface = graph ? page.locator('.u-over') : timeline;
    const preview = page.locator(graph ? '.graph-time-cursor.preview' : '.time-cursor.preview');
    const box = (await surface.boundingBox())!;
    const x = box.x + box.width * 0.75;

    await page.mouse.move(x, box.y + box.height / 2);

    await expect(preview).toBeVisible();

    const samples = await recordFrames(graph);

    // Chunked scrolling produces a sawtooth cursor between 90% and 100%; continuous follow holds it at 90%.
    for (const sample of samples) expect(Math.abs(sample.fraction - 0.9)).toBeLessThan(0.003);

    expect(samples.at(-1)!.time).toBeGreaterThan(samples[0].time + 0.05);

    if (!graph) expect(new Set(samples.map((sample) => sample.start)).size).toBeGreaterThan(12);

    await expect.poll(async () => Math.abs((await preview.boundingBox())!.x - x)).toBeLessThan(2);
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  }

  // Disabling auto-scroll freezes the viewport while the clock continues beyond its visible range.
  await page.getByLabel('Visualization settings', { exact: true }).click();
  await page.getByLabel('Auto-scroll', { exact: true }).uncheck();
  await page.keyboard.press('Escape');

  const start = await timeline.getAttribute('aria-valuemin');
  const end = await timeline.getAttribute('aria-valuemax');
  const samples = await recordFrames(false);

  expect(samples.at(-1)!.time).toBeGreaterThan(Number(end));
  await expect(timeline).toHaveAttribute('aria-valuemin', start!);
  await expect(timeline).toHaveAttribute('aria-valuemax', end!);

  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  expect(errors).toEqual([]);
});

test('running hover cursors remain visible while field and dock values follow playback', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await page.getByLabel('Search fields', { exact: true }).fill('East position');
  await seekTime(page, 0.25);
  await page.getByLabel('Playback speed', { exact: true }).selectOption('0.1');

  const timeline = page.getByRole('slider', { name: 'Timeline' });
  const strip = (await timeline.boundingBox())!;

  await page.mouse.move(strip.x + strip.width * 0.75, strip.y + strip.height / 2);

  await expect(page.locator('.time-cursor.preview')).toContainText('1.500');

  // Start with the pointer still on the timeline so playback cannot hide an already visible hover cursor.
  await timeline.focus();
  await page.keyboard.press('Space');

  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await expect(page.locator('.time-cursor.preview')).toContainText('1.500');

  for (const graph of [false, true]) {
    if (graph) await page.getByRole('tab', { name: '⌁ Graph 1' }).click();

    const surface = graph ? page.locator('.u-over') : timeline;
    const preview = page.locator(graph ? '.graph-time-cursor.preview' : '.time-cursor.preview');
    const box = (await surface.boundingBox())!;
    const x = box.x + box.width * 0.75;
    const y = box.y + box.height / 2;

    await page.mouse.move(x, y);

    await expect(preview).toContainText('1.500');

    /**
     * Check all readouts in one browser task against the same committed clock snapshot.
     * @returns Whether the browser, dock, and displayed timestamp follow playback rather than the hover time.
     */
    const valuesFollowClock = () =>
      page.evaluate((isGraph) => {
        const clock = parseFloat(document.querySelector('[data-testid=playback-time]')!.textContent!);
        const displayed = parseFloat(document.querySelector('[data-testid=field-time]')!.textContent!.split('=')[1]);
        const field = parseFloat(
          document.querySelector('.field-row[data-field-id="position.0"] [data-testid=field-value]')!.textContent!,
        );
        const id = isGraph ? 'position.0' : 'pose:position';
        const text = document.querySelector(`.binding[data-field-id="${id}"] .binding-value`)!.textContent!;
        const dock = parseFloat(isGraph ? text : text.slice(1));

        return displayed === clock && Math.abs(field - clock) < 0.001 && Math.abs(dock - clock) < 0.001;
      }, graph);

    await expect.poll(valuesFollowClock).toBe(true);

    const before = parseFloat((await page.getByTestId('playback-time').textContent())!);

    await expect
      .poll(async () => parseFloat((await page.getByTestId('playback-time').textContent())!))
      .toBeGreaterThan(before + 0.03);

    await expect(preview).toContainText('1.500');
    await expect.poll(valuesFollowClock).toBe(true);

    if (graph) await expect(page.locator('.graph-time-cursor.committed')).toBeVisible();

    // Wheel zoom, pan, and automatic scrolling must retain the bar under a stationary pointer.
    await surface.dispatchEvent('wheel', { clientX: x, clientY: y, deltaY: Math.log(0.5) / 0.002 });
    await surface.dispatchEvent('wheel', { clientX: x, clientY: y, deltaX: box.width * 0.25 });

    await expect(preview).toBeVisible();
    await expect.poll(async () => Math.abs((await preview.boundingBox())!.x - x)).toBeLessThan(2);
    await expect.poll(valuesFollowClock).toBe(true);
    await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();

    await surface.dispatchEvent('wheel', { clientX: x, clientY: y, deltaY: Math.log(8) / 0.002 });
    await page.mouse.move(10, 10);

    await expect(preview).toHaveCount(0);
    await expect.poll(valuesFollowClock).toBe(true);
  }

  // Clicking the graph during playback still pauses and commits the pointed timestamp.
  const graph = page.locator('.u-over');
  const box = (await graph.boundingBox())!;

  await graph.click({ position: { x: box.width * 0.75, y: box.height / 2 } });

  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByTestId('playback-time')).toContainText('1.500');
  await expect(page.getByTestId('field-time')).toContainText('1.500');
  expect(errors).toEqual([]);
});

test('union coverage and unavailable alignment', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');

  const later = poseCsv
    .replace('0,0,0,1,0,0,0', '1,5,0,1,0,0,0')
    .replace('1,1,0,1,0,0,0', '2,6,0,1,0,0,0')
    .replace('2,2,0,1,0,0,1', '3,7,0,1,0,0,1');

  await page
    .getByTestId('trace-input')
    .setInputFiles([uploadFile('first.csv', poseCsv), uploadFile('later.csv', later)]);

  await expect(page.locator('.run-title')).toHaveText('later.csv');
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuemin', '0');
  await expect(page.getByRole('slider')).toHaveAttribute('aria-valuemax', '3');

  await page.getByLabel('Visualization settings', { exact: true }).click();

  await expect(page.getByRole('button', { name: 'Fit common', exact: true })).toHaveCount(0);

  await page.getByLabel('Time alignment', { exact: true }).selectOption('armed');

  await expect(page.getByText(/Missing alignment event:/)).toBeVisible();

  await page.getByLabel('Time alignment', { exact: true }).selectOption('absolute');

  expect(errors).toEqual([]);
});

test('empty startup waits for a log and timeline ticks replace navigation clutter', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Import a log to view telemetry.')).toBeVisible();
  await expect(page.locator('.binding')).toHaveCount(0);
  await expect(page.locator('.field-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await expect(page.getByLabel('Go to time', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Zoom in time', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Fit time', exact: true })).toHaveCount(0);

  await page.keyboard.press('Space');

  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toHaveCount(0);

  await importFlight(page);

  await expect(page.locator('.time-tick.major').first()).toBeVisible();
  await expect(page.locator('.time-tick.minor').first()).toBeVisible();

  const before = await page.locator('.time-ticks').innerText();

  await zoomIn(page);

  await expect.poll(() => page.locator('.time-ticks').innerText()).not.toBe(before);

  const timeline = page.getByRole('slider');
  const box = (await timeline.boundingBox())!;

  await page.mouse.move(box.x + box.width / 2, box.y + 20);

  await expect(page.locator('.time-cursor.preview')).toBeVisible();
  await expect(page.locator('.time-cursor.preview')).not.toContainText('Preview');

  await page.screenshot({ path: 'artifacts/validation/timeline-ticks.png' });
});
