import test from 'node:test';
import assert from 'node:assert/strict';
import { preparePlot, paddedRange } from '../../.test-build/src/workspace/preparation.js';
import { buildGraphIndex, indexedPlot, rangeRows } from '../../.test-build/src/workspace/graphIndex.js';
import { assertClose, createRun, createPlotSeries } from './support.mjs';

test('graph axis fits every raw event spike and interpolated boundaries independently', async () => {
  const run = createRun({
    time_s: Float64Array.from([0, 1, 1, 2]),
    'position_m[1]': Float64Array.from([0, 100, 1, 2]),
    'position_m[2]': new Float64Array(4),
    'position_m[3]': new Float64Array(4),
    'velocity_m_s[1]': Float64Array.from([3, 3, 3, 3]),
  });
  const plot = await preparePlot(
    new Map([[run.id, run]]),
    [createPlotSeries(run, 'position.0'), createPlotSeries(run, 'velocity.0', 'right')],
    [0.5, 1.5],
    100,
    () => {},
    () => false,
  );

  // Axis fitting must include both raw rows at the event, even when the rendered path is decimated.
  assert.ok(plot.ranges.left[1] > 100);
  assert.ok(plot.ranges.left[0] < 1);
  assert.ok(plot.ranges.right[0] < 3 && plot.ranges.right[1] > 3);

  const events = plot.x.flatMap((time, index) => (time === 1 ? [plot.y[0][index]] : []));

  assert.deepEqual(events, [100, 1]);
  assert.equal(plot.y[0][0], 50);
  assert.equal(plot.y[0].at(-1), 1.5);
});

test('graph gaps, validity masks and empty axes never invent a finite measurement', async () => {
  const run = createRun({ time_s: Float64Array.from([0, 1, 10]), 'position_m[1]': Float64Array.from([0, 1, 10]) });

  run.gapLimit = 2;

  const plot = await preparePlot(
    new Map([[run.id, run]]),
    [createPlotSeries(run, 'position.0')],
    [0, 10],
    100,
    () => {},
    () => false,
  );
  const midpoint = plot.x.indexOf(5.5);

  assert.ok(midpoint >= 0);
  assert.equal(plot.y[0][midpoint], null);
  assert.deepEqual(plot.ranges.right, [-1, 1]);

  const empty = await preparePlot(
    new Map([[run.id, run]]),
    [createPlotSeries(run, 'position.0')],
    [20, 30],
    100,
    () => {},
    () => false,
  );

  assert.deepEqual(empty.ranges.left, [-1, 1]);
  assert.ok(empty.y[0].every((value) => value === null));
  assert.deepEqual(paddedRange(0, 0), [-0.01, 0.01]);
});

test('graph display conversions and alignment affect coordinates without mutating source values', async () => {
  const run = createRun();
  const item = { ...createPlotSeries(run, 'position.0', 'left', 10), offset: 1 };
  const result = await preparePlot(
    new Map([[run.id, run]]),
    [item],
    [-0.5, 0.5],
    100,
    () => {},
    () => false,
  );

  assert.equal(result.x[0], -0.5);
  assert.equal(result.y[0][0], 5);
  assert.equal(result.y[0].at(-1), 15);
  assert.equal(run.signals['position.0'].values[2], 2);
});

test('cached graph navigation agrees with full-resolution event extrema, boundaries and conversions', async () => {
  const run = createRun({
    time_s: Float64Array.from([0, 1, 1, 2]),
    'position_m[1]': Float64Array.from([0, 100, 1, 2]),
    'position_m[2]': new Float64Array(4),
    'position_m[3]': new Float64Array(4),
  });
  const index = await buildGraphIndex(
    run,
    'position.0',
    () => {},
    () => false,
  );

  // Compare the cached navigation path with the full-resolution worker calculation at several window sizes.
  for (const window of [
    [0, 2],
    [0.5, 1.5],
    [1.2, 1.8],
    [5, 6],
    [0.25, 0.75],
  ]) {
    const series = [createPlotSeries(run, 'position.0')];
    const expected = await preparePlot(
      new Map([[run.id, run]]),
      series,
      window,
      100,
      () => {},
      () => false,
    );
    const actual = indexedPlot([run], series, [index], window, 100);

    assert.deepEqual(actual.ranges, expected.ranges);
    assert.equal(actual.y[0][0], expected.y[0][0]);
    assert.equal(actual.y[0].at(-1), expected.y[0].at(-1));
  }

  const events = indexedPlot([run], [createPlotSeries(run, 'position.0')], [index], [0.5, 1.5], 100);

  assert.deepEqual(
    events.x.flatMap((time, i) => (time === 1 ? [events.y[0][i]] : [])),
    [100, 1],
  );

  const converted = indexedPlot(
    [run],
    [{ ...createPlotSeries(run, 'position.0', 'right', -10), offset: 1 }],
    [index],
    [0.2, 0.8],
    100,
  );

  assertClose(converted.y[0][0], -12);
  assertClose(converted.y[0].at(-1), -18);
  assert.deepEqual(converted.ranges.left, [-1, 1]);
  assert.equal(run.signals['position.0'].values[1], 100);
});

