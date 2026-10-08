import { compile } from './test.mjs';
import { readFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// Use the same parser and normalizer as the viewer, separating their timings from source transpilation.
compile();
const { parseBuffer } = await import('../.test-build/src/data/csv.js');
const { decodeArrow } = await import('../.test-build/src/data/arrow.js');
const { normalizeRun } = await import('../.test-build/src/data/normalize.js');
const { summarize } = await import('../.test-build/src/math/statistics.js');
const path = process.argv[2];
if (!path) {
  throw new Error('Usage: npm run benchmark -- /path/to/trace.arrow (or trace.csv)');
}
const before = performance.now();
const bytes = readFileSync(path);
const { columns, manifest } = /\.arrow$/i.test(path)
  ? decodeArrow(bytes)
  : {
      columns: parseBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      manifest: undefined,
    };
const parsed = performance.now();
const run = normalizeRun(columns, path, manifest, statSync(path).size);
const done = performance.now();
const summary = summarize(run, 'tracking.norm', run.time[0], run.time.at(-1));
// Memory is a process snapshot after import, rather than an assertion about peak browser memory.
console.log(
  JSON.stringify(
    {
      file: path,
      bytes: run.bytes,
      rawRows: run.time.length,
      playbackRows: run.index.length,
      signals: Object.keys(run.signals).length,
      parseSeconds: (parsed - before) / 1000,
      normalizeSeconds: (done - parsed) / 1000,
      processMemory: process.memoryUsage(),
      tracking: summary,
      warnings: run.warnings,
    },
    null,
    2,
  ),
);
