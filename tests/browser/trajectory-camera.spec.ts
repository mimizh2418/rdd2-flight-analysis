import { test, expect } from '@playwright/test';
import { uploadFile, flightCsv } from './support/fixtures';
import { watchErrors, importFlight, addField, seekTime } from './support/actions';
import { observeTrajectoryCamera, trajectoryCamera, expectCameraPosition } from './support/camera';

test('trajectory follow tracks the selected pose, preserves zoom, and holds through unavailable samples', async ({
  page,
}) => {
  const errors = watchErrors(page);

  await observeTrajectoryCamera(page);
  await page.goto('/');
  await importFlight(page);
  await addField(page, 'Reference position marker', 'pose:reference.position', '3D fields');
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(
    page.getByRole('group', { name: '3D view controls' }).getByLabel('Follow pose', { exact: true }),
  ).toContainText('Truth vehicle pose');

  const selector = page.getByLabel('Follow pose', { exact: true });
  const poseMenu = page.locator('.follow-pose-menu');

  // The selected target and individual choices use model icons without trajectory lines.
  await expect(selector.locator('[data-appearance=drone]')).toHaveCount(1);
  await expect(selector.locator('[data-appearance=line]')).toHaveCount(0);
  await selector.click();
  await expect(
    poseMenu.getByRole('button', { name: 'Truth vehicle pose', exact: true }).locator('[data-appearance=drone]'),
  ).toHaveCount(1);
  await expect(
    poseMenu.getByRole('button', { name: 'Reference position marker', exact: true }).locator('[data-appearance=drone]'),
  ).toHaveCount(1);
  await page.mouse.click(10, 10);
  await expect(poseMenu).not.toHaveAttribute('open');
  await selector.click();
  await page.keyboard.press('Escape');
  await expect(poseMenu).not.toHaveAttribute('open');
  await expect(selector).toBeFocused();
  await page.getByRole('slider', { name: 'Timeline' }).press('Home');

  const initial = await trajectoryCamera(page);

  await page.getByRole('slider', { name: 'Timeline' }).press('End');
  await page.mouse.move(10, 10);
  await expectCameraPosition(
    page,
    initial.position.map((value, axis) => value + (axis === 0 ? 2 : 0)),
  );

  const moving = await trajectoryCamera(page);

  // The drone yaws at t=2; following its position must retain the world camera direction.
  moving.forward.forEach((value, axis) => expect(value).toBeCloseTo(initial.forward[axis], 4));

  // Playback moves the rendered camera continuously, using the same global clock as the telemetry readout.
  await page.getByRole('slider', { name: 'Timeline' }).press('Home');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(async () => parseFloat((await page.getByTestId('playback-time').textContent())!))
    .toBeGreaterThan(0.2);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  const pausedTime = parseFloat((await page.getByTestId('playback-time').textContent())!);

  await expect
    .poll(async () => Math.abs((await trajectoryCamera(page)).position[0] - initial.position[0] - pausedTime))
    .toBeLessThan(0.002);
  await page.getByRole('slider', { name: 'Timeline' }).press('End');
  await page.mouse.move(10, 10);

  // Select a stationary pose instead of the first binding, retaining the same relative camera offset.
  await page.getByLabel('Follow pose', { exact: true }).click();
  await page
    .locator('.follow-pose-menu')
    .getByRole('button', { name: 'Reference position marker', exact: true })
    .click();
  await expect(poseMenu).not.toHaveAttribute('open');
  await expect(selector.locator('[data-appearance=drone]')).toHaveCount(1);
  await expectCameraPosition(page, initial.position);
  await seekTime(page, 1);
  await expectCameraPosition(page, initial.position);

  const canvas = page.getByLabel('Trajectory 3D view', { exact: true });
  const beforeZoom = await trajectoryCamera(page);

  /** Return the camera's distance in metres from the stationary reference pose at (0, 0, 1). */
  const distance = (position: number[]) => Math.hypot(position[0], position[1], position[2] - 1);

  await canvas.hover();
  await page.mouse.wheel(0, -200);
  await expect
    .poll(async () => distance((await trajectoryCamera(page)).position))
    .toBeLessThan(distance(beforeZoom.position));

  const zoomed = await trajectoryCamera(page);
  const reference = page.locator('.binding[data-field-id="pose:reference.position"]');

  await reference.getByRole('button', { name: 'Hide Reference position marker', exact: true }).click();
  await page.getByRole('slider', { name: 'Timeline' }).press('End');
  await page.mouse.move(10, 10);
  await expectCameraPosition(page, zoomed.position);
  await reference.getByRole('button', { name: 'Show Reference position marker', exact: true }).click();
  await expectCameraPosition(page, zoomed.position);

  // Removing the followed field releases the camera into orbit without a new fit or a different target.
  await reference.getByRole('button', { name: 'Remove Reference position marker', exact: true }).click();
  await expectCameraPosition(page, zoomed.position);
  await expect(page.getByRole('button', { name: 'Orbit', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Follow pose', { exact: true })).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('trajectory follow selection survives duplication and workspace reattachment', async ({ page }) => {
  const errors = watchErrors(page);

  await page.goto('/');
  await importFlight(page);
  await page.getByRole('button', { name: 'Follow', exact: true }).click();

  const originalId = await page
    .getByLabel('Follow pose', { exact: true })
    .locator('[data-binding-id]')
    .getAttribute('data-binding-id');

  await page.getByRole('button', { name: 'Duplicate', exact: true }).click();

  const duplicateId = await page
    .getByLabel('Follow pose', { exact: true })
    .locator('[data-binding-id]')
    .getAttribute('data-binding-id');

  expect(duplicateId).not.toBe(originalId);
  await expect(page.locator(`.binding[data-binding-id="${duplicateId}"]`)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Follow', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // Reattachment retains the selected binding identity without guessing another source.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const workspace = JSON.parse(localStorage.getItem('rdd2.workspace.v1')!);

        return workspace.tabs.find((tab: { id: string }) => tab.id === workspace.active)?.followPose;
      }),
    )
    .toBe(duplicateId);
  await page.reload();
  await importFlight(page);
  await expect(page.getByLabel('Follow pose', { exact: true }).locator('[data-binding-id]')).toHaveAttribute(
    'data-binding-id',
    duplicateId!,
  );
  await expect(page.getByRole('button', { name: 'Follow', exact: true })).toHaveAttribute('aria-pressed', 'true');

  expect(errors).toEqual([]);
});

test('follow retains the last valid camera position at missing pose samples', async ({ page }) => {
  const errors = watchErrors(page);

  await observeTrajectoryCamera(page);
  await page.goto('/');
  await page
    .getByTestId('trace-input')
    .setInputFiles(uploadFile('gaps.csv', flightCsv.replace('1,1,0,1', '1,nan,0,1')));
  await expect(page.locator('.run-title')).toBeVisible();
  await expect(page.locator('.binding[aria-busy=true]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Follow', exact: true }).click();

  const initial = await trajectoryCamera(page);

  await seekTime(page, 1);
  await expectCameraPosition(page, initial.position);
  await page.getByRole('slider', { name: 'Timeline' }).press('End');
  await page.mouse.move(10, 10);
  await expectCameraPosition(
    page,
    initial.position.map((value, axis) => value + (axis === 0 ? 2 : 0)),
  );

  expect(errors).toEqual([]);
});
