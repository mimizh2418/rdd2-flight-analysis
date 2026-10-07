import type { Columns } from './types';

/** Incremental RFC4180-style reader. Handles quotes/CRLF across chunk boundaries. */
export class CsvReader {
  private field = '';
  private row: string[] = [];
  private quoted = false;
  private afterQuote = false;
  private cr = false;
  private started = false;

  /**
   * Create a streaming CSV parser that emits complete rows through the supplied callback.
   *
   * @param emit Synchronous callback receiving each nonblank parsed row. Ownership of the row array passes to the
   *   callback; callback errors propagate to feed.
   */
  constructor(private emit: (row: string[]) => void) {}

  /**
   * Consume a text chunk without losing quote or CRLF state across chunk boundaries.
   *
   * @param text Decoded CSV text in source order; chunks may split fields, escaped quotes, or CRLF pairs.
   * @param final Flush the last row and reject an unfinished quoted field; defaults to false.
   * @returns Nothing; synchronously emits complete nonblank rows through the constructor callback.
   * @throws Error for malformed quote usage, or any error raised by the row callback.
   * @remarks Strips a BOM only at the beginning of the stream. Call with final=true once all text has arrived.
   */
  feed(text: string, final = false) {
    const lineBreak = /[\r\n]/g;
    let cursor = 0;

    while (cursor < text.length) {
      // CRLF can straddle chunks. Consume its LF before attempting the complete-row fast path.
      if (this.cr) {
        this.cr = false;
        if (text[cursor] === '\n') {
          cursor++;
          continue;
        }
      }

      if (this.started && !this.quoted && !this.afterQuote && !this.field && !this.row.length) {
        lineBreak.lastIndex = cursor;
        const ending = lineBreak.exec(text);
        const end = ending?.index ?? text.length;
        const line = text.slice(cursor, end);

        // Simulation rows are usually unquoted numbers. Native splitting avoids constructing each cell one
        // character at a time. Quotes and partial rows still use the original streaming state machine below.
        if ((ending || final) && !line.includes('"')) {
          const row = line.split(',');
          if (row.some((cell) => cell.trim() !== '')) this.emit(row);

          this.cr = ending?.[0] === '\r';
          cursor = ending ? end + 1 : end;
          continue;
        }
      }

      const c = text[cursor++];
      if (!this.started) {
        this.started = true;

        if (c === '\uFEFF') {
          continue;
        }
      }

      // Inside quotes, delimiters are literal data; a quote starts the separate closing/escaped-quote state.
      if (this.quoted) {
        if (c === '"') {
          this.quoted = false;
          this.afterQuote = true;
        } else {
          this.field += c;
        }

        continue;
      }

      if (this.afterQuote && c === '"') {
        // Two consecutive quotes inside a quoted field represent one literal quote.
        this.field += '"';
        this.quoted = true;
        this.afterQuote = false;
        continue;
      }

      if (c === ',') {
        this.row.push(this.field);
        this.field = '';
        this.afterQuote = false;
        continue;
      }

      if (c === '\r' || c === '\n') {
        this.endRow();
        this.cr = c === '\r';
        continue;
      }

      if (c === '"' && !this.field && !this.afterQuote) {
        this.quoted = true;
        continue;
      }

      if (this.afterQuote) {
        if (c === ' ' || c === '\t') {
          continue;
        }

        throw new Error('Unexpected character after closing CSV quote');
      }

      if (c === '"') {
        throw new Error('Unexpected quote in unquoted CSV field');
      }

      this.field += c;
    }

    // At end of stream, flush a row without a trailing newline but refuse an incomplete quoted field.
    if (final) {
      if (this.quoted) {
        throw new Error('Unterminated CSV quote');
      }

      if (this.field || this.row.length || this.afterQuote) {
        this.endRow();
      }
    }
  }

  /**
   * Emit a nonblank row and reset row-local parser state.
   *
   * @returns Nothing; appends the current field, calls the enclosing emit callback if any cell is nonblank, and
   *   replaces the row buffer.
   * @remarks Stream-level quote, BOM, and CRLF state is managed by feed, not reset here.
   */
  private endRow() {
    this.row.push(this.field);

    if (this.row.some((x) => x.trim() !== '')) {
      this.emit(this.row);
    }

    this.row = [];
    this.field = '';
    this.afterQuote = false;
  }
}

export class ColumnBuilder {
  headers: string[] = [];
  private blocks: Float64Array[][] = [];
  private currentBlocks: Float64Array[] = [];
  count = 0;
  private blockSize = 4096;
  nonFinite = 0;

