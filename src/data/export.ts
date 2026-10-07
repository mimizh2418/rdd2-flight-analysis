import type { Run } from './types';

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
