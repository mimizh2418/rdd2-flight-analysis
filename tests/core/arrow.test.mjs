import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Float64, Schema, Field, Table, makeVector, vectorFromArray, tableToIPC } from 'apache-arrow';
import { decodeArrow, encodeArrow } from '../../.test-build/src/data/arrow.js';
import { normalizeRun } from '../../.test-build/src/data/normalize.js';

test('Python IPC batches preserve event rows, Float64 values, metadata and derived diagnostics', () => {
  const { columns, manifest } = decodeArrow(readFileSync('tests/fixtures/python-flight.arrow'));
  assert.deepEqual(Array.from(columns.time), [0, 1, 1, 1.0000000000000002, 2]);
  assert.equal(Object.is(columns.x_m[0], -0), true);
  assert.equal(Number.isNaN(columns.y_m[3]), true);
  assert.equal(manifest.name, 'Python Arrow flight');
  assert.deepEqual(manifest.mission.waypoints, [
    [0, 0, 1],
    [4, 0, 1],
  ]);

  const run = normalizeRun(columns, 'fixture', manifest);
  assert.equal(run.eventGroups, 2);
  assert.deepEqual(Array.from(run.signals['position.0'].values), Array.from(columns.x_m));
  assert.deepEqual(Array.from(run.index), [0, 3, 4]);

  const again = decodeArrow(encodeArrow(columns, manifest));
  assert.deepEqual(again.manifest, manifest);
  for (const name of Object.keys(columns)) assert.deepEqual(again.columns[name], columns[name]);
});

test('Arrow nulls become gaps, while generic Float64 files remain importable without metadata', () => {
  const table = new Table({
    time: makeVector(new Float64Array([0, 1, 2])),
    x: vectorFromArray([1, null, 3], new Float64()),
  });
  const { columns, manifest } = decodeArrow(tableToIPC(table, 'file'));
  assert.equal(manifest, undefined);
  assert.deepEqual(columns.x, new Float64Array([1, NaN, 3]));
});

test('Arrow rejects unsupported encodings, metadata versions and truncated files', () => {
  const numeric = makeVector(new Float64Array([0, 1]));
  const fields = [new Field('time', new Float64())];
  const future = new Table(new Schema(fields, new Map([['rdd2:format', 'rdd2-arrow-v99']])), { time: numeric });
  assert.throws(() => decodeArrow(tableToIPC(future, 'file')), /Unsupported Arrow format/);
  assert.throws(() => decodeArrow(tableToIPC(new Table({ time: numeric }), 'stream')), /IPC file/);
  assert.throws(() => decodeArrow(new Uint8Array([1, 2, 3])), /IPC file/);
  assert.throws(
    () => decodeArrow(tableToIPC(new Table({ time: numeric, text: vectorFromArray(['a', 'b']) }), 'file')),
    /must be Float64/,
  );
});
