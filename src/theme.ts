/**
 * Read the stylesheet's Mission Control tokens for renderers that draw directly into a canvas.
 * @param element Mounted chart or scene container inheriting the application's CSS custom properties.
 * @returns Plot background, grid, border, text/axis colors, and the shared monospace font stack.
 * @remarks Reading on renderer creation keeps canvas colors aligned with the UI without per-frame style queries.
 */
export function visualizationTheme(element: HTMLElement) {
  const style = getComputedStyle(element);

  return {
    canvas: style.getPropertyValue('--canvas').trim(),
    grid: style.getPropertyValue('--grid').trim(),
    border: style.getPropertyValue('--border').trim(),
    muted: style.getPropertyValue('--muted').trim(),
    axis: style.getPropertyValue('--axis').trim(),
    mono: style.getPropertyValue('--font-mono').trim(),
  };
}
