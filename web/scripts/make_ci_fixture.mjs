/**
 * Generate a tiny synthetic bundle for CI so the smoke test needs no Python and no
 * checked-in audio. Same shape as a real project.json, a few hundred KB of WAV.
 *
 * Usage: node scripts/make_ci_fixture.mjs [outDir]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const OUT = process.argv[2] || "public/fixtures/ci";
const SR = 22050;
const DURATION = 8;
const TEMPO = 120;
const BEAT = 60 / TEMPO;

function wav(samples, sr = SR) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v < 0 ? v * 0x8000 : v * 0x7fff), 44 + i * 2);
  }
  return buf;
}

function write(rel, data) {
  const path = join(OUT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
}

const midiHz = (p) => 440 * Math.pow(2, (p - 69) / 12);

function tone(pitch, dur, gain = 0.6) {
  const n = Math.floor(dur * SR);
  const out = new Float32Array(n);
  const f = midiHz(pitch);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t * 60) * Math.exp(-t * 2.2);
    out[i] = gain * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t));
  }
  return out;
}

function hit(freq, dur, decay, noise = 0) {
  const n = Math.floor(dur * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.exp(-t / decay);
    out[i] = env * ((1 - noise) * Math.sin(2 * Math.PI * freq * t) + noise * (Math.random() * 2 - 1));
  }
  return out;
}

function mix(length, parts) {
  const out = new Float32Array(length);
  for (const [at, data, gain = 1] of parts) {
    const start = Math.floor(at * SR);
    for (let i = 0; i < data.length && start + i < length; i++) out[start + i] += data[i] * gain;
  }
  return out;
}

const total = DURATION * SR;

// bass: one note per beat, A1 / C2 / D2
const bassNotes = [];
const bassParts = [];
for (let i = 0; i < 16; i++) {
  const pitch = [33, 33, 36, 38][i % 4];
  const at = i * BEAT * 0.5;
  bassNotes.push([pitch, +at.toFixed(4), +(at + 0.4).toFixed(4), 100, 0.9]);
  bassParts.push([at, tone(pitch, 0.45)]);
}
write("stems/bass.wav", wav(mix(total, bassParts)));

// drums: kick on 1&3, snare on 2&4, hats on 8ths
const drumNotes = [];
const drumParts = [];
for (let i = 0; i < 16; i++) {
  const at = i * BEAT;
  if (i % 2 === 0) {
    drumNotes.push([36, +at.toFixed(4), +(at + 0.12).toFixed(4), 110, 0.95]);
    drumParts.push([at, hit(60, 0.3, 0.09)]);
  } else {
    drumNotes.push([38, +at.toFixed(4), +(at + 0.12).toFixed(4), 95, 0.9]);
    drumParts.push([at, hit(220, 0.2, 0.06, 0.7)]);
  }
  for (const off of [0, 0.5]) {
    const t = at + off * BEAT;
    drumNotes.push([42, +t.toFixed(4), +(t + 0.05).toFixed(4), 70, 0.8]);
    drumParts.push([t, hit(9000, 0.06, 0.012, 0.95), 0.35]);
  }
}
write("stems/drums.wav", wav(mix(total, drumParts)));

// one drum one-shot per piece, so the sampler lane has something to play
const kickSample = hit(60, 0.3, 0.09);
const snareSample = hit(220, 0.2, 0.06, 0.7);
const hatSample = hit(9000, 0.06, 0.012, 0.95);
write("instruments/drums/samples/kick_v1_rr1.wav", wav(kickSample));
write("instruments/drums/samples/snare_v1_rr1.wav", wav(snareSample));
write("instruments/drums/samples/hh_v1_rr1.wav", wav(hatSample));
write(
  "instruments/drums/kit.json",
  JSON.stringify({
    type: "drumkit",
    name: "drums",
    pieces: {
      kick: { gm: 36, gm_all: [36], zones: [{ path: "instruments/drums/samples/kick_v1_rr1.wav", lovel: 0, hivel: 127, rr: 0 }] },
      snare: { gm: 38, gm_all: [38], zones: [{ path: "instruments/drums/samples/snare_v1_rr1.wav", lovel: 0, hivel: 127, rr: 0 }] },
      hh: { gm: 42, gm_all: [42, 46], zones: [{ path: "instruments/drums/samples/hh_v1_rr1.wav", lovel: 0, hivel: 127, rr: 0 }] },
    },
  }, null, 2),
);

for (const pitch of [33, 36, 38]) {
  write(`instruments/bass/samples/bass_${String(pitch).padStart(3, "0")}_v1.wav`, wav(tone(pitch, 0.6, 0.9)));
}
write(
  "instruments/bass/instrument.json",
  JSON.stringify({
    type: "multisample",
    name: "bass",
    amp_env: { a: 0.005, d: 0.1, s: 1.0, r: 0.25 },
    zones: [33, 36, 38].map((p, i, all) => ({
      path: `instruments/bass/samples/bass_${String(p).padStart(3, "0")}_v1.wav`,
      root: p,
      lo: i === 0 ? 0 : Math.floor((all[i - 1] + p) / 2) + 1,
      hi: i === all.length - 1 ? 127 : Math.floor((p + all[i + 1]) / 2),
      lovel: 0, hivel: 127, rr: 0, gain_db: 0, loop: null,
    })),
  }, null, 2),
);

const beats = Array.from({ length: 17 }, (_, i) => +(i * BEAT).toFixed(4));
const project = {
  schema_version: 2,
  app: { name: "stemflipper", version: "2.0.0", created_utc: new Date().toISOString() },
  song: { source_file: "ci.wav", duration: DURATION, sample_rate: SR, channels: 1 },
  grid: {
    tempo: TEMPO, time_signature: "4/4", beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    tempo_map: [[0, TEMPO]], source: "ci",
  },
  key: { name: "A minor", tonic: 9, mode: "minor", confidence: 0.8 },
  chords: [{ start: 0, end: DURATION, label: "Am", root: 9, quality: "min", conf: 0.8 }],
  sections: [],
  separation: { preset: "ci", device: "cpu", gpu_seconds: 0, chain: [{ step: "stems", model: "ci", input: "mix", seconds: 0 }] },
  tracks: [
    {
      id: "drums", name: "Drums", role: "drums", kind: "drums", color: "#6ad5c0",
      audio: { src: "stems/drums.wav", silent: false, peak_db: -3, lufs: null },
      sub_stems: [], character: {},
      transcription: { engine: "ci", fallback: null, n_notes: drumNotes.length, quantized: true, subdivision: 4 },
      notes: drumNotes, f0: null,
      instrument: { sampler: "instruments/drums/kit.json", sfz: null, dspreset: null, patch: null, vital: null },
      effects: null, loops: [], phrases: [], midi: null,
    },
    {
      id: "bass", name: "Bass", role: "bass", kind: "pitched", color: "#8a7fe8",
      audio: { src: "stems/bass.wav", silent: false, peak_db: -4, lufs: null },
      sub_stems: [], character: {},
      transcription: { engine: "ci", fallback: null, n_notes: bassNotes.length, quantized: true, subdivision: 4 },
      notes: bassNotes, f0: null,
      instrument: { sampler: "instruments/bass/instrument.json", sfz: null, dspreset: null, patch: null, vital: null },
      effects: null, loops: [], phrases: [], midi: null,
    },
  ],
  midi: { song: null, chords: null },
  exports: {},
  stages: [{ name: "separate", status: "ok", seconds: 0, detail: "ci fixture" }],
};
write("project.json", JSON.stringify(project, null, 2));
console.log(`ci fixture written to ${OUT} (${project.tracks.length} tracks)`);
