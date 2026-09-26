/**
 * The one live Session, and the transport controls the screens drive it with.
 *
 * Listen and Studio share a single Session: the decode is the expensive part, so opening
 * Studio from Listen should be instant, not a second download.
 */

import { trackAssets, type AssetSource } from "../api/assets";
import { audioContext, resumeAudio } from "../engine/context";
import { Session } from "../engine/session";
import type { Project } from "./types";
import { duration, loadProject, loopRegion, mixer, notesByTrack, playhead, playing, setNotesListener } from "./store";
import { signal } from "@preact/signals";

export const session = signal<Session | null>(null);
export const levels = signal<Record<string, number>>({});

/** How far through loading this project's assets we are; null when not loading. */
export const assetLoad = signal<{ loaded: number; total: number } | null>(null);

let raf = 0;

/** Meters refresh at this rate rather than every frame — see startClock. */
const LEVELS_HZ = 20;

/**
 * Drives the playhead, the play/stop state and the meters from one animation frame loop.
 *
 * The note scheduler is a `setInterval` on this same thread, so whatever happens here is
 * competing with it: a frame that overruns makes notes late. Two economies matter.
 *
 * `levels()` allocates a Float32Array per track and peak-scans it, and every write to the
 * signal re-renders each track's meter — at 60 Hz, for a six-stem song, for a reading the eye
 * cannot follow anyway. It runs at 20 Hz instead.
 *
 * The playhead signal is only written when it has actually moved by a meaningful amount, so a
 * paused page does no work at all rather than re-rendering every canvas that reads it.
 */
export function startClock(): () => void {
  let lastLevels = 0;
  let lastHead = -1;
  const tick = () => {
    const s = session.value;
    if (s) {
      const head = s.transport.now();
      // ~0.5 ms: below one pixel at any zoom the UI offers.
      if (Math.abs(head - lastHead) > 0.0005) {
        playhead.value = head;
        lastHead = head;
      }
      if (playing.value !== s.transport.playing) playing.value = s.transport.playing;
      const now = performance.now();
      if (s.transport.playing && now - lastLevels > 1000 / LEVELS_HZ) {
        levels.value = s.levels();
        lastLevels = now;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/**
 * Replace whatever is loaded with this project.
 *
 * `onProgress` reports asset loading; the caller shows it. resumeAudio() is called here
 * as a safety net, but Safari only honours it inside a user gesture, so the screens call
 * it in the click that led here.
 */
export async function openProject(
  data: Project,
  source: AssetSource,
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  loadProject(data, source);
  session.value?.dispose();
  session.value = null;
  await resumeAudio();

  const next = new Session(data, source, mixer.value!, audioContext());
  assetLoad.value = { loaded: 0, total: 0 };
  trackAssets((loaded, total) => {
    assetLoad.value = { loaded, total };
    onProgress?.(loaded, total);
  });
  try {
    await next.load(notesByTrack.value);
  } finally {
    trackAssets(null);
    assetLoad.value = null;
  }
  next.applyMixer(mixer.value!);
  setNotesListener((trackId, notes) => session.value?.setNotes(trackId, notes));
  session.value = next;
  (window as any).__sf.session = next;
}

export async function togglePlay(): Promise<void> {
  const s = session.value;
  if (!s) return;
  await resumeAudio();
  s.transport.toggle();
  playing.value = s.transport.playing;
}

export async function play(): Promise<void> {
  const s = session.value;
  if (!s || s.transport.playing) return;
  await resumeAudio();
  s.transport.toggle();
  playing.value = s.transport.playing;
}

export function stop(): void {
  const s = session.value;
  if (!s || !s.transport.playing) return;
  s.transport.toggle();
  playing.value = s.transport.playing;
}

export function seek(t: number): void {
  session.value?.transport.seek(Math.max(0, Math.min(duration(), t)));
}

export function nudge(delta: number): void {
  session.value?.transport.nudge(delta);
}

export function toggleLoop(): void {
  const s = session.value;
  if (!s) return;
  const r = loopRegion.value;
  if (!r.on && r.b <= r.a) return;
  const on = !s.transport.loop.on;
  if (on) s.transport.setLoop(r.a, r.b);
  else s.transport.clearLoop();
  loopRegion.value = { ...r, on };
}

export function setLoopRegion(a: number, b: number): void {
  const s = session.value;
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(duration(), Math.max(a, b));
  loopRegion.value = { a: lo, b: hi, on: hi - lo > 0.05 };
  s?.transport.setLoop(lo, hi);
}

export function applyMixerNow(): void {
  if (mixer.value) session.value?.applyMixer(mixer.value);
}
