/**
 * ADSR scheduling, and the one rule that keeps it click-free.
 *
 * **Never read `param.value` to find out where an envelope is.** `.value` is the value at
 * `ctx.currentTime`, and every note is scheduled ahead of the clock, so at scheduling time it
 * reports the node's default (1.0) rather than wherever the curve will be. The synth lane used
 * to release from `param.value`, which jumped the gain to full scale at every note-off before
 * ramping down — a pop on every note, in playback and in exported audio alike.
 *
 * The fix is that a note's whole envelope is knowable when it is scheduled: the transport
 * hands over both `when` and `until`, so attack, decay, sustain and release all go in one
 * pass, with the value at each boundary computed rather than observed. `test/engineVoices`
 * walks the resulting curve and fails on any discontinuity.
 */

/** -80 dB. `exponentialRampToValueAtTime` throws on a target of exactly zero. */
export const FLOOR = 0.0001;

/** How long a hard cut takes. Short enough to feel immediate, long enough not to click. */
export const CUT_S = 0.012;

export interface Adsr {
  a: number;
  d: number;
  s: number;
  r: number;
}

/**
 * Schedule a complete ADSR on `param`, returning the time the envelope reaches silence.
 *
 * Handles a release that lands inside the attack or the decay — a 40 ms note with a 60 ms
 * decay is ordinary in transcribed MIDI — by computing the curve's value at that instant and
 * ramping from there, so short notes are quieter rather than clipped mid-ramp.
 */
export function scheduleAdsr(
  param: AudioParam,
  when: number,
  releaseAt: number,
  level: number,
  env: Adsr,
): number {
  const a = Math.max(0.002, env.a);
  const d = Math.max(0.002, env.d);
  const r = Math.max(0.02, env.r);
  const peak = Math.max(FLOOR, level);
  const sustain = Math.max(FLOOR, level * Math.min(1, Math.max(0, env.s)));

  const peakAt = when + a;
  const decayEnd = peakAt + d;
  // Always give the attack a moment, or a zero-length note schedules two events at one time.
  const rel = Math.max(releaseAt, when + 0.004);

  param.setValueAtTime(FLOOR, when);
  if (rel >= decayEnd) {
    param.linearRampToValueAtTime(peak, peakAt);
    param.linearRampToValueAtTime(sustain, decayEnd);
    if (rel > decayEnd) param.setValueAtTime(sustain, rel);
  } else if (rel > peakAt) {
    // Release lands inside the decay: ramp to where the decay would have got to.
    param.linearRampToValueAtTime(peak, peakAt);
    const frac = (rel - peakAt) / d;
    param.linearRampToValueAtTime(Math.max(FLOOR, peak + (sustain - peak) * frac), rel);
  } else {
    // Release lands inside the attack: the note never reaches full level.
    const frac = (rel - when) / a;
    param.linearRampToValueAtTime(Math.max(FLOOR, peak * frac), rel);
  }
  param.exponentialRampToValueAtTime(FLOOR, rel + r);
  return rel + r;
}

/**
 * Stop a voice NOW (a transport stop, a seek, a stolen voice, a deleted note).
 *
 * Here — and only here — reading `param.value` is correct, because `at` is the current time.
 * Prefers `cancelAndHoldAtTime`, which holds whatever the curve had reached; falls back to
 * `.value` where that is missing (Firefox).
 */
export function cutParam(param: AudioParam, at: number): void {
  try {
    const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => void };
    if (typeof p.cancelAndHoldAtTime === "function") {
      p.cancelAndHoldAtTime(at);
    } else {
      param.cancelScheduledValues(at);
      param.setValueAtTime(Math.max(FLOOR, param.value), at);
    }
    param.exponentialRampToValueAtTime(FLOOR, at + CUT_S);
  } catch {
    /* the context may be closing */
  }
}

/**
 * Disconnect a voice's nodes once its sources have finished.
 *
 * Without this, every note leaves a gain and a filter attached to the mixer bus for the
 * garbage collector to find later; a few thousand notes into a song that shows up as pauses.
 */
export function disconnectWhenDone(
  sources: { onended: unknown }[],
  nodes: AudioNode[],
): void {
  let left = sources.length;
  if (!left) return;
  const done = () => {
    if (--left > 0) return;
    for (const n of nodes) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
  };
  for (const s of sources) (s as { onended: (() => void) | null }).onended = done;
}
