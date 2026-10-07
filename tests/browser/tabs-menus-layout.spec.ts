import { test, expect } from '@playwright/test';
import { watchErrors, importFlight, openAppearance, seekTime } from './support/actions';

test('independent tabs, models, styles, rename, reorder, duplicate and close', async ({ page }) => {
  const errors = watchErrors(page);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');

  await expect(page.getByRole('tab')).toHaveCount(3);

  const newMenu = page.locator('.new-tab');
  const newButton = page.getByLabel('New visualization', { exact: true });

  await newButton.click();

  await expect(newMenu).toHaveAttribute('open', '');
  await expect(newMenu.locator('button .tab-type-icon')).toHaveCount(3);
  await expect(newMenu.getByRole('button', { name: '3D trajectory', exact: true })).toBeVisible();

  await page.locator('.app-bar > strong').click();

  await expect(newMenu).not.toHaveAttribute('open', '');

  await newButton.click();
  await newButton.press('Escape');

  await expect(newMenu).not.toHaveAttribute('open', '');
  await expect(newButton).toBeFocused();

  for (const name of ['Duplicate', 'Rename', 'Move tab left', 'Move tab right']) {
    await expect(page.getByRole('button', { name, exact: true }).locator('svg')).toHaveCount(1);
  }
  await importFlight(page);

  await expect(page.locator('.scene-canvas canvas')).toBeVisible();

  await seekTime(page, 1);

  // Duplicated tabs inherit appearance settings and then keep independent edits.
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

  const activeTab = page.locator('.tab.active');
  const originalBounds = (await activeTab.boundingBox())!;
  const originalIcon = (await activeTab.locator('.tab-type-icon').boundingBox())!;

  // Renaming must preserve the tab's bounds and icon while the draft title is longer than the saved name.
  await page.getByRole('button', { name: 'Rename', exact: true }).click();

  await expect(activeTab.locator('.tab-type-icon')).toBeVisible();

  await page.getByLabel('Tab name').fill('A much longer name while editing');

  const editingBounds = (await activeTab.boundingBox())!;
  const editingIcon = (await activeTab.locator('.tab-type-icon').boundingBox())!;

  expect(editingBounds.width).toBeCloseTo(originalBounds.width, 1);
  expect(editingBounds.height).toBeCloseTo(originalBounds.height, 1);
  expect(editingIcon.x).toBeCloseTo(originalIcon.x, 1);

  await page.screenshot({ path: 'artifacts/validation/workspace-tab-renaming.png' });
  await page.getByLabel('Tab name').fill('Flight path');
  await page.getByLabel('Tab name').press('Enter');

  await expect(page.getByRole('tab', { name: '◇ Flight path' })).toBeVisible();

  await page.getByRole('button', { name: 'Move tab right' }).click();

  await expect(page.getByRole('tab').nth(1)).toHaveAccessibleName('◇ Flight path');

  // Vehicle model choices remain local to their tab while the committed timestamp stays global.
  await page.getByRole('tab', { name: '✧ Vehicle 1' }).click();
  await openAppearance(page, 'Truth vehicle pose');
  await page.getByLabel('Model Truth vehicle pose', { exact: true }).selectOption('ghost');
  await page.keyboard.press('Escape');
  await page.getByLabel('Follow orientation', { exact: true }).check();

  await expect(page.getByText('Camera follows body orientation')).toBeVisible();

  await openAppearance(page, 'Truth vehicle pose');
  await page.getByLabel('Model Truth vehicle pose', { exact: true }).selectOption('ball');
  await page.getByRole('button', { name: 'Close Vehicle 1', exact: true }).click();

  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.getByTestId('playback-time')).toContainText('1.000');

  await page.screenshot({ path: 'artifacts/validation/workspace-trajectory.png' });

  expect(errors).toEqual([]);
});

