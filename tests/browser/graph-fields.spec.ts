import { test, expect } from '@playwright/test';
import { uploadFile, flightCsv } from './support/fixtures';
import { watchErrors, createView, addField, openAppearance } from './support/actions';

/** Motor commands and measured rotor speeds extend the same three-sample flight fixture. */
const actuationHeaders = [
  ...[1, 2, 3, 4].map((index) => `motorCommand[${index}]`),
  ...[1, 2, 3, 4].map((index) => `plant.motorOmega_rad_s[${index}]`),
];
const actuationCsv =
  flightCsv
    .trim()
    .split('\n')
    .map((row, index) => `${row},${index ? '0.1,0.2,0.3,0.4,100,200,300,400' : actuationHeaders.join(',')}`)
    .join('\n') + '\n';

for (const { id, label, prefix, count } of [
  { id: 'motors', label: 'Motor effort commands', prefix: 'motor', count: 4 },
  { id: 'rotors', label: 'Actual rotor speeds', prefix: 'rotor', count: 4 },
  { id: 'orientation:q', label: 'Truth orientation', prefix: 'rpy', count: 3 },
]) {
  test(`${label} splits into independent graph fields through drag/drop and Add`, async ({ page }) => {
    const errors = watchErrors(page);

    await page.goto('/');
    await page.getByTestId('trace-input').setInputFiles(uploadFile('actuation.csv', actuationCsv));
    await expect(page.locator('.run-title')).toBeVisible();
    await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);
    await createView(page, 'Graph');
    await page.getByLabel('Search fields', { exact: true }).fill(label);
    await page.locator(`.field-row[data-field-id="${id}"]`).dragTo(page.getByTestId('drop-left'));

    await expect(page.locator('.binding')).toHaveCount(count);
    await expect(page.locator(`.binding[data-field-id="${id}"]`)).toHaveCount(0);
    await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);
    await expect(page.locator('.uplot')).toBeVisible();

    const colors: string[] = [];

    for (let component = 0; component < count; component++) {
      const row = page.locator(`.binding[data-field-id="${prefix}.${component}"]`);

      await expect(page.locator('.binding-lane[data-lane="left"]').locator(row)).toBeVisible();
      colors.push((await row.locator('.binding-appearance svg').getAttribute('stroke'))!);
    }

    expect(new Set(colors).size).toBe(count);

    // Appearance and visibility belong to individual components, not the dropped aggregate.
    const first = page.locator(`.binding[data-field-id="${prefix}.0"]`);
    const second = page.locator(`.binding[data-field-id="${prefix}.1"]`);
    const firstLabel = await first.locator('.binding-label').inputValue();
    const secondLabel = await second.locator('.binding-label').inputValue();

    await openAppearance(page, firstLabel);
    await page.getByLabel(`Line style ${firstLabel}`, { exact: true }).selectOption('dashed');
    await page.keyboard.press('Escape');
    await expect(first.locator('[data-appearance=line]')).toHaveAttribute('stroke-dasharray', /.+/);
    expect(await second.locator('[data-appearance=line]').getAttribute('stroke-dasharray')).toBeNull();

    await first.getByRole('button', { name: `Hide ${firstLabel}`, exact: true }).click();
    await expect(first.getByRole('button', { name: `Show ${firstLabel}`, exact: true })).toBeVisible();
    await expect(second.getByRole('button', { name: `Hide ${secondLabel}`, exact: true })).toBeVisible();

    await first.getByRole('button', { name: `Remove ${firstLabel}`, exact: true }).click();
    await expect(page.locator('.binding')).toHaveCount(count - 1);

    // The accessible Add menu uses the same expansion on the other axis, including repeated source channels.
    await addField(page, label, id, 'Right Y axis');
    await expect(page.locator('.binding-lane[data-lane="right"] .binding')).toHaveCount(count);
    await expect(page.locator('.binding')).toHaveCount(count * 2 - 1);
    await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
}
