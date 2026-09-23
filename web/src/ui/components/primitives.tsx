/** Small presentational building blocks. Anything with its own state lives in its own file. */

import type { ComponentChildren, JSX } from "preact";

type Variant = "default" | "primary" | "ghost" | "danger";
type Size = "sm" | "md" | "lg" | "icon";

interface ButtonProps extends Omit<JSX.IntrinsicElements["button"], "size" | "ref"> {
  variant?: Variant;
  size?: Size;
  on?: boolean;
  block?: boolean;
  /** Render as a link instead of a button (same styling). */
  href?: string;
  download?: string | boolean;
  target?: string;
  rel?: string;
}

function btnClass(p: ButtonProps): string {
  return [
    "btn",
    p.variant && p.variant !== "default" ? `btn--${p.variant}` : "",
    p.size && p.size !== "md" ? `btn--${p.size}` : "",
    p.on ? "btn--on" : "",
    p.block ? "btn--block" : "",
    p.class || "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({ variant, size, on, block, href, children, ...rest }: ButtonProps) {
  const cls = btnClass({ variant, size, on, block, class: rest.class as string });
  if (href !== undefined) {
    const { class: _c, ...linkRest } = rest as Record<string, unknown>;
    return (
      <a href={href} class={cls} {...(linkRest as JSX.HTMLAttributes<HTMLAnchorElement>)}>
        {children}
      </a>
    );
  }
  const { class: _c, ...btnRest } = rest as Record<string, unknown>;
  return (
    <button type="button" class={cls} {...(btnRest as JSX.HTMLAttributes<HTMLButtonElement>)}>
      {children}
    </button>
  );
}

export function Card(props: { title?: ComponentChildren; quiet?: boolean; flat?: boolean; class?: string; style?: JSX.CSSProperties; children: ComponentChildren }) {
  return (
    <div
      class={["card", props.quiet ? "card--quiet" : "", props.flat ? "card--flat" : "", props.class || ""].filter(Boolean).join(" ")}
      style={props.style}
    >
      {props.title ? <div class="card__title">{props.title}</div> : null}
      {props.children}
    </div>
  );
}

export function Badge(props: { tone?: "accent" | "ok" | "warn" | "err"; children: ComponentChildren; title?: string }) {
  return (
    <span class={"badge" + (props.tone ? ` badge--${props.tone}` : "")} title={props.title}>
      {props.children}
    </span>
  );
}

export function Kbd({ children }: { children: ComponentChildren }) {
  return <kbd>{children}</kbd>;
}

export function Spinner() {
  return <span class="spinner" role="progressbar" aria-label="working" />;
}

/**
 * A determinate bar when `value` is a number 0..1, an indeterminate sweep when it is null
 * (we know something is happening but not how far along it is).
 */
export function ProgressBar({ value, label }: { value: number | null; label?: string }) {
  const pct = value == null ? null : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      class={"progress" + (pct == null ? " progress--indeterminate" : "")}
      role="progressbar"
      aria-label={label || "progress"}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct == null ? undefined : Math.round(pct)}
    >
      <div class="progress__fill" style={pct == null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

export function Avatar({ src, name, size = 24 }: { src?: string | null; name: string; size?: number }) {
  const style = { width: `${size}px`, height: `${size}px`, borderRadius: "50%", flex: "none" };
  if (src) return <img src={src} alt="" style={style} />;
  return (
    <span
      style={{ ...style, background: "var(--accent-soft)", color: "var(--accent)", display: "grid", placeItems: "center", fontSize: "11px", fontWeight: 700 }}
      aria-hidden="true"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
