import { encodeArrow } from '../data/arrow';
import type { Columns, Manifest } from '../data/types';

/**
 * Filter original event rows and serialize an Arrow selection away from the UI thread.
 * @param event Numeric source snapshots, provenance, and inclusive simulation-time interval.
 * @returns Posts transferable IPC bytes or a recoverable export error.
 */
self.onmessage = (event: MessageEvent<{ columns: Columns; manifest: Manifest; interval: [number, number] }>) => {
  try {
    const { columns, manifest, interval } = event.data;
    const time = columns.time_s;
    const rows: number[] = [];

    for (let row = 0; row < time.length; row++) {
      if (time[row] >= interval[0] && time[row] <= interval[1]) rows.push(row);
    }
    if (!rows.length) throw new Error('No samples in the selected interval');

    const selected: Columns = Object.create(null);
    for (const [name, values] of Object.entries(columns)) {
      selected[name] = Float64Array.from(rows, (row) => values[row]);
    }
    manifest.observed = {
      rows: rows.length,
      start_time_s: time[rows[0]],
      end_time_s: time[rows[rows.length - 1]],
    };
    const bytes = encodeArrow(selected, manifest);
    self.postMessage({ bytes }, { transfer: [bytes.buffer as ArrayBuffer] });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
