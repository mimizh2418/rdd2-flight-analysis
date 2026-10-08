import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tableFromIPC } from 'apache-arrow';
import { watchErrors } from './support/actions';

test('Python Arrow imports, restores workspaces, and exports event rows with embedded metadata', async ({ page }) => {
  const errors = watchErrors(page);
  const fixture = resolve('tests/fixtures/python-flight.arrow');
  await page.goto('/');
  await page.getByTestId('trace-input').setInputFiles(fixture);
  await expect(page.locator('.run-title')).toHaveText('Python Arrow flight');
  await expect(page.locator('.binding[data-field-id="mission:plan"]')).toBeVisible();
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);

  // Reimport the same bytes after a reload to verify that Arrow fingerprints restore saved bindings.
  const binding = await page.locator('.binding').first().getAttribute('data-binding-id');
  await page.reload();
  await page.getByTestId('trace-input').setInputFiles(fixture);
  await expect(page.locator(`.binding[data-binding-id="${binding}"]`)).toBeVisible();

  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByLabel('Interval start', { exact: true }).fill('1');
  await page.getByLabel('Interval end', { exact: true }).fill('1.5');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export selection Arrow', exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe('rdd2-selection.arrow');
  const bytes = await readFile((await download.path())!);
  const table = tableFromIPC(bytes);
  expect(Array.from(table.getChild('time_s')!.toArray())).toEqual([1, 1, 1.0000000000000002]);
  expect(Array.from(table.getChild('x_m')!.toArray())).toEqual([1, 2, 3]);
  const metadata = JSON.parse(table.schema.metadata.get('rdd2:manifest')!);
  expect(metadata.mission.waypoints).toEqual([
    [0, 0, 1],
    [4, 0, 1],
  ]);
  expect(metadata.selection.source_file_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(metadata.csv_sha256).toBeUndefined();
  await page.keyboard.press('Escape');

  await page
    .getByTestId('trace-input')
    .setInputFiles({ name: 'selection.arrow', mimeType: 'application/vnd.apache.arrow.file', buffer: bytes });
  await expect(page.getByRole('button', { name: 'Runs 2', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a malformed Arrow in a mixed batch leaves existing logs intact', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('trace-input').setInputFiles(resolve('tests/fixtures/python-flight.arrow'));
  await expect(page.locator('.run-title')).toHaveText('Python Arrow flight');
  await page.getByTestId('trace-input').setInputFiles([
    { name: 'valid.csv', mimeType: 'text/csv', buffer: Buffer.from('time,x\n0,1\n1,2\n') },
    { name: 'broken.arrow', mimeType: 'application/vnd.apache.arrow.file', buffer: Buffer.from('broken') },
  ]);
  await expect(page.getByRole('alert')).toContainText('Expected an Arrow IPC file');
  await expect(page.getByRole('button', { name: 'Runs 1', exact: true })).toBeVisible();
});
