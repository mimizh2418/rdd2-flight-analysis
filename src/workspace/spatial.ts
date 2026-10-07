import type { Binding, Field, SpatialDisplay, ViewTab } from './types';
import { findField } from './fieldCatalog';

/**
 * Find visible trajectory bindings with a sampled position that the camera can follow.
 * @param tab Active view and its independent field bindings.
 * @param fields Loaded source descriptors used to distinguish positions from static mission geometry.
 * @returns Pose/position bindings in dock order, including path-only fields with a moving position anchor.
 * @remarks Hidden and unattached sources are excluded; sample coverage is checked by the renderer each frame.
 */
export function followablePoses(tab: ViewTab, fields: Field[]): Binding[] {
  if (tab.type !== 'trajectory') return [];

  return tab.bindings.filter((binding) => {
    const field = findField(fields, binding.runId, binding.fieldId);

    return binding.visible && ['pose', 'position'].includes(field?.type ?? '');
  });
}

/**
 * Resolve a spatial field's display selection, including workspaces saved with separate path/pose lanes.
 *
 * @param binding Field presentation settings; an explicit display choice always takes precedence.
 * @param field Attached catalog metadata, if its source has been imported.
 * @returns Trajectory, pose, or both; mission paths always render as trajectories.
 */
export function spatialDisplay(binding: Binding, field?: Field): SpatialDisplay {
  if (field?.type === 'plan') return 'trajectory';
  if (binding.display) return binding.display;
  if (binding.lane === 'paths') return 'trajectory';
  if (binding.lane === 'poses') return 'pose';
  return field?.type === 'pose' ? 'both' : field?.type === 'position' ? 'trajectory' : 'pose';
}

/**
 * Determine which layers a spatial binding can draw without changing its source or preparation cache.
 *
 * @param binding Current display settings, including legacy path/pose lane identities.
 * @param field Typed source descriptor.
 * @returns Independent trajectory and model flags. Vectors are rendered separately as arrows.
 * @remarks Position-only sources can show a ball or an unoriented model marker; missing attitude is not invented.
 */
export function spatialLayers(binding: Binding, field: Field): { trajectory: boolean; pose: boolean } {
  const display = spatialDisplay(binding, field);
  return {
    trajectory: ['position', 'pose', 'plan'].includes(field.type) && display !== 'pose',
    pose: ['position', 'pose', 'orientation'].includes(field.type) && display !== 'trajectory',
  };
}
