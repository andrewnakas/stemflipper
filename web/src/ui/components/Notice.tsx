import type { ComponentChildren } from "preact";

/** An inline message block: the error panel, the honesty note, quota warnings. */
export function Notice(props: {
  tone?: "info" | "warn" | "error";
  title?: ComponentChildren;
  children?: ComponentChildren;
  actions?: ComponentChildren;
  role?: "alert" | "status";
}) {
  return (
    <div
      class={"notice" + (props.tone ? ` notice--${props.tone}` : "")}
      role={props.role || (props.tone === "error" ? "alert" : undefined)}
    >
      {props.title ? <div class="notice__title">{props.title}</div> : null}
      {props.children ? <div class="small soft">{props.children}</div> : null}
      {props.actions ? <div class="notice__actions">{props.actions}</div> : null}
    </div>
  );
}
