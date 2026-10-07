import { test, expect } from '@playwright/test';
import { uploadFile, flightCsv } from './support/fixtures';
import { watchErrors, createView, addField } from './support/actions';

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

test('motor arrays, rotor arrays, and quaternion orientation expand into independently addressable graph channels', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await page.getByTestId('trace-input').setInputFiles(uploadFile('actuation.csv', actuationCsv));
  await expect(page.locator('.run-title')).toBeVisible();
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);

  // Exercise raw four-value lists and quaternion-to-Euler expansion with one shared import.
  for (const { id, label, prefix, count, lane } of [
    { id: 'motors', label: 'Motor effort commands', prefix: 'motor', count: 4, lane: 'left' },
    { id: 'rotors', label: 'Actual rotor speeds', prefix: 'rotor', count: 4, lane: 'right' },
    { id: 'orientation:q', label: 'Truth orientation', prefix: 'rpy', count: 3, lane: 'left' },
  ]) {
    await createView(page, 'Graph');
    if (lane === 'right') {
      await addField(page, label, id, 'Right Y axis');
    } else {
      await page.getByLabel('Search fields', { exact: true }).fill(label);
      await page.locator(`.field-row[data-field-id="${id}"]`).dragTo(page.getByTestId('drop-left'));
    }

    await expect(page.locator('.binding')).toHaveCount(count);
    await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);
    await expect(page.locator('.uplot')).toBeVisible();
    for (let component = 0; component < count; component++) {
      await expect(
        page.locator(`.binding-lane[data-lane="${lane}"] .binding[data-field-id="${prefix}.${component}"]`),
      ).toHaveCount(1);
    }
  }

  expect(errors).toEqual([]);
});
