/** Canvas piano roll / drum lane, drawn against the shared timeline viewport. */

import { useEffect, useRef } from "preact/hooks";
import { barLines } from "../model/grid";
import type { Grid, Note, Track } from "../model/types";

export type EditTool = "select" | "draw" | "erase";

export interface RollGesture {
  kind: "move" | "resize-start" | "resize-end" | "marquee" | "draw" | "erase" | "seek";
  noteId?: string;
  time: number;
  pitch: number;
  additive: boolean;
}

const GM_NAMES: Record<number, string> = {
  36: "Kick", 38: "Snare", 39: "Clap", 42: "HH", 44: "HH pedal", 46: "HH open",
  45: "Tom lo", 47: "Tom mid", 50: "Tom hi", 49: "Crash", 57: "Crash 2", 51: "Ride",
};

export interface RollProps {
  track: Track;
  notes: Note[];
  grid: Grid | null;
  duration: number;
  pxPerSecond: number;
  scrollX: number;
  playhead: number;
  height?: number;
  selection?: Set<string>;
  marquee?: { t0: number; t1: number; p0: number; p1: number } | null;
  tool?: EditTool;
  onGestureStart?: (g: RollGesture) => void;
  onGestureMove?: (time: number, pitch: number) => void;
  onGestureEnd?: () => void;
}

const PAD_L = 44;
const EDGE_PX = 5;

