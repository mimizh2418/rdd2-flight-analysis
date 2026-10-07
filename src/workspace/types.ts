import type { Kind, Run, Vec3 } from '../data/types';

export type ViewType = 'trajectory' | 'graph' | 'vehicle';
export type FieldType =
  | 'scalar'
  /** A graph-only vector of diagnostics, not a physical position, velocity, or orientation. */
  | 'vector'
  | 'position'
  | 'velocity'
  | 'orientation'
  | 'pose'
  | 'motors'
  | 'rotors'
  | 'thrust'
  | 'plan';
/** Paths/poses remain accepted for saved workspaces; new trajectory fields share the spatial lane. */
export type Lane = 'spatial' | 'paths' | 'poses' | 'left' | 'right' | 'vehicle' | 'overlays';
export type SpatialDisplay = 'trajectory' | 'pose' | 'both';
export type ModelType = 'drone' | 'ghost' | 'ball';
export type LineStyle = 'solid' | 'dashed' | 'dotted';

/** A draggable catalog item references existing data; aggregate fields never duplicate source arrays. */
export interface Field {
  id: string;
  runId: string;
  label: string;
  group: string;
  type: FieldType;
  signals: string[];
  unit: string;
  frame: string;
  prefix?: string;
  orientation?: string;
  kind: Kind;
  search: string;
}

/** Presentation choices belong to one tab binding, even when its source is used in several views. */
export interface Binding {
  id: string;
  runId: string;
  fieldId: string;
  label: string;
  lane: Lane;
  /** Independent trajectory/pose selection for position-bearing fields in a trajectory tab. */
  display?: SpatialDisplay;
  color: string;
  style: LineStyle;
  /** Relative stroke weight: graph steps are 0.5 CSS pixels; trajectory steps are one CSS pixel. */
  width: number;
  model: ModelType;
  scale: number;
  visible: boolean;
  fullPath: boolean;
  markers: boolean;
  componentArrows: boolean;
  frame: 'ENU' | 'FLU';
  /** Pose binding that anchors a trajectory vector or attitude layer. */
  attachTo?: string;
  orientation?: { runId: string; fieldId: string };
}

export interface AxisSettings {
  auto: boolean;
  min: number;
  max: number;
  zero: boolean;
}

export interface ViewTab {
  id: string;
  name: string;
  type: ViewType;
  bindings: Binding[];
  camera: 'orbit' | 'top' | 'side' | 'follow';
  /** Trajectory binding whose sampled position centers the follow camera; independent for each tab. */
  followPose?: string;
  followOrientation: boolean;
  bodyAxes: boolean;
  worldAxes: boolean;
  angles: 'degrees' | 'radians';
  leftAxis: AxisSettings;
  rightAxis: AxisSettings;
}

/** Configuration persistence stores identities only; imported trace arrays stay in the shared run registry. */
export interface WorkspaceDocument {
  schema: 'rdd2-workspace-v1';
  runs: { id: string; name: string; fingerprint: string; rows: number; start: number; end: number }[];
  tabs: ViewTab[];
  active: string;
  time: number;
  window: [number, number];
  alignment: string;
  browserWidth: number;
  dockHeight: number;
}

export interface LoadingState {
  fraction: number;
  stage: string;
  error?: string;
  ready: boolean;
}

/** GPU-ready path coordinates and segment end times, computed in a worker and transferable to the UI. */
export interface PreparedPath {
  positions: Float32Array;
  /** Render-only compact geometry for the full-path view; timed trails retain positions and times. */
  fullPositions?: Float32Array;
  times: Float64Array;
  bounds: { min: Vec3; max: Vec3 };
}

export interface PreparedField {
  path?: PreparedPath;
}

export interface PlotSeries {
  bindingId: string;
  runId: string;
  signalId: string;
  label: string;
  lane: 'left' | 'right';
  color: string;
  style: LineStyle;
  width: number;
  markers: boolean;
  unit: string;
  kind: Kind;
  offset: number;
  factor: number;
}

export interface PreparedPlot {
  x: number[];
  y: (number | null)[][];
  ranges: { left: [number, number]; right: [number, number] };
}

/** Minimal run metadata used when allocating selected columns in the preparation worker. */
export type WorkerRun = Omit<Run, 'time' | 'index' | 'signals'> & { rows: number; groups: number };
