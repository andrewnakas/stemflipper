/**
 * One lane of a track, drawn on the shared timeline.
 *
 * The mixer has always had three lanes per track — the separated stem, the notes on a
 * synth, the notes on samples cut from this song — but they were three faders with no
 * picture. You could hear the arrangement and not see it. These are thin strips in the
 * same viewport coordinates as the ruler and the piano roll, so everything lines up.
 */

import { useEffect, useRef } from "preact/hooks";
import { assetUrl, decodeAudio } from "../../api/assets";
import { audioContext } from "../../engine/context";
import type { LaneId, Note, Track } from "../../model/types";
import { assetSource } from "../../model/store";
import { peaksFor } from "../listen/peaks";
import { cssVar, rollPalette, themeVersion } from "../theme";

export const LANE_H = 20;

export function LaneStrip(props: {
  track: Track;
  lane: LaneId;
  notes: Note[];
  duration: number;
  pxPerSecond: number;
  scrollX: number;
  playhead: number;
  /** 0..1 — a silent lane is drawn faded, so the picture matches what you hear. */
  gain: number;
  label: string;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const peaks = useRef<Float32Array | null>(null);
  const theme = themeVersion.value;

  useEffect(() => {
    if (props.lane !== "original" || !props.track.audio.src || props.track.audio.silent) return;
    let cancelled = false;
    const source = assetSource.value;
    if (!source) return;
    void decodeAudio(audioContext(), assetUrl(source, props.track.audio.src), { mono: true })
      .then((buf) => {
        if (cancelled) return;
        // One bucket per 20 ms: fine enough to read at any zoom this timeline allows.
        peaks.current = peaksFor(`${props.track.audio.src}|strip`, buf, Math.ceil(props.duration * 50));
        draw();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [props.track.id, props.lane]);

  useEffect(draw);

  function draw() {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 600;
    const h = LANE_H;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const c = rollPalette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = c.row;
    ctx.fillRect(0, 0, w, h);

    const xOf = (t: number) => t * props.pxPerSecond - props.scrollX;
    ctx.globalAlpha = props.gain > 0.01 ? 0.35 + props.gain * 0.65 : 0.18;

    if (props.lane === "original") {
      const data = peaks.current;
      if (data) {
        ctx.fillStyle = props.track.color;
        const mid = h / 2;
        for (let x = 0; x < w; x++) {
          const t = (x + props.scrollX) / props.pxPerSecond;
          if (t < 0 || t > props.duration) continue;
          const v = data[Math.min(data.length - 1, Math.floor((t / props.duration) * data.length))];
          const bar = Math.max(1, v * (h - 3));
          ctx.fillRect(x, mid - bar / 2, 1, bar);
        }
      }
    } else {
      // Notes as blocks: pitch sets the vertical position, velocity the opacity.
      const pitches = props.notes.map((n) => n.pitch);
      const lo = pitches.length ? Math.min(...pitches) : 48;
      const hi = pitches.length ? Math.max(...pitches) : 72;
      const span = Math.max(4, hi - lo);
      ctx.fillStyle = props.lane === "synth" ? c.note : props.track.color;
      for (const n of props.notes) {
        const x = xOf(n.start);
        const width = Math.max(1.5, (n.end - n.start) * props.pxPerSecond);
        if (x + width < 0 || x > w) continue;
        const y = h - 2 - ((n.pitch - lo) / span) * (h - 5);
        ctx.globalAlpha = (props.gain > 0.01 ? 0.35 + props.gain * 0.65 : 0.18) * (0.45 + (n.vel / 127) * 0.55);
        ctx.fillRect(x, y, width, 2.5);
      }
    }

    // The lane's name, pinned to the left edge so it survives scrolling. Without it the
    // strips are three anonymous rows and you cannot tell the synth from the sampler.
    ctx.globalAlpha = 1;
    ctx.font = "9px -apple-system, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    const label = props.gain > 0.01 ? props.label : `${props.label} (off)`;
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = c.bg;
    ctx.globalAlpha = 0.8;
    ctx.fillRect(0, 0, tw, h - 1);
    ctx.globalAlpha = 1;
    ctx.fillStyle = props.gain > 0.01 ? c.label : c.grid;
    ctx.fillText(label, 4, h / 2);

    const px = xOf(props.playhead);
    if (px >= 0 && px <= w) {
      ctx.fillStyle = c.playhead;
      ctx.fillRect(px, 0, 1, h);
    }
    ctx.strokeStyle = cssVar("--line-soft", "#8883");
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();
    void theme;
  }

  return (
    <canvas
      ref={ref}
      style={{ height: `${LANE_H}px`, display: "block", cursor: "pointer" }}
      title={`${props.label} — click to ${props.gain > 0.01 ? "mute" : "unmute"}`}
      onClick={props.onToggle}
    />
  );
}
