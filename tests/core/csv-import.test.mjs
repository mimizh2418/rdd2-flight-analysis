import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CsvReader, ColumnBuilder, parseText, parseBlob, parseBuffer } from '../../.test-build/src/data/csv.js';
import { importCsv } from '../../.test-build/src/data/importCsv.js';
import { validateManifest } from '../../.test-build/src/data/normalize.js';

test('quoted matrix names, escaped quotes, BOM, CRLF and every possible chunk boundary', () => {
  const csv = '\uFEFFtime_s,"matrix[1,2]","a""b"\r\n0,1e-3,true\r\n1,2,false\r\n';

  // Split at every character, including inside escaped quotes and the two-character CRLF separator.
  for (let split = 0; split < csv.length; split++) {
    const builder = new ColumnBuilder();
    const reader = new CsvReader(builder.row);

    reader.feed(csv.slice(0, split));
    reader.feed(csv.slice(split), true);

    const columns = builder.finish();

    assert.deepEqual([...columns['matrix[1,2]']], [0.001, 2]);
    assert.deepEqual([...columns['a"b']], [1, 0]);
  }
});

test('malformed CSV fails explicitly', () => {
  for (const text of ['time,x\n0', 'time,x\n0,nope', 'time,time\n0,1', 'time,"oops\n0,1', 'time,x\n0,"1"x']) {
    assert.throws(() => parseText(text));
  }
});

test('blank and non-finite numeric samples stay gaps', () => {
  const columns = parseText('time,x\n0,\n1,NaN\n2,Infinity');

  assert.ok([...columns.x].every((value) => !Number.isFinite(value)));
});

test('chunked Blob matches text parser', async () => {
  const csv = 'time,x\n0,1\n1,2';

  assert.deepEqual(await parseBlob(new Blob([csv])), parseText(csv));
});

test('manifest rejects mismatched coordinates', () => {
  assert.throws(() => validateManifest({ schema: 'rdd2-viewer-v1', world_frame: 'NED' }));
  assert.throws(() => validateManifest({ schema: 'other' }));
});

test('fast CSV rows preserve mixed quoting, multiline fields, bare CR, CRLF, blanks and final empty cells', () => {
  const csv = '\uFEFFtime_s,"matrix[1,2]",label\r\n0,1.25," a,b "\r1,"2",bare\n2,"3\r\n4","a""b"\r\n,,\r\n3,4,';
  const expected = [
    ['time_s', 'matrix[1,2]', 'label'],
    ['0', '1.25', ' a,b '],
    ['1', '2', 'bare'],
    ['2', '3\r\n4', 'a"b'],
    ['3', '4', ''],
  ];

  for (let split = 0; split <= csv.length; split++) {
    const rows = [];
    const reader = new CsvReader((row) => rows.push(row));

    reader.feed(csv.slice(0, split));
    reader.feed(csv.slice(split), true);

    assert.deepEqual(rows, expected, `CSV split at ${split}`);
  }

  const rows = [];
  const reader = new CsvReader((row) => rows.push(row));

  for (const character of csv) reader.feed(character);
  reader.feed('', true);

  assert.deepEqual(rows, expected);
});

test('quoted and unquoted numeric paths preserve the same Float64 bits and event rows', () => {
  const cells = [
    '0',
    '-0',
    '0.0012499999999999998',
    '0.00125',
    '1.7976931348623157e308',
    '5e-324',
    '-Infinity',
    'true',
    'false',
    '+NaN',
    '-NaN',
    '',
    '  2.5  ',
  ];
  const plain = parseText('time,value\n' + cells.map((cell, row) => `${row},${cell}`).join('\n'));
  const quoted = parseText('time,value\n' + cells.map((cell, row) => `${row},"${cell}"`).join('\n'));

  // Compare bytes so that signed zero and extreme IEEE-754 values cannot pass through rounding.
  assert.deepEqual(new Uint8Array(plain.value.buffer), new Uint8Array(quoted.value.buffer));
  assert.equal(plain.time.length, cells.length);
  assert.ok(Object.is(plain.value[1], -0));
});

