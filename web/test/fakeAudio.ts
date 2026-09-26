/**
 * A recording stand-in for Web Audio, so the engine's scheduling can be tested in node.
 *
 * vitest runs with `environment: "node"`, so there is no AudioContext. The lanes only ever
 * touch a small corner of the API, and what we actually want to assert is not "did it make a
 * sound" but "is the automation it scheduled continuous" — a click IS a discontinuity in a
 * gain curve, so recording the automation and evaluating it is a more precise test than
 * listening would be.
 *
 * `FakeParam.valueAt(t)` implements the subset of the AudioParam automation rules the engine
 * uses (setValueAtTime, linearRamp, exponentialRamp, setTarget, cancel), which lets a test
 * walk a gain envelope and find jumps.
 */

export type ParamEvent =
  | { type: "set"; value: number; time: number }
  | { type: "linear"; value: number; time: number }
  | { type: "exp"; value: number; time: number }
  | { type: "target"; value: number; time: number; tau: number };

export class FakeParam {
  events: ParamEvent[] = [];
  private intrinsic: number;

  constructor(
    defaultValue: number,
    private ctx: FakeContext,
  ) {
    this.intrinsic = defaultValue;
  }

  /** Web Audio's `.value` is the value NOW, not at some future scheduled time. */
  get value(): number {
    return this.valueAt(this.ctx.currentTime);
  }

  set value(v: number) {
    this.intrinsic = v;
  }

  setValueAtTime(value: number, time: number): FakeParam {
    this.events.push({ type: "set", value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): FakeParam {
    this.events.push({ type: "linear", value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): FakeParam {
    if (value === 0) throw new RangeError("exponentialRampToValueAtTime target must be non-zero");
    this.events.push({ type: "exp", value, time });
    return this;
  }

  setTargetAtTime(value: number, time: number, tau: number): FakeParam {
    this.events.push({ type: "target", value, time, tau });
    return this;
  }

  cancelScheduledValues(time: number): FakeParam {
    this.events = this.events.filter((e) => e.time < time);
    return this;
  }

  cancelAndHoldAtTime(time: number): FakeParam {
    const held = this.valueAt(time);
    this.events = this.events.filter((e) => e.time < time);
    this.events.push({ type: "set", value: held, time });
    return this;
  }

  /** The automation curve's value at `t`, following the AudioParam rules. */
  valueAt(t: number): number {
    const evs = [...this.events].sort((a, b) => a.time - b.time);
    if (!evs.length) return this.intrinsic;
    if (t < evs[0].time) {
      // Before the first event the param holds its intrinsic value — except that a ramp
      // interpolates from the value at the time the ramp was scheduled.
      return this.intrinsic;
    }
    let prevValue = this.intrinsic;
    let prevTime = evs[0].time;
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (t >= e.time) {
        if (e.type === "target") {
          // Only meaningful until the next event; approximate over the whole span.
          const next = evs[i + 1];
          const end = next ? Math.min(t, next.time) : t;
          const from = prevValue;
          prevValue = e.value + (from - e.value) * Math.exp(-(end - e.time) / e.tau);
        } else {
          prevValue = e.value;
        }
        prevTime = e.time;
        continue;
      }
      // t falls between prevTime and this event
      const span = e.time - prevTime;
      const frac = span > 0 ? (t - prevTime) / span : 1;
      if (e.type === "linear") return prevValue + (e.value - prevValue) * frac;
      if (e.type === "exp") {
        const from = Math.max(1e-9, prevValue);
        const to = Math.max(1e-9, e.value);
        return from * Math.pow(to / from, frac);
      }
      if (e.type === "target") {
        return e.value + (prevValue - e.value) * Math.exp(-(t - e.time) / e.tau);
      }
      return prevValue; // a "set" holds the previous value until its own time
    }
    return prevValue;
  }

  /** Largest value the curve reaches between `from` and `to`. */
  peakBetween(from: number, to: number, steps = 2000): number {
    let peak = 0;
    for (let i = 0; i <= steps; i++) {
      peak = Math.max(peak, this.valueAt(from + ((to - from) * i) / steps));
    }
    return peak;
  }

  /**
   * The biggest instantaneous jump in the curve, as a ratio. A click is a discontinuity, so
   * this is the number a "no clicks" test asserts on. Sampled either side of every event.
   *
   * Takes a window because the value BEFORE a voice's first event is irrelevant: a gain node
   * sits at its default 1.0 from the moment it is created, but nothing is connected to it
   * until the oscillator starts, so that step is silent. Pass the window in which the voice
   * actually sounds.
   */
  worstJump(from = -Infinity, to = Infinity, eps = 1e-4): { ratio: number; at: number } {
    let worst = { ratio: 1, at: 0 };
    for (const e of [...this.events].sort((a, b) => a.time - b.time)) {
      if (e.time <= from || e.time > to) continue;
      const before = this.valueAt(e.time - eps);
      const after = this.valueAt(e.time + eps);
      const hi = Math.max(before, after);
      const lo = Math.min(before, after);
      const ratio = lo > 1e-7 ? hi / lo : hi > 1e-5 ? Infinity : 1;
      if (ratio > worst.ratio) worst = { ratio, at: e.time };
    }
    return worst;
  }
}

class FakeNode {
  connections: FakeNode[] = [];
  disconnected = 0;
  constructor(public ctx: FakeContext) {}
  connect<T extends FakeNode>(dest: T): T {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {
    this.disconnected++;
    this.connections = [];
  }
}

export class FakeGain extends FakeNode {
  gain: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx);
    this.gain = new FakeParam(1, ctx);
  }
}

export class FakeOscillator extends FakeNode {
  type = "sine";
  frequency: FakeParam;
  detune: FakeParam;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  constructor(ctx: FakeContext) {
    super(ctx);
    this.frequency = new FakeParam(440, ctx);
    this.detune = new FakeParam(0, ctx);
  }
  start(t = 0): void {
    this.startedAt = t;
  }
  stop(t = 0): void {
    this.stoppedAt = t;
  }
}

export class FakeBufferSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  playbackRate: FakeParam;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  startedAt: number | null = null;
  startOffset: number | null = null;
  stoppedAt: number | null = null;
  onended: (() => void) | null = null;
  constructor(ctx: FakeContext) {
    super(ctx);
    this.playbackRate = new FakeParam(1, ctx);
  }
  start(t = 0, offset = 0): void {
    this.startedAt = t;
    this.startOffset = offset;
  }
  stop(t = 0): void {
    this.stoppedAt = t;
  }
}

export class FakeBiquad extends FakeNode {
  type = "lowpass";
  frequency: FakeParam;
  Q: FakeParam;
  gain: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx);
    this.frequency = new FakeParam(350, ctx);
    this.Q = new FakeParam(1, ctx);
    this.gain = new FakeParam(0, ctx);
  }
}

