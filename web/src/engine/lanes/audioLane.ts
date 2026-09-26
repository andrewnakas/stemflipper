/** Plays a decoded stem (the "Original" lane) in sync with the transport.
 *
 * Two things this has to get right, both of which it used to get wrong:
 *
 * 1. **Splices are crossfaded, not cut.** `stop(when)` scheduled the stop in the future but
 *    called `disconnect()` synchronously, so the old audio vanished immediately while the new
 *    source started up to a look-ahead later: an audible gap plus a click on every seek and
 *    every loop wrap. Now each source owns a gain node, the outgoing one fades down into the
 *    incoming one's fade up, and nodes are disconnected when the source actually ends.
 * 2. **A late start keeps its place.** If the scheduler is called with a `when` that has
 *    already passed, starting at the requested offset would put the stem out of step with the
 *    transport clock for the rest of the song, so the lateness is added to the offset instead.
 */

const FADE_S = 0.006;

export class AudioLane {
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;

  constructor(
    private ctx: BaseAudioContext,
    private dest: AudioNode,
    private buffer: AudioBuffer | null,
  ) {}

  get ready(): boolean {
    return !!this.buffer;
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.buffer = buffer;
  }

  /** Start (or restart) playback so that song time `offset` lands at context time `when`. */
  startAt(when: number, offset: number): void {
    this.stop(when);
    if (!this.buffer) return;

    const now = this.ctx.currentTime;
    let at = when;
    let from = Math.max(0, offset);
    if (at < now) {
      // Late: keep the clock relationship rather than the requested offset.
      from += now - at;
      at = now;
    }
    if (from >= this.buffer.duration) return;

    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(1, at + FADE_S);
    src.connect(gain).connect(this.dest);
    src.start(at, from);
    src.onended = () => {
      try {
        src.disconnect();
        gain.disconnect();
      } catch {
        /* already gone */
      }
    };
    this.source = src;
    this.gain = gain;
  }

  /**
   * Fade the current source out, ending at `when`, then stop it.
   *
   * The fade STARTS before `when` so that the level reaches zero exactly at the splice point —
   * which is what makes a loop wrap seamless with the next source's fade in.
   */
  stop(when?: number): void {
    const src = this.source;
    const gain = this.gain;
    this.source = null;
    this.gain = null;
    if (!src) return;

    const now = this.ctx.currentTime;
    const end = when === undefined ? now : Math.max(when, now);
    const fadeFrom = Math.max(now, end - FADE_S);
    try {
      if (gain) {
        gain.gain.cancelScheduledValues(fadeFrom);
        gain.gain.setValueAtTime(gain.gain.value, fadeFrom);
        gain.gain.linearRampToValueAtTime(0, end);
      }
    } catch {
      /* context closing */
    }
    try {
      // A little past the fade, so the ramp completes before the source is torn down.
      src.stop(end + 0.01);
    } catch {
      /* already stopped */
    }
  }
}
