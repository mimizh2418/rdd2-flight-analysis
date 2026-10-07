/**
 * Draw the drone geometry shared by pose appearance previews and application branding.
 * @param props Body fill color; surrounding SVG/group supplies stroke, opacity, and placement.
 * @returns Centered four-rotor glyph spanning 28 by 18 SVG units, with no accessible text of its own.
 */
export function DroneGlyph({ color = 'currentColor' }: { color?: string }) {
  return (
    <>
      <path d="M-8 -6 L8 6 M-8 6 L8 -6" />
      {[
        [-9, -6],
        [9, -6],
        [-9, 6],
        [9, 6],
      ].map(([x, y]) => (
        <ellipse key={`${x}:${y}`} cx={x} cy={y} rx={5} ry={3} />
      ))}
      <rect x={-3} y={-4} width={6} height={8} rx={2} fill={color} />
    </>
  );
}

/**
 * Frame the pose dock's drone glyph for use in the app header and visualization tabs.
 * @param props Optional class for sizing and color; the icon inherits the surrounding text color.
 * @returns Decorative SVG; the enclosing wordmark or control supplies its accessible name.
 */
export function DroneIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 36 26"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <g transform="translate(18 13)">
        <DroneGlyph />
      </g>
    </svg>
  );
}
