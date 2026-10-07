import { usePlayback } from '../playback/PlaybackProvider';
import type { ViewTab } from '../workspace/types';
import { DropdownMenu } from './DropdownMenu';

/**
 * Keep shared playback options and active-view settings in a compact, keyboard-accessible popup.
 *
 * @param props Active tab, its settings callback, and the independent graph interval-selection mode.
 * @returns Settings menu that closes on outside clicks, Escape, and active-tab changes.
 * @remarks Playback settings affect every tab; angle units affect only the active tab.
 */
export function ViewSettingsMenu({
  tab,
  onTabPatch,
  intervalMode,
  onIntervalMode,
}: {
  tab?: ViewTab;
  onTabPatch: (patch: Partial<ViewTab>) => void;
  intervalMode: boolean;
  onIntervalMode: (enabled: boolean) => void;
}) {
  const playback = usePlayback();

  return (
    <DropdownMenu
      className="view-settings"
      label="Visualization settings"
      title="Settings"
      contextKey={tab?.id}
      summary={
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
        >
          <path
            d="M10 3 H14 L14.6 5.4 L16.2 6.3 L18.6 5.7 L20.6 9.1 L18.9 10.9 V13.1 L20.6 14.9
            L18.6 18.3 L16.2 17.7 L14.6 18.6 L14 21 H10 L9.4 18.6 L7.8 17.7 L5.4 18.3 L3.4 14.9
            L5.1 13.1 V10.9 L3.4 9.1 L5.4 5.7 L7.8 6.3 L9.4 5.4 Z"
          />
          <circle cx={12} cy={12} r={3} />
        </svg>
      }
    >
      <fieldset>
        <legend>Shared playback</legend>
        <label className="settings-row">
          Alignment
          <select
            aria-label="Time alignment"
            value={playback.alignment}
            onChange={(event) => playback.setAlignment(event.target.value)}
          >
            <option value="absolute">Absolute time</option>
            <option value="armed">Aligned to armed</option>
            <option value="mission">Aligned to mission start</option>
          </select>
        </label>
        <label>
          <input type="checkbox" checked={playback.loop} onChange={(event) => playback.setLoop(event.target.checked)} />
          Loop
        </label>
        <label>
          <input
            type="checkbox"
            checked={playback.autoScroll}
            onChange={(event) => playback.setAutoScroll(event.target.checked)}
          />
          Auto-scroll
        </label>
      </fieldset>
      {tab && (
        <fieldset>
          <legend>Active view</legend>
          <label className="settings-row">
            Angles
            <select
              aria-label="Angle units"
              value={tab.angles}
              onChange={(event) => onTabPatch({ angles: event.target.value as ViewTab['angles'] })}
            >
              <option value="degrees">Degrees</option>
              <option value="radians">Radians</option>
            </select>
          </label>
          {tab.type === 'graph' && (
            <label>
              <input
                type="checkbox"
                checked={intervalMode}
                onChange={(event) => onIntervalMode(event.target.checked)}
              />
              Select interval
            </label>
          )}
        </fieldset>
      )}
    </DropdownMenu>
  );
}
