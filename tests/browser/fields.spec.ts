import { test, expect } from '@playwright/test';
import { watchErrors, importFlight, addField, createView, openAppearance } from './support/actions';

test('graph field additions reject incompatible units without changing existing bindings', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await createView(page, 'Graph');
  await page.getByLabel('Search fields', { exact: true }).fill('Position ENU');
  await page.locator('.field-row[data-field-id="vector:position"]').dragTo(page.getByTestId('drop-left'));
  await expect(page.locator('.binding')).toHaveCount(3);

  const colors = [];

  for (const axis of [0, 1, 2]) {
    const row = page.locator(`.binding-lane[data-lane="left"] .binding[data-field-id="position.${axis}"]`);

    await expect(row).toHaveCount(1);
    colors.push(await row.locator('.binding-appearance svg').getAttribute('stroke'));
  }
  expect(new Set(colors).size).toBe(3);

  // Reject an incompatible drop atomically, then accept the same data on the other axis.
  await addField(page, 'Velocity ENU', 'vector:velocity', 'Left Y axis');
  await expect(page.getByRole('alert')).toContainText('needs the other axis');
  await expect(page.locator('.binding')).toHaveCount(3);
  await addField(page, 'Velocity ENU', 'vector:velocity', 'Right Y axis');
  await expect(page.locator('.binding')).toHaveCount(6);
  await expect(page.locator('.binding-lane[data-lane="right"] .binding')).toHaveCount(3);

  // Editing an existing channel's axis must obey the same compatibility rule as adding it.
  await openAppearance(page, 'East velocity');
  await page.getByLabel('Axis East velocity', { exact: true }).selectOption('left');
  await expect(page.getByLabel('Axis East velocity', { exact: true })).toHaveValue('right');
  await page.keyboard.press('Escape');
  await page
    .locator('.binding[data-field-id="position.1"]')
    .getByRole('button', { name: 'Remove North position', exact: true })
    .click();
  await expect(page.locator('.binding')).toHaveCount(5);
  await expect(page.locator('.binding[data-field-id="position.0"]')).toHaveCount(1);
  await expect(page.locator('.binding[data-field-id="position.2"]')).toHaveCount(1);
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);
  await expect(page.locator('.uplot')).toBeVisible();
  expect(errors).toEqual([]);
});
