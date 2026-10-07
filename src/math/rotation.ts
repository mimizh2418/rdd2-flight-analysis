import type { Quat, Vec3 } from '../data/types';

/**
 * Clamp a scalar to an inclusive interval, defaulting to the domain of inverse trigonometric functions.
 *
 * @param x Value to clamp; NaN propagates.
 * @param lo Inclusive lower bound; defaults to -1.
 * @param hi Inclusive upper bound; defaults to 1 and must be >= lo.
 * @returns Value restricted to [lo, hi].
 */
export const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));

/**
 * Return the Euclidean norm of a numeric vector.
 *
 * @param v Components in a common unit.
 * @returns Nonnegative magnitude in that unit; NaN components propagate.
 */
export const norm = (v: number[]) => Math.hypot(...v);

/**
 * Normalize an x/y/z/w Hamilton quaternion; return NaN components for degenerate inputs.
 *
 * @param q Quaternion [x, y, z, w]; does not need to have unit length.
 * @returns New unit quaternion, or four NaNs when the magnitude is non-finite or <= 1e-12. The input is unchanged.
 */
export function normalize(q: Quat): Quat {
  const n = norm(q);

  return n > 1e-12 && Number.isFinite(n) ? (q.map((x) => x / n) as Quat) : [NaN, NaN, NaN, NaN];
}

/**
 * Convert roll, pitch, and yaw in radians to a body-FLU-to-world-ENU quaternion using intrinsic ZYX order.
 *
 * @param rpy [roll, pitch, yaw] in radians, using yaw-pitch-roll rotation composition.
 * @returns Unit Hamilton quaternion [x, y, z, w]; invalid angles produce NaN components.
 */
export function fromRpy(rpy: Vec3): Quat {
  const [roll, pitch, yaw] = rpy;

  // Quaternion products use half-angles; these terms compose yaw about Z, pitch about Y, then roll about X.
  const cosRoll = Math.cos(roll / 2);
  const sinRoll = Math.sin(roll / 2);
  const cosPitch = Math.cos(pitch / 2);
  const sinPitch = Math.sin(pitch / 2);
  const cosYaw = Math.cos(yaw / 2);
  const sinYaw = Math.sin(yaw / 2);

  return normalize([
    sinRoll * cosPitch * cosYaw - cosRoll * sinPitch * sinYaw,
    cosRoll * sinPitch * cosYaw + sinRoll * cosPitch * sinYaw,
    cosRoll * cosPitch * sinYaw - sinRoll * sinPitch * cosYaw,
    cosRoll * cosPitch * cosYaw + sinRoll * sinPitch * sinYaw,
  ]);
}

/**
 * Convert an x/y/z/w quaternion to intrinsic ZYX roll, pitch, and yaw in radians.
 *
 * @param q Body-FLU-to-world-ENU Hamilton quaternion [x, y, z, w], normalized internally.
 * @returns [roll, pitch, yaw] in radians, with pitch in [-pi/2, pi/2]. Invalid quaternions propagate NaNs; Euler
 *   angles remain ambiguous at gimbal lock.
 */
export function toRpy(q: Quat): Vec3 {
  // Normalize first so slightly non-unit simulator output does not distort the recovered angles.
  const [x, y, z, w] = normalize(q);

  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
    Math.asin(clamp(2 * (w * y - z * x))),
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
  ];
}

/**
 * Convert a normalized quaternion into a row-major 3×3 body-to-world rotation matrix.
 *
 * @param q Body-FLU-to-world-ENU quaternion [x, y, z, w], normalized internally.
 * @returns Nine row-major entries of R such that worldVector = R * bodyVector. Invalid input produces NaN entries.
 */
export function toMatrix(q: Quat): number[] {
  const [x, y, z, w] = normalize(q);

  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y - z * w),
    2 * (x * z + y * w),
    2 * (x * y + z * w),
    1 - 2 * (x * x + z * z),
    2 * (y * z - x * w),
    2 * (x * z - y * w),
    2 * (y * z + x * w),
    1 - 2 * (x * x + y * y),
  ];
}

/**
 * Convert a finite row-major 3×3 body-to-world rotation matrix into an x/y/z/w quaternion.
 *
 * @param m Nine row-major entries of a proper rotation matrix; orthogonality is assumed rather than checked.
 * @returns Normalized Hamilton quaternion [x, y, z, w], or four NaNs for invalid length, non-finite entries, or a
 *   degenerate result.
 */
