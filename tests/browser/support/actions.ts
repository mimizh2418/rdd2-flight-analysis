import { expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { uploadFile, flightCsv, createManifest } from './fixtures';

/**
 * Observe unhandled browser exceptions for the whole test.
 * @param page Browser page under test.
 * @returns Mutable collection of unhandled exceptions; callers assert it remains empty.
 */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];

  page.on('pageerror', (error) => errors.push(error.message));

  return errors;
}

/**
 * Import fixtures and await publication of the completed batch.
 * @param page Browser page under test.
 * @returns Promise after the verified analytic flight and initial field preparations are ready.
 */
export async function importFlight(page: Page): Promise<void> {
  await page
    .getByTestId('trace-input')
    .setInputFiles([
      uploadFile('flight.csv', flightCsv),
      uploadFile('manifest.json', JSON.stringify(createManifest(flightCsv))),
    ]);

  await expect(page.locator('.run-title')).toHaveText('Analytic flight');
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);
}

/**
 * Download an export and read its exact UTF-8 content.
 * @param page Browser page whose download event is observed.
 * @param name Exact accessible export-button name.
 * @returns Promise of downloaded UTF-8 file contents.
 */
export async function downloadText(page: Page, name: string): Promise<string> {
  const pending = page.waitForEvent('download');

  await page.getByRole('button', { name, exact: true }).click();

  const download = await pending;

  return readFile((await download.path())!, 'utf8');
}

/**
 * Select a field by catalog identity and use the accessible Add alternative to dragging.
 * @param page Browser page under test.
 * @param query Search text revealing the desired catalog row.
 * @param id Canonical field identity.
 * @param lane Accessible destination-column label.
 * @returns Promise after the field-add action has been dispatched.
 */
export async function addField(page: Page, query: string, id: string, lane: string): Promise<void> {
  await page.getByLabel('Search fields', { exact: true }).fill(query);

  const row = page.locator(`.field-row[data-field-id="${id}"]`).first();

  await row.getByRole('button', { name: /^Add / }).click();
  await page.getByRole('button', { name: `Add to ${lane}`, exact: true }).click();
}

/**
 * Create an empty tab through the New visualization menu.
 * @param page Browser page under test.
 * @param name Exact accessible view-type name.
 * @returns Promise after the new empty tab is activated.
 */
export async function createView(page: Page, name: string): Promise<void> {
  await page.getByLabel('New visualization').click();
  await page.getByRole('button', { name, exact: true }).click();
}

/**
 * Open a field's appearance dialog through the compact dock's preview button.
 * @param page Browser page containing the active tab's dock.
 * @param label Exact editable field label.
 * @returns Promise after the field's popup is visible; an already-open dialog remains open.
 */
export async function openAppearance(page: Page, label: string): Promise<void> {
  const button = page.getByRole('button', { name: `Appearance ${label}`, exact: true });

  if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();

  await expect(page.getByRole('dialog', { name: `Appearance settings for ${label}`, exact: true })).toBeVisible();
}

/**
 * Seek through the user-facing timeline without a numeric timestamp input.
 * @param page Browser page with a 3D timeline.
 * @param time Desired displayed timestamp inside the current time window.
 * @returns Promise after pointer seek commits; leaves the timeline to clear hover preview.
 * @remarks Clicking also pauses active playback. The requested time must be within the visible window.
 */
export async function seekTime(page: Page, time: number): Promise<void> {
  const timeline = page.getByRole('slider', { name: 'Timeline' });
  const start = Number(await timeline.getAttribute('aria-valuemin'));
  const end = Number(await timeline.getAttribute('aria-valuemax'));
  const bounds = (await timeline.boundingBox())!;

  await timeline.click({ position: { x: ((time - start) / (end - start)) * bounds.width, y: 20 } });
  await page.mouse.move(10, 10);
}

/**
 * Zoom around the center of the timeline or chart with a wheel gesture.
 * @param page Browser page containing one active visualization.
 * @returns Promise after dispatching a two-times magnification gesture.
 */
export async function zoomIn(page: Page): Promise<void> {
  const surface = (await page.locator('.u-over').count()) ? page.locator('.u-over') : page.getByRole('slider');
  const box = (await surface.boundingBox())!;

  await surface.dispatchEvent('wheel', { clientX: box.x + box.width / 2, deltaY: Math.log(0.5) / 0.002 });
}
