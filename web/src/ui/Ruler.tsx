/** Bar ruler + click/drag to seek, shift-drag to set a loop region. */

import { useEffect, useRef } from "preact/hooks";
import { barLines, beatsPerBar } from "../model/grid";
import type { Grid, Section } from "../model/types";
import { rollPalette, themeVersion } from "./theme";

export interface RulerProps {
  grid: Grid | null;
  duration: number;
  pxPerSecond: number;
  scrollX: number;
  playhead: number;
  loop: { a: number; b: number; on: boolean };
  /** Song structure, when the analysis found any. Drawn as a strip above the bars. */
  sections?: Section[];
  onSeek: (t: number) => void;
  onLoop: (a: number, b: number) => void;
}

const PAD_L = 44;
const SECTION_H = 13;

export function rulerHeight(sections?: Section[]): number {
  return sections && sections.length > 1 ? 26 + SECTION_H : 26;
}

export function Ruler(props: RulerProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ from: number; loop: boolean } | null>(null);

  // themeVersion is read so a scheme change repaints the canvas, which CSS cannot do.
  const theme = themeVersion.value;
  useEffect(() => {
    const canvas = ref.current;
    if (canvas) drawRuler(canvas, props);
  }, [props, theme]);

  const timeAt = (clientX: number): number => {
    const canvas = ref.current!;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - PAD_L + props.scrollX) / props.pxPerSecond);
  };

  return (
    <canvas
      ref={ref}
      class="ruler"
      style={{ height: `${rulerHeight(props.sections)}px` }}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
        const t = timeAt(e.clientX);
        drag.current = { from: t, loop: e.shiftKey };
        if (!e.shiftKey) props.onSeek(t);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const t = timeAt(e.clientX);
        if (drag.current.loop) props.onLoop(drag.current.from, t);
        else props.onSeek(t);
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
    />
  );
}

function drawRuler(canvas: HTMLCanvasElement, p: RulerProps): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth || 800;
  const h = canvas.clientHeight || 26;
  if (canvas.width !== Math.floor(w * dpr)) canvas.width = Math.floor(w * dpr);
  if (canvas.height !== Math.floor(h * dpr)) canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const c = rollPalette();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = c.rulerBg;
  ctx.fillRect(0, 0, w, h);

  const xOf = (t: number) => PAD_L + (t * p.pxPerSecond - p.scrollX);
  const sections = p.sections && p.sections.length > 1 ? p.sections : null;
  const top = sections ? SECTION_H : 0;

  if (sections) {
    ctx.font = "10px -apple-system, system-ui, sans-serif";
    ctx.textBaseline = "top";
    sections.forEach((s, i) => {
      const x0 = xOf(s.start);
      const x1 = xOf(s.end);
      if (x1 < PAD_L || x0 > w) return;
      // Alternating tint: the boundary is the information, not the colour.
      ctx.globalAlpha = i % 2 ? 0.16 : 0.08;
      ctx.fillStyle = c.accent;
      ctx.fillRect(Math.max(PAD_L, x0), 0, Math.max(1, Math.min(x1, w) - Math.max(PAD_L, x0)), SECTION_H);
      ctx.globalAlpha = 1;
      if (s.label && x1 - x0 > 26) {
        ctx.fillStyle = c.rulerText;
        ctx.fillText(s.label, Math.max(PAD_L, x0) + 3, 1);
      }
    });
    ctx.strokeStyle = c.line;
    ctx.beginPath();
    ctx.moveTo(0, SECTION_H + 0.5);
    ctx.lineTo(w, SECTION_H + 0.5);
    ctx.stroke();
  }

  if (p.loop.on) {
    ctx.fillStyle = c.rulerLoop;
    ctx.fillRect(xOf(p.loop.a), top, Math.max(1, (p.loop.b - p.loop.a) * p.pxPerSecond), h - top);
  }

  const bars = barLines(p.grid, p.duration);
  const per = beatsPerBar(p.grid);
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "top";
  const everyN = p.pxPerSecond < 20 ? 4 : 1;
  bars.forEach((t, i) => {
    const x = xOf(t);
    if (x < PAD_L - 40 || x > w + 40) return;
    ctx.strokeStyle = c.bar;
    ctx.beginPath();
    ctx.moveTo(x, top + 8);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (i % everyN === 0) {
      ctx.fillStyle = c.rulerText;
      ctx.fillText(String(i + 1), x + 3, top + 2);
    }
  });
  void per;

  const px = xOf(p.playhead);
  ctx.strokeStyle = c.playhead;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();
}
