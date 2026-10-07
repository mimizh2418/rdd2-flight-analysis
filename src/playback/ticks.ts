/** One timeline graduation; minor ticks have no label. */
export interface TimeTick {
  time: number;
  major: boolean;
  label: string;
}

/**
 * Choose stable, round graduations for a zoomable simulation timeline.
 * @param window Visible simulation seconds, in ascending order.
 * @param width Available width in CSS pixels.
 * @returns Major ticks about 90 pixels apart, with four minor subdivisions and precision appropriate to the zoom.
 */
export function timeTicks(window: [number, number], width: number): TimeTick[] {
  const [start, end] = window;
  const target = (end - start) / Math.max(1, width / 90);
  if (!(target > 0) || !Number.isFinite(target)) return [];

  const magnitude = 10 ** Math.floor(Math.log10(target));
  const major = ([1, 2, 5, 10].find((multiple) => multiple * magnitude >= target) ?? 10) * magnitude;
  const minor = major / 5;
  const decimals = Math.max(0, -Math.floor(Math.log10(major)));
  const ticks: TimeTick[] = [];
  const first = Math.ceil(start / minor - 1e-9);
  const last = Math.floor(end / minor + 1e-9);

  // Generate by integer index to avoid accumulating floating-point drift while panning.
  for (let index = first; index <= last && ticks.length < 1000; index++) {
    const time = Number((index * minor).toPrecision(14));
    const isMajor = index % 5 === 0;
    ticks.push({ time, major: isMajor, label: isMajor ? `${time.toFixed(Math.min(12, decimals))}s` : '' });
  }
  return ticks;
}
