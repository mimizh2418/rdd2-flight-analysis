import { test, expect } from '@playwright/test';
import { flightCsv, uploadFile } from './support/fixtures';
import { addField, openAppearance, watchErrors } from './support/actions';

test('reference drones default to yaw-only orientation and retain truth/estimate overrides', async ({ page }) => {
  const errors = watchErrors(page);
  const csv = flightCsv
    .trim()
    .split('\n')
    .map((line, index) =>
      index === 0
        ? `${line},avionics.reference.yaw,estimator.estimate.valid,` +
          'estimator.estimate.quaternionWorldBody[1],estimator.estimate.quaternionWorldBody[2],' +
          'estimator.estimate.quaternionWorldBody[3],estimator.estimate.quaternionWorldBody[4]'
        : `${line},${index * 0.2},1,1,0,0,0`,
    )
    .join('\n');

  await page.goto('/');
  await page.getByTestId('trace-input').setInputFiles(uploadFile('reference.csv', csv));
  await expect(page.locator('.run-title')).toHaveText('reference.csv');
  await addField(page, 'Reference position marker', 'pose:reference.position', '3D fields');

  const row = page.locator('.binding[data-field-id="pose:reference.position"]');

  await expect(row).toHaveAttribute('aria-busy', 'false');
  await expect(row.locator('[data-appearance=drone]')).toHaveCount(1);
  await openAppearance(page, 'Reference position marker');

  const model = page.getByLabel('Model Reference position marker', { exact: true });
  const orientation = page.getByLabel('Orientation Reference position marker', { exact: true });

  await expect(model).toHaveValue('drone');
  await expect(orientation).toHaveValue('auto');
  await expect(orientation.locator('option:checked')).toHaveText('Reference yaw (zero roll/pitch)');

  for (const label of ['Truth orientation · reference.csv', 'Estimated orientation · reference.csv']) {
    await orientation.selectOption({ label });
    await expect(row).toHaveAttribute('aria-busy', 'false');
    await expect(orientation.locator('option:checked')).toHaveText(label);
    await expect(model).toHaveValue('drone');
  }

  await orientation.selectOption('none');
  await expect(row).toHaveAttribute('aria-busy', 'false');
  await model.selectOption('ghost');
  await expect(row.locator('[data-appearance=ghost]')).toHaveCount(1);
  await orientation.selectOption('auto');
  await expect(orientation.locator('option:checked')).toHaveText('Reference yaw (zero roll/pitch)');
  expect(errors).toEqual([]);
});
