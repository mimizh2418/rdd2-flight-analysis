import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Run } from '../data/types';
import { adjacentSample, alignmentOffset } from './time';

export interface Playback {
  time: number;
  /** Pointer timestamp for a separate hover cursor; affects telemetry only while paused. */
  preview: number | null;
  effectiveTime: number;
  playing: boolean;
  speed: number;
  loop: boolean;
  autoScroll: boolean;
  alignment: string;
  offsets: Map<string, number>;
  domain: [number, number];
  window: [number, number];
  seek: (time: number) => void;
  hover: (time: number | null) => void;
  setPlaying: (playing: boolean) => void;
  setSpeed: (speed: number) => void;
  setLoop: (loop: boolean) => void;
  setAutoScroll: (enabled: boolean) => void;
  setAlignment: (alignment: string) => void;
  setWindow: (window: [number, number], previewFraction?: number) => void;
  zoom: (factor: number, anchor?: number) => void;
  pan: (seconds: number, previewFraction?: number) => void;
  fit: (common?: boolean) => void;
  step: (direction: number, run?: Run) => void;
}

const PlaybackContext = createContext<Playback | null>(null);

/**
 * Clip a visible time interval to the workspace coverage without changing its zoom unnecessarily.
 * @param range Requested displayed interval.
 * @param domain Global union coverage.
 * @returns Positive bounded interval, preserving span when possible.
 */
export function clampWindow(range: [number, number], domain: [number, number]): [number, number] {
  const length = Math.min(domain[1] - domain[0], Math.max(0.000001, range[1] - range[0]));
  const start = Math.max(domain[0], Math.min(domain[1] - length, range[0]));

  return [start, start + length];
}

/**
 * Own one clock and visible time window for every view and field-browser readout.
 * @param props Runs plus initial restored settings and child components.
 * @returns Context provider. Paused hover is transient; commits always pause and clear the preview.
 */
