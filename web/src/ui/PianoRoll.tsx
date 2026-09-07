/** Canvas piano roll / drum lane, drawn against the shared timeline viewport. */

import { useEffect, useRef } from "preact/hooks";
import { barLines } from "../model/grid";
import type { Grid, Note, Track } from "../model/types";

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
}

export function PianoRoll(props: RollProps) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    draw(canvas, props);
  });

  const height = props.height ?? (props.track.kind === "drums" ? 110 : 140);
  return <canvas ref={ref} class="roll" style={{ height: `${height}px` }} />;
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

  const padL = 44;
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
    const hue = 180 + (n.vel / 127) * 60;
    ctx.fillStyle = sounding ? "#ffffff" : `hsl(${hue} 70% ${45 + (n.conf || 0.7) * 18}%)`;
    ctx.fillRect(x, y, w, noteH);
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
