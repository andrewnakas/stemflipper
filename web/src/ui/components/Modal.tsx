import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { Button } from "./primitives";

/** A focus-trapping-lite dialog: Escape and backdrop close it, body scroll is locked. */
export function Modal(props: {
  title: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
    };
  }, [props.onClose]);

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div class="modal__head">
          <h3 style={{ flex: 1 }}>{props.title}</h3>
          <Button variant="ghost" size="sm" aria-label="close" onClick={props.onClose}>×</Button>
        </div>
        {props.children}
        {props.footer ? <div class="notice__actions">{props.footer}</div> : null}
      </div>
    </div>
  );
}
