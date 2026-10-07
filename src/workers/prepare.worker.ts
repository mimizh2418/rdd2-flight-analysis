import type { Run, Signal } from '../data/types';
import type { Field, WorkerRun } from '../workspace/types';
import { prepareField, prepareSummary } from '../workspace/preparation';
import { buildGraphIndex } from '../workspace/graphIndex';

const runs = new Map<string, Run>();
const cancelled = new Set<number>();
const context = self as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

/**
 * Accept bounded column uploads and cancellable data-preparation requests.
 * @param event Worker protocol message; source arrays arrive in transferable chunks.
 * @returns Promise after the message is handled; progress/result/errors are posted back to the client.
 */
context.onmessage = async (event: MessageEvent) => {
  const message = event.data;

  if (message.type === 'run') {
    const metadata = message.run as WorkerRun;
    const { rows, groups, ...rest } = metadata;
    runs.set(metadata.id, { ...rest, time: new Float64Array(rows), index: new Uint32Array(groups), signals: {} });
    return;
  }

  if (message.type === 'column') {
    const run = runs.get(message.runId);

    // A cancelled upload may have one final chunk in flight after its source has been released.
    if (!run) return;

    let target: Float64Array | Uint32Array;

    if (message.name === '$time') target = run.time;
    else if (message.name === '$index') target = run.index;
    else {
      if (!run.signals[message.name])
        run.signals[message.name] = {
          ...(message.meta as Omit<Signal, 'values'>),
          values: new Float64Array(run.time.length),
        };
      target = run.signals[message.name].values;
    }
    target.set(message.data, message.offset);
    return;
  }

  if (message.type === 'cancel') {
    cancelled.add(message.id);
    return;
  }
  if (message.type === 'release') {
    runs.delete(message.runId);
    return;
  }

  const id = message.id as number;
  /**
   * Publish progress for one cancellable worker operation.
   *
   * @param fraction Worker-computation fraction from zero to one.
   * @param stage Human-readable loading stage.
   * @returns Nothing; posts progress tagged with the owning request identity.
   */
  const report = (fraction: number, stage: string) => context.postMessage({ type: 'progress', id, fraction, stage });
  /**
   * Check cancellation between worker computation batches.
   *
   * @returns True when a matching cancellation message has been received.
   */
  const isCancelled = () => cancelled.has(id);

  try {
    let result: unknown;
    const transfer: Transferable[] = [];

    if (message.type === 'field') {
      const prepared = await prepareField(runs.get(message.runId)!, message.field as Field, report, isCancelled);
      result = prepared;
      if (prepared.path) {
        transfer.push(prepared.path.positions.buffer, prepared.path.times.buffer);
        if (prepared.path.fullPositions) transfer.push(prepared.path.fullPositions.buffer);
      }
    } else if (message.type === 'graph-index') {
      const index = await buildGraphIndex(runs.get(message.runId)!, message.signalId, report, isCancelled);
      result = index;
      transfer.push(
        index.values.buffer,
        index.min.buffer,
        index.max.buffer,
        index.boundaries.buffer,
        index.gaps.buffer,
      );
    } else if (message.type === 'summary') {
      result = prepareSummary(runs.get(message.runId)!, message.interval);
    } else throw new Error('Unknown preparation request.');

    if (!isCancelled()) context.postMessage({ type: 'result', id, result }, transfer);
  } catch (error) {
    if (!isCancelled())
      context.postMessage({ type: 'error', id, message: error instanceof Error ? error.message : String(error) });
  } finally {
    cancelled.delete(id);
  }
};
