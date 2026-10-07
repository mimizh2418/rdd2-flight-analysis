import type { Run, Summary } from '../data/types';
import type { Field, PreparedField, WorkerRun } from './types';
import type { Progress } from './preparation';
import type { GraphIndex } from './graphIndex';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  progress: Progress;
}

/** Shared worker cache contains only selected columns, never clones an entire imported simulation. */
export class PreparationService {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private uploaded = new Map<string, Promise<void>>();
  private disposed = false;
  private fields = new Map<string, PreparedField>();
  private graphIndices = new Map<string, GraphIndex>();
  private graphJobs = new Map<string, { signal: AbortSignal; promise: Promise<GraphIndex> }>();

  /**
   * Start a dedicated CPU preparation worker.
   * @returns A service whose owner must call dispose on application unmount.
   */
  constructor() {
    this.worker = new Worker(new URL('../workers/prepare.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event) => {
      const message = event.data;
      const request = this.pending.get(message.id);

      if (!request) return;

      if (message.type === 'progress') request.progress(message.fraction, message.stage);
      else {
        this.pending.delete(message.id);
        if (message.type === 'result') request.resolve(message.result);
        else request.reject(new Error(message.message));
      }
    };
    this.worker.onerror = (event) => {
      for (const request of this.pending.values()) request.reject(new Error(event.message));
      this.pending.clear();
    };
  }

  /**
   * Copy selected columns in small transferable batches, yielding to paint/input between batches.
   * @param run Source run retained on the UI thread.
   * @param ids Needed channels; validity dependencies are added recursively.
   * @param progress Per-field loading callback.
   * @param signal Cancellation signal for the binding/plot request.
   * @returns Promise when the worker has all needed source columns. Uploads are deduplicated across tabs.
   */
  private async upload(run: Run, ids: string[], progress: Progress, signal: AbortSignal): Promise<void> {
    const columns = new Set<string>(['$time', '$index']);

    /**
     * Gather a channel and its validity dependencies without recursion cycles.
     * @param id Source scalar channel key.
     * @returns Nothing; mutates the enclosing upload set.
     */
    const gather = (id: string) => {
      if (columns.has(id) || !run.signals[id]) return;
      columns.add(id);
      if (run.signals[id].validity) gather(run.signals[id].validity!);
    };
    ids.forEach(gather);

    const runKey = `${run.id}:$run`;

    if (!this.uploaded.has(runKey)) {
      const { time, index, signals, ...metadata } = run;
      const workerRun: WorkerRun = { ...metadata, rows: time.length, groups: index.length };
      this.worker.postMessage({ type: 'run', run: workerRun });
      this.uploaded.set(runKey, Promise.resolve());
    }

    let done = 0;

    for (const name of columns) {
      if (signal.aborted || this.disposed) throw new DOMException('Field removed', 'AbortError');

      const key = `${run.id}:${name}`;
      let promise = this.uploaded.get(key);

      if (!promise) {
        promise = (async () => {
          const source = name === '$time' ? run.time : name === '$index' ? run.index : run.signals[name].values;
          const meta = name.startsWith('$') ? undefined : { ...run.signals[name], values: undefined };

          // At most 256 KiB per numeric column chunk: no giant structured clone on a field drop.
          for (let offset = 0; offset < source.length; offset += 32768) {
            if (this.disposed) throw new DOMException('Workspace closed', 'AbortError');

            const data = source.slice(offset, offset + 32768);
            this.worker.postMessage({ type: 'column', runId: run.id, name, meta, offset, data }, [data.buffer]);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
        })();
        this.uploaded.set(key, promise);
        promise.catch(() => this.uploaded.delete(key));
      }

      await promise;
      progress(++done / columns.size, 'Loading source columns');
    }
  }

  /**
   * Send one cancellable worker operation after source uploads.
   * @param message Operation-specific metadata.
   * @param progress Worker-stage progress callback.
   * @param signal Abort signal; stale results are ignored and pending promises are rejected.
   * @returns Promise of the typed prepared result.
   */
  private request<T>(message: Record<string, unknown>, progress: Progress, signal: AbortSignal): Promise<T> {
    if (signal.aborted || this.disposed) return Promise.reject(new DOMException('Preparation cancelled', 'AbortError'));

    const id = ++this.sequence;

    return new Promise<T>((resolve, reject) => {
      /**
       * Cancel the pending preparation operation.
       *
       * @returns Nothing; tells the worker to cancel, removes the pending request, and rejects with AbortError.
       */
      const abort = () => {
        this.worker.postMessage({ type: 'cancel', id });
        this.pending.delete(id);
        reject(new DOMException('Preparation cancelled', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          signal.removeEventListener('abort', abort);
          resolve(value as T);
        },
        reject: (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
        progress,
      });
      this.worker.postMessage({ ...message, id });
    });
  }

  /**
   * Load a binding's channels and prepare any path buffers without blocking the browser.
   * @param run Shared source run.
   * @param field Catalog field being bound.
   * @param progress Progress from zero to one, mapped across transfer and worker computation.
   * @param signal Binding lifetime cancellation.
   * @returns Prepared geometry or an empty result for a nonspatial field.
   */
  async field(run: Run, field: Field, progress: Progress, signal: AbortSignal): Promise<PreparedField> {
    const ids = [...field.signals];

    if (field.orientation) ids.push(...[0, 1, 2, 3].map((axis) => `${field.orientation}.${axis}`));
    if (field.prefix === 'reference.position') ids.push('reference.clock', 'reference.sequence');

    await this.upload(run, ids, (fraction, stage) => progress(fraction * 0.45, stage), signal);
    const key = `${run.id}:${field.type === 'pose' ? 'position' : field.type}:${field.signals.join(',')}`;
    const cached = this.fields.get(key);

    if (cached) return cached;

    const result = await this.request<PreparedField>(
      { type: 'field', runId: run.id, field },
      (fraction, stage) => progress(0.45 + fraction * 0.55, stage),
      signal,
    );
    this.fields.set(key, result);
    return result;
  }

  /**
   * Load and index one graph channel once; zoom, axis, color, and angle changes reuse its immutable cache.
   * @param run Shared source registry entry.
   * @param id Selected scalar channel.
   * @param progress Per-binding loading callback for initial transfer and indexing.
   * @param signal Binding/tab lifetime cancellation.
   * @returns Transferable extrema index retained until this source is removed.
   */
  async graphIndex(run: Run, id: string, progress: Progress, signal: AbortSignal): Promise<GraphIndex> {
    const key = `${run.id}:${id}`;
    const cached = this.graphIndices.get(key);
    if (cached) return cached;

    const pending = this.graphJobs.get(key);
    if (pending && pending.signal === signal && !signal.aborted) return pending.promise;

    // An aggregate and one of its components can reference the same scalar in the same graph.
    const promise = (async () => {
      await this.upload(run, [id], (fraction, stage) => progress(fraction * 0.3, stage), signal);
      const result = await this.request<GraphIndex>(
        { type: 'graph-index', runId: run.id, signalId: id },
        (fraction, stage) => progress(0.3 + fraction * 0.7, stage),
        signal,
      );
      this.graphIndices.set(key, result);
      return result;
    })();
    this.graphJobs.set(key, { signal, promise });
    try {
      return await promise;
    } finally {
      if (this.graphJobs.get(key)?.promise === promise) this.graphJobs.delete(key);
    }
  }

  /**
   * Compute existing full-resolution tracking metrics asynchronously for an export.
   * @param run Imported source.
   * @param interval Original simulation seconds, independent of zoom.
   * @returns Tracking summary from the numeric integration implementation.
   */
  async summary(run: Run, interval: [number, number]): Promise<Summary> {
    const controller = new AbortController();
    await this.upload(run, ['tracking.norm', 'tracking.0', 'tracking.1', 'tracking.2'], () => {}, controller.signal);
    return this.request<Summary>({ type: 'summary', runId: run.id, interval }, () => {}, controller.signal);
  }

  /**
   * Release cached columns and geometry when a source run is removed.
   * @param runId Registry identity to forget; its binding jobs must be aborted first.
   * @returns Nothing; future reimports receive fresh source identities.
   */
  release(runId: string): void {
    this.worker.postMessage({ type: 'release', runId });
    for (const key of this.uploaded.keys()) if (key.startsWith(`${runId}:`)) this.uploaded.delete(key);
    for (const key of this.fields.keys()) if (key.startsWith(`${runId}:`)) this.fields.delete(key);
    for (const key of this.graphIndices.keys()) if (key.startsWith(`${runId}:`)) this.graphIndices.delete(key);
    for (const key of this.graphJobs.keys()) if (key.startsWith(`${runId}:`)) this.graphJobs.delete(key);
  }

  /**
   * Release all worker caches and cancel outstanding requests.
   * @returns Nothing; call once when the service owner unmounts.
   */
  dispose(): void {
    this.disposed = true;
    for (const request of this.pending.values()) request.reject(new DOMException('Workspace closed', 'AbortError'));
    this.pending.clear();
    this.uploaded.clear();
    this.fields.clear();
    this.graphIndices.clear();
    this.graphJobs.clear();
    this.worker.terminate();
  }
}
