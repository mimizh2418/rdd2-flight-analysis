import { test, expect } from '@playwright/test';
import { uploadFile, flightCsv } from './support/fixtures';
import { watchErrors, importFlight, addField, createView, openAppearance } from './support/actions';

test('field Add menu stays beside its row, fits narrow viewports, and closes when the row scrolls away', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await page.getByLabel('Search fields', { exact: true }).fill('m');

  const trigger = page
    .locator('.field-row[data-field-id="vector:position"]')
    .getByRole('button', { name: 'Add Position ENU', exact: true });
  const menu = page.getByRole('dialog', { name: 'Add Position ENU', exact: true });

  await trigger.click();

  await expect(menu).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  const anchor = (await trigger.boundingBox())!;
  const initial = (await menu.boundingBox())!;

  expect(initial.x).toBeCloseTo(anchor.x + anchor.width + 6, 0);
  expect(initial.y).toBeCloseTo(anchor.y, 0);

  await page.screenshot({ path: 'artifacts/validation/field-add-menu.png' });

  await page.locator('.field-list').evaluate((element) => {
    element.scrollTop = 30;
  });

  await expect.poll(async () => (await menu.boundingBox())?.y).toBeCloseTo(initial.y - 30, 0);

  await page.setViewportSize({ width: 500, height: 460 });

  await expect(menu).toBeInViewport();

  await expect
    .poll(async () => {
      const button = await trigger.boundingBox();
      const popup = await menu.boundingBox();

      return (
        !!button &&
        !!popup &&
        popup.x >= 8 &&
        popup.y >= 8 &&
        popup.x + popup.width <= button.x &&
        popup.y + popup.height <= 452
      );
    })
    .toBe(true);

  await page.locator('.field-list').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });

  await expect(menu).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('field drag/drop and keyboard Add respect lane types and axis units', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await createView(page, 'Graph');
  await page.getByLabel('Search fields', { exact: true }).fill('Position ENU');
  await page.locator('.field-row[data-field-id="vector:position"]').dragTo(page.getByTestId('drop-left'));

  await expect(page.locator('.binding')).toHaveCount(3);
  await expect(page.locator('.binding[data-field-id="vector:position"]')).toHaveCount(0);

  // Dropping a vector creates three scalar bindings, each with its own color and appearance configuration.
  const positionRows = ['position.0', 'position.1', 'position.2'].map((id) =>
    page.locator(`.binding[data-field-id="${id}"]`),
  );
  const colors = [];

  for (const row of positionRows) {
    await expect(page.locator('.binding-lane[data-lane="left"]').locator(row)).toBeVisible();

    colors.push(await row.locator('.binding-appearance svg').getAttribute('stroke'));

    expect(await row.locator('[data-appearance=line]').getAttribute('stroke-dasharray')).toBeNull();
  }

  expect(new Set(colors).size).toBe(3);
  await expect(page.locator('.uplot')).toBeVisible();

  // Velocity units cannot share the position axis, but can occupy the other independently scaled axis.
  await addField(page, 'Velocity ENU', 'vector:velocity', 'Left Y axis');

  await expect(page.getByRole('alert')).toContainText('needs the other axis');
  await expect(page.locator('.binding')).toHaveCount(3);

  await addField(page, 'Velocity ENU', 'vector:velocity', 'Right Y axis');

  await expect(page.locator('.binding')).toHaveCount(6);
  await expect(page.locator('.binding-lane[data-lane="right"] .binding')).toHaveCount(3);

  await openAppearance(page, 'East velocity');
  await page.getByLabel('Axis East velocity', { exact: true }).selectOption('left');

  await expect(page.locator('.binding')).toHaveCount(6);
  await expect(page.getByLabel('Axis East velocity', { exact: true })).toHaveValue('right');

  const position = positionRows[0];

  await position.getByRole('button', { name: 'Hide East position', exact: true }).click();

  await expect(
    page.locator('.graph-legend').getByRole('button', { name: 'Show East position', exact: true }),
  ).toBeVisible();
  await expect(positionRows[1].getByRole('button', { name: 'Hide North position', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await page.locator('.graph-legend').getByRole('button', { name: 'Show East position', exact: true }).click();

  await expect(position.getByRole('button', { name: 'Hide East position', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await openAppearance(page, 'East position');
  await page.getByRole('button', { name: 'Blue color for East position', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Blue color for East position', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('input[type=color]')).toHaveCount(0);

  await page.getByLabel('Line weight East position').fill('4');
  await page.getByLabel('Line style East position').selectOption('dotted');

  await expect(positionRows[1].locator('.binding-appearance svg')).toHaveAttribute('stroke', colors[1]!);
  expect(await positionRows[1].locator('[data-appearance=line]').getAttribute('stroke-dasharray')).toBeNull();
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);
  await expect(page.locator('.uplot canvas').first()).toBeVisible();

  await page.getByLabel('Dismiss error').click();
  await page.screenshot({ path: 'artifacts/validation/workspace-graph.png' });
  await positionRows[1].getByRole('button', { name: 'Remove North position', exact: true }).click();

  await expect(page.locator('.binding')).toHaveCount(5);
  await expect(positionRows[0]).toBeVisible();
  await expect(positionRows[2]).toBeVisible();
  expect(errors).toEqual([]);
});

test('compact field rows show scalar precision, appearance previews, and eye-button visibility', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');

  const csv = flightCsv.replace('0,0,0,1,0,0,0', '0,0.123456789,0,1,0,0,0');

  await page.getByTestId('trace-input').setInputFiles(uploadFile('precision.csv', csv));

  await expect(page.locator('.run-title')).toHaveText('precision.csv');

  await page.getByRole('tab', { name: '⌁ Graph 1' }).click();

  await expect(page.locator('.uplot')).toBeVisible();

  const row = page.locator('.binding[data-field-id="position.0"]');

  await expect(row.locator('.binding-value')).toHaveText('0.123457 m');

  const label = (await row.getByLabel('Label East position', { exact: true }).boundingBox())!;
  const value = (await row.locator('.binding-value').boundingBox())!;

  expect(value.y).toBeGreaterThanOrEqual(label.y + label.height);
  await expect(page.getByLabel('Line style East position', { exact: true })).toHaveCount(0);

  await openAppearance(page, 'East position');
  await page.getByRole('button', { name: 'Blue color for East position', exact: true }).click();
  await page.getByLabel('Line style East position', { exact: true }).selectOption('dashed');

  await expect(row.locator('.binding-appearance svg')).toHaveAttribute('stroke', '#6dacf8');
  await expect(row.locator('[data-appearance=line]')).toHaveAttribute('stroke-dasharray', '6 4');
  await expect(
    page.getByRole('dialog', { name: 'Appearance settings for East position', exact: true }),
  ).toBeInViewport();

  await page.screenshot({ path: 'artifacts/validation/workspace-field-appearance.png' });
  await row.getByRole('button', { name: 'Hide East position', exact: true }).click();

  await expect(row.getByRole('button', { name: 'Show East position', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(row.locator('[data-appearance=hidden]')).toHaveCount(1);
  await expect(page.getByRole('dialog', { name: 'Appearance settings for East position', exact: true })).toHaveCount(0);

  const eye = (await row.locator('.visibility').boundingBox())!;
  const remove = (await row.locator('.remove').boundingBox())!;

  expect(eye.x + eye.width).toBeLessThanOrEqual(remove.x);

  await row.getByRole('button', { name: 'Show East position', exact: true }).click();

  await expect(row.locator('[data-appearance=hidden]')).toHaveCount(0);

  await row.getByRole('button', { name: 'Remove East position', exact: true }).click();

  await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('derived diagnostics expose nested groups and error vectors with independent graph components', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);

  const browser = page.getByRole('complementary', { name: 'Available telemetry fields' });

  await expect(browser.getByRole('button', { name: '▸ Motion', exact: true })).toBeVisible();
  await expect(browser.getByRole('button', { name: '▸ Tracking', exact: true })).toBeVisible();

  // Search expands the ancestry and reveals the aggregate plus each independently selectable ENU component.
  await page.getByLabel('Search fields', { exact: true }).fill('Position tracking error');

  const vector = page.locator('.field-row[data-field-id="vector:tracking"]');

  await expect(vector).toBeVisible();
  await expect(browser.getByRole('button', { name: '▾ Position error', exact: true })).toBeVisible();
  await expect(vector.getByTestId('field-value')).toHaveText('[0.00, 0.00, 0.00] m');

  for (const axis of [0, 1, 2]) {
    await expect(page.locator(`.field-row[data-field-id="tracking.${axis}"]`)).toBeVisible();
  }
  await vector.getByRole('button', { name: 'Add Position tracking error ENU', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Add to 3D fields', exact: true })).toBeDisabled();

  await page.keyboard.press('Escape');

  await createView(page, 'Graph');
  await vector.dragTo(page.getByTestId('drop-left'));

  await expect(page.locator('.binding')).toHaveCount(3);
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);
  await expect(page.locator('.uplot')).toBeVisible();

  const colors: string[] = [];

  for (const axis of [0, 1, 2]) {
    const row = page.locator(`.binding[data-field-id="tracking.${axis}"]`);

    await expect(row).toBeVisible();

    colors.push((await row.locator('.binding-appearance svg').getAttribute('stroke'))!);
  }

  expect(new Set(colors).size).toBe(3);

  const dock = page.getByRole('region', { name: 'Visualized fields' });

  await dock.getByRole('button', { name: 'Hide North tracking error', exact: true }).click();

  await expect(dock.getByRole('button', { name: 'Show North tracking error', exact: true })).toBeVisible();
  await expect(dock.getByRole('button', { name: 'Hide East tracking error', exact: true })).toBeVisible();

  await page.screenshot({ path: 'artifacts/validation/derived-diagnostics.png' });

  expect(errors).toEqual([]);
});

test('compact pose hierarchy exposes independently selectable vectors and scalar components', async ({ page }) => {
  await page.goto('/');
  await importFlight(page);

  const pose = page.locator('.field-row[data-field-id="pose:position"]');

  await expect(pose).toBeVisible();
  await expect(page.locator('.field-row[data-field-id="vector:position"]')).toHaveCount(0);

  await pose.getByRole('button', { name: 'Expand Truth vehicle pose', exact: true }).click();

  const position = page.locator('.field-row[data-field-id="vector:position"]');

  await expect(position).toBeVisible();
  await expect(page.locator('.field-row[data-field-id="orientation:q"]')).toBeVisible();

  await position.getByRole('button', { name: 'Expand Position ENU', exact: true }).click();

  const east = page.locator('.field-row[data-field-id="position.0"]');

  await expect(east).toBeVisible();
  await expect(east.getByTestId('field-value')).toContainText('0.000');

  await createView(page, 'Graph');
  await east.dragTo(page.getByTestId('drop-left'));

  await expect(page.locator('.binding[data-field-id="position.0"]')).toHaveCount(1);

  await position.getByRole('button', { name: 'Add Position ENU', exact: true }).click();
  await page.getByRole('button', { name: 'Add to Left Y axis', exact: true }).click();

  await expect(page.locator('.binding')).toHaveCount(4);
  await expect(page.locator('.binding[data-field-id="position.0"]')).toHaveCount(2);
  await expect(page.locator('.binding[data-field-id="position.1"]')).toHaveCount(1);
  await expect(page.locator('.binding[data-field-id="position.2"]')).toHaveCount(1);

  await page.getByLabel('Search fields', { exact: true }).fill('yaw');

  await expect(page.locator('.field-row[data-field-id="rpy.2"]')).toBeVisible();

  await page.screenshot({ path: 'artifacts/validation/nested-fields.png' });
});