export function PlaybackProvider({
  runs,
  initial,
  children,
}: {
  runs: Run[];
  initial?: { time: number; window: [number, number]; alignment: string; runs?: unknown[] };
  children: ReactNode;
}) {
  const [time, updateTime] = useState(initial?.time ?? 0);
  const [preview, updatePreview] = useState<number | null>(null);
  const [playing, updatePlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [alignment, updateAlignment] = useState(initial?.alignment ?? 'absolute');
  const offsets = useMemo(
    () => new Map(runs.map((run) => [run.id, alignmentOffset(run, alignment)])),
    [runs, alignment],
  );
  const domain = useMemo<[number, number]>(() => {
    const ranges = runs
      .filter((run) => Number.isFinite(offsets.get(run.id)))
      .map((run) => [
        run.time[run.index[0]] - offsets.get(run.id)!,
        run.time[run.index[run.index.length - 1]] - offsets.get(run.id)!,
      ]);

    if (!ranges.length) return [0, 1];

    const start = Math.min(...ranges.map((range) => range[0]));

    return [start, Math.max(start + 0.000001, ...ranges.map((range) => range[1]))];
  }, [runs, offsets]);
  const [window, updateWindow] = useState<[number, number]>(() => clampWindow(initial?.window ?? domain, domain));
  const hasSources = runs.some((run) => Number.isFinite(offsets.get(run.id)));
  const live = useRef({ time, window, domain, speed, loop, autoScroll, playing, hasSources });
  live.current = { time, window, domain, speed, loop, autoScroll, playing, hasSources };

  const previousAlignment = useRef(alignment);
  const previousSources = useRef(hasSources);
  useEffect(() => {
    // The first imported log supplies the real clock. An empty registry must not preserve a fabricated 0–1 window.
    if (!previousSources.current && hasSources) {
      updateWindow(initial && initial.runs?.length !== 0 ? clampWindow(initial.window, domain) : domain);
      updateTime(
        initial && initial.runs?.length !== 0 ? Math.max(domain[0], Math.min(domain[1], initial.time)) : domain[0],
      );
    }
    previousSources.current = hasSources;
    if (!hasSources) updatePlaying(false);
    if (previousAlignment.current !== alignment) {
      updateWindow(domain);
      previousAlignment.current = alignment;
    }
    updateTime((value) => Math.max(domain[0], Math.min(domain[1], value)));
    updateWindow((current) => clampWindow(current, domain));
    updatePreview(null);
  }, [domain, alignment, hasSources]);

  /**
   * Commit a displayed time and reveal its cursor in a zoomed window.
   * @param requested Displayed seconds; non-finite requests are ignored.
   * @returns Nothing; pauses playback and clears any uncommitted hover.
   */
  const seek = useCallback((requested: number) => {
    if (!Number.isFinite(requested)) return;

    const state = live.current;
    const target = Math.max(state.domain[0], Math.min(state.domain[1], requested));
    updatePlaying(false);
    updatePreview(null);
    updateTime(target);

    if (target < state.window[0] || target > state.window[1]) {
      const span = state.window[1] - state.window[0];
      updateWindow(clampWindow([target - span / 2, target + span / 2], state.domain));
    }
  }, []);

  /**
   * Track pointer time for the hover cursor without changing the playback clock.
   * @param value Displayed seconds, or null on pointer leave.
   * @returns Nothing; clamps to coverage. Only paused playback uses this time for telemetry and poses.
   */
  const hover = useCallback((value: number | null) => {
    const state = live.current;
    updatePreview(
      value !== null && Number.isFinite(value) ? Math.max(state.domain[0], Math.min(state.domain[1], value)) : null,
    );
  }, []);

  /**
   * Change transport state without accidentally committing a hover preview.
   * @param enabled Whether playback should run.
   * @returns Nothing; restarting at the end begins at the coverage start.
   */
  const setPlaying = useCallback((enabled: boolean) => {
    if (enabled && live.current.time >= live.current.domain[1]) updateTime(live.current.domain[0]);
    updatePlaying(enabled && live.current.hasSources);
  }, []);

  /**
   * Apply a time-window change independently of cursor/transport state.
   * @param range Requested visible displayed seconds.
   * @param previewFraction Optional pointer position from zero (left) to one (right); preserves the current
   *   preview's position when omitted, and shows a hover cursor when explicitly supplied.
   * @returns Nothing; invalid or reversed intervals are ignored.
   */
  const setWindow = useCallback((range: [number, number], previewFraction?: number) => {
    if (!range.every(Number.isFinite) || range[1] <= range[0]) return;

    const state = live.current;
    const previous = state.window;
    const next = clampWindow(range, state.domain);

    updateWindow(next);
    updatePreview((current) => {
      // Remap the hover in the clamped window so panning and boundary-limited zoom keep it under the pointer.
      const fraction =
        previewFraction ?? (current === null ? null : (current - previous[0]) / (previous[1] - previous[0]));
      if (fraction === null || !Number.isFinite(fraction)) return null;

      return next[0] + Math.max(0, Math.min(1, fraction)) * (next[1] - next[0]);
    });
  }, []);

  /**
   * Zoom the shared time window around a fixed pointer time.
   * @param factor Span multiplier; less than one zooms in.
   * @param anchor Displayed seconds kept under the pointer, defaulting to window center.
   * @returns Nothing; the committed clock is unaffected.
   */
  const zoom = useCallback(
    (factor: number, anchor?: number) => {
      const state = live.current;
      const center = anchor ?? (state.window[0] + state.window[1]) / 2;
      const fraction =
        anchor === undefined ? undefined : (anchor - state.window[0]) / (state.window[1] - state.window[0]);

      setWindow([center + (state.window[0] - center) * factor, center + (state.window[1] - center) * factor], fraction);
    },
    [setWindow],
  );

  /**
   * Pan the shared visible interval.
   * @param seconds Displayed-time displacement.
   * @param previewFraction Optional pointer position within the viewport, used to refresh the hover cursor.
   * @returns Nothing; clamps at coverage boundaries without seeking.
   */
  const pan = useCallback(
    (seconds: number, previewFraction?: number) =>
      setWindow([live.current.window[0] + seconds, live.current.window[1] + seconds], previewFraction),
    [setWindow],
  );

  /**
   * Fit union or explicit common coverage across aligned runs.
   * @param common Intersect aligned ranges when true; otherwise use the union.
   * @returns Nothing; an empty common range leaves the existing window unchanged.
   */
  const fit = useCallback(
    (common = false) => {
      if (!common) {
        setWindow(domain);
        return;
      }

      const aligned = runs.filter((run) => Number.isFinite(offsets.get(run.id)));

      if (!aligned.length) return;
      setWindow([
        Math.max(...aligned.map((run) => run.time[run.index[0]] - offsets.get(run.id)!)),
        Math.min(...aligned.map((run) => run.time[run.index[run.index.length - 1]] - offsets.get(run.id)!)),
      ]);
    },
    [domain, offsets, runs, setWindow],
  );

  /**
   * Step between source event representatives using that run's alignment.
   * @param direction Negative goes backward, positive goes forward.
   * @param run Preferred source; defaults to the first aligned run.
   * @returns Nothing; commits a clamped neighboring sample and pauses.
   */
  const step = useCallback(
    (direction: number, run?: Run) => {
      const source = run ?? runs.find((item) => Number.isFinite(offsets.get(item.id)));
      const offset = source ? offsets.get(source.id)! : NaN;

      if (source && Number.isFinite(offset))
        seek(adjacentSample(source, live.current.time + offset, direction) - offset);
    },
    [runs, offsets, seek],
  );

  /**
   * Choose an alignment basis explicitly, discarding the old zoom coordinates.
   * @param mode Absolute, armed, or mission alignment.
   * @returns Nothing; pauses, clears preview, and resets the visible interval after offsets update.
   */
  const setAlignment = useCallback((mode: string) => {
    updatePlaying(false);
    updatePreview(null);
    updateAlignment(mode);
  }, []);

  useEffect(() => {
    if (!playing) return;

    let frame = 0;
    let previous = performance.now();

    /**
     * Advance the global simulation clock according to elapsed wall time.
     * @param now Animation timestamp in milliseconds.
     * @returns Nothing; reschedules until the effect is cleaned up.
     */
    const tick = (now: number) => {
      const state = live.current;
      let next = state.time + ((now - previous) / 1000) * state.speed;
      previous = now;

      if (next > state.domain[1]) {
        if (state.loop) next = state.domain[0] + ((next - state.domain[0]) % (state.domain[1] - state.domain[0]));
        else {
          next = state.domain[1];
          updatePlaying(false);
        }
      }
      live.current.time = next;
      updateTime(next);

      if (state.autoScroll) {
        const span = state.window[1] - state.window[0];
        const followStart = next - span * 0.9;

        // Once the cursor reaches 90% of the view, follow it every frame rather than waiting for it to exit.
        // A loop wrap also reveals the clock at the beginning of the log.
        if (next < state.window[0] || followStart > state.window[0]) {
          const following = clampWindow([followStart, followStart + span], state.domain);

          // Stop moving at coverage boundaries. Avoid redrawing an unchanged full-range or end-of-log window.
          if (following[0] !== state.window[0] || following[1] !== state.window[1]) {
            // Preserve a stationary pointer's hover in the same screen position as the window moves.
            setWindow(following);
          }
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, setWindow]);

  useEffect(() => {
    /**
     * Apply global playback shortcuts unless focus belongs to an interactive editor.
     * @param event Document key press; Space toggles playback and arrows step event representatives.
     * @returns Nothing; consumes handled keys and leaves text input behavior intact.
     */
    const keyboard = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input,select,textarea,button,summary,[contenteditable=true]')) return;
      if (event.code === 'Space') {
        event.preventDefault();
        setPlaying(!live.current.playing);
      }
      if (event.code === 'ArrowLeft') {
        event.preventDefault();
        step(-1);
      }
      if (event.code === 'ArrowRight') {
        event.preventDefault();
        step(1);
      }
    };
    document.addEventListener('keydown', keyboard);
    return () => document.removeEventListener('keydown', keyboard);
  }, [step, setPlaying]);

  const value: Playback = {
    time,
    preview,
    effectiveTime: !playing && preview !== null ? preview : time,
    playing,
    speed,
    loop,
    autoScroll,
    alignment,
    offsets,
    domain,
    window,
    seek,
    hover,
    setPlaying,
    setSpeed,
    setLoop,
    setAutoScroll,
    setAlignment,
    setWindow,
    zoom,
    pan,
    fit,
    step,
  };

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

/**
 * Read the shared clock from a visualization or transport component.
 * @returns Current playback state and stable interaction methods.
 * @throws Error if called outside the workspace provider.
 */
export function usePlayback(): Playback {
  const context = useContext(PlaybackContext);

  if (!context) throw new Error('PlaybackProvider is missing.');
  return context;
}
