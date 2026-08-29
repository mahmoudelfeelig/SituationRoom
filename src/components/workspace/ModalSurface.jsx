import { useEffect, useId, useRef } from "react";
import { IconX } from "@tabler/icons-react";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function ModalSurface({ open, title, eyebrow, onClose, closeDisabled = false, size = "medium", children, footer }) {
  const titleId = useId();
  const panelRef = useRef(null);
  const closeRef = useRef(onClose);
  const closeDisabledRef = useRef(closeDisabled);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closeDisabledRef.current = closeDisabled;
  }, [closeDisabled]);

  useEffect(() => {
    if (!open) return undefined;
    const prior = document.activeElement;
    const panel = panelRef.current;
    const focusables = () => [...(panel?.querySelectorAll(FOCUSABLE) ?? [])];
    requestAnimationFrame(() => (focusables()[0] ?? panel)?.focus());
    const handleKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!closeDisabledRef.current) closeRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        event.preventDefault();
        panel?.focus();
        return;
      }
      const first = items[0];
      const last = items.at(-1);
      if (!panel?.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const handleFocus = (event) => {
      if (panel && !panel.contains(event.target)) (focusables()[0] ?? panel).focus();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("focusin", handleFocus);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("focusin", handleFocus);
      prior?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="os-modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !closeDisabled) onClose?.();
    }}>
      <section
        className={`os-modal os-modal--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={panelRef}
        tabIndex="-1"
      >
        <header className="os-modal__header">
          <div>
            {eyebrow ? <span className="os-eyebrow">{eyebrow}</span> : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          {typeof onClose === "function" ? (
            <button type="button" className="os-icon-button" disabled={closeDisabled} onClick={onClose} aria-label={`Close ${title}`}>
              <IconX size={21} />
            </button>
          ) : null}
        </header>
        <div className="os-modal__body">{children}</div>
        {footer ? <footer className="os-modal__footer">{footer}</footer> : null}
      </section>
    </div>
  );
}
