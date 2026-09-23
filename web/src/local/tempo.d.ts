/** Types for the copied-verbatim tempo.js. */
export declare function toMono(buffer: { numberOfChannels: number; length: number; getChannelData(i: number): Float32Array }): Float32Array;
export declare function onsetEnvelope(mono: Float32Array, sampleRate: number): { flux: Float32Array; rate: number };
export declare function analyse(
  buffer: { numberOfChannels: number; length: number; duration: number; sampleRate: number; getChannelData(i: number): Float32Array },
  onProgress?: (p: number) => void,
): { bpm: number; confidence: number; duration: number };
