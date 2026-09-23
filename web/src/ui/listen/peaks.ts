/**
 * Waveform peaks for the stem strips.
 *
 * Reads the AudioBuffer the Session already decoded (assets.ts caches it), so drawing a
 * waveform costs no extra network and no second decode.
 */

const cache = new Map<string, Float32Array>();

export function peaksFor(key: string, buffer: AudioBuffer, buckets: number): Float32Array {
  const id = `${key}|${buckets}`;
  const hit = cache.get(id);
  if (hit) return hit;

  const data = buffer.getChannelData(0);
  const out = new Float32Array(buckets);
  const per = Math.max(1, Math.floor(data.length / buckets));
  for (let b = 0; b < buckets; b++) {
    const start = b * per;
    const end = Math.min(data.length, start + per);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = data[i] < 0 ? -data[i] : data[i];
      if (v > peak) peak = v;
    }
    out[b] = peak;
  }
  // Normalise so a quiet stem is still legible; the fader shows the real level.
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < out.length; i++) out[i] /= max;
  cache.set(id, out);
  return out;
}

export function clearPeaks(): void {
  cache.clear();
}
