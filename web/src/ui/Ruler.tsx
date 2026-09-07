/** Bar ruler + click/drag to seek, shift-drag to set a loop region. */

import { useEffect, useRef } from "preact/hooks";
import { barLines, beatsPerBar } from "../model/grid";
import type { Grid } from "../model/types";

export interface RulerProps {
  grid: Grid | null;
  duration: number;
  pxPerSecond: number;
  scrollX: number;
  playhead: number;
  loop: { a: number; b: number; on: boolean };
  onSeek: (t: number) => void;
  onLoop: (a: number, b: number) => void;
}

const PAD_L = 44;

export function Ruler(props: RulerProps) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ from: number; loop: boolean } | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas) drawRuler(canvas, props);
  });

  const timeAt = (clientX: number): number => {
    const canvas = ref.current!;
    const rect = canvas.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left - PAD_L + props.scrollX) / props.pxPerSecond);
  };

  return (
    <canvas
      ref={ref}
      class="ruler"
      style={{ height: "26px" }}
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
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#161a22";
  ctx.fillRect(0, 0, w, h);

  const xOf = (t: number) => PAD_L + (t * p.pxPerSecond - p.scrollX);

  if (p.loop.on) {
    ctx.fillStyle = "rgba(255,180,84,0.18)";
    ctx.fillRect(xOf(p.loop.a), 0, Math.max(1, (p.loop.b - p.loop.a) * p.pxPerSecond), h);
  }

  const bars = barLines(p.grid, p.duration);
  const per = beatsPerBar(p.grid);
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "top";
  const everyN = p.pxPerSecond < 20 ? 4 : 1;
  bars.forEach((t, i) => {
    const x = xOf(t);
    if (x < PAD_L - 40 || x > w + 40) return;
    ctx.strokeStyle = "#3a4252";
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (i % everyN === 0) {
      ctx.fillStyle = "#93a0b4";
      ctx.fillText(String(i + 1), x + 3, 2);
    }
  });
  void per;

  const px = xOf(p.playhead);
  ctx.strokeStyle = "#ffb454";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, 0);
  ctx.lineTo(px, h);
  ctx.stroke();
}
