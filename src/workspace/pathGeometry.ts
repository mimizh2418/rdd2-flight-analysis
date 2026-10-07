/** Maximum spatial error in the full-path drawing buffer, in metres; source telemetry is never simplified. */
export const fullPathTolerance = 0.00001;

/**
 * Measure a vertex's squared distance from a candidate chord in a packed three-component polyline.
 * @param points XYZ coordinates at GPU Float32 precision.
 * @param vertex Point index to measure.
 * @param start First endpoint index.
 * @param end Last endpoint index.
 * @returns Squared distance to the finite chord, in square metres.
 */
function chordDistance(points: number[], vertex: number, start: number, end: number): number {
  let numerator = 0;
  let denominator = 0;

  for (let axis = 0; axis < 3; axis++) {
    const direction = points[end * 3 + axis] - points[start * 3 + axis];
    numerator += (points[vertex * 3 + axis] - points[start * 3 + axis]) * direction;
    denominator += direction * direction;
  }

  const fraction = denominator ? Math.max(0, Math.min(1, numerator / denominator)) : 0;
  let squared = 0;

  for (let axis = 0; axis < 3; axis++) {
    const direction = points[end * 3 + axis] - points[start * 3 + axis];
    const delta = points[vertex * 3 + axis] - points[start * 3 + axis] - fraction * direction;
    squared += delta * delta;
  }

  return squared;
}

/**
 * Reduce only the immutable full-path drawing buffer using bounded-error Douglas-Peucker simplification.
 * @param segments Packed Float32 XYZ endpoint pairs; disconnected pairs remain separate polylines.
 * @param yieldWork Async checkpoint that yields to messages and checks cancellation.
 * @param report Completed fraction of source segments covered by accepted chords.
 * @returns New endpoint-pair buffer with at most fullPathTolerance deviation from the supplied geometry.
 * @remarks Endpoints come from original vertices. An iterative stack avoids recursion overflow, and periodic
 *   checkpoints keep pathological inputs cancellable. Timed trails and sampled poses use their original buffers.
 */
export async function simplifyFullPath(
  segments: Float32Array,
  yieldWork: () => Promise<void>,
  report: (fraction: number) => void,
): Promise<Float32Array> {
  const result: number[] = [];
  const count = segments.length / 6;
  let completed = 0;
  let operations = 0;

  for (let first = 0; first < count; ) {
    const points = Array.from(segments.subarray(first * 6, first * 6 + 3));
    let next = first;

    // Consecutive segments are connected only when their stored endpoints agree exactly.
    // This retains spatial breaks from invalid samples, coverage gaps, and reference resets.
    do {
      points.push(...segments.subarray(next * 6 + 3, next * 6 + 6));
      next++;

      if (++operations % 4096 === 0) {
        report(completed / count);
        await yieldWork();
      }
    } while (
      next < count &&
      [0, 1, 2].every((axis) => segments[next * 6 + axis] === segments[(next - 1) * 6 + 3 + axis])
    );

    const vertices = points.length / 3;
    const keep = new Uint8Array(vertices);
    keep[0] = keep[vertices - 1] = 1;
    const pending: [number, number][] = [[0, vertices - 1]];

    while (pending.length) {
      const [start, end] = pending.pop()!;
      let furthest = -1;
      let maximum = fullPathTolerance ** 2;

      for (let vertex = start + 1; vertex < end; vertex++) {
        const distance = chordDistance(points, vertex, start, end);

        if (distance > maximum) {
          maximum = distance;
          furthest = vertex;
        }

        if (++operations % 4096 === 0) {
          report(completed / count);
          await yieldWork();
        }
      }

      if (furthest >= 0) {
        keep[furthest] = 1;
        pending.push([start, furthest], [furthest, end]);
      } else completed += end - start;
    }

    let previous = 0;

    for (let vertex = 1; vertex < vertices; vertex++) {
      if (!keep[vertex]) continue;
      result.push(...points.slice(previous * 3, previous * 3 + 3), ...points.slice(vertex * 3, vertex * 3 + 3));
      previous = vertex;
    }

    first = next;
  }

  report(1);
  return Float32Array.from(result);
}
