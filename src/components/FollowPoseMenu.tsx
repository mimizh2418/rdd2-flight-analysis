import type { Run } from '../data/types';
import type { Binding, ViewTab } from '../workspace/types';
import { AppearanceIcon } from './BindingAppearance';
import { DropdownMenu } from './DropdownMenu';

/**
 * Select a follow target using the same model and color icons as the field dock.
 * @param props Active trajectory tab, visible position anchors, source names, and binding-selection callback.
 * @returns A compact selector showing the selected pose and an icon beside each available choice.
 * @remarks Hidden or unattached targets retain their identity and icon, with an unavailable label.
 */
export function FollowPoseMenu({
  tab,
  poses,
  runs,
  onSelect,
}: {
  tab: ViewTab;
  poses: Binding[];
  runs: Run[];
  onSelect: (bindingId: string) => void;
}) {
  const selected = tab.bindings.find((binding) => binding.id === tab.followPose);
  const available = poses.some((binding) => binding.id === tab.followPose);

  /**
   * Distinguish identically named poses when multiple logs are loaded.
   * @param binding Pose binding, including its user-visible name and source identity.
   * @returns Field name with a source suffix only when there are multiple logs.
   */
  const label = (binding: Binding) =>
    binding.label + (runs.length > 1 ? ` (${runs.find((run) => run.id === binding.runId)?.name ?? 'Unattached'})` : '');

  return (
    <DropdownMenu
      className="follow-pose-menu"
      label="Follow pose"
      contextKey={tab.id}
      closeOnSelect
      summary={
        <>
          {selected && <AppearanceIcon binding={selected} tab={tab} poseOnly />}
          <span className="follow-pose-label" data-binding-id={selected?.id}>
            {selected ? label(selected) : 'Selected pose'}
            {!available && ' (unavailable)'}
          </span>
          <svg className="menu-chevron" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
            <path d="M3 4.5 L6 7.5 L9 4.5" fill="none" stroke="currentColor" strokeWidth={1.5} />
          </svg>
        </>
      }
    >
      {poses.map((binding) => (
        <button
          key={binding.id}
          aria-pressed={binding.id === tab.followPose}
          onClick={(event) => {
            onSelect(binding.id);
            // Keep keyboard focus on the selector after its chosen item disappears with the closed menu.
            event.currentTarget.closest('details')?.querySelector('summary')?.focus();
          }}
        >
          <AppearanceIcon binding={binding} tab={tab} poseOnly />
          <span className="follow-pose-label">{label(binding)}</span>
        </button>
      ))}
      {!poses.length && <button disabled>No poses available</button>}
    </DropdownMenu>
  );
}
