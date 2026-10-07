import { useEffect, useRef, useState } from 'react';
import type { ImportStatus } from '../data/useRunImport';

export interface ErrorNotification {
  id: string;
  message: string;
}

/**
 * Keep short imports silent and give visible imports a readable completion state.
 * @param props Stable batch progress, cancellation action, and removal callback after completion.
 * @returns One toast after 200 ms of loading, retained for 1.2 seconds after completion.
 * @remarks Progress updates preserve the element and its timer. Cancellation or failure unmounts it immediately.
 */
function ImportToast({
  progress,
  cancelImport,
  onDismiss,
}: {
  progress: ImportStatus;
  cancelImport: () => void;
  onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(false);
  const complete = progress.phase === 'complete';
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    // A completed fast import cancels the pending reveal, so it never flashes on screen.
    const timer = setTimeout(
      () => {
        if (complete) dismiss.current();
        else setVisible(true);
      },
      complete ? 1200 : 200,
    );

    return () => clearTimeout(timer);
  }, [complete]);

  if (!visible) return null;

  return (
    <section className="workbench-toast import-toast" aria-label="CSV import">
      <div className="toast-heading">
        <strong>{complete ? 'CSV imported' : 'Importing CSV'}</strong>
        {complete ? (
          <button className="flat icon" aria-label="Dismiss import" onClick={onDismiss}>
            ×
          </button>
        ) : (
          <button className="flat" onClick={cancelImport}>
            Cancel import
          </button>
        )}
      </div>
      <p role="status">{progress.stage}</p>
      <div className="toast-progress">
        <progress aria-label="CSV import progress" max={1} value={progress.fraction} />
        <span className="mono">{Math.round(progress.fraction * 100)}%</span>
      </div>
    </section>
  );
}

/**
 * Display global operation feedback without taking space from the visualization.
 * @param props Current import, queued errors, alignment warning, and their action callbacks.
 * @returns A fixed notification stack with independent dismissal for each queued error.
 * @remarks Errors and warnings never expire automatically. Field-specific feedback stays in the field dock.
 */
export function WorkbenchToasts({
  progress,
  cancelImport,
  errors,
  dismissError,
  warning,
  warningKey,
}: {
  progress: ImportStatus | null;
  cancelImport: () => void;
  errors: ErrorNotification[];
  dismissError: (id: string) => void;
  warning: string;
  warningKey: string;
}) {
  const [imports, setImports] = useState<ImportStatus[]>([]);
  const [dismissedWarning, setDismissedWarning] = useState<string | null>(null);
  const [visibleWarning, setVisibleWarning] = useState<string | null>(null);
  const hasWarning = !!warning;

  useEffect(() => {
    // Keep finished batches while their completion feedback expires, even if another import starts.
    // Only batch identity/phase changes affect the queue; live progress is read directly during rendering.
    setImports((current) => {
      if (!progress) return current.filter((item) => item.phase === 'complete');

      if (current.some((item) => item.id === progress.id))
        return current.map((item) => (item.id === progress.id ? progress : item));

      return [...current.filter((item) => item.phase === 'complete'), progress];
    });
  }, [progress?.id, progress?.phase]);

  useEffect(() => {
    if (!hasWarning) {
      setVisibleWarning(null);
      setDismissedWarning(null);
      return;
    }

    // Restoring an imported workspace may change alignment before the next paint settles its sources.
    const timer = setTimeout(() => setVisibleWarning(warningKey), 200);

    return () => clearTimeout(timer);
  }, [hasWarning, warningKey]);

  return (
    <div className="toast-stack" aria-label="Workspace notifications">
      {imports.map((item) => (
        <ImportToast
          key={item.id}
          progress={progress?.id === item.id ? progress : item}
          cancelImport={cancelImport}
          onDismiss={() => setImports((current) => current.filter((entry) => entry.id !== item.id))}
        />
      ))}

      {errors.map((error) => (
        <section className="workbench-toast error-toast" key={error.id}>
          <div className="toast-heading">
            <strong>Error</strong>
            <button className="flat icon" aria-label="Dismiss error" onClick={() => dismissError(error.id)}>
              ×
            </button>
          </div>
          <p role="alert">{error.message}</p>
        </section>
      ))}

      {warning && warningKey === visibleWarning && warningKey !== dismissedWarning && (
        <section className="workbench-toast warning-toast">
          <div className="toast-heading">
            <strong>Alignment warning</strong>
            <button
              className="flat icon"
              aria-label="Dismiss alignment warning"
              onClick={() => setDismissedWarning(warningKey)}
            >
              ×
            </button>
          </div>
          <p role="status">{warning}</p>
        </section>
      )}
    </div>
  );
}
