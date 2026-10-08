import type { Columns, Manifest, Run } from './types';

/**
 * Download a local artifact and release its temporary object URL.
 * @param name Suggested filename.
 * @param blob Encoded artifact contents.
 * @returns Nothing; starts the browser download.
 */
export function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Quote a CSV header using RFC-style doubled quotes when a delimiter or newline is present.
 *
 * @param value Original CSV header text.
 * @returns Escaped header, quoted only when delimiters or newlines require it.
 */
function quote(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Export original rows, including event duplicates, without interpolation or display decimation.
 * @param run Source simulation.
 * @param ids Selected scalar source IDs.
 * @param interval Inclusive interval in original simulation seconds, independent of chart zoom.
 * @returns Promise resolving once a streamed save or fallback Blob download completes.
 * @throws DOMException on cancelled save dialog; other errors propagate to the UI.
 */
export async function exportCsv(run: Run, ids: string[], interval: [number, number]): Promise<void> {
  const api = window as Window & {
    showSaveFilePicker?: (options: unknown) => Promise<{
      createWritable: () => Promise<{
        write: (data: Uint8Array) => Promise<void>;
        close: () => Promise<void>;
        abort?: () => Promise<void>;
      }>;
    }>;
  };
  const encoder = new TextEncoder();
  const writer = api.showSaveFilePicker
    ? await (
        await api.showSaveFilePicker({
          suggestedName: 'rdd2-selection.csv',
          types: [{ description: 'CSV trace', accept: { 'text/csv': ['.csv'] } }],
        })
      ).createWritable()
    : null;
  const parts: BlobPart[] = [];

  /**
   * Flush bounded CSV text to disk or retain a bounded Blob part in the fallback path.
   *
   * @param text Bounded serialized CSV text to flush.
   * @returns Promise after writing bytes to the native stream or retaining a fallback Blob part.
   */
  const write = async (text: string) => {
    if (writer) await writer.write(encoder.encode(text));
    else parts.push(text);
  };

  try {
    await write(['time_s', ...ids].map(quote).join(',') + '\n');
    let chunk = '';

    for (let row = 0; row < run.time.length; row++) {
      const time = run.time[row];

      if (time >= interval[0] && time <= interval[1]) {
        chunk += [String(time), ...ids.map((id) => String(run.signals[id].values[row]))].join(',') + '\n';
      }
      // Yield even when rows fall outside the interval; scanning a large export stays interruptible.
      if ((row & 255) === 255) {
        if (chunk) await write(chunk);
        chunk = '';
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
    if (chunk) await write(chunk);
    if (writer) await writer.close();
    else download('rdd2-selection.csv', new Blob(parts, { type: 'text/csv' }));
  } catch (error) {
    await writer?.abort?.();
    throw error;
  }
}

/**
 * Export a self-contained Arrow selection with embedded provenance and signal annotations.
 * @param run Source simulation, retained intact throughout export.
 * @param ids Channels to include, in output order.
 * @param interval Inclusive original simulation seconds; duplicate event rows are preserved.
 * @returns Resolves after the worker finishes and the file download begins; errors reject for UI reporting.
 */
export async function exportArrow(run: Run, ids: string[], interval: [number, number]): Promise<void> {
  const columns: Columns = { time_s: run.time.slice() };
  const signals: NonNullable<Manifest['signals']> = {};

  // Snapshot each source once, yielding between columns; transfer these copies without detaching live telemetry.
  for (const id of ids) {
    const signal = run.signals[id];
    columns[id] = signal.values.slice();
    signals[id] = {
      label: signal.label,
      unit: signal.unit,
      frame: signal.frame,
      kind: signal.kind,
      ...(signal.validity && ids.includes(signal.validity) ? { validity: signal.validity } : {}),
    };
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const manifest: Manifest = {
    ...run.manifest,
    schema: 'rdd2-viewer-v1',
    name: run.name,
    signals,
    selection: { interval, source_file_sha256: run.fileHash ?? run.csvHash },
  };

  const bytes = await new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    const worker = new Worker(new URL('../workers/export.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event) => {
      worker.terminate();
      if (event.data.error) reject(new Error(event.data.error));
      else resolve(event.data.bytes);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message));
    };
    worker.postMessage(
      { columns, manifest, interval },
      Object.values(columns).map((values) => values.buffer),
    );
  });
  download('rdd2-selection.arrow', new Blob([bytes], { type: 'application/vnd.apache.arrow.file' }));
}
