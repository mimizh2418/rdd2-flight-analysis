import { test, expect } from '@playwright/test';
import { uploadFile, poseCsv } from './support/fixtures';
import { watchErrors, importFlight, zoomIn } from './support/actions';

test('successful imports fit the shared time window even when new coverage is unchanged', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await zoomIn(page);

  const timeline = page.getByRole('slider', { name: 'Timeline' });

  await expect(timeline).toHaveAttribute('aria-valuemin', '0.5');
  await expect(timeline).toHaveAttribute('aria-valuemax', '1.5');

  // An overlapping log must reset the zoom even though the global coverage still spans 0–2 seconds.
  await page.getByTestId('trace-input').setInputFiles(uploadFile('overlapping.csv', poseCsv));
  await expect(page.locator('.run-title')).toHaveText('overlapping.csv');
  await expect(timeline).toHaveAttribute('aria-valuemin', '0');
  await expect(timeline).toHaveAttribute('aria-valuemax', '2');

  // Importing from a graph tab fits the same shared time axis, including logs beginning before zero.
  await page.getByRole('tab', { name: '⌁ Graph 1' }).click();
  await expect(page.locator('.u-over')).toBeVisible();
  await zoomIn(page);

  const earlier = poseCsv
    .replace('0,0,0,1,0,0,0', '-5,0,0,1,0,0,0')
    .replace('1,1,0,1,0,0,0', '-4,1,0,1,0,0,0')
    .replace('2,2,0,1,0,0,1', '-3,2,0,1,0,0,1');

  await page.getByTestId('trace-input').setInputFiles(uploadFile('earlier.csv', earlier));
  await expect(page.locator('.run-title')).toHaveText('earlier.csv');
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('rdd2.workspace.v1')!).window))
    .toEqual([-5, 2]);
  await page.getByRole('tab', { name: '✧ Vehicle 1' }).click();
  await expect(timeline).toHaveAttribute('aria-valuemin', '-5');
  await expect(timeline).toHaveAttribute('aria-valuemax', '2');

  expect(errors).toEqual([]);
});
