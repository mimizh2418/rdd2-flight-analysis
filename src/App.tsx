import { useState } from 'react';
import type { Run } from './data/types';
import { PlaybackProvider } from './playback/PlaybackProvider';
import { validateWorkspace, workspaceStorageKey } from './workspace/workspaceState';
import type { WorkspaceDocument } from './workspace/types';
import { Workbench } from './Workbench';

/**
 * Read configuration from optional browser storage without making invalid JSON fatal.
 * @returns Validated workspace, or undefined when no usable saved settings exist.
 */
function savedWorkspace(): WorkspaceDocument | undefined {
  try {
    const saved = localStorage.getItem(workspaceStorageKey);
    return saved ? validateWorkspace(JSON.parse(saved)) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Own the immutable source registry and compose the technical workbench with its global clock.
 * @returns Empty source registry with any saved configuration-only workspace; logs are imported explicitly.
 */
export default function App() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [initial] = useState(savedWorkspace);

  return (
    <PlaybackProvider runs={runs} initial={initial}>
      <Workbench runs={runs} setRuns={setRuns} initial={initial} />
    </PlaybackProvider>
  );
}
