import type { ComponentChildren } from "preact";

/** A <details> styled to match, used for "Change preset" and "Advanced". */
export function Disclosure(props: {
  summary: ComponentChildren;
  children: ComponentChildren;
  open?: boolean;
  id?: string;
}) {
  return (
    <details class="disclosure" open={props.open} id={props.id}>
      <summary class="disclosure__summary">
        <span class="disclosure__chevron" aria-hidden="true">›</span>
        {props.summary}
      </summary>
      <div class="disclosure__body">{props.children}</div>
    </details>
  );
}