test('cached graph indices preserve invalid intervals, long gaps, and held transitions', async () => {
  const run = createRun({
    time_s: Float64Array.from([0, 1, 2, 3, 10]),
    'position_m[1]': Float64Array.from([0, 1, NaN, 3, 10]),
    'position_m[2]': new Float64Array(5),
    'position_m[3]': new Float64Array(5),
  });

  run.gapLimit = 2;

  const index = await buildGraphIndex(
    run,
    'position.0',
    () => {},
    () => false,
  );
  const data = indexedPlot([run], [createPlotSeries(run, 'position.0')], [index], [0, 10], 100);

  assert.equal(data.y[0][data.x.indexOf(2)], null);
  assert.equal(data.y[0][data.x.indexOf(6.5)], null);

  const absent = indexedPlot([run], [createPlotSeries(run, 'position.0')], [index], [4, 8], 100);

  assert.deepEqual(absent.ranges.left, [-1, 1]);
  assert.ok(absent.y[0].every((value) => value === null));

  run.signals['position.0'].kind = 'held';

  const held = await buildGraphIndex(
    run,
    'position.0',
    () => {},
    () => false,
  );
  const step = indexedPlot([run], [createPlotSeries(run, 'position.0')], [held], [0.2, 0.8], 100);

  assert.deepEqual(step.y[0], [0, 0]);
  await assert.rejects(
    buildGraphIndex(
      run,
      'position.0',
      () => {},
      () => true,
    ),
    { name: 'AbortError' },
  );
});

test('pixel-budgeted cached queries retain narrow spikes at every zoom level', async () => {
  // One isolated spike in a hundred-thousand-row trace exercises the extrema index under heavy decimation.
  const length = 100001;
  const time = Float64Array.from({ length }, (_, row) => row / 1000);
  const values = new Float64Array(length);

  values[51357] = 1234;

  const run = createRun({
    time_s: time,
    'position_m[1]': values,
    'position_m[2]': new Float64Array(length),
    'position_m[3]': new Float64Array(length),
  });
  const index = await buildGraphIndex(
    run,
    'position.0',
    () => {},
    () => false,
  );

  for (const window of [
    [0, 100],
    [50, 52],
    [51.35, 51.36],
    [51.357, 51.3571],
  ]) {
    const result = indexedPlot([run], [createPlotSeries(run, 'position.0')], [index], window, 300);

    assert.ok(result.y[0].includes(1234));
    assert.ok(result.ranges.left[1] > 1234);
    assert.ok(result.x.length < 1500);
  }

  assert.equal(index.values[rangeRows(index, 0, length)[1]], 1234);

  const excluding = indexedPlot([run], [createPlotSeries(run, 'position.0')], [index], [60, 70], 300);

  assert.deepEqual(excluding.ranges.left, [-0.01, 0.01]);
});

test('cached graph extrema apply validity masks before plotting or fitting', async () => {
  const run = createRun({ 'position_m[1]': Float64Array.from([0, 999, 2]) });

  run.signals.mask = { ...run.signals['position.0'], id: 'mask', values: Float64Array.from([1, 0, 1]) };
  run.signals['position.0'].validity = 'mask';

  const index = await buildGraphIndex(
    run,
    'position.0',
    () => {},
    () => false,
  );
  const result = indexedPlot([run], [createPlotSeries(run, 'position.0')], [index], [0, 2], 100);

  assert.equal(result.y[0][result.x.indexOf(1)], null);
  assert.ok(result.ranges.left[1] < 3);
  assert.equal(run.signals['position.0'].values[1], 999);
});