test('floating menus dismiss outside, on Escape, and after commands while preserving inside interactions', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);

  const outside = page.locator('.app-bar > strong');
  const workspace = page.getByLabel('Workspace', { exact: true });
  const settings = page.getByLabel('Visualization settings', { exact: true });
  const newTab = page.getByLabel('New visualization', { exact: true });

  for (const trigger of [workspace, settings, newTab]) {
    await trigger.click();

    await expect(page.locator('.menu[open]')).toHaveCount(1);

    await outside.click();

    await expect(page.locator('.menu[open]')).toHaveCount(0);

    await trigger.click();
    await trigger.press('Escape');

    await expect(page.locator('.menu[open]')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }

  // Opening another menu closes the previous one without consuming the new trigger's click.
  await workspace.click();
  await settings.click();

  await expect(page.getByRole('button', { name: 'Save workspace', exact: true })).toBeHidden();

  await page.getByLabel('Angle units', { exact: true }).selectOption('radians');

  await expect(page.locator('.view-settings')).toHaveAttribute('open', '');

  await newTab.click();

  await expect(page.locator('.view-settings')).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Graph', exact: true })).toBeVisible();

  await outside.click();

  await workspace.click();

  const download = page.waitForEvent('download');

  await page.getByRole('button', { name: 'Save workspace', exact: true }).click();
  await download;

  await expect(page.locator('.workspace-menu')).not.toHaveAttribute('open', '');

  await page.getByLabel('Search fields', { exact: true }).fill('Position ENU');

  const add = page
    .locator('.field-row[data-field-id="vector:position"]')
    .getByRole('button', { name: 'Add Position ENU', exact: true });
  const addDialog = page.getByRole('dialog', { name: 'Add Position ENU', exact: true });

  await add.click();

  await expect(addDialog).toBeVisible();

  await addDialog.getByText('Position ENU', { exact: true }).click();

  await expect(addDialog).toBeVisible();

  await outside.click();

  await expect(addDialog).toHaveCount(0);

  await add.click();
  await page.keyboard.press('Escape');

  await expect(addDialog).toHaveCount(0);
  await expect(add).toBeFocused();

  await add.click();
  await workspace.click();

  await expect(addDialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open workspace', exact: true })).toBeVisible();

  await outside.click();
  await add.click();
  await addDialog.getByRole('button', { name: 'Add to 3D fields', exact: true }).click();

  await expect(addDialog).toHaveCount(0);
  await expect(page.locator('.binding[data-field-id="vector:position"]')).toHaveCount(1);

  await openAppearance(page, 'Position ENU');

  const appearance = page.getByRole('dialog', { name: 'Appearance settings for Position ENU', exact: true });

  await page.getByLabel('Line style Position ENU', { exact: true }).selectOption('dashed');

  await expect(appearance).toBeVisible();

  await outside.click();

  await expect(appearance).toHaveCount(0);

  await openAppearance(page, 'Position ENU');
  await page.keyboard.press('Escape');

  await expect(appearance).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Appearance Position ENU', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test('narrow viewport keeps transport and fields accessible', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 800 });
  await page.goto('/');
  await importFlight(page);
  await page.getByLabel('Collapse fields').click();

  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await expect(page.getByLabel('Visualization settings', { exact: true })).toBeInViewport();

  const tabs = (await page.locator('.tab-bar').boundingBox())!;
  const transport = (await page.locator('.transport').boundingBox())!;

  expect(transport.y).toBeGreaterThanOrEqual(tabs.y);
  expect(transport.y + transport.height).toBeLessThanOrEqual(tabs.y + tabs.height);
  expect(transport.x + transport.width).toBeLessThanOrEqual(760);
  await expect(page.locator('.scene-canvas canvas')).toBeVisible();

  await page.getByLabel('Expand fields').click();
  await page.getByLabel('Search fields', { exact: true }).fill('tracking');

  await expect(page.locator('.field-row').first()).toBeVisible();

  await page.screenshot({ path: 'artifacts/validation/workspace-narrow.png' });
});

test('settings menu preserves global playback and independent view options without a configuration bar', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await seekTime(page, 1);

  const settings = page.getByLabel('Visualization settings', { exact: true });

  await expect(page.locator('.app-bar-right').getByLabel('Visualization settings', { exact: true })).toBeVisible();

  const settingsBounds = (await settings.boundingBox())!;

  expect(settingsBounds.x + settingsBounds.width).toBeCloseTo(page.viewportSize()!.width - 14, 0);

  const tabs = (await page.locator('.tabs').boundingBox())!;
  const controls = (await page.locator('.new-tab').boundingBox())!;

  expect(controls.x - (tabs.x + tabs.width)).toBeLessThan(12);

  // Space belongs to the focused menu summary and must not start the global clock.
  await settings.focus();
  await settings.press('Space');

  await expect(page.getByLabel('Angle units', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();

  await page.getByLabel('Loop', { exact: true }).check();
  await page.getByLabel('Angle units', { exact: true }).selectOption('radians');
  await page.getByLabel('Angle units', { exact: true }).press('Escape');

  await expect(page.getByLabel('Angle units', { exact: true })).toBeHidden();
  await expect(settings).toBeFocused();

  await page.getByRole('tab', { name: '⌁ Graph 1' }).click();

  await expect(page.locator('.view-toolbar')).toHaveCount(0);
  await expect(page.locator('.clock-row .transport')).toHaveCount(0);
  await expect(page.locator('.clock-row')).toHaveCount(0);
  await expect(page.locator('.tab-bar .transport')).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Timeline' })).toHaveCount(0);

  await settings.click();

  await expect(page.getByLabel('Loop', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Angle units', { exact: true })).toHaveValue('degrees');

  await page.getByLabel('Select interval', { exact: true }).check();
  await page.screenshot({ path: 'artifacts/validation/workspace-settings.png' });

  // Clicking the chart dismisses settings and selects an export interval without zooming or seeking.
  const plot = page.locator('.u-over');
  const box = (await plot.boundingBox())!;

  await page.mouse.move(box.x + box.width / 4, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + (box.width * 3) / 4, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();

  await expect(page.getByLabel('Angle units', { exact: true })).toBeHidden();

  await expect
    .poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem('rdd2.workspace.v1')!).window))
    .toEqual([0, 2]);

  await expect(page.getByTestId('playback-time')).toContainText('1.000');

  await page.getByRole('button', { name: 'Export', exact: true }).click();

  await expect(page.getByLabel('Interval start', { exact: true })).toHaveValue('0.5');
  await expect(page.getByLabel('Interval end', { exact: true })).toHaveValue('1.5');

  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  await page.getByRole('tab', { name: '✧ Vehicle 1' }).click();

  await expect(page.locator('.view-toolbar')).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Timeline' })).toBeVisible();

  await settings.click();

  await expect(page.getByLabel('Loop', { exact: true })).toBeChecked();
  await expect(page.getByLabel('Angle units', { exact: true })).toHaveValue('degrees');

  await page.getByRole('tab', { name: '◇ Trajectory 1' }).click();

  await expect(page.getByLabel('Angle units', { exact: true })).toBeHidden();
  await expect(page.locator('.view-toolbar')).toHaveCount(0);

  await settings.click();

  await expect(page.getByLabel('Angle units', { exact: true })).toHaveValue('radians');
  expect(errors).toEqual([]);
});
