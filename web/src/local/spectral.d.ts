/** Types for the copied-verbatim spectral.js. */
export declare function hannPeriodic(n: number): Float32Array;
export declare function makeFFT(n: number): { run(re: Float32Array, im: Float32Array, inverse: boolean): void };
export declare class Spectral {
  constructor(nFft: number, hop: number);
  forwardPair(
    left: Float32Array,
    right: Float32Array,
    frames: number,
  ): { lr: Float32Array; li: Float32Array; rr: Float32Array; ri: Float32Array };
  inversePair(
    lr: Float32Array,
    li: Float32Array,
    rr: Float32Array,
    ri: Float32Array,
    frames: number,
    outLength: number,
  ): Float32Array[];
}