export function PianoRoll(props: RollProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    draw(canvas, props);
  });

  const height = props.height ?? (props.track.kind === "drums" ? 110 : 140);

  const geometry = () => {
    const canvas = ref.current!;
    const rect = canvas.getBoundingClientRect();
    const plotH = Math.max(1, rect.height - 4);
    const { lo, hi, rows, isDrum } = pitchRange(props);
    return {
      rect,
      timeAt: (clientX: number) =>
        Math.max(0, (clientX - rect.left - PAD_L + props.scrollX) / props.pxPerSecond),
      pitchAt: (clientY: number) => {
        const y = clientY - rect.top;
        if (isDrum) {
          const step = plotH / Math.max(1, rows.length);
          const i = Math.max(0, Math.min(rows.length - 1, Math.floor(y / step)));
          return rows[i] ?? 60;
        }
        return Math.round(hi - (y / plotH) * (hi - lo));
      },
    };
  };

  const onDown = (e: PointerEvent) => {
    if (!props.onGestureStart) return;
    (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const g = geometry();
    const time = g.timeAt(e.clientX);
    const pitch = g.pitchAt(e.clientY);
    const additive = e.shiftKey || e.metaKey || e.ctrlKey;
    const tool = props.tool || "select";
    const hit = hitTest(props, time, pitch);

    if (tool === "erase") {
      props.onGestureStart({ kind: "erase", noteId: hit?.id, time, pitch, additive });
      return;
    }
    if (tool === "draw" && !hit) {
      props.onGestureStart({ kind: "draw", time, pitch, additive });
      return;
    }
    if (hit) {
      const x = e.clientX - g.rect.left;
      const startX = PAD_L + hit.start * props.pxPerSecond - props.scrollX;
      const endX = PAD_L + hit.end * props.pxPerSecond - props.scrollX;
      const kind =
        Math.abs(x - endX) <= EDGE_PX ? "resize-end"
        : Math.abs(x - startX) <= EDGE_PX ? "resize-start"
        : "move";
      props.onGestureStart({ kind, noteId: hit.id, time, pitch, additive });
      return;
    }
    props.onGestureStart({ kind: "marquee", time, pitch, additive });
  };

  const onMove = (e: PointerEvent) => {
    if (!props.onGestureMove) return;
    const g = geometry();
    props.onGestureMove(g.timeAt(e.clientX), g.pitchAt(e.clientY));
  };

  return (
    <canvas
      ref={ref}
      class="roll"
      style={{ height: `${height}px`, touchAction: "none", cursor: props.tool === "draw" ? "crosshair" : "default" }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={() => props.onGestureEnd?.()}
      onPointerCancel={() => props.onGestureEnd?.()}
    />
  );
}

function pitchRange(p: RollProps) {
  const isDrum = p.track.kind === "drums";
  const pitches = p.notes.map((n) => n.pitch);
  let lo = pitches.length ? Math.min(...pitches) : 48;
  let hi = pitches.length ? Math.max(...pitches) : 72;
  if (hi - lo < 4) {
    lo -= 2;
    hi += 2;
  }
  const rows = isDrum ? [...new Set(pitches)].sort((a, b) => b - a) : [];
  return { lo, hi, rows, isDrum };
}

function hitTest(p: RollProps, time: number, pitch: number): Note | null {
  const tol = p.track.kind === "drums" ? 0.5 : 0.6;
  const slack = 3 / p.pxPerSecond; // a few pixels, so short notes are still grabbable
  let best: Note | null = null;
  for (const n of p.notes) {
    if (time < n.start - slack || time > n.end + slack) continue;
    if (Math.abs(n.pitch - pitch) > tol) continue;
    if (!best || n.start > best.start) best = n;
  }
  return best;
}

function draw(canvas: HTMLCanvasElement, p: RollProps): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssWidth = canvas.clientWidth || 800;
  const cssHeight = canvas.clientHeight || 120;
  if (canvas.width !== Math.floor(cssWidth * dpr) || canvas.height !== Math.floor(cssHeight * dpr)) {
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padL = PAD_L;
  const padB = 4;
  const plotW = Math.max(1, cssWidth - padL);
  const plotH = Math.max(1, cssHeight - padB);
  const xOf = (t: number) => padL + (t * p.pxPerSecond - p.scrollX);
  const tOf = (x: number) => (x - padL + p.scrollX) / p.pxPerSecond;
  const visibleFrom = tOf(padL);
  const visibleTo = tOf(cssWidth);

  ctx.fillStyle = "#12151c";
  ctx.fillRect(padL, 0, plotW, cssHeight);

  const isDrum = p.track.kind === "drums";
  const pitches = p.notes.map((n) => n.pitch);
  let lo = pitches.length ? Math.min(...pitches) : 48;
  let hi = pitches.length ? Math.max(...pitches) : 72;
  if (hi - lo < 4) {
    lo -= 2;
    hi += 2;
  }
  const rows = isDrum ? [...new Set(pitches)].sort((a, b) => b - a) : [];
  const yOf = (pitch: number) => {
    if (isDrum) {
      const i = rows.indexOf(pitch);
      const step = plotH / Math.max(1, rows.length);
      return i < 0 ? plotH / 2 : i * step + step / 2;
    }
    return plotH - ((pitch - lo) / Math.max(1, hi - lo)) * plotH;
  };

  // lanes / octave lines
  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  if (isDrum) {
    for (const pitch of rows) {
      const y = yOf(pitch);
      ctx.strokeStyle = "#1c212b";
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssWidth, y);
      ctx.stroke();
      ctx.fillStyle = "#8794a8";
      ctx.fillText(GM_NAMES[pitch] || String(pitch), 4, y);
    }
  } else {
    for (let pitch = Math.ceil(lo / 12) * 12; pitch <= hi; pitch += 12) {
      const y = yOf(pitch);
      ctx.strokeStyle = "#1c212b";
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssWidth, y);
      ctx.stroke();
      ctx.fillStyle = "#8794a8";
      ctx.fillText(`C${Math.floor(pitch / 12) - 1}`, 4, y);
    }
  }

  // bar lines
  const bars = barLines(p.grid, p.duration);
  ctx.strokeStyle = "#2c3444";
  for (const t of bars) {
    if (t < visibleFrom - 1 || t > visibleTo + 1) continue;
    const x = xOf(t);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, plotH);
    ctx.stroke();
  }

  // notes (only what is on screen)
  const noteH = isDrum ? 6 : Math.max(2, plotH / Math.max(1, hi - lo) - 1);
  for (const n of p.notes) {
    if (n.end < visibleFrom || n.start > visibleTo) continue;
    const x = xOf(n.start);
    const w = Math.max(2, (n.end - n.start) * p.pxPerSecond);
    const y = yOf(n.pitch) - noteH / 2;
    const sounding = p.playhead >= n.start && p.playhead < n.end;
    const selected = p.selection?.has(n.id);
    const hue = 180 + (n.vel / 127) * 60;
    ctx.fillStyle = sounding ? "#ffffff" : `hsl(${hue} 70% ${45 + (n.conf || 0.7) * 18}%)`;
    ctx.fillRect(x, y, w, noteH);
    if (selected) {
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - 0.5, y - 1, w + 1, noteH + 2);
      ctx.lineWidth = 1;
    }
  }

  if (p.marquee) {
    const x0 = xOf(Math.min(p.marquee.t0, p.marquee.t1));
    const x1 = xOf(Math.max(p.marquee.t0, p.marquee.t1));
    const y0 = yOf(Math.max(p.marquee.p0, p.marquee.p1));
    const y1 = yOf(Math.min(p.marquee.p0, p.marquee.p1));
    ctx.fillStyle = "rgba(255,180,84,0.12)";
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = "rgba(255,180,84,0.6)";
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
  }

  // playhead
  if (p.playhead > 0 || true) {
    const x = xOf(p.playhead);
    if (x >= padL && x <= cssWidth) {
      ctx.strokeStyle = "#ffb454";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, cssHeight);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  }

  ctx.strokeStyle = "#262c38";
  ctx.beginPath();
  ctx.moveTo(padL, 0);
  ctx.lineTo(padL, cssHeight);
  ctx.stroke();
}
