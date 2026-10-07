import type { Vec3 } from '../data/types';

interface Segment {
  a: Vec3;
  b: Vec3;
}

interface Node {
  lo: Vec3;
  hi: Vec3;
  left?: Node;
  right?: Node;
  segments?: Segment[];
}

/**
 * Return squared point-to-segment distance, optionally projected into the East/North plane.
 *
 * @param point Query [East, North, Up] position in metres.
 * @param segment Segment with finite ENU endpoints in metres; zero-length segments are supported.
 * @param horizontal Ignore Up when true; defaults to a full 3D measurement.
 * @returns Squared distance in square metres to the nearest point on the finite segment.
 */
const distance = (point: Vec3, segment: Segment, horizontal = false) => {
  let numerator = 0;
  let denominator = 0;
  const dimensions = horizontal ? 2 : 3;

  // Project point-minus-start onto the segment direction. Dividing by squared segment length gives
  // the unconstrained fraction along the line; a zero-length segment falls back to its start point.
  for (let i = 0; i < dimensions; i++) {
    numerator += (point[i] - segment.a[i]) * (segment.b[i] - segment.a[i]);
    denominator += (segment.b[i] - segment.a[i]) ** 2;
  }

  // Clamp the projection to [0, 1] so points beyond either end measure distance to the endpoint.
  const projectionFraction = denominator ? Math.max(0, Math.min(1, numerator / denominator)) : 0;
  let squaredDistance = 0;

  for (let i = 0; i < dimensions; i++) {
    squaredDistance += (point[i] - segment.a[i] - projectionFraction * (segment.b[i] - segment.a[i])) ** 2;
  }

  return squaredDistance;
};

/**
 * Build a balanced bounding-volume tree by splitting segments along their longest spatial extent.
 *
 * @param segments Nonempty segment list. This function sorts the supplied list in place; recursive children receive
 *   slices.
 * @returns Bounding box node with either at most twelve leaf segments or two child nodes.
 */
function build(segments: Segment[]): Node {
  const lower: Vec3 = [Infinity, Infinity, Infinity];
  const upper: Vec3 = [-Infinity, -Infinity, -Infinity];

  for (const segment of segments) {
    for (let i = 0; i < 3; i++) {
      lower[i] = Math.min(lower[i], segment.a[i], segment.b[i]);
      upper[i] = Math.max(upper[i], segment.a[i], segment.b[i]);
    }
  }

  // Small leaves use direct segment checks; larger nodes split to reduce nearest-path query work.
  if (segments.length <= 12) {
    return { lo: lower, hi: upper, segments };
  }

  let axis = 0;

  for (let i = 1; i < 3; i++) {
    if (upper[i] - lower[i] > upper[axis] - lower[axis]) {
      axis = i;
    }
  }

  // Sort by segment midpoint on the widest axis, then partition into equally sized child lists.
  segments.sort((a, b) => a.a[axis] + a.b[axis] - b.a[axis] - b.b[axis]);

  const splitIndex = segments.length >>> 1;

  return { lo: lower, hi: upper, left: build(segments.slice(0, splitIndex)), right: build(segments.slice(splitIndex)) };
}

/** Bounding-volume tree over actual recorded reference segments; no decimated metric data. */
export class PathDistance {
  private root?: Node;

  /**
   * Index recorded segments, treating null or non-finite points as breaks in the path.
   *
   * @param points Ordered ENU positions in metres. Null or non-finite entries break connectivity; isolated valid
   *   points are retained as zero-length segments.
   * @remarks Consecutive duplicate points do not create extra segments. Coordinate tuples are referenced rather than
   *   copied; callers must not modify them after construction. Empty input produces an index whose queries return NaN.
   */
  constructor(points: (Vec3 | null)[]) {
    const segments: Segment[] = [];
    let previousPoint: Vec3 | null = null;

    // Breaks reset connectivity. Each disconnected portion starts with a point segment so a one-point
    // reference still has a well-defined nearest distance.
    for (const point of points) {
      if (!point || !point.every(Number.isFinite)) {
        previousPoint = null;
        continue;
      }

      if (previousPoint) {
        if (point.some((v, i) => v !== previousPoint![i])) {
          segments.push({ a: previousPoint, b: point });
        }
      } else {
        segments.push({ a: point, b: point });
      }

      previousPoint = point;
    }

    if (segments.length) {
      this.root = build(segments);
    }
  }

  /**
   * Return nearest recorded-path distance in metres, or NaN when no valid query is possible.
   *
   * @param point Finite query [East, North, Up] position in metres.
   * @param horizontal Ignore Up when true; defaults to full 3D distance.
   * @returns Nonnegative distance in metres, or NaN for an empty path or non-finite query.
   * @remarks Searches the full indexed reference polyline independently of flight timing; crossing segments and
   *   zero-length segments are supported.
   */
  distance(point: Vec3, horizontal = false): number {
    if (!this.root || !point.every(Number.isFinite)) {
      return NaN;
    }

    let bestSquaredDistance = Infinity;

    /**
     * Compute a squared lower bound from the query point to a tree node's bounding box.
     *
     * @param node Bounding-volume node in the enclosing path index.
     * @returns Squared distance in square metres to the box, using the enclosing query and projection mode.
     */
    const bound = (node: Node) => {
      let squaredDistance = 0;

      for (let i = 0; i < (horizontal ? 2 : 3); i++) {
        squaredDistance += Math.max(node.lo[i] - point[i], 0, point[i] - node.hi[i]) ** 2;
      }

      return squaredDistance;
    };

    /**
     * Search the nearer subtree first and prune nodes that cannot improve the best distance.
     *
     * @param node Node to search using the enclosing query.
     * @returns Nothing; updates the enclosing best squared distance when a nearer segment is found.
     */
    const visit = (node: Node) => {
      // The box lower bound cannot beat the best known segment distance, so its whole subtree can be skipped.
      if (bound(node) > bestSquaredDistance) {
        return;
      }

      if (node.segments) {
        for (const segment of node.segments) {
          bestSquaredDistance = Math.min(bestSquaredDistance, distance(point, segment, horizontal));
        }
      } else {
        const leftChild = node.left!;
        const rightChild = node.right!;

        // Search the closer box first to tighten the best distance before testing the farther subtree.
        if (bound(leftChild) < bound(rightChild)) {
          visit(leftChild);
          visit(rightChild);
        } else {
          visit(rightChild);
          visit(leftChild);
        }
      }
    };

    visit(this.root);

    return Math.sqrt(bestSquaredDistance);
  }
}
