import { parseBuffer } from './csv';
import type { Columns } from './types';

/**
 * Read a CSV once, verify its fingerprint, then reuse those bytes for worker-side parsing.
 *
 * @param file Local CSV Blob or File.
 * @param expectedHash Optional manifest SHA-256; mismatches are rejected before parsing or publication.
 * @param progress Optional callback receiving import fraction and the current read/hash/parse stage.
 * @returns Numeric source columns and the verified content fingerprint, including for plain CSV imports.
 * @throws Error for a hash mismatch, malformed CSV, invalid values, or a failed file read/hash operation.
 * @remarks Call in a worker. Raw bytes are released after parsing, before the caller builds derived telemetry.
 */
export async function importCsv(
  file: Blob,
  expectedHash?: string,
  progress?: (fraction: number, stage: string) => void,
): Promise<{ columns: Columns; hash: string }> {
  progress?.(0, 'Reading CSV');
  let bytes: ArrayBuffer | null = await file.arrayBuffer();

  progress?.(0.05, 'Fingerprinting CSV');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');

  if (expectedHash && hash !== expectedHash) throw new Error('CSV SHA-256 does not match its manifest');

  // Hashing already needs the source buffer. Parse views of it instead of rereading the file in Blob slices.
  const columns = parseBuffer(bytes, (fraction) => progress?.(0.1 + fraction * 0.55, 'Parsing CSV'));
  bytes = null;

  return { columns, hash };
}
