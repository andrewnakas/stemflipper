import { useEffect, useRef } from "preact/hooks";
import { assetUrl } from "../../api/assets";
import { decodeAudio } from "../../api/assets";
import { audioContext } from "../../engine/context";
import { assetSource } from "../../model/store";
import { cssVar, themeVersion } from "../theme";
import { peaksFor } from "./peaks";

const BUCKETS = 420;

/** A static waveform strip that doubles as a seek bar. */
export function Waveform({
  src,
  color,
  duration,
  playhead,
  onSeek,
  height = 44,
}: {
  src: string;
  color: string;
  duration: number;
  playhead: number;
  onSeek: (t: number) => void;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const peaks = useRef<Float32Array | null>(null);
  const theme = themeVersion.value;

  useEffect(() => {
    let cancelled = false;
    const source = assetSource.value;
    if (!source || !src) return;
    void decodeAudio(audioContext(), assetUrl(source, src), { mono: true })
      .then((buf) => {
        if (cancelled) return;
        peaks.current = peaksFor(src, buf, BUCKETS);
        draw();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [src]);

  useEffect(draw, [playhead, theme, color]);

  function draw() {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 300;
    const h = height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const data = peaks.current;
    const mid = h / 2;
    if (!data) {
      ctx.fillStyle = cssVar("--line-soft", "#8883");
      ctx.fillRect(0, mid - 0.5, w, 1);
      return;
    }

    // Draw the whole waveform in the track's own colour, dimmed ahead of the playhead.
    // Greying the unplayed part made a stem look disabled rather than simply not-yet-played.
    const played = duration > 0 ? (playhead / duration) * w : 0;
    for (let x = 0; x < w; x++) {
      const v = data[Math.min(data.length - 1, Math.floor((x / w) * data.length))];
      const bar = Math.max(1, v * (h - 4));
      ctx.globalAlpha = x <= played ? 1 : 0.42;
      ctx.fillStyle = color;
      ctx.fillRect(x, mid - bar / 2, 1, bar);
    }
    ctx.globalAlpha = 1;
    if (played > 0 && played < w) {
      ctx.fillStyle = cssVar("--text", "#000");
      ctx.fillRect(played, 0, 1, h);
    }
  }

  const seekAt = (e: MouseEvent) => {
    const canvas = ref.current;
    if (!canvas || !duration) return;
    const rect = canvas.getBoundingClientRect();
    onSeek(((e.clientX - rect.left) / rect.width) * duration);
  };

  return (
    <canvas
      ref={ref}
      class="waveform"
      style={{ height: `${height}px` }}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(playhead)}
      onClick={seekAt}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onSeek(playhead + 5);
        if (e.key === "ArrowLeft") onSeek(playhead - 5);
      }}
    />
  );
}
