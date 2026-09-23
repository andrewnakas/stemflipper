/**
 * Build the "Hear an example" fixture by running a real song through a real backend.
 *
 * The demo has to be what a visitor actually gets, so it comes out of the same pipeline
 * rather than being assembled by hand. Stems are stored as MONO 16-bit FLAC: the player
 * downmixes every stem to mono anyway (api/assets.ts decodeAudio), so this is lossless
 * with respect to what the page can play, and it is the difference between a 6 MB fixture
 * and a 20 MB one in a git repo.
 *
 *   node scripts/make_demo_fixture.mjs --file song.wav --preset balanced \
 *     --title "Another Queen" --artist "Pure Camomile Jam" \
 *     --license CC0 --url https://archive.org/details/...
 */

import { mkdir, readFile, rm, writeFile, stat, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

const run = promisify(execFile);

async function dirSize(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size;
  }
  return total;
}
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "../public/fixtures/demo");
const MAX_MB = Number(process.env.DEMO_MAX_MB || 10);
/** A demo proves loops and phrases exist; it does not need every one of them. */
const MAX_LOOPS = Number(args.maxLoops || 3);
const MAX_PHRASES = Number(args.maxPhrases || 3);

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith("--") ? [[a.slice(2), all[i + 1] ?? true]] : [])),
);
const FILE = resolve(process.cwd(), args.file || "");
const BASE = (args.backend || "https://nakas-stemflipper.hf.space").replace(/\/+$/, "");
const API = `${BASE}/gradio_api`;
const PRESET = args.preset || "balanced";
const TOKEN = args.token || process.env.HF_TOKEN || "";

const t0 = Date.now();
const log = (...m) => console.log(`[${String(((Date.now() - t0) / 1000).toFixed(1)).padStart(5)}s]`, ...m);
const headers = TOKEN ? { authorization: `Bearer ${TOKEN}` } : {};

/* ---------------------------------------------------------------- run it */

const bytes = await readFile(FILE);
log(`uploading ${basename(FILE)} (${(bytes.length / 1e6).toFixed(1)} MB) to ${BASE}`);
const form = new FormData();
form.append("files", new Blob([bytes]), basename(FILE));
const up = await fetch(`${API}/upload`, { method: "POST", body: form, headers });
if (!up.ok) throw new Error(`upload failed (${up.status})`);
const [serverPath] = await up.json();

const session_hash = Math.random().toString(36).slice(2);
const join_ = await fetch(`${API}/queue/join`, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({
    data: [{ path: serverPath, orig_name: basename(FILE), meta: { _type: "gradio.FileData" } }, PRESET, false],
    fn_index: 0,
    session_hash,
    trigger_id: null,
  }),
});
if (!join_.ok) throw new Error(`queue join failed (${join_.status})`);

const res = await fetch(`${API}/queue/data?session_hash=${session_hash}`, { headers: { ...headers, accept: "text/event-stream" } });
let buf = "";
let output = null;
const dec = new TextDecoder();
outer: for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const raw = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const data = raw.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
    if (!data) continue;
    let msg;
    try { msg = JSON.parse(data); } catch { continue; }
    if (msg.msg === "progress") log(msg.progress_data?.[0]?.desc ?? "");
    if (msg.msg === "process_completed") {
      if (msg.success === false || msg.output?.error) throw new Error(msg.output?.error || "backend error");
      output = msg.output.data;
      break outer;
    }
    if (msg.msg === "close_stream") throw new Error("stream closed with no result");
  }
}
if (!output) throw new Error("no result");

const project = output[3];
const zipUrl = output[0]?.url;
log(`done: ${project.tracks.length} tracks, tempo ${project.grid.tempo}, key ${project.key.name}, zip ${(output[0].size / 1e6).toFixed(1)} MB`);

/* ------------------------------------------------------------ fetch + trim */

log("downloading the bundle zip");
const zipRes = await fetch(zipUrl, { headers });
if (!zipRes.ok) throw new Error(`zip download failed (${zipRes.status})`);
const files = unzipSync(new Uint8Array(await zipRes.arrayBuffer()));

// The zip nests everything under one folder; strip it so paths match project.json.
const names = Object.keys(files);
const prefix = names.every((n) => n.includes("/")) ? names[0].split("/")[0] + "/" : "";
log(`zip has ${names.length} entries (prefix "${prefix}")`);

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

