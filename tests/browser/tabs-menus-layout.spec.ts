import { test, expect } from '@playwright/test';
import { watchErrors, importFlight, openAppearance, seekTime } from './support/actions';

test('duplicated tabs keep independent settings while sharing playback time', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await seekTime(page, 1);
  await openAppearance(page, 'Truth vehicle pose');
  await page.getByLabel('Line style Truth vehicle pose').selectOption('dotted');
  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(4);

  await openAppearance(page, 'Truth vehicle pose');
  await page.getByLabel('Line style Truth vehicle pose').selectOption('dashed');
  await page.getByRole('tab', { name: '◇ Trajectory 1', exact: true }).click();
  await openAppearance(page, 'Truth vehicle pose');
  await expect(page.getByLabel('Line style Truth vehicle pose')).toHaveValue('dotted');
  await expect(page.getByTestId('playback-time')).toContainText('1.000');

  await page.getByRole('tab', { name: '◇ Trajectory 1 copy', exact: true }).click();
  await page.getByRole('button', { name: 'Close Trajectory 1 copy', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.getByTestId('playback-time')).toContainText('1.000');
  expect(errors).toEqual([]);
});

test('menus handle outside clicks, keyboard focus, and interactions inside portaled dialogs', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);

  const outside = page.locator('.app-bar > strong');

  // All three top-level menus share dismissal logic; retain one focused check of that shared behavior.
  for (const label of ['Workspace', 'Visualization settings', 'New visualization']) {
    const trigger = page.getByLabel(label, { exact: true });

    await trigger.click();
    await outside.click();
    await expect(page.locator('.menu[open]')).toHaveCount(0);
    await trigger.click();
    await trigger.press('Escape');
    await expect(page.locator('.menu[open]')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }

  // Opening a different menu must close the previous one without consuming the new click.
  await page.getByLabel('Workspace', { exact: true }).click();
  await page.getByLabel('Visualization settings', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save workspace', exact: true })).toBeHidden();
  await page.getByLabel('Angle units', { exact: true }).selectOption('radians');
  await expect(page.locator('.view-settings')).toHaveAttribute('open', '');
  await outside.click();

  await page.getByLabel('Search fields', { exact: true }).fill('Position ENU');
  const add = page.locator('.field-row[data-field-id="vector:position"]').getByRole('button', { name: /^Add / });
  const dialog = page.getByRole('dialog', { name: 'Add Position ENU', exact: true });

  await add.click();
  await dialog.getByText('Position ENU', { exact: true }).click();
  await expect(dialog).toBeVisible();
  await outside.click();
  await expect(dialog).toHaveCount(0);
  await add.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(add).toBeFocused();

  await openAppearance(page, 'Truth vehicle pose');
  await page.getByLabel('Line style Truth vehicle pose').selectOption('dashed');
  await expect(page.getByRole('dialog', { name: 'Appearance settings for Truth vehicle pose' })).toBeVisible();
  await outside.click();
  await expect(page.getByRole('dialog', { name: 'Appearance settings for Truth vehicle pose' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('view settings remain independent and chart interval selection does not seek or zoom', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await seekTime(page, 1);

  const settings = page.getByLabel('Visualization settings', { exact: true });

  // Space belongs to the focused menu trigger, not the application's global playback shortcut.
  await settings.focus();
  await settings.press('Space');
  await page.getByLabel('Loop', { exact: true }).check();
  await page.getByLabel('Angle units', { exact: true }).selectOption('radians');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '⌁ Graph 1' }).click();
  await settings.click();
  await expect(page.getByLabel('Loop', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Angle units', { exact: true })).toHaveValue('degrees');
  await page.getByLabel('Select interval', { exact: true }).check();

  const plot = page.locator('.u-over');
  const box = (await plot.boundingBox())!;

  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + (box.width * 3) / 4, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('rdd2.workspace.v1')!).window))
    .toEqual([0, 2]);
  await expect(page.getByTestId('playback-time')).toContainText('1.000');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByLabel('Interval start', { exact: true })).toHaveValue('0.5');
  await expect(page.getByLabel('Interval end', { exact: true })).toHaveValue('1.5');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('tab', { name: '◇ Trajectory 1' }).click();
  await settings.click();
  await expect(page.getByLabel('Angle units', { exact: true })).toHaveValue('radians');
  expect(errors).toEqual([]);
});
