/** Transient messages. Errors that need a decision belong in a Notice, not here. */

import { signal } from "@preact/signals";
import { Button } from "./primitives";

export interface ToastItem {
  id: number;
  text: string;
  tone?: "error";
  action?: { label: string; run: () => void };
}

export const toasts = signal<ToastItem[]>([]);
let nextId = 1;

export function toast(text: string, opts: { tone?: "error"; action?: ToastItem["action"]; ms?: number } = {}): void {
  const item: ToastItem = { id: nextId++, text, tone: opts.tone, action: opts.action };
  toasts.value = [...toasts.value, item];
  const ms = opts.ms ?? (opts.tone === "error" ? 9000 : 5000);
  setTimeout(() => dismiss(item.id), ms);
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

export function Toasts() {
  const items = toasts.value;
  if (!items.length) return null;
  return (
    <div class="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} class={"toast" + (t.tone === "error" ? " toast--error" : "")}>
          <span class="small">{t.text}</span>
          <span class="spacer" />
          {t.action ? (
            <Button size="sm" onClick={() => { t.action!.run(); dismiss(t.id); }}>
              {t.action.label}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" aria-label="dismiss" onClick={() => dismiss(t.id)}>×</Button>
        </div>
      ))}
    </div>
  );
}
