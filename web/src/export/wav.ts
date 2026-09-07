/** RIFF/WAVE encoder for rendered mixes and stems. */

export function encodeWav(buffer: AudioBuffer, bits: 16 | 24 = 16): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytesPerSample = bits / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);

  const str = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  str(8, "WAVE");
  str(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  str(36, "data");
  view.setUint32(40, dataBytes, true);

  const data = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]));
      if (bits === 16) {
        view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
        offset += 2;
      } else {
        const int = Math.round(v < 0 ? v * 0x800000 : v * 0x7fffff);
        view.setUint8(offset, int & 0xff);
        view.setUint8(offset + 1, (int >> 8) & 0xff);
        view.setUint8(offset + 2, (int >> 16) & 0xff);
        offset += 3;
      }
    }
  }
  return new Blob([out], { type: "audio/wav" });
}
