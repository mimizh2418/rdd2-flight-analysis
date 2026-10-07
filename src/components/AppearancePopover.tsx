import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Open a field's appearance controls outside the dock's clipped, independently scrolling lanes.
 *
 * @param props Accessible field name, current appearance icon, and configuration controls.
 * @returns An icon button and, while open, a viewport-positioned nonmodal dialog.
 * @remarks Escape restores focus to the button; outside pointer presses dismiss without taking focus back.
 */
export function AppearancePopover({ label, icon, children }: { label: string; icon: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return;

    /**
     * Fit the menu above its button when possible, otherwise below, staying inside the viewport.
     * @returns Nothing; updates fixed coordinates without changing the dock or visualization dimensions.
     */
    const place = () => {
      const anchor = button.current!.getBoundingClientRect();
      const menu = panel.current!.getBoundingClientRect();
      const above = anchor.top - menu.height - 6;
      const preferred = above >= 8 ? above : anchor.bottom + 6;

      setPosition({
        top: Math.max(8, Math.min(preferred, innerHeight - menu.height - 8)),
        left: Math.max(8, Math.min(anchor.left, innerWidth - menu.width - 8)),
      });
    };

    /**
     * Close on an outside pointer press while letting configuration controls and the trigger receive events.
     * @param event Document pointer press, potentially outside this portal.
     * @returns Nothing; leaves the clicked element's normal focus behavior intact.
     */
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) setOpen(false);
    };

    /**
     * Return keyboard users to the appearance button when they dismiss the dialog.
     * @param event Document key press while the popup is open.
     * @returns Nothing; consumes Escape and restores trigger focus.
     */
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      button.current?.focus();
    };

    place();
    panel.current?.querySelector<HTMLElement>('button,select,input')?.focus();

    const observer = new ResizeObserver(place);
    observer.observe(panel.current!);
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        className="binding-appearance flat"
        aria-label={`Appearance ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={`Appearance · ${label}`}
        onClick={() => setOpen(!open)}
      >
        {icon}
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            className="appearance-popover"
            role="dialog"
            aria-label={`Appearance settings for ${label}`}
            style={position}
          >
            <div className="appearance-title">{label}</div>
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
