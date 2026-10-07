import { createHash } from 'node:crypto';
import type { Manifest } from '../../../src/data/types';

/**
 * Encode a named local CSV/JSON fixture as a Playwright upload.
 * @param name Filename used to pair imports and select MIME type.
 * @param text Serialized UTF-8 CSV or JSON fixture.
 * @returns Upload descriptor with a fresh Buffer and matching MIME type.
 */
export const uploadFile = (name: string, text: string): { name: string; mimeType: string; buffer: Buffer } => ({
  name,
  mimeType: name.endsWith('.json') ? 'application/json' : 'text/csv',
  buffer: Buffer.from(text),
});

/** Three samples with Eastward motion, constant altitude, and a final yaw change. */
export const poseCsv = 'time_s,x_m,y_m,z_m,roll_rad,pitch_rad,yaw_rad\n0,0,0,1,0,0,0\n1,1,0,1,0,0,0\n2,2,0,1,0,0,1\n';

/** Native velocity and a stationary reference make tracking errors analytically predictable. */
export const flightCsv = [
  'time_s,x_m,y_m,z_m,roll_rad,pitch_rad,yaw_rad,' +
    'velocity_m_s[1],velocity_m_s[2],velocity_m_s[3],' +
    'avionics.reference.position[1],avionics.reference.position[2],avionics.reference.position[3]',
  '0,0,0,1,0,0,0,1,0,0,0,0,1',
  '1,1,0,1,0,0,0,1,0,0,0,0,1',
  '2,2,0,1,0,0,1,1,0,0,0,0,1',
  '',
].join('\n');

/**
 * Build verifiable metadata and static mission geometry for the analytic fixture.
 * @param csv Exact serialized CSV used to calculate its content digest.
 * @returns Manifest containing the matching SHA-256 and ENU mission geometry.
 */
export const createManifest = (csv: string): Manifest => ({
  schema: 'rdd2-viewer-v1',
  name: 'Analytic flight',
  csv: 'flight.csv',
  csv_sha256: createHash('sha256').update(csv).digest('hex'),
  world_frame: 'ENU',
  body_frame: 'FLU',
  quaternion_order: 'wxyz',
  mission: {
    trajectory: [
      [0, 0, 1],
      [2, 0, 1],
    ],
    waypoints: [
      [0, 0, 1],
      [2, 0, 1],
    ],
  },
});