  /**
   * Validate a parsed row and append its numeric cells to fixed-size column blocks.
   *
   * @param row Parsed CSV fields. The first row defines trimmed unique nonempty headers; subsequent rows must match
   *   their width.
   * @returns Nothing; mutates this builder's blocks, count, and nonFinite counter.
   * @throws Error for duplicate/empty headers, inconsistent row width, or an unsupported numeric spelling.
   * @remarks Booleans map to 1/0; blank cells and signed NaN spellings stay NaN. Infinity remains a non-finite sample.
   */
  row = (row: string[]) => {
    if (!this.headers.length) {
      this.headers = row.map((s) => s.trim());

      if (this.headers.some((s) => !s) || new Set(this.headers).size !== this.headers.length) {
        throw new Error('Empty or duplicate CSV column name');
      }

      this.blocks = this.headers.map(() => []);

      return;
    }

    if (row.length !== this.headers.length) {
      throw new Error(`Row ${this.count + 2}: expected ${this.headers.length} fields, received ${row.length}`);
    }

    // Grow columns in fixed-size blocks to avoid a full array copy for every appended sample.
    const offset = this.count % this.blockSize;

    if (!offset) {
      this.currentBlocks = this.blocks.map((blocks) => {
        const block = new Float64Array(this.blockSize);
        blocks.push(block);
        return block;
      });
    }

    // Cache the destination blocks once per 4096 rows, instead of resolving/allocating them for every cell.
    for (let c = 0; c < row.length; c++) {
      const v = row[c].trim();

      // Decode the supported numeric/boolean spellings. Empty cells deliberately remain gaps, not zeros.
      const n = v === 'true' ? 1 : v === 'false' ? 0 : v === '' ? NaN : Number(v);

      if (Number.isNaN(n) && v !== '' && !/^[-+]?nan$/i.test(v)) {
        throw new Error(`Row ${this.count + 2}: invalid numeric value in ${this.headers[c]}`);
      }

      if (!Number.isFinite(n)) {
        this.nonFinite++;
      }

      this.currentBlocks[c][offset] = n;
    }

    this.count++;
  };

  /**
   * Compact accumulated blocks into Float64 columns and release the temporary block storage.
   *
   * @returns Header-to-column registry with one Float64Array per source channel, including NaN gaps.
   * @throws Error if no data rows were appended.
   * @remarks Consumes temporary storage. Call once after the last row; the builder is not intended for reuse after
   *   finishing.
   */
  finish(): Columns {
    if (!this.count) {
      throw new Error('CSV contains no data rows');
    }

    const result: Columns = {};

    // Allocate exactly one final array per header and copy only the populated portion of each block.
    this.headers.forEach((h, c) => {
      const out = new Float64Array(this.count);

      for (let b = 0; b < this.blocks[c].length; b++) {
        out.set(
          this.blocks[c][b].subarray(0, Math.min(this.blockSize, this.count - b * this.blockSize)),
          b * this.blockSize,
        );
      }

      result[h] = out;
    });
    this.blocks = [];
    this.currentBlocks = [];

    return result;
  }
}

/**
 * Decode already-read CSV bytes in one-megabyte text chunks without another file read or a full-file string.
 *
 * @param buffer UTF-8 source bytes, normally the same buffer used to verify the content hash.
 * @param progress Optional callback receiving the decoded byte fraction in [0, 1].
 * @returns Original-precision Float64 columns; the input buffer is neither mutated nor retained by the result.
 * @throws Error for malformed CSV, invalid numeric cells, duplicate headers, or no data rows.
 * @remarks Synchronous CPU work: call in an import worker. UTF-8, quotes, and CRLF may span chunk boundaries.
 */
export function parseBuffer(buffer: ArrayBuffer, progress?: (fraction: number) => void): Columns {
  const builder = new ColumnBuilder();
  const reader = new CsvReader(builder.row);
  const decoder = new TextDecoder();
  const size = 1024 * 1024;

  for (let offset = 0; offset < buffer.byteLength; offset += size) {
    const length = Math.min(size, buffer.byteLength - offset);
    const chunk = new Uint8Array(buffer, offset, length);
    reader.feed(decoder.decode(chunk, { stream: true }));
    progress?.((offset + length) / buffer.byteLength);
  }

  reader.feed(decoder.decode(), true);

  return builder.finish();
}

/**
 * Parse a local file in one-megabyte slices and report progress without retaining its full text.
 *
 * @param file UTF-8 CSV Blob, including browser File objects.
 * @param progress Optional synchronous callback receiving approximate read fraction in [0, 1] after each slice.
 * @returns Promise of numeric columns indexed by trimmed source headers.
 * @throws Error via rejection for malformed CSV, invalid numeric cells, missing data, read failures, or callback
 *   failures.
 * @remarks Retains numeric columns but not the full decoded text; handles multibyte UTF-8 and quoted fields across
 *   slice boundaries.
 */
export async function parseBlob(file: Blob, progress?: (fraction: number) => void): Promise<Columns> {
  const builder = new ColumnBuilder();
  const reader = new CsvReader(builder.row);
  const decoder = new TextDecoder();
  const size = 1024 * 1024;

  for (let offset = 0; offset < file.size; offset += size) {
    reader.feed(decoder.decode(await file.slice(offset, offset + size).arrayBuffer(), { stream: true }));
    progress?.(Math.min(1, (offset + size) / file.size));
  }

  reader.feed(decoder.decode(), true);

  return builder.finish();
}

/**
 * Parse a complete CSV string using the same reader and validation rules as file imports.
 *
 * @param text Complete decoded CSV, optionally beginning with a UTF-8 BOM character.
 * @returns Numeric columns indexed by trimmed source headers; blank/non-finite samples remain gaps.
 * @throws Error for malformed CSV, invalid numeric cells, duplicate headers, or no data rows.
 */
export function parseText(text: string): Columns {
  const b = new ColumnBuilder();
  const r = new CsvReader(b.row);

  r.feed(text, true);

  return b.finish();
}
