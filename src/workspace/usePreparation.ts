import { useEffect, useRef, useState } from 'react';
import type { Run } from '../data/types';
import { findField } from './fieldCatalog';
import { PreparationService } from './PreparationService';
import type { Field, LoadingState, PreparedField, ViewTab } from './types';

/**
 * Coordinate cancellable preparation jobs for all tab bindings using one selected-column worker cache.
 * @param runs Shared source registry.
 * @param fields Metadata catalog, without copies of source arrays.
 * @param tabs Independent visualization configurations.
 * @returns Prepared buffers, per-row progress, and the service used by graph and statistics requests.
 */
export function usePreparation(runs: Run[], fields: Field[], tabs: ViewTab[]) {
  const [service, setService] = useState<PreparationService | null>(null);
  const [prepared, setPrepared] = useState<Record<string, PreparedField>>({});
  const [loading, setLoading] = useState<Record<string, LoadingState>>({});
  const sources = useRef(new Set<string>());
  const jobs = useRef(new Map<string, { key: string; controller: AbortController }>());

  useEffect(() => {
    const instance = new PreparationService();
    setService(instance);

    return () => {
      for (const job of jobs.current.values()) job.controller.abort();
      jobs.current.clear();
      instance.dispose();
    };
  }, []);

  useEffect(() => {
    if (!service) return;

    const bindings = tabs.flatMap((tab) => tab.bindings);
    const present = new Set(bindings.map((binding) => binding.id));

    // Closing a tab or removing a field stops its outstanding work and prevents late results being applied.
    for (const [id, job] of jobs.current) {
      if (!present.has(id)) {
        job.controller.abort();
        jobs.current.delete(id);
        setPrepared((old) => {
          const next = { ...old };
          delete next[id];
          return next;
        });
        setLoading((old) => {
          const next = { ...old };
          delete next[id];
          return next;
        });
      }
    }

    for (const runId of sources.current) {
      if (!runs.some((run) => run.id === runId)) {
        for (const binding of bindings.filter((item) => item.runId === runId || item.orientation?.runId === runId)) {
          jobs.current.get(binding.id)?.controller.abort();
          jobs.current.delete(binding.id);
        }
        service.release(runId);
      }
    }
    sources.current = new Set(runs.map((run) => run.id));

    for (const binding of bindings) {
      const run = runs.find((item) => item.id === binding.runId);
      const field = findField(fields, binding.runId, binding.fieldId);
      const key = `${binding.runId}:${binding.fieldId}:${binding.orientation?.runId}:${binding.orientation?.fieldId}`;
      const existing = jobs.current.get(binding.id);

      if (existing?.key === key && run && field) continue;
      existing?.controller.abort();
      jobs.current.delete(binding.id);

      if (!run || !field) {
        setPrepared((old) => {
          const next = { ...old };
          delete next[binding.id];
          return next;
        });
        setLoading((old) => {
          const next = { ...old };
          delete next[binding.id];
          return next;
        });
        continue;
      }

      const controller = new AbortController();
      const job = { key, controller };
      jobs.current.set(binding.id, job);
      setLoading((old) => ({ ...old, [binding.id]: { fraction: 0, stage: 'Queued', ready: false } }));

      /**
       * Update only the binding that still owns this job; removed/replaced rows never receive stale progress.
       *
       * @param fraction Completed preparation fraction from zero to one.
       * @param stage Current worker or column-transfer stage.
       * @returns Nothing; ignores progress from removed or superseded bindings.
       */
      const progress = (fraction: number, stage: string) => {
        if (jobs.current.get(binding.id) === job && !controller.signal.aborted) {
          setLoading((old) => ({ ...old, [binding.id]: { fraction, stage, ready: false } }));
        }
      };

      void (async () => {
        try {
          const orientation = binding.orientation
            ? findField(fields, binding.orientation.runId, binding.orientation.fieldId)
            : undefined;
          const source = binding.orientation ? runs.find((item) => item.id === binding.orientation!.runId) : undefined;
          const positionWeight = orientation && source ? 0.7 : 1;
          const result = await service.field(
            run,
            field,
            (fraction, stage) => progress(fraction * positionWeight, stage),
            controller.signal,
          );

          // Explicit attitude sources have their own aligned data; account for both stages in one monotonic row bar.
          if (orientation && source) {
            await service.field(
              source,
              orientation,
              (fraction, stage) => progress(positionWeight + fraction * (1 - positionWeight), stage),
              controller.signal,
            );
          }
          if (controller.signal.aborted) return;
          setPrepared((old) => ({ ...old, [binding.id]: result }));
          setLoading((old) => ({ ...old, [binding.id]: { fraction: 1, stage: 'Ready', ready: true } }));
        } catch (error) {
          if (!controller.signal.aborted)
            setLoading((old) => ({
              ...old,
              [binding.id]: {
                fraction: 0,
                stage: 'Failed',
                ready: false,
                error: error instanceof Error ? error.message : String(error),
              },
            }));
        }
      })();
    }
  }, [runs, fields, tabs, service]);

  return { service, prepared, loading };
}