/** Everything project.json points at, so nothing unreferenced is shipped. */
const referenced = new Set();
const add = (p) => p && referenced.add(p.replace(/^\/+/, ""));
for (const t of project.tracks) {
  add(t.audio?.src);
  // The split drum kit is six more full-length stems that the player never loads
  // (engine/session.ts only reads track.audio), so in the demo they are pure download
  // weight — 7.8 MB of it. A real run still produces them.
  t.sub_stems = [];
  t.loops = (t.loops || []).slice(0, MAX_LOOPS);
  t.phrases = (t.phrases || []).slice(0, MAX_PHRASES);
  add(t.midi);
  for (const k of ["sampler", "sfz", "dspreset", "vital"]) add(t.instrument?.[k]);
  for (const l of t.loops || []) add(l.src);
  for (const p of t.phrases || []) add(p.src);
}
add(project.midi?.song);
add(project.midi?.chords);
// The DAWproject is 2+ MB of duplicated audio and nothing on the page opens it.
project.exports = Object.fromEntries(Object.entries(project.exports || {}).filter(([k]) => k !== "dawproject"));
for (const v of Object.values(project.exports)) add(v);

// Sample zones are listed inside the instrument JSONs, not in project.json.
for (const rel of [...referenced]) {
  if (!rel.endsWith(".json")) continue;
  const entry = files[prefix + rel];
  if (!entry) continue;
  try {
    const inst = JSON.parse(new TextDecoder().decode(entry));
    const zones = inst.zones || Object.values(inst.pieces || {}).flatMap((p) => p.zones || []);
    for (const z of zones) {
      if (!z.path) continue;
      // kit.json / instrument.json spell zone paths from the BUNDLE root, not relative to
      // themselves. Prefer that, and fall back to the relative reading if it is ever not.
      const direct = z.path.replace(/^\/+/, "");
      add(files[prefix + direct] ? direct : join(dirname(rel), z.path));
    }
  } catch {
    /* not an instrument file */
  }
}

let written = 0;
for (const rel of referenced) {
  const entry = files[prefix + rel];
  if (!entry) {
    console.warn(`  missing from zip: ${rel}`);
    continue;
  }
  const dest = join(OUT, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, entry);
  written++;
}
log(`wrote ${written} referenced files`);

/**
 * Shrink the audio. Everything the page plays is downmixed to mono at load time, and the
 * samples and loops are 24-bit — neither is doing anything for a demo except making the
 * page slower to open.
 */
async function shrink(rel, { codec }) {
  const p = join(OUT, rel);
  const tmp = `${p}.tmp.${codec === "flac" ? "flac" : "wav"}`;
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-i", p,
    "-ac", "1", "-sample_fmt", "s16",
    ...(codec === "flac" ? ["-c:a", "flac"] : ["-c:a", "pcm_s16le"]),
    tmp, "-y",
  ]);
  await run("mv", [tmp, p]);
}

let before = await dirSize(OUT);
for (const rel of referenced) {
  if (/^stems\/.*\.flac$/.test(rel)) await shrink(rel, { codec: "flac" });
  else if (/\.wav$/.test(rel)) await shrink(rel, { codec: "wav" });
}
log(`audio ${(before / 1e6).toFixed(1)} MB -> ${((await dirSize(OUT)) / 1e6).toFixed(1)} MB (mono, 16-bit)`);

project._server = undefined;
delete project._server;
await writeFile(join(OUT, "project.json"), JSON.stringify(project));

await writeFile(
  join(OUT, "attribution.json"),
  JSON.stringify(
    {
      title: args.title || project.song.source_file,
      artist: args.artist || "Unknown",
      license: args.license || "CC0",
      licenseUrl: args.licenseUrl || "https://creativecommons.org/publicdomain/zero/1.0/",
      sourceUrl: args.url || "",
      note: args.note || "Excerpt, processed with the same pipeline the site runs.",
    },
    null,
    1,
  ) + "\n",
);

/* --------------------------------------------------------------- size gate */

const mb = (await dirSize(OUT)) / 1e6;
log(`fixture is ${mb.toFixed(1)} MB at ${OUT}`);
if (mb > MAX_MB) {
  console.error(`\nTOO BIG: ${mb.toFixed(1)} MB > ${MAX_MB} MB. Use a shorter excerpt or a cheaper preset.`);
  process.exit(1);
}
console.log("\ndemo fixture OK");
