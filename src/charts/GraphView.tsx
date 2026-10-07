import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import type { Run } from '../data/types';
import { usePlayback } from '../playback/PlaybackProvider';
import { findField } from '../workspace/fieldCatalog';
import type { PreparationService } from '../workspace/PreparationService';
import { indexedPlot, type GraphIndex } from '../workspace/graphIndex';
import type { Field, PlotSeries, ViewTab } from '../workspace/types';
import { visualizationTheme } from '../theme';

/**
 * Expand selected typed fields into scalar channels without cloning their data.
 * @param tab Graph configuration.
 * @param fields Source descriptors.
 * @param runs Loaded simulations.
 * @param offsets Display-time alignment offsets.
 * @returns Visible scalar series; orientation aggregates expand into roll, pitch, and yaw.
 */
export function graphSeries(tab: ViewTab, fields: Field[], runs: Run[], offsets: Map<string, number>): PlotSeries[] {
  return tab.bindings
    .filter((binding) => binding.visible)
    .flatMap((binding) => {
      const field = findField(fields, binding.runId, binding.fieldId);
      const run = runs.find((item) => item.id === binding.runId);
      const offset = offsets.get(binding.runId);

      if (!field || !run || !Number.isFinite(offset)) return [];

      const ids =
        field.type === 'orientation'
          ? [0, 1, 2].map((axis) => `${field.prefix === 'estimate.q' ? 'estimate.rpy' : 'rpy'}.${axis}`)
          : field.signals;

      return ids
        .filter((id) => !!run.signals[id])
        .map((id, component) => {
          const signal = run.signals[id];
          const degrees = signal.unit === 'rad' && tab.angles === 'degrees';

          return {
            bindingId: binding.id,
            runId: run.id,
            signalId: id,
            label: `${binding.label}${ids.length > 1 ? ` / ${field.type === 'orientation' ? ['Roll', 'Pitch', 'Yaw'][component] : ['E', 'N', 'U', '4'][component]}` : ''} · ${run.name}`,
            lane: binding.lane as 'left' | 'right',
            color: binding.color,
            style: binding.style,
            width: binding.width,
            markers: binding.markers,
            unit: degrees ? '°' : signal.unit,
            kind: signal.kind,
            offset: offset!,
            factor: degrees ? 180 / Math.PI : 1,
          };
        });
    });
}

/**
 * Render one responsive dual-axis plot with worker preparation and shared clock interactions.
 * @param props Active graph, sources, preparation service, and independent analysis-interval callbacks.
 * @returns Full-size graph; dragging zooms or selects an analysis interval, Shift-drag pans, and wheel zooms X.
 */
