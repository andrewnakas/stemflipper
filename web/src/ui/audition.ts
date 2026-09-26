/**
 * Play one sample, for a click on a kit piece or a loop.
 *
 * Small enough to inline, except that the inline version in ClipStrip connected a source
 * straight to `ctx.destination` and never disconnected it, so auditioning built up nodes for
 * the life of the page. This fades in and out (a drum one-shot starts at a transient, but a
 * multisample zone sliced out of a mix does not begin at a zero crossing), disconnects when the
 * source ends, and cancels the previous audition so clicking down a kit does not pile up.
 */

import { assetUrl, decodeAudio } from "../api/assets";
import { resumeAudio } from "../engine/context";
import type { AssetSource } from "../api/assets";

const FADE_S = 0.004;

let current: { src: AudioBufferSourceNode; gain: GainNode } | null = null;

/** Stop whatever is auditioning, with a short fade rather than a cut. */
export function stopAudition(): void {
  const c = current;
  current = null;
  if (!c) return;
  const ctx = c.gain.context;
  const at = ctx.currentTime;
  try {
    c.gain.gain.cancelScheduledValues(at);
    c.gain.gain.setValueAtTime(c.gain.gain.value, at);
    c.gain.gain.linearRampToValueAtTime(0, at + FADE_S);
    c.src.stop(at + FADE_S + 0.01);
  } catch {
    /* already stopped */
  }
}

/**
 * Decode and play `rel` from the bundle. Resolves when it has finished playing, so a caller can
 * show which sample is sounding; rejects only if the sample could not be fetched or decoded.
 */
export async function audition(source: AssetSource, rel: string, gainValue = 0.9): Promise<void> {
  const ctx = await resumeAudio();
  const buf = await decodeAudio(ctx, assetUrl(source, rel), { mono: false });
  stopAudition();

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  const at = ctx.currentTime;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(gainValue, at + FADE_S);
  src.connect(gain).connect(ctx.destination);
  const mine = { src, gain };
  current = mine;

  return new Promise((resolve) => {
    src.onended = () => {
      try {
        src.disconnect();
        gain.disconnect();
      } catch {
        /* already gone */
      }
      if (current === mine) current = null;
      resolve();
    };
    src.start(at);
  });
}