export function fromMatrix(m: number[]): Quat {
  if (m.length !== 9 || !m.every(Number.isFinite)) {
    return [NaN, NaN, NaN, NaN];
  }

  const trace = m[0] + m[4] + m[8];
  let q: Quat;

  // Choose a stable matrix component so rotations close to 180° avoid division by a tiny trace term.
  if (trace > 0) {
    const s = 2 * Math.sqrt(trace + 1);

    q = [(m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s, s / 4];
  } else if (m[0] > m[4] && m[0] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[0] - m[4] - m[8]);

    q = [s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s, (m[7] - m[5]) / s];
  } else if (m[4] > m[8]) {
    const s = 2 * Math.sqrt(1 + m[4] - m[0] - m[8]);

    q = [(m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s, (m[2] - m[6]) / s];
  } else {
    const s = 2 * Math.sqrt(1 + m[8] - m[0] - m[4]);

    q = [(m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4, (m[3] - m[1]) / s];
  }

  return normalize(q);
}

/**
 * Interpolate normalized quaternions along the shortest rotation arc, respecting their sign equivalence.
 *
 * @param a Starting Hamilton quaternion [x, y, z, w].
 * @param b Ending Hamilton quaternion [x, y, z, w].
 * @param t Interpolation fraction, normally in [0, 1]; this function does not clamp it.
 * @returns Interpolated quaternion with matching frame direction. Invalid endpoints propagate NaNs. Inputs are not
 *   changed.
 */
export function slerp(a: Quat, b: Quat, t: number): Quat {
  a = normalize(a);
  b = normalize(b);

  let dot = a.reduce((s, x, i) => s + x * b[i], 0);

  // q and −q encode the same attitude; choose matching signs to follow the shorter rotation arc.
  if (dot < 0) {
    b = b.map((x) => -x) as Quat;
    dot = -dot;
  }

  // Nearly identical rotations use normalized linear interpolation to avoid an unstable sine denominator.
  if (dot > 0.9995) {
    return normalize(a.map((x, i) => x + t * (b[i] - x)) as Quat);
  }

  // The sine weights follow the great-circle arc between the two orientations on the quaternion sphere.
  const theta = Math.acos(clamp(dot));
  const sin = Math.sin(theta);

  return a.map((x, i) => (x * Math.sin((1 - t) * theta) + b[i] * Math.sin(t * theta)) / sin) as Quat;
}

/**
 * Return the shortest rotation angle in radians between two quaternion attitudes.
 *
 * @param a First Hamilton quaternion [x, y, z, w], normalized internally.
 * @param b Second quaternion with the same frame convention, normalized internally.
 * @returns Angular separation in [0, pi] radians, or NaN for an invalid quaternion. Opposite quaternion signs
 *   represent zero separation.
 */
export const angleError = (a: Quat, b: Quat) =>
  2 * Math.acos(clamp(Math.abs(normalize(a).reduce((s, x, i) => s + x * normalize(b)[i], 0)), 0, 1));

/**
 * Wrap an angle in radians into the principal interval from −π to π.
 *
 * @param x Angle in radians; non-finite values produce NaN.
 * @returns Equivalent principal angle in [-pi, pi].
 */
export const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));

/**
 * Rotate a three-component vector by the transpose of a row-major 3×3 matrix.
 *
 * @param m Nine row-major matrix entries, normally the body-to-world rotation R.
 * @param v Three vector components, normally in world ENU coordinates.
 * @returns R-transpose * v; for a rotation matrix this expresses the vector in the local/body frame. Inputs are
 *   unchanged.
 */
export function transposeMultiply(m: number[], v: number[]): number[] {
  return [0, 1, 2].map((i) => m[i] * v[0] + m[i + 3] * v[1] + m[i + 6] * v[2]);
}

/**
 * Cholesky solve: reject singular or indefinite covariance.
 *
 * @param p Row-major n-by-n covariance, where n = e.length; matching dimensions are required. Off-diagonal entries are
 *   symmetrized during factorization.
 * @param e n-component error vector in the covariance's frame and state ordering.
 * @returns Dimensionless e-transpose * inverse(P) * e, or NaN for non-finite inputs or a singular/indefinite
 *   symmetrized covariance.
 * @remarks Uses a Cholesky factor and forward substitution rather than forming an explicit inverse. Inputs are
 *   unchanged.
 */
export function quadraticForm(p: number[], e: number[]): number {
  const n = e.length;
  const L = new Array(n * n).fill(0);
  const y = new Array(n).fill(0);

  if (!p.every(Number.isFinite) || !e.every(Number.isFinite)) {
    return NaN;
  }

  // Factor the symmetrized covariance as L Lᵀ instead of forming an explicit inverse.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      // Average mirrored entries to remove small numerical asymmetry before subtracting prior Cholesky terms.
      let s = (p[i * n + j] + p[j * n + i]) / 2;

      for (let k = 0; k < j; k++) {
        s -= L[i * n + k] * L[j * n + k];
      }

      if (i === j) {
        if (s <= 0) {
          return NaN;
        }

        L[i * n + j] = Math.sqrt(s);
      } else {
        L[i * n + j] = s / L[j * n + j];
      }
    }
  }

  // Solve L y = e by forward substitution; then eᵀ P⁻¹ e equals yᵀ y.
  for (let i = 0; i < n; i++) {
    let s = e[i];

    for (let k = 0; k < i; k++) {
      s -= L[i * n + k] * y[k];
    }

    y[i] = s / L[i * n + i];
  }

  return y.reduce((s, x) => s + x * x, 0);
}
