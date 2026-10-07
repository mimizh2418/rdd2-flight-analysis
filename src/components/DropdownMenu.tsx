import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Give floating command and settings menus consistent dismissal behavior.
 * @param props Trigger content/labels, popup contents, styling, and optional context/command-selection behavior.
 * @returns A native details trigger and popup that close on outside pointer presses and Escape.
 * @remarks Outside presses retain their normal action; Escape restores trigger focus. Context changes close
 *   the popup, and closeOnSelect dismisses command menus after a button action without closing settings controls.
 */
export function DropdownMenu({
  summary,
  children,
  className = '',
  summaryClassName,
  label,
  title,
  contextKey,
  closeOnSelect = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  summaryClassName?: string;
  label?: string;
  title?: string;
  contextKey?: string;
  closeOnSelect?: boolean;
}) {
  const menu = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (menu.current) menu.current.open = false;
  }, [contextKey]);

  useEffect(() => {
    /**
     * Dismiss on outside pointer presses without consuming the click or moving focus back to the trigger.
     * @param event Document pointer press, including another menu's trigger.
     * @returns Nothing; clicks within this menu remain uninterrupted.
     */
    const dismiss = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false;
    };

    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, []);

  return (
    <details
      className={`menu ${className}`}
      ref={menu}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && event.currentTarget.open) {
          event.preventDefault();
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
    >
      <summary className={summaryClassName} aria-label={label} title={title}>
        {summary}
      </summary>
      <div
        onClick={(event) => {
          // Command buttons close the popup after their own handlers run; settings inputs keep it open.
          if (closeOnSelect && event.target instanceof Element && event.target.closest('button')) {
            if (menu.current) menu.current.open = false;
          }
        }}
      >
        {children}
      </div>
    </details>
  );
}
