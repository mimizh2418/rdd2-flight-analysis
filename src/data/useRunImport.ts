import { useEffect, useRef, useState } from 'react';
import type { Manifest, Run } from './types';
import { validateManifest } from './normalize';

export interface ImportStatus {
  /** Stable batch identity, independent of progress updates and selected filenames. */
  id: number;
  phase: 'loading' | 'complete';
  fraction: number;
  stage: string;
}

/**
 * Import local CSV/manifest batches in workers, publishing only fully successful batches.
 * @param onComplete Receives new runs after all selected files have passed parsing and hash verification.
 * @param onError Reports recoverable errors without replacing existing data.
 * @returns File loader, cancellation action, and current batch progress.
 */
export function useRunImport(onComplete: (runs: Run[]) => void, onError: (error: string) => void) {
  const [status, setStatus] = useState<ImportStatus | null>(null);
  const token = useRef(0);
  const callbacks = useRef({ onComplete, onError });
  callbacks.current = { onComplete, onError };
  const cancelCurrent = useRef<(() => void) | null>(null);

  /**
   * Cancel a pending batch; existing source runs remain intact.
   *
   * @returns Nothing; invalidates the batch, terminates its worker, and clears progress without removing loaded runs.
   */
  const cancel = () => {
    token.current++;
    cancelCurrent.current?.();
    cancelCurrent.current = null;
    setStatus(null);
  };

  useEffect(
    () => () => {
      token.current++;
      cancelCurrent.current?.();
    },
    [],
  );

  /**
   * Parse selected files in order and pair manifests by their declared CSV filename.
   * @param files CSVs and optional manifests from the file picker, drop, or simulation service.
   * @returns Promise resolving after success, cancellation, or a reported recoverable failure.
   */
  const load = async (files: File[]) => {
    cancel();
    const batch = token.current;
    try {
      const csvs = files.filter((file) => /\.csv$/i.test(file.name));

      if (!csvs.length) throw new Error('Select a CSV, optionally together with its manifest.json.');

      // Start one stable notification before any asynchronous reads; quick batches need not display it.
      setStatus({ id: batch, phase: 'loading', fraction: 0, stage: `${csvs[0].name}: Preparing import` });

      const manifests: Manifest[] = [];

      for (const file of files.filter((file) => /\.json$/i.test(file.name))) {
        manifests.push(validateManifest(JSON.parse(await file.text())));
      }

      const imported: Run[] = [];

      for (const file of csvs) {
        if (batch !== token.current) return;

        const manifest =
          manifests.find((item) => item.csv === file.name) ??
          (csvs.length === 1 && manifests.length === 1 ? manifests[0] : undefined);

        if (manifests.length && !manifest) throw new Error(`No matching manifest for ${file.name}.`);

        const run = await new Promise<Run>((resolve, reject) => {
          const worker = new Worker(new URL('../workers/import.worker.ts', import.meta.url), { type: 'module' });
          /**
           * Release the worker and its cancellation callback on every terminal path.
           *
           * @returns Nothing; terminates the import worker and releases its cancellation callback.
           */
          const finish = () => {
            worker.terminate();
            cancelCurrent.current = null;
          };
          cancelCurrent.current = () => {
            finish();
            reject(new DOMException('Import cancelled', 'AbortError'));
          };
          worker.onmessage = (event) => {
            if (batch !== token.current) return;

            const message = event.data;

            if (message.type === 'progress')
              setStatus({
                id: batch,
                phase: 'loading',
                fraction: message.fraction,
                stage: `${file.name}: ${message.stage}`,
              });
            if (message.type === 'complete') {
              finish();
              resolve(message.run);
            }
            if (message.type === 'error') {
              finish();
              reject(new Error(message.message));
            }
          };
          worker.onerror = (event) => {
            finish();
            reject(new Error(event.message));
          };
          worker.postMessage({ file, manifest });
        });
        imported.push(run);
      }
      if (batch === token.current) {
        setStatus({
          id: batch,
          phase: 'complete',
          fraction: 1,
          stage: csvs.map((file) => file.name).join(', '),
        });
        // Source removals and tab edits made during the import must survive its eventual publication.
        callbacks.current.onComplete(imported);
      }
    } catch (error) {
      if (batch === token.current && !(error instanceof DOMException && error.name === 'AbortError')) {
        setStatus(null);
        callbacks.current.onError(error instanceof Error ? error.message : String(error));
      }
    }
  };

  return { status, load, cancel };
}