test('fast and partial CSV rows reject malformed quotes at every chunk boundary', () => {
  for (const csv of ['time,x\n0,1"2\n', 'time,x\r0,"1"tail\r', 'time,x\n0,"1', 'time,x\n0,"1""']) {
    for (let split = 0; split <= csv.length; split++) {
      assert.throws(() => {
        const builder = new ColumnBuilder();
        const reader = new CsvReader(builder.row);

        reader.feed(csv.slice(0, split));
        reader.feed(csv.slice(split), true);
        builder.finish();
      }, /quote|closing/i);
    }
  }
});

test('cached column blocks preserve every value across allocation and compaction boundaries', () => {
  const rows = 9000;
  const csv = 'time,value\n' + Array.from({ length: rows }, (_, row) => `${row},${row / 3}`).join('\n');
  const result = parseText(csv);

  assert.deepEqual(
    result.time,
    Float64Array.from({ length: rows }, (_, row) => row),
  );
  assert.deepEqual(
    result.value,
    Float64Array.from({ length: rows }, (_, row) => row / 3),
  );
});

test('verified byte-buffer parsing handles UTF-8 and quoted headers across a one-megabyte boundary', () => {
  // Each character occupies three UTF-8 bytes; the header crosses the parser's decoding block boundary.
  const name = '界'.repeat(Math.floor((1024 * 1024) / 3)) + '[1,2]';
  const csv = `\uFEFFtime,"${name}"\r\n0,1\r\n1,2`;
  const progress = [];
  const bytes = new TextEncoder().encode(csv);
  const result = parseBuffer(bytes.buffer, (fraction) => progress.push(fraction));

  assert.deepEqual(Object.keys(result), ['time', name]);
  assert.deepEqual([...result[name]], [1, 2]);
  assert.ok(progress.length > 1);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every((fraction, index) => fraction > (progress[index - 1] ?? 0)));
});

test('CSV import reads once, verifies raw bytes before parsing, and keeps progress monotonic', async () => {
  /** Blob that records whole-file reads and rejects any attempt to reread via slices. */
  class ReadOnceBlob extends Blob {
    reads = 0;

    /**
     * Count the one source read used for both hashing and parsing.
     * @returns {Promise<ArrayBuffer>} Exact source bytes from the Blob implementation.
     */
    async arrayBuffer() {
      this.reads++;
      return super.arrayBuffer();
    }

    /**
     * Detect a redundant sliced file read in the optimized import path.
     * @returns {never} Always throws; importer must reuse the verified byte buffer instead.
     */
    slice() {
      throw new Error('CSV bytes must not be reread');
    }
  }

  const csv = '\uFEFFtime,"matrix[1,2]"\r\n0,1\r\n1,NaN\r\n';
  const blob = new ReadOnceBlob([csv]);
  const expectedHash = createHash('sha256').update(csv).digest('hex');
  const progress = [];
  const result = await importCsv(blob, expectedHash, (fraction, stage) => progress.push({ fraction, stage }));

  assert.equal(blob.reads, 1);
  assert.equal(result.hash, expectedHash);
  assert.deepEqual(result.columns, parseText(csv));
  assert.deepEqual(
    [...new Set(progress.map((item) => item.stage))],
    ['Reading CSV', 'Fingerprinting CSV', 'Parsing CSV'],
  );
  assert.ok(progress.every((item, index) => item.fraction >= (progress[index - 1]?.fraction ?? 0)));

  // The malformed CSV would fail parsing, but a hash mismatch must be reported first.
  await assert.rejects(importCsv(new ReadOnceBlob(['malformed']), '0'.repeat(64)), /SHA-256 does not match/);
  await assert.rejects(importCsv(new ReadOnceBlob(['time,x\n0,nope'])), /invalid numeric/);
});
