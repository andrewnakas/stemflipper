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

/** Call from a click handler before scheduling anything. */
export async function resumeAudio(): Promise<AudioContext> {
  const c = audioContext();
  if (c.state === "suspended") {
    try {
      await c.resume();
    } catch {
      /* the next gesture will try again */
    }
  }
  return c;
}

export function isRunning(): boolean {
  return !!ctx && ctx.state === "running";
}
