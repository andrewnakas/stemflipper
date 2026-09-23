/** AudioContext lifecycle. Safari only starts one inside a user gesture. */

let ctx: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!ctx) {
    const Ctor: typeof AudioContext =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    ctx = new Ctor();
  }
  return ctx;
}

/**
 * Call from a click handler before scheduling anything.
 *
 * Outside a user gesture Chrome leaves the promise from resume() PENDING FOREVER rather
 * than rejecting, so awaiting it bare deadlocks the caller — which is what made opening a
 * ?fixture= link hang before the first click. The race means a caller is never blocked;
 * the next real gesture resumes the context anyway.
 */
export async function resumeAudio(): Promise<AudioContext> {
  const c = audioContext();
  if (c.state === "suspended") {
    await Promise.race([
      c.resume().catch(() => undefined),
      new Promise((r) => setTimeout(r, 250)),
    ]);
  }
  return c;
}

export function isRunning(): boolean {
  return !!ctx && ctx.state === "running";
}
