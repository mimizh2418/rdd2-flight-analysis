import { importCsv } from '../data/importCsv';
import { decodeArrow } from '../data/arrow';
import { normalizeRun, validateManifest } from '../data/normalize';
import type { Manifest, Run } from '../data/types';

const ctx = self as unknown as {
  onmessage: (e: MessageEvent) => void;
  postMessage: (m: unknown, t?: Transferable[]) => void;
};

/**
 * Verify, parse, and normalize a local trace away from the UI thread, then transfer its numeric buffers.
 *
 * @param e Worker request containing an Arrow or CSV File and optional CSV metadata.
 * @returns Promise resolving after a terminal message is posted; failures are converted into {type: 'error', message}
 *   messages.
 * @remarks Posts {type: 'progress', fraction, stage} while importing, then {type: 'complete', run}. A supplied CSV
 *   hash is verified before parsing. Successful ArrayBuffer transfer detaches the worker's numeric arrays.
 */
ctx.onmessage = async (e: MessageEvent<{ file: File; manifest?: Manifest }>) => {
  const start = performance.now();

  try {
    const { file } = e.data;
    let manifest = e.data.manifest ? validateManifest(e.data.manifest) : undefined;

    const arrow = /\.arrow$/i.test(file.name);
    let columns;
    let hash: string;

    if (arrow) {
      ctx.postMessage({ type: 'progress', fraction: 0.05, stage: 'Reading Arrow' });
      const bytes = await file.arrayBuffer();
      ctx.postMessage({ type: 'progress', fraction: 0.2, stage: 'Fingerprinting Arrow' });
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      ctx.postMessage({ type: 'progress', fraction: 0.4, stage: 'Decoding Arrow columns' });
      ({ columns, manifest } = decodeArrow(new Uint8Array(bytes)));
    } else {
      ({ columns, hash } = await importCsv(file, manifest?.csv_sha256, (fraction, stage) =>
        ctx.postMessage({ type: 'progress', fraction, stage }),
      ));
    }

    ctx.postMessage({ type: 'progress', fraction: 0.7, stage: 'Building signals, event index, and path metrics' });

    const run: Run = normalizeRun(columns, file.name, manifest, file.size);

    run.fileHash = hash;
    run.format = arrow ? 'arrow' : 'csv';
    if (!arrow) run.csvHash = hash;
    run.importMs = performance.now() - start;

    // Aliases share their source arrays. Deduplicate buffers before transferring ownership to the main thread.
    const buffers = new Set<ArrayBuffer>();

    buffers.add(run.time.buffer as ArrayBuffer);
    buffers.add(run.index.buffer as ArrayBuffer);

    for (const s of Object.values(run.signals)) {
      buffers.add(s.values.buffer as ArrayBuffer);
    }

    ctx.postMessage({ type: 'complete', run }, [...buffers]);
  } catch (error) {
    ctx.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
