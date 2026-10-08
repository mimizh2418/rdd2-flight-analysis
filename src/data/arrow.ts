import { DataType, Field, Float64, Precision, Schema, Table, makeVector, tableFromIPC, tableToIPC } from 'apache-arrow';
import { validateManifest } from './normalize';
import type { Columns, Manifest } from './types';

export const ARROW_FORMAT = 'rdd2-arrow-v1';
export const ARROW_MIME = 'application/vnd.apache.arrow.file';

/**
 * Decode uncompressed IPC files into the viewer's contiguous numeric columns.
 * @param bytes Complete IPC file bytes; source buffers may be shared by returned columns.
 * @returns Validated numeric columns and optional embedded run metadata.
 * @throws Error for unsupported schema versions, non-Float64 channels, or malformed metadata.
 * @remarks Nulls become NaN; event rows and original Float64 timestamps are never resampled or sorted.
 */
export function decodeArrow(bytes: Uint8Array): { columns: Columns; manifest?: Manifest } {
  if (
    new TextDecoder().decode(bytes.subarray(0, 6)) !== 'ARROW1' ||
    new TextDecoder().decode(bytes.subarray(-6)) !== 'ARROW1'
  ) {
    throw new Error('Expected an Arrow IPC file (.arrow), not a stream or truncated file');
  }

  const table = tableFromIPC(bytes);
  const version = table.schema.metadata.get('rdd2:format');
  const embedded = table.schema.metadata.get('rdd2:manifest');

  if (version && version !== ARROW_FORMAT) throw new Error(`Unsupported Arrow format: ${version}`);
  if (version && !embedded) throw new Error('RDD2 Arrow file is missing embedded metadata');

  const columns: Columns = Object.create(null);
  const signals: NonNullable<Manifest['signals']> = {};
  const names = new Set<string>();

  for (const field of table.schema.fields) {
    if (!field.name || names.has(field.name)) throw new Error('Missing or duplicate Arrow column names');
    names.add(field.name);

    if (!DataType.isFloat(field.type) || field.type.precision !== Precision.DOUBLE) {
      throw new Error(`Arrow column ${field.name} must be Float64`);
    }

    const vector = table.getChild(field.name)!;
    // toArray joins multiple record batches only when necessary. Nulls require a writable copy.
    const values = vector.toArray();
    const numeric = vector.nullCount ? values.slice() : values;

    if (vector.nullCount) {
      for (let row = 0; row < vector.length; row++) {
        if (!vector.isValid(row)) numeric[row] = NaN;
      }
    }
    columns[field.name] = numeric as Float64Array;

    const metadata = field.metadata.get('rdd2:signal');
    if (metadata) {
      const annotation = JSON.parse(metadata);

      // Empty field annotations carry no additional information. In particular, a time field must not
      // add a new empty signal entry to an otherwise unchanged embedded manifest on every round-trip.
      if (!annotation || typeof annotation !== 'object' || Object.keys(annotation).length) {
        signals[field.name] = annotation;
      }
    }
  }

  const manifest = embedded ? validateManifest(JSON.parse(embedded)) : undefined;
  if (manifest && (manifest.csv || manifest.csv_sha256)) {
    throw new Error('Arrow metadata must not identify a separate CSV payload');
  }
  if (manifest || Object.keys(signals).length) {
    return {
      columns,
      manifest: validateManifest({
        ...manifest,
        schema: 'rdd2-viewer-v1',
        signals: { ...signals, ...manifest?.signals },
      }),
    };
  }
  return { columns };
}

/**
 * Serialize Float64 columns and metadata as one uncompressed, self-contained IPC file.
 * @param columns Equal-length numeric channels, including time or time_s.
 * @param manifest Run provenance and signal annotations; no external payload checksum is embedded.
 * @returns File bytes suitable for .arrow downloads or cross-language readers.
 */
export function encodeArrow(columns: Columns, manifest: Manifest): Uint8Array {
  const clean = { ...manifest };
  delete clean.csv;
  delete clean.csv_sha256;
  validateManifest(clean);

  const fields = Object.keys(columns).map(
    (name) =>
      new Field(name, new Float64(), false, new Map([['rdd2:signal', JSON.stringify(clean.signals?.[name] ?? {})]])),
  );
  const schema = new Schema(
    fields,
    new Map([
      ['rdd2:format', ARROW_FORMAT],
      ['rdd2:manifest', JSON.stringify(clean)],
    ]),
  );
  const vectors = Object.fromEntries(Object.entries(columns).map(([name, values]) => [name, makeVector(values)]));

  return tableToIPC(new Table(schema, vectors), 'file');
}
