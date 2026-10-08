/** Three components in the containing signal's frame; ENU vectors are [East, North, Up]. */
export type Vec3 = [number, number, number];

/** Hamilton quaternion in Three.js order: x,y,z,w. */
export type Quat = [number, number, number, number];

/** Linear interpolation, left-held values, or markers available only at their timestamp. */
export type Kind = 'continuous' | 'held' | 'event';

/** A scalar channel whose values are aligned with Run.time, including all retained raw event rows. */
export interface Signal {
  id: string;
  label: string;
  unit: string;
  frame: string;
  kind: Kind;

  /** Raw-row values. Shared by source aliases; treat as immutable after normalization. */
  values: Float64Array;

  /** Original source headers or canonical dependencies used to produce this channel. */
  source: string[];

  /** Human-readable calculation shown in the signal inspector. */
  derived?: string;

  /** Signal ID that must sample above 0.5 before this channel is usable. */
  validity?: string;
}

/** Optional bundle metadata; source quaternion order is distinct from the viewer's internal Quat order. */
export interface Manifest {
  schema: 'rdd2-viewer-v1';
  name?: string;
  csv?: string;
  csv_sha256?: string;
  model?: string;
  scenario?: string;
  compiler?: Record<string, unknown>;
  termination?: unknown;
  coverage_status?: string;
  scenario_path?: string;
  model_revision?: string;
  source_sha256?: string;
  world_frame?: 'ENU';
  body_frame?: 'FLU';
  quaternion_order?: 'wxyz';
  solver?: Record<string, unknown>;
  observed?: Record<string, unknown>;
  signals?: Record<string, { label?: string; unit?: string; frame?: string; kind?: Kind; validity?: string }>;
  mission?: {
    waypoints?: Vec3[];
    trajectory?: Vec3[];
    rotor_positions?: Vec3[];
    origin?: Record<string, number>;
    ground?: { normal: Vec3; offset: number };
  };
  [key: string]: unknown;
}

/** Imported simulation and its full-resolution channel registry, playback index, and import diagnostics. */
export interface Run {
  id: string;
  name: string;
  profile: string;

  /** SHA-256 of the imported CSV for workspace reattachment, independent of simulation provenance. */
  csvHash?: string;
  /** SHA-256 of the imported file, independent of format and simulation provenance. */
  fileHash?: string;
  /** Source encoding; absent for legacy in-memory fixtures. */
  format?: 'arrow' | 'csv';

  /** Original simulation seconds for every raw source row, including near-coincident event rows. */
  time: Float64Array;

  /** Raw-row indices of the final sample in each event group; this is not a separate time array. */
  index: Uint32Array;

  /** Raw source channels, canonical aliases, and calculated diagnostics keyed by signal ID. */
  signals: Record<string, Signal>;

  /** Original source IDs used for full-resolution log export. */
  raw: string[];
  warnings: string[];
  manifest?: Manifest;
  capabilities: string[];

  /** Maximum segment duration in seconds across which interpolation or integration is permitted. */
  gapLimit: number;

  /** Original trace size in bytes, or zero when not supplied. */
  bytes: number;

  /** Worker import duration in milliseconds. */
  importMs: number;

  /** Count of raw rows omitted from the final-row playback index. */
  eventGroups: number;
  pathApproximation?: string;
}

/** Numeric source columns keyed by original field name; all arrays have the same raw-row length. */
export type Columns = Record<string, Float64Array>;

/** Interval statistics; unavailable numerical metrics use NaN rather than fabricated zero values. */
export interface Summary {
  /** Time-weighted root mean square in the signal's units. */
  rmse: number;

  /** Time-weighted mean in the signal's units; vector-norm means use Simpson integration. */
  mean: number;

  /** Largest valid value, including raw event values and clipped interval endpoints. */
  max: number;

  /** Original simulation time in seconds at the reported maximum. */
  maxTime: number;

  /** Approximate duration-weighted 95th percentile using interval midpoints. */
  p95: number;

  /** Usable duration divided by the requested interval duration; ranges from zero to one. */
  coverage: number;

  /** Total duration in seconds actually included in integration. */
  duration: number;
}
