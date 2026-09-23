/**
 * Where this track's loops and phrases came from.
 *
 * Both carry a position in the song — a loop knows its downbeat, bar count and tempo; a
 * phrase knows its start and end — and until now that was only ever a filename in a
 * download list. Seeing them on the timeline is what makes them an arrangement rather
 * than a folder. Click one to hear it.
 */

import { useEffect, useRef, useState } from "preact/hooks";
import { assetUrl, decodeAudio } from "../../api/assets";
import { audioContext, resumeAudio } from "../../engine/context";
import { beatsPerBar } from "../../model/grid";
import { assetSource } from "../../model/store";
import type { Grid, Track } from "../../model/types";
import { cssVar, rollPalette, themeVersion } from "../theme";

export const CLIP_H = 18;

interface Clip {
  rel: string;
  start: number;
  end: number;
  label: string;
  kind: "loop" | "phrase";
}

export function clipsOf(track: Track, grid: Grid): Clip[] {
  const per = beatsPerBar(grid);
  const loops: Clip[] = (track.loops || []).map((l) => ({
    rel: l.src,
    start: l.start,
    // A loop's length is its own bars at its own tempo, not the song's current tempo.
    end: l.start + (l.bars * per * 60) / (l.bpm || grid.tempo || 120),
    label: `${l.bars} bar${l.bars === 1 ? "" : "s"}`,
    kind: "loop",
  }));
  const phrases: Clip[] = (track.phrases || []).map((p) => ({
    rel: p.src,
    start: p.start,
    end: p.end,
    label: "phrase",
    kind: "phrase",
  }));
  return [...loops, ...phrases].sort((a, b) => a.start - b.start);
}

export function ClipStrip(props: {
  track: Track;
  grid: Grid;
  pxPerSecond: number;
  scrollX: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const clips = clipsOf(props.track, props.grid);
  const theme = themeVersion.value;

  useEffect(draw);

  function draw() {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 600;
    const h = CLIP_H;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const c = rollPalette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = "9px -apple-system, system-ui, sans-serif";
    ctx.textBaseline = "middle";

    for (const clip of clips) {
      const x = clip.start * props.pxPerSecond - props.scrollX;
      const width = Math.max(3, (clip.end - clip.start) * props.pxPerSecond);
      if (x + width < 0 || x > w) continue;
      const active = playing === clip.rel;
      ctx.fillStyle = active ? c.noteSel : clip.kind === "loop" ? props.track.color : c.note;
      ctx.globalAlpha = active ? 1 : 0.55;
      ctx.fillRect(x, 2, width, h - 5);
      ctx.globalAlpha = 1;
      if (width > 34) {
        ctx.fillStyle = c.bg;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 2, 0, width - 4, h);
        ctx.clip();
        ctx.fillText(clip.label, x + 4, h / 2);
        ctx.restore();
      }
    }
    ctx.strokeStyle = cssVar("--line-soft", "#8883");
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();
    void theme;
  }

  const hit = (e: MouseEvent): Clip | null => {
    const canvas = ref.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const t = (e.clientX - rect.left + props.scrollX) / props.pxPerSecond;
    return clips.find((c) => t >= c.start && t <= c.end) || null;
  };

  return (
    <canvas
      ref={ref}
      style={{ height: `${CLIP_H}px`, display: "block", cursor: clips.length ? "pointer" : "default" }}
      title={clips.length ? "Click a loop or phrase to hear it" : undefined}
      onClick={async (e) => {
        const clip = hit(e as unknown as MouseEvent);
        const source = assetSource.value;
        if (!clip || !source) return;
        const ctx = await resumeAudio();
        try {
          const buf = await decodeAudio(ctx, assetUrl(source, clip.rel), { mono: false });
          const node = audioContext().createBufferSource();
          node.buffer = buf;
          node.connect(audioContext().destination);
          setPlaying(clip.rel);
          node.onended = () => setPlaying((p) => (p === clip.rel ? null : p));
          node.start();
        } catch {
          setPlaying(null);
        }
      }}
    />
  );
}
