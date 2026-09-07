/** Plays a decoded stem (the "Original" lane) in sync with the transport. */

export class AudioLane {
  private source: AudioBufferSourceNode | null = null;

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
    if (offset >= this.buffer.duration) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.dest);
    src.start(Math.max(when, this.ctx.currentTime), Math.max(0, offset));
    this.source = src;
  }

  stop(when?: number): void {
    if (!this.source) return;
    try {
      this.source.stop(when === undefined ? this.ctx.currentTime : Math.max(when, this.ctx.currentTime));
    } catch {
      /* already stopped */
    }
    try {
      this.source.disconnect();
    } catch {
      /* fine */
    }
    this.source = null;
  }
}