export function GraphView({
  tab,
  fields,
  runs,
  service,
  onProgress,
  intervalMode,
  onInterval,
  onToggle,
}: {
  tab: ViewTab;
  fields: Field[];
  runs: Run[];
  service: PreparationService | null;
  onProgress: (ids: string[], fraction: number, stage: string, error?: string) => void;
  intervalMode: boolean;
  onInterval: (range: [number, number]) => void;
  onToggle: (bindingId: string) => void;
}) {
  const playback = usePlayback();
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<uPlot | null>(null);
  const live = useRef({ playback, intervalMode, onInterval });
  live.current = { playback, intervalMode, onInterval };
  const [size, setSize] = useState({ width: 600, height: 400 });
  const [metrics, setMetrics] = useState({ left: 68, width: 500, top: 55, bottom: 62 });
  const [cache, setCache] = useState<{ key: string; indices: GraphIndex[] } | null>(null);
  const series = useMemo(() => graphSeries(tab, fields, runs, playback.offsets), [tab, fields, runs, playback.offsets]);
  const [start, end] = playback.window;
  // Presentation and clock changes never invalidate the selected source-channel index.
  const channelKey = JSON.stringify(series.map((item) => [item.bindingId, item.runId, item.signalId]));
  const selectedChannels = useMemo(
    () => series.map((item) => ({ runId: item.runId, signalId: item.signalId, bindingId: item.bindingId })),
    [channelKey],
  );
  const data = useMemo(
    () =>
      cache?.key === channelKey && series.length
        ? indexedPlot(runs, series, cache.indices, [start, end], size.width)
        : null,
    [cache, channelKey, runs, series, start, end, size.width],
  );
  const currentData = useRef(data);
  currentData.current = data;

  useEffect(() => {
    const element = host.current!;
    const observer = new ResizeObserver(() =>
      setSize({ width: Math.max(200, element.clientWidth), height: Math.max(180, element.clientHeight) }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!service || !selectedChannels.length) {
      setCache(null);
      return;
    }

    const controller = new AbortController();
    const fractions = selectedChannels.map(() => 0);
    const ids = [...new Set(selectedChannels.map((item) => item.bindingId))];
    onProgress(ids, 0, 'Loading graph channels');

    void Promise.all(
      selectedChannels.map((item, channel) =>
        service.graphIndex(
          runs.find((run) => run.id === item.runId)!,
          item.signalId,
          (fraction, stage) => {
            if (controller.signal.aborted) return;
            fractions[channel] = fraction;
            const components = selectedChannels.flatMap((other, index) =>
              other.bindingId === item.bindingId ? [fractions[index]] : [],
            );
            onProgress([item.bindingId], components.reduce((sum, value) => sum + value, 0) / components.length, stage);
          },
          controller.signal,
        ),
      ),
    )
      .then((indices) => {
        if (!controller.signal.aborted) {
          setCache({ key: channelKey, indices });
          onProgress(ids, 1, 'Ready');
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) onProgress(ids, 0, 'Failed', String(error));
      });

    return () => controller.abort();
  }, [service, selectedChannels, channelKey, runs, onProgress]);

  useEffect(() => {
    if (!host.current || !data || data.y.length !== series.length || !series.length) return;
    const theme = visualizationTheme(host.current);

    /**
     * Resolve independent manual/automatic axis limits, optionally including zero.
     *
     * @param lane Left or right graph scale.
     * @returns Finite axis limits resolved from exact visible extrema or explicit manual limits.
     */
    const axisRange = (lane: 'left' | 'right'): [number, number] => {
      const setting = lane === 'left' ? tab.leftAxis : tab.rightAxis;
      const range = setting.auto ? currentData.current!.ranges[lane] : ([setting.min, setting.max] as [number, number]);

      return setting.zero ? [Math.min(0, range[0]), Math.max(0, range[1])] : range;
    };
    /**
     * Read the unit family already validated when bindings entered this axis.
     *
     * @param lane Left or right graph scale.
     * @returns Display unit of its validated family, or an empty label when no series uses it.
     */
    const units = (lane: 'left' | 'right') => series.find((item) => item.lane === lane)?.unit ?? '';
    const plot = new uPlot(
      {
        width: size.width,
        height: size.height,
        legend: { show: false },
        select: { show: true, left: 0, top: 0, width: 0, height: 0 },
        cursor: { show: false, drag: { x: false, y: false, setScale: false } },
        scales: {
          x: { time: false, auto: false, min: start, max: end },
          left: { range: () => axisRange('left') },
          right: { range: () => axisRange('right') },
        },
        axes: [
          {
            stroke: theme.muted,
            font: `10px ${theme.mono}`,
            grid: { stroke: theme.grid, width: 0.5 },
            ticks: { stroke: theme.axis, width: 1, size: 6 },
            border: { show: true, stroke: theme.axis, width: 1 },
            // Keep uPlot's numeric precision at every zoom level, adding the time unit to each visible tick.
            values: (_plot, splits) => splits.map((value) => (value === null ? '' : `${uPlot.fmtNum(value)}s`)),
            size: 36,
          },
          {
            scale: 'left',
            stroke: theme.muted,
            font: `10px ${theme.mono}`,
            labelFont: `11px ${theme.mono}`,
            grid: { stroke: theme.grid, width: 0.5 },
            ticks: { stroke: theme.axis, width: 1, size: 6 },
            border: { show: true, stroke: theme.axis, width: 1 },
            label: units('left'),
            labelSize: 23,
            size: 60,
          },
          {
            scale: 'right',
            side: 1,
            stroke: theme.muted,
            font: `10px ${theme.mono}`,
            labelFont: `11px ${theme.mono}`,
            grid: { show: false },
            ticks: { stroke: theme.axis, width: 1, size: 6 },
            border: { show: true, stroke: theme.axis, width: 1 },
            label: units('right'),
            labelSize: 23,
            size: 60,
            show: series.some((item) => item.lane === 'right'),
          },
        ],
        series: [
          {},
          ...series.map((item, index) => ({
            label: item.label,
            scale: item.lane,
            stroke: item.color,
            // A half-pixel step produces finer graph strokes while retaining adjustable per-field weights.
            width: item.width / 2,
            dash: item.style === 'dashed' ? [8, 5] : item.style === 'dotted' ? [2, 4] : [],
            paths:
              item.kind === 'event'
                ? () => null
                : item.kind === 'held'
                  ? uPlot.paths.stepped!({ align: 1 })
                  : undefined,
            points: { show: item.markers || item.kind === 'event', size: 5, fill: item.color },
            // Component dashes distinguish channels in aggregate fields without changing their configured color.
            ...(item.style === 'solid' && series.some((other, i) => i < index && other.bindingId === item.bindingId)
              ? { dash: index % 2 ? [8, 4] : [2, 4] }
              : {}),
          })),
        ],
      },
      [data.x, ...data.y] as uPlot.AlignedData,
      host.current,
    );
    chart.current = plot;
    // uPlot completes layout in a queued task; measure after paint so cursor geometry uses the real plot rectangle.
    const measure = requestAnimationFrame(() => {
      const rectangle = plot.over.getBoundingClientRect();
      const container = host.current!.parentElement!.getBoundingClientRect();
      setMetrics({
        left: rectangle.left - container.left,
        width: rectangle.width,
        top: rectangle.top - container.top,
        bottom: container.bottom - rectangle.bottom,
      });
    });
    const overlay = plot.over;
    let gesture: { x: number; time: number; window: [number, number]; pan: boolean } | null = null;

    /**
     * Locate a pointer horizontally within the graph's plotting area.
     * @param event Pointer client coordinate in CSS pixels.
     * @returns Clamped position from zero at the left time-axis edge to one at the right edge.
     */
    const pointerFraction = (event: { clientX: number }) => {
      const box = overlay.getBoundingClientRect();
      return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width));
    };

    /**
     * Convert a pointer position into displayed seconds using the current plot scale.
     *
     * @param event Pointer client coordinate in CSS pixels.
     * @returns Displayed simulation seconds using the current plot scale.
     */
    const pointerTime = (event: { clientX: number }) =>
      plot.posToVal(event.clientX - overlay.getBoundingClientRect().left, 'x');
    /**
     * Begin a graph navigation gesture.
     *
     * @param event Primary pointer press on the graph overlay.
     * @returns Nothing; records the gesture origin and captures the pointer for seek/zoom/pan.
     */
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      gesture = {
        x: event.clientX,
        time: pointerTime(event),
        window: [...live.current.playback.window],
        pan: event.shiftKey,
      };
      overlay.setPointerCapture(event.pointerId);
      // Keep hover feedback while panning; box selection temporarily replaces the hover cursor.
      live.current.playback.hover(event.shiftKey ? pointerTime(event) : null);
    };
    /**
     * Apply a captured pointer movement.
     *
     * @param event Current captured-pointer position in CSS pixels.
     * @returns Nothing; updates drag feedback or panel dimensions, or previews time when not dragging.
     */
    const move = (event: PointerEvent) => {
      if (gesture?.pan) {
        const delta = ((gesture.x - event.clientX) / overlay.clientWidth) * (gesture.window[1] - gesture.window[0]);
        live.current.playback.setWindow([gesture.window[0] + delta, gesture.window[1] + delta], pointerFraction(event));
      } else if (!gesture) live.current.playback.hover(pointerTime(event));
      if (gesture && !gesture.pan) {
        plot.setSelect(
          {
            left: Math.min(gesture.x, event.clientX) - overlay.getBoundingClientRect().left,
            top: 0,
            width: Math.abs(event.clientX - gesture.x),
            height: overlay.clientHeight,
          },
          false,
        );
        plot.root.classList.add('selecting');
      }
    };
    /**
     * Complete one graph gesture without converting a drag to a seek.
     *
     * @param event Pointer release after a graph gesture.
     * @returns Nothing; commits a click seek, time zoom/pan, or independent analysis interval.
     */
    const up = (event: PointerEvent) => {
      if (!gesture) return;

      const saved = gesture;
      gesture = null;
      plot.root.classList.remove('selecting');
      plot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
      if (Math.abs(saved.x - event.clientX) < 4) live.current.playback.seek(pointerTime(event));
      else if (saved.pan) {
        const delta = ((saved.x - event.clientX) / overlay.clientWidth) * (saved.window[1] - saved.window[0]);
        live.current.playback.setWindow([saved.window[0] + delta, saved.window[1] + delta], pointerFraction(event));
      } else {
        const range = [Math.min(saved.time, pointerTime(event)), Math.max(saved.time, pointerTime(event))] as [
          number,
          number,
        ];

        if (live.current.intervalMode) live.current.onInterval(range);
        else live.current.playback.setWindow(range, pointerFraction(event));
      }
    };
    /**
     * Restore committed time when the pointer leaves the graph.
     *
     * @returns Nothing; clears the transient global hover preview.
     */
    const leave = () => live.current.playback.hover(null);
    /**
     * Navigate the shared time window from wheel or pinch input.
     *
     * @param event Wheel/pinch event with client position and scroll deltas.
     * @returns Nothing; zooms around pointer time or pans the shared time window without seeking.
     */
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        live.current.playback.pan(
          ((event.deltaX || event.deltaY) / overlay.clientWidth) *
            (live.current.playback.window[1] - live.current.playback.window[0]),
          pointerFraction(event),
        );
      } else live.current.playback.zoom(Math.exp(event.deltaY * 0.002), pointerTime(event));
    };
    /**
     * Clear an interrupted drag so subsequent hover resumes without committing a seek or zoom.
     * @returns Nothing; removes selection feedback and clears transient preview.
     */
    const cancelGesture = () => {
      gesture = null;
      plot.root.classList.remove('selecting');
      plot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
      leave();
    };

    overlay.addEventListener('pointerdown', down);
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
    overlay.addEventListener('pointercancel', cancelGesture);
    overlay.addEventListener('pointerleave', leave);
    overlay.addEventListener('wheel', wheel, { passive: false });
    return () => {
      overlay.removeEventListener('pointerdown', down);
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      overlay.removeEventListener('pointercancel', cancelGesture);
      overlay.removeEventListener('pointerleave', leave);
      overlay.removeEventListener('wheel', wheel);
      cancelAnimationFrame(measure);
      plot.destroy();
      chart.current = null;
    };
  }, [cache, series, tab.leftAxis, tab.rightAxis, size]);

  // Keep the canvas, pointer listeners, and navigation gesture alive during zooming. Only its data/scales change.
  useEffect(() => {
    const plot = chart.current;
    if (!plot || !data || data.y.length !== series.length) return;
    plot.batch(() => {
      plot.setData([data.x, ...data.y] as uPlot.AlignedData, false);
      plot.setScale('x', { min: start, max: end });
      for (const lane of ['left', 'right'] as const) {
        const setting = lane === 'left' ? tab.leftAxis : tab.rightAxis;
        const range = setting.auto ? data.ranges[lane] : [setting.min, setting.max];
        plot.setScale(lane, {
          min: setting.zero ? Math.min(0, range[0]) : range[0],
          max: setting.zero ? Math.max(0, range[1]) : range[1],
        });
      }
    });
  }, [data, start, end, series, tab.leftAxis, tab.rightAxis]);

  // A running hover shows pointer time independently; plotted telemetry and the committed cursor follow the clock.
  const previewLeft =
    playback.preview === null ? 0 : metrics.left + ((playback.preview - start) / (end - start)) * metrics.width;
  const committedLeft = metrics.left + ((playback.time - start) / (end - start)) * metrics.width;

  return (
    <div className="graph-view" data-testid="graph-view">
      <div className="graph-legend">
        {series.map((item) => (
          <button
            className="legend-series flat"
            key={`${item.bindingId}:${item.signalId}`}
            title={item.label}
            aria-label={`Hide ${item.label}`}
            aria-pressed={true}
            onClick={() => onToggle(item.bindingId)}
          >
            <i style={{ background: item.color }} />
            {item.label.split(' · ')[0]}{' '}
            <small>
              {item.lane === 'left' ? 'L' : 'R'} · {item.unit || '1'}
            </small>
          </button>
        ))}
        {tab.bindings
          .filter((binding) => !binding.visible)
          .map((binding) => (
            <button
              className="legend-series flat hidden-series"
              key={binding.id}
              aria-label={`Show ${binding.label}`}
              aria-pressed={false}
              onClick={() => onToggle(binding.id)}
            >
              <i style={{ background: binding.color }} />
              {binding.label}
            </button>
          ))}
      </div>
      <div className="graph-canvas" ref={host} />
      {!!data && playback.time >= start && playback.time <= end && (
        <div
          className={`graph-time-cursor ${playback.preview !== null ? 'committed' : ''}`}
          style={{ left: committedLeft, top: metrics.top, bottom: metrics.bottom }}
        >
          {(playback.playing || playback.preview === null) && <span>{playback.time.toFixed(3)} s</span>}
        </div>
      )}
      {!!data && playback.preview !== null && playback.preview >= start && playback.preview <= end && (
        <div
          className="graph-time-cursor preview"
          style={{ left: previewLeft, top: metrics.top, bottom: metrics.bottom }}
        >
          <span>{playback.preview.toFixed(3)} s</span>
        </div>
      )}
      {!series.length && <div className="empty-view">Drop fields into Left Y axis or Right Y axis.</div>}
      {!!series.length && (!data || data.y.length !== series.length) && (
        <div className="empty-view">Preparing graph…</div>
      )}
      <output className="axis-ranges" data-testid="axis-ranges" aria-label="Visible axis bounds">
        {data
          ? `L ${data.ranges.left.map((value) => value.toFixed(3)).join(' … ')} · R ${data.ranges.right.map((value) => value.toFixed(3)).join(' … ')}`
          : ''}
      </output>
    </div>
  );
}
