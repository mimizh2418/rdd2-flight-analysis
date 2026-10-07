import { useEffect, useRef, useState } from 'react';
import { usePlayback } from '../playback/PlaybackProvider';
import { timeTicks } from '../playback/ticks';

/**
 * Render a zoomable timeline above either 3D view using the same global clock as graph cursors.
 * @returns Accessible time slider with a hover cursor, paused data preview, click seek, wheel zoom, and drag pan.
 */
export function TimeStrip() {
  const playback = usePlayback();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const ticks = timeTicks(playback.window, width);
  const live = useRef(playback);
  live.current = playback;
  const gesture = useRef<{ x: number; time: number; window: [number, number]; moved: boolean } | null>(null);
  const span = playback.window[1] - playback.window[0];
  /**
   * Locate a timestamp within the visible timeline.
   *
   * @param time Displayed simulation seconds within or outside the zoom window.
   * @returns Clipped horizontal percentage from zero to one hundred.
   */
  const percent = (time: number) => Math.max(0, Math.min(100, ((time - playback.window[0]) / span) * 100));

  /**
   * Locate a pointer horizontally within the timeline.
   * @param x Pointer client X in viewport pixels.
   * @returns Clamped position from zero at the left edge to one at the right edge.
   */
  const pointerFraction = (x: number) => {
    const box = host.current!.getBoundingClientRect();

    return Math.max(0, Math.min(1, (x - box.left) / box.width));
  };

  /**
   * Convert a pointer coordinate to displayed time inside the visible strip.
   * @param x Pointer client X in viewport pixels.
   * @returns Displayed simulation seconds.
   */
  const pointerTime = (x: number) => {
    return live.current.window[0] + pointerFraction(x) * (live.current.window[1] - live.current.window[0]);
  };

  useEffect(() => {
    const element = host.current!;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    /**
     * Navigate the shared time window from wheel or pinch input.
     *
     * @param event Wheel/pinch event with client position and scroll deltas.
     * @returns Nothing; zooms around pointer time or pans the shared time window without seeking.
     */
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        live.current.pan(
          ((event.deltaX || event.deltaY) / element.clientWidth) * (live.current.window[1] - live.current.window[0]),
          pointerFraction(event.clientX),
        );
      } else live.current.zoom(Math.exp(Math.max(-2, Math.min(2, event.deltaY * 0.002))), pointerTime(event.clientX));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
    };
  }, []);

  return (
    <div
      className="time-strip"
      ref={host}
      role="slider"
      tabIndex={0}
      aria-label="Timeline"
      aria-valuemin={playback.window[0]}
      aria-valuemax={playback.window[1]}
      aria-valuenow={playback.time}
      aria-valuetext={`${playback.time.toFixed(3)} seconds`}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          playback.step(event.key === 'ArrowLeft' ? -1 : 1);
        }
        if (event.key === 'Home') playback.seek(playback.domain[0]);
        if (event.key === 'End') playback.seek(playback.domain[1]);
        if (event.key === '+' || event.key === '=') playback.zoom(0.5);
        if (event.key === '-') playback.zoom(2);
      }}
      onPointerDown={(event) => {
        gesture.current = {
          x: event.clientX,
          time: pointerTime(event.clientX),
          window: [...playback.window],
          moved: false,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = gesture.current;

        if (start && Math.abs(event.clientX - start.x) > 4) {
          start.moved = true;
          const delta = ((start.x - event.clientX) / host.current!.clientWidth) * (start.window[1] - start.window[0]);
          playback.setWindow([start.window[0] + delta, start.window[1] + delta], pointerFraction(event.clientX));
        } else if (!start) playback.hover(pointerTime(event.clientX));
      }}
      onPointerUp={(event) => {
        const start = gesture.current;
        gesture.current = null;
        if (start && !start.moved) playback.seek(start.time);
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        gesture.current = null;
        playback.hover(null);
      }}
      onPointerLeave={() => playback.hover(null)}
    >
      <div className="time-track" />
      <div className="time-fill" style={{ width: `${percent(playback.time)}%` }} />
      <div className="time-cursor committed" style={{ left: `${percent(playback.time)}%` }}>
        <span>{playback.time.toFixed(3)}</span>
      </div>
      {playback.preview !== null && (
        <div className="time-cursor preview" style={{ left: `${percent(playback.preview)}%` }}>
          <span>{playback.preview.toFixed(3)}</span>
        </div>
      )}
      <div className="time-ticks">
        {ticks.map((tick) => (
          <div
            key={tick.time}
            className={`time-tick ${tick.major ? 'major' : 'minor'}`}
            style={{ left: `${percent(tick.time)}%` }}
          >
            {tick.major && (
              <span
                style={{
                  transform:
                    percent(tick.time) < 5
                      ? 'none'
                      : percent(tick.time) > 95
                        ? 'translateX(-100%)'
                        : 'translateX(-50%)',
                }}
              >
                {tick.label}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Place shared playback controls on the visualization-tab row, independent of the timeline.
 * @param props Disable transport until an imported log provides a real playback clock.
 * @returns Current timestamp, play/pause, and speed controls; seeking uses the timeline or graph.
 */
export function TransportControls({ disabled = false }: { disabled?: boolean }) {
  const playback = usePlayback();

  return (
    <div className="transport">
      <output className="mono" data-testid="playback-time">
        {playback.time.toFixed(3)} <small>s</small>
      </output>
      <button
        className="play"
        disabled={disabled}
        aria-label={playback.playing ? 'Pause' : 'Play'}
        onClick={() => playback.setPlaying(!playback.playing)}
      >
        {playback.playing ? 'Ⅱ' : '▶'}
      </button>
      <select
        aria-label="Playback speed"
        value={playback.speed}
        onChange={(event) => playback.setSpeed(Number(event.target.value))}
      >
        {[0.1, 0.25, 0.5, 1, 2, 4, 10].map((speed) => (
          <option key={speed} value={speed}>
            {speed}×
          </option>
        ))}
      </select>
    </div>
  );
}