export class FakeBuffer {
  constructor(
    public numberOfChannels: number,
    public length: number,
    public sampleRate: number,
  ) {}
  get duration(): number {
    return this.length / this.sampleRate;
  }
  private data: Float32Array[] = [];
  getChannelData(i: number): Float32Array {
    if (!this.data[i]) this.data[i] = new Float32Array(this.length);
    return this.data[i];
  }
}

export class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  destination = new FakeGain(this as unknown as FakeContext);
  created: FakeNode[] = [];

  private track<T extends FakeNode>(n: T): T {
    this.created.push(n);
    return n;
  }
  createGain(): FakeGain {
    return this.track(new FakeGain(this));
  }
  createOscillator(): FakeOscillator {
    return this.track(new FakeOscillator(this));
  }
  createBufferSource(): FakeBufferSource {
    return this.track(new FakeBufferSource(this));
  }
  createBiquadFilter(): FakeBiquad {
    return this.track(new FakeBiquad(this));
  }
  createBuffer(ch: number, len: number, sr: number): FakeBuffer {
    return new FakeBuffer(ch, len, sr);
  }

  /** Every gain node the engine made, for scanning envelopes. */
  gains(): FakeGain[] {
    return this.created.filter((n): n is FakeGain => n instanceof FakeGain);
  }
  sources(): FakeBufferSource[] {
    return this.created.filter((n): n is FakeBufferSource => n instanceof FakeBufferSource);
  }
  oscillators(): FakeOscillator[] {
    return this.created.filter((n): n is FakeOscillator => n instanceof FakeOscillator);
  }
}

/** Cast helper: the lanes take a BaseAudioContext, and this quacks like enough of one. */
export function asCtx(c: FakeContext): BaseAudioContext {
  return c as unknown as BaseAudioContext;
}
